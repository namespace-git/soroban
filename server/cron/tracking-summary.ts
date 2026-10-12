import type { Ctx } from '../context'
import type { TrackingCheckSummary } from '../../src/shared/types'

// ============================================================
// 17TRACK の直近の確認結果（getLastTrackingSummary の元）。
//
// デスクトップは index.ts がメモリに持っていた。サーバーは定期実行（人のリクエストとは別の呼び出し）が
// 結果を作るので、デスクトップが applog.log('collector', 'tracking', …) に残していたのと同じ形で
// app_log に書き、最新の 1 行を読む。14 日で消える（app_log の方針）。表は足さない。
// ============================================================

export const TRACKING_LOG_SOURCE = 'collector'
export const TRACKING_LOG_KIND = 'tracking'
const TRACKING_LOG_MESSAGE = '配送状況を確認しました'
const LOG_RETENTION_DAYS = 14

/** 結果を app_log に残す。書けなくても確認そのものは成功させる（呼ぶ側の流れを止めない） */
export async function writeTrackingSummary(ctx: Ctx, summary: TrackingCheckSummary): Promise<void> {
  try {
    await ctx.sql.tx(async (sql) => {
      await sql.run(`delete from app_log where ts < now() - make_interval(days => ${LOG_RETENTION_DAYS})`)
      await sql.run(
        'insert into app_log (source, kind, message, payload) values (?, ?, ?, ?)',
        TRACKING_LOG_SOURCE, TRACKING_LOG_KIND, TRACKING_LOG_MESSAGE, JSON.stringify(summary),
      )
    })
  } catch (e) {
    console.error('配送状況の確認結果を記録できませんでした', e instanceof Error ? e.name : 'error')
  }
}

const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/** 直近の確認結果。無ければ null。読めない形（壊れた行）も null（推測で埋めない） */
export async function readLastTrackingSummary(ctx: Ctx): Promise<TrackingCheckSummary | null> {
  const row = await ctx.sql.get<{ payload: string | null }>(
    `select payload from app_log where source = ? and kind = ? order by ts desc, id desc limit 1`,
    TRACKING_LOG_SOURCE, TRACKING_LOG_KIND,
  )
  if (!row?.payload) return null
  let json: unknown
  try {
    json = JSON.parse(row.payload)
  } catch {
    return null
  }
  if (typeof json !== 'object' || json === null) return null
  const o = json as Record<string, unknown>
  if (!nonNegInt(o.registered) || !nonNegInt(o.checked) || !nonNegInt(o.delivered) || !nonNegInt(o.failed)) return null
  if (o.stopped !== null && typeof o.stopped !== 'string') return null
  if (typeof o.at !== 'string') return null
  return { registered: o.registered, checked: o.checked, delivered: o.delivered, failed: o.failed, stopped: o.stopped, at: o.at }
}
