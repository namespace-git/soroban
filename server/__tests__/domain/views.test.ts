import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import { UserError } from '../../errors'
import * as inbox from '../../domain/inbox'
import * as master from '../../domain/master'
import * as monthly from '../../domain/monthly'
import * as product from '../../domain/product'
import * as purchase from '../../domain/purchase'
import * as views from '../../domain/views'
import { handlers } from '../../rpc'
import { subtractDaysJst, thisMonthJst, todayJst } from '../../domain/_shared'
import type { ExpenseInput, PurchaseInput, SaleInput, SaleStatus } from '../../../src/shared/types'
import { MEDIA_BASE, newWorld, openDomainDb, type DomainDb, type World } from './helpers'
import { bindDb } from './core-helpers'

// src/main/__tests__/views.test.ts（6 本）と、db.test.ts / recognition.test.ts の中で views.ts・inbox.ts を見ているテストを移したもの。
// 期待値は変えていない。書き換えたのは「呼び方」だけ：
//   * 同期の views.xxx() / db.xxx(...) → await …（db は下の薄い包み。1 回の呼び出し＝1 リクエスト＝1 トランザクション）
//   * expect(() => …).toThrow() → await expect(…).rejects.toThrow()
//   * todayLocal() → todayJst()、thisMonthLocal() → thisMonthJst()、「N 日前」は subtractDaysJst(todayJst(), N)
//     （サーバーは UTC。日本の暦日で数える）
//   * 仕入は本物の purchase.createPurchase（仕入のドメイン）。販売・出品・在庫は core-helpers の包み
//   * getDb().prepare(…) の直接 SQL は db.sqlRun（Postgres の名前）に読み替えた
// 移した元：
//   views.test.ts  売上タブの進捗（2 本）／在庫タブの状態カードと型番グループ／商品カルテ／月次の計算書／仕入タブの仕入先カード
//   db.test.ts     listInventoryGroups：分割前の親（split）の絞り込み／getInventoryOverview().total／
//                  setProductNote の getProductKarte（summary.note）／滞留日数 → getInventoryOverview().aging（ちょうど 90 日）
//   recognition.test.ts  取引完了だけ実績・未完了は見込み：getMonthStatement・getInbox().strip の期待
// 移していないもの：
//   * recognition.test.ts の listMonthly / getMonthDetail / saleTotals / listProducts / getProduct / exportRows の期待
//     （それぞれ月次・商品・ホームのテスト。ここは getMonthStatement・getInbox の分だけ）
//   * scenarios/ には views.ts・inbox.ts を呼ぶものが無い（grep で確かめた）
// 足したもの：
//   * 日本時間：今月に完了した数、90 日以内に売れた数（UTC の 15:00〜23:59 で翌日・翌月扱い）
//   * 型番グループの絞り込み（unlisted / listed / sold / other / all / split）・並び（滞留の長い順、型番なしは最後）・代表画像
//   * 金額が合う：計算書（粗利＝売上−手数料−送料−梱包材−原価、純利益＝粗利−経費）／仕入先カードの総額＝按分後の合計
//   * 世帯 B から A が見えない（id を知っていても）／変な型の引数は UserError／dispatch 経由

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

afterEach(() => {
  vi.useRealTimers()
})

const A = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)
const core = bindDb(() => w.a)

/** 元のテストの `db.` と同じ形で呼べる、世帯 A の薄い包み */
const db = {
  ...core,
  createPurchase: (input: PurchaseInput) => A((c) => purchase.createPurchase(c, input)),
  createPurchaseDraft: (input: Parameters<typeof purchase.createPurchaseDraft>[1]) => A((c) => purchase.createPurchaseDraft(c, input)),
  createShopAccount: (name: string, kind?: Parameters<typeof master.createShopAccount>[2]) => A((c) => master.createShopAccount(c, name, kind)),
  startRun: (source: Parameters<typeof master.startRun>[1], shopAccountId?: string) => A((c) => master.startRun(c, source, shopAccountId ?? null)),
  finishRun: (id: string, status: Parameters<typeof master.finishRun>[2], fetched: number, inserted: number, message?: string) =>
    A((c) => master.finishRun(c, id, status, fetched, inserted, message)),
  createExpense: (input: ExpenseInput) => A((c) => monthly.createExpense(c, input)),
  listMonthly: () => A((c) => monthly.listMonthly(c)),
  getMonthDetail: (month: string) => A((c) => monthly.getMonthDetail(c, month)),
  setProductNote: (code: string, note: string | null) => A((c) => product.setProductNote(c, code, note)),
  getSalesProgress: () => A((c) => views.getSalesProgress(c)),
  getInventoryOverview: () => A((c) => views.getInventoryOverview(c)),
  listInventoryGroups: (filter: Parameters<typeof views.listInventoryGroups>[1]) => A((c) => views.listInventoryGroups(c, filter)),
  getProductKarte: (code: string) => A((c) => views.getProductKarte(c, code)),
  getMonthStatement: (month: string) => A((c) => views.getMonthStatement(c, month)),
  listPurchaseAccountCards: (from: string | null, to: string | null) => A((c) => views.listPurchaseAccountCards(c, from, to)),
  getInbox: () => A((c) => inbox.getInbox(c)),
}

/** 集計テスト用：取引完了を明示した販売を作る。状態未設定の仕様とは分ける */
async function createCompletedSale(input: SaleInput): Promise<string> {
  const id = await db.createSale(input)
  await db.applySaleActuals(id, { status: 'completed' })
  return id
}

/** 偽の時計（Date だけ）。非同期の DB の待ちは止めない */
function setClock(utc: [number, number, number, number, number]): void {
  vi.useRealTimers()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.UTC(utc[0], utc[1] - 1, utc[2], utc[3], utc[4])))
}

