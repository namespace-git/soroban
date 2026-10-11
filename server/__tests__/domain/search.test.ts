import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import * as inventory from '../../domain/inventory'
import * as listing from '../../domain/listing'
import * as sale from '../../domain/sale'
import { normalizeSearchText, subtractDaysJst, todayJst } from '../../domain/_shared'
import type { SearchHit } from '../../../src/shared/types'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'
import { bindDb } from './core-helpers'

// src/main/__tests__/db.test.ts の describe('searchAll：横断検索') のうち、在庫・出品・販売の部分（仕入の部分は仕入のドメイン、
// 4 種類を束ねる searchAll は 2c のホーム）と、在庫の CSV 書き出し・滞留日数のテストを移したもの。
// 期待値は変えていない。searchAll は、ここでは 3 種類の searchXxxHits を searchAll と同じ規則で束ねる小さな関数で代用した：
//   空白区切り AND、NFKC 正規化、種類ごとの上限は ceil(limit/4)、並びは inventory → listing → sale

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const db = bindDb(() => w.a)

/** searchAll と同じ束ね方（仕入は含めない） */
async function searchAll(query: string, limit = 60): Promise<SearchHit[]> {
  const terms = normalizeSearchText(query).trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const perKind = Math.ceil(limit / 4)
  return w.a.run(async (c: Ctx) => [
    ...await inventory.searchInventoryHits(c, terms, perKind),
    ...await listing.searchListingHits(c, terms, perKind),
    ...await sale.searchSaleHits(c, terms, perKind),
  ])
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else {
        cur += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      cells.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  cells.push(cur)
  return cells
}

function parseCsv(csv: string): { headers: string[]; rows: string[][] } {
  const clean = csv.replace(/^﻿/, '')
  if (!clean) return { headers: [], rows: [] }
  const lines = clean.split('\r\n').filter(l => l.length > 0)
  const [headerLine, ...rest] = lines
  return { headers: parseCsvLine(headerLine), rows: rest.map(parseCsvLine) }
}

describe('横断検索（在庫・出品・販売）', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('空文字（空白のみ含む）は[]を返す', async () => {
    expect(await searchAll('')).toEqual([])
    expect(await searchAll('   ')).toEqual([])
  })

  it('型番で在庫・出品・販売にヒットする', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'クリームわん【Z200-1】', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]

    await db.upsertListings([
      { mercariItemId: 'SZ200', title: 'クリームわん【Z200-1】', price: 2500, suspended: false, thumbUrl: null },
    ])

    // 手入力の私物販売（型番が一致していても私物は自動紐付けの対象外）。
    // 送料未入力のままだと status_label は「送料未入力」が優先されるので確定させておく
    const personalSaleId = await db.createSale({
      title: 'クリームわん【Z200-1】', sold_at: '2026-01-10', price: 3000, kind: 'personal',
    })
    await db.updateSale(personalSaleId, { shipping_fee: 0 })

    const hits = await searchAll('Z200-1')
    expect(hits.map(h => h.kind).sort()).toEqual(['inventory', 'listing', 'sale'])

    const inv = hits.find(h => h.kind === 'inventory')!
    expect(inv.id).toBe(item.id)
    expect(inv.model_code).toBe('Z200-1')
    expect(inv.status_label).toBe('未出品')
    expect(inv.amount).toBe(item.landed_cost)
    expect(inv.date).toBe(item.acquired_at)

    const lst = hits.find(h => h.kind === 'listing')!
    expect(lst.id).toBe('SZ200')
    expect(lst.status_label).toBe('出品中')
    expect(lst.amount).toBe(2500)

    const s = hits.find(h => h.kind === 'sale')!
    expect(s.status_label).toBe('私物')
    expect(s.amount).toBe(3000)
  })

  it('タグ名（直接・派生）でヒットする', async () => {
    const tag = await db.createTag('限定品')
    const purchaseId = await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'タグ検索対象', unit_price: 1000, quantity: 1 }],
    })
    await db.setPurchaseTags(purchaseId, [tag])

    // 仕入のタグは在庫・販売にも派生する
    const item = (await db.listInventory('in_stock'))[0]
    const saleId = await db.createSale({ title: 'タグ検索対象の販売', sold_at: '2026-01-05', price: 2000 })
    await db.linkInventory(saleId, [item.id])

    const hits = await searchAll('限定品')
    expect(hits.map(h => h.kind).sort()).toEqual(['inventory', 'sale'])
  })

  it('買い手（buyer）でヒットする', async () => {
    const saleId = await db.createSale({ title: '買い手検索対象', sold_at: '2026-01-01', price: 1000 })
    await db.sqlRun(`update sale set buyer = ? where id = ?`, 'やまだたろう', saleId)

    const hits = await searchAll('やまだたろう')
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('sale')
    expect(hits[0].id).toBe(saleId)
  })

  it('空白区切りAND：全部の語を満たすものだけヒットする', async () => {
    await db.createSale({ title: 'AAA商品', sold_at: '2026-01-01', price: 1000, note: 'BBBメモ' })
    await db.createSale({ title: 'AAA商品2', sold_at: '2026-01-02', price: 1000 })

    expect(await searchAll('AAA BBB')).toHaveLength(1)
    expect(await searchAll('AAA')).toHaveLength(2)
  })

  it('全角英数はNFKC正規化で半角と同一視する', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{
        name: 'ぜんかく検索テスト', unit_price: 1000, quantity: 1,
        model_code: 'Z300', series_code: 'Z300',
      }],
    })

    const hits = await searchAll('Ｚ３００')
    expect(hits.some(h => h.model_code === 'Z300')).toBe(true)
  })

  it('limit：種類ごとの上限はceil(limit/4)', async () => {
    for (let i = 0; i < 10; i++) {
      await db.createSale({
        title: `件数テスト${i}`,
        sold_at: `2026-01-${String(i + 1).padStart(2, '0')}`,
        price: 1000,
      })
    }
    const hits = await searchAll('件数テスト', 8) // perKind = ceil(8/4) = 2
    expect(hits.filter(h => h.kind === 'sale')).toHaveLength(2)
    // 新しい順（販売日の降順）に残る
    expect(hits.filter(h => h.kind === 'sale').map(h => h.date)).toEqual(['2026-01-10', '2026-01-09'])
  })

  it('sale の status_label は 送料未入力 → 未紐付け（転売のみ） → 私物 → 完了 の優先順', async () => {
    const s1 = await db.createSale({ title: '送料未入力テスト', sold_at: '2026-01-01', price: 1000 })
    expect((await searchAll('送料未入力テスト'))[0].status_label).toBe('送料未入力')

    await db.updateSale(s1, { shipping_fee: 200 })
    expect((await searchAll('送料未入力テスト'))[0].status_label).toBe('未紐付け')

    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '紐付け用在庫', unit_price: 500, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.linkInventory(s1, [item.id])
    expect((await searchAll('送料未入力テスト'))[0].status_label).toBe('完了')

    const s2 = await db.createSale({ title: '私物テスト検索', sold_at: '2026-01-02', price: 1000, kind: 'personal' })
    await db.updateSale(s2, { shipping_fee: 100 })
    expect((await searchAll('私物テスト検索'))[0].status_label).toBe('私物')
  })

  it('inventory の status_label：出品中/未出品/廃棄/自家消費/販売済/分割済', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [
        { name: 'ラベル在庫A', unit_price: 1000, quantity: 1 },
        { name: 'ラベル在庫B', unit_price: 1000, quantity: 1 },
        { name: 'ラベル在庫C', unit_price: 1000, quantity: 1 },
        { name: 'ラベル在庫D', unit_price: 1000, quantity: 1 },
        { name: 'ラベル在庫E', unit_price: 1000, quantity: 1 },
        { name: 'ラベル在庫F', unit_price: 1000, quantity: 1 },
      ],
    })
    const all = await db.listInventory('in_stock')
    const byName = (name: string) => all.find(i => i.name === name)!
    const a = byName('ラベル在庫A')
    const c = byName('ラベル在庫C')
    const d = byName('ラベル在庫D')
    const e = byName('ラベル在庫E')
    const f = byName('ラベル在庫F')

    await db.upsertListings([
      { mercariItemId: 'LBL1', title: 'ラベル在庫A', price: 2000, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('LBL1', [a.id])
    await db.disposeInventory(c.id, '壊れた')
    await db.disposeInventory(d.id, '自分用', 'personal_use')
    const saleId = await db.createSale({ title: 'ラベル販売済み', sold_at: '2026-01-05', price: 2000 })
    await db.linkInventory(saleId, [e.id])
    await db.splitInventory(f.id, 2)

    expect((await searchAll('ラベル在庫A'))[0].status_label).toBe('出品中')
    expect((await searchAll('ラベル在庫B'))[0].status_label).toBe('未出品')
    expect((await searchAll('ラベル在庫C'))[0].status_label).toBe('廃棄')
    expect((await searchAll('ラベル在庫D'))[0].status_label).toBe('自家消費')
    expect((await searchAll('ラベル在庫E'))[0].status_label).toBe('販売済')
    // 分割で生まれた子は親と同名（in_stock）で出るため、親自身のidで引く
    expect((await searchAll('ラベル在庫F')).find(h => h.id === f.id)!.status_label).toBe('分割済')
  })

  it('listing の status_label：出品中/出品停止中/売れた/取り下げ', async () => {
    await db.upsertListings([
      { mercariItemId: 'LBLA', title: 'リストA', price: 1000, suspended: false, thumbUrl: null },
      { mercariItemId: 'LBLB', title: 'リストB', price: 1000, suspended: true, thumbUrl: null },
      { mercariItemId: 'LBLC', title: 'リストC', price: 1000, suspended: false, thumbUrl: null },
      { mercariItemId: 'LBLD', title: 'リストD', price: 1000, suspended: false, thumbUrl: null },
    ])
    await db.insertCollected([{ mercariItemId: 'LBLC', title: 'リストC', price: 1000, soldAt: '2026-01-01' }])
    await db.endListing('LBLD')

    expect((await searchAll('リストA'))[0].status_label).toBe('出品中')
    expect((await searchAll('リストB'))[0].status_label).toBe('出品停止中')
    expect((await searchAll('リストC')).find(h => h.kind === 'listing')!.status_label).toBe('売れた')
    expect((await searchAll('リストD'))[0].status_label).toBe('取り下げ')
  })

  it('他の世帯の在庫・出品・販売はヒットしない', async () => {
    await db.createSale({ title: '世帯Aだけの販売', sold_at: '2026-01-01', price: 1000 })
    await db.upsertListings([{ mercariItemId: 'SA-only', title: '世帯Aだけの出品', price: 1, suspended: false, thumbUrl: null }])
    const terms = ['世帯a']
    expect(await w.b.run((c) => sale.searchSaleHits(c, ['世帯aだけ'], 10))).toEqual([])
    expect(await w.b.run((c) => listing.searchListingHits(c, ['世帯aだけ'], 10))).toEqual([])
    expect(await w.b.run((c) => inventory.searchInventoryHits(c, terms, 10))).toEqual([])
  })
})

