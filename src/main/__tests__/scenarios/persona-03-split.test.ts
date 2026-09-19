import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ03：ばらす人', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('メロジョイ')
  })

  it('箱1点(原価3198)を4つに分割→端数は最後の子2つへ→2つ売る→親はin_stock/在庫金額に出ない→月別in_stockが正しい', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-01',
      shipping_fee: 0,
      lines: [{ name: '【W001】ケース', unit_price: 3198, quantity: 1 }],
    })
    const parent = db.listInventory('in_stock')[0]
    expect(parent.landed_cost).toBe(3198)

    // splitEvenly(3198, 4)：base=floor(3198/4)=799, 余り2は最後の2個へ+1
    // → [799, 799, 800, 800]
    const childIds = db.splitInventory(parent.id, 4)
    expect(childIds).toHaveLength(4)

    const children = db.listInventory('in_stock').filter(i => childIds.includes(i.id))
    expect(children.map(i => i.landed_cost).sort((a, b) => a - b)).toEqual([799, 799, 800, 800])
    expect(children.reduce((s, i) => s + i.landed_cost, 0)).toBe(3198)

    // 親は split になり in_stock から消える。在庫金額にも出ない
    const dashAfterSplit = db.getDashboard()
    expect(dashAfterSplit.stockCount).toBe(4)
    expect(dashAfterSplit.stockValue).toBe(3198)
    expect(db.listInventory('in_stock').some(i => i.id === parent.id)).toBe(false)

    // 子を2つ売る（799の子と800の子を1つずつ）
    const sorted = [...children].sort((a, b) => a.landed_cost - b.landed_cost)
    const toSell = [sorted[0], sorted[2]] // 799 と 800
    for (const item of toSell) {
      const saleId = db.createSale({ title: 'ケース売却', sold_at: '2026-04-05', price: 1500 })
      db.linkInventory(saleId, [item.id])
    }

    const remainingInStock = db.listInventory('in_stock').filter(i => childIds.includes(i.id))
    expect(remainingInStock).toHaveLength(2)
    expect(remainingInStock.reduce((s, i) => s + i.landed_cost, 0)).toBe(799 + 800)

    // 親は分割後もどの一覧にも in_stock として出ない
    expect(db.getDashboard().stockCount).toBe(2)

    // 商品ページの月別 in_stock：purchased は親を除いた子(4点)、sold=2、in_stock=2
    const product = db.getProduct('W001')!
    expect(product.purchased).toBe(4)
    expect(product.sold).toBe(2)
    expect(product.in_stock).toBe(2)

    const point = product.months.find(m => m.month === '2026-04')!
    expect(point.purchased).toBe(4)
    expect(point.sold).toBe(2)
    expect(point.in_stock).toBe(2)
  })
})
