import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ09：送料がややこしい人', () => {
  beforeEach(() => {
    db.initDb(':memory:')
  })

  it('着払い(actual/0)／マスタ選択(master)／手入力(manual)でshipping_sourceが変わり、粗利もそれぞれ正しい', () => {
    // 着払い：実額0で取り込まれる（0も確定した実額として扱う）
    const [collected] = db.insertCollected([
      { mercariItemId: 'ship-cod', title: '着払いの商品', price: 1000, soldAt: '2026-03-01', shippingFee: 0 },
    ])
    const codSale = db.listSales().find(s => s.id === collected.id)!
    expect(codSale.is_shipping_confirmed).toBe(1)
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
})
