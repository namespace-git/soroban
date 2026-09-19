import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ10：梱包材費と他費用の人', () => {
  beforeEach(() => {
    db.initDb(':memory:')
  })

  it('梱包材費50を入れると粗利がちょうど50減る', () => {
    const saleId = db.createSale({ title: '梱包材テスト', sold_at: '2026-04-01', price: 2000 })
    const before = db.listSales().find(s => s.id === saleId)!
    // fee = floor(2000*1000/10000) = 200 → 粗利 = 2000-200-0-0-0 = 1800
    expect(before.gross_profit).toBe(1800)

    db.updateSale(saleId, { packaging_cost: 50 })
    const after = db.listSales().find(s => s.id === saleId)!
    expect(after.packaging_cost).toBe(50)
    expect(after.gross_profit).toBe(1800 - 50)
  })

  it('その他費用200・割引-300を含めた按分：金額按分と数量按分で端数の寄せ方が違うが、合計はどちらも一致する', () => {
    // 配賦対象 = 送料(0) + その他費用(200) - 割引(300) = -100
    const shopId1 = db.createShopAccount('按分テスト仕入先（金額）')
    db.createPurchase({
      shop_account_id: shopId1,
      ordered_at: '2026-04-01',
      other_cost: 200,
      discount: 300,
      alloc_method: 'by_amount',
      lines: [
        { name: '商品A（金額按分）', unit_price: 1000, quantity: 2 },
        { name: '商品B（金額按分）', unit_price: 500, quantity: 1 },
      ],
    })
    const byAmountItems = db.listInventory('in_stock')
    expect(byAmountItems).toHaveLength(3)

    // by_amount: base(A)=2000, base(B)=500, total=2500, pool=-100
    //   Aへの配賦 = round(-100*2000/2500) = -80 → 1点あたり-40（割り切れる）→ 960/960
    //   Bへの配賦 = 残り -100-(-80) = -20 → 480
    const aAmount = byAmountItems.filter(i => i.name === '商品A（金額按分）').map(i => i.landed_cost).sort()
    const bAmount = byAmountItems.filter(i => i.name === '商品B（金額按分）').map(i => i.landed_cost)
    expect(aAmount).toEqual([960, 960])
    expect(bAmount).toEqual([480])
    expect(byAmountItems.reduce((s, i) => s + i.landed_cost, 0)).toBe(1000 * 2 + 500 * 1 - 100) // 2400

    const shopId2 = db.createShopAccount('按分テスト仕入先（数量）')
    db.createPurchase({
      shop_account_id: shopId2,
      ordered_at: '2026-04-02',
      other_cost: 200,
      discount: 300,
      alloc_method: 'by_quantity',
      lines: [
        { name: '商品A（数量按分）', unit_price: 1000, quantity: 2 },
        { name: '商品B（数量按分）', unit_price: 500, quantity: 1 },
      ],
    })
    const byQtyItems = db.listInventory('in_stock').filter(i => i.name.includes('数量按分'))
    expect(byQtyItems).toHaveLength(3)

    // by_quantity: base(A)=2, base(B)=1, total=3, pool=-100
    //   Aへの配賦 = round(-100*2/3) = -67 → splitEvenly(-67,2) = [-34,-33] → 966/967
    //   Bへの配賦 = 残り -100-(-67) = -33 → 467
    const aQty = byQtyItems.filter(i => i.name === '商品A（数量按分）').map(i => i.landed_cost).sort()
    const bQty = byQtyItems.filter(i => i.name === '商品B（数量按分）').map(i => i.landed_cost)
    expect(aQty).toEqual([966, 967])
    expect(bQty).toEqual([467])
    expect(byQtyItems.reduce((s, i) => s + i.landed_cost, 0)).toBe(1000 * 2 + 500 * 1 - 100) // 2400

    // 端数の寄せ方（各アイテムへの配分）は金額按分と数量按分で違うが、総額はどちらも一致する
    expect(aAmount).not.toEqual(aQty)
  })
})
