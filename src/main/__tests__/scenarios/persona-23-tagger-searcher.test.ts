import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ23：タグで整理して探す人', () => {
  let shopId: string
  let purchaseId: string
  let saleTagId: string
  let scratchTagId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('タグテスト仕入先')
    saleTagId = db.createTag('セール')
    scratchTagId = db.createTag('傷あり')

    // 型番はZ078。全角検索テスト（'ｚ０７８ セール'）用にも使う
    purchaseId = db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-07-01',
      shipping_fee: 0,
      lines: [{ name: '商品【Z078】', unit_price: 1000, quantity: 3 }],
    })
  })

  it('仕入→在庫→販売へのタグの派生・重複除去・絞り込み・カスケード削除が正しい', () => {
    // 仕入にタグ「セール」→ その在庫3点のinherited_tagsに「セール」、tagsは空
    db.setPurchaseTags(purchaseId, [saleTagId])
    let items = db.listInventory('in_stock').filter(i => i.model_code === 'Z078')
    expect(items).toHaveLength(3)
    for (const i of items) {
      expect(i.tags).toEqual([])
      expect(i.inherited_tags.map(t => t.name)).toEqual(['セール'])
    }

    // 1点に直接「傷あり」→ tags=[傷あり], inherited=[セール]
    const [item1, item2, item3] = items
    db.setInventoryTags(item1.id, [scratchTagId])
    let item1After = db.listInventory('in_stock').find(i => i.id === item1.id)!
    expect(item1After.tags.map(t => t.name)).toEqual(['傷あり'])
    expect(item1After.inherited_tags.map(t => t.name)).toEqual(['セール'])

    // 同じタグ（セール）を直接にも付けたらinheritedから消える（重複なし）
    db.setInventoryTags(item1.id, [saleTagId, scratchTagId])
    item1After = db.listInventory('in_stock').find(i => i.id === item1.id)!
    expect(item1After.tags.map(t => t.name).sort()).toEqual(['セール', '傷あり'].sort())
    expect(item1After.inherited_tags).toEqual([])

    // 横断検索：この時点でセールは仕入・在庫の両方に見える
    const hitsBeforeSale = db.searchAll('セール')
    expect(hitsBeforeSale.some(h => h.kind === 'purchase' && h.id === purchaseId)).toBe(true)
    expect(hitsBeforeSale.some(h => h.kind === 'inventory' && h.id === item1.id)).toBe(true)
    const item1Hit = hitsBeforeSale.find(h => h.kind === 'inventory' && h.id === item1.id)!
    expect(item1Hit.status_label).toBe('未出品')

    // 全角・AND：'ｚ０７８ セール' でも同じ在庫がヒットする（NFKC正規化）
    const zenkakuHits = db.searchAll('ｚ０７８ セール')
    expect(zenkakuHits.some(h => h.kind === 'inventory' && h.id === item1.id)).toBe(true)

    // 空文字は空
    expect(db.searchAll('')).toEqual([])

    // 売れて紐付いた販売：inherited_tagsにセール・傷あり、tagsは空
    // タイトル自体に「セール」を含めない（検索一致がタグ由来かタイトル由来か紛れないように）
    const saleId = db.createSale({ title: 'まとめ売りの確認（型番なし。手で紐付ける）', sold_at: '2026-07-10', price: 3000 })
    db.linkInventory(saleId, [item1.id])
    let sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.tags).toEqual([])
    expect(sale.inherited_tags.map(t => t.name).sort()).toEqual(['セール', '傷あり'].sort())

    // 検索：販売も出る。status_labelは送料未入力（is_shipping_confirmedが既定0のため）
    const hitsWithSale = db.searchAll('セール')
    const saleHit = hitsWithSale.find(h => h.kind === 'sale' && h.id === saleId)!
    expect(saleHit).toBeTruthy()
    expect(saleHit.status_label).toBe('送料未入力')

    // limit：種類ごとの上限（ceil(limit/4)）を超えない
    const limited = db.searchAll('セール', 4) // perKind = ceil(4/4) = 1
    const byKind = new Map<string, number>()
    for (const h of limited) byKind.set(h.kind, (byKind.get(h.kind) ?? 0) + 1)
    for (const c of byKind.values()) expect(c).toBeLessThanOrEqual(1)

    // 販売に直接「まとめ売り」→ tags=[まとめ売り]。inheritedは変わらず
    const bundleTagId = db.createTag('まとめ売り')
    db.setSaleTags(saleId, [bundleTagId])
    sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.tags.map(t => t.name)).toEqual(['まとめ売り'])
    expect(sale.inherited_tags.map(t => t.name).sort()).toEqual(['セール', '傷あり'].sort())

    // listSales({tagId: セール}) に出る（派生でも絞れる）
    const bySaleTag = db.listSales({ tagId: saleTagId })
    expect(bySaleTag.some(s => s.id === saleId)).toBe(true)

    // unlinkInventory → 販売のinheritedは空
    db.unlinkInventory(saleId, item1.id)
    sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.inherited_tags).toEqual([])
    expect(db.listSales({ tagId: saleTagId }).some(s => s.id === saleId)).toBe(false)

    // 仕入からタグを外す → 在庫（item2, item3）からも消える
    db.setPurchaseTags(purchaseId, [])
    items = db.listInventory('in_stock').filter(i => i.model_code === 'Z078')
    const item2After = items.find(i => i.id === item2.id)!
    const item3After = items.find(i => i.id === item3.id)!
    expect(item2After.inherited_tags).toEqual([])
    expect(item3After.inherited_tags).toEqual([])

    // unlinkInventory で在庫は in_stock に戻る（trg_sline_unsold）。直接タグ（セール・傷あり）は残る
    item1After = db.listInventory('in_stock').find(i => i.id === item1.id)!
    expect(item1After.status).toBe('in_stock')
    expect(item1After.tags.map(t => t.name).sort()).toEqual(['セール', '傷あり'].sort())

    // deleteTag → 全部から消える（item1の直接タグからも）
    db.deleteTag(saleTagId)
    expect(db.listTags().some(t => t.id === saleTagId)).toBe(false)
    item1After = db.listInventory('in_stock').find(i => i.id === item1.id)!
    expect(item1After.tags.map(t => t.name)).toEqual(['傷あり'])
    expect(db.searchAll('セール')).toEqual([])
  })
})
