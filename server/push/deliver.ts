import type { Sql } from '../db/sql'
import { sendWebPush, type PushOutcome, type SendDeps } from './send'
import { loadVapidKeys, VapidConfigError, type VapidEnv, type VapidKeys } from './vapid'

// 配送（notification_delivery）を送る。Cron の Worker が 5 分ごとに呼ぶ（waitUntil で急ぐときも同じ）。
//
//   claim_deliveries  … 送る番が来たものを取る（sending にして attempts を 1 増やす。skip locked なので 2 本走っても被らない）
//   送信              … Push サービスへ POST（通信のあいだ DB のトランザクションは開けない）
//   complete_delivery … 結果を書く（sent / 再送待ち / 諦め / 購読ごと削除）
//
// 世帯をまたいで巡回するので、ロールは soroban_cron（`set local role`）。販売・在庫・金額の列は読めない役。
// 取ったあとに落ちても、lease（2 分）を過ぎれば取り直される。少なくとも 1 回届く（payload の tag で 1 つに見える）

/** 1 回の呼び出しで送る件数の既定 */
export const DEFAULT_DRAIN_LIMIT = 20
/** Workers（無料枠）の 1 回の呼び出しで使える外部通信の上限。これを超える件数は取らない */
export const MAX_DRAIN_LIMIT = 50
const DEFAULT_CONCURRENCY = 5

/** claim_deliveries が返す 1 行（送るのに要るものを全部） */
export interface ClaimedDelivery {
  delivery_id: string
  household_id: string
  event_id: string
  subscription_id: string
  kind: string
  title: string
  body: string
  url: string | null
  endpoint: string
  p256dh: string
  auth: string
  attempts: number
}

export interface DrainResult {
  /** 送れた（Push サービスが受け付けた） */
  sent: number
  /** 規定の回数を使い切って諦めた */
  failed: number
  /** 404 / 410。購読ごと消した */
  gone: number
  /** 失敗して、あとで送り直す */
  retried: number
}

export interface DrainOptions extends SendDeps {
  /** 取る件数の上限。既定 20、最大 50。同じ呼び出しの中で外部通信を他にも使うなら小さくする */
  limit?: number
  /** 同時に送る数。既定 5 */
  concurrency?: number
}

export const EMPTY_DRAIN: Readonly<DrainResult> = Object.freeze({ sent: 0, failed: 0, gone: 0, retried: 0 })

/**
 * 送る番が来た通知を送る。例外は投げない（1 件の失敗で他を止めない）。DB につながらないなどは投げる
 * （Cron のログに出すため）。鍵（VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY）が無ければ何もしない。
 * 1 回の呼び出しで送るのは opts.limit 件まで（既定 20、最大 50）
 */
export async function drainDeliveries(root: Sql, env: VapidEnv, opts: DrainOptions = {}): Promise<DrainResult> {
  const keys = await keysOrNull(env)
  if (!keys) return { ...EMPTY_DRAIN }

  const limit = clampLimit(opts.limit)
  const rows = await root.tx(async (sql) => {
    await sql.run('set local role soroban_cron')
    return sql.all<ClaimedDelivery>(
      `select delivery_id, household_id, event_id, subscription_id, kind, title, body, url,
              endpoint, p256dh, auth, attempts
         from app.claim_deliveries(?::int)`,
      limit,
    )
  })
  if (rows.length === 0) return { ...EMPTY_DRAIN }

  const results = await sendClaimed(rows, keys, opts)

  return root.tx(async (sql) => {
    await sql.run('set local role soroban_cron')
    const total = { ...EMPTY_DRAIN }
    for (const { row, outcome } of results) {
      // 1 件の書き込みの失敗で、他の結果まで巻き込まない
      const state = await sql.tx((inner) => completeDelivery(inner, row.delivery_id, outcome)).catch((e) => {
        console.error('[push] 配送の結果を書けませんでした', e instanceof Error ? e.message : String(e))
        return undefined
      })
      tally(total, outcome, state)
    }
    return total
  })
}

/** 取った配送を送る。同時に送る数を絞り、結果は取った順で返す。例外は投げない */
export async function sendClaimed(
  rows: ClaimedDelivery[], keys: VapidKeys, deps: SendDeps & { concurrency?: number } = {},
): Promise<Array<{ row: ClaimedDelivery; outcome: PushOutcome }>> {
  return mapLimit(rows, deps.concurrency ?? DEFAULT_CONCURRENCY, async (row) => ({
    row,
    outcome: await sendWebPush(
      { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
      { title: row.title, body: row.body, url: row.url, tag: row.event_id },
      keys,
      deps,
    ),
  }))
}

/**
 * 結果を complete_delivery で書く。戻り値は 'sent' / 'pending'（あとで再送）/ 'failed'（諦めた）/ 'gone'（購読を消した）。
 * 配送がもう無い・別の送信役が取り直したときは null（何もしない）
 */
export async function completeDelivery(
  sql: Sql, deliveryId: string, outcome: PushOutcome,
): Promise<'sent' | 'pending' | 'failed' | 'gone' | null> {
  const ok = outcome.kind === 'sent'
  const gone = outcome.kind === 'gone'
  const error = outcome.kind === 'retry' ? outcome.error : gone ? `HTTP ${outcome.status}（購読が無効）` : null
  const row = await sql.get<{ state: string | null }>(
    'select app.complete_delivery(?::uuid, ?::boolean, ?::text, ?::boolean) as state',
    deliveryId, ok, error, gone,
  )
  return (row?.state ?? null) as 'sent' | 'pending' | 'failed' | 'gone' | null
}

function tally(total: DrainResult, outcome: PushOutcome, state: string | null | undefined): void {
  if (state === 'sent') total.sent++
  else if (state === 'pending') total.retried++
  else if (state === 'failed') total.failed++
  else if (state === 'gone') total.gone++
  // 同じ購読への 2 通目の 404 / 410 は、1 通目が購読ごと消したので配送も無い（null）。無効な購読には変わりない
  else if (state === null && outcome.kind === 'gone') total.gone++
}

async function keysOrNull(env: VapidEnv): Promise<VapidKeys | null> {
  try {
    return await loadVapidKeys(env)
  } catch (e) {
    if (!(e instanceof VapidConfigError)) throw e
    // 鍵の値は出さない（メッセージにも入れていない）
    console.error(`[push] ${e.message}`)
    return null
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_DRAIN_LIMIT
  if (!Number.isFinite(limit)) return DEFAULT_DRAIN_LIMIT
  return Math.min(Math.max(1, Math.floor(limit)), MAX_DRAIN_LIMIT)
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}
