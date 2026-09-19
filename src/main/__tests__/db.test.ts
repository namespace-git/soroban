import { beforeEach, describe, expect, it, vi } from 'vitest'

// db.ts は electron の app.getPath を参照する（:memory: を使うときは呼ばれないが、
// import 時点で electron モジュールへの依存があるため潰しておく）
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import * as db from '../db'

describe('db（:memory:）', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('メロジョイA')
  })

  it('createPurchase：送料100・数量3の1行で在庫合計がpoolと一致する', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 100,
      lines: [{ name: 'テスト商品', unit_price: 1000, quantity: 3 }],
    })

    const items = db.listInventory('in_stock')
    expect(items).toHaveLength(3)

    const totalLanded = items.reduce((s, i) => s + i.landed_cost, 0)
    // subtotal(1000*3=3000) + pool(100) = 3100 と一致するはず
    expect(totalLanded).toBe(3000 + 100)

    // 端数(100/3=33.33)は最後のアイテムに寄る
    const sorted = [...items].sort((a, b) => a.landed_cost - b.landed_cost)
    expect(sorted.map(i => i.landed_cost)).toEqual([1033, 1033, 1034])
  })

  it('createPurchase：複数行でも明細ごと・全体の合計が一致する', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-02',
      shipping_fee: 100,
      other_cost: 50,
      discount: 20,
      lines: [
        { name: '商品A', unit_price: 1000, quantity: 2 },
        { name: '商品B', unit_price: 500, quantity: 3 },
      ],
    })

    const items = db.listInventory('in_stock')
    expect(items).toHaveLength(5)

    const subtotal = 1000 * 2 + 500 * 3
    const pool = 100 + 50 - 20
    const totalLanded = items.reduce((s, i) => s + i.landed_cost, 0)
    expect(totalLanded).toBe(subtotal + pool)

    const purchases = db.listPurchases()
    expect(purchases[0].total_cost).toBe(subtotal + pool)
    expect(purchases[0].subtotal).toBe(subtotal)
  })

  it('createSale → linkInventory → listSaleLines / listSales の cost・gross_profit が正しい', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: '売る商品', unit_price: 1000, quantity: 1 }],
    })
    const item = db.listInventory('in_stock')[0]

    const saleId = db.createSale({
      title: '売る商品',
      sold_at: '2026-01-05',
      price: 2000,
    })
    db.linkInventory(saleId, [item.id])

    const lines = db.listSaleLines(saleId)
    expect(lines).toHaveLength(1)
    expect(lines[0].id).toBe(item.id)

    const sales = db.listSales()
    const sale = sales.find(s => s.id === saleId)!
    expect(sale.cost).toBe(1000)
    // fee_rate_bp 既定1000(10%) → fee = floor(2000*1000/10000) = 200
    expect(sale.fee).toBe(200)
    expect(sale.gross_profit).toBe(2000 - 200 - 0 - 0 - 1000)
    expect(sale.unmatched).toBe(0)

    // 紐付けた在庫は sold になるので in_stock からは消える
    expect(db.listInventory('in_stock')).toHaveLength(0)
  })

  it('disposeInventory：personal_useでstatusが変わる／sold在庫は外せない', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: '在庫X', unit_price: 500, quantity: 2 }],
    })
    const [item1, item2] = db.listInventory('in_stock')

    db.disposeInventory(item1.id, 'テスト理由', 'personal_use')
    const personalUse = db.listInventory('personal_use')
    expect(personalUse).toHaveLength(1)
    expect(personalUse[0].id).toBe(item1.id)

    // item2 を売って sold にしてから外そうとするとthrow
    const saleId = db.createSale({ title: '在庫X', sold_at: '2026-01-06', price: 1000 })
    db.linkInventory(saleId, [item2.id])
    expect(() => db.disposeInventory(item2.id, 'テスト')).toThrow()
  })
})
