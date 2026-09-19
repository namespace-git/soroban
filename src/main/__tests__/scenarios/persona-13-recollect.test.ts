import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ13：二度取り込まれる人', () => {
  beforeEach(() => {
    db.initDb(':memory:')
  })

  it('同じmercariItemIdでinsertCollectedを生で2回呼ぶとUNIQUE制約でエラーになる（静かな重複防止ではない）', () => {
    db.insertCollected([
      { mercariItemId: 'dup-1', title: '二度目チェック', price: 1000, soldAt: '2026-07-01' },
    ])
    expect(db.listSales().filter(s => s.mercari_item_id === 'dup-1')).toHaveLength(1)

    // insertCollected自体には「既存ならスキップ」する仕組みが無い。
    // 呼び出し側（collector.ts）が existingMercariIds で事前にフィルタする前提の設計。
    // 生で2回呼ぶと mercari_item_id の UNIQUE 制約違反で例外になる
    expect(() => db.insertCollected([
      { mercariItemId: 'dup-1', title: '二度目チェック', price: 1000, soldAt: '2026-07-01' },
    ])).toThrow()

    // 実運用どおり：existingMercariIdsで先に弾けば安全に再取り込みを避けられる
    const already = db.existingMercariIds(['dup-1', 'dup-2'])
    expect(already.has('dup-1')).toBe(true)
    expect(already.has('dup-2')).toBe(false)
  })

  it('updateCollectedActuals：人が手で送料・メモを直した後でも、shipping_source=manualなら静かに実額で上書きされる', () => {
    const [inserted] = db.insertCollected([
      { mercariItemId: 'touch-1', title: '人が触った商品', price: 3000, soldAt: '2026-07-05' },
    ])
    // 人が送料を手入力（manual）で確定し、メモも書く
    db.updateSale(inserted.id, { shipping_fee: 500 })
    db.updateSale(inserted.id, { note: '梱包を厚めにした' })

    let sale = db.listSales().find(s => s.id === inserted.id)!
    expect(sale.shipping_source).toBe('manual')
    expect(sale.shipping_fee).toBe(500)
    expect(sale.note).toBe('梱包を厚めにした')

    // collectorが後から実額を取ってきて上書きしようとする
    const updated = db.updateCollectedActuals([
      { mercariItemId: 'touch-1', soldAt: '2026-07-05', fee: 280, shippingFee: 999 },
    ])
    expect(updated).toBe(1)

    sale = db.listSales().find(s => s.id === inserted.id)!
    // updateCollectedActuals は shipping_source === 'actual' かどうかしか見ておらず、
    // 「人が手で触ったか」は判定していない。そのため manual で確定した送料が
    // actual(999) で静かに上書きされてしまう ＝ CLAUDE.md の想定と食い違う可能性がある挙動
    expect(sale.shipping_fee).toBe(999)
    expect(sale.shipping_source).toBe('actual')
    expect(sale.fee).toBe(280)
    // メモは applySaleActuals が触る列に無いので残る
    expect(sale.note).toBe('梱包を厚めにした')
  })

  it('updateCollectedActuals：shipping_source=actualかつsold_atが同じなら再適用しても更新しない（差分適用）', () => {
    db.insertCollected([{
      mercariItemId: 'stable-1', title: '確定済みの商品', price: 1000, soldAt: '2026-07-06', shippingFee: 210,
    }])
    const before = db.listSales().find(s => s.mercari_item_id === 'stable-1')!
    expect(before.shipping_source).toBe('actual')

    const updated = db.updateCollectedActuals([
      { mercariItemId: 'stable-1', soldAt: '2026-07-06', fee: 999, shippingFee: 999 },
    ])
    expect(updated).toBe(0)
    const after = db.listSales().find(s => s.mercari_item_id === 'stable-1')!
    expect(after.shipping_fee).toBe(210) // 変わらない
  })
})
