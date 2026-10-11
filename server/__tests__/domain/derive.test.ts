import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as derive from '../../domain/derive'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'
import { bindDb } from './core-helpers'

// derive.ts（タグと画像の派生）を直接確かめる。画面の一覧（listInventory / listSales）を通した派生の確認は linking.test.ts にある

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const db = bindDb(() => w.a)

describe('派生（derive）', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('仕入のタグ → 在庫（purchase_line 経由）。同じ仕入の在庫は全部、別の仕入の在庫には付かない。並びは sort_order → 名前（文字コード順）', async () => {
    const p1 = await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '仕入1', unit_price: 100, quantity: 2 }],
    })
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-02', shipping_fee: 0,
      lines: [{ name: '仕入2', unit_price: 100, quantity: 1 }],
    })
    // sort_order が同じタグ 3 つ。名前の並びは SQLite のバイト順と同じ（大文字 → 小文字 → かな）
    const ids: Record<string, string> = {}
    for (const name of ['a', 'B', 'あ']) {
      ids[name] = (await db.sqlGet<{ id: string }>(`insert into tag (name, sort_order) values (?, 5) returning id`, name))!.id
    }
    await db.setPurchaseTags(p1, [ids['あ'], ids['a'], ids['B']])

    const items = await db.listInventory('in_stock')
    const inP1 = items.filter(i => i.name === '仕入1')
    const inP2 = items.find(i => i.name === '仕入2')!
    const map = await w.a.run((c) => derive.loadPurchaseTagsForInventory(c, items.map(i => i.id)))
    for (const i of inP1) expect(map.get(i.id)!.map(t => t.name)).toEqual(['B', 'a', 'あ'])
    expect(map.get(inP2.id)).toBeUndefined()
    expect(inP1[0].inherited_tags.map(t => t.name)).toEqual(['B', 'a', 'あ'])
    expect(inP1[0].inherited_tags.every(t => t.from === 'purchase')).toBe(true)
  })

  it('商品（型番）のタグ → 在庫・販売。同じ型番の在庫が 2 点でも、1 つの販売には 1 回だけ', async () => {
    const tag = await db.createTag('型番タグ')
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '同じ型番【A200】', unit_price: 100, quantity: 2 }, { name: '型番なし', unit_price: 100, quantity: 1 }],
    })
    await db.setProductTags('A200', [tag])
    const items = await db.listInventory('in_stock')
    const sameCode = items.filter(i => i.model_code === 'A200')
    const noCode = items.find(i => i.model_code === null)!

    const byItem = await w.a.run((c) => derive.loadProductTagsForInventory(c, items))
    for (const i of sameCode) expect(byItem.get(i.id)!.map(t => t.id)).toEqual([tag])
    expect(byItem.has(noCode.id)).toBe(false) // 型番の無い在庫は対象外

    const saleId = await db.createSale({ title: 'まとめ【A200】×2', sold_at: '2026-01-05', price: 3000 })
    // ×2 で自動確定されている（2 点）
    expect((await db.listSales()).find(s => s.id === saleId)!.item_count).toBe(2)
    const bySale = await w.a.run((c) => derive.loadProductTagsForSales(c, [saleId]))
    expect(bySale.get(saleId)!.map(t => t.id)).toEqual([tag])
  })

  it('在庫のタグ → 販売（紐付けた在庫の直接タグ）。仕入のタグ → 販売（在庫の仕入経由）', async () => {
    const tagInv = await db.createTag('在庫のタグ')
    const tagPur = await db.createTag('仕入のタグ')
    const purchaseId = await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '在庫X', unit_price: 100, quantity: 2 }],
    })
    await db.setPurchaseTags(purchaseId, [tagPur])
    const [a, b] = await db.listInventory('in_stock')
    await db.setInventoryTags(a.id, [tagInv])
    const saleId = await db.createSale({ title: '販売', sold_at: '2026-01-05', price: 1000 })
    await db.linkInventory(saleId, [a.id, b.id])

    const inv = await w.a.run((c) => derive.loadInventoryTagsForSales(c, [saleId]))
    expect(inv.get(saleId)!.map(t => t.id)).toEqual([tagInv])
    // 仕入のタグは 2 点とも同じ仕入なので、行は 2 つ返る（束ねるのは mergeInheritedTags の役目）
    const pur = await w.a.run((c) => derive.loadPurchaseTagsForSales(c, [saleId]))
    expect(pur.get(saleId)!.map(t => t.id)).toEqual([tagPur, tagPur])
    const sale = (await db.listSales())[0]
    expect(sale.inherited_tags.map(t => t.id).sort()).toEqual([tagInv, tagPur].sort())
  })

  it('空の入力は空の結果（SQL を投げない）', async () => {
    await w.a.run(async (c) => {
      expect((await derive.loadPurchaseTagsForInventory(c, [])).size).toBe(0)
      expect((await derive.loadProductTagsForInventory(c, [])).size).toBe(0)
      expect((await derive.loadInventoryTagsForSales(c, [])).size).toBe(0)
      expect((await derive.loadPurchaseTagsForSales(c, [])).size).toBe(0)
      expect((await derive.loadProductTagsForSales(c, [])).size).toBe(0)
      expect(await derive.attachInventoryTags(c, [])).toEqual([])
      expect((await derive.productImageFiles(c, [])).size).toBe(0)
    })
  })

  it('他の世帯のタグ・画像は派生に出ない（世帯 B から A の id を渡しても空）', async () => {
    const tag = await db.createTag('Aのタグ')
    const purchaseId = await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'A【A300】', unit_price: 100, quantity: 1 }],
    })
    await db.setPurchaseTags(purchaseId, [tag])
    await db.setProductTags('A300', [tag])
    await db.upsertProductImage('A300', 'a.jpg')
    const [item] = await db.listInventory('in_stock')
    await w.b.run(async (c) => {
      expect((await derive.loadPurchaseTagsForInventory(c, [item.id])).size).toBe(0)
      expect((await derive.loadProductTagsForInventory(c, [{ id: item.id, model_code: 'A300' }])).get(item.id)).toEqual([])
      expect((await derive.productImageFiles(c, ['A300'])).size).toBe(0)
    })
  })

  it('productImageFiles：同じ型番を重複して渡しても 1 件。人がセットした画像が最優先（manual）', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '画像【A400】', unit_price: 100, quantity: 1, image_path: 'purchase.jpg' }],
    })
    expect((await db.productImageFiles(['A400', 'A400'])).get('A400')).toEqual({ path: 'purchase.jpg', manual: false })
    await db.upsertProductImage('A400', 'manual.jpg')
    const map = await db.productImageFiles(['A400', 'A400'])
    expect(map.size).toBe(1)
    expect(map.get('A400')).toEqual({ path: 'manual.jpg', manual: true })
  })

  it('productImageFiles：販売の画像は「最新の販売」の画像だけを見る（最新の販売に画像が無ければ、古い販売の画像には遡らない）', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '遡らない【A500】', unit_price: 100, quantity: 2 }],
    })
    const [i1, i2] = await db.listInventory('in_stock')
    const s1 = await db.createSale({ title: '古い販売', sold_at: '2026-01-06', price: 1000 })
    const s2 = await db.createSale({ title: '新しい販売', sold_at: '2026-02-06', price: 1000 })
    await db.linkInventory(s1, [i1.id])
    await db.linkInventory(s2, [i2.id])
    await db.setSaleThumb(s1, 'old.jpg', null)
    expect((await db.productImageFiles(['A500'])).has('A500')).toBe(false)
    await db.setSaleThumb(s2, 'new.jpg', null)
    expect((await db.productImageFiles(['A500'])).get('A500')).toEqual({ path: 'new.jpg', manual: false })
  })
})
