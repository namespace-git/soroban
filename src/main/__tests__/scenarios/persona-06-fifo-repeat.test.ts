import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ06：同じ型番を何度も仕入れる人', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('メロジョイ')
  })

  it('同じ型番を3回仕入れる→取り込みは先入先出で充たり、在庫が尽きたら候補にも出ない', () => {
    // 同じ型番Z999-1を、仕入日が違う3回の注文で1点ずつ仕入れる（送料なし＝原価はそのまま単価）
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: '【Z999-1】ばーむ', unit_price: 1000, quantity: 1 }],
    })
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-05',
      shipping_fee: 0,
      lines: [{ name: '【Z999-1】ばーむ', unit_price: 1200, quantity: 1 }],
    })
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-10',
      shipping_fee: 0,
      lines: [{ name: '【Z999-1】ばーむ', unit_price: 1500, quantity: 1 }],
    })

    const stock = db.listInventory('in_stock').filter(i => i.model_code === 'Z999-1')
    expect(stock).toHaveLength(3)
    expect(stock.map(i => i.landed_cost).sort((a, b) => a - b)).toEqual([1000, 1200, 1500])

    // 1件目・2件目の取り込み：先入先出で 1,000 → 1,200 の順に充たる
    const c1 = db.insertCollected([{
      mercariItemId: 's-persona06-1', title: '【Z999-1】ばーむ', price: 2000, soldAt: '2026-02-01',
    }])
    const sale1 = db.listSales().find(s => s.id === c1[0].id)!
    expect(sale1.unmatched).toBe(0)
    expect(sale1.cost).toBe(1000)

    const c2 = db.insertCollected([{
      mercariItemId: 's-persona06-2', title: '【Z999-1】ばーむ', price: 2000, soldAt: '2026-02-02',
    }])
    const sale2 = db.listSales().find(s => s.id === c2[0].id)!
    expect(sale2.unmatched).toBe(0)
    expect(sale2.cost).toBe(1200)

    // 3件目の取り込み：残っている1,500が充たる
    const c3 = db.insertCollected([{
      mercariItemId: 's-persona06-3', title: '【Z999-1】ばーむ', price: 2000, soldAt: '2026-02-03',
    }])
    const sale3 = db.listSales().find(s => s.id === c3[0].id)!
    expect(sale3.unmatched).toBe(0)
    expect(sale3.cost).toBe(1500)

    // 在庫が尽きた。4件目は未紐付けのまま
    expect(db.listInventory('in_stock').filter(i => i.model_code === 'Z999-1')).toHaveLength(0)
    const c4 = db.insertCollected([{
      mercariItemId: 's-persona06-4', title: '【Z999-1】ばーむ', price: 2000, soldAt: '2026-02-04',
    }])
    const sale4 = db.listSales().find(s => s.id === c4[0].id)!
    expect(sale4.unmatched).toBe(1)
    expect(sale4.cost).toBe(0)

    // 候補にも出ない（在庫が無いので空）
    expect(db.suggestInventory(sale4.id)).toEqual([])
  })
})
