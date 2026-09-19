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

    // 商品ページの按分：価格・粗利を紐付けた点数(3)で整数按分したもの（sale_line_share）が月別に積まれる。
    // 按分の順序は sale_line の挿入順（= linkInventory に渡した配列の順）：
    //   price 12000 / 3 = 4000 ちょうど（余りなし）→ 3点とも 4000
    //   gross_profit 6500 / 3 = 2166 余り2 → 余り2は「最後の2行」に+1
    //     rn1 = xItems[0] → 2166 / rn2 = xItems[1] → 2167 / rn3 = yItems[0] → 2167
    //   （2166 + 2167 + 2167 = 6500 で sale.gross_profit と一致）
    const month = '2026-03'
    const productX = db.getProduct('X001')!
    const pointX = productX.months.find(m => m.month === month)!
    expect(pointX.sold).toBe(2)
    expect(pointX.sales_amount).toBe(4000 * 2)
    expect(pointX.profit).toBe(2166 + 2167)

    const productY = db.getProduct('Y001')!
    const pointY = productY.months.find(m => m.month === month)!
    expect(pointY.sold).toBe(1)
    expect(pointY.sales_amount).toBe(4000)
    expect(pointY.profit).toBe(2167)

    // 按分の合計は必ず販売の price / gross_profit に一致する（丸めで総額をずらさない）
    const shares = db.getDb().prepare(
      'SELECT price_share, profit_share FROM sale_line_share WHERE sale_id = ?',
    ).all(saleId) as Array<{ price_share: number; profit_share: number }>
    expect(shares.reduce((s, r) => s + r.price_share, 0)).toBe(sale.price)
    expect(shares.reduce((s, r) => s + r.profit_share, 0)).toBe(sale.gross_profit)

    // 履歴ドロワー：「まとめ売り 3 点」の表記
    const timeline = db.getItemTimeline(yItems[0].id)!
    const soldEvent = timeline.events.find(e => e.kind === 'sold')!
    expect(soldEvent.detail).toContain('まとめ売り 3 点')
    expect(soldEvent.detail).toContain('¥4,000') // 1点あたり floor(12000/3)=4000
  })
})
