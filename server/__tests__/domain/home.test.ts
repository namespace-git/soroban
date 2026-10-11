import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import { UserError } from '../../errors'
import * as home from '../../domain/home'
import * as master from '../../domain/master'
import * as monthly from '../../domain/monthly'
import * as product from '../../domain/product'
import * as purchase from '../../domain/purchase'
import * as sale from '../../domain/sale'
import { subtractDaysJst, thisMonthJst, todayJst } from '../../domain/_shared'
import { SALE_KIND_LABEL } from '../../../src/shared/types'
import type { ExpenseInput, PurchaseInput, SaleInput } from '../../../src/shared/types'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'
import { bindDb } from './core-helpers'

// src/main/__tests__/db.test.ts のホーム（getDashboard）・データの健康診断（getHealthChecks）・横断検索（searchAll）・
// CSV 書き出し（exportCsvRows）のテストを移したもの。期待値は変えていない。書き換えたのは「呼び方」だけ：
//   * 同期の db.xxx(...) → await db.xxx(...)（db は下の薄い包み。1 回の呼び出し＝1 リクエスト＝1 トランザクション）
//   * expect(() => …).toThrow() → await expect(…).rejects.toThrow()
//   * 仕入は本物の purchase.createPurchase（仕入のドメイン）を使う。販売・出品・在庫は core-helpers の包み
//   * 「N 日前」は todayLocal() ではなく subtractDaysJst(todayJst(), N)（サーバー＝Workers は UTC。日本の暦日で数える）
//   * 偽の時計は vi.useFakeTimers() ではなく Date だけ（非同期の DB の待ちを止めない）、ローカル時刻ではなく UTC の瞬間で置く
//   * getDb().prepare(…) の直接 SQL は db.sql / sqlRun（Postgres の名前）に読み替えた
//   * 存在しない出品の SQL による書き換えは listing.channel_item_id（mercari_item_id から名前が変わった列）
// 移した元（db.test.ts）：
//   getDashboard().thisMonth／getDashboard().needsShipment／getDashboard().needsListingAllocation／getDashboard().recentRuns／
//   searchAll：横断検索（12 本）／getHealthChecks（15 本）／exportCsvRows（8 本。経費の 2 本は exportExpenseRows の経路の確認）
//   recognition.test.ts の exportRows（実績・見込みの区分）
//   scenarios/ persona-01（基本）／persona-08（下書き→確定の要対応）／persona-18（数字の突き合わせ）／persona-21・22（在庫数・在庫金額）／persona-23（検索）
//   と、persona-20 の「空の帳簿でも getDashboard は例外なく返り全部 0」
// 移していないもの：
//   * persona-20 の resetData（Web 版に「全部消す」API は無い）／persona-15 は product.test.ts（履歴に出る日付の分）
//   * getInventoryOverview().aging（views.ts の担当）。滞留日数そのものは search.test.ts にあり、ここでは getDashboard().agingCount で確かめた
//   * inbox / views / monthly の getMonthStatement・getInbox の期待（受信箱・ビュー、月次の担当）

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
  confirmPurchase: (id: string, input: PurchaseInput) => A((c) => purchase.confirmPurchase(c, id, input)),
  setPurchaseTags: (id: string, tagIds: string[]) => A((c) => purchase.setPurchaseTags(c, id, tagIds)),
  setProductTags: (code: string, tagIds: string[]) => A((c) => product.setProductTags(c, code, tagIds)),
  createShopAccount: (name: string, kind?: Parameters<typeof master.createShopAccount>[2]) => A((c) => master.createShopAccount(c, name, kind)),
  updateShopAccount: (id: string, patch: Parameters<typeof master.updateShopAccount>[2]) => A((c) => master.updateShopAccount(c, id, patch)),
  startRun: (source: Parameters<typeof master.startRun>[1], shopAccountId?: string) => A((c) => master.startRun(c, source, shopAccountId ?? null)),
  finishRun: (id: string, status: Parameters<typeof master.finishRun>[2], fetched: number, inserted: number, message?: string) =>
    A((c) => master.finishRun(c, id, status, fetched, inserted, message)),
  createExpense: (input: ExpenseInput) => A((c) => monthly.createExpense(c, input)),
  listMonthly: () => A((c) => monthly.listMonthly(c)),
  getDashboard: () => A((c) => home.getDashboard(c)),
  getHealthChecks: () => A((c) => home.getHealthChecks(c)),
  searchAll: (query: string, limit?: number) => A((c) => home.searchAll(c, query, limit)),
  exportRows: (month?: string) => A((c) => home.exportRows(c, month)),
  exportCsvRows: (kind?: Parameters<typeof home.exportCsvRows>[1], month?: string) => A((c) => home.exportCsvRows(c, kind, month)),
}

/** 集計テスト用：取引完了を明示した販売を作る。状態未設定の仕様とは分ける */
async function createCompletedSale(input: SaleInput): Promise<string> {
  const id = await db.createSale(input)
  await db.applySaleActuals(id, { status: 'completed' })
  return id
}

/** exportCsvRows() の CSV（先頭にBOM、CRLF区切り）をパースする（値に含まれるカンマ・"" のクォートも展開する） */
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

const daysAgo = (n: number): string => subtractDaysJst(todayJst(), n)

// ============================================================
// ホーム（要対応の数字）
// ============================================================

