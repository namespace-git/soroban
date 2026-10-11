import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import { mapDbError } from '../../errors'
import * as master from '../../domain/master'
import type { CollectorSource, RunStatus, ShopAccountKind } from '../../../src/shared/types'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'

// src/main/__tests__/db.test.ts の db（:memory:）の中の、タグ・仕入先・発送方法・設定・収集の実行記録のテストを移したもの。
// 期待値は変えていない。書き換えたのは「呼び方」だけ：
//   * 同期の db.xxx(...) → await db.xxx(...)（db は下の薄い包み。1 回の呼び出し＝1 リクエスト＝1 トランザクション）
//   * expect(() => …).toThrow(x) → await expect(…).rejects.toThrow(x)
//   * 仕入・販売の作成（createPurchase / createSale / setSaleTags）は、このウェーブにまだ無いドメインの代わりに SQL で直接行う

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const A = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)

/** 元のテストの `db.` と同じ形で呼べる、世帯 A の薄い包み */
const db = {
  listTags: () => A((c) => master.listTags(c)),
  createTag: (name: string) => A((c) => master.createTag(c, name)),
  renameTag: (id: string, name: string) => A((c) => master.renameTag(c, id, name)),
  deleteTag: (id: string) => A((c) => master.deleteTag(c, id)),
  listShopAccounts: () => A((c) => master.listShopAccounts(c)),
  listShopAccountStats: () => A((c) => master.listShopAccountStats(c)),
  createShopAccount: (name: string, kind?: ShopAccountKind) => A((c) => master.createShopAccount(c, name, kind)),
  getShopAccount: (id: string) => A((c) => master.getShopAccount(c, id)),
  updateShopAccount: (id: string, patch: Parameters<typeof master.updateShopAccount>[2]) => A((c) => master.updateShopAccount(c, id, patch)),
  deleteShopAccount: (id: string) => A((c) => master.deleteShopAccount(c, id)),
  listShippingMethods: () => A((c) => master.listShippingMethods(c)),
  saveShippingMethod: (m: Parameters<typeof master.saveShippingMethod>[1]) => A((c) => master.saveShippingMethod(c, m)),
  deleteShippingMethod: (id: string) => A((c) => master.deleteShippingMethod(c, id)),
  getSettings: () => A((c) => master.getSettings(c)),
  setSetting: (k: string, v: string) => A((c) => master.setSetting(c, k, v)),
  startRun: (source: CollectorSource, shopAccountId: string | null = null) => A((c) => master.startRun(c, source, shopAccountId)),
  finishRun: (id: string, status: RunStatus, fetched: number, inserted: number, message?: string) =>
    A((c) => master.finishRun(c, id, status, fetched, inserted, message)),
  listRuns: (limit?: number) => A((c) => master.listRuns(c, limit)),
  // ---- 仕入・販売（それぞれのドメインが入るまでの代わり。SQL で直接）----
  createSale: (i: { title: string; sold_at: string; price: number }) =>
    A(async (c) => (await c.sql.get<{ id: string }>(
      'insert into sale (title, sold_at, price) values (?, ?, ?) returning id', i.title, i.sold_at, i.price,
    ))!.id),
  setSaleTags: (saleId: string, tagIds: string[]) =>
    A(async (c) => {
      await c.sql.run('delete from sale_tag where sale_id = ?', saleId)
      for (const tagId of tagIds) await c.sql.run('insert into sale_tag (sale_id, tag_id) values (?, ?)', saleId, tagId)
    }),
  saleTagNames: (saleId: string) =>
    A(async (c) => (await c.sql.all<{ name: string }>(
      'select t.name from sale_tag x join tag t on t.household_id = x.household_id and t.id = x.tag_id where x.sale_id = ? order by t.name',
      saleId,
    )).map(r => r.name)),
  /** 仕入を 1 件（明細つき）作る。allocated_cost は送料などを配賦した後の値をそのまま入れる */
  insertPurchase: (p: {
    shopId: string; ordered_at: string; status?: 'confirmed' | 'draft'
    lines: Array<{ name: string; unit_price: number; quantity: number; allocated_cost?: number }>
  }) =>
    A(async (c) => {
      const row = await c.sql.get<{ id: string }>(
        'insert into purchase (shop_account_id, ordered_at, status) values (?, ?, ?) returning id', p.shopId, p.ordered_at, p.status ?? 'confirmed',
      )
      for (const l of p.lines) {
        await c.sql.run(
          'insert into purchase_line (purchase_id, name, unit_price, quantity, allocated_cost) values (?, ?, ?, ?, ?)',
          row!.id, l.name, l.unit_price, l.quantity, l.allocated_cost ?? 0,
        )
      }
      return row!.id
    }),
}

