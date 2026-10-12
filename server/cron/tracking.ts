import { withHousehold, type Ctx } from '../context'
import type { Sql } from '../db/sql'
import { todayJst } from '../domain/_shared'
import { applyTrackingResult } from '../domain/purchase'
import { parseSecretKeys, readSecretAndRefresh, SECRET_TRACK17, type KeyRing } from '../secrets'
import {
  getTrackInfo, NOT_REGISTERED_CODE, registerNumbers, TRACK17_BATCH_SIZE, track17Fulfillment, track17Label,
  Track17Error, type Track17Options, type Track17Read,
} from '../../src/main/track17'
import { writeTrackingSummary } from './tracking-summary'

// ============================================================
// 17TRACK の定期実行の 1 回分（Cron の Worker から 5 分ごとに呼ぶ）。
//
// 設計：docs/web/03-agent-and-push.md の 3 節。Pages Functions には定期実行が無く、waitUntil は応答から 30 秒で
// 切られるので、画面の「配送状況を確認」と取り込みの終わりは purchase.tracking_queued_at に積むだけにして、
// 実際に 17TRACK に聞くのはここだけ。
//
//   * 世帯（＝ API キー）ごとに acquire_tracking_lease を取る。取れなければ（別の実行が持っている）何もしない。
//     秒間 3 リクエストは API キーごとの上限なので、同じ世帯を同時に 2 本走らせない
//   * 40 件以下のバッチを数本だけ回し、バッチごとに DB へ結果を書く（途中で切れても、書いた分は残る）
//   * register は「送る前に tracking_register_pending_at を書く → 成功したら tracking_registered_at（pending を戻す）」。
//     pending のまま残っているもの（前回途中で切れた）は、送り直す前にまず gettrackinfo で照会して、
//     登録済みかを確かめる（無料枠を二重に使わない）。-18019901（登録済み）は成功
//   * 429 と 4xx は再試行しない。その場で打ち切って理由（日本語）を残す。5xx・通信失敗だけ短く数回（track17.ts）
//   * 1 回の呼び出しの 17TRACK への通信は maxRequests 本まで（Workers の外部通信は 50 本）。再試行も数える
//   * 結果は問い合わせた番号と突き合わせ、知らない状態は捨てる（track17.ts）。到着状態は前に進む方向だけ
//     （domain/purchase.ts の applyTrackingResult）
//
// 17TRACK の画面（DOM）は読まない。API キーは復号した値を fetch のヘッダーに入れるだけで、ログ・例外に出さない。
// ============================================================

/** 定期実行が「押した人」の代わりに使う ID（app.user_id に入れるだけ。誰のメンバーでもない） */
export const CRON_USER_ID = '00000000-0000-4000-8000-000000000000'

/** 1 回の呼び出しで 17TRACK に送る HTTP の上限（再試行も数える）。Workers の 50 本に対して控えめ */
export const DEFAULT_MAX_REQUESTS = 8
/** 1 回の呼び出しで見る世帯の上限 */
export const DEFAULT_MAX_HOUSEHOLDS = 5
/** この時間（ms）を過ぎたら新しい通信を始めない。lease（5 分）が切れる前に終わるため */
export const DEFAULT_DEADLINE_MS = 120_000
const LEASE = '5 minutes'
/** 秒間 3 リクエスト。数え間違い・通信の揺れに備えて窓を少し広げる */
export const RATE_PER_SECOND = 3
const RATE_WINDOW_MS = 1_050

export interface TrackingRunOptions {
  /** 17TRACK への通信。省略時はグローバルの fetch */
  fetch?: typeof fetch
  /** いまの時刻（ミリ秒）。秒間 3 の判定と締め切りに使う。省略時は Date.now */
  now?: () => number
  /** 待ち（再試行・秒間 3 の間隔）。省略時は setTimeout */
  sleep?: (ms: number) => Promise<void>
  /** この呼び出しで 17TRACK に送る HTTP の上限（全世帯の合計・再試行込み）。既定 8 */
  maxRequests?: number
  /** この呼び出しで見る世帯の上限。既定 5 */
  maxHouseholds?: number
  /** 新しい通信を始めてよい時間（ミリ秒）。既定 120 秒 */
  deadlineMs?: number
}