describe('getDashboard：ホームの要対応', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('空の帳簿でも例外なく返り、数字は全部 0。今月は販売が 0 件でも 0 の行が返る（月次画面が前月のまま固まらないように）', async () => {
    const dash = await db.getDashboard()
    expect(dash.needsShipping).toBe(0)
    expect(dash.needsMatch).toBe(0)
    expect(dash.needsPurchaseConfirm).toBe(0)
    expect(dash.needsListingAllocation).toBe(0)
    expect(dash.needsShipment).toBe(0)
    expect(dash.stockCount).toBe(0)
    expect(dash.stockValue).toBe(0)
    expect(dash.agingCount).toBe(0)
    expect(dash.thisMonth).toMatchObject({
      month: thisMonthJst(), kind: 'resale', sales_count: 0, revenue: 0, gross_profit: 0, net_profit: 0,
    })
    expect(dash.lastRun).toBeNull()
    expect(dash.recentRuns).toEqual([])
  })

  it('getDashboard().thisMonth：net_profit/expense_total/unconfirmed_shippingが入る（monthly_summaryビューを直読みすると無かった）', async () => {
    await createCompletedSale({ title: '今月の転売', sold_at: todayJst(), price: 1000 })
    // 手動の経費（計上月省略→occurred_atの月）がexpense_totalに乗る
    await db.createExpense({ occurred_at: todayJst(), category: 'packaging', amount: 200 })

    const dash = await db.getDashboard()
    expect(dash.thisMonth).not.toBeNull()
    expect(dash.thisMonth!.kind).toBe('resale')
    expect(dash.thisMonth!.revenue).toBe(1000)
    expect(dash.thisMonth!.total_fee).toBe(100) // fee_rate_bp既定1000(10%)
    expect(dash.thisMonth!.expense_total).toBe(200)
    expect(dash.thisMonth!.net_profit).toBe((1000 - 100) - 200)
    expect(dash.thisMonth!.unconfirmed_shipping).toBe(1) // 送料未入力のまま集計されている
  })

  it('getDashboard().thisMonth は実績だけ。未完了は forecast（見込み）に別に出て、粗利に混ざらない', async () => {
    await createCompletedSale({ title: '完了', sold_at: todayJst(), price: 1000 })
    const pending = await db.createSale({ title: '発送済み', sold_at: todayJst(), price: 3000 })
    await db.applySaleActuals(pending, { status: 'shipped' })

    const dash = await db.getDashboard()
    expect(dash.thisMonth).toMatchObject({ sales_count: 1, revenue: 1000, gross_profit: 900 })
    expect(dash.thisMonth!.forecast).toEqual({ count: 1, revenue: 3000, gross_profit: 2700 })
  })

  it('今月は日本時間で決める。UTC ではまだ前の月の 15:00〜23:59 でも、日本時間の今月の行が返り、その月の販売が数えられる', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 30, 16, 0, 0))) // UTC 2026-09-30 16:00 = JST 2026-10-01 01:00
    expect(todayJst()).toBe('2026-10-01')
    await createCompletedSale({ title: '日本時間の10月1日の販売', sold_at: todayJst(), price: 1000 })

    const dash = await db.getDashboard()
    expect(dash.thisMonth).toMatchObject({ month: '2026-10', kind: 'resale', sales_count: 1, revenue: 1000 })
  })

  it('getDashboard().needsShipment：status=waiting_shipmentの件数', async () => {
    await db.insertCollected([
      { mercariItemId: 'ns-1', title: '発送待ち1', price: 1000, soldAt: '2026-08-01', status: 'waiting_shipment' },
      { mercariItemId: 'ns-2', title: '発送待ち2', price: 1000, soldAt: '2026-08-02', status: 'waiting_shipment' },
      { mercariItemId: 'ns-3', title: '支払い待ち', price: 1000, soldAt: '2026-08-03', status: 'waiting_payment' },
      { mercariItemId: 'ns-4', title: '完了済み', price: 1000, soldAt: '2026-08-04', status: 'completed' },
    ])

    expect((await db.getDashboard()).needsShipment).toBe(2)
  })

  it('getDashboard().needsShipping / needsMatch：送料未入力の販売と、未紐付けの転売（私物は数えない）', async () => {
    const resale = await db.createSale({ title: '転売・送料未入力・未紐付け', sold_at: '2026-08-01', price: 1000 })
    await db.createSale({ title: '私物・送料未入力', sold_at: '2026-08-02', price: 500, kind: 'personal' })

    let dash = await db.getDashboard()
    expect(dash.needsShipping).toBe(2) // 送料未入力は転売も私物も数える
    expect(dash.needsMatch).toBe(1) // 未紐付けは転売だけ

    await db.updateSale(resale, { shipping_fee: 200 })
    dash = await db.getDashboard()
    expect(dash.needsShipping).toBe(1)
    expect(dash.needsMatch).toBe(1) // 送料を入れても紐付けるまで残る

    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-07-01', shipping_fee: 0,
      lines: [{ name: '紐付ける在庫', unit_price: 500, quantity: 1 }],
    })
    await db.linkInventory(resale, [(await db.listInventory('in_stock'))[0].id])
    expect((await db.getDashboard()).needsMatch).toBe(0)
  })

  it('getDashboard().needsListingAllocation：activeで未引き当ての出品数（suspendedは数えない）', async () => {
    await db.upsertListings([
      { mercariItemId: 'NA1', title: '未引き当て1', price: 1000, suspended: false, thumbUrl: null },
      { mercariItemId: 'NA2', title: '未引き当て2', price: 1000, suspended: false, thumbUrl: null },
      { mercariItemId: 'NA3', title: '公開停止中', price: 1000, suspended: true, thumbUrl: null },
    ])
    expect((await db.getDashboard()).needsListingAllocation).toBe(2)

    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: '引き当て用', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.reserveInventory('NA1', [item.id])
    expect((await db.getDashboard()).needsListingAllocation).toBe(1)
  })

  it('getDashboard().needsPurchaseConfirm：下書きの仕入の件数。確定すると 0（persona-08）', async () => {
    const draftId = await db.createPurchaseDraft({
      import_key: 'order-8001',
      shop_account_id: shopId,
      ordered_at: '2026-02-01',
      order_no: '8001',
      lines: [{ name: 'テスト商品【D001】', quantity: 3 }],
    })
    expect(draftId).not.toBe('')

    // 在庫はまだ無い
    expect(await db.listInventory('in_stock')).toHaveLength(0)
    // ダッシュボードの「要対応」に出る
    expect((await db.getDashboard()).needsPurchaseConfirm).toBe(1)

    // 同じ import_key でもう一度積んでも増えない
    const dup = await db.createPurchaseDraft({
      import_key: 'order-8001', shop_account_id: shopId, ordered_at: '2026-02-01',
      lines: [{ name: 'テスト商品【D001】', quantity: 3 }],
    })
    expect(dup).toBe('')
    expect((await db.getDashboard()).needsPurchaseConfirm).toBe(1)

    await db.confirmPurchase(draftId, {
      shop_account_id: shopId, ordered_at: '2026-02-01', order_no: '8001', shipping_fee: 100,
      lines: [{ name: 'テスト商品【D001】', unit_price: 1000, quantity: 3 }],
    })
    const items = await db.listInventory('in_stock')
    // 端数は最終アイテムへ寄る（1033/1033/1034）。合計はpool(3100)と一致
    expect([...items].sort((a, b) => a.landed_cost - b.landed_cost).map(i => i.landed_cost)).toEqual([1033, 1033, 1034])
    expect(items.reduce((s, i) => s + i.landed_cost, 0)).toBe(3100)
    expect((await db.getDashboard()).needsPurchaseConfirm).toBe(0)
    // 在庫の金額はダッシュボードも同じ
    expect((await db.getDashboard()).stockValue).toBe(3100)
  })

  it('getDashboard().recentRuns：取り込み元ごとの直近1件（mercari + 有効なメロジョイ口座ごと）が状態を隠さず並ぶ', async () => {
    // shopId（beforeEachで作成）はkind未指定＝'other'なので、ここではmellojoy口座を別途作る
    const mellojoyAId = await db.createShopAccount('メロジョイ口座A', 'mellojoy')
    const mellojoyBId = await db.createShopAccount('メロジョイ口座B', 'mellojoy')

    // メルカリ：1回目ok→2回目failed（直近＝failedだけが残る）
    const m1 = await db.startRun('mercari')
    await db.finishRun(m1, 'ok', 3, 1)
    const m2 = await db.startRun('mercari')
    await db.finishRun(m2, 'failed', 0, 0, 'ERR_FAILED loading /account')

    // メロジョイ口座A：ok
    const a1 = await db.startRun('mellojoy', mellojoyAId)
    await db.finishRun(a1, 'ok', 2, 1)

    const recent = (await db.getDashboard()).recentRuns
    expect(recent).toHaveLength(2)
    expect(recent[0].source).toBe('mercari')
    expect(recent[0].status).toBe('failed')
    expect(recent[0].message).toBe('ERR_FAILED loading /account')
    expect(recent[1].source).toBe('mellojoy')
    expect(recent[1].shop_account_id).toBe(mellojoyAId)
    expect(recent[1].status).toBe('ok')

    // kind='other'（shopId）の実行があっても、メロジョイ口座扱いにはしない
    const otherRun = await db.startRun('mellojoy', shopId)
    await db.finishRun(otherRun, 'ok', 1, 1)
    expect((await db.getDashboard()).recentRuns.some(r => r.shop_account_id === shopId)).toBe(false)

    // 無効化した口座の実行は入らない
    const b1 = await db.startRun('mellojoy', mellojoyBId)
    await db.finishRun(b1, 'auth_required', 0, 0, 'ログインが必要です')
    await db.updateShopAccount(mellojoyBId, { is_active: 0 })
    expect((await db.getDashboard()).recentRuns.some(r => r.shop_account_id === mellojoyBId)).toBe(false)

    // 有効に戻すと、口座の名前順（A→B）で並ぶ
    await db.updateShopAccount(mellojoyBId, { is_active: 1 })
    const recent2 = (await db.getDashboard()).recentRuns
    expect(recent2.map(r => r.shop_account_name)).toEqual([null, 'メロジョイ口座A', 'メロジョイ口座B'])
    // 最後の1回（lastRun）は取り込み元を問わない直近 1 件
    expect((await db.getDashboard()).lastRun!.id).toBe(b1)
  })

  it('stockCount / stockValue：未販売在庫の点数と原価合計。分割しても親は数えず、売れた分・廃棄した分は減る（persona-03・22）', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-04-01', shipping_fee: 0,
      lines: [{ name: '【W001】ケース', unit_price: 3198, quantity: 1 }],
    })
    const parent = (await db.listInventory('in_stock'))[0]
    const childIds = await db.splitInventory(parent.id, 4) // 799, 799, 800, 800

    // 親は split になり in_stock から消える。在庫金額にも出ない
    let dash = await db.getDashboard()
    expect(dash.stockCount).toBe(4)
    expect(dash.stockValue).toBe(3198)

    const children = (await db.listInventory('in_stock')).filter(i => childIds.includes(i.id))
    const sorted = [...children].sort((a, b) => a.landed_cost - b.landed_cost)
    for (const item of [sorted[0], sorted[2]]) { // 799 と 800 を売る
      const saleId = await db.createSale({ title: 'ケース売却', sold_at: '2026-04-05', price: 1500 })
      await db.linkInventory(saleId, [item.id])
    }
    dash = await db.getDashboard()
    expect(dash.stockCount).toBe(2)
    expect(dash.stockValue).toBe(799 + 800)

    // 廃棄すると在庫金額から消える（出品に引き当て中でも）
    await db.upsertListings([{ mercariItemId: 'M101', title: '商品', price: 2000, suspended: false, thumbUrl: null }])
    await db.reserveInventory('M101', [sorted[1].id])
    await db.disposeInventory(sorted[1].id, '出し直しをやめた', 'disposed')
    dash = await db.getDashboard()
    expect(dash.stockCount).toBe(1)
    expect(dash.stockValue).toBe(sorted[3].landed_cost)
  })

  it('agingCount：滞留warn日数（既定90）を超えた在庫の点数。ちょうど90日は入り、89日は入らない（日本時間の暦日）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 12, 16, 0, 0))) // JST 2026-10-13 01:00
    expect(todayJst()).toBe('2026-10-13')
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

    const dash = await db.getDashboard()
    expect(dash.stockCount).toBe(3)
    expect(dash.agingCount).toBe(1)

    // 設定 aging_warn_days を変えると、その日数が境目になる
    await db.setSetting('aging_warn_days', '30')
    expect((await db.getDashboard()).agingCount).toBe(2)
    // 設定が数でなければ（壊れた値）既定の 90 日で数え、ホームが開けなくなることはない
    await db.setSetting('aging_warn_days', 'abc')
    expect((await db.getDashboard()).agingCount).toBe(1)
  })

  it('世帯 B のホームに A の数字は出ない', async () => {
    await db.createSale({ title: 'Aの未処理の販売', sold_at: '2026-08-01', price: 1000 })
    await db.createPurchaseDraft({ import_key: 'a-draft', shop_account_id: shopId, ordered_at: '2026-08-01', lines: [] })
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-08-01', shipping_fee: 0,
      lines: [{ name: 'Aの在庫', unit_price: 1000, quantity: 2 }],
    })
    const a = await db.getDashboard()
    expect(a.needsShipping).toBe(1)
    expect(a.needsPurchaseConfirm).toBe(1)
    expect(a.stockCount).toBe(2)

    const b = await w.b.run((c) => home.getDashboard(c))
    expect(b).toMatchObject({
      needsShipping: 0, needsMatch: 0, needsPurchaseConfirm: 0, needsListingAllocation: 0, needsShipment: 0,
      stockCount: 0, stockValue: 0, agingCount: 0, lastRun: null, recentRuns: [],
    })
    expect(b.thisMonth).toMatchObject({ sales_count: 0, revenue: 0 })
  })

  it('dispatch 経由：getDashboard は 200 で、JSON にできる形で返る', async () => {
    await db.createSale({ title: '販売', sold_at: '2026-08-01', price: 1000 })
    const r = await w.a.call('getDashboard')
    expect(r.status).toBe(200)
    expect(r.body.result).toMatchObject({ needsShipping: 1, needsMatch: 1, stockCount: 0, recentRuns: [] })
    expect((await w.b.call('getDashboard')).body.result).toMatchObject({ needsShipping: 0 })
  })
})

// ============================================================
// データの健康診断
// ============================================================