describe('db（:memory:）の中のマスタ', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('startRun：sourceとshop_account_idを渡すと、finishRun/listRunsにshop_account_nameまで付いて返る', async () => {
    const runId = await db.startRun('mellojoy', shopId)
    const finished = await db.finishRun(runId, 'ok', 3, 3)
    expect(finished.source).toBe('mellojoy')
    expect(finished.shop_account_id).toBe(shopId)
    expect(finished.shop_account_name).toBe('メロジョイA')

    const listed = (await db.listRuns()).find(r => r.id === runId)!
    expect(listed.source).toBe('mellojoy')
    expect(listed.shop_account_id).toBe(shopId)
    expect(listed.shop_account_name).toBe('メロジョイA')

    // shop_account_idを省略するとmercari収集と同じくnull
    const mercariRunId = await db.startRun('mercari')
    const mercariRun = await db.finishRun(mercariRunId, 'ok', 1, 1)
    expect(mercariRun.source).toBe('mercari')
    expect(mercariRun.shop_account_id).toBeNull()
    expect(mercariRun.shop_account_name).toBeNull()
  })

  it('updateShopAccount / deleteShopAccount：改名・種別変更・無効化、仕入の有無で削除の可否が変わる', async () => {
    await db.updateShopAccount(shopId, { name: 'メロジョイA改', kind: 'tiktok', is_active: 0 })
    const updated = (await db.listShopAccounts()).find(a => a.id === shopId)!
    expect(updated.name).toBe('メロジョイA改')
    expect(updated.kind).toBe('tiktok')
    expect(updated.is_active).toBe(0)

    // is_active に関係なく listShopAccounts は全件返す
    expect((await db.listShopAccounts()).some(a => a.id === shopId)).toBe(true)

    await db.insertPurchase({ shopId, ordered_at: '2026-01-01', lines: [{ name: '仕入あり', unit_price: 1000, quantity: 1 }] })
    await expect(db.deleteShopAccount(shopId)).rejects.toThrow('この仕入先は仕入で使われています。無効にしてください')
    expect((await db.listShopAccounts()).some(a => a.id === shopId)).toBe(true)

    // 仕入の無いアカウントは消せる
    const otherId = await db.createShopAccount('仕入なしアカウント')
    await db.deleteShopAccount(otherId)
    expect((await db.listShopAccounts()).some(a => a.id === otherId)).toBe(false)
  })

  it('updateShopAccount / getShopAccount：import_keywords の保存・空文字はnullに丸める', async () => {
    expect((await db.getShopAccount(shopId))!.import_keywords).toBeNull()

    await db.updateShopAccount(shopId, { import_keywords: 'メロジョイ, Mellojoy' })
    expect((await db.getShopAccount(shopId))!.import_keywords).toBe('メロジョイ, Mellojoy')
    expect((await db.listShopAccounts()).find(a => a.id === shopId)!.import_keywords).toBe('メロジョイ, Mellojoy')

    await db.updateShopAccount(shopId, { import_keywords: '   ' })
    expect((await db.getShopAccount(shopId))!.import_keywords).toBeNull()

    await db.updateShopAccount(shopId, { import_keywords: null })
    expect((await db.getShopAccount(shopId))!.import_keywords).toBeNull()
  })

  it('updateShopAccount：default_shipping_fee の保存・null に戻す・負や小数はエラー', async () => {
    expect((await db.getShopAccount(shopId))!.default_shipping_fee).toBeNull()

    await db.updateShopAccount(shopId, { default_shipping_fee: 399 })
    expect((await db.getShopAccount(shopId))!.default_shipping_fee).toBe(399)
    expect((await db.listShopAccounts()).find(a => a.id === shopId)!.default_shipping_fee).toBe(399)

    await db.updateShopAccount(shopId, { default_shipping_fee: null })
    expect((await db.getShopAccount(shopId))!.default_shipping_fee).toBeNull()

    await expect(db.updateShopAccount(shopId, { default_shipping_fee: -1 })).rejects.toThrow('送料は整数で入力してください')
    await expect(db.updateShopAccount(shopId, { default_shipping_fee: 1.5 })).rejects.toThrow('送料は整数で入力してください')
  })

  it('タグ：作成・重複例外・改名・削除で販売から外れる', async () => {
    const tagId = await db.createTag('  セール品  ')
    expect(await db.listTags()).toHaveLength(1)
    expect((await db.listTags())[0].name).toBe('セール品') // 前後の空白は除去

    await expect(db.createTag('セール品')).rejects.toThrow('同じ名前のタグがあります')
    await expect(db.createTag('   ')).rejects.toThrow()

    await db.renameTag(tagId, 'まとめ売り')
    expect((await db.listTags())[0].name).toBe('まとめ売り')

    const otherId = await db.createTag('another')
    await expect(db.renameTag(otherId, 'まとめ売り')).rejects.toThrow('同じ名前のタグがあります')

    const saleId = await db.createSale({ title: 'タグ付き商品', sold_at: '2026-01-01', price: 1000 })
    await db.setSaleTags(saleId, [tagId])
    expect(await db.saleTagNames(saleId)).toEqual(['まとめ売り'])

    await db.deleteTag(tagId)
    expect((await db.listTags()).map(t => t.id)).toEqual([otherId])
    // CASCADEで販売からも外れる
    expect(await db.saleTagNames(saleId)).toEqual([])
  })

  it('saveShippingMethod：料金が小数だとthrow', async () => {
    await expect(db.saveShippingMethod({ name: 'テスト', fee: 100.5 })).rejects.toThrow('料金は整数で入力してください')
  })

  it('setting.yahoo_keywordの既定は空文字（新規DB）', async () => {
    expect((await db.getSettings()).yahoo_keyword).toBe('')
  })

  it('setting.yahoo_keywordは保存して読み戻せる。mercari_keywordとは独立している', async () => {
    await db.setSetting('mercari_keyword', 'メロジョイ')
    await db.setSetting('yahoo_keyword', 'ヤフー限定')

    expect((await db.getSettings()).yahoo_keyword).toBe('ヤフー限定')
    expect((await db.getSettings()).mercari_keyword).toBe('メロジョイ')

    await db.setSetting('yahoo_keyword', '別のキーワード')
    expect((await db.getSettings()).yahoo_keyword).toBe('別のキーワード')
    // yahoo_keywordを変えてもmercari_keywordは影響を受けない
    expect((await db.getSettings()).mercari_keyword).toBe('メロジョイ')
  })

  it('listShopAccountStats：確定済みの仕入だけ集計、下書きは含めない。仕入0件は0で返す', async () => {
    const otherShopId = await db.createShopAccount('仕入なしアカウント')

    // 商品A 1,000円×2 に送料 300 円を配賦（allocated_cost）／商品B 500円×1／下書き（単価 0）
    await db.insertPurchase({ shopId, ordered_at: '2026-09-01', lines: [{ name: '商品A', unit_price: 1000, quantity: 2, allocated_cost: 300 }] })
    await db.insertPurchase({ shopId, ordered_at: '2026-09-10', lines: [{ name: '商品B', unit_price: 500, quantity: 1 }] })
    await db.insertPurchase({ shopId, ordered_at: '2026-09-05', status: 'draft', lines: [{ name: '下書き商品', unit_price: 0, quantity: 1 }] })

    // 元のテストは listPurchases の total_cost の合計と突き合わせている。ここでは同じ値を手計算で置く：
    //   (1000×2 + 300) + (500×1) = 2,800（商品計＋送料＋その他−割引。下書きは含めない）
    const expectedTotal = 2000 + 300 + 500

    const stats = await db.listShopAccountStats()
    const mine = stats.find(s => s.shop_account_id === shopId)!
    expect(mine.orders).toBe(2)
    expect(mine.items).toBe(3)
    expect(mine.total_cost).toBe(expectedTotal)
    expect(mine.last_ordered_at).toBe('2026-09-10')

    const other = stats.find(s => s.shop_account_id === otherShopId)!
    expect(other.orders).toBe(0)
    expect(other.items).toBe(0)
    expect(other.total_cost).toBe(0)
    expect(other.last_ordered_at).toBeNull()
  })

  it('仕入先の自動タグ：updateShopAccount の auto_tag_ids は丸ごと置き換え。他のpatchフィールドと同時に渡しても独立して効く', async () => {
    const tagA = await db.createTag('A')
    const tagB = await db.createTag('B')
    await db.updateShopAccount(shopId, { auto_tag_ids: [tagA, tagB], name: '改名後' })
    let acc = (await db.getShopAccount(shopId))!
    expect(acc.name).toBe('改名後')
    expect(acc.auto_tags.map(t => t.id).sort()).toEqual([tagA, tagB].sort())

    await db.updateShopAccount(shopId, { auto_tag_ids: [tagB] })
    acc = (await db.getShopAccount(shopId))!
    expect(acc.auto_tags.map(t => t.id)).toEqual([tagB])

    await db.updateShopAccount(shopId, { auto_tag_ids: [] })
    acc = (await db.getShopAccount(shopId))!
    expect(acc.auto_tags).toEqual([])
  })

  it('仕入先の自動タグ：口座に自動タグA→listShopAccounts / getShopAccount に auto_tags。仕入の作成時にだけ purchase_tag に付き、後から外しても再付与しない', async () => {
    const tagId = await db.createTag('自動タグA')
    await db.updateShopAccount(shopId, { auto_tag_ids: [tagId] })
    expect((await db.listShopAccounts()).find(a => a.id === shopId)!.auto_tags.map(t => t.id)).toEqual([tagId])
    expect((await db.getShopAccount(shopId))!.auto_tags.map(t => t.id)).toEqual([tagId])

    // 仕入の作成が呼ぶ applyShopAccountAutoTags（作成時だけ）
    const purchaseId = await db.insertPurchase({ shopId, ordered_at: '2026-01-01', lines: [{ name: '自動タグ対象', unit_price: 1000, quantity: 1 }] })
    const tagsOf = (id: string) => A((c) => c.sql.all<{ tag_id: string }>('select tag_id from purchase_tag where purchase_id = ?', id))
    expect(await tagsOf(purchaseId)).toEqual([])
    await A((c) => master.applyShopAccountAutoTags(c, purchaseId, shopId))
    expect((await tagsOf(purchaseId)).map(r => r.tag_id)).toEqual([tagId])
    // 2 回呼んでも重複しない
    await A((c) => master.applyShopAccountAutoTags(c, purchaseId, shopId))
    expect(await tagsOf(purchaseId)).toHaveLength(1)

    // 口座の自動タグを外しても、すでに付いた仕入のタグは動かない（過去の仕入は変わらない）
    await db.updateShopAccount(shopId, { auto_tag_ids: [] })
    expect(await tagsOf(purchaseId)).toHaveLength(1)
  })
})

