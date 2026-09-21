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

  it('updateCollectedActuals：取得できた値（fee/shipping_fee/sold_at/status）が保存値と全部同じなら再適用しない', () => {
    db.insertCollected([{
      mercariItemId: 'stable-1', title: '確定済みの商品', price: 1000, soldAt: '2026-07-06', shippingFee: 210,
    }])
    const before = db.listSales().find(s => s.mercari_item_id === 'stable-1')!
    expect(before.shipping_source).toBe('actual')

    // 1回目：statusがまだ付いていないので completed にする分だけ更新される
    const firstRun = db.updateCollectedActuals([
      { mercariItemId: 'stable-1', soldAt: '2026-07-06', fee: before.fee, shippingFee: 210 },
    ])
    expect(firstRun).toBe(1)
    expect(db.listSales().find(s => s.mercari_item_id === 'stable-1')!.status).toBe('completed')

    // 2回目：fee・shipping_fee・sold_at・status のどれも同じなので再適用しない
    const secondRun = db.updateCollectedActuals([
      { mercariItemId: 'stable-1', soldAt: '2026-07-06', fee: before.fee, shippingFee: 210 },
    ])
    expect(secondRun).toBe(0)
    const after = db.listSales().find(s => s.mercari_item_id === 'stable-1')!
    expect(after.shipping_fee).toBe(210) // 変わらない
  })

  it('updateCollectedActuals：一度 completed になった後でも、送料の実額が変われば取りこぼさず反映する（¥0→¥210）', () => {
    db.insertCollected([
      { mercariItemId: 'zero-then-actual', title: '送料あとから判明', price: 1000, soldAt: '2026-07-06' },
    ])
    // 最初は取引詳細から送料が取れず0円・未確定のまま、販売履歴で完了だけ先に反映される
    db.updateCollectedActuals([
      { mercariItemId: 'zero-then-actual', soldAt: '2026-07-06', fee: 100, shippingFee: 0 },
    ])
    let sale = db.listSales().find(s => s.mercari_item_id === 'zero-then-actual')!
    expect(sale.shipping_fee).toBe(0)
    expect(sale.is_shipping_confirmed).toBe(0)
    expect(sale.status).toBe('completed')

    // 後日の再収集で実額（¥210）が取れた。旧実装は shipping_source==='actual' かつ
    // status==='completed' で無条件にスキップしていたため、この更新が握りつぶされていた
    const updated = db.updateCollectedActuals([
      { mercariItemId: 'zero-then-actual', soldAt: '2026-07-06', fee: 100, shippingFee: 210 },
    ])
    expect(updated).toBe(1)
    sale = db.listSales().find(s => s.mercari_item_id === 'zero-then-actual')!
    expect(sale.shipping_fee).toBe(210)
    expect(sale.is_shipping_confirmed).toBe(1)
  })
})