describe('getHealthChecks：データの健康診断（読むだけ。直しはしない）', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('きれいなDBでは空配列', async () => {
    expect(await db.getHealthChecks()).toEqual([])
  })

  it('alloc-mismatch：allocated_costをわざと壊すと検出され、正常な注文では出ない。読むだけで直さない', async () => {
    const purchaseId = await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 100,
      lines: [{ name: '正常な仕入', unit_price: 1000, quantity: 1 }],
    })
    expect((await db.getHealthChecks()).find(c => c.id === 'alloc-mismatch')).toBeUndefined()

    await db.sqlRun('update purchase_line set allocated_cost = ? where purchase_id = ?', 9999, purchaseId)

    const found = (await db.getHealthChecks()).find(c => c.id === 'alloc-mismatch')
    expect(found?.count).toBe(1)
    expect(found?.level).toBe('warn')

    // 直しはしない：診断を何度走らせても、壊した値はそのまま（直すのは人が仕入を開いて保存し直したとき）
    await db.getHealthChecks()
    expect(await db.sql('select allocated_cost from purchase_line where purchase_id = ?', purchaseId))
      .toEqual([{ allocated_cost: 9999 }])
    // 在庫の原価（landed_cost）にも触らない
    expect((await db.listInventory('in_stock')).map(i => i.landed_cost)).toEqual([1100])
  })

  it('alloc-mismatch：下書きは数えない。送料・その他費用が大きくても診断自体は落ちない（足し算は bigint）', async () => {
    await db.createPurchaseDraft({ import_key: 'd-1', shop_account_id: shopId, ordered_at: '2026-01-01', lines: [] })
    expect((await db.getHealthChecks()).find(c => c.id === 'alloc-mismatch')).toBeUndefined()

    // integer の上限に近い送料とその他費用（足すと integer を超える）。明細の無い確定済みの仕入として直接入れる
    await db.sqlRun(
      `insert into purchase (shop_account_id, ordered_at, shipping_fee, other_cost, status)
       values (?, '2026-01-02', 2147483647, 2147483647, 'confirmed')`, shopId,
    )
    const found = (await db.getHealthChecks()).find(c => c.id === 'alloc-mismatch')
    expect(found?.count).toBe(1)
  })

  it('zero-cost-link：原価0円の在庫を紐付けた転売の販売が1件になる', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '原価0円商品', unit_price: 0, quantity: 1 }],
    })
    const [item] = await db.listInventory('in_stock')
    const saleId = await db.createSale({ title: '原価0円商品', sold_at: todayJst(), price: 1000 })
    await db.linkInventory(saleId, [item.id])

    const found = (await db.getHealthChecks()).find(c => c.id === 'zero-cost-link')
    expect(found?.count).toBe(1)
    expect(found?.goto).toEqual({ tab: 'sales', stage: 'all' })
  })

  it('status-mismatch：在庫の状態と紐付けが食い違うと検出される（トリガーで起きないはずの食い違い）', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '食い違い', unit_price: 1000, quantity: 2 }],
    })
    const [a, b] = await db.listInventory('in_stock')
    expect((await db.getHealthChecks()).find(c => c.id === 'status-mismatch')).toBeUndefined()

    // sale_line が無いのに sold
    await db.sqlRun(`update inventory_item set status = 'sold' where id = ?`, a.id)
    expect((await db.getHealthChecks()).find(c => c.id === 'status-mismatch')).toMatchObject({ level: 'warn', count: 1 })

    // sale_line があるのに sold でない（紐付けたあとで、状態だけ手で戻した想定）
    await db.sqlRun(`update inventory_item set status = 'in_stock' where id = ?`, a.id)
    const saleId = await db.createSale({ title: '食い違いの販売', sold_at: '2026-01-05', price: 1000 })
    await db.linkInventory(saleId, [b.id])
    await db.sqlRun(`update inventory_item set status = 'in_stock' where id = ?`, b.id)
    expect((await db.getHealthChecks()).find(c => c.id === 'status-mismatch')).toMatchObject({ level: 'warn', count: 1 })
  })

  it('shipping-old：送料未入力のまま30日たった販売が1件になる（29日は出ない）', async () => {
    await db.createSale({ title: '古い販売', sold_at: daysAgo(31), price: 1000 })
    await db.createSale({ title: '最近の販売', sold_at: daysAgo(29), price: 1000 })

    const found = (await db.getHealthChecks()).find(c => c.id === 'shipping-old')
    expect(found?.count).toBe(1)
    expect(found?.level).toBe('info')
  })

  it('unmatched-old：紐付けないまま30日たった転売の販売が1件になる（私物は数えない）', async () => {
    await db.createSale({ title: '未紐付け・古い', sold_at: daysAgo(35), price: 1000 })
    await db.createSale({ title: '未紐付け・私物', sold_at: daysAgo(35), price: 1000, kind: 'personal' })

    const found = (await db.getHealthChecks()).find(c => c.id === 'unmatched-old')
    expect(found?.count).toBe(1)
  })

  it('draft-old：下書きのまま14日たった仕入が1件になる', async () => {
    await db.createPurchaseDraft({
      import_key: 'draft-old-1', shop_account_id: shopId,
      ordered_at: daysAgo(15), lines: [],
    })
    await db.createPurchaseDraft({
      import_key: 'draft-old-2', shop_account_id: shopId,
      ordered_at: daysAgo(5), lines: [],
    })

    const found = (await db.getHealthChecks()).find(c => c.id === 'draft-old')
    expect(found?.count).toBe(1)
    expect(found?.goto).toEqual({ tab: 'purchases' })
  })

  it('経過日数はJSTの暦日で数える。UTCでは前日にあたる時刻（JST深夜0時台）でも、' +
    'shipping-old・unmatched-old（30日）とdraft-old（14日）のちょうどの日数の扱いが変わらない', async () => {
    // 「いま」を JST 2026-05-01 00:15（= UTC 2026-04-30 15:15）に固定する。
    // UTC の日付で数えると、この時間帯だけ経過日数が実際より少なく出て境目が1日ずれる
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.UTC(2026, 3, 30, 15, 15, 0)))
    expect(todayJst()).toBe('2026-05-01')
    await db.createSale({ title: 'ちょうど30日・未紐付け', sold_at: daysAgo(30), price: 1000 })
    await db.createSale({ title: '29日・未紐付け', sold_at: daysAgo(29), price: 1000 })
    await db.createPurchaseDraft({
      import_key: 'draft-jst-1', shop_account_id: shopId,
      ordered_at: daysAgo(14), lines: [],
    })
    await db.createPurchaseDraft({
      import_key: 'draft-jst-2', shop_account_id: shopId,
      ordered_at: daysAgo(13), lines: [],
    })

    const checks = await db.getHealthChecks()
    expect(checks.find(c => c.id === 'shipping-old')?.count).toBe(1)
    expect(checks.find(c => c.id === 'unmatched-old')?.count).toBe(1)
    expect(checks.find(c => c.id === 'draft-old')?.count).toBe(1)
  })

  it('同じ「ちょうど30日／29日／31日・14日／13日」の扱いが、JST昼間に実行しても深夜0時台と同じになる', async () => {
    // 深夜0時台と結果を比較するため、今度は UTC でも同じ日付になる JST 昼間（12:00）に固定する
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.UTC(2026, 3, 30, 3, 0, 0))) // JST 2026-04-30 12:00
    await db.createSale({ title: 'ちょうど30日・未紐付け・昼', sold_at: daysAgo(30), price: 1000 })
    await db.createSale({ title: '31日・未紐付け・昼', sold_at: daysAgo(31), price: 1000 })
    await db.createSale({ title: '29日・未紐付け・昼', sold_at: daysAgo(29), price: 1000 })
    await db.createPurchaseDraft({
      import_key: 'draft-noon-1', shop_account_id: shopId,
      ordered_at: daysAgo(14), lines: [],
    })
    await db.createPurchaseDraft({
      import_key: 'draft-noon-2', shop_account_id: shopId,
      ordered_at: daysAgo(13), lines: [],
    })

    const checks = await db.getHealthChecks()
    // 30日・31日の2件が対象（29日は対象外）
    expect(checks.find(c => c.id === 'unmatched-old')?.count).toBe(2)
    expect(checks.find(c => c.id === 'shipping-old')?.count).toBe(2)
    expect(checks.find(c => c.id === 'draft-old')?.count).toBe(1)
  })

  it('no-model-code：型番の無いin_stock在庫が1件になる', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '型番の無い商品', unit_price: 1000, quantity: 1 }],
    })
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '型番あり商品【M001】', unit_price: 1000, quantity: 1 }],
    })

    const found = (await db.getHealthChecks()).find(c => c.id === 'no-model-code')
    expect(found?.count).toBe(1)
    expect(found?.goto).toEqual({ tab: 'inventory' })
  })

  it('collect-empty：取り込み元ごとの最新3件が全部 empty のときだけ。2件では出ない・1件でも ok が混ざれば出ない', async () => {
    const run = async (source: 'mercari' | 'yahoo', status: 'ok' | 'empty') => {
      const id = await db.startRun(source)
      await db.finishRun(id, status, 0, 0)
    }
    await run('mercari', 'empty')
    await run('mercari', 'empty')
    expect((await db.getHealthChecks()).find(c => c.id === 'collect-empty')).toBeUndefined() // まだ 2 件

    await run('mercari', 'empty')
    expect((await db.getHealthChecks()).find(c => c.id === 'collect-empty')).toMatchObject({ level: 'info', count: 1 })

    // 取り込み元ごとに数える：yahoo も続けて 0 件なら 2 件
    await run('yahoo', 'empty'); await run('yahoo', 'empty'); await run('yahoo', 'empty')
    expect((await db.getHealthChecks()).find(c => c.id === 'collect-empty')?.count).toBe(2)

    // 最新が ok になれば、その取り込み元は外れる
    await run('mercari', 'ok')
    expect((await db.getHealthChecks()).find(c => c.id === 'collect-empty')?.count).toBe(1)
  })

  it('warnがinfoより先に並ぶ。同じ水準の中は件数の多い順', async () => {
    // info（no-model-code）
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '型番なし', unit_price: 1000, quantity: 1 }],
    })
    // warn（zero-cost-link）
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-02', shipping_fee: 0,
      lines: [{ name: '原価0円【M002】', unit_price: 0, quantity: 1 }],
    })
    const [item] = (await db.listInventory('in_stock')).filter(i => i.name === '原価0円【M002】')
    const saleId = await db.createSale({ title: '原価0円【M002】', sold_at: todayJst(), price: 1000 })
    await db.linkInventory(saleId, [item.id])

    const checks = await db.getHealthChecks()
    const firstInfoIndex = checks.findIndex(c => c.level === 'info')
    const lastWarnIndex = checks.map(c => c.level).lastIndexOf('warn')
    expect(firstInfoIndex).toBeGreaterThan(lastWarnIndex)

    // info の中は件数の多い順（古い販売 3 件の shipping-old/unmatched-old が、no-model-code 1 件より前）
    for (const n of [1, 2, 3]) await db.createSale({ title: `古い${n}`, sold_at: daysAgo(40 + n), price: 1000 })
    const infos = (await db.getHealthChecks()).filter(c => c.level === 'info')
    for (let i = 1; i < infos.length; i++) expect(infos[i - 1].count).toBeGreaterThanOrEqual(infos[i].count)
  })

  describe('listing-blocks-sale／suspended-listing-reserved：出品に取られたままの在庫', () => {
    it('実データの再現：suspendedな出品が握った在庫と同じ型番のYahoo販売が未紐付けだと、両方1件ずつ出る', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A040】もこ山 スクイーズ', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      await db.upsertListings([
        { mercariItemId: 'm-blk-1', title: '【A040】もこ山 スクイーズ', price: 3000, suspended: true, thumbUrl: null },
      ])
      await db.reserveInventory('m-blk-1', [item.id])

      const saleId = await db.createSale({
        title: 'もこ山 スクイーズ【A040】', sold_at: '2026-01-10', price: 5750, channel: 'yahoo',
      })
      const sale = (await db.listSales()).find(s => s.id === saleId)!
      expect(sale.unmatched).toBe(1)

      const checks = await db.getHealthChecks()
      expect(checks.find(c => c.id === 'listing-blocks-sale')).toMatchObject({
        level: 'warn', count: 1, goto: { tab: 'sales', stage: 'all' },
      })
      expect(checks.find(c => c.id === 'suspended-listing-reserved')).toMatchObject({
        level: 'info', count: 1, goto: { tab: 'sales', stage: 'listed', listingStatus: 'suspended' },
      })
    })

    it('同じ型番の在庫がもう1点、引き当てられずに残っていればlisting-blocks-saleは出ない（FIFOで紐付くので）。suspended-listing-reservedは出る', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A050】在庫2点', unit_price: 1000, quantity: 2 }],
      })
      const [item1] = await db.listInventory('in_stock')
      await db.upsertListings([
        { mercariItemId: 'm-blk-2', title: '【A050】在庫2点', price: 3000, suspended: true, thumbUrl: null },
      ])
      await db.reserveInventory('m-blk-2', [item1.id]) // item2は未引き当てのまま残す

      const saleId = await db.createSale({ title: '在庫2点【A050】', sold_at: '2026-01-10', price: 3000, channel: 'yahoo' })
      const sale = (await db.listSales()).find(s => s.id === saleId)!
      expect(sale.unmatched).toBe(0) // item2で普通に自動紐付けできている

      const checks = await db.getHealthChecks()
      expect(checks.find(c => c.id === 'listing-blocks-sale')).toBeUndefined()
      expect(checks.find(c => c.id === 'suspended-listing-reserved')).toMatchObject({ count: 1 })
    })

    it('activeな出品が握っている場合：listing-blocks-saleは出るが、suspended-listing-reservedは出ない（出品中は正常）', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A051】商品', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      await db.upsertListings([
        { mercariItemId: 'm-blk-3', title: '【A051】商品', price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('m-blk-3', [item.id])

      const saleId = await db.createSale({ title: '商品【A051】', sold_at: '2026-01-10', price: 3000, channel: 'yahoo' })
      const sale = (await db.listSales()).find(s => s.id === saleId)!
      expect(sale.unmatched).toBe(1)

      const checks = await db.getHealthChecks()
      expect(checks.find(c => c.id === 'listing-blocks-sale')).toMatchObject({ count: 1 })
      expect(checks.find(c => c.id === 'suspended-listing-reserved')).toBeUndefined()
    })

    it('sold/endedの出品が握っていた在庫は、どちらも数えない', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A052】商品', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      await db.upsertListings([
        { mercariItemId: 'm-blk-4', title: '【A052】商品', price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('m-blk-4', [item.id])
      // 通常はtakeOverListingがlisting_lineを先に消してからsoldにするが、万一残っていても
      // 数えないことを確かめる（既存のgetAutoLinkBlockersのテストと同じやり方）
      await db.sqlRun(`update listing set status = 'sold' where channel_item_id = ?`, 'm-blk-4')

      const saleId = await db.createSale({ title: '商品【A052】', sold_at: '2026-01-10', price: 3000, channel: 'yahoo' })
      const sale = (await db.listSales()).find(s => s.id === saleId)!
      expect(sale.unmatched).toBe(0) // soldな出品は横取りにならないのでFIFOで紐付く

      const checks = await db.getHealthChecks()
      expect(checks.find(c => c.id === 'listing-blocks-sale')).toBeUndefined()
      expect(checks.find(c => c.id === 'suspended-listing-reserved')).toBeUndefined()
    })

    it('私物・型番なし・型番2つ・紐付け済みの販売はlisting-blocks-saleに数えない', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A053】商品', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      await db.upsertListings([
        { mercariItemId: 'm-blk-5', title: '【A053】商品', price: 3000, suspended: true, thumbUrl: null },
      ])
      await db.reserveInventory('m-blk-5', [item.id])

      // 私物
      await db.createSale({ title: '商品【A053】', sold_at: '2026-01-10', price: 3000, kind: 'personal' })
      // 型番なし
      await db.createSale({ title: '型番なしの商品', sold_at: '2026-01-10', price: 1000 })
      // 型番2つ
      await db.createSale({ title: '【A053】と【A054】のセット', sold_at: '2026-01-10', price: 2000 })
      // 紐付け済み（別の型番の在庫を明示的に紐付ける）
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A055】別商品', unit_price: 1000, quantity: 1 }],
      })
      const item55 = (await db.listInventory('in_stock')).find(i => i.model_code === 'A055')!
      const linkedSaleId = await db.createSale({ title: '別商品【A055】', sold_at: '2026-01-10', price: 3000 })
      await db.linkInventory(linkedSaleId, [item55.id])

      const checks = await db.getHealthChecks()
      expect(checks.find(c => c.id === 'listing-blocks-sale')).toBeUndefined()
    })

    it('該当が無いとき、どちらもリストに出てこない', async () => {
      const checks = await db.getHealthChecks()
      expect(checks.find(c => c.id === 'listing-blocks-sale')).toBeUndefined()
      expect(checks.find(c => c.id === 'suspended-listing-reserved')).toBeUndefined()
    })
  })

  it('世帯の分離：A の問題は B の診断に出ない。B にも同じ問題があれば B の分だけ数える', async () => {
    await db.createSale({ title: 'Aの古い販売', sold_at: daysAgo(40), price: 1000 })
    expect((await db.getHealthChecks()).map(c => c.id).sort()).toEqual(['shipping-old', 'unmatched-old'])
    expect(await w.b.run((c) => home.getHealthChecks(c))).toEqual([])

    await w.b.run((c) => sale.createSale(c, { title: 'Bの古い販売', sold_at: daysAgo(50), price: 1000 }))
    const b = await w.b.run((c) => home.getHealthChecks(c))
    expect(b.find(c => c.id === 'shipping-old')?.count).toBe(1)
    expect((await db.getHealthChecks()).find(c => c.id === 'shipping-old')?.count).toBe(1)
  })

  it('dispatch 経由：getHealthChecks は 200 で、HealthCheck の配列を返す', async () => {
    await db.createSale({ title: '古い販売', sold_at: daysAgo(40), price: 1000 })
    const r = await w.a.call('getHealthChecks')
    expect(r.status).toBe(200)
    const ids = (r.body.result as Array<{ id: string; count: number }>).map(c => c.id).sort()
    expect(ids).toEqual(['shipping-old', 'unmatched-old'])
  })
})

