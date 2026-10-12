import type {
  AgentClaim, AgentCollectPlan, AgentFinishResult, AgentFinishStatus, AgentHeartbeat,
} from '../../src/shared/agent-types'
import type { CollectorRun, CollectorSource, RunStatus } from '../../src/shared/types'
import { argEnum, argId, argIds, argInt, argNullableText, argObject } from '../domain/_shared'
import { finishRun, listShopAccounts, startRun } from '../domain/master'
import { UserError } from '../errors'
import { registerAgentHandler } from './handler'
import { assertLease, beginStage, parseLease, type AgentCtx } from './lease'
import { COLLECT_NOTIFICATION_URL, collectNotification, describeProblems } from './notify'

/** lease の長さ。heartbeat（60 秒ごと）のたびに、ここから数え直して延びる */
const LEASE = '3 minutes'

const RUN_SOURCES: readonly CollectorSource[] = ['mercari', 'mellojoy', 'yahoo']
const RUN_STATUSES: readonly RunStatus[] = ['ok', 'auth_required', 'failed', 'empty']
const FINISH_STATUSES: readonly AgentFinishStatus[] = ['done', 'partial', 'failed', 'cancelled']
const MESSAGE_MAX = 500

/** master.ts の RUN_SELECT と同じ（collector_run に仕入先の名前を付ける） */
const RUN_SELECT = `
  select r.id, r.started_at, r.finished_at, r.status, r.fetched, r.inserted, r.message, r.source,
         r.shop_account_id, sa.name as shop_account_name
    from collector_run r
    left join shop_account sa on sa.household_id = r.household_id and sa.id = r.shop_account_id
`

async function agentName(ctx: AgentCtx): Promise<string> {
  const row = await ctx.sql.get<{ name: string }>('select name from agent_device where id = ?', ctx.agentId)
  return row?.name ?? '取り込み担当の PC'
}

// ------------------------------------------------------------
// 取り込み要求
// ------------------------------------------------------------

/**
 * 積まれた要求を 1 本取る。`app.claim_collect_job`（skip locked で原子的に 1 台だけ。頭で期限切れを片付ける）。
 * 端末名と PC の id は鍵から決まる（PC が名乗る名前は使わない）。無ければ null
 */
async function claim(ctx: AgentCtx): Promise<AgentClaim | null> {
  const job = await ctx.sql.get<{
    id: string | null; lease_token: string | null; lease_expires_at: string | null; requested_at: string | null
  }>(
    // 取れなかったときも全列 null の 1 行が返る（id が null かで見分ける）
    'select id, lease_token, lease_expires_at, requested_at from app.claim_collect_job(?, ?::interval, ?)',
    await agentName(ctx), LEASE, ctx.agentId,
  )
  if (!job || job.id === null) return null
  return {
    job_id: job.id,
    lease_token: job.lease_token as string,
    lease_expires_at: job.lease_expires_at as string,
    requested_at: job.requested_at as string,
  }
}

/** 60 秒ごと。失効した lease は延命できない（SB003 → lease_lost） */
async function heartbeat(ctx: AgentCtx, rawLease: unknown): Promise<AgentHeartbeat> {
  const lease = parseLease(rawLease)
  await assertLease(ctx, lease)
  const row = await ctx.sql.get<{ e: string }>(
    'select app.heartbeat_collect_job(?, ?, ?::interval) as e', lease.job_id, lease.lease_token, LEASE,
  )
  return { lease_expires_at: row!.e }
}

/**
 * 取り込みを終える。結果（`CollectorRun[]`）はサーバーが実行記録（recordRun）から組み立てて result に入れる。
 *
 * - done にできるのは、実行記録が 1 つ以上あり、ok か empty だけのとき。0 件で終わったものを成功にしない
 *   （失敗・要ログインが混ざるなら partial か failed）
 * - 失敗・要ログイン・0 件があれば `app.enqueue_notification('collect', …)` を同じトランザクションで積む
 *   （dedupe_key は job id。送り直しても二重に積まない）。全部 ok なら積まない
 * - すでに終わった取り込みをもう一度終えようとすると lease_lost（通信が切れて送り直したときも）
 */
