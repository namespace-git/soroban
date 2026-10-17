import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Ctx } from '../../context'
import type { Sql } from '../../db/sql'
import { UserError } from '../../errors'
import * as inventory from '../../domain/inventory'
import * as master from '../../domain/master'
import * as sale from '../../domain/sale'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'
import { bindDb, seedItems } from './core-helpers'

// listSaleLinesBulk（売上の画面が販売ごとに listSaleLines を呼ぶ N+1 の置き換え）のテスト。
// 約束は「各キーの値が listSaleLines(id) と toEqual で一致する」ことと、
// 「紐付けの無い販売・知らない id・他の世帯の販売はキーを持たない」「SQL の本数が在庫の数で増えない」こと

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const db = bindDb(() => w.a)
const asA = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)
const asB = <T>(fn: (ctx: Ctx) => Promise<T>) => w.b.run(fn)

/** ctx.sql に流れた問い合わせの本数を数える（get / all / run のどれも 1 本） */
function counting(ctx: Ctx): { ctx: Ctx; count: () => number } {
  let n = 0
  const sql: Sql = {
    get: (text, ...p) => { n++; return ctx.sql.get(text, ...p) },
    all: (text, ...p) => { n++; return ctx.sql.all(text, ...p) },
    run: (text, ...p) => { n++; return ctx.sql.run(text, ...p) },
    tx: (fn) => ctx.sql.tx(fn),
  }
  return { ctx: { ...ctx, sql }, count: () => n }
}