// ============================================================
// 横断検索
// ============================================================

describe('searchAll：横断検索', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('空文字（空白のみ含む）は[]を返す', async () => {
    expect(await db.searchAll('')).toEqual([])
    expect(await db.searchAll('   ')).toEqual([])
  })

  it('型番で在庫・出品・販売・仕入のすべてにヒットする', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      order_no: 'PO-Z200',
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

    const hits = await db.searchAll('Z200-1')
    expect(hits.map(h => h.kind).sort()).toEqual(['inventory', 'listing', 'purchase', 'sale'])

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

    const sale = hits.find(h => h.kind === 'sale')!
    expect(sale.status_label).toBe('私物')
    expect(sale.amount).toBe(3000)

    const purchaseHit = hits.find(h => h.kind === 'purchase')!
    expect(purchaseHit.status_label).toBe('未着')
    expect(purchaseHit.amount).toBe(1000)
  })

  it('タグ名（直接・派生）でヒットする', async () => {
    const tag = await db.createTag('限定品')
    const purchaseId = await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: 'タグ検索対象', unit_price: 1000, quantity: 1 }],
    })
    await db.setPurchaseTags(purchaseId, [tag])

    // 仕入のタグは在庫・販売にも派生する
    const item = (await db.listInventory('in_stock'))[0]
    const saleId = await db.createSale({ title: 'タグ検索対象の販売', sold_at: '2026-01-05', price: 2000 })
    await db.linkInventory(saleId, [item.id])

    const hits = await db.searchAll('限定品')
    expect(hits.map(h => h.kind).sort()).toEqual(['inventory', 'purchase', 'sale'])
  })

  it('買い手（buyer）でヒットする', async () => {
    const saleId = await db.createSale({ title: '買い手検索対象', sold_at: '2026-01-01', price: 1000 })
    await db.sqlRun(`update sale set buyer = ? where id = ?`, 'やまだたろう', saleId)

    const hits = await db.searchAll('やまだたろう')
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('sale')
    expect(hits[0].id).toBe(saleId)
  })

  it('注文番号・メモでヒットする（仕入）', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      order_no: 'ORDER-777',
      note: '特別な注文',
      lines: [{ name: 'メモ検索対象', unit_price: 1000, quantity: 1 }],
    })
    // order_noは在庫（inventory_view経由）・仕入の両方の検索対象なので両方にヒットする
    const orderHits = await db.searchAll('ORDER-777')
    expect(orderHits.map(h => h.kind).sort()).toEqual(['inventory', 'purchase'])

    // noteは仕入自身のメモ（在庫のnoteとは別）なので仕入だけにヒットする
    expect(await db.searchAll('特別な注文')).toHaveLength(1)
    expect((await db.searchAll('特別な注文'))[0].kind).toBe('purchase')
  })

  it('空白区切りAND：全部の語を満たすものだけヒットする', async () => {
    await db.createSale({ title: 'AAA商品', sold_at: '2026-01-01', price: 1000, note: 'BBBメモ' })
    await db.createSale({ title: 'AAA商品2', sold_at: '2026-01-02', price: 1000 })

    expect(await db.searchAll('AAA BBB')).toHaveLength(1)
    expect(await db.searchAll('AAA')).toHaveLength(2)
  })

  it('全角英数はNFKC正規化で半角と同一視する', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{
        name: 'ぜんかく検索テスト', unit_price: 1000, quantity: 1,
        model_code: 'Z300', series_code: 'Z300',
      }],
    })

    const hits = await db.searchAll('Ｚ３００')
    expect(hits.some(h => h.model_code === 'Z300')).toBe(true)
  })

  it('limit：種類ごとの上限はceil(limit/4)。新しい順に残る', async () => {
    for (let i = 0; i < 10; i++) {
      await db.createSale({
        title: `件数テスト${i}`,
        sold_at: `2026-01-${String(i + 1).padStart(2, '0')}`,
        price: 1000,
      })
    }
    const hits = await db.searchAll('件数テスト', 8) // perKind = ceil(8/4) = 2
    expect(hits.filter(h => h.kind === 'sale')).toHaveLength(2)
    expect(hits.filter(h => h.kind === 'sale').map(h => h.date)).toEqual(['2026-01-10', '2026-01-09'])
    // 上限は 1 件ずつの切り上げ（limit=5 → 2 件）
    expect((await db.searchAll('件数テスト', 5)).filter(h => h.kind === 'sale')).toHaveLength(2)
  })

  it('sale の status_label は 送料未入力 → 未紐付け（転売のみ） → 私物 → 完了 の優先順', async () => {
    const s1 = await db.createSale({ title: '送料未入力テスト', sold_at: '2026-01-01', price: 1000 })
    expect((await db.searchAll('送料未入力テスト'))[0].status_label).toBe('送料未入力')

    await db.updateSale(s1, { shipping_fee: 200 })
    expect((await db.searchAll('送料未入力テスト'))[0].status_label).toBe('未紐付け')

    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: '紐付け用在庫', unit_price: 500, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.linkInventory(s1, [item.id])
    expect((await db.searchAll('送料未入力テスト'))[0].status_label).toBe('完了')

    const s2 = await db.createSale({ title: '私物テスト検索', sold_at: '2026-01-02', price: 1000, kind: 'personal' })
    await db.updateSale(s2, { shipping_fee: 100 })
    expect((await db.searchAll('私物テスト検索'))[0].status_label).toBe('私物')
  })

  it('inventory の status_label：出品中/未出品/廃棄/自家消費/販売済/分割済', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
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

    expect((await db.searchAll('ラベル在庫A'))[0].status_label).toBe('出品中')
    expect((await db.searchAll('ラベル在庫B'))[0].status_label).toBe('未出品')
    expect((await db.searchAll('ラベル在庫C'))[0].status_label).toBe('廃棄')
    expect((await db.searchAll('ラベル在庫D'))[0].status_label).toBe('自家消費')
    expect((await db.searchAll('ラベル在庫E'))[0].status_label).toBe('販売済')
    // 分割で生まれた子は親と同名（in_stock）で出るため、親自身のidで引く
    expect((await db.searchAll('ラベル在庫F')).find(h => h.id === f.id)!.status_label).toBe('分割済')
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

    expect((await db.searchAll('リストA'))[0].status_label).toBe('出品中')
    expect((await db.searchAll('リストB'))[0].status_label).toBe('出品停止中')
    expect((await db.searchAll('リストC')).find(h => h.kind === 'listing')!.status_label).toBe('売れた')
    expect((await db.searchAll('リストD'))[0].status_label).toBe('取り下げ')
  })

  it('purchase の status_label：下書き/未着/配送中/到着済', async () => {
    await db.createPurchaseDraft({
      import_key: 'IMP-DRAFT',
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      lines: [{ name: '下書き商品テスト', quantity: 1 }],
    })
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: '未着商品テスト', unit_price: 1000, quantity: 1 }],
    })
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      fulfillment: 'shipped',
      lines: [{ name: '配送中商品テスト', unit_price: 1000, quantity: 1 }],
    })
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      fulfillment: 'delivered',
      lines: [{ name: '到着済商品テスト', unit_price: 1000, quantity: 1 }],
    })

    // 確定済みの仕入は在庫（同名）も一緒にヒットするため、purchase種別だけ見る
    const purchaseHit = async (title: string) =>
      (await db.searchAll(title)).find(h => h.kind === 'purchase')!

    expect((await db.searchAll('下書き商品テスト'))[0].status_label).toBe('下書き')
    expect((await purchaseHit('未着商品テスト')).status_label).toBe('未着')
    expect((await purchaseHit('配送中商品テスト')).status_label).toBe('配送中')
    expect((await purchaseHit('到着済商品テスト')).status_label).toBe('到着済')
  })

  it('並びは 在庫 → 出品 → 販売 → 仕入 の順（種類ごとに新しい順）', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '並び順確認【R100】', unit_price: 1000, quantity: 1 }],
    })
    await db.upsertListings([{ mercariItemId: 'R100', title: '並び順確認【R100】', price: 2000, suspended: false, thumbUrl: null }])
    await db.createSale({ title: '並び順確認【R100】', sold_at: '2026-01-10', price: 2000, kind: 'personal' })

    expect((await db.searchAll('R100')).map(h => h.kind)).toEqual(['inventory', 'listing', 'sale', 'purchase'])
  })

  it('世帯 B の検索に A の在庫・出品・販売・仕入は出ない', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0, order_no: 'A-ONLY-1',
      lines: [{ name: '世帯Aだけの商品【S900】', unit_price: 1000, quantity: 1 }],
    })
    await db.upsertListings([{ mercariItemId: 'SA-only', title: '世帯Aだけの出品【S900】', price: 1, suspended: false, thumbUrl: null }])
    await db.createSale({ title: '世帯Aだけの販売【S900】', sold_at: '2026-01-01', price: 1000 })
    expect((await db.searchAll('S900')).length).toBeGreaterThanOrEqual(4)

    expect(await w.b.run((c) => home.searchAll(c, 'S900'))).toEqual([])
    expect(await w.b.run((c) => home.searchAll(c, 'A-ONLY-1'))).toEqual([])
  })

  it('引数の検査：変な型は UserError（500 にならない）。長すぎる検索語・0 以下の件数も断る', async () => {
    const bad = (fn: (c: Ctx) => Promise<unknown>) => expect(w.a.run(fn)).rejects.toBeInstanceOf(UserError)
    await bad((c) => home.searchAll(c, 123 as never))
    await bad((c) => home.searchAll(c, null as never))
    await bad((c) => home.searchAll(c, 'x'.repeat(501)))
    await bad((c) => home.searchAll(c, 'a', 0))
    await bad((c) => home.searchAll(c, 'a', 1.5))
    await bad((c) => home.searchAll(c, 'a', '10' as never))
    await bad((c) => home.exportCsvRows(c, 'bogus' as never))
    await bad((c) => home.exportCsvRows(c, 'sales', '2026-13'))
    await bad((c) => home.exportRows(c, 'x' as never))
  })

  it('dispatch 経由：searchAll は 200。limit は省略（null）でもよい。変な型は 400', async () => {
    await db.createSale({ title: 'ディスパッチ確認', sold_at: '2026-01-01', price: 1000 })
    const r = await w.a.call('searchAll', 'ディスパッチ')
    expect(r.status).toBe(200)
    expect((r.body.result as Array<{ kind: string }>).map(h => h.kind)).toEqual(['sale'])
    expect((await w.a.call('searchAll', 'ディスパッチ', null)).status).toBe(200)
    expect((await w.a.call('searchAll', 'ディスパッチ', 4)).status).toBe(200)
    expect((await w.a.call('searchAll', '')).body.result).toEqual([])
    expect((await w.a.call('searchAll', 5)).status).toBe(400)
    expect((await w.a.call('searchAll')).status).toBe(400)
    expect((await w.b.call('searchAll', 'ディスパッチ')).body.result).toEqual([])
  })

  it('persona-23：タグで整理して探す。仕入→在庫→販売へのタグの派生・重複除去・絞り込み・カスケード削除', async () => {
    const saleTagId = await db.createTag('セール')
    const scratchTagId = await db.createTag('傷あり')
    // 型番はZ078。全角検索テスト（'ｚ０７８ セール'）用にも使う
    const purchaseId = await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-07-01',
      shipping_fee: 0,
      lines: [{ name: '商品【Z078】', unit_price: 1000, quantity: 3 }],
    })

    // 仕入にタグ「セール」→ その在庫3点のinherited_tagsに「セール」、tagsは空
    await db.setPurchaseTags(purchaseId, [saleTagId])
    let items = (await db.listInventory('in_stock')).filter(i => i.model_code === 'Z078')
    expect(items).toHaveLength(3)
    for (const i of items) {
      expect(i.tags).toEqual([])
      expect(i.inherited_tags.map(t => t.name)).toEqual(['セール'])
    }

    // 1点に直接「傷あり」→ tags=[傷あり], inherited=[セール]
    const [item1, item2, item3] = items
    await db.setInventoryTags(item1.id, [scratchTagId])
    let item1After = (await db.listInventory('in_stock')).find(i => i.id === item1.id)!
    expect(item1After.tags.map(t => t.name)).toEqual(['傷あり'])
    expect(item1After.inherited_tags.map(t => t.name)).toEqual(['セール'])

    // 同じタグ（セール）を直接にも付けたらinheritedから消える（重複なし）
    await db.setInventoryTags(item1.id, [saleTagId, scratchTagId])
    item1After = (await db.listInventory('in_stock')).find(i => i.id === item1.id)!
    expect(item1After.tags.map(t => t.name).sort()).toEqual(['セール', '傷あり'].sort())
    expect(item1After.inherited_tags).toEqual([])

    // 横断検索：この時点でセールは仕入・在庫の両方に見える
    const hitsBeforeSale = await db.searchAll('セール')
    expect(hitsBeforeSale.some(h => h.kind === 'purchase' && h.id === purchaseId)).toBe(true)
    expect(hitsBeforeSale.some(h => h.kind === 'inventory' && h.id === item1.id)).toBe(true)
    const item1Hit = hitsBeforeSale.find(h => h.kind === 'inventory' && h.id === item1.id)!
    expect(item1Hit.status_label).toBe('未出品')

    // 全角・AND：'ｚ０７８ セール' でも同じ在庫がヒットする（NFKC正規化）
    const zenkakuHits = await db.searchAll('ｚ０７８ セール')
    expect(zenkakuHits.some(h => h.kind === 'inventory' && h.id === item1.id)).toBe(true)

    // 空文字は空
    expect(await db.searchAll('')).toEqual([])

    // 売れて紐付いた販売：inherited_tagsにセール・傷あり、tagsは空
    // タイトル自体に「セール」を含めない（検索一致がタグ由来かタイトル由来か紛れないように）
    const saleId = await db.createSale({ title: 'まとめ売りの確認（型番なし。手で紐付ける）', sold_at: '2026-07-10', price: 3000 })
    await db.linkInventory(saleId, [item1.id])
    let sale = (await db.listSales()).find(s => s.id === saleId)!
    expect(sale.tags).toEqual([])
    expect(sale.inherited_tags.map(t => t.name).sort()).toEqual(['セール', '傷あり'].sort())

    // 検索：販売も出る。status_labelは送料未入力（is_shipping_confirmedが既定0のため）
    const hitsWithSale = await db.searchAll('セール')
    const saleHit = hitsWithSale.find(h => h.kind === 'sale' && h.id === saleId)!
    expect(saleHit).toBeTruthy()
    expect(saleHit.status_label).toBe('送料未入力')

    // limit：種類ごとの上限（ceil(limit/4)）を超えない
    const limited = await db.searchAll('セール', 4) // perKind = ceil(4/4) = 1
    const byKind = new Map<string, number>()
    for (const h of limited) byKind.set(h.kind, (byKind.get(h.kind) ?? 0) + 1)
    for (const c of byKind.values()) expect(c).toBeLessThanOrEqual(1)

    // 販売に直接「まとめ売り」→ tags=[まとめ売り]。inheritedは変わらず
    const bundleTagId = await db.createTag('まとめ売り')
    await db.setSaleTags(saleId, [bundleTagId])
    sale = (await db.listSales()).find(s => s.id === saleId)!
    expect(sale.tags.map(t => t.name)).toEqual(['まとめ売り'])
    expect(sale.inherited_tags.map(t => t.name).sort()).toEqual(['セール', '傷あり'].sort())

    // listSales({tagId: セール}) に出る（派生でも絞れる）
    const bySaleTag = await db.listSales({ tagId: saleTagId })
    expect(bySaleTag.some(s => s.id === saleId)).toBe(true)

    // unlinkInventory → 販売のinheritedは空
    await db.unlinkInventory(saleId, item1.id)
    sale = (await db.listSales()).find(s => s.id === saleId)!
    expect(sale.inherited_tags).toEqual([])
    expect((await db.listSales({ tagId: saleTagId })).some(s => s.id === saleId)).toBe(false)

    // 仕入からタグを外す → 在庫（item2, item3）からも消える
    await db.setPurchaseTags(purchaseId, [])
    items = (await db.listInventory('in_stock')).filter(i => i.model_code === 'Z078')
    const item2After = items.find(i => i.id === item2.id)!
    const item3After = items.find(i => i.id === item3.id)!
    expect(item2After.inherited_tags).toEqual([])
    expect(item3After.inherited_tags).toEqual([])

    // unlinkInventory で在庫は in_stock に戻る（trg_sline_unsold）。直接タグ（セール・傷あり）は残る
    item1After = (await db.listInventory('in_stock')).find(i => i.id === item1.id)!
    expect(item1After.status).toBe('in_stock')
    expect(item1After.tags.map(t => t.name).sort()).toEqual(['セール', '傷あり'].sort())

    // deleteTag → 全部から消える（item1の直接タグからも）
    await db.deleteTag(saleTagId)
    expect((await db.listTags()).some(t => t.id === saleTagId)).toBe(false)
    item1After = (await db.listInventory('in_stock')).find(i => i.id === item1.id)!
    expect(item1After.tags.map(t => t.name)).toEqual(['傷あり'])
    expect(await db.searchAll('セール')).toEqual([])
  })
})

