import type { AgentDevice, CollectJob, CollectJobStatus, CollectStatus } from '../../src/shared/web-types'
import type { CollectorRun } from '../../src/shared/types'
import type { Ctx } from '../context'
import { UserError, readDbError } from '../errors'
import { registerWebHandler } from '../rpc'
import { argId } from './_shared'
import { getPurchaseTrackingNumber } from './purchase'

// ============================================================
// 取り込みの要求（画面の「取り込む」ボタン）と、取り込み担当の PC の一覧（WebApi の 5 本 + 追跡番号）
//
// 実際に取り込むのは PC の取り込み担当（server/agent/）。ここは「頼む・状態を見る・取り消す」だけ。
// 同時・連続で走らせない規則は DB の関数（app.enqueue_collect_job）が持つ：
//   SB001 取り込み中です／ SB002 前回の取り込みから n 分たっていません（あと n 秒）
// **画面に lease_token（取り込みの権限）を絶対に返さない**：collect_job は列を選んで読む（select * にしない）。
// ============================================================

/** 連続の取り込みを断る間隔。enqueue（requestCollect）と cooldown_seconds の計算で**同じ値**を使う */
const COOLDOWN = '10 minutes'
const COOLDOWN_MINUTES = 10
/** 「生きている」と数える時間。last_seen_at がこれより新しい PC がオンライン */
const ONLINE_WINDOW = '5 minutes'

/** lease_token・lease_expires・agent_device_id は読まない */
const JOB_COLUMNS = `
  j.id, j.status, j.requested_by, j.requested_at, j.agent_id, j.claimed_at, j.heartbeat_at, j.finished_at, j.result
`

interface JobRow {
  id: string
  status: CollectJobStatus
  requested_by: string | null
  requested_at: string
  agent_id: string | null
  claimed_at: string | null
  heartbeat_at: string | null
  finished_at: string | null
  result: unknown
}

const REAPED_MESSAGE: Record<string, string> = {
  lease_expired: '取り込み担当の PC からの応答が途絶えたため、失敗として片付けました。PC を確認してもう一度お試しください',
  queued_timeout: '取り込み担当の PC が見つからなかったため取り消しました。PC を起動して（Web 版にログインしたまま）もう一度押してください',
}

/** 人に見せる日本語。PC が補足を付けていればそれ、無ければ片付けた理由（reap・取り消し） */
function jobMessage(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null
  const r = result as Record<string, unknown>
  if (typeof r.message === 'string' && r.message !== '') return r.message
  if (r.reaped === true && typeof r.reason === 'string') return REAPED_MESSAGE[r.reason] ?? null
  if (r.reason === 'user_cancelled') return '取り消しました'
  return null
}

/** result は `{ runs: CollectorRun[], message }`。配列そのもの（`CollectorRun[]`）で入っていても読む */
function jobRuns(result: unknown): CollectorRun[] | null {
  if (Array.isArray(result)) return result as CollectorRun[]
  if (typeof result === 'object' && result !== null && Array.isArray((result as { runs?: unknown }).runs)) {
    return (result as { runs: CollectorRun[] }).runs
  }
  return null
}

function toCollectJob(row: JobRow, userId: string): CollectJob {
  return {
    id: row.id,
    status: row.status,
    requested_at: row.requested_at,
    requested_by_me: row.requested_by !== null && row.requested_by.toLowerCase() === userId.toLowerCase(),
    agent_name: row.agent_id,
    claimed_at: row.claimed_at,
    heartbeat_at: row.heartbeat_at,
    finished_at: row.finished_at,
    runs: jobRuns(row.result),
    message: jobMessage(row.result),
  }
}

async function loadJob(ctx: Ctx, id: string): Promise<CollectJob> {
  const row = await ctx.sql.get<JobRow>(`select ${JOB_COLUMNS} from collect_job j where j.id = ?`, id)
  if (!row) throw new UserError('取り込みの要求が見つかりません', 'not_found')
  return toCollectJob(row, ctx.userId)
}

