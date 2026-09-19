import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

beforeEach(() => { db.initDb(':memory:') })

// ペルソナ16：タグで整理する人。
// 「セール」「まとめ売り」タグを作り、販売と在庫に付けて絞り込む。
describe('ペルソナ16：タグで整理する人', () => {
  it('タグで絞った saleTotals/listSales が手計算と一致→改名→削除→在庫にも付けられる', () => {
    const saleTag = db.createTag('セール')
    const bundleTag = db.createTag('まとめ売り')
    expect(db.listTags().map(t => t.name)).toEqual(['セール', 'まとめ売り'])

    // 販売3件。手数料率は既定10%（切り捨て）。送料は手入力で確定させる
    const s1 = db.createSale({ title: 'ぬいぐるみA', price: 3000, sold_at: '2026-05-01' })
    db.updateSale(s1, { shipping_fee: 300 }) // fee=300, profit=3000-300-300=2400

    const s2 = db.createSale({ title: 'ぬいぐるみB', price: 5000, sold_at: '2026-05-02' })
    db.updateSale(s2, { shipping_fee: 400 }) // fee=500, profit=5000-500-400=4100

    const s3 = db.createSale({ title: 'ぬいぐるみC', price: 2000, sold_at: '2026-05-03' })
    db.updateSale(s3, { shipping_fee: 200 }) // fee=200, profit=2000-200-200=1600

    // 3件のうち2件（s1, s2）に「セール」タグを付ける
    db.setSaleTags(s1, [saleTag])
    db.setSaleTags(s2, [saleTag, bundleTag])

    const totals = db.saleTotals({ tagId: saleTag })
    expect(totals.count).toBe(2)
    expect(totals.revenue).toBe(3000 + 5000)
    expect(totals.total_fee).toBe(300 + 500)
    expect(totals.total_shipping).toBe(300 + 400)
    expect(totals.total_cost).toBe(0) // 在庫を紐付けていないので原価0
    expect(totals.gross_profit).toBe(2400 + 4100)
    // 合計の整合性：売上-手数料-送料-梱包-原価=粗利
    expect(totals.revenue - totals.total_fee - totals.total_shipping - totals.total_packaging - totals.total_cost)
      .toBe(totals.gross_profit)

    const sales = db.listSales({ tagId: saleTag })
    expect(sales.map(s => s.id).sort()).toEqual([s1, s2].sort())

    // タグを改名しても紐付けは変わらない
    db.renameTag(saleTag, 'SALE')
    expect(db.listTags().find(t => t.id === saleTag)?.name).toBe('SALE')
    expect(db.listSales({ tagId: saleTag }).map(s => s.id).sort()).toEqual([s1, s2].sort())

    // タグを削除すると、販売からは外れるが販売そのものは残る
    db.deleteTag(saleTag)
    expect(db.listTags().find(t => t.id === saleTag)).toBeUndefined()
    const allSales = db.listSales()
    expect(allSales).toHaveLength(3)
    expect(allSales.find(s => s.id === s2)?.tags.map(t => t.id)).toEqual([bundleTag])
    expect(allSales.find(s => s.id === s1)?.tags).toEqual([])

    // 在庫にもタグを付けて listInventory に出る
    const shopId = db.createShopAccount('仕入先A')
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-01',
      lines: [{ name: 'アクリルスタンド', unit_price: 1000, quantity: 1 }],
    })
    const item = db.listInventory('in_stock')[0]
    db.setInventoryTags(item.id, [bundleTag])
    const inv = db.listInventory('in_stock').find(i => i.id === item.id)
    expect(inv?.tags.map(t => t.id)).toEqual([bundleTag])
  })
})