export type TrackingHouseholdOutcome =
  /** lease を取って確認した（何も積まれていなければ件数が全部 0） */
  | 'ran'
  /** 別の実行が lease を持っていたので何もしなかった */
  | 'busy'
  /** API キーが保存されていない（積まれた分は下ろした） */
  | 'no_key'
  /** API キーを復号できない（入れ直してもらう。積まれた分は下ろした） */
  | 'unreadable_key'
  /** 予期しないエラー（他の世帯は続ける） */
  | 'error'

export interface TrackingHouseholdResult {
  householdId: string
  outcome: TrackingHouseholdOutcome
  /** 今回 17TRACK に新しく登録できた仕入の数 */
  registered: number
  /** 状況を読めた件数 */
  checked: number
  /** 到着済みにした件数 */
  delivered: number
  /** 読めなかった件数 */
  failed: number
  /** 続けられなかった理由（日本語）。上限・時間切れ（次の定期実行で続ける）は理由にしない */
  stopped: string | null
  /** この世帯で 17TRACK に送った HTTP の数（再試行込み） */
  requests: number
  /** 終わった時点でまだ積まれたままの件数（次の定期実行で続く） */
  remaining: number
}

export interface TrackingRunResult {
  households: TrackingHouseholdResult[]
  /** 17TRACK に送った HTTP の合計 */
  requests: number
}

type KeyResult = { kind: 'key'; apiKey: string } | { kind: 'missing' } | { kind: 'unreadable' }
type ResolveKey = (ctx: Ctx) => Promise<KeyResult>

/** この回の上限に達した、または時間切れ。失敗ではない（積んだまま次の定期実行で続ける） */
class TrackingBudgetError extends Track17Error {
  constructor(message: string) {
    super(message, 0, null)
    this.name = 'TrackingBudgetError'
  }
}

interface Run {
  fetch: typeof fetch
  now: () => number
  sleep: (ms: number) => Promise<void>
  startedAt: number
  maxRequests: number
  deadlineMs: number
  used: number
}

function newRun(o: TrackingRunOptions): Run {
  const now = o.now ?? (() => Date.now())
  return {
    fetch: o.fetch ?? ((input, init) => fetch(input, init)),
    now,
    sleep: o.sleep ?? ((ms) => new Promise<void>(resolve => setTimeout(resolve, ms))),
    startedAt: now(),
    maxRequests: o.maxRequests ?? DEFAULT_MAX_REQUESTS,
    deadlineMs: o.deadlineMs ?? DEFAULT_DEADLINE_MS,
    used: 0,
  }
}

function exhausted(run: Run): boolean {
  return run.used >= run.maxRequests || run.now() - run.startedAt >= run.deadlineMs
}

/**
 * 17TRACK へ送る fetch を、(1) この回の本数の上限 (2) 秒間 3 リクエスト で包む。再試行も 1 本として数える。
 * 世帯（API キー）ごとに作る。上限に達したら送らずに TrackingBudgetError を投げる
 */
function meteredFetch(run: Run): typeof fetch {
  const sent: number[] = []
  return async (input, init) => {
    if (exhausted(run)) {
      throw new TrackingBudgetError('この回の確認の上限に達したので、残りは次の定期実行で確かめます')
    }
    for (;;) {
      const t = run.now()
      while (sent.length > 0 && t - sent[0] >= RATE_WINDOW_MS) sent.shift()
      if (sent.length < RATE_PER_SECOND) break
      await run.sleep(Math.max(1, sent[0] + RATE_WINDOW_MS - t))
    }
    // 待っているあいだに締め切りを過ぎたら、送らない
    if (exhausted(run)) {
      throw new TrackingBudgetError('この回の確認の上限に達したので、残りは次の定期実行で確かめます')
    }
    sent.push(run.now())
    run.used++
    return run.fetch(input, init)
  }
}

/**
 * 送ったか分からない失敗（5xx・通信切れ・タイムアウト）か。確実に送っていない（上限で送らなかった・4xx・API のエラー）なら false。
 * 上限で止まったときは、その前の試行が 1 本でも出ていたら（5xx のあとの再試行が上限に当たった）分からない扱い
 */
function mayHaveReachedServer(e: unknown, sentAny: boolean): boolean {
  if (e instanceof TrackingBudgetError) return sentAny
  if (e instanceof Track17Error) return e.status === 0 || e.status >= 500
  return true
}

