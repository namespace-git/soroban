import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'
import { todayLocal } from '../../../shared/date'

describe('ペルソナ01：基本の人', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('メロジョイ')
  })

  it('仕入3点(金額按分)→在庫原価一致→取り込み1件→自動紐付け→粗利一致→各画面が同じ数字を出す', () => {
    const today = todayLocal()

    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: today,
      shipping_fee: 499,
      lines: [
        { name: '【Z001-1】ムースクリームわん', unit_price: 2499, quantity: 1 },
        { name: '【Z002-1】ねっとりヨーグルトにゃん', unit_price: 2399, quantity: 1 },
        { name: '【Z003-1】もちもちもちうさぎ', unit_price: 2699, quantity: 1 },
      ],
    })

    const items = db.listInventory('in_stock')
    expect(items).toHaveLength(3)

    // 合計 = 7,597（単価合計） + 499（送料） = 8,096
    const totalLanded = items.reduce((s, i) => s + i.landed_cost, 0)
    expect(totalLanded).toBe(7597 + 499)

    // 手計算：金額按分。round(499*unit/7597)、端数は最終行(Z003-1)へ寄せる
    const byModel = Object.fromEntries(items.map(i => [i.model_code, i.landed_cost]))
    expect(byModel['Z001-1']).toBe(2499 + 164) // round(499*2499/7597) = 164
    expect(byModel['Z002-1']).toBe(2399 + 158) // round(499*2399/7597) = 158
    expect(byModel['Z003-1']).toBe(2699 + 177) // 残り 499-164-158=177

    // メルカリ取り込み：型番付き・送料実額
    const collected = db.insertCollected([{
      mercariItemId: 'm-persona01-1',
      title: '【Z001-1】ムースクリームわん',
      price: 8999,
      soldAt: today,
      fee: 899,
      shippingFee: 215,
    }])
    const saleId = collected[0].id

    // 自動紐付けされている
    const sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.unmatched).toBe(0)
    expect(sale.auto_linked).toBe(1)
    expect(sale.cost).toBe(2663) // Z001-1の原価
    expect(sale.item_count).toBe(1)

    // 粗利 = 8999 - 899 - 215 - 0(梱包材) - 2663 = 5222
    expect(sale.gross_profit).toBe(5222)

    // 未処理から消える（送料確定・紐付け済み）
    expect(db.listSales({ onlyPending: true }).some(s => s.id === saleId)).toBe(false)
    const dash = db.getDashboard()
    expect(dash.needsMatch).toBe(0)
    expect(dash.needsShipping).toBe(0)

    // 月次
    const month = today.slice(0, 7)
    const monthly = db.listMonthly().find(m => m.month === month && m.kind === 'resale')!
    expect(monthly.revenue).toBe(8999)
    expect(monthly.total_fee).toBe(899)
    expect(monthly.total_shipping).toBe(215)
    expect(monthly.total_cost).toBe(2663)
    expect(monthly.gross_profit).toBe(5222)

    // ダッシュボード（今月）は月次と同じ数字
    expect(dash.thisMonth).not.toBeNull()
    expect(dash.thisMonth!.gross_profit).toBe(5222)
    expect(dash.thisMonth!.revenue).toBe(8999)

    // 型番ランキング
    const variants = db.listVariantSummary()
    const z001Variant = variants.find(v => v.model_code === 'Z001-1')!
    expect(z001Variant.sold).toBe(1)
    expect(z001Variant.total_profit).toBe(5222)
    expect(z001Variant.avg_profit).toBe(5222)

    // 商品（型番）ページ
    const product = db.getProduct('Z001-1')!
    expect(product.sold).toBe(1)
    expect(product.total_profit).toBe(5222)
    const thisMonthPoint = product.months.find(m => m.month === month)!
    expect(thisMonthPoint.sales_amount).toBe(8999)
    expect(thisMonthPoint.profit).toBe(5222)
    expect(thisMonthPoint.purchase_amount).toBe(2663)

    // 在庫1点の履歴ドロワー
    const z001Item = items.find(i => i.model_code === 'Z001-1')!
    const timeline = db.getItemTimeline(z001Item.id)!
    expect(timeline.sale).not.toBeNull()
    expect(timeline.sale!.gross_profit).toBe(5222)
    expect(timeline.sale!.id).toBe(saleId)
  })
})