// ============================================================
// CSV 書き出し
// ============================================================

describe('exportCsvRows：CSV書き出し（金額は円の整数のまま。サーバーで組み立て、レンダラーで再計算しない）', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('0件は空文字（保存ダイアログを出さない判定に使う）', async () => {
    expect(await db.exportCsvRows('sales')).toBe('')
    expect(await db.exportCsvRows('purchases')).toBe('')
    expect(await db.exportCsvRows('expenses')).toBe('')
    expect(await db.exportCsvRows('inventory')).toBe('')
    // 省略は販売
    expect(await db.exportCsvRows()).toBe('')
  })

  it('sales：見出しと1行目の列数が一致し、monthでsold_at（計上日）を絞れる。金額はカンマ区切りにならない整数', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '商品A', unit_price: 1000, quantity: 2 }],
    })
    const [item1, item2] = await db.listInventory('in_stock')
    const sale1 = await db.createSale({ title: '商品A', sold_at: '2026-01-05', price: 123456 })
    await db.linkInventory(sale1, [item1.id])
    const sale2 = await db.createSale({ title: '商品A', sold_at: '2026-02-05', price: 20000 })
    await db.linkInventory(sale2, [item2.id])

    const all = parseCsv(await db.exportCsvRows('sales'))
    expect(all.rows).toHaveLength(2)
    expect(all.rows[0]).toHaveLength(all.headers.length)
    expect(all.headers).toEqual([
      '販売日', '集計区分', '商品名', '区分', '取得元', '販売価格', '販売手数料', '送料', '送料区分',
      '梱包材', '原価', '粗利', '紐付け点数', '型番', 'タグ', '取引ID',
    ])

    const jan = parseCsv(await db.exportCsvRows('sales', '2026-01'))
    expect(jan.rows).toHaveLength(1)
    const priceIdx = jan.headers.indexOf('販売価格')
    expect(jan.rows[0][priceIdx]).toBe('123456')
    expect(jan.rows[0][priceIdx]).not.toContain(',')
    // 月末の境目：1/31 の販売は 1 月、2/1 の販売は 2 月（月の範囲は monthBounds）
    await db.createSale({ title: '月末', sold_at: '2026-01-31', price: 100 })
    await db.createSale({ title: '月初', sold_at: '2026-02-01', price: 200 })
    expect(parseCsv(await db.exportCsvRows('sales', '2026-01')).rows).toHaveLength(2)
    expect(parseCsv(await db.exportCsvRows('sales', '2026-02')).rows).toHaveLength(2)
  })

  it('sales：区分の列は SALE_KIND_LABEL の言葉（販売／私物）で出る。DB の値（resale）や「転売」は出ない', async () => {
    await db.createSale({ title: '販売の品', sold_at: '2026-01-05', price: 1000, kind: 'resale' })
    await db.createSale({ title: '私物の品', sold_at: '2026-01-06', price: 500, kind: 'personal' })

    const csv = await db.exportCsvRows('sales')
    const parsed = parseCsv(csv)
    const kindIdx = parsed.headers.indexOf('区分')
    const byTitle = new Map(parsed.rows.map(r => [r[parsed.headers.indexOf('商品名')], r[kindIdx]]))
    expect(byTitle.get('販売の品')).toBe(SALE_KIND_LABEL.resale)
    expect(byTitle.get('販売の品')).toBe('販売')
    expect(byTitle.get('私物の品')).toBe(SALE_KIND_LABEL.personal)
    expect(csv).not.toContain('転売')

    // month を渡してもバインドの順序が崩れない
    const jan = parseCsv(await db.exportCsvRows('sales', '2026-01'))
    expect(jan.rows.map(r => r[kindIdx]).sort()).toEqual(['私物', '販売'])
  })

  it('sales：実績／見込みの区分・取得元・送料区分・型番（| 区切り）・タグ（| 区切り）・取引ID・金額が販売の一覧と一致する', async () => {
    const tagA = await db.createTag('A')
    const tagB = await db.createTag('B')
    const done = await db.createSale({ title: '実績の販売', sold_at: '2026-03-01', price: 3000 })
    await db.applySaleActuals(done, { status: 'completed' })
    await db.updateSale(done, { shipping_fee: 300 })
    await db.setSaleTags(done, [tagB, tagA])
    await db.sqlRun(`update sale set model_codes = ?::text[] where id = ?`, ['A001', 'A002'], done)
    const [pending] = await db.insertCollected([{ mercariItemId: 'm-csv-1', title: '見込みの販売', price: 2000, soldAt: '2026-03-02' }])

    const parsed = parseCsv(await db.exportCsvRows('sales', '2026-03'))
    const col = (row: string[], name: string) => row[parsed.headers.indexOf(name)]
    const doneRow = parsed.rows.find(r => col(r, '商品名') === '実績の販売')!
    const pendingRow = parsed.rows.find(r => col(r, '商品名') === '見込みの販売')!
    const sales = await db.listSales()
    const doneSale = sales.find(s => s.id === done)!

    expect(col(doneRow, '集計区分')).toBe('実績')
    expect(col(doneRow, '取得元')).toBe('手入力')
    expect(col(doneRow, '送料区分')).toBe('manual')
    expect(col(doneRow, '型番')).toBe('A001|A002')
    expect(col(doneRow, 'タグ')).toBe('A|B') // タグの並び（sort_order → 名前）で毎回同じ
    expect(Number(col(doneRow, '販売価格'))).toBe(doneSale.price)
    expect(Number(col(doneRow, '販売手数料'))).toBe(doneSale.fee)
    expect(Number(col(doneRow, '送料'))).toBe(300)
    expect(Number(col(doneRow, '原価'))).toBe(doneSale.cost)
    expect(Number(col(doneRow, '粗利'))).toBe(doneSale.gross_profit)
    expect(Number(col(doneRow, '粗利'))).toBe(3000 - 300 - 300) // 価格 − 手数料 − 送料（原価 0）

    expect(col(pendingRow, '集計区分')).toBe('見込み')
    expect(col(pendingRow, '取得元')).toBe('自動取得')
    expect(col(pendingRow, '取引ID')).toBe('m-csv-1')
    expect(pending.id).toBeTruthy()
  })

  it('recognition：状態未設定の手入力は実績、取得分の状態不明は見込み。CSV の集計区分に出る', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-06-01',
      lines: [{ name: '商品【A037】', unit_price: 500, quantity: 2 }],
    })
    await db.createSale({ title: '商品【A037】', sold_at: '2026-06-01', price: 1000 })
    await db.insertCollected([{ mercariItemId: 'unknown', title: '商品【A037】', soldAt: '2026-06-01', price: 2000 }])
    const csv = await db.exportRows()
    expect(csv).toContain('実績')
    expect(csv).toContain('見込み')
  })

  it('purchases：1行=仕入の1明細。見出しと列数が一致し、monthでordered_at（注文日）を絞れる', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-10', shipping_fee: 100,
      lines: [{ name: '仕入品A【Q001】', unit_price: 1000, quantity: 1 }],
    })
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-02-10', shipping_fee: 50,
      lines: [{ name: '仕入品B【Q002】', unit_price: 2000, quantity: 1 }],
    })

    const all = parseCsv(await db.exportCsvRows('purchases'))
    expect(all.rows).toHaveLength(2)
    expect(all.rows[0]).toHaveLength(all.headers.length)
    expect(all.headers).toEqual([
      '注文日', '仕入先', '注文番号', '状態', '商品名', '型番', '数量', '単価',
      '按分後原価', '注文の送料', '注文のその他費用', '注文の割引', 'メモ',
    ])

    const jan = parseCsv(await db.exportCsvRows('purchases', '2026-01'))
    expect(jan.rows).toHaveLength(1)
    expect(jan.rows[0][jan.headers.indexOf('商品名')]).toBe('仕入品A【Q001】')
    expect(jan.rows[0][jan.headers.indexOf('型番')]).toBe('Q001')
    expect(jan.rows[0][jan.headers.indexOf('状態')]).toBe('確定')
  })

  it('expenses：1行=経費の1明細。monthは計上月（occurred_atではない）で絞る。明細の無い経費も落とさない（exportExpenseRows への経路）', async () => {
    // 12月末に買ったが計上月は1月（月をまたぐケース）。明細なし＝合計だけ入力
    await db.createExpense({ occurred_at: '2025-12-30', month: '2026-01', category: 'packaging', amount: 700 })
    await db.createExpense({ occurred_at: '2026-02-01', category: 'other', amount: 300 })

    const all = parseCsv(await db.exportCsvRows('expenses'))
    expect(all.rows).toHaveLength(2)
    expect(all.rows[0]).toHaveLength(all.headers.length)
    expect(all.headers).toEqual([
      '計上月', '購入日', '購入店', '登録番号', '項目', '品名', '単価', '数量', '金額', 'メモ',
    ])

    const jan = parseCsv(await db.exportCsvRows('expenses', '2026-01'))
    expect(jan.rows).toHaveLength(1)
    expect(jan.rows[0][jan.headers.indexOf('購入日')]).toBe('2025-12-30')
    expect(jan.rows[0][jan.headers.indexOf('金額')]).toBe('700')
    expect(jan.rows[0][jan.headers.indexOf('項目')]).toBe('梱包費')
  })

  it('expenses：registration_noを保存した経費はCSVの登録番号列に出る。無い経費は空文字', async () => {
    await db.createExpense({
      occurred_at: '2026-03-01', category: 'supplies', amount: 300,
      shop: 'セリア 小倉貫店', receipt_registration_no: 'T4200001013662',
    })
    await db.createExpense({ occurred_at: '2026-03-02', category: 'other', amount: 100 })

    const rows = parseCsv(await db.exportCsvRows('expenses', '2026-03'))
    const regIdx = rows.headers.indexOf('登録番号')
    const values = rows.rows.map(r => r[regIdx]).sort()
    expect(values).toEqual(['', 'T4200001013662'])
  })

  it('inventory：monthを渡しても全件（在庫は「今」の姿なので月で切らない）', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '在庫品【R001】', unit_price: 1000, quantity: 2 }],
    })

    const withoutMonth = parseCsv(await db.exportCsvRows('inventory'))
    expect(withoutMonth.rows).toHaveLength(2)
    expect(withoutMonth.rows[0]).toHaveLength(withoutMonth.headers.length)
    expect(withoutMonth.headers).toEqual([
      '在庫コード', '商品名', '型番', '素材', '状態', '仕入先', '注文番号', '仕入日',
      '滞留日数', '按分後原価', '出品価格', '販売日', '販売価格', '1点あたりの粗利',
    ])

    const withMonth = parseCsv(await db.exportCsvRows('inventory', '2099-01'))
    expect(withMonth.rows).toHaveLength(2)
  })

  it('値にカンマを含む商品名は"で囲まれる', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '商品,カンマ入り', unit_price: 1000, quantity: 1 }],
    })
    const [item] = await db.listInventory('in_stock')
    const saleId = await db.createSale({ title: '商品,カンマ入り', sold_at: '2026-01-05', price: 2000 })
    await db.linkInventory(saleId, [item.id])

    const csv = await db.exportCsvRows('sales')
    expect(csv).toContain('"商品,カンマ入り"')
    const parsed = parseCsv(csv)
    expect(parsed.rows[0][parsed.headers.indexOf('商品名')]).toBe('商品,カンマ入り')
  })

  it('世帯 B の CSV に A の行は出ない', async () => {
    await db.createSale({ title: 'Aの販売', sold_at: '2026-01-05', price: 1000 })
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'Aの仕入', unit_price: 1000, quantity: 1 }],
    })
    await db.createExpense({ occurred_at: '2026-01-02', category: 'other', amount: 100 })
    for (const kind of ['sales', 'purchases', 'expenses', 'inventory'] as const) {
      expect(await db.exportCsvRows(kind)).not.toBe('')
      expect(await w.b.run((c) => home.exportCsvRows(c, kind))).toBe('')
    }
  })

  it('exportCsv（API）：戻り値は CSV の中身そのもの（先頭に BOM）。対象が 0 件なら null。kind を省略すると販売', async () => {
    expect((await w.a.call('exportCsv')).body.result).toBeNull()
    expect((await w.a.call('exportCsv', 'sales', '2026-01')).body.result).toBeNull()

    await db.createSale({ title: 'CSVの販売', sold_at: '2026-01-05', price: 4321 })
    const r = await w.a.call('exportCsv', 'sales', '2026-01')
    expect(r.status).toBe(200)
    const csv = r.body.result as string
    expect(csv.startsWith('﻿')).toBe(true)
    expect(parseCsv(csv).rows[0][parseCsv(csv).headers.indexOf('販売価格')]).toBe('4321')

    // 省略（null で届く）は販売。月が違えば 0 件で null
    expect((await w.a.call('exportCsv', null, null)).body.result).toBe(csv)
    expect((await w.a.call('exportCsv', 'sales', '2026-02')).body.result).toBeNull()
    expect((await w.a.call('exportCsv', 'purchases')).body.result).toBeNull()
    expect((await w.b.call('exportCsv', 'sales')).body.result).toBeNull()

    // 変な引数は 400
    expect((await w.a.call('exportCsv', 'bogus')).status).toBe(400)
    expect((await w.a.call('exportCsv', 'sales', '2026-13')).status).toBe(400)
    expect((await w.a.call('exportCsv', 5)).status).toBe(400)
  })
})