// ------------------------------------------------------------
// 入口
// ------------------------------------------------------------

/**
 * 確認する番が来た仕入のある世帯を、古い順に見つける。soroban_cron（世帯をまたいで追跡の列だけ読める）で引く。
 * 世帯の中の仕事は soroban_api（その世帯の RLS の中。画面の API と同じ入り方）でする
 */
export async function findHouseholdsWithTrackingQueue(root: Sql, limit: number): Promise<string[]> {
  return root.tx(async (sql) => {
    await sql.run('set local search_path = app, public')
    await sql.run('set local role soroban_cron')
    const rows = await sql.all<{ household_id: string }>(
      `select household_id from purchase
        where tracking_queued_at is not null
        group by household_id
        order by min(tracking_queued_at), household_id
        limit ?`,
      limit,
    )
    return rows.map(r => r.household_id)
  })
}

/**
 * Cron の入口。積まれた仕入のある世帯を巡回して、世帯ごとに 17TRACK を確認する。
 * `secretKeys` は環境変数 SECRET_KEYS（形が違えば SecretKeysError を、何もする前に投げる）。
 * root は接続ロールの Sql（トランザクションの外）。
 * 通信は合計 `maxRequests` 本まで。世帯の中の失敗は他の世帯を止めない。
 */
export async function runTrackingBatch(
  root: Sql, opts: TrackingRunOptions & { secretKeys: string | KeyRing | null | undefined },
): Promise<TrackingRunResult> {
  const ring = typeof opts.secretKeys === 'object' && opts.secretKeys !== null ? opts.secretKeys : parseSecretKeys(opts.secretKeys)
  const run = newRun(opts)
  const ids = await findHouseholdsWithTrackingQueue(root, opts.maxHouseholds ?? DEFAULT_MAX_HOUSEHOLDS)
  const resolve: ResolveKey = async (ctx) => {
    const read = await readSecretAndRefresh(ctx, ring, SECRET_TRACK17)
    if (read.status === 'ok') return { kind: 'key', apiKey: read.value }
    return { kind: read.status === 'missing' ? 'missing' : 'unreadable' }
  }
  const households: TrackingHouseholdResult[] = []
  for (const id of ids) {
    if (exhausted(run)) break
    households.push(await processHousehold(root, id, run, resolve))
  }
  return { households, requests: run.used }
}

/**
 * 1 つの世帯だけを、渡された API キーで確認する（キーの取り出しを省く。テストと、キーを別の経路で持つ呼び出し用）。
 * 積まれた仕入が無ければ何も送らない
 */
export async function runTrackingForHousehold(
  root: Sql, householdId: string, opts: TrackingRunOptions & { apiKey: string },
): Promise<TrackingHouseholdResult> {
  const run = newRun(opts)
  return processHousehold(root, householdId, run, async () => ({ kind: 'key', apiKey: opts.apiKey }))
}

// ------------------------------------------------------------
// 世帯 1 つ
// ------------------------------------------------------------

interface Row {
  id: string
  /** 前後の空白を除いた追跡番号 */
  number: string
}

interface RunState {
  /** この回で触った仕入（二度選ばない。応答に無かったものも含む） */
  skip: Set<string>
  /** 照会したら「未登録」だった pending の仕入（register へ進める） */
  unregistered: Set<string>
}

type Counts = Pick<TrackingHouseholdResult, 'registered' | 'checked' | 'delivered' | 'failed'>

const BASE = `tracking_queued_at is not null
        and tracking_number is not null and btrim(tracking_number) <> ''
        and (fulfillment is null or fulfillment <> 'delivered')`

