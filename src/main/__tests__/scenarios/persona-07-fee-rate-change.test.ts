import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ07：手数料率を変える人', () => {
  beforeEach(() => {
    db.initDb(':memory:')
  })

  it('10%で2件売れた後に8%へ変更しても既存の販売は再計算されない。新規は新しい率、収集の実額はそれも優先', () => {
    // 既定 10%（fee_rate_bp=1000）
    const sale1Id = db.createSale({ title: 'A', sold_at: '2026-07-01', price: 1000 })
    const sale2Id = db.createSale({ title: 'B', sold_at: '2026-07-02', price: 2000 })

    expect(db.listSales().find(s => s.id === sale1Id)!.fee).toBe(100) // floor(1000*1000/10000)
    expect(db.listSales().find(s => s.id === sale2Id)!.fee).toBe(200) // floor(2000*1000/10000)

    // 8%へ変更
    db.setSetting('fee_rate_bp', '800')

    // 既存2件の手数料・粗利は変わらない
    expect(db.listSales().find(s => s.id === sale1Id)!.fee).toBe(100)
    expect(db.listSales().find(s => s.id === sale2Id)!.fee).toBe(200)

    // 新しい手入力の販売は8%
    const sale3Id = db.createSale({ title: 'C', sold_at: '2026-07-03', price: 1000 })
    expect(db.listSales().find(s => s.id === sale3Id)!.fee).toBe(80) // floor(1000*800/10000)

    // 収集の販売は fee 実額が渡されればそれを優先（8%換算の80ではなく実額）
    const collected = db.insertCollected([{
      mercariItemId: 'm-persona07-1',
      title: '実額あり',
      price: 1000,
      soldAt: '2026-07-04',
      fee: 777,
    }])
    expect(db.listSales().find(s => s.id === collected[0].id)!.fee).toBe(777)

    // fee を渡さない収集は現在の料率（8%）で計算される
    const collected2 = db.insertCollected([{
      mercariItemId: 'm-persona07-2',
      title: '実額なし',
      price: 1000,
      soldAt: '2026-07-05',
    }])
    expect(db.listSales().find(s => s.id === collected2[0].id)!.fee).toBe(80)
  })
})
