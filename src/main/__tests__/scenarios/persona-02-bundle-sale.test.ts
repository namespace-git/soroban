import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ02：まとめ売りの人', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('メロジョイ')
  })

  it('同じ型番2点＋別型番1点を1販売に手で紐付け→原価合計・粗利・item_count・商品ページの按分・履歴の表記が一致する', () => {
    // X001を2点、Y001を1点、送料300を金額按分
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-03-01',
      shipping_fee: 300,
      lines: [
        { name: '【X001】うさぎクリーム', unit_price: 1000, quantity: 2 },
        { name: '【Y001】くまクリーム', unit_price: 2000, quantity: 1 },
      ],
    })

    const items = db.listInventory('in_stock')
    const xItems = items.filter(i => i.model_code === 'X001')
    const yItems = items.filter(i => i.model_code === 'Y001')
    expect(xItems).toHaveLength(2)
    expect(yItems).toHaveLength(1)

    // 手計算：pool=300, total=1000*2+2000*1=4000
    // X001（先頭行）：round(300*2000/4000)=150 → 2点で等分（端数なし）→ 75ずつ
    expect(xItems.map(i => i.landed_cost).sort()).toEqual([1075, 1075])
    // Y001（最終行）：残り 300-150=150
    expect(yItems[0].landed_cost).toBe(2150)

    const saleId = db.createSale({ title: 'まとめ売り', sold_at: '2026-03-10', price: 12000 })
    db.linkInventory(saleId, [xItems[0].id, xItems[1].id, yItems[0].id])

    const sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.item_count).toBe(3)
    // 原価合計 = 1075*2 + 2150 = 4300 (= 4000 + 300 と一致)
    expect(sale.cost).toBe(4300)
    // fee_rate_bp 既定1000(10%) → fee = floor(12000*1000/10000) = 1200
    expect(sale.fee).toBe(1200)
    // 粗利 = 12000 - 1200 - 0 - 0 - 4300 = 6500
    expect(sale.gross_profit).toBe(6500)

    // 商品ページの按分：価格・粗利を点数(3)で割って1点あたりに直したものが月別に積まれる
    const month = '2026-03'
    const productX = db.getProduct('X001')!
    const pointX = productX.months.find(m => m.month === month)!
    // X001は2点紐付いているので、1点あたりの按分値(round(12000/3)=4000, round(6500/3)=2167)が2つ分積まれる
    expect(pointX.sold).toBe(2)
    expect(pointX.sales_amount).toBe(4000 * 2)
    expect(pointX.profit).toBe(2167 * 2)

    const productY = db.getProduct('Y001')!
    const pointY = productY.months.find(m => m.month === month)!
    expect(pointY.sold).toBe(1)
    expect(pointY.sales_amount).toBe(4000)
    expect(pointY.profit).toBe(2167)

    // 履歴ドロワー：「まとめ売り 3 点」の表記
    const timeline = db.getItemTimeline(yItems[0].id)!
    const soldEvent = timeline.events.find(e => e.kind === 'sold')!
    expect(soldEvent.detail).toContain('まとめ売り 3 点')
    expect(soldEvent.detail).toContain('¥4,000') // 1点あたり floor(12000/3)=4000
  })
})