async function processHousehold(root: Sql, householdId: string, run: Run, resolve: ResolveKey): Promise<TrackingHouseholdResult> {
  const result: TrackingHouseholdResult = {
    householdId, outcome: 'ran', registered: 0, checked: 0, delivered: 0, failed: 0, stopped: null, requests: 0, remaining: 0,
  }
  const startUsed = run.used
  const scope = <T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> =>
    withHousehold(root, { householdId, userId: CRON_USER_ID }, fn)

  let token: string | null = null
  try {
    // 1. lease と API キー。取れなければ何もしない
    const gate = await scope(async (ctx) => {
      const lease = await ctx.sql.get<{ token: string | null }>('select app.acquire_tracking_lease(?::interval) as token', LEASE)
      if (!lease?.token) return { kind: 'busy' as const }
      const key = await resolve(ctx)
      if (key.kind !== 'key') {
        // 聞けないので、積まれた分は下ろして lease を返す（積んだままだと毎回この世帯を見に来る）
        await ctx.sql.run('update purchase set tracking_queued_at = null where tracking_queued_at is not null')
        await ctx.sql.get('select app.release_tracking_lease(?::uuid) as ok', lease.token)
        if (key.kind === 'unreadable') {
          await writeTrackingSummary(ctx, {
            registered: 0, checked: 0, delivered: 0, failed: 0, at: new Date(run.now()).toISOString(),
            stopped: '17TRACK の API キーを読み出せませんでした。設定 → 配送状況 でキーを入れ直してください',
          })
        }
        return key.kind === 'missing' ? { kind: 'missing' as const } : { kind: 'unreadable' as const }
      }
      // 見る必要が無くなったもの（到着済みにした・追跡番号を消した）は積んだままにしない
      await ctx.sql.run(
        `update purchase set tracking_queued_at = null
          where tracking_queued_at is not null
            and (tracking_number is null or btrim(tracking_number) = '' or fulfillment = 'delivered')`,
      )
      return { kind: 'go' as const, token: lease.token, apiKey: key.apiKey }
    })
    if (gate.kind === 'busy') return { ...result, outcome: 'busy' }
    if (gate.kind === 'missing') return { ...result, outcome: 'no_key' }
    if (gate.kind === 'unreadable') return { ...result, outcome: 'unreadable_key' }
    token = gate.token

    // 2. バッチを数本。バッチごとに結果を書く
    const t17: Track17Options = { fetch: meteredFetch(run), sleep: run.sleep, dateOf: todayJst }
    const state: RunState = { skip: new Set(), unregistered: new Set() }
    while (!exhausted(run)) {
      const step = await scope((ctx) => nextStep(ctx, state))
      if (!step) break
      try {
        if (step.kind === 'verify') await verifyPending(scope, gate.apiKey, step.rows, state, result, t17)
        else if (step.kind === 'register') await registerBatch(scope, gate.apiKey, step.rows, state, result, t17, run)
        else await checkBatch(scope, gate.apiKey, step.rows, state, result, t17)
      } catch (e) {
        if (e instanceof TrackingBudgetError) break // 失敗ではない。積んだまま次の定期実行で続ける
        // 17TRACK から続けられない返事（キー違い・混雑・4xx・5xx・通信切れ）。通信まわりの失敗は track17.ts が
        // すべて Track17Error にするので、それ以外（DB など）は外側で「予期しないエラー」として扱う
        if (!(e instanceof Track17Error)) throw e
        result.stopped = e.message
        break
      }
    }
  } catch (e) {
    // DB など。積んだ分はそのまま残す（次の定期実行でやり直す）。他の世帯は続ける
    console.error('17TRACK の確認で予期しないエラー', { householdId }, e instanceof Error ? e.name : 'error')
    result.outcome = 'error'
  } finally {
    result.requests = run.used - startUsed
    if (token !== null) await finish(scope, token, result, run)
  }
  return result
}

/** 最後に：続けられなかったなら積んだ分を下ろす → lease を返す → 結果を残す。失敗しても lease は 5 分で切れる */
async function finish(
  scope: <T>(fn: (ctx: Ctx) => Promise<T>) => Promise<T>, token: string, result: TrackingHouseholdResult, run: Run,
): Promise<void> {
  try {
    await scope(async (ctx) => {
      // 続けられない理由があったときは、その回は打ち切って次の取り込みでまた試す（デスクトップと同じ）。
      // 積んだままだと 5 分ごとに同じ失敗を繰り返す
      if (result.stopped) await ctx.sql.run('update purchase set tracking_queued_at = null where tracking_queued_at is not null')
      const left = await ctx.sql.get<{ n: number }>('select count(*) as n from purchase where tracking_queued_at is not null')
      result.remaining = left?.n ?? 0
      await ctx.sql.get('select app.release_tracking_lease(?::uuid) as ok', token)
      if (result.registered > 0 || result.checked > 0 || result.failed > 0 || result.stopped) {
        await writeTrackingSummary(ctx, {
          registered: result.registered, checked: result.checked, delivered: result.delivered, failed: result.failed,
          stopped: result.stopped, at: new Date(run.now()).toISOString(),
        })
      }
    })
  } catch (e) {
    console.error('17TRACK の確認の後始末に失敗しました（lease は期限で切れます）', e instanceof Error ? e.name : 'error')
  }
}