describe('views: 売上タブの進捗', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  it('販売4件(発送待ち1・発送済み1・今月完了1・私物1)と出品2件(引き当て1)の件数・金額', async () => {
    const today = todayJst()
    const shopId = await db.createShopAccount('メロジョイ')

    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: today,
      fulfillment: 'delivered',
      lines: [{ name: '【K100】テスト商品', unit_price: 1000, quantity: 5 }],
    })

    // A: 発送待ち・送料確定・自動紐付け
    const [saleA] = await db.insertCollected([{
      mercariItemId: 'm-a', title: '【K100】テスト商品', price: 2000, soldAt: today,
      fee: 200, shippingFee: 300, status: 'waiting_shipment',
    }])
    // B: 発送済み（受取評価待ち）・送料未入力
    const [saleB] = await db.insertCollected([{
      mercariItemId: 'm-b', title: '【K100】テスト商品', price: 2500, soldAt: today,
      fee: 250, status: 'shipped',
    }])
    // C: 今月完了・送料確定
    const [saleC] = await db.insertCollected([{
      mercariItemId: 'm-c', title: '【K100】テスト商品', price: 3000, soldAt: today,
      fee: 300, shippingFee: 400, status: 'completed',
    }])
    // D: 型番なし・私物
    await db.insertCollected([{
      mercariItemId: 'm-d', title: '普通の私物 靴', price: 500, soldAt: today, fee: 50,
    }])

    // 前提確認：A/B/C は自動紐付け済み（型番1つ・在庫が足りている）
    for (const s of [saleA, saleB, saleC]) {
      expect((await db.listSales()).find(x => x.id === s.id)!.unmatched).toBe(0)
    }

    // 出品2件。1件だけ在庫を引き当てる（残り2点のうち1点）
    await db.upsertListings([
      { mercariItemId: 'm-list-1', title: '【K100】テスト商品 出品', price: 2200, suspended: false, thumbUrl: null },
      { mercariItemId: 'm-list-2', title: '【K100】テスト商品 出品2', price: 2400, suspended: false, thumbUrl: null },
    ])
    const remaining = (await db.listInventory('in_stock')).filter(i => i.model_code === 'K100')
    expect(remaining).toHaveLength(2)
    await db.reserveInventory('m-list-1', [remaining[0].id])

    const progress = await db.getSalesProgress()

    expect(progress.to_ship).toEqual({ count: 1, revenue: 2000 })
    expect(progress.in_transit).toEqual({ count: 1, revenue: 2500 })
    expect(progress.completed_this_month).toEqual({ count: 1, revenue: 3000 })

    // listed: 出品2件のうち1件だけ引き当て済み
    expect(progress.listed.count).toBe(2)
    expect(progress.listed.unallocated).toBe(1)
    // 見込み粗利 = 2200 - floor(2200*0.1) - 1000(原価) - 0(送料未設定) = 980
    expect(progress.listed.expected_profit).toBe(980)

    // all = 販売4件 + 出品2件
    expect(progress.all).toBe(6)

    // inputs：転売のみ（私物Dは含めない）。B だけ送料未入力
    expect(progress.inputs.needs_shipping).toBe(1)
    expect(progress.inputs.needs_link).toBe(0)
    expect(progress.inputs.done).toBe(2) // A・C
  })

  it('出品中のカードは出品中のみを数える（停止中を足しても count・unallocated・expected_profit は動かない）。すべては停止中も含む', async () => {
    const today = todayJst()
    const shopId = await db.createShopAccount('メロジョイ')
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: today, fulfillment: 'delivered',
      lines: [{ name: '【K101】テスト商品', unit_price: 1000, quantity: 3 }],
    })
    await db.upsertListings([
      { mercariItemId: 'm-act-1', title: '【K101】出品中1', price: 2200, suspended: false, thumbUrl: null },
      { mercariItemId: 'm-act-2', title: '【K101】出品中2', price: 2400, suspended: false, thumbUrl: null },
    ])
    const stock = (await db.listInventory('in_stock')).filter(i => i.model_code === 'K101')
    await db.reserveInventory('m-act-1', [stock[0].id])

    const before = await db.getSalesProgress()
    expect(before.listed).toEqual({ count: 2, expected_profit: 980, unallocated: 1 })
    expect(before.all).toBe(2)

    // 停止中の出品（在庫を押さえている）を足す
    await db.upsertListings([
      { mercariItemId: 'm-sus-1', title: '【K101】停止中', price: 5000, suspended: true, thumbUrl: null },
    ])
    await db.reserveInventory('m-sus-1', [stock[1].id])

    const after = await db.getSalesProgress()
    expect(after.listed).toEqual(before.listed)
    expect(after.all).toBe(3)
  })

  it('今月に完了した数は日本時間で数える。UTC の 15:00〜23:59 は日本ではもう翌日（翌月）', async () => {
    setClock([2026, 9, 30, 16, 0]) // UTC 2026-09-30 16:00 = JST 2026-10-01 01:00
    expect(todayJst()).toBe('2026-10-01')
    await createCompletedSale({ title: '日本時間の今月の販売', sold_at: '2026-10-01', price: 1200 })
    await createCompletedSale({ title: '先月の販売', sold_at: '2026-09-30', price: 800 })

    expect((await db.getSalesProgress()).completed_this_month).toEqual({ count: 1, revenue: 1200 })
  })

  it('空の帳簿でも 0 で返る。世帯 B の進捗に A の販売・出品は出ない', async () => {
    const empty = await db.getSalesProgress()
    expect(empty).toEqual({
      listed: { count: 0, expected_profit: 0, unallocated: 0 },
      to_ship: { count: 0, revenue: 0 }, in_transit: { count: 0, revenue: 0 },
      completed_this_month: { count: 0, revenue: 0 }, all: 0,
      inputs: { needs_shipping: 0, needs_link: 0, done: 0 },
    })

    await db.createSale({ title: 'Aの販売', sold_at: todayJst(), price: 1000 })
    await db.upsertListings([{ mercariItemId: 'a-list', title: 'Aの出品', price: 2000, suspended: false, thumbUrl: null }])
    expect(await db.getSalesProgress()).toMatchObject({ all: 2, inputs: { needs_shipping: 1, needs_link: 1, done: 0 } })

    expect(await w.b.run((c) => views.getSalesProgress(c))).toEqual(empty)
  })
})

