import type { Ctx } from '../context'
import { isUuid } from '../domain/_shared'
import { hasSecret, SECRET_TRACK17 } from '../secrets'

// ============================================================
// 17TRACK の「確認する番が来た」印（purchase.tracking_queued_at）を積む。
//
// 実際に 17TRACK に聞くのは定期実行（cron/tracking.ts）だけ。画面の「配送状況を確認」と取り込みの終わりは
// ここで積むだけで、すぐには聞かない（Pages Functions は応答から 30 秒で切られ、register を二重に送りかねない）。
// 積む対象の規則はデスクトップと同じ（trackingRegisterCandidates / trackingCheckCandidates の和集合）：
// 追跡番号があって、まだ到着していないもの。
// ============================================================

const ELIGIBLE = `tracking_number is not null and btrim(tracking_number) <> ''
        and (fulfillment is null or fulfillment <> 'delivered')`

/** 設定 track_shipping が切られているか（既定はオン。'0' のときだけオフ。デスクトップの checkShippingIfEnabled と同じ） */
export async function isTrackShippingOff(ctx: Ctx): Promise<boolean> {
  const row = await ctx.sql.get<{ value: string }>(`select value from setting where key = 'track_shipping'`)
  return row?.value === '0'
}

/** 1 件を積む（画面の「配送状況を確認」）。積めたら true。追跡番号が無い・到着済み・無い仕入は false。すでに積んであれば位置は変えない */
export async function enqueueTracking(ctx: Ctx, purchaseId: string): Promise<boolean> {
  if (!isUuid(purchaseId)) return false
  const r = await ctx.sql.run(
    `update purchase set tracking_queued_at = coalesce(tracking_queued_at, now())
      where id = ? and ${ELIGIBLE}`,
    purchaseId.toLowerCase(),
  )
  return r.changes > 0
}

export interface EnqueueAllResult {
  /** 新しく積んだ仕入の数（すでに積んであったものは数えない） */
  queued: number
  /** 積まなかった理由：設定でオフ／API キーが無い。積んだなら null */
  skipped: 'off' | 'no_key' | null
}

/**
 * 未到着の仕入をまとめて積む（取り込みの終わりが呼ぶ。デスクトップの「取り込みのたびに未到着の分をまとめて見る」）。
 * 設定 track_shipping がオフ、または API キーが無いときは何もしない（件数の上限は置かない）
 */
export async function enqueueAllTracking(ctx: Ctx): Promise<EnqueueAllResult> {
  if (await isTrackShippingOff(ctx)) return { queued: 0, skipped: 'off' }
  if (!(await hasSecret(ctx, SECRET_TRACK17))) return { queued: 0, skipped: 'no_key' }
  const r = await ctx.sql.run(
    `update purchase set tracking_queued_at = now() where tracking_queued_at is null and ${ELIGIBLE}`,
  )
  return { queued: r.changes, skipped: null }
}
