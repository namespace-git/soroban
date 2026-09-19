import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ05：後から直す人', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('メロジョイ')
  })

  it('型番なしで取り込まれた未紐付けの販売→候補提示→手で紐付け→送料をマスタから選ぶ→解除→付け替え', () => {
    // キーワード設定：型番が無くても「ねこ」を含めば転売として取り込む
    db.setSetting('mercari_keyword', 'ねこ')

    // 候補になる在庫（名前が近い）
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-06-01',
      shipping_fee: 0,
      lines: [{ name: 'ねこのマグカップ(白)', unit_price: 800, quantity: 1 }],
    })
    const item1 = db.listInventory('in_stock')[0]

    // 無関係の在庫（型番付き）
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-06-01',
      shipping_fee: 0,
      lines: [{ name: '【Q001】ぜんぜん違う商品', unit_price: 500, quantity: 1 }],
    })
    const item2 = db.listInventory('in_stock').find(i => i.id !== item1.id)!

    // 型番なしのタイトルで取り込む（キーワード一致で転売扱い、型番がないので未紐付け）
    const collected = db.insertCollected([{
      mercariItemId: 'm-persona05-1',
      title: 'ねこのマグカップ',
      price: 1500,
      soldAt: '2026-06-10',
    }])
    const saleId = collected[0].id

    let sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.kind).toBe('resale')
    expect(sale.unmatched).toBe(1)
    expect(sale.model_codes).toEqual([])
    expect(sale.fee).toBe(150) // floor(1500*1000/10000)
    expect(sale.is_shipping_confirmed).toBe(0) // 送料未入力

    // 候補（名前一致）に item1 が出る
    const suggestions = db.suggestInventory(saleId)
    expect(suggestions[0].id).toBe(item1.id)

    // 手で紐付け
    db.linkInventory(saleId, [item1.id])
    sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.unmatched).toBe(0)
    expect(sale.cost).toBe(800)
    expect(sale.gross_profit).toBe(1500 - 150 - 0 - 0 - 800) // 550

    // 送料をマスタから選ぶ（ネコポス=210）
    const method = db.listShippingMethods().find(m => m.name === 'ネコポス')!
    db.updateSale(saleId, { shipping_method_id: method.id })
    sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.shipping_fee).toBe(210)
    expect(sale.is_shipping_confirmed).toBe(1)
    expect(sale.shipping_source).toBe('master')
    expect(sale.gross_profit).toBe(1500 - 150 - 210 - 0 - 800) // 340

    // 紐付けを解除→在庫はin_stockに戻る
    db.unlinkInventory(saleId, item1.id)
    expect(db.listInventory('in_stock').some(i => i.id === item1.id)).toBe(true)
    sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.unmatched).toBe(1)
    expect(sale.cost).toBe(0)

    // 別の在庫に付け替え
    db.linkInventory(saleId, [item2.id])
    expect(db.listInventory('in_stock').some(i => i.id === item1.id)).toBe(true) // 元の在庫は在庫のまま
    expect(db.listInventory('in_stock').some(i => i.id === item2.id)).toBe(false) // 新しい方が売れた扱い
    sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.unmatched).toBe(0)
    expect(sale.cost).toBe(500)
    expect(sale.gross_profit).toBe(1500 - 150 - 210 - 0 - 500) // 640
  })
})
