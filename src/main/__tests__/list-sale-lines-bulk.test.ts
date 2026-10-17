import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../db'

// listSaleLinesBulk：売上一覧が販売ごとに listSaleLines を呼ばないための、まとめ取り。
// 値は listSaleLines(id) と同じ中身・同じ並び／紐付けの無い販売・知らない id はキーを持たない／重複 id は 1 つ／501 件で Error。

describe('listSaleLinesBulk', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('まとめ取りテスト仕入先')
  })

  /** 名前の違う在庫を n 点つくる（ORDER BY iv.name の並びを確かめるため、名前を逆順に振る） */
  function stockItems(prefix: string, n: number): string[] {
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: Array.from({ length: n }, (_, i) => ({
        name: `${prefix}${String.fromCharCode(90 - i)}`, unit_price: 1000 + i, quantity: 1,
      })),
    })
    return db.listInventory('in_stock').filter(i => i.name.startsWith(prefix)).map(i => i.id)
  }

  it('まとめ売りを含む複数の販売で、各販売の値が listSaleLines と一致する。紐付けの無い販売・知らない id はキーを持たない', () => {
    const ids = stockItems('単品', 1).concat(stockItems('セット', 3))
    const [single, ...bundle] = ids

    const sale1 = db.createSale({ title: 'まとめ取りA', sold_at: '2026-01-05', price: 2000 })
    const sale2 = db.createSale({ title: 'まとめ取りB（セット）', sold_at: '2026-01-06', price: 5000 })
    const sale3 = db.createSale({ title: 'まとめ取りC（紐付け無し）', sold_at: '2026-01-07', price: 800 })
    db.linkInventory(sale1, [single])
    db.linkInventory(sale2, bundle)

    const out = db.listSaleLinesBulk([sale1, sale2, sale3, 'no-such-sale'])

    expect(Object.keys(out).sort()).toEqual([sale1, sale2].sort())
    expect(out[sale1]).toEqual(db.listSaleLines(sale1))
    expect(out[sale2]).toEqual(db.listSaleLines(sale2))
    expect(out[sale1]).toHaveLength(1)
    expect(out[sale2]).toHaveLength(3)
    // 並びも listSaleLines と同じ（名前順）
    expect(out[sale2].map(i => i.id)).toEqual(db.listSaleLines(sale2).map(i => i.id))
    expect(sale3 in out).toBe(false)
    expect('no-such-sale' in out).toBe(false)
  })

  it('id が重複していても 1 つにまとめる／空配列は空のオブジェクト', () => {
    const [item] = stockItems('重複', 1)
    const sale = db.createSale({ title: '重複テスト', sold_at: '2026-01-05', price: 2000 })
    db.linkInventory(sale, [item])

    const out = db.listSaleLinesBulk([sale, sale, sale])
    expect(Object.keys(out)).toEqual([sale])
    expect(out[sale].map(i => i.id)).toEqual([item])

    expect(db.listSaleLinesBulk([])).toEqual({})
  })

  it('500 件までは通り、501 件を超えると日本語の Error。配列でないものも Error', () => {
    const ids500 = Array.from({ length: 500 }, (_, i) => `x-${i}`)
    expect(db.listSaleLinesBulk(ids500)).toEqual({})

    const ids501 = Array.from({ length: 501 }, (_, i) => `x-${i}`)
    expect(() => db.listSaleLinesBulk(ids501)).toThrow(/500 件/)

    expect(() => db.listSaleLinesBulk('abc' as unknown as string[])).toThrow(/販売の指定/)
    expect(() => db.listSaleLinesBulk([1] as unknown as string[])).toThrow(/販売の指定/)
  })
})
