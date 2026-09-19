import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ04：家族が間違える人', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('メロジョイ')
  })

  it('転売⇔私物の切り替えで月次の集計対象から出入りする', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-01',
      shipping_fee: 0,
      lines: [{ name: '商品', unit_price: 1000, quantity: 1 }],
    })
    const item = db.listInventory('in_stock')[0]

    const saleId = db.createSale({ title: '商品', sold_at: '2026-05-05', price: 2000 })
    db.linkInventory(saleId, [item.id])
    // fee = floor(2000*1000/10000) = 200、粗利 = 2000-200-0-0-1000 = 800
    expect(db.listSales().find(s => s.id === saleId)!.gross_profit).toBe(800)

    const month = '2026-05'
    expect(db.listMonthly().find(m => m.month === month && m.kind === 'resale')!.gross_profit).toBe(800)

    // 私物に切り替え
    db.updateSale(saleId, { kind: 'personal' })
    expect(db.listSales().find(s => s.id === saleId)!.kind).toBe('personal')
    // 転売の集計から消える
    expect(db.listMonthly().find(m => m.month === month && m.kind === 'resale')).toBeUndefined()
    expect(db.listMonthly().find(m => m.month === month && m.kind === 'personal')!.gross_profit).toBe(800)

    // 戻す
    db.updateSale(saleId, { kind: 'resale' })
    expect(db.listMonthly().find(m => m.month === month && m.kind === 'resale')!.gross_profit).toBe(800)
    expect(db.listMonthly().find(m => m.month === month && m.kind === 'personal')).toBeUndefined()
  })

  it('紐付けた（売れた）在庫は廃棄できない', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-01',
      shipping_fee: 0,
      lines: [{ name: '商品', unit_price: 1000, quantity: 1 }],
    })
    const item = db.listInventory('in_stock')[0]
    const saleId = db.createSale({ title: '商品', sold_at: '2026-05-05', price: 2000 })
    db.linkInventory(saleId, [item.id])

    expect(() => db.disposeInventory(item.id, '間違えて廃棄しようとした'))
      .toThrow('販売済みの在庫は外せません')
  })

  it('販売を削除すると、紐付いていた在庫はin_stockに戻る', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-01',
      shipping_fee: 0,
      lines: [{ name: '商品', unit_price: 1000, quantity: 1 }],
    })
    const item = db.listInventory('in_stock')[0]
    const saleId = db.createSale({ title: '商品', sold_at: '2026-05-05', price: 2000 })
    db.linkInventory(saleId, [item.id])
    expect(db.listInventory('in_stock')).toHaveLength(0)

    db.deleteSale(saleId)

    expect(db.listSales().some(s => s.id === saleId)).toBe(false)
    expect(db.listInventory('in_stock').some(i => i.id === item.id)).toBe(true)
  })

  it('売れた在庫がある仕入は削除できない。紐付けを外せば削除できる', () => {
    const purchaseId = db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-01',
      shipping_fee: 0,
      lines: [{ name: '商品', unit_price: 1000, quantity: 1 }],
    })
    const item = db.listInventory('in_stock')[0]
    const saleId = db.createSale({ title: '商品', sold_at: '2026-05-05', price: 2000 })
    db.linkInventory(saleId, [item.id])

    expect(() => db.deletePurchase(purchaseId)).toThrow('販売済みの在庫')

    db.unlinkInventory(saleId, item.id)
    expect(() => db.deletePurchase(purchaseId)).not.toThrow()
    expect(db.listPurchases().some(p => p.id === purchaseId)).toBe(false)
  })
})
