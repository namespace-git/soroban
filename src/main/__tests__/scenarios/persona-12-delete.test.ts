import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ12：消す人', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('削除テスト仕入先')
  })

  it('未販売のみの仕入は削除できる。売れた在庫がある仕入は削除できない（エラー文言）。販売削除で在庫が戻る', () => {
    // 未販売のみ → 削除可能
    const purchaseId1 = db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-06-01',
      shipping_fee: 0,
      lines: [{ name: '未販売の商品', unit_price: 1000, quantity: 2 }],
    })
    expect(db.listInventory('in_stock')).toHaveLength(2)
    db.deletePurchase(purchaseId1)
    expect(db.listInventory('in_stock')).toHaveLength(0)
    expect(db.listPurchases()).toHaveLength(0)

    // 売れた在庫がある仕入は削除できない
    const purchaseId2 = db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-06-02',
      shipping_fee: 0,
      lines: [{ name: '売れた商品', unit_price: 1000, quantity: 1 }],
    })
    const item = db.listInventory('in_stock')[0]
    const saleId = db.createSale({ title: '売れた商品', sold_at: '2026-06-05', price: 2000 })
    db.linkInventory(saleId, [item.id])

    expect(() => db.deletePurchase(purchaseId2))
      .toThrow('この仕入には販売済みの在庫が1点あります。先に紐付けを解除してください')

    // 販売・在庫にタグを付けておく
    const saleTagId = db.createTag('削除テスト用タグ')
    db.setSaleTags(saleId, [saleTagId])
    const invTagId = db.createTag('在庫タグ')
    db.setInventoryTags(item.id, [invTagId])

    // 販売を削除 → 紐付いていた在庫がin_stockに戻る
    db.deleteSale(saleId)
    const backToStock = db.listInventory('in_stock')
    expect(backToStock).toHaveLength(1)
    expect(backToStock[0].id).toBe(item.id)
    // 在庫についていたタグ（inventory_tag）は在庫側の記録なので残る
    expect(backToStock[0].tags.map(t => t.id)).toEqual([invTagId])
    // 販売が消えたので sale_tag は CASCADE で消えるが、tag マスタ自体は残る
    expect(db.listTags().some(t => t.id === saleTagId)).toBe(true)

    // 在庫が戻ったので、今度は仕入を削除できる
    db.deletePurchase(purchaseId2)
    expect(db.listInventory('in_stock')).toHaveLength(0)

    // タグを削除 → 付いていた対象からは外れるが、対象自体（販売・在庫）は残る
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-06-10',
      shipping_fee: 0,
      lines: [{ name: 'タグテスト用', unit_price: 500, quantity: 1 }],
    })
    const item2 = db.listInventory('in_stock')[0]
    db.setInventoryTags(item2.id, [invTagId])
    expect(db.listInventory('in_stock')[0].tags.map(t => t.id)).toEqual([invTagId])

    db.deleteTag(invTagId)
    expect(db.listInventory('in_stock')).toHaveLength(1) // 在庫自体は残る
    expect(db.listInventory('in_stock')[0].tags).toEqual([]) // タグだけ外れる

    const saleId2 = db.createSale({ title: 'タグ削除後も残る販売', sold_at: '2026-06-11', price: 1000 })
    db.setSaleTags(saleId2, [saleTagId])
    db.deleteTag(saleTagId)
    expect(db.listSales().find(s => s.id === saleId2)).toBeDefined() // 販売自体は残る
    expect(db.listSales().find(s => s.id === saleId2)!.tags).toEqual([])
  })
})
