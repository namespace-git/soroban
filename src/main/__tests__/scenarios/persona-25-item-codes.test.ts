import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'
import { todayLocal } from '../../../shared/date'

// ============================================================
// ペルソナ25：在庫コードで売る人（初心者の家族）
//
// 「箱を開けて半分ずつ売る」「2個セットで売る」を、型番だけでは
// 区別できない在庫1点ずつに、そろばんが発行する在庫コード（S-0001…）で
// 指定できるようにした機能のシナリオ。
// ============================================================

describe('ペルソナ25：在庫コードで売る人', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('在庫コードテスト仕入先')
  })

  it('仕入で在庫コードが順に振られる→分割で子が新コードを持つ→出品タイトルの在庫コードだけが自動で引き当たる→売れてその在庫が紐付く', () => {
    // 仕入 Z078-2 ×3 → 在庫コード S-0001〜S-0003 が振られる（送料なしなので原価は単価そのまま）
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-01',
      shipping_fee: 0,
      lines: [{ name: '【Z078-2】いちごスフレ', unit_price: 1000, quantity: 3 }],
    })
    const items = db.listInventory('in_stock')
    expect(items.map(i => i.item_code).sort()).toEqual(['S-0001', 'S-0002', 'S-0003'])
    const s1 = items.find(i => i.item_code === 'S-0001')!

    // 1点(S-0001)を2つに分割 → 子は新しいコード(S-0004・S-0005)を持ち、
    // 名前は「元の名前（分割 1/2）」「（分割 2/2）」、原価は均等割り(1000→500/500)
    const childIds = db.splitInventory(s1.id, 2)
    const children = db.listInventory('in_stock').filter(i => childIds.includes(i.id))
    const child1 = children.find(c => c.item_code === 'S-0004')!
    const child2 = children.find(c => c.item_code === 'S-0005')!
    expect(child1.name).toBe(`${s1.name}（分割 1/2）`)
    expect(child2.name).toBe(`${s1.name}（分割 2/2）`)
    expect(child1.landed_cost).toBe(500)
    expect(child2.landed_cost).toBe(500)
    // 親は split になり in_stock から消える
    expect(db.listInventory('in_stock').some(i => i.id === s1.id)).toBe(false)

    // 出品タイトル『【S-0004】半分』→ autoReserveListings で S-0004 だけ引き当たる（S-0005 は対象外）
    db.upsertListings([
      { mercariItemId: 'L1', title: '【S-0004】半分', price: 1500, suspended: false, thumbUrl: null },
    ])
    const reserved = db.autoReserveListings()
    expect(reserved).toBe(1)
    const listing = db.listListings().find(l => l.mercari_item_id === 'L1')!
    expect(listing.items.map(i => i.item_code)).toEqual(['S-0004'])

    // 売れる → 出品への引き当て（listing）がそのまま紐付けへ引き継がれる
    const soldAt = todayLocal()
    const [inserted] = db.insertCollected(
      [{ mercariItemId: 'L1', title: '【S-0004】半分', price: 1500, soldAt }],
    )
    const sale = db.listSales().find(s => s.id === inserted.id)!
    expect(sale.kind).toBe('resale')
    expect(sale.item_count).toBe(1)
    expect(sale.cost).toBe(500)
    expect(sale.unmatched).toBe(0)

    const linked = db.listSaleLines(sale.id)
    expect(linked.map(i => i.item_code)).toEqual(['S-0004'])
    // S-0005 は無関係。in_stock のまま残る
    expect(db.listInventory('in_stock').some(i => i.item_code === 'S-0005')).toBe(true)
  })

  it('在庫コードが複数見つかれば全部自動で紐付き、costが合算される（2個セット）', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-01',
      shipping_fee: 0,
      lines: [{ name: '【Z078-2】いちごスフレ', unit_price: 1000, quantity: 2 }],
    })
    const items = db.listInventory('in_stock')
    const a = items.find(i => i.item_code === 'S-0001')!
    const b = items.find(i => i.item_code === 'S-0002')!

    const saleId = db.createSale({
      title: '【S-0001】【S-0002】2個セット', sold_at: '2026-05-10', price: 3000,
    })
    const sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.item_count).toBe(2)
    expect(sale.auto_linked).toBe(1)
    expect(sale.unmatched).toBe(0)
    expect(sale.cost).toBe(a.landed_cost + b.landed_cost)
    expect(sale.cost).toBe(2000)

    const linkedIds = db.listSaleLines(saleId).map(i => i.id).sort()
    expect(linkedIds).toEqual([a.id, b.id].sort())
  })

  it('在庫コードが無ければ型番1つ＋個数表記でFIFO：【Z078-2】×2 なら古い順2点が紐付く', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-01',
      shipping_fee: 0,
      lines: [{ name: '【Z078-2】いちごスフレ', unit_price: 1000, quantity: 1 }],
    })
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-10',
      shipping_fee: 0,
      lines: [{ name: '【Z078-2】いちごスフレ', unit_price: 1200, quantity: 1 }],
    })
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-20',
      shipping_fee: 0,
      lines: [{ name: '【Z078-2】いちごスフレ', unit_price: 1500, quantity: 1 }],
    })
    const items = db.listInventory('in_stock').sort((x, y) => x.acquired_at.localeCompare(y.acquired_at))
    expect(items.map(i => i.landed_cost)).toEqual([1000, 1200, 1500])

    // 在庫コードは書かず、型番＋個数表記だけの販売
    const saleId = db.createSale({ title: '【Z078-2】×2', sold_at: '2026-04-25', price: 4000 })
    const sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.item_count).toBe(2)
    expect(sale.auto_linked).toBe(1)
    expect(sale.unmatched).toBe(0)
    // FIFO：一番古い2点（1000円・1200円）が紐付く。一番新しい(1500円)在庫は残る
    expect(sale.cost).toBe(1000 + 1200)

    const linked = db.listSaleLines(saleId)
    expect(linked.map(i => i.landed_cost).sort((x, y) => x - y)).toEqual([1000, 1200])
    expect(db.listInventory('in_stock').map(i => i.landed_cost)).toEqual([1500])
  })

  it('在庫コードの一部が見つからなければ、見つかった分だけ確定してunmatchedが残る（存在しないコード混在）', () => {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-06-01',
      shipping_fee: 0,
      lines: [{ name: '【Z078-2】いちごスフレ', unit_price: 1000, quantity: 1 }],
    })
    const only = db.listInventory('in_stock')[0]
    expect(only.item_code).toBe('S-0001')

    // S-9999 は存在しない在庫コード
    const saleId = db.createSale({
      title: '【S-0001】【S-9999】まとめ売り', sold_at: '2026-06-05', price: 2000,
    })
    const sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.item_count).toBe(1)
    expect(sale.auto_linked).toBe(1)
    // 片方が見つからないので候補止まり（見つかった分だけ確定、unmatchedは残る）
    expect(sale.unmatched).toBe(1)
    expect(sale.cost).toBe(1000)

    const linked = db.listSaleLines(saleId)
    expect(linked.map(i => i.item_code)).toEqual(['S-0001'])
  })
})
