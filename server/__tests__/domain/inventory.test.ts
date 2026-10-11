import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import * as derive from '../../domain/derive'
import * as inventory from '../../domain/inventory'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'
import { bindDb } from './core-helpers'

// src/main/__tests__/db.test.ts の db（:memory:）の中の、在庫まわり（split / merge / dispose / restore /
// タグ / nextItemCode）のテストを移したもの。期待値は変えていない。書き換えたのは「呼び方」だけ：
//   * 同期の db.xxx(...) → await db.xxx(...)（db は core-helpers の薄い包み。1 回の呼び出し＝1 リクエスト＝1 トランザクション）
//   * expect(() => …).toThrow(x) → await expect(…).rejects.toThrow(x)
//   * db.createPurchase は仕入のドメインが無くても在庫が作れる SQL の直接投入（core-helpers の seedPurchase）
//   * 'no-such-id'（uuid でない文字列）は、Postgres の uuid 列に渡せないので、存在しない uuid に変えた
//     （uuid でない文字列は別に「指定が正しくありません」と断ることをテストしている）
//   * 販売・出品が要るもの（販売済みの子の分割戻し・引き当て・紐付けガード）は sale.test.ts / listing.test.ts / linking.test.ts

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const db = bindDb(() => w.a)

describe('在庫（inventory）', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('disposeInventory：personal_useでstatusが変わる', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '在庫X', unit_price: 500, quantity: 2 }],
    })
    const [item1] = await db.listInventory('in_stock')

    await db.disposeInventory(item1.id, 'テスト理由', 'personal_use')
    const personalUse = await db.listInventory('personal_use')
    expect(personalUse).toHaveLength(1)
    expect(personalUse[0].id).toBe(item1.id)
  })

  it('restoreInventory：廃棄・自家消費を手元の在庫に戻す。原価は変わらない／未廃棄は戻せない', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '在庫Y', unit_price: 500, quantity: 3 }],
    })
    const [item1, item2, item3] = await db.listInventory('in_stock')
    const cost1 = item1.landed_cost

    await db.disposeInventory(item1.id, '間違えて廃棄', 'disposed')
    await db.restoreInventory(item1.id)
    const restored = (await db.listInventory('in_stock')).find(i => i.id === item1.id)!
    expect(restored.landed_cost).toBe(cost1) // landed_cost は生成時のまま
    expect(restored.note ?? null).toBeNull()

    // disposed_at・disposed_note が消えている
    const raw = (await db.sqlGet<{ disposed_at: string | null; disposed_note: string | null }>(
      'select disposed_at, disposed_note from inventory_item where id = ?', item1.id))!
    expect(raw.disposed_at).toBeNull()
    expect(raw.disposed_note).toBeNull()

    // 自家消費からも戻せる
    await db.disposeInventory(item2.id, '自分用に使った', 'personal_use')
    await db.restoreInventory(item2.id)
    expect((await db.listInventory('in_stock')).some(i => i.id === item2.id)).toBe(true)

    // 未廃棄（in_stock）は戻せない
    await expect(db.restoreInventory(item3.id)).rejects.toThrow('この在庫は戻せません')

    // 存在しないIDはエラー
    await expect(db.restoreInventory(randomUUID())).rejects.toThrow('在庫が見つかりません')
  })

  it('splitInventory：landed_cost 1000 を3分割 → 333/333/334、親はsplitでin_stockから消える', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'ばら売り元', unit_price: 1000, quantity: 1 }],
    })
    const parent = (await db.listInventory('in_stock'))[0]

    const childIds = await db.splitInventory(parent.id, 3)
    expect(childIds).toHaveLength(3)

    // 親は split になり in_stock からは消える
    const inStock = await db.listInventory('in_stock')
    expect(inStock).toHaveLength(3)
    expect(inStock.some(i => i.id === parent.id)).toBe(false)

    const splitList = await db.listInventory('split')
    expect(splitList).toHaveLength(1)
    expect(splitList[0].id).toBe(parent.id)

    const sorted = [...inStock].sort((a, b) => a.landed_cost - b.landed_cost)
    expect(sorted.map(i => i.landed_cost)).toEqual([333, 333, 334])
    expect(inStock.reduce((s, i) => s + i.landed_cost, 0)).toBe(1000)

    for (const child of inStock) expect(child.parent_id).toBe(parent.id)
  })

  it('splitInventory：均等割りは floor を配って余りを末尾に 1 円ずつ（1,001 円÷3 → 333/334/334）。合計は必ず親と一致する', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '余りの出る分割', unit_price: 1001, quantity: 1 }],
    })
    const parent = (await db.listInventory('in_stock'))[0]
    const childIds = await db.splitInventory(parent.id, 3)

    // 子は作った順（在庫コード順）に 333/334/334
    const byId = new Map((await db.listInventory('in_stock')).map(i => [i.id, i.landed_cost]))
    expect(childIds.map(id => byId.get(id))).toEqual([333, 334, 334])
    expect([...byId.values()].reduce((s, c) => s + c, 0)).toBe(1001)

    // 親の原価は書き換えない（過去の帳簿を動かさない）
    expect((await db.listInventory('split'))[0].landed_cost).toBe(1001)

    // 子の在庫コードは新しく採番される（親と重ならない）
    const codes = (await db.sql<{ item_code: string }>('select item_code from inventory_item')).map(r => r.item_code)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes).toHaveLength(4)
  })

  it('splitInventory：分割数が2未満・小数・多すぎる／in_stockでない／存在しない在庫は断る', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '分割できるか', unit_price: 600, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]

    await expect(db.splitInventory(item.id, 1)).rejects.toThrow('分割数は2以上にしてください')
    await expect(db.splitInventory(item.id, 2.5)).rejects.toThrow('分割数は2以上の整数にしてください')
    await expect(db.splitInventory(item.id, 1000)).rejects.toThrow('分割数は100以下にしてください')
    await expect(db.splitInventory(randomUUID(), 2)).rejects.toThrow('在庫が見つかりません')

    await db.disposeInventory(item.id, '捨てた')
    await expect(db.splitInventory(item.id, 2)).rejects.toThrow('未販売の在庫のみ分割できます')
    // どれも失敗なので、在庫は増えていない
    expect(await db.sql('select id from inventory_item')).toHaveLength(1)
  })

  describe('mergeSplitInventory：分割を戻す', () => {
    it('3分割した直後に戻す→親がin_stock、子は0件、原価とitem_codeは親のまま', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '間違えて分けた', unit_price: 1000, quantity: 1 }],
      })
      const parent = (await db.listInventory('in_stock'))[0]
      const childIds = await db.splitInventory(parent.id, 3)

      await db.mergeSplitInventory(parent.id)

      const inStock = await db.listInventory('in_stock')
      expect(inStock).toHaveLength(1)
      expect(inStock[0].id).toBe(parent.id)
      expect(inStock[0].item_code).toBe(parent.item_code)
      expect(inStock[0].landed_cost).toBe(1000)
      expect(await db.listInventory('split')).toHaveLength(0)

      for (const childId of childIds) {
        expect((await db.listInventory('in_stock')).some(i => i.id === childId)).toBe(false)
      }
    })

    it('子のタグ・メモは親に寄せる', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'タグ付き分割', unit_price: 900, quantity: 1 }],
      })
      const parent = (await db.listInventory('in_stock'))[0]
      const tagId = await db.createTag('レア')
      const childIds = await db.splitInventory(parent.id, 3)
      await db.setInventoryTags(childIds[0], [tagId])
      await db.updateInventory(childIds[1], { note: '傷あり' })

      await db.mergeSplitInventory(parent.id)

      const merged = (await db.listInventory('in_stock'))[0]
      expect(merged.tags.map(t => t.id)).toEqual([tagId])
      expect(merged.note).toBe('傷あり')
    })

    it('孫まで分割されているとError「さらに分割」', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '孫分割', unit_price: 900, quantity: 1 }],
      })
      const parent = (await db.listInventory('in_stock'))[0]
      const childIds = await db.splitInventory(parent.id, 2)
      await db.splitInventory(childIds[0], 2)

      await expect(db.mergeSplitInventory(parent.id)).rejects.toThrow('さらに分割')
    })

    it('分割していない在庫・存在しない在庫は断る', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '分割していない', unit_price: 900, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      await expect(db.mergeSplitInventory(item.id)).rejects.toThrow('分割した在庫ではありません')
      await expect(db.mergeSplitInventory(randomUUID())).rejects.toThrow('在庫が見つかりません')
    })
  })

  it('setInventoryTags：タグの置き換え（丸ごと入れ替え）', async () => {
    const tagA = await db.createTag('A')
    const tagB = await db.createTag('B')

    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'タグ付き在庫', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.setInventoryTags(item.id, [tagA])
    expect((await db.listInventory('in_stock'))[0].tags.map(t => t.id)).toEqual([tagA])
    await db.setInventoryTags(item.id, [tagB])
    expect((await db.listInventory('in_stock'))[0].tags.map(t => t.id)).toEqual([tagB])
    // 同じタグを重複して渡しても 1 つにまとまる。空配列で全部外す
    await db.setInventoryTags(item.id, [tagA, tagA, tagB])
    expect((await db.listInventory('in_stock'))[0].tags.map(t => t.id).sort()).toEqual([tagA, tagB].sort())
    await db.setInventoryTags(item.id, [])
    expect((await db.listInventory('in_stock'))[0].tags).toEqual([])
  })

  describe('disposeInventory：disposed_at は UTC ではなく日本時間の日付で入る', () => {
    it('JST 深夜0時台（UTC ではまだ前日）でも disposed_at は当日の日付になる', async () => {
      // JST 2026-02-02 00:30 = UTC 2026-02-01 15:30。
      // UTC で丸めるとこの時刻に廃棄したとき誤って前日（2026-02-01）が入る。サーバー（Workers）は UTC で動く
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(Date.UTC(2026, 1, 1, 15, 30, 0)))
      try {
        await db.createPurchase({
          shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
          lines: [{ name: '深夜廃棄テスト', unit_price: 1000, quantity: 1 }],
        })
        const item = (await db.listInventory('in_stock'))[0]
        await db.disposeInventory(item.id, '深夜に廃棄', 'disposed')

        const raw = (await db.sqlGet<{ disposed_at: string | null }>(
          'select disposed_at from inventory_item where id = ?', item.id))!
        expect(raw.disposed_at).toBe('2026-02-02')
      } finally {
        vi.useRealTimers()
      }
    })

    it('UTC の 14:59（JST 23:59）はまだ当日', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(Date.UTC(2026, 1, 1, 14, 59, 0)))
      try {
        await db.createPurchase({
          shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
          lines: [{ name: '夜廃棄テスト', unit_price: 1000, quantity: 1 }],
        })
        const item = (await db.listInventory('in_stock'))[0]
        await db.disposeInventory(item.id, '夜に廃棄', 'personal_use')
        const raw = (await db.sqlGet<{ disposed_at: string | null }>(
          'select disposed_at from inventory_item where id = ?', item.id))!
        expect(raw.disposed_at).toBe('2026-02-01')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('nextItemCode：カウンタが既存コードより後ろにずれていても衝突しない', () => {
    it('開始番号は max(カウンタ, 既存コードの最大番号) から採番する', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '商品A', unit_price: 100, quantity: 1 }],
      })
      const first = (await db.listInventory('in_stock'))[0]
      expect(first.item_code).toBe('S-0001')

      // カウンタが既存コードより後ろにずれた状態を再現する（移行の取り込み・手動編集など）
      await db.sqlRun(`update setting set value = '0' where key = 'item_code_seq'`)

      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-02', shipping_fee: 0,
        lines: [{ name: '商品B', unit_price: 100, quantity: 1 }],
      })
      const codes = (await db.listInventory('in_stock')).map(i => i.item_code)
      expect(new Set(codes).size).toBe(codes.length) // 重複しない
      expect(codes).toContain('S-0002')
    })

    it('9999 を超えたら桁が増える。数量分まとめて取っても連番で重ならない', async () => {
      await db.sqlRun(`update setting set value = '9998' where key = 'item_code_seq'`)
      const codes = await w.a.run((c) => inventory.nextItemCodes(c, 3))
      expect(codes).toEqual(['S-9999', 'S-10000', 'S-10001'])
      expect(await db.nextItemCode()).toBe('S-10002')
    })

    it('カウンタの行が無くても採番できる（既存コードの最大番号の続きから）', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '商品A', unit_price: 100, quantity: 2 }],
      })
      await db.sqlRun(`delete from setting where key = 'item_code_seq'`)
      expect(await db.nextItemCode()).toBe('S-0003')
    })

    it('S- で始まらないコードや数字でない値は最大番号の計算に混ざらない', async () => {
      await db.sqlRun(`update setting set value = 'abc' where key = 'item_code_seq'`)
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '商品A', unit_price: 100, quantity: 1 }],
      })
      await db.sqlRun(`update inventory_item set item_code = 'X-77'`)
      expect(await db.nextItemCode()).toBe('S-0002')
    })
  })
})