describe('views: 在庫タブの状態カードと型番グループ', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイ')
  })

  it('在庫5点(未出品・到着2/未着1/引き当て済み2のうち1点が滞留70日)', async () => {
    const today = todayJst()
    const oldDate = subtractDaysJst(today, 70)

    // 未出品・到着済み（fresh）2点
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: today, fulfillment: 'delivered',
      lines: [{ name: '【K200】テスト商品', unit_price: 1000, quantity: 2 }],
    })
    // 未着1点
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: today, fulfillment: 'pending',
      lines: [{ name: '【K200】テスト商品', unit_price: 1000, quantity: 1 }],
    })
    // 引き当て予定：到着済み(fresh)1点
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: today, fulfillment: 'delivered',
      lines: [{ name: '【K200】テスト商品', unit_price: 1000, quantity: 1 }],
    })
    // 引き当て予定：到着済みだが滞留70日
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: oldDate, fulfillment: 'delivered',
      lines: [{ name: '【K200】テスト商品', unit_price: 1000, quantity: 1 }],
    })

    await db.setSetting('aging_warn_days', '60')

    const items = (await db.listInventory('in_stock')).filter(i => i.model_code === 'K200')
    expect(items).toHaveLength(5)
    const freshUnlisted = items.filter(i => i.fulfillment === 'delivered' && i.aging_days < 60)
    const oldItem = items.find(i => i.aging_days >= 60)!
    const listedFresh = freshUnlisted.find(i => i.landed_cost === 1000)! // どれでもよい

    // 出品1件に「到着済み(fresh)1点」と「滞留70日1点」を引き当てる
    await db.upsertListings([
      { mercariItemId: 'm-k200', title: '【K200】テスト商品 出品', price: 3000, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('m-k200', [listedFresh.id, oldItem.id])

    const overview = await db.getInventoryOverview()

    // 未出品・到着済みは残り2点（引き当てた2点を除く）
    expect(overview.unlisted_arrived).toEqual({ count: 2, cost: 2000 })
    expect(overview.not_arrived).toEqual({ count: 1, cost: 1000 })
    expect(overview.listed.count).toBe(2)
    // 見込み粗利 = 3000 - floor(3000*0.1) - (1000+1000) - 0 = 700
    expect(overview.listed.expected_profit).toBe(700)
    expect(overview.aging).toEqual({ count: 1, cost: 1000, days: 60 })

    // 型番グループ：unlisted_arrived だけを見ると2点（引き当て済みの2点は除く）
    const groups = await db.listInventoryGroups('unlisted_arrived')
    expect(groups).toHaveLength(1)
    expect(groups[0].model_code).toBe('K200')
    expect(groups[0].items).toHaveLength(2)
    expect(groups[0].unlisted_arrived).toBe(2)
    expect(groups[0].not_arrived).toBe(1)
    expect(groups[0].listed).toBe(2)
    expect(groups[0].cost_per_item).toBe(1000) // in_stock 5点、単価1000固定
  })

  describe('listInventoryGroups：分割前の親（split）の絞り込み', () => {
    it('split は all にも other にも含めず、split フィルタでだけ見える', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-05-01', shipping_fee: 0,
        lines: [{ name: '分割元【P400】', unit_price: 3000, quantity: 1 }],
      })
      const [item] = await db.listInventory('in_stock')
      await db.splitInventory(item.id, 2)

      const all = await db.listInventoryGroups('all')
      const p400All = all.find(g => g.model_code === 'P400')
      // all には子（in_stock）2点だけが残り、親（split）は入らない
      expect(p400All?.items.every(i => i.status !== 'split')).toBe(true)
      expect(p400All?.items).toHaveLength(2)

      const other = await db.listInventoryGroups('other')
      expect(other.find(g => g.model_code === 'P400')).toBeUndefined()

      const splitOnly = await db.listInventoryGroups('split')
      const p400Split = splitOnly.find(g => g.model_code === 'P400')
      expect(p400Split?.items).toHaveLength(1)
      expect(p400Split?.items[0].status).toBe('split')
      expect(p400Split?.items[0].id).toBe(item.id)
    })
  })

  describe('getInventoryOverview().total：記録の上での在庫の総数', () => {
    it('在庫を作ると増える。廃棄・自家消費にしても（記録は残るので）減らない', async () => {
      expect((await db.getInventoryOverview()).total).toBe(0)

      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-06-01', shipping_fee: 0,
        lines: [{ name: '総数テスト', unit_price: 1000, quantity: 2 }],
      })
      expect((await db.getInventoryOverview()).total).toBe(2)

      const [item1] = await db.listInventory('in_stock')
      await db.disposeInventory(item1.id, '廃棄テスト', 'disposed')
      expect((await db.getInventoryOverview()).total).toBe(2)
    })
  })

  describe('滞留日数 → getInventoryOverview().aging', () => {
    it('acquired_atからの経過日数は、ちょうどの暦日数になる。ちょうど90日は長期滞留に入り、89日は入らない', async () => {
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

      const items = await db.listInventory('in_stock')
      expect(items.find(i => i.name === 'ちょうど90日')!.aging_days).toBe(90)
      expect(items.find(i => i.name === '89日')!.aging_days).toBe(89)
      expect(items.find(i => i.name === '今日仕入れた')!.aging_days).toBe(0)

      // aging_warn_days は既定90（世帯を作ったときの初期値）。90日ちょうどの1件だけが対象
      expect((await db.getInventoryOverview()).aging.count).toBe(1)
    })

    it('設定が数でなければ（壊れた値）既定の 60 日にして、在庫タブが開けなくなることはない', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: subtractDaysJst(todayJst(), 60), shipping_fee: 0,
        lines: [{ name: '60日', unit_price: 1000, quantity: 1 }],
      })
      await db.setSetting('aging_warn_days', 'abc')
      expect((await db.getInventoryOverview()).aging).toEqual({ count: 1, cost: 1000, days: 60 })
    })
  })

  // ------------------------------------------------------------
  // ここから Web 版で足したもの
  // ------------------------------------------------------------

  it('絞り込み：未出品＝到着済み＋未着、出品中、売れた、その他（廃棄）、すべて（分割前の親は除く）。型番ごとの点数は絞り込みに依らない', async () => {
    const newItem = async (name: string, fulfillment: 'delivered' | 'pending'): Promise<string> => {
      const before = new Set((await db.listInventory('in_stock')).map(i => i.id))
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: todayJst(), shipping_fee: 0, fulfillment,
        lines: [{ name, unit_price: 1000, quantity: 1, model_code: 'G100' }],
      })
      return (await db.listInventory('in_stock')).find(i => !before.has(i.id))!.id
    }
    const arrived = await newItem('到着済み', 'delivered')
    const notArrived = await newItem('未着', 'pending')
    const listed = await newItem('出品中', 'delivered')
    const sold = await newItem('売れた', 'delivered')
    const disposed = await newItem('廃棄', 'delivered')

    await db.upsertListings([{ mercariItemId: 'm-g100', title: '【G100】出品', price: 2000, suspended: false, thumbUrl: null }])
    await db.reserveInventory('m-g100', [listed])
    const saleId = await db.createSale({ title: '売れた商品', sold_at: todayJst(), price: 2000 })
    await db.linkInventory(saleId, [sold])
    await db.disposeInventory(disposed, '壊れた', 'disposed')

    const ids = async (filter: Parameters<typeof views.listInventoryGroups>[1]) =>
      (await db.listInventoryGroups(filter)).flatMap(g => g.items.map(i => i.id)).sort()
    expect(await ids('unlisted_arrived')).toEqual([arrived])
    expect(await ids('not_arrived')).toEqual([notArrived])
    expect(await ids('unlisted')).toEqual([arrived, notArrived].sort())
    expect(await ids('listed')).toEqual([listed])
    expect(await ids('sold')).toEqual([sold])
    expect(await ids('other')).toEqual([disposed])
    expect(await ids('all')).toEqual([arrived, notArrived, listed, sold, disposed].sort())
    expect(await ids('split')).toEqual([])

    // 点数は絞り込みに依らず、型番ごとの全体で数える
    const [g] = await db.listInventoryGroups('sold')
    expect(g).toMatchObject({ model_code: 'G100', unlisted_arrived: 1, not_arrived: 1, unlisted: 2, listed: 1, sold: 1 })
    // 中の並びは 在庫 → 売れた → 廃棄（状態の順）
    expect((await db.listInventoryGroups('all'))[0].items.map(i => i.status))
      .toEqual(['in_stock', 'in_stock', 'in_stock', 'sold', 'disposed'])
  })

  it('並びは滞留が長い順で、型番なしは最後。名前・代表画像・1点あたりの原価（合計が合う）', async () => {
    const buy = (name: string, daysAgo: number, model: string | null, qty: number, shipping = 0) => db.createPurchase({
      shop_account_id: shopId, ordered_at: subtractDaysJst(todayJst(), daysAgo), shipping_fee: shipping,
      lines: [{ name, unit_price: 1000, quantity: qty, model_code: model }],
    })
    await buy('新しい型番', 10, 'N100', 1)
    await buy('古い型番', 40, 'N200', 3, 1001) // 送料 1,001 を 3 点に割る → 333 / 334 / 334（合計 4,001）
    await buy('型番のない品', 5, null, 1)
    await db.setProductName('N100', '登録した名前')
    await db.upsertProductImage('N200', 'h/product/n200.jpg')

    const groups = await db.listInventoryGroups('all')
    expect(groups.map(g => g.model_code)).toEqual(['N200', 'N100', null])
    expect(groups.map(g => g.name)).toEqual(['古い型番', '登録した名前', '型番なし'])
    expect(groups.map(g => g.oldest_aging_days)).toEqual([40, 10, 5])
    expect(groups.map(g => g.thumb_url)).toEqual([`${MEDIA_BASE}/h/product/n200.jpg`, null, null])

    // 1点あたりの原価 = round(合計 / 点数)。合計は仕入の按分後の原価と 1 円も違わない
    const n200 = groups[0]
    expect(n200.items.reduce((s, i) => s + i.landed_cost, 0)).toBe(3 * 1000 + 1001)
    expect(n200.cost_per_item).toBe(Math.round((3 * 1000 + 1001) / 3)) // 1,334
    expect((await db.getInventoryOverview()).unlisted_arrived.cost).toBe(4001 + 1000 + 1000)
  })

  it('世帯 B の在庫タブに A の在庫は出ない', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-08-01', shipping_fee: 0,
      lines: [{ name: 'Aの在庫【B900】', unit_price: 1000, quantity: 2 }],
    })
    expect((await db.getInventoryOverview()).total).toBe(2)
    expect(await db.listInventoryGroups('all')).toHaveLength(1)

    expect(await w.b.run((c) => views.getInventoryOverview(c))).toMatchObject({
      total: 0, unlisted_arrived: { count: 0, cost: 0 }, not_arrived: { count: 0, cost: 0 }, listed: { count: 0 },
    })
    expect(await w.b.run((c) => views.listInventoryGroups(c, 'all'))).toEqual([])
  })

  it('変な型の引数は UserError（絞り込み）。dispatch 経由は 200 と 400', async () => {
    await expect(A((c) => views.listInventoryGroups(c, 'bogus' as never))).rejects.toBeInstanceOf(UserError)
    await expect(A((c) => views.listInventoryGroups(c, undefined as never))).rejects.toBeInstanceOf(UserError)
    await expect(A((c) => views.listInventoryGroups(c, 5 as never))).rejects.toBeInstanceOf(UserError)

    expect((await w.a.call('getInventoryOverview')).status).toBe(200)
    expect((await w.a.call('listInventoryGroups', 'all')).status).toBe(200)
    expect((await w.a.call('listInventoryGroups', 'split')).body.result).toEqual([])
    expect((await w.a.call('listInventoryGroups', 'bogus')).status).toBe(400)
    expect((await w.a.call('listInventoryGroups')).status).toBe(400)
  })
})