// ============================================================
// シナリオ（persona）：同じデータを複数の集計から見て、数字が全部一致する
// ============================================================

describe('シナリオ：ホームの数字', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイ', 'mellojoy')
  })

  it('persona-01：仕入3点(金額按分)→在庫原価一致→取り込み1件→自動紐付け→粗利一致→ホームが月次と同じ数字を出す', async () => {
    const today = todayJst()

    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: today,
      shipping_fee: 499,
      lines: [
        { name: '【Z001-1】ムースクリームわん', unit_price: 2499, quantity: 1 },
        { name: '【Z002-1】ねっとりヨーグルトにゃん', unit_price: 2399, quantity: 1 },
        { name: '【Z003-1】もちもちもちうさぎ', unit_price: 2699, quantity: 1 },
      ],
    })

    const items = await db.listInventory('in_stock')
    expect(items).toHaveLength(3)

    // 合計 = 7,597（単価合計） + 499（送料） = 8,096
    const totalLanded = items.reduce((s, i) => s + i.landed_cost, 0)
    expect(totalLanded).toBe(7597 + 499)

    // 手計算：金額按分。trunc(499*unit/7597)（0方向への切り捨て）、端数は最終行(Z003-1)へ寄せる
    const byModel = Object.fromEntries(items.map(i => [i.model_code, i.landed_cost]))
    expect(byModel['Z001-1']).toBe(2499 + 164) // trunc(499*2499/7597) = trunc(164.14) = 164
    expect(byModel['Z002-1']).toBe(2399 + 157) // trunc(499*2399/7597) = trunc(157.58) = 157
    expect(byModel['Z003-1']).toBe(2699 + 178) // 残り 499-164-157=178

    // メルカリ取り込み：型番付き・送料実額
    const collected = await db.insertCollected([{
      mercariItemId: 'm-persona01-1',
      status: 'completed',
      title: '【Z001-1】ムースクリームわん',
      price: 8999,
      soldAt: today,
      fee: 899,
      shippingFee: 215,
    }])
    const saleId = collected[0].id

    // 自動紐付けされている
    const sale = (await db.listSales()).find(s => s.id === saleId)!
    expect(sale.unmatched).toBe(0)
    expect(sale.auto_linked).toBe(1)
    expect(sale.cost).toBe(2663) // Z001-1の原価
    expect(sale.item_count).toBe(1)

    // 粗利 = 8999 - 899 - 215 - 0(梱包材) - 2663 = 5222
    expect(sale.gross_profit).toBe(5222)

    // 未処理から消える（送料確定・紐付け済み）
    expect((await db.listSales({ onlyPending: true })).some(s => s.id === saleId)).toBe(false)
    const dash = await db.getDashboard()
    expect(dash.needsMatch).toBe(0)
    expect(dash.needsShipping).toBe(0)

    // 月次
    const month = today.slice(0, 7)
    const monthlyRow = (await db.listMonthly()).find(m => m.month === month && m.kind === 'resale')!
    expect(monthlyRow.revenue).toBe(8999)
    expect(monthlyRow.total_fee).toBe(899)
    expect(monthlyRow.total_shipping).toBe(215)
    expect(monthlyRow.total_cost).toBe(2663)
    expect(monthlyRow.gross_profit).toBe(5222)

    // ダッシュボード（今月）は月次と同じ数字
    expect(dash.thisMonth).not.toBeNull()
    expect(dash.thisMonth!.gross_profit).toBe(5222)
    expect(dash.thisMonth!.revenue).toBe(8999)
    expect(dash.thisMonth).toEqual(monthlyRow)

    // 売れた 1 点が在庫から減り、残りの原価がそのまま「寝ている資金」になる
    expect(dash.stockCount).toBe(2)
    expect(dash.stockValue).toBe(totalLanded - 2663)
  })

  it('persona-18：ダッシュボード・variant・product・monthly・CSVの数字が全部一致する', async () => {
    const today = todayJst()
    // 仕入：X001-1を2点、送料200円を金額按分（1行のみなので端数なく100/100）
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: today,
      shipping_fee: 200,
      lines: [{ name: 'ぬいぐるみ【X001-1】', unit_price: 1000, quantity: 2 }],
    })
    const items = (await db.listInventory('in_stock')).filter(i => i.model_code === 'X001-1')
    expect(items).toHaveLength(2)
    expect(items[0].landed_cost).toBe(1100)
    expect(items[1].landed_cost).toBe(1100)

    // 販売：1点を型番完全一致で自動紐付け、送料300円を確定
    const saleId = await createCompletedSale({ title: 'ぬいぐるみ【X001-1】美品', price: 3000, sold_at: today })
    await db.updateSale(saleId, { shipping_fee: 300 })
    // fee=300, profit = 3000-300-300-1100 = 1300
    const sale = (await db.listSales()).find(s => s.id === saleId)!
    expect(sale.item_count).toBe(1)
    expect(sale.cost).toBe(1100)
    expect(sale.gross_profit).toBe(1300)
    expect(sale.auto_linked).toBe(1)

    // 残り1点は在庫のまま
    const remaining = (await db.listInventory('in_stock')).filter(i => i.model_code === 'X001-1')
    expect(remaining).toHaveLength(1)
    const remainingCost = remaining[0].landed_cost

    // ---- 突き合わせ ----

    // 1) getDashboard
    const dash = await db.getDashboard()
    expect(dash.needsShipping).toBe(0)
    expect(dash.needsMatch).toBe(0)
    expect(dash.needsPurchaseConfirm).toBe(0)
    expect(dash.stockCount).toBe(1)
    // 在庫金額 = in_stock の landed_cost 合計
    const stockValueByHand = (await db.listInventory('in_stock')).reduce((s, i) => s + i.landed_cost, 0)
    expect(dash.stockValue).toBe(stockValueByHand)
    expect(dash.stockValue).toBe(remainingCost)
    expect(dash.thisMonth).toMatchObject({
      month: thisMonthJst(), kind: 'resale',
      sales_count: 1, revenue: 3000, total_fee: 300, total_shipping: 300,
      total_cost: 1100, gross_profit: 1300,
    })

    // 2) listVariantSummary
    const variant = (await A((c) => product.listVariantSummary(c))).find(v => v.model_code === 'X001-1')!
    expect(variant.purchased).toBe(2)
    expect(variant.sold).toBe(1)
    expect(variant.in_stock).toBe(1)
    expect(variant.stock_value).toBe(remainingCost)
    expect(variant.total_profit).toBe(1300)

    // 3) listProducts
    const prod = (await A((c) => product.listProducts(c))).find(p => p.model_code === 'X001-1')!
    expect(prod.purchase_total).toBe(1100 + 1100)
    expect(prod.avg_cost).toBe(1100)
    expect(prod.total_profit).toBe(1300)
    expect(prod.stock_value).toBe(remainingCost)

    // 4) getProduct().months：今月だけの1点
    const detail = (await A((c) => product.getProduct(c, 'X001-1')))!
    const thisMonthPoint = detail.months.find(m => m.month === thisMonthJst())!
    expect(thisMonthPoint).toMatchObject({
      purchased: 2, sold: 1, in_stock: 1,
      purchase_amount: 2200, sales_amount: 3000, profit: 1300,
    })
    // months の profit 合計 = gross_profit 合計
    const monthsProfitSum = detail.months.reduce((s, m) => s + m.profit, 0)
    expect(monthsProfitSum).toBe(1300)

    // 5) listMonthly
    const monthlyRow = (await db.listMonthly()).find(m => m.month === thisMonthJst() && m.kind === 'resale')!
    expect(monthlyRow.gross_profit).toBe(1300)
    expect(monthlyRow.total_cost).toBe(1100)

    // 6) saleTotals：粗利合計 = 各販売のgross_profit合計（今は1件）
    const totals = await db.saleTotals()
    const profitSumByHand = (await db.listSales()).reduce((s, x) => s + x.gross_profit, 0)
    expect(totals.gross_profit).toBe(profitSumByHand)
    expect(totals.gross_profit).toBe(1300)

    // 7) exportRows（CSV）：行数 = 販売数
    const csv = parseCsv(await db.exportRows())
    expect(csv.rows).toHaveLength((await db.listSales()).length)
    expect(csv.rows).toHaveLength(1)
    const cell = (name: string) => csv.rows[0][csv.headers.indexOf(name)]
    expect(Number(cell('粗利'))).toBe(1300)
    expect(Number(cell('原価'))).toBe(1100)
    expect(cell('型番')).toBe('X001-1')
  })

  it('persona-21：出品に引き当てても在庫数・在庫金額は変わらず、売れると引き当てた 1 点ぶんだけ減る。履歴は listed → sold の順', async () => {
    const title = '【L001】ぬいぐるみ'
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-01',
      shipping_fee: 100,
      lines: [{ name: title, unit_price: 1000, quantity: 3 }],
    })
    const items = (await db.listInventory('in_stock')).filter(i => i.model_code === 'L001')
    expect(items.map(i => i.landed_cost).sort((a, b) => a - b)).toEqual([1033, 1033, 1034])
    expect(items.reduce((s, i) => s + i.landed_cost, 0)).toBe(3100) // 1000*3+100 と一致

    await db.upsertListings([{ mercariItemId: 'LST1', title, price: 2500, suspended: false, thumbUrl: null }])
    const [first] = items
    await db.reserveInventory('LST1', [first.id])

    // 在庫数・在庫金額は出品しても変わらない
    const dashBefore = await db.getDashboard()
    expect(dashBefore.stockCount).toBe(3)
    expect(dashBefore.stockValue).toBe(3100)
    // 出品中で在庫が引き当て済みなので「未引き当ての出品」には数えない
    expect(dashBefore.needsListingAllocation).toBe(0)

    // 同じ mercari_item_id で販売が来る → 引き当てをそのまま引き継ぐ
    const [inserted] = await db.insertCollected([{ mercariItemId: 'LST1', title, price: 2500, soldAt: todayJst() }])
    const sale = (await db.listSales()).find(s => s.id === inserted.id)!
    expect(sale.unmatched).toBe(0)
    expect(sale.cost).toBe(first.landed_cost)

    // 在庫数は減る（1点が sold に）。残り2点はそのまま
    const dashAfter = await db.getDashboard()
    expect(dashAfter.stockCount).toBe(2)
    expect(dashAfter.stockValue).toBe(3100 - first.landed_cost)

    // 履歴：listed → sold の順
    const timeline = (await A((c) => product.getItemTimeline(c, first.id)))!
    const kinds = timeline.events.map(e => e.kind)
    expect(kinds.indexOf('listed')).toBeGreaterThanOrEqual(0)
    expect(kinds.indexOf('sold')).toBeGreaterThan(kinds.indexOf('listed'))
  })

  it('persona-22：引き当て中の在庫を廃棄すると、出品は未引き当てに戻り、在庫金額から消える', async () => {
    const make = async (code: string, orderedAt: string) => {
      const before = new Set((await db.listInventory('in_stock')).map(i => i.id))
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: orderedAt, shipping_fee: 0,
        lines: [{ name: `商品【${code}】`, unit_price: 1000, quantity: 1 }],
      })
      return (await db.listInventory('in_stock')).find(i => i.model_code === code && !before.has(i.id))!
    }
    const x = await make('M101', '2026-06-01')
    await make('M102', '2026-06-02')
    await db.upsertListings([{ mercariItemId: 'C', title: '商品【M101】', price: 2200, suspended: false, thumbUrl: null }])
    await db.reserveInventory('C', [x.id])
    expect((await db.getDashboard()).needsListingAllocation).toBe(0)

    const stockValueBefore = (await db.getDashboard()).stockValue
    await db.disposeInventory(x.id, '出し直しをやめた', 'disposed')
    const dash = await db.getDashboard()
    expect(dash.stockValue).toBe(stockValueBefore - x.landed_cost)
    expect(dash.stockCount).toBe(1)
    // 引き当てが外れて、出品は「未引き当て」に戻る（ホームの要対応に出る）
    expect(dash.needsListingAllocation).toBe(1)
  })
})