// ------------------------------------------------------------
// 次にやること（照会 → 登録 → 確認の順）
// ------------------------------------------------------------

type Step = { kind: 'verify' | 'register' | 'check'; rows: Row[] }
type Scope = <T>(fn: (ctx: Ctx) => Promise<T>) => Promise<T>

async function pick(ctx: Ctx, where: string, order: string, ...params: unknown[]): Promise<Row[]> {
  const rows = await ctx.sql.all<{ id: string; number: string }>(
    `select id, btrim(tracking_number) as number from purchase
      where ${BASE} and ${where}
      order by ${order}
      limit ${TRACK17_BATCH_SIZE}`,
    ...params,
  )
  return rows
}

async function nextStep(ctx: Ctx, state: RunState): Promise<Step | null> {
  const skip = [...state.skip]
  const skipOrUnregistered = [...state.skip, ...state.unregistered]

  // 前回、register を送る直前に書いて、結果を書く前に切れたもの。送り直す前にまず照会する
  const verify = await pick(ctx,
    `tracking_registered_at is null and tracking_register_pending_at is not null and id <> all(?::uuid[])`,
    'tracking_queued_at, id', skipOrUnregistered)
  if (verify.length > 0) return { kind: 'verify', rows: verify }

  // 未登録（照会して未登録だった pending を含む）。新しい注文が先
  const register = await pick(ctx,
    `tracking_registered_at is null and (tracking_register_pending_at is null or id = any(?::uuid[])) and id <> all(?::uuid[])`,
    'ordered_at desc, created_at desc, id', [...state.unregistered], skip)
  if (register.length > 0) return { kind: 'register', rows: register }

  const check = await pick(ctx, `tracking_registered_at is not null and id <> all(?::uuid[])`, 'tracking_queued_at, id', skip)
  if (check.length > 0) return { kind: 'check', rows: check }
  return null
}

function readsByNumber(reads: Track17Read[]): Map<string, Track17Read> {
  return new Map(reads.map(r => [r.number.toUpperCase(), r]))
}

const uniqueNumbers = (rows: Row[]): string[] => [...new Set(rows.map(r => r.number))]

// ------------------------------------------------------------
// 結果を書く
// ------------------------------------------------------------

/**
 * 17TRACK で見た結果を 1 件ぶん書き、キューから外す。1 件の失敗が他の件を巻き込まないよう savepoint の中で行う。
 * 中身はデスクトップの checkTrackingBatch と同じ（読めなかった言葉も status_text に残す）
 */
async function applyRead(ctx: Ctx, id: string, read: Track17Read, counts: Counts): Promise<void> {
  try {
    const outcome = await ctx.sql.tx(async (sql) => {
      const c: Ctx = { ...ctx, sql }
      if (read.error) {
        await applyTrackingResult(c, id, {
          status_text: read.error.message || '17TRACK から状況を読めませんでした', fulfillment: null, delivered_at: null,
        })
        await sql.run('update purchase set tracking_queued_at = null where id = ?', id)
        return 'failed' as const
      }
      const fulfillment = track17Fulfillment(read.status)
      const changed = await applyTrackingResult(c, id, {
        status_text: track17Label(read.status, read.subStatus),
        fulfillment,
        delivered_at: read.status === 'Delivered' ? read.deliveredAt : null,
      })
      await sql.run('update purchase set tracking_queued_at = null where id = ?', id)
      return fulfillment === 'delivered' && changed ? ('delivered' as const) : ('checked' as const)
    })
    if (outcome === 'failed') counts.failed++
    else {
      counts.checked++
      if (outcome === 'delivered') counts.delivered++
    }
  } catch (e) {
    counts.failed++
    console.error('追跡の結果を書き込めませんでした', { purchaseId: id }, e instanceof Error ? e.name : 'error')
  }
}