// ============================================================
// Postgres に移したことで足したテスト
// ============================================================
describe('マスタ：Postgres で足すもの', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  describe('タグ', () => {
    it('sort_order は作った順に増える。並びは sort_order → 名前（文字コード順＝SQLite と同じ）', async () => {
      const a = await db.createTag('a')
      const capital = await db.createTag('B')
      expect((await db.listTags()).map(t => [t.name, t.sort_order])).toEqual([['a', 0], ['B', 1]])
      // sort_order が同じなら名前順。SQLite はバイト順なので大文字が小文字の前。ロケールの順（a < B）にしない
      await A((c) => c.sql.run('update tag set sort_order = 5'))
      const kana = await db.createTag('あいう')
      await A((c) => c.sql.run('update tag set sort_order = 5'))
      expect((await db.listTags()).map(t => t.name)).toEqual(['B', 'a', 'あいう'])
      expect([a, capital, kana]).toHaveLength(3)
    })

    it('存在しないタグの改名は 404 相当。削除は黙って何もしない', async () => {
      await expect(db.renameTag('00000000-0000-4000-8000-000000000001', 'x')).rejects.toMatchObject({ code: 'not_found' })
      await expect(db.deleteTag('00000000-0000-4000-8000-000000000001')).resolves.toBeUndefined()
    })

    it('重複は conflict。同名のタグを同時に作った 2 本目の一意制約違反（23505）も同じ文言になる', async () => {
      await db.createTag('重複')
      await expect(db.createTag('重複')).rejects.toMatchObject({ code: 'conflict', message: '同じ名前のタグがあります' })
      const err = await A((c) => c.sql.run(`insert into tag (name) values ('重複')`)).then(() => undefined, (e: unknown) => e)
      expect(mapDbError(err)).toMatchObject({ code: 'conflict', message: '同じ名前のタグがあります' })
    })

    it('名前は 100 文字まで。型が違えば UserError', async () => {
      await db.createTag('あ'.repeat(100))
      await expect(db.createTag('あ'.repeat(101))).rejects.toThrow('100文字以内')
      await expect(db.createTag(123 as unknown as string)).rejects.toMatchObject({ code: 'bad_request' })
      await expect(db.createTag(null as unknown as string)).rejects.toMatchObject({ code: 'bad_request' })
      await expect(db.renameTag('not-a-uuid', 'x')).rejects.toMatchObject({ code: 'bad_request' })
    })
  })

  describe('仕入先アカウント', () => {
    it('契約の列だけを返す（household_id・created_at を漏らさない）。名前順（バイト順）', async () => {
      const b = await db.createShopAccount('b')
      const capital = await db.createShopAccount('B')
      const kana = await db.createShopAccount('あ', 'tiktok')
      const list = await db.listShopAccounts()
      expect(list.map(s => s.id)).toEqual([capital, b, kana])
      expect(Object.keys(list[0]).sort()).toEqual(
        ['auto_tags', 'default_shipping_fee', 'id', 'import_keywords', 'is_active', 'kind', 'name', 'note'],
      )
      expect(list[2]).toMatchObject({ kind: 'tiktok', is_active: 1, note: null, import_keywords: null, default_shipping_fee: null, auto_tags: [] })
    })

    it('存在しない口座の更新・削除は not_found。他のタグ・変な種類は断る', async () => {
      const ghost = '00000000-0000-4000-8000-000000000002'
      await expect(db.updateShopAccount(ghost, { name: 'x' })).rejects.toMatchObject({ code: 'not_found' })
      await expect(db.deleteShopAccount(ghost)).rejects.toMatchObject({ code: 'not_found' })
      const shop = await db.createShopAccount('口座')
      await expect(db.updateShopAccount(shop, { auto_tag_ids: [ghost] })).rejects.toMatchObject({ code: 'not_found', message: 'タグが見つかりません' })
      await expect(db.updateShopAccount(shop, { kind: 'bogus' as ShopAccountKind })).rejects.toMatchObject({ code: 'bad_request' })
      await expect(db.updateShopAccount(shop, { name: '   ' })).rejects.toThrow('名前を入力してください')
      await expect(db.createShopAccount('   ')).rejects.toThrow('名前を入力してください')
    })

    it('削除しても収集の実行記録は残る（口座への参照だけ外れる）', async () => {
      const shop = await db.createShopAccount('消す口座', 'mellojoy')
      const runId = await db.startRun('mellojoy', shop)
      await db.finishRun(runId, 'ok', 1, 1)
      await db.deleteShopAccount(shop)
      const run = (await db.listRuns()).find(r => r.id === runId)!
      expect(run.shop_account_id).toBeNull()
      expect(run.shop_account_name).toBeNull()
    })

    it('listShopAccountStats は円の整数のまま（bigint・numeric の文字列を返さない）', async () => {
      const shop = await db.createShopAccount('集計')
      await db.insertPurchase({ shopId: shop, ordered_at: '2026-02-01', lines: [{ name: '高額', unit_price: 2_000_000_000, quantity: 3, allocated_cost: 1 }] })
      const row = (await db.listShopAccountStats()).find(s => s.shop_account_id === shop)!
      expect(row).toEqual({ shop_account_id: shop, orders: 1, items: 3, total_cost: 6_000_000_001, last_ordered_at: '2026-02-01' })
    })
  })

  describe('発送方法', () => {
    it('新しい世帯には初期の 8 本が sort_order 順に入っている。契約の列だけを返す', async () => {
      const list = await db.listShippingMethods()
      expect(list.map(m => m.name)).toEqual([
        'ゆうパケットポストmini', 'ネコポス', 'ゆうパケットポスト', 'ゆうパケット',
        '宅急便コンパクト', 'ゆうパケットプラス', '宅急便 60サイズ', '送料なし・着払い',
      ])
      expect(Object.keys(list[0]).sort()).toEqual(['carrier', 'fee', 'id', 'is_active', 'name', 'sort_order'])
      expect(list[1]).toMatchObject({ name: 'ネコポス', carrier: 'らくらくメルカリ便', fee: 210, sort_order: 2, is_active: 1 })
      expect(list[7]).toMatchObject({ carrier: null, fee: 0, sort_order: 99 })
    })

    it('追加・更新・削除（削除は無効にして一覧から外すだけ）。存在しない id の更新は not_found', async () => {
      await db.saveShippingMethod({ name: 'テスト発送方法', carrier: '運送会社', fee: 300, sort_order: 10 })
      const created = (await db.listShippingMethods()).find(m => m.name === 'テスト発送方法')!
      expect(created).toMatchObject({ carrier: '運送会社', fee: 300, sort_order: 10, is_active: 1 })

      await db.saveShippingMethod({ id: created.id, name: 'テスト発送方法（改）', fee: 350 })
      expect((await db.listShippingMethods()).find(m => m.id === created.id)).toMatchObject({
        name: 'テスト発送方法（改）', carrier: null, fee: 350, sort_order: 0,
      })

      await db.deleteShippingMethod(created.id)
      expect((await db.listShippingMethods()).some(m => m.id === created.id)).toBe(false)
      // 消したのではなく無効にしただけ（過去の販売が料金を引き続けられる）
      expect(await A((c) => c.sql.get('select is_active from shipping_method where id = ?', created.id))).toEqual({ is_active: 0 })

      await expect(db.saveShippingMethod({ id: '00000000-0000-4000-8000-000000000003', name: 'x', fee: 1 })).rejects.toMatchObject({ code: 'not_found' })
    })

    it('料金は 0 以上の整数。名前が空・型が違えば UserError', async () => {
      await expect(db.saveShippingMethod({ name: 'x', fee: -1 })).rejects.toThrow('料金は整数で入力してください')
      await expect(db.saveShippingMethod({ name: 'x', fee: '100' as unknown as number })).rejects.toThrow('料金は整数で入力してください')
      await expect(db.saveShippingMethod({ name: '  ', fee: 100 })).rejects.toThrow('名前を入力してください')
      await expect(db.saveShippingMethod({ name: 5 as unknown as string, fee: 100 })).rejects.toMatchObject({ code: 'bad_request' })
      await expect(db.saveShippingMethod({ id: 'x', name: 'x', fee: 1 })).rejects.toMatchObject({ code: 'bad_request' })
      await expect(db.saveShippingMethod(null as never)).rejects.toMatchObject({ code: 'bad_request' })
    })
  })

  describe('設定', () => {
    it('新しい世帯には初期の 9 件が入っている', async () => {
      expect(await db.getSettings()).toEqual({
        fee_rate_bp: '1000', fee_rate_bp_yahoo: '500', transfer_fee: '200', aging_warn_days: '90', collect_interval_h: '1',
        mercari_keyword: '', yahoo_keyword: '', auto_release_suspended: '1', item_code_seq: '0',
      })
    })

    it('getSettings は *_enc のキー（暗号化した API キー）を返さない。setSetting も *_enc は書かせない', async () => {
      await A(async (c) => {
        await c.sql.run(`insert into setting (key, value) values ('gemini_api_key_enc', 'SECRET-A'), ('track17_api_key_enc', 'SECRET-B'), ('other_ENC', 'x')`)
      })
      const settings = await db.getSettings()
      expect(Object.keys(settings).filter(k => /_enc$/i.test(k))).toEqual([])
      expect(JSON.stringify(settings)).not.toContain('SECRET')
      expect(settings.fee_rate_bp).toBe('1000')

      await expect(db.setSetting('gemini_api_key_enc', 'zzz')).rejects.toMatchObject({ code: 'bad_request' })
      expect(await A((c) => c.sql.get('select value from setting where key = ?', 'gemini_api_key_enc'))).toEqual({ value: 'SECRET-A' })
    })

    it('setSetting は上書き（同じキーを書き直せる）。値の型・長さを検査する', async () => {
      await db.setSetting('fee_rate_bp', '1234')
      await db.setSetting('fee_rate_bp', '1500')
      await db.setSetting('new_key', '')
      const settings = await db.getSettings()
      expect(settings.fee_rate_bp).toBe('1500')
      expect(settings.new_key).toBe('')
      expect(await A((c) => c.sql.get('select count(*) as n from setting where key = ?', 'fee_rate_bp'))).toEqual({ n: 1 })

      await expect(db.setSetting('', 'x')).rejects.toMatchObject({ code: 'bad_request' })
      await expect(db.setSetting('k', 5 as unknown as string)).rejects.toMatchObject({ code: 'bad_request' })
      await expect(db.setSetting('k', null as unknown as string)).rejects.toMatchObject({ code: 'bad_request' })
      await expect(db.setSetting('k', 'あ'.repeat(20001))).rejects.toThrow('20000文字以内')
      await expect(db.setSetting('k', 'a\u0000b')).rejects.toThrow('使えない文字')
    })
  })

  describe('収集の実行記録', () => {
    it('listRuns は新しい順で、件数を絞れる。finishRun で終わりの時刻・結果が入る', async () => {
      const ids: string[] = []
      for (const source of ['mercari', 'yahoo', 'mercari'] as const) ids.push(await db.startRun(source))
      expect((await db.listRuns()).map(r => r.id)).toEqual([...ids].reverse())
      expect((await db.listRuns(2)).map(r => r.id)).toEqual([ids[2], ids[1]])

      const open = (await db.listRuns()).find(r => r.id === ids[0])!
      expect(open).toMatchObject({ status: 'ok', fetched: 0, inserted: 0, finished_at: null, message: null })
      expect(open.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/)

      const done = await db.finishRun(ids[0], 'failed', 0, 0, 'ERR_FAILED loading /account')
      expect(done).toMatchObject({ status: 'failed', message: 'ERR_FAILED loading /account' })
      expect(done.finished_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(new Date(done.finished_at!).getTime()).toBeGreaterThanOrEqual(new Date(done.started_at).getTime())
    })

    it('長いメッセージは 2,000 文字で切る（断らない）。件数・状態・存在を検査する', async () => {
      const id = await db.startRun('mercari')
      const done = await db.finishRun(id, 'empty', 0, 0, 'x'.repeat(5000))
      expect(done.message).toHaveLength(2000)
      await expect(db.finishRun(id, 'bogus' as RunStatus, 0, 0)).rejects.toMatchObject({ code: 'bad_request' })
      await expect(db.finishRun(id, 'ok', -1, 0)).rejects.toMatchObject({ code: 'bad_request' })
      await expect(db.finishRun('00000000-0000-4000-8000-000000000004', 'ok', 0, 0)).rejects.toMatchObject({ code: 'not_found' })
      await expect(db.startRun('bogus' as CollectorSource)).rejects.toMatchObject({ code: 'bad_request' })
      await expect(db.listRuns(0)).rejects.toMatchObject({ code: 'bad_request' })
      await expect(db.listRuns(1.5)).rejects.toMatchObject({ code: 'bad_request' })
    })
  })

  describe('画面の例外のログ（logClient）', () => {
    const rows = () => A((c) => c.sql.all<{ source: string; kind: string; message: string; payload: string | null; error: string | null }>(
      'select source, kind, message, payload, error from app_log order by id',
    ))

    it('app_log に source=renderer で入る。payload が無ければ null', async () => {
      await A((c) => master.logClient(c, 'error', '画面で例外が起きました', { where: 'Sales.vue', code: 42 }))
      await A((c) => master.logClient(c, 'info', '操作'))
      expect(await rows()).toEqual([
        { source: 'renderer', kind: 'error', message: '画面で例外が起きました', payload: '{"where":"Sales.vue","code":42}', error: null },
        { source: 'renderer', kind: 'info', message: '操作', payload: null, error: null },
      ])
    })

    it('password / token / cookie / secret / api key / authorization を含むキーの値は伏せる（入れ子・配列の中も）', async () => {
      await A((c) => master.logClient(c, 'error', 'x', {
        password: 'pw', accessToken: 't', Cookie: 'c', client_secret: 's', geminiApiKey: 'gk', api_key: 'k', Authorization: 'Bearer z',
        nested: { list: [{ token: 'inner' }], ok: 'visible' },
      }))
      const payload = (await rows())[0].payload!
      for (const secret of ['"pw"', '"t"', '"c"', '"s"', '"gk"', '"k"', 'Bearer z', 'inner']) expect(payload).not.toContain(secret)
      expect(payload).toContain('visible')
      expect(JSON.parse(payload).password).toBe('***')
    })

    it('payload は 2,000 文字で切る。大きな配列は件数だけ。深すぎる入れ子も落ちない', async () => {
      await A((c) => master.logClient(c, 'e', 'm', { text: 'あ'.repeat(5000) }))
      await A((c) => master.logClient(c, 'e', 'm', Array.from({ length: 51 }, (_, i) => i)))
      let deep: unknown = 'bottom'
      for (let i = 0; i < 500; i++) deep = { child: deep }
      await A((c) => master.logClient(c, 'e', 'm', deep))
      const [long, big, nested] = await rows()
      expect(long.payload!.length).toBe(2000 + '…(省略)'.length)
      expect(long.payload!.endsWith('…(省略)')).toBe(true)
      expect(big.payload).toBe('"<Array 51件>"')
      expect(nested.payload).toContain('[深すぎます]')
    })

    it('kind は 100 文字、message は 2,000 文字で切る。型が違っても例外にしない（ログで画面の操作を止めない）', async () => {
      await A((c) => master.logClient(c, 'k'.repeat(300), 'm'.repeat(5000)))
      await A((c) => master.logClient(c, 123 as unknown as string, { a: 1 } as unknown as string))
      await A((c) => master.logClient(c, undefined as unknown as string, null as unknown as string, 'a\u0000b'))
      const [long, odd, nul] = await rows()
      expect(long.kind).toHaveLength(100)
      expect(long.message).toHaveLength(2000)
      expect(odd).toMatchObject({ kind: '123', message: '[object Object]' })
      // payload は JSON の文字列にしてから入れるので、NUL は \u0000 の文字として残る（生の NUL は DB に入らない）
      expect(nul).toMatchObject({ kind: '', message: '', payload: '"a\\u0000b"' })
    })

    it('14 日より古い行は書くたびに消す。14 日以内は残す。他の世帯の行は触らない', async () => {
      await A(async (c) => {
        await c.sql.run(`insert into app_log (ts, source, kind, message) values (now() - interval '15 days', 'main', 'old', 'old')`)
        await c.sql.run(`insert into app_log (ts, source, kind, message) values (now() - interval '13 days', 'main', 'recent', 'recent')`)
      })
      await w.b.run((c) => c.sql.run(`insert into app_log (ts, source, kind, message) values (now() - interval '20 days', 'main', 'b-old', 'b-old')`))
      await A((c) => master.logClient(c, 'new', 'new'))
      expect((await rows()).map(r => r.kind)).toEqual(['recent', 'new'])
      expect(await w.b.run((c) => c.sql.all('select kind from app_log'))).toEqual([{ kind: 'b-old' }])
    })

    it('書き込みに失敗しても例外にしない（ログのせいで画面の操作を失敗させない）', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await A(async (c) => {
          const broken = { ...c, sql: { ...c.sql, tx: async () => { throw new Error('boom') } } } as unknown as Ctx
          await expect(master.logClient(broken, 'k', 'm')).resolves.toBeUndefined()
        })
        expect(spy).toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    })
  })
})