describe('在庫の滞留日数と CSV 書き出し', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('acquired_atからの経過日数は、実行した時刻（時分秒）を引きずらずちょうどの暦日数になる（日本時間の暦日）', async () => {
    // inventory_view の「今日」は日本時間の暦日。UTC の 15:00〜23:59（日本ではもう翌日）に実行しても 1 日ずれない
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 12, 16, 0, 0))) // JST 2026-10-13 01:00
    try {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: subtractDaysJst(todayJst(), 90), shipping_fee: 0,
        lines: [{ name: 'ちょうど90日', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: subtractDaysJst(todayJst(), 89), shipping_fee: 0,
        lines: [{ name: '89日', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: todayJst(), shipping_fee: 0,
        lines: [{ name: '今日仕入れた', unit_price: 1000, quantity: 1 }],
      })

      expect(todayJst()).toBe('2026-10-13')
      const items = await db.listInventory('in_stock')
      expect(items.find(i => i.name === 'ちょうど90日')!.aging_days).toBe(90)
      expect(items.find(i => i.name === '89日')!.aging_days).toBe(89)
      expect(items.find(i => i.name === '今日仕入れた')!.aging_days).toBe(0)
      // 滞留日数の長い順
      expect(items.map(i => i.name)).toEqual(['ちょうど90日', '89日', '今日仕入れた'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('exportInventoryRows：1行=在庫1点。見出しと列数が一致し、状態の言葉が画面と同じ優先順位で出る', async () => {
    const [a, b, c, d, e] = await db.createPurchaseItems({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [
        { name: '在庫品【R001】', unit_price: 1000, quantity: 5 },
      ],
    })
    await db.upsertListings([{ mercariItemId: 'CSV-1', title: '出品中', price: 2500, suspended: false, thumbUrl: null }])
    await db.reserveInventory('CSV-1', [a])
    await db.disposeInventory(b, '捨てた')
    await db.disposeInventory(c, '使った', 'personal_use')
    const saleId = await db.createSale({ title: '販売', sold_at: '2026-01-05', price: 2000 })
    await db.linkInventory(saleId, [d])
    void e

    const csv = await db.exportInventoryRows()
    const parsed = parseCsv(csv)
    expect(parsed.headers).toEqual([
      '在庫コード', '商品名', '型番', '素材', '状態', '仕入先', '注文番号', '仕入日',
      '滞留日数', '按分後原価', '出品価格', '販売日', '販売価格', '1点あたりの粗利',
    ])
    expect(parsed.rows).toHaveLength(5)
    for (const r of parsed.rows) expect(r).toHaveLength(parsed.headers.length)

    const col = (name: string) => parsed.headers.indexOf(name)
    const byCode = new Map(parsed.rows.map(r => [r[col('在庫コード')], r]))
    const codes = (await db.listInventory('in_stock')).concat(await db.listInventory('sold'))
      .concat(await db.listInventory('disposed')).concat(await db.listInventory('personal_use'))
    const codeOf = (id: string) => codes.find(i => i.id === id)!.item_code
    expect(byCode.get(codeOf(a))![col('状態')]).toBe('出品中')
    expect(byCode.get(codeOf(a))![col('出品価格')]).toBe('2500')
    expect(byCode.get(codeOf(b))![col('状態')]).toBe('廃棄')
    expect(byCode.get(codeOf(c))![col('状態')]).toBe('自家消費')
    expect(byCode.get(codeOf(d))![col('状態')]).toBe('販売済')
    expect(byCode.get(codeOf(d))![col('販売価格')]).toBe('2000')
    expect(byCode.get(codeOf(d))![col('販売日')]).toBe('2026-01-05')
    // 1 点あたりの粗利＝販売の粗利（1 点だけなので 2000 - 200 - 0 - 0 - 1000）
    expect(byCode.get(codeOf(d))![col('1点あたりの粗利')]).toBe('800')
    expect(byCode.get(codeOf(e))![col('状態')]).toBe('届いていて未出品')
    expect(byCode.get(codeOf(e))![col('按分後原価')]).toBe('1000')
  })

  it('exportInventoryRows：未着（発送準備中・配送中）の仕入の在庫は「未着」。0件は空文字', async () => {
    expect(await db.exportInventoryRows()).toBe('')
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0, fulfillment: 'shipped',
      lines: [{ name: '配送中の在庫', unit_price: 1000, quantity: 1 }],
    })
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-02', shipping_fee: 0, fulfillment: 'delivered',
      lines: [{ name: '届いた在庫', unit_price: 1000, quantity: 1 }],
    })
    const parsed = parseCsv(await db.exportInventoryRows())
    const col = parsed.headers.indexOf('状態')
    expect(parsed.rows.map(r => r[col])).toEqual(['未着', '届いていて未出品'])
  })

  it('exportInventoryRows：値にカンマを含む商品名は"で囲まれる。金額は円の整数（カンマ区切りにならない）', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '商品,カンマ入り', unit_price: 12000, quantity: 1 }],
    })
    const csv = await db.exportInventoryRows()
    expect(csv).toContain('"商品,カンマ入り"')
    expect(csv.startsWith('﻿')).toBe(true) // BOM
    const parsed = parseCsv(csv)
    expect(parsed.rows[0][parsed.headers.indexOf('商品名')]).toBe('商品,カンマ入り')
    expect(parsed.rows[0][parsed.headers.indexOf('按分後原価')]).toBe('12000')
  })
})