describe('listSaleLinesBulk', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  /** 仕入を 1 件作って（quantity 点）、販売を 1 件作り、全部の在庫を紐付ける。販売 id と在庫 id を返す */
  async function sellBundle(name: string, quantity: number, price = 3000): Promise<{ saleId: string; itemIds: string[] }> {
    const itemIds = await db.createPurchaseItems({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name, unit_price: 1000, quantity }],
    })
    const saleId = await db.createSale({ title: `${name}の販売`, sold_at: '2026-01-05', price })
    await db.linkInventory(saleId, itemIds)
    return { saleId, itemIds }
  }

  it('まとめ売り（3 点）・単品・別の名前を含む複数の販売で、各キーの値が listSaleLines(id) と一致する', async () => {
    const bundle = await sellBundle('まとめ売りの商品【B001】', 3)
    const single = await sellBundle('ばら売りの商品【B002】', 1)
    // 名前の並び（iv.name の C 照合）を確かめるため、名前の違う在庫を 1 つの販売に紐付ける
    const mixedItems = [
      ...await db.createPurchaseItems({
        shop_account_id: shopId, ordered_at: '2026-01-02', shipping_fee: 0,
        lines: [{ name: 'zzz後ろの商品', unit_price: 500, quantity: 1 }, { name: 'aaa前の商品', unit_price: 700, quantity: 2 }],
      }),
    ]
    const mixedSale = await db.createSale({ title: '名前違いのセット', sold_at: '2026-01-06', price: 5000 })
    await db.linkInventory(mixedSale, mixedItems)
    // 紐付けの無い販売
    const unlinked = await db.createSale({ title: '紐付けの無い販売', sold_at: '2026-01-07', price: 1000 })

    const ids = [bundle.saleId, single.saleId, mixedSale, unlinked]
    const bulk = await asA((c) => sale.listSaleLinesBulk(c, ids))

    expect(Object.keys(bulk).sort()).toEqual([bundle.saleId, single.saleId, mixedSale].sort())
    expect(bulk[bundle.saleId]).toHaveLength(3)
    expect(bulk[single.saleId]).toHaveLength(1)
    expect(bulk[mixedSale]).toHaveLength(3)
    // 並びの確認：aaa（2 点）→ zzz（1 点）
    expect(bulk[mixedSale].map(i => i.name)).toEqual(['aaa前の商品', 'aaa前の商品', 'zzz後ろの商品'])
    for (const id of [bundle.saleId, single.saleId, mixedSale]) {
      expect(bulk[id], id).toEqual(await db.listSaleLines(id))
    }
    expect(unlinked in bulk).toBe(false)
    expect(await db.listSaleLines(unlinked)).toEqual([])
  })

  it('タグ（直接・仕入・商品）と商品画像が付いていても、listSaleLines と一致する。sale_id などの余計な列を混ぜない', async () => {
    const tagDirect = await db.createTag('直接タグ')
    const tagPurchase = await db.createTag('仕入タグ')
    const tagProduct = await db.createTag('商品タグ')

    const purchaseId = await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'タグ付きの商品【T001】', unit_price: 1000, quantity: 2 }],
    })
    await db.setPurchaseTags(purchaseId, [tagPurchase])
    await db.setProductTags('T001', [tagProduct])
    await db.upsertProductImage('T001', 'hh/product/T001.jpg')
    const itemIds = (await db.listInventory('in_stock')).map(i => i.id)
    expect(itemIds).toHaveLength(2)
    await db.setInventoryTags(itemIds[0], [tagDirect])

    const s1 = await db.createSale({ title: 'タグ付きのセット', sold_at: '2026-01-05', price: 3000 })
    await db.linkInventory(s1, itemIds)
    const s2 = (await sellBundle('タグ無しの商品【T002】', 1)).saleId

    const bulk = await asA((c) => sale.listSaleLinesBulk(c, [s1, s2]))
    expect(bulk[s1], 's1').toEqual(await db.listSaleLines(s1))
    expect(bulk[s2], 's2').toEqual(await db.listSaleLines(s2))

    // 派生タグ・直接タグ・商品画像が実際に載っている（空の一致で通っていない）
    const tagged = bulk[s1].find(i => i.id === itemIds[0])!
    expect(tagged.tags.map(t => t.name)).toEqual(['直接タグ'])
    expect(tagged.inherited_tags.map(t => t.name).sort()).toEqual(['仕入タグ', '商品タグ'])
    expect(tagged.thumb_url).toMatch(/hh\/product\/T001\.jpg$/)

    for (const item of [...bulk[s1], ...bulk[s2]]) {
      expect(Object.keys(item)).not.toContain('sale_id')
      expect(Object.keys(item)).not.toContain('bulk_sale_id')
    }
  })

  it('空配列は {} を返す。知らない uuid・紐付けの無い販売だけでも {}', async () => {
    expect(await asA((c) => sale.listSaleLinesBulk(c, []))).toEqual({})
    const unlinked = await db.createSale({ title: '紐付けの無い販売', sold_at: '2026-01-07', price: 1000 })
    expect(await asA((c) => sale.listSaleLinesBulk(c, [unlinked, randomUUID()]))).toEqual({})
  })

  it('空配列のときは DB に問い合わせない', async () => {
    const n = await asA(async (c) => {
      const k = counting(c)
      expect(await sale.listSaleLinesBulk(k.ctx, [])).toEqual({})
      return k.count()
    })
    expect(n).toBe(0)
  })

  it('id の重複は 1 つにまとめる（在庫が二重に並ばない）。大文字の uuid も同じ販売として扱う', async () => {
    const { saleId } = await sellBundle('重複の商品【D001】', 2)
    const expected = await db.listSaleLines(saleId)
    const bulk = await asA((c) => sale.listSaleLinesBulk(c, [saleId, saleId, saleId.toUpperCase()]))
    expect(Object.keys(bulk)).toEqual([saleId])
    expect(bulk[saleId]).toEqual(expected)
    expect(bulk[saleId]).toHaveLength(2)
  })

  it('別の世帯の販売 id を渡しても何も返らない（世帯の分離）', async () => {
    const mine = await sellBundle('世帯Aの商品【E001】', 2)
    // 世帯 B にも別の販売・在庫を作る
    const itemsB = await asB(async (c) => {
      const shop = await master.createShopAccount(c, 'メロジョイB')
      return seedItems(c, { shopId: shop, ordered_at: '2026-01-01', lines: [{ name: '世帯Bの商品【E002】', unit_price: 800, quantity: 1 }] })
    })
    const saleB = await asB(async (c) => {
      const id = await sale.createSale(c, { title: '世帯Bの販売', sold_at: '2026-01-05', price: 2000 })
      await inventory.linkInventory(c, id, itemsB, 'manual')
      return id
    })

    // B から A の販売 id を渡しても何も返らない。B 自身のものは返る
    expect(await asB((c) => sale.listSaleLinesBulk(c, [mine.saleId]))).toEqual({})
    const bulkB = await asB((c) => sale.listSaleLinesBulk(c, [mine.saleId, saleB]))
    expect(Object.keys(bulkB)).toEqual([saleB])
    expect(bulkB[saleB].map(i => i.id)).toEqual(itemsB)
    // A から B の販売 id を渡しても同じ
    expect(await asA((c) => sale.listSaleLinesBulk(c, [saleB]))).toEqual({})
    // A の結果に B の在庫は混ざらない
    const bulkA = await asA((c) => sale.listSaleLinesBulk(c, [mine.saleId, saleB]))
    expect(Object.keys(bulkA)).toEqual([mine.saleId])
    expect(bulkA[mine.saleId]).toHaveLength(2)
  })

  describe('引数の検査', () => {
    it('500 件までは通る。501 件は UserError', async () => {
      const ids = (n: number) => Array.from({ length: n }, () => randomUUID())
      expect(await asA((c) => sale.listSaleLinesBulk(c, ids(500)))).toEqual({})
      await expect(asA((c) => sale.listSaleLinesBulk(c, ids(501)))).rejects.toThrow(UserError)
      await expect(asA((c) => sale.listSaleLinesBulk(c, ids(501)))).rejects.toThrow('500個以内')
    })

    it('配列でない・id でない要素は UserError', async () => {
      const call = (v: unknown) => asA((c) => sale.listSaleLinesBulk(c, v as string[]))
      for (const bad of [undefined, null, 'x', 123, {}, true, randomUUID()]) {
        await expect(call(bad), JSON.stringify(bad)).rejects.toThrow(UserError)
      }
      for (const bad of [['x'], [123], [null], [{}], [randomUUID(), 'not-a-uuid'], [''], [['nested']]]) {
        await expect(call(bad), JSON.stringify(bad)).rejects.toThrow(UserError)
      }
    })

    it('API の入口（dispatch）からも：変な引数は 400、正しければ 200', async () => {
      const bad = await w.a.call('listSaleLinesBulk', 'x')
      expect(bad.status).toBe(400)
      const badItem = await w.a.call('listSaleLinesBulk', ['x'])
      expect(badItem.status).toBe(400)
      const { saleId } = await sellBundle('入口の商品【F001】', 2)
      const ok = await w.a.call('listSaleLinesBulk', [saleId])
      expect(ok.status).toBe(200)
      const result = ok.body.result as Record<string, Array<{ id: string }>>
      expect(Object.keys(result)).toEqual([saleId])
      expect(result[saleId].map(i => i.id).sort()).toEqual((await db.listSaleLines(saleId)).map(i => i.id).sort())
    })
  })

  describe('問い合わせの本数', () => {
    it('在庫・販売が増えても本数が増えない（販売ごとの listSaleLines は N 倍になる）', async () => {
      const tag = await db.createTag('数えるタグ')
      const small = [await sellBundle('少数A【G001】', 1), await sellBundle('少数B【G002】', 2)]
      const smallIds = small.map(s => s.saleId)

      const many: string[] = []
      for (let i = 0; i < 8; i++) {
        const b = await sellBundle(`多数${i}【H00${i}】`, 3)
        await db.setInventoryTags(b.itemIds[0], [tag])
        many.push(b.saleId)
      }

      const a = await asA(async (c) => {
        const k = counting(c)
        const r = await sale.listSaleLinesBulk(k.ctx, smallIds)
        return { n: k.count(), r }
      })
      const b = await asA(async (c) => {
        const k = counting(c)
        const r = await sale.listSaleLinesBulk(k.ctx, [...smallIds, ...many])
        return { n: k.count(), r }
      })
      expect(Object.keys(a.r)).toHaveLength(2)
      expect(Object.keys(b.r)).toHaveLength(10)
      // 在庫 3 点→27 点、販売 2→10 件でも同じ本数
      expect(b.n).toBe(a.n)
      // 在庫の取得 1 本＋タグ（直接・仕入・商品の 3 本）＋商品画像の補完（優先順位ごとに最大 4 本）＝ 8 本。
      // 販売ごとに呼んだ場合（下）より十分少ない
      expect(b.n).toBeLessThanOrEqual(10)

      // 比較：販売ごとの listSaleLines は販売の数だけ増える
      const perSale = await asA(async (c) => {
        const k = counting(c)
        for (const id of [...smallIds, ...many]) await sale.listSaleLines(k.ctx, id)
        return k.count()
      })
      expect(perSale).toBeGreaterThan(b.n * 2)
    })
  })
})