// ============================================================
// 世帯の分離：B から A の行は、id を知っていても見えない・書けない
// ============================================================
describe('マスタ：世帯の分離（B から A の行が見えない・書けない）', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  it('B の一覧に A の行が出ない。B には B の初期データだけ', async () => {
    const tag = await db.createTag('Aのタグ')
    const shop = await db.createShopAccount('Aの口座')
    const run = await db.startRun('mercari')
    await db.setSetting('only_a', 'yes')

    const b = w.b
    expect(await b.run((c) => master.listTags(c))).toEqual([])
    expect(await b.run((c) => master.listShopAccounts(c))).toEqual([])
    expect(await b.run((c) => master.listShopAccountStats(c))).toEqual([])
    expect(await b.run((c) => master.listRuns(c))).toEqual([])
    expect(await b.run((c) => master.getShopAccount(c, shop))).toBeUndefined()
    expect((await b.run((c) => master.getSettings(c))).only_a).toBeUndefined()
    expect(await b.run((c) => master.listShippingMethods(c))).toHaveLength(8)
    expect([tag, run]).toHaveLength(2)
  })

  it('B から A のタグ・口座・発送方法・実行記録を、id を知っていても変えられない', async () => {
    const tag = await db.createTag('Aのタグ')
    const shop = await db.createShopAccount('Aの口座')
    const method = (await db.listShippingMethods())[0]
    const run = await db.startRun('mercari')
    const b = w.b

    await expect(b.run((c) => master.renameTag(c, tag, '乗っ取り'))).rejects.toMatchObject({ code: 'not_found' })
    await b.run((c) => master.deleteTag(c, tag)) // 何も消えない
    await expect(b.run((c) => master.updateShopAccount(c, shop, { name: '乗っ取り' }))).rejects.toMatchObject({ code: 'not_found' })
    await expect(b.run((c) => master.deleteShopAccount(c, shop))).rejects.toMatchObject({ code: 'not_found' })
    await expect(b.run((c) => master.saveShippingMethod(c, { id: method.id, name: '乗っ取り', fee: 1 }))).rejects.toMatchObject({ code: 'not_found' })
    await b.run((c) => master.deleteShippingMethod(c, method.id)) // 無効にならない
    await expect(b.run((c) => master.finishRun(c, run, 'failed', 0, 0))).rejects.toMatchObject({ code: 'not_found' })
    // 自分の口座に A のタグを自動タグとして付けることもできない
    const mine = await b.run((c) => master.createShopAccount(c, 'Bの口座'))
    await expect(b.run((c) => master.updateShopAccount(c, mine, { auto_tag_ids: [tag] }))).rejects.toMatchObject({ code: 'not_found', message: 'タグが見つかりません' })
    // 自分の実行記録に A の口座は結べない（外部キーは世帯をまたげない）
    await expect(b.run((c) => master.startRun(c, 'mellojoy', shop))).rejects.toThrow()

    expect((await db.listTags()).map(t => t.name)).toEqual(['Aのタグ'])
    expect((await db.getShopAccount(shop))!.name).toBe('Aの口座')
    expect((await db.listShippingMethods()).some(m => m.id === method.id)).toBe(true)
    expect((await db.listRuns()).find(r => r.id === run)!.status).toBe('ok')
  })

  it('世帯 id を B のものにして A の行を直接 insert しようとしても RLS が止める', async () => {
    const err = await w.b
      .run((c) => c.sql.run(`insert into tag (household_id, name) values (?, '潜り込み')`, w.a.householdId))
      .then(() => undefined, (e: unknown) => e)
    expect((err as { code?: string }).code).toBe('42501')
    expect(await db.listTags()).toEqual([])
  })

  it('同じ名前のタグ・設定を A と B が別々に持てる（一意性は世帯の中だけ）', async () => {
    await db.createTag('共通')
    await w.b.run((c) => master.createTag(c, '共通'))
    await db.setSetting('fee_rate_bp', '1111')
    await w.b.run((c) => master.setSetting(c, 'fee_rate_bp', '2222'))
    expect((await db.getSettings()).fee_rate_bp).toBe('1111')
    expect((await w.b.run((c) => master.getSettings(c))).fee_rate_bp).toBe('2222')
  })
})