describe('在庫（inventory）の引数の検査と世帯の分離', () => {
  const asA = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)
  const asB = <T>(fn: (ctx: Ctx) => Promise<T>) => w.b.run(fn)
  let shopId: string
  let itemA: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '世帯Aの在庫【A001】', unit_price: 1000, quantity: 1 }],
    })
    itemA = (await db.listInventory('in_stock'))[0].id
  })

  it('世帯 B からは A の在庫が見えない・触れない（id を知っていても）', async () => {
    expect(await asB((c) => inventory.listInventory(c, 'in_stock'))).toEqual([])
    await expect(asB((c) => inventory.updateInventory(c, itemA, { name: '乗っ取り' }))).rejects.toThrow('在庫が見つかりません')
    await expect(asB((c) => inventory.disposeInventory(c, itemA, '捨てる'))).rejects.toThrow('在庫が見つかりません')
    await expect(asB((c) => inventory.restoreInventory(c, itemA))).rejects.toThrow('在庫が見つかりません')
    await expect(asB((c) => inventory.splitInventory(c, itemA, 2))).rejects.toThrow('在庫が見つかりません')
    await expect(asB((c) => inventory.mergeSplitInventory(c, itemA))).rejects.toThrow('在庫が見つかりません')
    await expect(asB((c) => inventory.setInventoryTags(c, itemA, []))).rejects.toThrow('在庫が見つかりません')

    // A の在庫は何も変わっていない
    const after = (await db.listInventory('in_stock'))[0]
    expect(after.id).toBe(itemA)
    expect(after.name).toBe('世帯Aの在庫【A001】')
    // 型番の先入先出も B からは何も選べない
    expect(await asB((c) => inventory.suggestProductInventory(c, 'A001', 1))).toEqual([])
    expect(await asA((c) => inventory.suggestProductInventory(c, 'A001', 1))).toEqual([itemA])
  })

  it('世帯 B の販売に、A の在庫は紐付けられない（id を知っていても）。B のタグを A の在庫にも付けられない', async () => {
    const saleB = (await w.b.run((c) => c.sql.get<{ id: string }>(
      `insert into sale (title, sold_at, price) values ('Bの販売', '2026-01-05', 1000) returning id`)))!.id
    await expect(asB((c) => inventory.linkInventory(c, saleB, [itemA]))).rejects.toThrow('在庫が見つかりません')
    const saleA = (await w.a.run((c) => c.sql.get<{ id: string }>(
      `insert into sale (title, sold_at, price) values ('Aの販売', '2026-01-05', 1000) returning id`)))!.id
    // A の販売に B から紐付けようとしても、販売が見えない
    await expect(asB((c) => inventory.linkInventory(c, saleA, [itemA]))).rejects.toThrow('販売が見つかりません')

    const tagB = await asB((c) => c.sql.get<{ id: string }>(`insert into tag (name) values ('Bのタグ') returning id`))
    await expect(asA((c) => inventory.setInventoryTags(c, itemA, [tagB!.id]))).rejects.toThrow('タグが見つかりません')

    expect((await db.sql('select * from sale_line'))).toHaveLength(0)
  })

  it('updateInventory は name / model_code / series_code / material / note だけ。landed_cost や status を渡しても書き換わらない（原価は生成時に確定）', async () => {
    const before = (await db.listInventory('in_stock'))[0]
    await db.updateInventory(itemA, {
      landed_cost: 1, status: 'sold', item_code: 'S-9999', acquired_at: '2000-01-01', note: 'メモだけ効く',
    } as never)
    const after = (await db.listInventory('in_stock'))[0]
    expect(after.landed_cost).toBe(before.landed_cost)
    expect(after.status).toBe('in_stock')
    expect(after.item_code).toBe(before.item_code)
    expect(after.acquired_at).toBe(before.acquired_at)
    expect(after.note).toBe('メモだけ効く')

    // null で消せる。何も渡さなければ何もしない（存在しない在庫でも黙って終わる）
    await db.updateInventory(itemA, { note: null, model_code: null })
    const cleared = (await db.listInventory('in_stock'))[0]
    expect(cleared.note).toBeNull()
    expect(cleared.model_code).toBeNull()
    await db.updateInventory(randomUUID(), {})
  })

  it('SQL に埋め込む別名は識別子の形だけ（画面の値を渡しても SQL を壊せない）', async () => {
    expect(() => derive.inventoryViewColumns('iv')).not.toThrow()
    expect(() => derive.inventoryViewColumns('iv; drop table sale')).toThrow('不正な別名です')
  })

  it('変な型の引数は UserError（500 にならない）', async () => {
    await expect(asA((c) => inventory.updateInventory(c, 'not-a-uuid', { name: 'x' }))).rejects.toThrow('在庫の指定が正しくありません')
    await expect(asA((c) => inventory.splitInventory(c, itemA, '3' as unknown as number))).rejects.toThrow('分割数は2以上の整数にしてください')
    await expect(asA((c) => inventory.updateInventory(c, itemA, { name: 123 } as never))).rejects.toThrow('商品名は文字で入力してください')
    await expect(asA((c) => inventory.updateInventory(c, itemA, { name: '   ' }))).rejects.toThrow('商品名を入力してください')
    await expect(asA((c) => inventory.updateInventory(c, itemA, 'x' as never))).rejects.toThrow('在庫の変更内容の形が正しくありません')
    await expect(asA((c) => inventory.disposeInventory(c, itemA, 'メモ', 'sold' as never))).rejects.toThrow('在庫の状態の値が正しくありません')
    await expect(asA((c) => inventory.setInventoryTags(c, itemA, 'x' as never))).rejects.toThrow('タグの形が正しくありません')
    await expect(asA((c) => inventory.setInventoryTags(c, itemA, ['x']))).rejects.toThrow('タグの指定が正しくありません')
    await expect(asA((c) => inventory.listInventory(c, 'gone' as never))).rejects.toThrow('在庫の状態の値が正しくありません')
    await expect(asA((c) => inventory.suggestProductInventory(c, '', 1))).rejects.toThrow('商品コードを指定してください')
    await expect(asA((c) => inventory.suggestProductInventory(c, 'A001', 0))).rejects.toThrow('点数は1以上の整数で指定してください')
    await expect(asA((c) => inventory.suggestProductInventory(c, 'A001', 1.5))).rejects.toThrow('点数は1以上の整数で指定してください')
    await expect(asA((c) => inventory.suggestProductInventory(c, 'A001', 1, ['x']))).rejects.toThrow('除外する在庫の指定が正しくありません')
    // 何も変わっていない
    expect((await db.listInventory('in_stock'))[0].name).toBe('世帯Aの在庫【A001】')
  })

  it('API の入口（dispatch）経由：変な引数は 400 の日本語、他の世帯の在庫は 404、正常は 200', async () => {
    const bad = await w.a.call('splitInventory', 'not-a-uuid', 2)
    expect(bad.status).toBe(400)
    expect(bad.body.error?.message).toBe('在庫の指定が正しくありません')

    const foreign = await w.b.call('disposeInventory', itemA, '捨てる')
    expect(foreign.status).toBe(404)
    expect(foreign.body.error?.message).toBe('在庫が見つかりません')

    // 画面は null を undefined の代わりに送る
    const list = await w.a.call('listInventory', null)
    expect(list.status).toBe(200)
    expect((list.body.result as Array<{ id: string }>).map(i => i.id)).toEqual([itemA])

    const split = await w.a.call('splitInventory', itemA, 2)
    expect(split.status).toBe(200)
    expect((split.body.result as string[])).toHaveLength(2)
  })
})
