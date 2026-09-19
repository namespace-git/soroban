import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'
import { todayLocal } from '../../../shared/date'

describe('ペルソナ21：出品する人（基本の流れ）', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('出品テスト仕入先')
  })

  it('引き当て→出品→売れる で在庫数・原価・粗利見込み・履歴が一致する', () => {
    const title = '【L001】ぬいぐるみ'

    // 送料あり・数量3。CLAUDE.mdの例と同じ按分（1000×3、送料100→33/33/34）
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-01',
      shipping_fee: 100,
      lines: [{ name: title, unit_price: 1000, quantity: 3 }],
    })

    const items = db.listInventory('in_stock').filter(i => i.model_code === 'L001')
    expect(items).toHaveLength(3)
    // pool=100（1明細のみなので端数もそのまま）。splitEvenly(100,3)=[33,33,34]
    expect(items.map(i => i.landed_cost).sort((a, b) => a - b)).toEqual([1033, 1033, 1034])
    expect(items.reduce((s, i) => s + i.landed_cost, 0)).toBe(3100) // 1000*3+100 と一致

    db.upsertListings([
      { mercariItemId: 'LST1', title, price: 2500, suspended: false, thumbUrl: null },
    ])

    // 出品への引き当て候補：型番一致の3点が出る（同じ仕入内で古い順＝作成順）
    const suggestions = db.suggestForListing('LST1')
    expect(suggestions.map(i => i.id).sort()).toEqual(items.map(i => i.id).sort())
    const [first] = items // 挿入順の先頭（rowid順）を1点引き当てる

    db.reserveInventory('LST1', [first.id])

    const listing = db.listListings().find(l => l.mercari_item_id === 'LST1')!
    expect(listing.items.map(i => i.id)).toEqual([first.id])
    expect(listing.reserved_cost).toBe(first.landed_cost)
    // fee = floor(2500*1000/10000) = 250。expected_profit = 2500 - 250 - 原価
    expect(listing.expected_profit).toBe(2500 - 250 - first.landed_cost)

    // listInventory：引き当て済みでも status は in_stock のまま。listing は派生で見える
    const afterReserve = db.listInventory('in_stock').find(i => i.id === first.id)!
    expect(afterReserve.status).toBe('in_stock')
    expect(afterReserve.listing).toEqual({ mercari_item_id: 'LST1', price: 2500, status: 'active' })

    // 在庫数・在庫金額は出品しても変わらない
    const dashBefore = db.getDashboard()
    expect(dashBefore.stockCount).toBe(3)
    expect(dashBefore.stockValue).toBe(3100)

    // 同じ mercari_item_id で販売が来る → 引き当てをそのまま引き継ぐ
    const soldAt = todayLocal()
    const [inserted] = db.insertCollected([{ mercariItemId: 'LST1', title, price: 2500, soldAt }])

    const sale = db.listSales().find(s => s.id === inserted.id)!
    expect(sale.unmatched).toBe(0)
    expect(sale.item_count).toBe(1)
    expect(sale.cost).toBe(first.landed_cost)
    expect(sale.auto_linked).toBe(0) // link_source='listing'であって'auto'ではない

    const lines = db.getDb().prepare(
      'SELECT link_source FROM sale_line WHERE sale_id = ?',
    ).all(sale.id) as Array<{ link_source: string }>
    expect(lines).toEqual([{ link_source: 'listing' }])

    // 出品は sold になり、listing_line は消える
    const soldListing = db.listListings({ status: ['sold'] }).find(l => l.mercari_item_id === 'LST1')!
    expect(soldListing.status).toBe('sold')
    expect(soldListing.items).toHaveLength(0)

    // 在庫数は減る（1点が sold に）。残り2点はそのまま
    const dashAfter = db.getDashboard()
    expect(dashAfter.stockCount).toBe(2)
    expect(dashAfter.stockValue).toBe(3100 - first.landed_cost)

    // 履歴：listed → sold の順
    const timeline = db.getItemTimeline(first.id)!
    const kinds = timeline.events.map(e => e.kind)
    expect(kinds.indexOf('listed')).toBeGreaterThanOrEqual(0)
    expect(kinds.indexOf('sold')).toBeGreaterThan(kinds.indexOf('listed'))
  })

  it('引き当て無しの出品が売れたら：出品はsold、販売は枝番ありなら自動FIFO、枝番なしなら候補止まり', () => {
    // 枝番あり（L002-1）：自動確定される
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-01',
      shipping_fee: 0,
      lines: [{ name: '商品【L002-1】', unit_price: 1000, quantity: 2 }],
    })
    db.upsertListings([
      { mercariItemId: 'LST2', title: '商品【L002-1】', price: 1800, suspended: false, thumbUrl: null },
    ])
    // 引き当てはしない

    const [insertedA] = db.insertCollected(
      [{ mercariItemId: 'LST2', title: '商品【L002-1】', price: 1800, soldAt: todayLocal() }],
    )
    const saleA = db.listSales().find(s => s.id === insertedA.id)!
    expect(saleA.unmatched).toBe(0)
    expect(saleA.auto_linked).toBe(1)
    expect(saleA.cost).toBe(1000) // 送料なしなので原価は単価そのまま
    expect(db.listInventory('in_stock').filter(i => i.model_code === 'L002-1')).toHaveLength(1)

    const listingA = db.listListings({ status: ['sold'] }).find(l => l.mercari_item_id === 'LST2')!
    expect(listingA.status).toBe('sold')

    // 枝番なし（L003：シリーズだけ）：自動確定しない。候補止まり
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-01',
      shipping_fee: 0,
      lines: [{ name: '商品【L003】', unit_price: 1000, quantity: 1 }],
    })
    db.upsertListings([
      { mercariItemId: 'LST3', title: '商品【L003】', price: 1500, suspended: false, thumbUrl: null },
    ])

    const [insertedB] = db.insertCollected(
      [{ mercariItemId: 'LST3', title: '商品【L003】', price: 1500, soldAt: todayLocal() }],
    )
    const saleB = db.listSales().find(s => s.id === insertedB.id)!
    expect(saleB.unmatched).toBe(1)
    expect(saleB.item_count).toBe(0)

    // それでも出品は sold になる（売れた以上、出品タブに active のまま残さない）
    const listingB = db.listListings({ status: ['sold'] }).find(l => l.mercari_item_id === 'LST3')!
    expect(listingB.status).toBe('sold')

    // 候補には出る（人が確定すればよい）
    const candidateItem = db.listInventory('in_stock').find(i => i.model_code === 'L003')!
    const suggestions = db.suggestInventory(saleB.id)
    expect(suggestions.some(i => i.id === candidateItem.id)).toBe(true)
  })
})