/** 「あと 4 分 12 秒」。60 秒に満たなければ秒だけ */
function waitText(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds))
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分${s % 60 === 0 ? '' : ` ${s % 60} 秒`}`
}

/**
 * 取り込みを頼む。走っている（SB001）・クールダウン中（SB002）は日本語のエラー（409）。
 * SB002 は「あと n 分 m 秒で押せます」と、残りを読める形にして返す
 */
export async function requestCollect(ctx: Ctx): Promise<CollectJob> {
  let id: string
  try {
    const row = await ctx.sql.get<{ id: string }>('select id from app.enqueue_collect_job(?::interval)', COOLDOWN)
    id = row!.id
  } catch (e) {
    const info = readDbError(e)
    if (info?.code === 'SB002') {
      const m = /(\d+)/.exec(info.detail ?? '')
      const wait = m ? `。あと ${waitText(Number(m[1]))}で押せます` : ''
      throw new UserError(`前回の取り込みから ${COOLDOWN_MINUTES} 分たっていません${wait}`, 'conflict')
    }
    throw e
  }
  return loadJob(ctx, id)
}

/**
 * 「取り込む」ボタンの状態。
 * - job … いま積まれている・走っているもの。無ければ直近のもの。1 度も無ければ null
 * - agents_online … 直近 5 分以内に last_seen_at が進んだ、取り消されていない PC の数（0 なら押しても誰も拾わない）
 * - cooldown_seconds … 次に押せるまで。requestCollect と同じ規則（最後に始めた時刻 claimed_at + 10 分）
 * 期限切れの要求（PC が落ちた・誰も取らなかった）は、ここで片付けてから読む（画面が古い状態を見続けない）
 */
export async function getCollectStatus(ctx: Ctx): Promise<CollectStatus> {
  await ctx.sql.get('select app.reap_stale_collect_jobs()')

  const row = await ctx.sql.get<JobRow>(
    `select ${JOB_COLUMNS} from collect_job j
      order by (j.status in ('queued', 'running')) desc, j.requested_at desc, j.id
      limit 1`,
  )
  const online = await ctx.sql.get<{ n: number }>(
    `select count(*)::integer as n from agent_device
      where revoked_at is null and last_seen_at > now() - ?::interval`,
    ONLINE_WINDOW,
  )
  const cooldown = await ctx.sql.get<{ s: number }>(
    `select coalesce(ceil(greatest(0, extract(epoch from (max(claimed_at) + ?::interval - now())))), 0)::integer as s
       from collect_job`,
    COOLDOWN,
  )
  return {
    job: row ? toCollectJob(row, ctx.userId) : null,
    agents_online: online?.n ?? 0,
    cooldown_seconds: cooldown?.s ?? 0,
  }
}

/** 始まる前（queued）なら取り消す。始まった後・終わった後は日本語のエラー（SB004）。他の世帯の要求は見つからない（SB005） */
export async function cancelCollectJob(ctx: Ctx, id: string): Promise<void> {
  await ctx.sql.get('select id from app.cancel_collect_job(?)', argId('取り込みの要求', id))
}

export async function listAgentDevices(ctx: Ctx): Promise<AgentDevice[]> {
  // token_hash は読まない
  return ctx.sql.all<AgentDevice>(
    `select id, name, first_seen_at, last_seen_at,
            (revoked_at is null and last_seen_at > now() - ?::interval) as online,
            (revoked_at is not null) as revoked
       from agent_device
      order by name collate "C", id`,
    ONLINE_WINDOW,
  )
}

/** その PC に、以後取り込み担当の鍵を出さない（鍵は引けなくなる）。見つからなければ 404（SB007） */
export async function revokeAgentDevice(ctx: Ctx, id: string): Promise<void> {
  await ctx.sql.get('select id from app.revoke_agent_device(?)', argId('取り込み担当の PC', id))
}

registerWebHandler('requestCollect', (ctx) => requestCollect(ctx))
registerWebHandler('getCollectStatus', (ctx) => getCollectStatus(ctx))
registerWebHandler('cancelCollectJob', (ctx, id) => cancelCollectJob(ctx, id))
registerWebHandler('listAgentDevices', (ctx) => listAgentDevices(ctx))
registerWebHandler('revokeAgentDevice', (ctx, id) => revokeAgentDevice(ctx, id))
registerWebHandler('getTrackingNumber', (ctx, purchaseId) => getPurchaseTrackingNumber(ctx, purchaseId))
