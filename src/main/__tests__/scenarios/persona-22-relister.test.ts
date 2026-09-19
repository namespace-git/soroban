import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ22：出し直す人（移動・取り下げ・廃棄）', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('出し直しテスト仕入先')
  })

  // 同じ型番を複数回作ることがあるため、既存のidを除いて「今作った1点」を取り出す
  function makeSingleItem(code: string, orderedAt: string, unitPrice = 1000) {
    const before = new Set(db.listInventory('in_stock').map(i => i.id))
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: orderedAt,
      shipping_fee: 0,
      lines: [{ name: `商品【${code}】`, unit_price: unitPrice, quantity: 1 }],
    })
    return db.listInventory('in_stock').find(i => i.model_code === code && !before.has(i.id))!
  }

  it('出品の移動・取り下げ・廃棄・分割・仕入削除・紐付けで、引き当てが正しく外れる／移る', () => {
    // 出品Aに在庫Xを引き当て→出品Bに同じXをreserveInventory→Aは未引き当て、Bに移る
    const x = makeSingleItem('M101', '2026-06-01')
    db.upsertListings([
      { mercariItemId: 'A', title: '商品【M101】', price: 2000, suspended: false, thumbUrl: null },
      { mercariItemId: 'B', title: '商品【M101】', price: 2100, suspended: false, thumbUrl: null },
      { mercariItemId: 'C', title: '商品【M101】', price: 2200, suspended: false, thumbUrl: null },
    ])

    db.reserveInventory('A', [x.id])
    expect(db.listListings().find(l => l.mercari_item_id === 'A')!.items.map(i => i.id)).toEqual([x.id])

    db.reserveInventory('B', [x.id])
    const listA = db.listListings().find(l => l.mercari_item_id === 'A')!
    const listB = db.listListings().find(l => l.mercari_item_id === 'B')!
    expect(listA.items).toHaveLength(0)
    expect(listB.items.map(i => i.id)).toEqual([x.id])
    const xAfterMove = db.listInventory('in_stock').find(i => i.id === x.id)!
    expect(xAfterMove.status).toBe('in_stock')
    expect(xAfterMove.listing).toEqual({ mercari_item_id: 'B', price: 2100, status: 'active' })

    // suggestForListing(B) には自分自身に引き当て済みのXは出ない。別在庫Zは出る
    const z = makeSingleItem('M101', '2026-06-02')
    const suggestions = db.suggestForListing('B')
    expect(suggestions.some(i => i.id === x.id)).toBe(false)
    expect(suggestions.some(i => i.id === z.id)).toBe(true)

    // 取り下げ：Bはended、Xは未出品に戻る
    db.endListing('B')
    const bEnded = db.listListings({ status: ['ended'] }).find(l => l.mercari_item_id === 'B')!
    expect(bEnded.status).toBe('ended')
    const xAfterEnd = db.listInventory('in_stock').find(i => i.id === x.id)!
    expect(xAfterEnd.listing).toBeNull()

    // Cに引き当てて廃棄→Cは未引き当てに戻り、Xはdisposedで在庫金額から消える
    db.reserveInventory('C', [x.id])
    const stockValueBefore = db.getDashboard().stockValue
    db.disposeInventory(x.id, '出し直しをやめた', 'disposed')
    const listC = db.listListings().find(l => l.mercari_item_id === 'C')!
    expect(listC.items).toHaveLength(0)
    const disposedX = db.listInventory('disposed').find(i => i.id === x.id)!
    expect(disposedX.status).toBe('disposed')
    const dash = db.getDashboard()
    expect(dash.stockValue).toBe(stockValueBefore - x.landed_cost)

    // 分割：引き当て中の在庫を分割すると引き当てが外れ、子は未出品
    const splitTarget = makeSingleItem('M102', '2026-06-03', 3000)
    db.upsertListings([{ mercariItemId: 'D', title: '商品【M102】', price: 5000, suspended: false, thumbUrl: null }])
    db.reserveInventory('D', [splitTarget.id])
    const childIds = db.splitInventory(splitTarget.id, 3)
    const listD = db.listListings().find(l => l.mercari_item_id === 'D')!
    expect(listD.items).toHaveLength(0)
    const children = db.listInventory('in_stock').filter(i => childIds.includes(i.id))
    expect(children).toHaveLength(3)
    expect(children.every(c => c.listing === null)).toBe(true)

    // 仕入削除：引き当て中の在庫を持つ仕入をdeletePurchaseすると成功し、出品は未引き当てに戻る
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-06-04',
      shipping_fee: 0,
      lines: [{ name: '商品【M103】', unit_price: 1500, quantity: 1 }],
    })
    const purchases = db.listPurchases()
    const purchaseE = purchases.find(p => p.first_model_code === 'M103')!
    const eItem = db.listInventory('in_stock').find(i => i.model_code === 'M103')!
    db.upsertListings([{ mercariItemId: 'F', title: '商品【M103】', price: 2000, suspended: false, thumbUrl: null }])
    db.reserveInventory('F', [eItem.id])
    expect(() => db.deletePurchase(purchaseE.id)).not.toThrow()
    const listF = db.listListings().find(l => l.mercari_item_id === 'F')!
    expect(listF.items).toHaveLength(0)
    expect(db.listInventory('in_stock').some(i => i.id === eItem.id)).toBe(false)

    // linkInventory：引き当て中の在庫を別の販売に紐付けると紐付き、引き当ては外れる（出品のstatusはそのまま）
    const gItem = makeSingleItem('M104', '2026-06-05', 800)
    db.upsertListings([{ mercariItemId: 'H', title: '商品【M104】', price: 1500, suspended: false, thumbUrl: null }])
    db.reserveInventory('H', [gItem.id])
    const manualSaleId = db.createSale({ title: '手動販売', sold_at: '2026-06-10', price: 1500 })
    db.linkInventory(manualSaleId, [gItem.id])
    const listH = db.listListings().find(l => l.mercari_item_id === 'H')!
    expect(listH.items).toHaveLength(0)
    expect(listH.status).toBe('active')
    const saleG = db.listSales().find(s => s.id === manualSaleId)!
    expect(saleG.cost).toBe(800)

    // 販売済みの在庫をreserveInventoryするとthrow
    expect(() => db.reserveInventory('H', [gItem.id])).toThrow()
  })
})