describe('views: 商品カルテ', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイ')
  })

  it('型番Xの在庫3点・販売2件', async () => {
    const today = todayJst()
    const monthAgo = subtractDaysJst(today, 30)

    await db.createPurchase({
      shop_account_id: shopId, ordered_at: today, fulfillment: 'delivered',
      lines: [{ name: 'X999 テスト商品', unit_price: 1000, quantity: 3, model_code: 'X999' }],
    })
    const items = (await db.listInventory('in_stock')).filter(i => i.model_code === 'X999')
    expect(items).toHaveLength(3)

    await db.saveShippingMethod({ name: 'ゆうパケット（テスト）', fee: 200 })
    await db.saveShippingMethod({ name: 'ネコポス（テスト）', fee: 300 })
    const methods = await db.listShippingMethods()
    const method1 = methods.find(m => m.name === 'ゆうパケット（テスト）')!
    const method2 = methods.find(m => m.name === 'ネコポス（テスト）')!

    // 古い方の販売（30日前）：ゆうパケット
    // タイトルに型番っぽい文字列（英字1+数字3）を入れると自動紐付けが割り込むため、
    // ここでは含めず手動での紐付けだけを試す
    const sale1 = await createCompletedSale({ title: 'テスト商品の販売その1', sold_at: monthAgo, price: 2000, kind: 'resale' })
    await db.linkInventory(sale1, [items[0].id])
    await db.updateSale(sale1, { shipping_method_id: method1.id })

    // 新しい方の販売（今日）：ネコポス
    const sale2 = await createCompletedSale({ title: 'テスト商品の販売その2', sold_at: today, price: 2500, kind: 'resale' })
    await db.linkInventory(sale2, [items[1].id])
    await db.updateSale(sale2, { shipping_method_id: method2.id })

    const karte = await db.getProductKarte('X999')

    expect(karte.summary.model_code).toBe('X999')
    expect(karte.in_stock).toEqual({ count: 1, arrived: 1, not_arrived: 0, cost: 1000 })
    expect(karte.price_range).toEqual({ min: 2000, max: 2500 })

    // 手計算：sale1 粗利 = 2000-200(手数料)-200(送料)-1000(原価) = 600
    //         sale2 粗利 = 2500-250(手数料)-300(送料)-1000(原価) = 950
    // avg_price=(2000+2500)/2=2250, avg_profit=(600+950)/2=775
    // profit_rate = round(775/2250*100) = 34
    expect(karte.profit_rate).toBe(34)

    // 先入先出の未出品在庫（残り1点）
    expect(karte.estimate_default.inventory_item_id).toBe(items[2].id)
    // 最後に使った発送方法（sold_at が新しい sale2 のもの）
    expect(karte.estimate_default.shipping_method_id).toBe(method2.id)

    await expect(db.getProductKarte('NOPE')).rejects.toThrow()
  })

  it('setProductNote の getProductKarte：メモは summary.note に出る。表示名とは独立に残る', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [{ name: 'ムースクリーム（箱）【Z078-2】', unit_price: 1000, quantity: 1 }],
    })

    // メモだけ付ける（表示名は付けない）
    await db.setProductNote('Z078-2', '型崩れしやすいので注意')
    const karte = await db.getProductKarte('Z078-2')
    expect(karte.summary.note).toBe('型崩れしやすいので注意')
    expect(karte.summary.custom_name).toBeNull()
    // 仕入明細の元の名前と表示名が同じなら source_name は出さない
    expect(karte.source_name).toBeNull()

    // 表示名を付けると、元の名前が source_name に出る。メモは残る
    await db.setProductName('Z078-2', '登録した名前')
    const named = await db.getProductKarte('Z078-2')
    expect(named.summary).toMatchObject({ name: '登録した名前', custom_name: '登録した名前', note: '型崩れしやすいので注意' })
    expect(named.source_name).toBe('ムースクリーム（箱）【Z078-2】')
  })

  it('カルテの summary は商品ページ（getProduct）の ProductSummary と同じ（月別・在庫・販売は入れない）。出品・在庫・販売を型番で組み替える', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: todayJst(), fulfillment: 'delivered', shipping_fee: 0,
      lines: [{ name: 'カルテの商品', unit_price: 1000, quantity: 3, model_code: 'KT01' }],
    })
    const [i1, i2, i3] = await db.listInventory('in_stock')
    await db.upsertListings([{ mercariItemId: 'm-kt', title: '【KT01】カルテの出品', price: 2000, suspended: false, thumbUrl: null }])
    await db.reserveInventory('m-kt', [i2.id])
    const saleId = await createCompletedSale({ title: 'カルテの販売', sold_at: todayJst(), price: 1800 })
    await db.linkInventory(saleId, [i1.id])

    const karte = await db.getProductKarte('KT01')
    const detail = (await A((c) => product.getProduct(c, 'KT01')))!
    const { months, items, sales, ...summary } = detail
    expect(karte.summary).toEqual(summary)
    expect(months.length).toBeGreaterThan(0)
    expect(karte.sales.map(s => s.id)).toEqual(sales.map(s => s.id))
    // 在庫は残っている 2 点（出品に引き当てた 1 点と、未出品の 1 点）。売れた 1 点は入らない
    expect(karte.items.map(i => i.id).sort()).toEqual([i2.id, i3.id].sort())
    expect(items.map(i => i.status).sort()).toEqual(['in_stock', 'in_stock', 'sold'])
    expect(karte.in_stock).toEqual({ count: 2, arrived: 2, not_arrived: 0, cost: 2000 })
    // 出品は 1 件（引き当てた在庫がこの型番）。見込み粗利 = 2000 − 200 − 1000
    expect(karte.listed).toEqual({ count: 1, price_total: 2000, expected_profit: 800 })
    expect(karte.listings.map(l => l.mercari_item_id)).toEqual(['m-kt'])
    expect(karte.sold_recent).toEqual({ count: 1, days: 90 })
    expect(karte.price_range).toEqual({ min: 1800, max: 1800 })
  })

  it('90 日以内に売れた数は日本時間の暦日で数える。ちょうど 90 日前は入り、91 日前は入らない', async () => {
    setClock([2026, 10, 12, 16, 0]) // UTC 2026-10-12 16:00 = JST 2026-10-13 01:00。90 日前は 2026-07-15（UTC の暦なら 07-14）
    expect(todayJst()).toBe('2026-10-13')
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-06-01', shipping_fee: 0,
      lines: [{ name: '日本時間の商品', unit_price: 1000, quantity: 2, model_code: 'JP01' }],
    })
    const [i1, i2] = await db.listInventory('in_stock')
    const exactly90 = await createCompletedSale({ title: 'ちょうど90日前の販売', sold_at: '2026-07-15', price: 2000 })
    const before = await createCompletedSale({ title: '91日前の販売', sold_at: '2026-07-14', price: 2000 })
    await db.linkInventory(exactly90, [i1.id])
    await db.linkInventory(before, [i2.id])

    expect((await db.getProductKarte('JP01')).sold_recent).toEqual({ count: 1, days: 90 })
  })

  it('1点あたりの売れた価格の価格帯は、まとめ売りでは按分後。合計は元の販売価格と一致する', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-08-01', shipping_fee: 0,
      lines: [{ name: 'まとめ売りの商品', unit_price: 500, quantity: 3, model_code: 'BD01' }],
    })
    const items = await db.listInventory('in_stock')
    const saleId = await createCompletedSale({ title: 'まとめ売りの販売', sold_at: '2026-08-05', price: 1001 })
    await db.linkInventory(saleId, items.map(i => i.id))

    // 1,001 円を 3 点に按分 → 333 / 334 / 334（余りは最後の行）。価格帯は 333〜334
    const karte = await db.getProductKarte('BD01')
    expect(karte.price_range).toEqual({ min: 333, max: 334 })
    const shares = await db.sql<{ price: number }>(
      'select price_share as price from sale_line_share where sale_id = ? order by price_share', saleId)
    expect(shares.map(r => r.price)).toEqual([333, 334, 334])
    expect(shares.reduce((s, r) => s + r.price, 0)).toBe(1001)
  })

  it('世帯 B は A の型番のカルテを見られない（型番を知っていても）。変な型の引数は UserError', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-08-01', shipping_fee: 0,
      lines: [{ name: 'Aの商品【S100】', unit_price: 1000, quantity: 1 }],
    })
    expect((await db.getProductKarte('S100')).summary.model_code).toBe('S100')

    const denied = w.b.run((c) => views.getProductKarte(c, 'S100'))
    await expect(denied).rejects.toBeInstanceOf(UserError)
    await expect(denied).rejects.toMatchObject({ code: 'not_found' })

    await expect(db.getProductKarte('')).rejects.toBeInstanceOf(UserError)
    await expect(db.getProductKarte(123 as never)).rejects.toBeInstanceOf(UserError)
    await expect(db.getProductKarte(undefined as never)).rejects.toBeInstanceOf(UserError)

    expect((await w.a.call('getProductKarte', 'S100')).status).toBe(200)
    expect((await w.b.call('getProductKarte', 'S100')).status).toBe(404)
    expect((await w.a.call('getProductKarte', 'NOPE')).status).toBe(404)
    expect((await w.a.call('getProductKarte', 7)).status).toBe(400)
  })
})

