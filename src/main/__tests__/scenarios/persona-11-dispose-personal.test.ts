import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ11：捨てる人・自分で使う人', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('廃棄テスト仕入先')
  })

  it('廃棄・自家消費：在庫数と在庫金額が減り、月次・ランキングの利益にその原価が混ざらない。履歴に出る。候補には出ない', () => {
    // 型番は枝番まで（【E001-1】）にする。枝番なし（シリーズのみ）は自動確定の対象外
    // （CLAUDE.mdの原則：自動確定は型番の枝番まで完全一致だけ）
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-01',
      shipping_fee: 0,
      lines: [{ name: 'テスト商品【E001-1】', unit_price: 1000, quantity: 5 }],
    })
    const items = db.listInventory('in_stock')
    expect(items).toHaveLength(5)

    const [disposedItem, personalItem] = items
    db.disposeInventory(disposedItem.id, '傷あり', 'disposed')
    db.disposeInventory(personalItem.id, '自分で使う', 'personal_use')

    const inStock = db.listInventory('in_stock')
    expect(inStock).toHaveLength(3)
    expect(inStock.reduce((s, i) => s + i.landed_cost, 0)).toBe(3000)

    expect(db.listInventory('disposed')).toHaveLength(1)
    expect(db.listInventory('personal_use')).toHaveLength(1)

    // 型番完全一致（枝番まで）で自動紐付け（先入先出）。残っている在庫のうち1点だけが原価として乗る
    const saleId = db.createSale({ title: 'テスト商品【E001-1】', sold_at: '2026-05-10', price: 2000 })
    const sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.unmatched).toBe(0)
    expect(sale.cost).toBe(1000) // 廃棄・自家消費分(合計2000)は混ざらない

    const variant = db.listVariantSummary().find(v => v.model_code === 'E001-1')!
    // fee = floor(2000*1000/10000) = 200 → gross_profit = 2000-200-0-0-1000 = 800
    expect(variant.total_profit).toBe(800)

    const monthly = db.listMonthly().find(m => m.month === '2026-05' && m.kind === 'resale')!
    expect(monthly.gross_profit).toBe(800)
    expect(monthly.total_cost).toBe(1000) // 廃棄分(1000)・自家消費分(1000)は混ざらない

    // 履歴ドロワーに「廃棄」「自家消費」が出る
    const disposedTimeline = db.getItemTimeline(disposedItem.id)!
    expect(disposedTimeline.events.some(e => e.kind === 'disposed' && e.title === '廃棄')).toBe(true)
    const personalTimeline = db.getItemTimeline(personalItem.id)!
    expect(personalTimeline.events.some(e => e.kind === 'personal_use' && e.title === '自家消費')).toBe(true)

    // 型番の無いタイトルで別の販売を作る（自動紐付けさせずにsuggest/linkの挙動だけ見る）
    const manualSaleId = db.createSale({ title: '手動紐付け確認用', sold_at: '2026-05-11', price: 1000 })
    expect(db.listSales().find(s => s.id === manualSaleId)!.unmatched).toBe(1)

    // 廃棄した在庫はsuggestInventoryの候補に出ない
    const suggestions = db.suggestInventory(manualSaleId)
    expect(suggestions.some(i => i.id === disposedItem.id)).toBe(false)
    expect(suggestions.some(i => i.id === personalItem.id)).toBe(false)

    // 廃棄した在庫はlinkInventoryできない、はず
    expect(() => db.linkInventory(manualSaleId, [disposedItem.id])).toThrow()
  })
})