/** 照会：登録済みか確かめる。登録済みなら印を付けて結果を書く。未登録なら register へ進める */
async function verifyPending(
  scope: Scope, apiKey: string, rows: Row[], state: RunState, counts: Counts, t17: Track17Options,
): Promise<void> {
  const byNumber = readsByNumber(await getTrackInfo(apiKey, uniqueNumbers(rows), t17))
  await scope(async (ctx) => {
    for (const row of rows) {
      const read = byNumber.get(row.number.toUpperCase())
      if (!read) {
        state.skip.add(row.id) // 応答に無かった番号には触らない（次の定期実行でまた照会する）
        continue
      }
      if (read.error?.code === NOT_REGISTERED_CODE) {
        state.unregistered.add(row.id)
        continue
      }
      state.skip.add(row.id)
      if (!read.error) {
        // 前回の register は通っていた。印を付けて、読めた結果を書く
        await ctx.sql.run(
          'update purchase set tracking_registered_at = now(), tracking_register_pending_at = null where id = ? and tracking_registered_at is null',
          row.id,
        )
        counts.registered++
      }
      await applyRead(ctx, row.id, read, counts)
    }
  })
}

/** 登録（無料枠を使うのはここだけ）。送る前に pending を書いて確定させる */
async function registerBatch(
  scope: Scope, apiKey: string, rows: Row[], state: RunState, counts: Counts, t17: Track17Options, run: Run,
): Promise<void> {
  const ids = rows.map(r => r.id)
  await scope((ctx) => ctx.sql.run(
    'update purchase set tracking_register_pending_at = now() where id = any(?::uuid[]) and tracking_registered_at is null', ids,
  ))
  const usedBefore = run.used
  let reg: Awaited<ReturnType<typeof registerNumbers>>
  try {
    reg = await registerNumbers(apiKey, uniqueNumbers(rows), t17)
  } catch (e) {
    // 確実に送っていないなら pending を外す。送ったか分からない（5xx・通信切れ）なら残す＝次はまず照会する
    if (!mayHaveReachedServer(e, run.used > usedBefore)) {
      await scope((ctx) => ctx.sql.run(
        'update purchase set tracking_register_pending_at = null where id = any(?::uuid[]) and tracking_registered_at is null', ids,
      ))
    }
    throw e
  }
  const accepted = new Set(reg.accepted.map(n => n.toUpperCase()))
  const rejected = new Map(reg.rejected.map(r => [r.number.toUpperCase(), r]))
  await scope(async (ctx) => {
    for (const row of rows) {
      state.skip.add(row.id) // 登録した番号の状況は次の定期実行で読む（登録した直後は 17TRACK に情報がまだ無い）
      const key = row.number.toUpperCase()
      if (accepted.has(key)) {
        await ctx.sql.run(
          'update purchase set tracking_registered_at = now(), tracking_register_pending_at = null where id = ? and tracking_registered_at is null',
          row.id,
        )
        counts.registered++
        continue
      }
      const rej = rejected.get(key)
      if (rej) {
        // 登録できなかった（番号が不正など）。印は付けず、理由を残してキューから外す（次の取り込みでまた試す）
        await ctx.sql.run('update purchase set tracking_register_pending_at = null where id = ?', row.id)
        await applyRead(ctx, row.id, {
          number: row.number, status: 'Unknown', subStatus: null, deliveredAt: null, latestEventAt: null,
          error: { code: rej.code, message: rej.message || '17TRACK に登録できませんでした' },
        }, counts)
      }
      // 応答に無かった番号は、送ったか不明のまま（pending を残す。次はまず照会する）
    }
  })
}

/** 登録済みの番号の状況を読んで書く。応答に無かった番号には触らない */
async function checkBatch(
  scope: Scope, apiKey: string, rows: Row[], state: RunState, counts: Counts, t17: Track17Options,
): Promise<void> {
  const byNumber = readsByNumber(await getTrackInfo(apiKey, uniqueNumbers(rows), t17))
  await scope(async (ctx) => {
    for (const row of rows) {
      state.skip.add(row.id)
      const read = byNumber.get(row.number.toUpperCase())
      if (!read) continue
      await applyRead(ctx, row.id, read, counts)
    }
  })
}