// ============================================================
// API の入口（dispatch）経由：登録が効いていて、JSON にでき、変な引数は 400（500 にしない）
// ============================================================
describe('マスタ：API として登録されている（dispatch 経由）', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  it('16 本が登録されていて、JSON の応答が返る', async () => {
    const created = await w.a.call('createTag', 'API で作ったタグ')
    expect(created.status).toBe(200)
    const tagId = created.body.result as string
    expect(tagId).toMatch(/^[0-9a-f-]{36}$/)

    const tags = await w.a.call('listTags')
    expect(tags.body.result).toEqual([{ id: tagId, name: 'API で作ったタグ', sort_order: 0 }])
    expect((await w.a.call('renameTag', tagId, '改名')).body).toEqual({ result: null })
    expect((await w.a.call('deleteTag', tagId)).body).toEqual({ result: null })

    const shopId = (await w.a.call('createShopAccount', 'API の口座', 'mellojoy')).body.result as string
    expect((await w.a.call('createShopAccount', 'API の口座2')).status).toBe(200) // kind 省略
    expect((await w.a.call('createShopAccount', 'API の口座3', null)).status).toBe(200) // 省略は null で届く
    expect((await w.a.call('updateShopAccount', shopId, { import_keywords: 'a, b', default_shipping_fee: 300 })).status).toBe(200)
    const accounts = (await w.a.call('listShopAccounts')).body.result as Array<{ id: string; kind: string; import_keywords: string }>
    expect(accounts).toHaveLength(3)
    expect(accounts.find(a => a.id === shopId)).toMatchObject({ kind: 'mellojoy', import_keywords: 'a, b', default_shipping_fee: 300 })
    expect(((await w.a.call('listShopAccountStats')).body.result as unknown[])).toHaveLength(3)
    expect((await w.a.call('deleteShopAccount', shopId)).status).toBe(200)

    expect((await w.a.call('saveShippingMethod', { name: 'API 便', fee: 123 })).status).toBe(200)
    const methods = (await w.a.call('listShippingMethods')).body.result as Array<{ name: string }>
    expect(methods.some(m => m.name === 'API 便')).toBe(true)

    expect((await w.a.call('setSetting', 'k', 'v')).status).toBe(200)
    expect(((await w.a.call('getSettings')).body.result as Record<string, string>).k).toBe('v')

    expect((await w.a.call('logClient', 'error', 'ログ', { a: 1 })).body).toEqual({ result: null })
    expect((await w.a.call('logClient', 'error', 'payload なし')).status).toBe(200)

    const run = await w.a.run((c) => master.startRun(c, 'mercari'))
    const runs = (await w.a.call('listRuns', 10)).body.result as Array<{ id: string }>
    expect(runs.map(r => r.id)).toEqual([run])
    expect((await w.a.call('listRuns')).status).toBe(200)
    expect((await w.a.call('listRuns', null)).status).toBe(200)
  })

  it('世帯が違えば別の帳簿（B の dispatch に A のデータは出ない）', async () => {
    await w.a.call('createTag', 'Aだけ')
    expect((await w.b.call('listTags')).body.result).toEqual([])
  })

  it.each([
    ['createTag', [123]],
    ['createTag', [{}]],
    ['createTag', []],
    ['createTag', [null]],
    ['renameTag', ['not-a-uuid', 'x']],
    ['renameTag', [null, 'x']],
    ['deleteTag', [42]],
    ['createShopAccount', [['配列']]],
    ['createShopAccount', ['口座', 'unknown-kind']],
    ['createShopAccount', ['口座', 7]],
    ['updateShopAccount', ['not-a-uuid', {}]],
    ['updateShopAccount', ['00000000-0000-4000-8000-000000000009', 'patch']],
    ['updateShopAccount', ['00000000-0000-4000-8000-000000000009', null]],
    ['updateShopAccount', ['00000000-0000-4000-8000-000000000009', { kind: 'bogus' }]],
    ['updateShopAccount', ['00000000-0000-4000-8000-000000000009', { default_shipping_fee: '399' }]],
    ['updateShopAccount', ['00000000-0000-4000-8000-000000000009', { auto_tag_ids: 'x' }]],
    ['updateShopAccount', ['00000000-0000-4000-8000-000000000009', { auto_tag_ids: ['not-a-uuid'] }]],
    ['updateShopAccount', ['00000000-0000-4000-8000-000000000009', { is_active: 'yes' }]],
    ['deleteShopAccount', [{}]],
    ['saveShippingMethod', [{ name: 1, fee: 'x' }]],
    ['saveShippingMethod', [[]]],
    ['saveShippingMethod', ['x']],
    ['saveShippingMethod', [{ name: 'x', fee: 1.5 }]],
    ['saveShippingMethod', [{ name: 'x', fee: 10, sort_order: 'a' }]],
    ['saveShippingMethod', [{ name: 'x', fee: 10, id: 'bad' }]],
    ['deleteShippingMethod', ['bad']],
    ['setSetting', [1, 2]],
    ['setSetting', ['k']],
    ['setSetting', [{}, 'v']],
    ['listRuns', ['a']],
    ['listRuns', [-1]],
    ['listRuns', [{}]],
  ])('変な引数は 400 の UserError（500 にならない）：%s %j', async (method, args) => {
    const r = await w.a.call(method, ...args)
    expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400)
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(500)
    expect(r.body.error?.message).toBeTruthy()
    expect(r.body.error?.message).not.toContain('サーバーでエラー')
  })

  it('logClient は変な引数でも 200（ログのせいで画面の操作を失敗させない）', async () => {
    for (const args of [[1, 2, 3], [null, null], [{}, [], 'x'], []]) {
      const r = await w.a.call('logClient', ...args)
      expect(r.status, JSON.stringify(args)).toBe(200)
    }
  })
})