describe('views: 月次の計算書', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  it('getMonthDetail と粗利・純利益が一致し、タグ別集計とmulti_tag_countが合う', async () => {
    const today = todayJst()
    const month = today.slice(0, 7)
    const shopId = await db.createShopAccount('メロジョイ')
    const tagA = await db.createTag('タグA')
    const tagB = await db.createTag('タグB')

    await db.createPurchase({
      shop_account_id: shopId, ordered_at: today, fulfillment: 'delivered',
      lines: [{ name: 'M001 テスト商品', unit_price: 1000, quantity: 3, model_code: 'M001' }],
    })
    const items = (await db.listInventory('in_stock')).filter(i => i.model_code === 'M001')
    await db.setInventoryTags(items[2].id, [tagB]) // sale3 に派生で付く

    // タイトルに型番っぽい文字列（英字1+数字3）を入れると自動紐付けが割り込むため含めない
    const sale1 = await createCompletedSale({ title: 'テスト商品の販売その1', sold_at: today, price: 1000, kind: 'resale' })
    await db.linkInventory(sale1, [items[0].id])
    await db.setSaleTags(sale1, [tagA])

    const sale2 = await createCompletedSale({ title: 'テスト商品の販売その2', sold_at: today, price: 1500, kind: 'resale' })
    await db.linkInventory(sale2, [items[1].id])
    await db.setSaleTags(sale2, [tagA, tagB])

    const sale3 = await createCompletedSale({ title: 'テスト商品の販売その3', sold_at: today, price: 2000, kind: 'resale' })
    await db.linkInventory(sale3, [items[2].id])
    // sale3 はタグを直接付けない（tagB は在庫からの派生）

    const detail = await db.getMonthDetail(month)
    const statement = await db.getMonthStatement(month)

    expect(statement.sales_count).toBe(detail.totals.sales_count)
    expect(statement.revenue).toBe(detail.totals.revenue)
    expect(statement.gross_profit).toBe(detail.totals.gross_profit)
    expect(statement.net_profit).toBe(detail.totals.net_profit)
    expect(statement.cost_items).toBe(3) // 3件とも1点ずつ紐付け

    const tagAEntry = statement.by_tag.find(t => t.tag.id === tagA)!
    const tagBEntry = statement.by_tag.find(t => t.tag.id === tagB)!
    const s1 = detail.sales.find(s => s.id === sale1)!
    const s2 = detail.sales.find(s => s.id === sale2)!
    const s3 = detail.sales.find(s => s.id === sale3)!

    expect(tagAEntry.count).toBe(2) // sale1・sale2
    expect(tagAEntry.gross_profit).toBe(s1.gross_profit + s2.gross_profit)
    expect(tagBEntry.count).toBe(2) // sale2（直接）・sale3（派生）
    expect(tagBEntry.gross_profit).toBe(s2.gross_profit + s3.gross_profit)

    // 2つ以上タグを持つのは sale2 だけ（tagA + tagB 直接）
    expect(statement.multi_tag_count).toBe(1)
  })

  it('金額が合う：粗利＝売上−手数料−送料−梱包材−原価、純利益＝粗利−経費。経費は項目ごとの内訳の合計', async () => {
    const shopId = await db.createShopAccount('メロジョイ')
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-08-01', shipping_fee: 0,
      lines: [{ name: '計算書の商品A', unit_price: 1000, quantity: 1 }, { name: '計算書の商品B', unit_price: 400, quantity: 1 }],
    })
    const [a, b] = await db.listInventory('in_stock')
    const sale1 = await createCompletedSale({ title: '計算書の販売1', sold_at: '2026-08-05', price: 3000 })
    await db.linkInventory(sale1, [a.landed_cost === 1000 ? a.id : b.id])
    await db.updateSale(sale1, { shipping_fee: 700, packaging_cost: 50 })
    const sale2 = await createCompletedSale({ title: '計算書の販売2', sold_at: '2026-08-06', price: 1500 })
    await db.linkInventory(sale2, [a.landed_cost === 1000 ? b.id : a.id])
    await db.updateSale(sale2, { shipping_fee: 400, packaging_cost: 20 })
    await db.createExpense({ occurred_at: '2026-08-10', category: 'packaging', amount: 120 })
    await db.createExpense({ occurred_at: '2026-08-11', category: 'supplies', amount: 80 })

    const s = await db.getMonthStatement('2026-08')
    // 販売1：3000 − 300 − 700 − 50 − 1000 = 950。販売2：1500 − 150 − 400 − 20 − 400 = 530
    expect(s).toMatchObject({
      sales_count: 2, revenue: 4500, fee: 450, shipping: 1100, packaging: 70, cost: 1400, cost_items: 2,
      gross_profit: 1480, expense_total: 200, net_profit: 1280,
    })
    expect(s.revenue - s.fee - s.shipping - s.packaging - s.cost).toBe(s.gross_profit)
    expect(s.gross_profit - s.expense_total).toBe(s.net_profit)
    expect(s.expenses.reduce((sum, e) => sum + e.amount, 0)).toBe(s.expense_total)
    // 率は円の整数から出す（四捨五入）
    expect(s.gross_rate).toBe(Math.round((1480 / 4500) * 100)) // 33
    expect(s.net_rate).toBe(Math.round((1280 / 4500) * 100)) // 28
  })

  it('売上のない月は率が null。変な月・変な型は UserError。dispatch 経由は 200 と 400', async () => {
    const empty = await db.getMonthStatement('2020-01')
    expect(empty).toMatchObject({ sales_count: 0, revenue: 0, gross_rate: null, net_rate: null, by_tag: [], multi_tag_count: 0 })

    await expect(db.getMonthStatement('2026-13')).rejects.toBeInstanceOf(UserError)
    await expect(db.getMonthStatement('2026-1')).rejects.toBeInstanceOf(UserError)
    await expect(db.getMonthStatement(202610 as never)).rejects.toBeInstanceOf(UserError)
    await expect(db.getMonthStatement(undefined as never)).rejects.toBeInstanceOf(UserError)

    expect((await w.a.call('getMonthStatement', '2026-10')).status).toBe(200)
    expect((await w.a.call('getMonthStatement', 'bogus')).status).toBe(400)
    expect((await w.a.call('getMonthStatement')).status).toBe(400)
  })

  it('世帯 B の計算書に A の販売・経費は出ない', async () => {
    await createCompletedSale({ title: 'Aの販売', sold_at: '2026-08-05', price: 3000 })
    await db.createExpense({ occurred_at: '2026-08-10', category: 'packaging', amount: 120 })
    expect(await db.getMonthStatement('2026-08')).toMatchObject({ sales_count: 1, revenue: 3000, expense_total: 120 })

    expect(await w.b.run((c) => views.getMonthStatement(c, '2026-08'))).toMatchObject({
      sales_count: 0, revenue: 0, expense_total: 0, net_profit: 0, by_tag: [],
    })
  })
})

