import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ09：送料がややこしい人', () => {
  beforeEach(() => {
    db.initDb(':memory:')
  })

  it('着払い(actual/0)／マスタ選択(master)／手入力(manual)でshipping_sourceが変わり、粗利もそれぞれ正しい', () => {
    // 着払い：実額0で取り込まれるが、メルカリ便を使っていない可能性が高いので送料未入力のまま（要対応）
    const [collected] = db.insertCollected([
      { mercariItemId: 'ship-cod', title: '着払いの商品', price: 1000, soldAt: '2026-03-01', shippingFee: 0 },
    ])
    const codSale = db.listSales().find(s => s.id === collected.id)!
    expect(codSale.is_shipping_confirmed).toBe(0)
    expect(codSale.shipping_fee).toBe(0)
    expect(codSale.shipping_source).toBe('actual')
    // fee = floor(1000*1000/10000) = 100
    expect(codSale.gross_profit).toBe(1000 - 100 - 0 - 0 - 0)

    // マスタの発送方法（ゆうパケット 230）を選ぶ
    const method = db.listShippingMethods().find(m => m.name === 'ゆうパケット')!
    expect(method.fee).toBe(230)

    const saleId = db.createSale({ title: 'マスタ送料テスト', sold_at: '2026-03-02', price: 2000 })
    db.updateSale(saleId, { shipping_method_id: method.id })

    let sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.shipping_fee).toBe(230)
    expect(sale.shipping_source).toBe('master')
    expect(sale.is_shipping_confirmed).toBe(1)
    // fee = floor(2000*1000/10000) = 200
    expect(sale.gross_profit).toBe(2000 - 200 - 230 - 0 - 0)

    // さらに手入力300に変える
    db.updateSale(saleId, { shipping_fee: 300 })
    sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.shipping_fee).toBe(300)
    expect(sale.shipping_source).toBe('manual')
    expect(sale.is_shipping_confirmed).toBe(1)
    expect(sale.gross_profit).toBe(2000 - 200 - 300 - 0 - 0)

    // 発送方法マスタの送料を後から変えても、既に確定した既存の販売の送料は動かない
    const otherSaleId = db.createSale({ title: '別の送料テスト', sold_at: '2026-03-03', price: 1500 })
    db.updateSale(otherSaleId, { shipping_method_id: method.id })
    expect(db.listSales().find(s => s.id === otherSaleId)!.shipping_fee).toBe(230)

    db.saveShippingMethod({
      id: method.id, name: method.name, carrier: method.carrier, fee: 999, sort_order: method.sort_order,
    })
    const afterMasterChange = db.listSales().find(s => s.id === otherSaleId)!
    expect(afterMasterChange.shipping_fee).toBe(230) // 動かない
    expect(db.listShippingMethods().find(m => m.id === method.id)!.fee).toBe(999) // マスタ自体は変わっている
  })

  it('送料0の取り込み→要対応に出る／発送方法を選んだ後は送料0の再取り込みで上書きされない／実額が入れば優先される', () => {
    // 1. 送料0で新規取り込み → 未確定のまま「要対応」に出る
    db.insertCollected([
      { mercariItemId: 'ship-fix', title: '要対応の商品', price: 3000, soldAt: '2026-08-01', shippingFee: 0 },
    ])
    let sale = db.listSales().find(s => s.mercari_item_id === 'ship-fix')!
    expect(sale.is_shipping_confirmed).toBe(0)
    expect(sale.shipping_source).toBe('actual')
    expect(db.listSales({ onlyPending: true }).some(s => s.id === sale.id)).toBe(true)

    // 2. 人が発送方法を選ぶ → master・確定
    const method = db.listShippingMethods().find(m => m.name === 'ゆうパケット')!
    db.updateSale(sale.id, { shipping_method_id: method.id })
    sale = db.listSales().find(s => s.mercari_item_id === 'ship-fix')!
    expect(sale.shipping_source).toBe('master')
    expect(sale.shipping_fee).toBe(method.fee)
    expect(sale.is_shipping_confirmed).toBe(1)
    expect(db.listSales({ onlyPending: true }).some(s => s.id === sale.id)).toBe(false)

    // 3. もう一度同じ販売履歴（送料0）を再適用 → 発送方法・送料は残る。手数料・completedは反映される
    const updated = db.updateCollectedActuals([
      { mercariItemId: 'ship-fix', soldAt: '2026-08-01', fee: 320, shippingFee: 0 },
    ])
    expect(updated).toBe(1)
    sale = db.listSales().find(s => s.mercari_item_id === 'ship-fix')!
    expect(sale.shipping_source).toBe('master')
    expect(sale.shipping_method_id).toBe(method.id)
    expect(sale.shipping_fee).toBe(method.fee)
    expect(sale.is_shipping_confirmed).toBe(1)
    expect(sale.fee).toBe(320)
    expect(sale.status).toBe('completed')
    expect(sale.completed_at).toBe('2026-08-01')

    // 4. 販売履歴の送料がメルカリ便実額500に変わった → actualで上書きされる（人の選択より優先）
    db.updateCollectedActuals([
      { mercariItemId: 'ship-fix', soldAt: '2026-08-01', fee: 320, shippingFee: 500 },
    ])
    sale = db.listSales().find(s => s.mercari_item_id === 'ship-fix')!
    expect(sale.shipping_source).toBe('actual')
    expect(sale.shipping_fee).toBe(500)
    expect(sale.is_shipping_confirmed).toBe(1)
  })
})