async function finish(ctx: AgentCtx, rawLease: unknown, rawInput: unknown): Promise<AgentFinishResult> {
  const lease = parseLease(rawLease)
  await assertLease(ctx, lease)

  const o = argObject('終わりの内容', rawInput)
  const status = argEnum('終わり方', o.status, FINISH_STATUSES)
  const runIds = [...new Set(argIds('実行記録', o.run_ids, { max: 50 }))]
  const message = (argNullableText('補足', o.message, { max: MESSAGE_MAX }) ?? '').trim() || null

  const runs = runIds.length === 0
    ? []
    // 終わった順（started_at は PC が渡さないと同じ時刻に丸まるので、並びの根拠にしない）
    : await ctx.sql.all<CollectorRun>(`${RUN_SELECT} where r.id = any(?::uuid[]) order by r.finished_at, r.id`, runIds)
  if (runs.length !== runIds.length) throw new UserError('実行記録が見つかりません', 'not_found')
  if (runs.some((r) => r.finished_at === null)) throw new UserError('終わっていない実行記録があります')
  if (status === 'done') {
    if (runs.length === 0) {
      throw new UserError('実行記録が 1 つもないまま、取り込みを「完了」にはできません（取得 0 件は empty で記録してください）')
    }
    if (runs.some((r) => r.status === 'failed' || r.status === 'auth_required')) {
      throw new UserError('失敗・要ログインの実行記録があるので、取り込みを「完了」にはできません（途中で止まった扱い partial か failed にしてください）')
    }
  }

  const shown = message ?? (describeProblems(runs) || null)
  const row = await ctx.sql.get<{ status: AgentFinishStatus; finished_at: string }>(
    'select status, finished_at from app.finish_collect_job(?, ?, ?, ?::jsonb)',
    lease.job_id, lease.lease_token, status, JSON.stringify({ runs, message: shown }),
  )

  let notified = false
  const note = collectNotification(status, runs, await agentName(ctx), message)
  if (note) {
    const id = await ctx.sql.get<{ id: string | null }>(
      'select app.enqueue_notification(?, ?, ?, ?, ?) as id',
      'collect', note.title, note.body, COLLECT_NOTIFICATION_URL, `collect:${lease.job_id}`,
    )
    notified = id?.id != null
  }
  return { status: row!.status, finished_at: row!.finished_at, notified }
}

// ------------------------------------------------------------
// 読む・実行記録
// ------------------------------------------------------------

/** 取り込む仕入先（有効なメロジョイのアカウント）。メルカリ・Yahoo!フリマは常に対象 */
async function getCollectPlan(ctx: AgentCtx, rawLease: unknown): Promise<AgentCollectPlan> {
  await assertLease(ctx, parseLease(rawLease))
  const accounts = await listShopAccounts(ctx)
  return {
    shop_accounts: accounts.filter((a) => a.is_active === 1 && a.kind === 'mellojoy').map((a) => ({ id: a.id, name: a.name })),
  }
}

/**
 * 取り込み元ごとの記録。デスクトップの startRun + finishRun を、終わったときの 1 回にまとめたもの
 * （途中で落ちても「実行中のまま」の記録が残らない）。冪等キー `run:<取り込み元>:<仕入先>`。
 * 同じ取り込み元をもう一度送ると、書かずに前の記録を返す。始めた時刻は、取り込みを取った時刻〜終わった時刻に丸める
 */
async function recordRun(ctx: AgentCtx, rawLease: unknown, rawRun: unknown): Promise<CollectorRun> {
  const lease = parseLease(rawLease)
  const o = argObject('実行記録', rawRun)
  const source = argEnum('取り込み元', o.source, RUN_SOURCES)
  const shopId = source === 'mellojoy' ? argId('仕入先', o.shop_account_id) : null
  const key = `run:${source}:${shopId ?? '-'}`

  if (!(await beginStage(ctx, lease, key))) {
    const prev = await ctx.sql.get<CollectorRun>(
      `${RUN_SELECT}
        where r.source = ? and r.shop_account_id is not distinct from ?::uuid and r.finished_at is not null
          and r.started_at >= (select claimed_at from collect_job where id = ?)
        order by r.started_at desc, r.id desc limit 1`,
      source, shopId, lease.job_id,
    )
    if (!prev) throw new UserError('この取り込み元の実行記録はすでに送られていますが、見つかりません', 'conflict')
    return prev
  }

  if (shopId) {
    const shop = await ctx.sql.get<{ id: string }>('select id from shop_account where id = ?', shopId)
    if (!shop) throw new UserError('仕入先が見つかりません', 'not_found')
  }
  const status = argEnum('状態', o.status, RUN_STATUSES)
  const fetched = argInt('取得数', o.fetched, { min: 0 })
  const inserted = argInt('登録数', o.inserted, { min: 0 })
  const message = argNullableText('メッセージ', o.message, { max: 5000 }) ?? undefined
  const startedAtText = argNullableText('始めた時刻', o.started_at, { max: 64 })
  const startedAt = startedAtText && !Number.isNaN(Date.parse(startedAtText)) ? new Date(startedAtText).toISOString() : null

  const runId = await startRun(ctx, source, shopId)
  const run = await finishRun(ctx, runId, status, fetched, inserted, message)
  await ctx.sql.run(
    `update collector_run r
        set started_at = greatest(j.claimed_at, least(coalesce(?::timestamptz, j.claimed_at), r.finished_at))
       from collect_job j
      where r.id = ? and j.id = ?`,
    startedAt, runId, lease.job_id,
  )
  return (await ctx.sql.get<CollectorRun>(`${RUN_SELECT} where r.id = ?`, run.id))!
}

registerAgentHandler('claim', claim)
registerAgentHandler('heartbeat', heartbeat)
registerAgentHandler('finish', finish)
registerAgentHandler('getCollectPlan', getCollectPlan)
registerAgentHandler('recordRun', recordRun)