describe('views: 仕入タブの仕入先カード', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  it('2仕入先・期間で絞る', async () => {
    const shop1 = await db.createShopAccount('メロジョイA', 'mellojoy')
    const shop2 = await db.createShopAccount('メロジョイB', 'other')

    // shop1：期間内の確定（2点・3000円）
    await db.createPurchase({
      shop_account_id: shop1, ordered_at: '2025-06-10',
      lines: [{ name: 'A1', unit_price: 1000, quantity: 1 }, { name: 'A2', unit_price: 2000, quantity: 1 }],
    })
    // shop1：期間外の確定（除外される）
    await db.createPurchase({
      shop_account_id: shop1, ordered_at: '2025-05-01',
      lines: [{ name: 'A3', unit_price: 500, quantity: 1 }],
    })
    // shop1：期間内の下書き
    await db.createPurchaseDraft({
      import_key: 'draft-1', shop_account_id: shop1, ordered_at: '2025-06-15',
      lines: [{ name: 'D1', quantity: 1 }],
    })
    // shop1：期間内の未着（確定）
    await db.createPurchase({
      shop_account_id: shop1, ordered_at: '2025-06-20', fulfillment: 'pending',
      lines: [{ name: 'P1', unit_price: 100, quantity: 1 }],
    })

    // shop2：期間内の確定（3点・900円）
    await db.createPurchase({
      shop_account_id: shop2, ordered_at: '2025-06-05',
      lines: [{ name: 'B1', unit_price: 300, quantity: 3 }],
    })

    // shop1：ログイン切れの実行記録
    const runId = await db.startRun('mellojoy', shop1)
    await db.finishRun(runId, 'auth_required', 0, 0, 'ログインが必要です')

    const cards = await db.listPurchaseAccountCards('2025-06-01', '2025-06-30')

    expect(cards[0]).toMatchObject({ shop_account_id: null, name: 'すべて' })
    const all = cards[0]
    const card1 = cards.find(c => c.shop_account_id === shop1)!
    const card2 = cards.find(c => c.shop_account_id === shop2)!

    // shop1：確定2件（2000+1000=3000円の注文 + 100円の未着注文）、点数3、下書き1、未着1
    expect(card1.orders).toBe(2)
    expect(card1.items).toBe(3)
    expect(card1.total_cost).toBe(3100)
    expect(card1.drafts).toBe(1)
    expect(card1.not_arrived).toBe(1)
    expect(card1.auth_required).toBe(true)

    expect(card2.orders).toBe(1)
    expect(card2.items).toBe(3)
    expect(card2.total_cost).toBe(900)
    expect(card2.drafts).toBe(0)
    expect(card2.not_arrived).toBe(0)
    expect(card2.auth_required).toBe(false)

    expect(all.orders).toBe(card1.orders + card2.orders)
    expect(all.items).toBe(card1.items + card2.items)
    expect(all.total_cost).toBe(card1.total_cost + card2.total_cost)
    expect(all.drafts).toBe(card1.drafts + card2.drafts)
    expect(all.not_arrived).toBe(card1.not_arrived + card2.not_arrived)
    expect(all.auth_required).toBe(true)
  })

  it('金額が合う：総額は商品代＋按分した送料・その他費用−割引と 1 円も違わない。期間なし（null）は全期間', async () => {
    const shop = await db.createShopAccount('金額の仕入先')
    // 商品代 3,000 + 送料 1,000 + その他 50 − 割引 100 = 3,950（金額按分で 2 行に配る。端数は最後の行）
    await db.createPurchase({
      shop_account_id: shop, ordered_at: '2026-03-01', shipping_fee: 1000, discount: 100, other_cost: 50,
      lines: [{ name: '按分A', unit_price: 1000, quantity: 1 }, { name: '按分B', unit_price: 2000, quantity: 1 }],
    })
    // 商品代 900 + 送料 100 = 1,000（数量按分で 3 点に配る）
    await db.createPurchase({
      shop_account_id: shop, ordered_at: '2026-04-01', shipping_fee: 100, alloc_method: 'by_quantity',
      lines: [{ name: '按分C', unit_price: 300, quantity: 3 }],
    })

    const [all, card] = await db.listPurchaseAccountCards(null, null)
    expect(card).toMatchObject({ shop_account_id: shop, name: '金額の仕入先', orders: 2, items: 5, total_cost: 3950 + 1000 })
    expect(all).toMatchObject({ orders: 2, items: 5, total_cost: 4950 })
    // 在庫の原価の合計とも一致する（landed_cost は生成時に確定）
    expect((await db.listInventory('in_stock')).reduce((s, i) => s + i.landed_cost, 0)).toBe(4950)

    // 期間は両端を含む。3 月だけ・4 月だけ・どちらの月でもない期間
    expect((await db.listPurchaseAccountCards('2026-03-01', '2026-03-31'))[1]).toMatchObject({ orders: 1, items: 2, total_cost: 3950 })
    expect((await db.listPurchaseAccountCards('2026-04-01', '2026-04-01'))[1]).toMatchObject({ orders: 1, items: 3, total_cost: 1000 })
    expect((await db.listPurchaseAccountCards('2026-04-02', null))[1]).toMatchObject({ orders: 0, items: 0, total_cost: 0 })
    expect((await db.listPurchaseAccountCards(null, '2026-02-28'))[0]).toMatchObject({ orders: 0, items: 0, total_cost: 0 })
  })

  it('仕入先が 0 件でも「すべて」だけ返る。ログイン切れの実行記録が無い仕入先・古い実行は auth_required にならない', async () => {
    expect(await db.listPurchaseAccountCards(null, null)).toEqual([{
      shop_account_id: null, name: 'すべて', kind: null, orders: 0, items: 0, total_cost: 0, drafts: 0, not_arrived: 0, auth_required: false,
    }])

    const shop = await db.createShopAccount('メロジョイA', 'mellojoy')
    const runId = await db.startRun('mellojoy', shop)
    await db.finishRun(runId, 'auth_required', 0, 0, 'ログインが必要です')
    expect((await db.listPurchaseAccountCards(null, null)).map(c => c.auth_required)).toEqual([true, true])
    // 同じ仕入先の次の実行が成功すれば、ログイン切れではなくなる（直近の 1 件だけを見る）
    const ok = await db.startRun('mellojoy', shop)
    await db.finishRun(ok, 'ok', 3, 3)
    expect((await db.listPurchaseAccountCards(null, null)).map(c => c.auth_required)).toEqual([false, false])
  })

  it('世帯 B のカードに A の仕入先・仕入は出ない（仕入先の id を知っていても）', async () => {
    const shop = await db.createShopAccount('Aの仕入先')
    await db.createPurchase({
      shop_account_id: shop, ordered_at: '2026-03-01', shipping_fee: 0,
      lines: [{ name: 'Aの仕入', unit_price: 1000, quantity: 1 }],
    })
    expect((await db.listPurchaseAccountCards(null, null))[0]).toMatchObject({ orders: 1, total_cost: 1000 })

    const b = await w.b.run((c) => views.listPurchaseAccountCards(c, null, null))
    expect(b).toHaveLength(1)
    expect(b[0]).toMatchObject({ shop_account_id: null, orders: 0, items: 0, total_cost: 0, drafts: 0 })
  })

  it('変な型・変な日付の引数は UserError。dispatch 経由は 200（null は期間なし）と 400', async () => {
    await expect(db.listPurchaseAccountCards('2026-13-01', null)).rejects.toBeInstanceOf(UserError)
    await expect(db.listPurchaseAccountCards(null, '2026-02-30')).rejects.toBeInstanceOf(UserError)
    await expect(db.listPurchaseAccountCards('abc', null)).rejects.toBeInstanceOf(UserError)
    await expect(db.listPurchaseAccountCards(20260101 as never, null)).rejects.toBeInstanceOf(UserError)
    await expect(db.listPurchaseAccountCards(null, { a: 1 } as never)).rejects.toBeInstanceOf(UserError)

    expect((await w.a.call('listPurchaseAccountCards', null, null)).status).toBe(200)
    expect((await w.a.call('listPurchaseAccountCards', '2026-01-01', null)).status).toBe(200)
    expect((await w.a.call('listPurchaseAccountCards')).status).toBe(200)
    expect((await w.a.call('listPurchaseAccountCards', 'bogus', null)).status).toBe(400)
  })
})

describe('API の登録（受信箱・画面ごとの集計）', () => {
  it('受信箱と集計の 8 本が登録されている（呼び方は src/main/index.ts の handle と同じ）', () => {
    const names = [
      'getInbox', 'snoozeReminder', 'getSalesProgress', 'getInventoryOverview',
      'listInventoryGroups', 'getProductKarte', 'getMonthStatement', 'listPurchaseAccountCards',
    ] as const
    for (const name of names) expect(typeof handlers[name], name).toBe('function')
  })
})

describe('recognition：取引完了だけ実績・未完了は見込み（月次の計算書・ホームの数字）', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  it('すべての未完了状態と状態不明を分離し、ホーム・月次・タグ合計が一致する', async () => {
    const month = thisMonthJst()
    const tag = await db.createTag('対象')
    const statuses: Array<SaleStatus | null> = [null, 'waiting_payment', 'waiting_shipment', 'shipped', 'delivered', 'completed']
    for (const status of statuses) {
      const [{ id }] = await db.insertCollected([{ mercariItemId: `state-${status}`, title: `商品【A037】${status}`, soldAt: `${month}-01`, price: 1000, status: status ?? undefined }])
      await db.setSaleTags(id, [tag])
    }
    await db.createExpense({ occurred_at: `${month}-01`, category: 'packaging', amount: 200 })
    const actual = (await db.listMonthly()).find(r => r.month === month)!
    expect(actual).toMatchObject({ sales_count: 1, revenue: 1000, gross_profit: 900, net_profit: 700,
      forecast: { count: 5, revenue: 5000, gross_profit: 4500 } })
    expect(await db.getMonthStatement(month)).toMatchObject({ sales_count: 1, net_profit: 700, forecast: actual.forecast })
    expect((await db.getMonthDetail(month)).sales).toHaveLength(1)
    expect((await db.getMonthDetail(month)).forecast_sales).toHaveLength(5)
    expect((await db.getInbox()).strip).toMatchObject({ revenue: 1000, gross_profit: 900, pending_profit_estimate: 4500, pending_count: 5 })
  })

  it('赤字の見込みも残し、見込みだけの月に経費を二重計上しない', async () => {
    const id = await db.createSale({ title: '赤字', sold_at: '2026-05-01', price: 100 })
    await db.applySaleActuals(id, { status: 'shipped' })
    await db.updateSale(id, { shipping_fee: 300 })
    await db.createExpense({ occurred_at: '2026-05-01', category: 'packaging', amount: 50 })
    expect((await db.listMonthly()).find(r => r.month === '2026-05' && r.kind === 'resale'))
      .toMatchObject({ revenue: 0, net_profit: -50,
        forecast: { count: 1, revenue: 100, gross_profit: -210 } })
    expect(await db.getMonthStatement('2026-05')).toMatchObject({ revenue: 0, net_profit: -50,
      forecast: { count: 1, revenue: 100, gross_profit: -210 } })
  })

  it('状態未設定の手入力は実績。取得分の状態不明は見込み。保存状態は変更しない', async () => {
    const month = thisMonthJst()
    const shop = await db.createShopAccount('手入力テスト')
    await db.createPurchase({ shop_account_id: shop, ordered_at: `${month}-01`,
      lines: [{ name: '商品【A037】', unit_price: 500, quantity: 2 }] })
    const manual = await db.createSale({ title: '商品【A037】', sold_at: `${month}-01`, price: 1000 })
    await db.insertCollected([{ mercariItemId: 'unknown', title: '商品【A037】', soldAt: `${month}-01`, price: 2000 }])
    expect((await db.listSales()).find(s => s.id === manual)?.status).toBeNull()
    expect(await db.getMonthStatement(month)).toMatchObject({ sales_count: 1, revenue: 1000, gross_profit: 400 })
    expect((await db.getInbox()).strip).toMatchObject({ revenue: 1000, pending_profit_estimate: 1300 })
  })
})
