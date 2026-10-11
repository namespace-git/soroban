import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import * as monthly from '../../domain/monthly'
import { thisMonthJst, todayJst } from '../../domain/_shared'
import type { AllocMethod, ExpenseInput, SaleInput } from '../../../src/shared/types'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'
import { bindDb } from './core-helpers'

// src/main/__tests__/db.test.ts の db（:memory:）の中の、月次・経費・月の締めのテストを移したもの。
// 期待値は変えていない。書き換えたのは「呼び方」だけ：
//   * 同期の db.xxx(...) → await db.xxx(...)（db は下の薄い包み。1 回の呼び出し＝1 リクエスト＝1 トランザクション）
//   * expect(() => …).toThrow() → await expect(…).rejects.toThrow()
//   * 偽の時計はローカル時刻（new Date(2026, 9, 3, 12, 0)）ではなく UTC の瞬間で置く。サーバー（Workers）は UTC なので、
//     日本時間（+9 時間）の月・日は UTC の 15:00〜23:59 で翌日・翌月になる（TZ=UTC で回すテストがこれを見張る）
//   * createCompletedSale は createSale → applySaleActuals({ status: 'completed' })（src/main/__tests__/completed-sale.ts と同じ）
//   * getDb().prepare(…) の直接 SQL は db.sql（Postgres の名前）に読み替えた
// 移した元：
//   db.test.ts   期間費用（経費の明細・計上月…）／listMonthly：今月の行は販売が 0 件でも必ず返る／
//                getMonthDetail：価格0の月でも…数量按分にフォールバックする／getMonthDetail：expense_by_categoryは明細ごとの項目で集計する／
//                exportCsvRows の経費の分（expenses の 2 本）
//   views.test.ts  月次の計算書（getMonthDetail 側の数字：粗利・純利益・タグ別の合計）
//   recognition.test.ts  取引完了だけ実績・未完了は見込み（listMonthly / getMonthDetail の分）
// 移していないもの：
//   * db.test.ts: shop_alias の直接テスト（purchase.test.ts にある）、getDashboard().thisMonth（ホームの担当）、
//     migrate の 2 本（SQLite の移行の話）
//   * views.test.ts / recognition.test.ts の getMonthStatement・getInbox・listProducts・getProduct・exportRows の期待
//     （それぞれ受信箱・ビュー、商品、ホームの担当）

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const A = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)
const core = bindDb(() => w.a)

/** 元のテストの `db.` と同じ形で呼べる、世帯 A の薄い包み */
const db = {
  ...core,
  listMonthly: () => A((c) => monthly.listMonthly(c)),
  listExpenses: (month?: string) => A((c) => monthly.listExpenses(c, month)),
  createExpense: (i: ExpenseInput) => A((c) => monthly.createExpense(c, i)),
  updateExpense: (id: string, i: ExpenseInput) => A((c) => monthly.updateExpense(c, id, i)),
  deleteExpense: (id: string) => A((c) => monthly.deleteExpense(c, id)),
  getMonthDetail: (month: string, opts?: { tagId?: string | null }) => A((c) => monthly.getMonthDetail(c, month, opts)),
  setMonthAllocMethod: (month: string, method: AllocMethod) => A((c) => monthly.setMonthAllocMethod(c, month, method)),
  closeMonth: (month: string) => A((c) => monthly.closeMonth(c, month)),
  reopenMonth: (month: string) => A((c) => monthly.reopenMonth(c, month)),
  exportExpenseRows: (month?: string) => A((c) => monthly.exportExpenseRows(c, month)),
  lookupShopAlias: (no: string) => A(async (c) => (await c.sql.get<{ shop: string }>(
    'select shop from shop_alias where key = ?', `reg:${no}`))?.shop ?? null),
}

/** 集計テスト用：取引完了を明示した販売を作る。状態未設定の仕様とは分ける */
async function createCompletedSale(input: SaleInput): Promise<string> {
  const id = await db.createSale(input)
  await db.applySaleActuals(id, { status: 'completed' })
  return id
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

describe('月次・経費（monthly）', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('期間費用（経費の明細・計上月・振込手数料の自動計上は撤去）', () => {
    it('createExpense：明細があれば合計・代表項目を明細から導く。明細が無ければinput.amount/categoryをそのまま使う', async () => {
      const id = await db.createExpense({
        occurred_at: '2026-01-10',
        category: 'packaging',
        lines: [
          { name: '緩衝材', unit_price: 300, quantity: 1 },
          { name: 'OPP袋', unit_price: 100, quantity: 2, category: 'supplies' },
        ],
      })
      const expense = (await db.listExpenses('2026-01')).find(e => e.id === id)!
      expect(expense.amount).toBe(500) // 300+200の合計
      expect(expense.category).toBe('packaging') // 最初の明細の項目
      expect(expense.lines).toHaveLength(2)
      expect(expense.lines[0]).toMatchObject(
        { name: '緩衝材', unit_price: 300, quantity: 1, amount: 300, category: 'packaging' },
      )
      expect(expense.lines[1]).toMatchObject(
        { name: 'OPP袋', unit_price: 100, quantity: 2, amount: 200, category: 'supplies' },
      )

      // 明細が無い経費はinput.amount/categoryのまま
      const id2 = await db.createExpense({ occurred_at: '2026-01-15', category: 'other', amount: 700 })
      const expense2 = (await db.listExpenses('2026-01')).find(e => e.id === id2)!
      expect(expense2.amount).toBe(700)
      expect(expense2.category).toBe('other')
      expect(expense2.lines).toHaveLength(0)
    })

    it('createExpense：明細の金額は単価×数量で計算される（数量省略は1）', async () => {
      const id = await db.createExpense({
        occurred_at: '2026-01-20',
        category: 'packaging',
        lines: [
          { name: '袋', unit_price: 300, quantity: 4 },
          { name: '箱', unit_price: 150 },
        ],
      })
      const expense = (await db.listExpenses('2026-01')).find(e => e.id === id)!
      expect(expense.lines[0]).toMatchObject({ name: '袋', unit_price: 300, quantity: 4, amount: 1200 })
      expect(expense.lines[1]).toMatchObject({ name: '箱', unit_price: 150, quantity: 1, amount: 150 })
      expect(expense.amount).toBe(1350) // 1200 + 150

      // updateで数量を変えると再計算される
      await db.updateExpense(id, {
        occurred_at: '2026-01-20',
        category: 'packaging',
        lines: [
          { name: '袋', unit_price: 300, quantity: 2 },
          { name: '箱', unit_price: 150 },
        ],
      })
      const updated = (await db.listExpenses('2026-01')).find(e => e.id === id)!
      expect(updated.lines[0]).toMatchObject({ name: '袋', unit_price: 300, quantity: 2, amount: 600 })
      expect(updated.amount).toBe(750) // 600 + 150
    })

    it('計上月：省略時はoccurred_atの月。指定すればそちらで集計される（listExpenses(month)）', async () => {
      // 12月末に買ったが、経理上は翌1月扱いにしたい
      const id = await db.createExpense({
        occurred_at: '2025-12-30', month: '2026-01', category: 'supplies', amount: 400,
      })
      expect(await db.listExpenses('2025-12')).toHaveLength(0)
      const jan = await db.listExpenses('2026-01')
      expect(jan.find(e => e.id === id)).toBeDefined()
      expect(jan.find(e => e.id === id)!.month).toBe('2026-01')
      expect(jan.find(e => e.id === id)!.occurred_at).toBe('2025-12-30')

      // 省略時はoccurred_atの月
      const id2 = await db.createExpense({ occurred_at: '2026-02-05', category: 'other', amount: 100 })
      expect((await db.listExpenses('2026-02')).find(e => e.id === id2)!.month).toBe('2026-02')

      // month省略で全部
      expect((await db.listExpenses()).map(e => e.id)).toEqual(expect.arrayContaining([id, id2]))
    })

    it('updateExpense：明細を丸ごと入れ替える', async () => {
      const id = await db.createExpense({
        occurred_at: '2026-03-01', category: 'packaging',
        lines: [{ name: '箱', unit_price: 500 }],
      })
      await db.updateExpense(id, {
        occurred_at: '2026-03-01', category: 'shipping',
        lines: [{ name: '切手', unit_price: 100 }, { name: '梱包テープ', unit_price: 200 }],
      })
      const updated = (await db.listExpenses('2026-03')).find(e => e.id === id)!
      expect(updated.amount).toBe(300)
      expect(updated.category).toBe('shipping')
      expect(updated.lines.map(l => l.name)).toEqual(['切手', '梱包テープ'])
    })

    it('createExpense：不正な費用区分・金額未指定はthrow', async () => {
      await expect(db.createExpense(
        { occurred_at: '2026-01-01', category: 'invalid' as never, amount: 100 },
      )).rejects.toThrow()
      // 明細も無くamountも無い
      await expect(db.createExpense({ occurred_at: '2026-01-01', category: 'other' })).rejects.toThrow('金額を入れてください')
    })

    it('createExpense：明細の単価が負・数量が0以下はthrow', async () => {
      await expect(db.createExpense({
        occurred_at: '2026-01-01', category: 'packaging',
        lines: [{ name: '袋', unit_price: -1 }],
      })).rejects.toThrow()
      await expect(db.createExpense({
        occurred_at: '2026-01-01', category: 'packaging',
        lines: [{ name: '袋', unit_price: 100, quantity: 0 }],
      })).rejects.toThrow()
      expect(await db.listExpenses()).toHaveLength(0)
    })

    it('createExpense：receipt_registration_no と shop を渡すと店名を学習し、lookupShopAlias で返る', async () => {
      await db.createExpense({
        occurred_at: '2026-04-01',
        category: 'supplies',
        amount: 300,
        shop: 'セリア 小倉貫店',
        receipt_registration_no: 'T4200001013662',
      })
      expect(await db.lookupShopAlias('T4200001013662')).toBe('セリア 小倉貫店')
    })

    it('createExpense：receipt_registration_noを渡すとexpense.registration_noに保存され、listExpensesで返る', async () => {
      const id = await db.createExpense({
        occurred_at: '2026-04-01',
        category: 'supplies',
        amount: 300,
        shop: 'セリア 小倉貫店',
        receipt_registration_no: 'T4200001013662',
      })
      expect((await db.listExpenses('2026-04')).find(e => e.id === id)!.registration_no).toBe('T4200001013662')
    })

    it('createExpense：receipt_registration_noが空文字ならnullで保存される', async () => {
      const id = await db.createExpense({
        occurred_at: '2026-04-01', category: 'supplies', amount: 300, receipt_registration_no: '',
      })
      expect((await db.listExpenses('2026-04')).find(e => e.id === id)!.registration_no).toBeNull()
    })

    it('updateExpense：receipt_registration_noを省略すると今の値を消さない。nullを渡すと消える', async () => {
      const id = await db.createExpense({
        occurred_at: '2026-04-01', category: 'supplies', amount: 300, receipt_registration_no: 'T4200001013662',
      })

      // 省略：値は消えない
      await db.updateExpense(id, { occurred_at: '2026-04-02', category: 'supplies', amount: 500 })
      expect((await db.listExpenses('2026-04')).find(e => e.id === id)!.registration_no).toBe('T4200001013662')

      // null明示：消える
      await db.updateExpense(id, {
        occurred_at: '2026-04-02', category: 'supplies', amount: 500, receipt_registration_no: null,
      })
      expect((await db.listExpenses('2026-04')).find(e => e.id === id)!.registration_no).toBeNull()

      // 別の番号を渡すと差し替わる
      await db.updateExpense(id, {
        occurred_at: '2026-04-02', category: 'supplies', amount: 500, receipt_registration_no: 'T9999999999999',
      })
      expect((await db.listExpenses('2026-04')).find(e => e.id === id)!.registration_no).toBe('T9999999999999')
    })

    it('振込手数料の自動計上は撤去：販売を作ってもexpenseは増えず、expense_auto_monthテーブルも存在しない', async () => {
      await db.createSale({ title: '経費テスト', sold_at: '2026-06-10', price: 2000 })
      expect(await db.listExpenses('2026-06')).toHaveLength(0)
      expect((await db.listMonthly()).find(m => m.month === '2026-06' && m.kind === 'resale')!.expense_total).toBe(0)

      const [t] = await db.sql<{ found: string | null }>(`select to_regclass('app.expense_auto_month')::text as found`)
      expect(t.found).toBeNull()
    })
  })

  describe('listMonthly：今月の行は販売が 0 件でも必ず返る', () => {
    const zeroRow = {
      kind: 'resale', sales_count: 0, revenue: 0, total_fee: 0, total_shipping: 0, total_packaging: 0,
      total_cost: 0, gross_profit: 0, unconfirmed_shipping: 0, expense_total: 0, net_profit: 0,
      closed: false, forecast: { count: 0, revenue: 0, gross_profit: 0 },
    }

    it('販売が全部先月でも、今月の行が 0 で出る。先月の行は消えず、新しい月が先頭', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-03T03:00:00Z')) // 日本時間 2026-10-03 12:00
      await createCompletedSale({ title: '先月の販売', sold_at: '2026-09-20', price: 1000 })

      const rows = await db.listMonthly()
      expect(rows.map(r => `${r.month}:${r.kind}`)).toEqual(['2026-10:resale', '2026-09:resale'])
      expect(rows[0]).toEqual({ month: '2026-10', ...zeroRow })
      expect(rows[1]).toMatchObject({ month: '2026-09', sales_count: 1, revenue: 1000 })
    })

    it('空DBでも今月の行が 1 件だけ出る', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-03T03:00:00Z'))
      expect(await db.listMonthly()).toEqual([{ month: '2026-10', ...zeroRow }])
    })

    it('今月の販売があるときは二重に出ない（resale は 1 行、私物は私物の行のまま）', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-03T03:00:00Z'))
      await createCompletedSale({ title: '今月の転売', sold_at: '2026-10-02', price: 2000 })
      await db.createSale({ title: '今月の私物', sold_at: '2026-10-02', price: 500, kind: 'personal' })

      const rows = await db.listMonthly()
      expect(rows.filter(r => r.month === '2026-10' && r.kind === 'resale')).toHaveLength(1)
      expect(rows.filter(r => r.month === '2026-10' && r.kind === 'personal')).toHaveLength(1)
      expect(rows.find(r => r.month === '2026-10' && r.kind === 'resale')).toMatchObject({ sales_count: 1, revenue: 2000 })
    })

    it('今月に経費だけあるときも二重に出ない（経費は 1 回だけ載る）', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-03T03:00:00Z'))
      await db.createExpense({ occurred_at: '2026-10-02', category: 'packaging', amount: 300 })

      const rows = (await db.listMonthly()).filter(r => r.month === '2026-10')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ kind: 'resale', expense_total: 300, net_profit: -300 })
    })

    it('日本時間の 0〜9 時台（UTC では前日・前月）でも今月は日本時間の月で判定される', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      // 日本時間 2026-10-01 00:10。UTC では 2026-09-30 15:10（サーバーの時計の月は 9 月）
      vi.setSystemTime(new Date('2026-09-30T15:10:00Z'))
      await createCompletedSale({ title: '先月の販売', sold_at: '2026-09-30', price: 1000 })

      const rows = await db.listMonthly()
      expect(rows[0]).toMatchObject({ month: '2026-10', kind: 'resale', sales_count: 0 })
      expect(rows.map(r => r.month)).toEqual(['2026-10', '2026-09'])

      // 月末の 23:50（日本時間）は 9 月のまま
      vi.setSystemTime(new Date('2026-09-30T14:50:00Z'))
      expect((await db.listMonthly())[0]).toMatchObject({ month: '2026-09', sales_count: 1 })
    })
  })

  describe('getMonthDetail：価格0の月でも経費配賦は数量按分にフォールバックする', () => {
    it('販売価格が全て0でも、経費は数量按分で全額配賦される（合計が一致する）', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-01', shipping_fee: 0,
        lines: [{ name: '無料配布品A', unit_price: 0, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-01', shipping_fee: 0,
        lines: [{ name: '無料配布品B', unit_price: 0, quantity: 1 }],
      })
      const [itemA, itemB] = await db.listInventory('in_stock')

      const saleA = await createCompletedSale({ title: '無料配布品A', sold_at: '2026-04-10', price: 0 })
      await db.linkInventory(saleA, [itemA.id])
      const saleB = await createCompletedSale({ title: '無料配布品B', sold_at: '2026-04-12', price: 0 })
      await db.linkInventory(saleB, [itemB.id])

      await db.createExpense({ occurred_at: '2026-04-05', category: 'packaging', amount: 101 })

      const detail = await db.getMonthDetail('2026-04')
      expect(detail.totals.expense_total).toBe(101)
      const sum = detail.sales.reduce((s, r) => s + r.allocated_expense, 0)
      // 金額按分（価格の比）だと重みの合計が0円になり、以前は誰にも配賦されず
      // Σallocated_expense が経費合計と一致しなくなっていた。数量按分にフォールバックして一致させる
      expect(sum).toBe(101)
    })
  })

  describe('getMonthDetail：expense_by_categoryは明細ごとの項目で集計する', () => {
    it('複数項目にまたがるレシートは明細ごとのcategoryに配分される（先頭項目にまとめない）。明細の無い経費は親の項目で集計する', async () => {
      await db.createExpense({
        occurred_at: '2026-05-01', category: 'packaging',
        lines: [
          { name: '緩衝材', unit_price: 300, quantity: 1, category: 'packaging' },
          { name: 'OPP袋', unit_price: 100, quantity: 2, category: 'supplies' },
        ],
      })
      await db.createExpense({ occurred_at: '2026-05-02', category: 'shipping', amount: 500 })

      const detail = await db.getMonthDetail('2026-05')
      const byCat = Object.fromEntries(detail.expense_by_category.map(c => [c.category, c.amount]))
      expect(byCat.packaging).toBe(300)
      expect(byCat.supplies).toBe(200)
      expect(byCat.shipping).toBe(500)
    })
  })

  describe('exportExpenseRows（元の exportCsvRows(\'expenses\')）', () => {
    it('expenses：1行=経費の1明細。見出しと列数が一致し、monthは計上月（occurred_atではない）で絞る。明細の無い経費も落とさない', async () => {
      // 12月末に買ったが計上月は1月（月をまたぐケース）。明細なし＝合計だけ入力
      await db.createExpense({ occurred_at: '2025-12-30', month: '2026-01', category: 'packaging', amount: 700 })
      await db.createExpense({ occurred_at: '2026-02-01', category: 'other', amount: 300 })

      const all = parseCsv(await db.exportExpenseRows())
      expect(all.rows).toHaveLength(2)
      expect(all.rows[0]).toHaveLength(all.headers.length)
      expect(all.headers).toEqual([
        '計上月', '購入日', '購入店', '登録番号', '項目', '品名', '単価', '数量', '金額', 'メモ',
      ])

      const jan = parseCsv(await db.exportExpenseRows('2026-01'))
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

      const rows = parseCsv(await db.exportExpenseRows('2026-03'))
      const regIdx = rows.headers.indexOf('登録番号')
      const values = rows.rows.map(r => r[regIdx]).sort()
      expect(values).toEqual(['', 'T4200001013662'])
    })
  })

  describe('views.test.ts「月次の計算書」の getMonthDetail 側', () => {
    it('粗利・純利益が販売の合計と一致し、タグ別（直接＋派生）の合計が合う', async () => {
      const today = todayJst()
      const month = today.slice(0, 7)
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

      await db.createExpense({ occurred_at: today, category: 'packaging', amount: 1000 })

      const detail = await db.getMonthDetail(month)
      const s1 = detail.sales.find(s => s.id === sale1)!
      const s2 = detail.sales.find(s => s.id === sale2)!
      const s3 = detail.sales.find(s => s.id === sale3)!

      // 粗利 = 価格 − 手数料(10%) − 原価1000。純利益 = 粗利 − 配賦した経費
      expect(s1.gross_profit).toBe(1000 - 100 - 1000)
      expect(s2.gross_profit).toBe(1500 - 150 - 1000)
      expect(s3.gross_profit).toBe(2000 - 200 - 1000)
      expect(detail.totals).toMatchObject({
        sales_count: 3, revenue: 4500, gross_profit: s1.gross_profit + s2.gross_profit + s3.gross_profit,
        expense_total: 1000,
      })
      expect(detail.totals.net_profit).toBe(detail.totals.gross_profit - 1000)
      // 配賦した経費の合計は経費と一致し、販売ごとの純利益の合計は月の純利益と一致する
      expect(detail.sales.reduce((s, r) => s + r.allocated_expense, 0)).toBe(1000)
      expect(detail.sales.reduce((s, r) => s + r.net_profit, 0)).toBe(detail.totals.net_profit)

      // タグ別：A は sale1・sale2、B は sale2（直接）・sale3（派生）
      const a = (await db.getMonthDetail(month, { tagId: tagA })).filtered!
      const b = (await db.getMonthDetail(month, { tagId: tagB })).filtered!
      expect(a.tag.id).toBe(tagA)
      expect(a.sales_count).toBe(2)
      expect(a.gross_profit).toBe(s1.gross_profit + s2.gross_profit)
      expect(a.expense_total).toBe(s1.allocated_expense + s2.allocated_expense)
      expect(a.net_profit).toBe(s1.net_profit + s2.net_profit)
      expect(b.sales_count).toBe(2)
      expect(b.gross_profit).toBe(s2.gross_profit + s3.gross_profit)
      expect(b.expense_total).toBe(s2.allocated_expense + s3.allocated_expense)
      // tagId を渡さなければ filtered は null
      expect(detail.filtered).toBeNull()
    })
  })

  describe('recognition.test.ts「取引完了だけ実績・未完了は見込み」の listMonthly / getMonthDetail 側', () => {
    it('すべての未完了状態と状態不明を分離し、月次・タグ合計が一致する', async () => {
      const month = thisMonthJst()
      const tag = await db.createTag('対象')
      const statuses = [null, 'waiting_payment', 'waiting_shipment', 'shipped', 'delivered', 'completed'] as const
      for (const status of statuses) {
        const [{ id }] = await db.insertCollected([{
          mercariItemId: `state-${status}`, title: `商品【A037】${status}`, soldAt: `${month}-01`, price: 1000,
          status: status ?? undefined,
        }])
        await db.setSaleTags(id, [tag])
      }
      await db.createExpense({ occurred_at: `${month}-01`, category: 'packaging', amount: 200 })
      const actual = (await db.listMonthly()).find(r => r.month === month)!
      expect(actual).toMatchObject({
        sales_count: 1, revenue: 1000, gross_profit: 900, net_profit: 700,
        forecast: { count: 5, revenue: 5000, gross_profit: 4500 },
      })
      expect(await db.saleTotals({ tagId: tag })).toMatchObject({ count: 1, revenue: 1000, forecast: actual.forecast })
      expect((await db.getMonthDetail(month)).sales).toHaveLength(1)
      expect((await db.getMonthDetail(month)).forecast_sales).toHaveLength(5)
    })

    it('赤字の見込みも残し、見込みだけの月に経費を二重計上しない', async () => {
      const id = await db.createSale({ title: '赤字', sold_at: '2026-05-01', price: 100 })
      await db.applySaleActuals(id, { status: 'shipped' })
      await db.updateSale(id, { shipping_fee: 300 })
      await db.createExpense({ occurred_at: '2026-05-01', category: 'packaging', amount: 50 })
      expect((await db.listMonthly()).find(r => r.month === '2026-05' && r.kind === 'resale'))
        .toMatchObject({
          revenue: 0, net_profit: -50,
          forecast: { count: 1, revenue: 100, gross_profit: -210 },
        })
    })

    it('月をまたいで完了した取引は完了月の実績に一度だけ移る', async () => {
      const [sale] = await db.insertCollected([{
        mercariItemId: 'recognition-month', title: '商品【A037】', price: 2000,
        soldAt: '2026-05-30', status: 'shipped',
      }])
      expect((await db.listMonthly()).find(r => r.month === '2026-05' && r.kind === 'resale'))
        .toMatchObject({ month: '2026-05', revenue: 0, forecast: { revenue: 2000 } })
      await db.applySaleActuals(sale.id, { status: 'completed', completedAt: '2026-06-02', sold_at: '2026-06-02' })
      // 5月と6月の両方に残っていない＝一度だけ移ったこと（listMonthly は今月の0行も返すので月で絞る）
      expect((await db.listMonthly()).filter(r => r.month === '2026-05' || r.month === '2026-06')).toHaveLength(1)
      expect((await db.listMonthly()).find(r => r.month === '2026-06' && r.kind === 'resale'))
        .toMatchObject({ month: '2026-06', revenue: 2000, forecast: { count: 0, revenue: 0 } })
      await db.applySaleActuals(sale.id, { status: 'completed', completedAt: '2026-06-02', sold_at: '2026-06-02' })
      expect(await db.saleTotals()).toMatchObject({ count: 1, revenue: 2000 })
    })

    it('状態未設定の手入力は実績。取得分の状態不明は見込み。保存状態は変更しない', async () => {
      const month = thisMonthJst()
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: `${month}-01`,
        lines: [{ name: '商品【A037】', unit_price: 500, quantity: 2 }],
      })
      const manual = await db.createSale({ title: '商品【A037】', sold_at: `${month}-01`, price: 1000 })
      await db.insertCollected([{ mercariItemId: 'unknown', title: '商品【A037】', soldAt: `${month}-01`, price: 2000 }])
      expect((await db.listSales()).find(s => s.id === manual)?.status).toBeNull()
      expect(await db.saleTotals()).toMatchObject({
        count: 1, revenue: 1000, gross_profit: 400, forecast: { count: 1, revenue: 2000, gross_profit: 1300 },
      })
      expect((await db.listMonthly())[0]).toMatchObject({ sales_count: 1, revenue: 1000, unconfirmed_shipping: 1 })
      expect(await db.sql('select revenue from monthly_summary')).toEqual([{ revenue: 1000 }])
    })
  })

  describe('月の締め（month_book）', () => {
    it('締めた時点の数字を記録する。締めても編集はロックしない（締め後に変わったら changed_since_close）', async () => {
      await createCompletedSale({ title: '九月の販売', sold_at: '2026-09-10', price: 3000 })
      await db.createExpense({ occurred_at: '2026-09-05', category: 'packaging', amount: 400 })

      const closed = await db.closeMonth('2026-09')
      expect(closed).toMatchObject({
        month: '2026-09', alloc_method: 'by_amount', sales_count: 1, revenue: 3000,
        gross_profit: 2700, expense_total: 400, net_profit: 2300,
      })
      expect(new Date(closed.closed_at).toISOString()).toBe(closed.closed_at)

      let detail = await db.getMonthDetail('2026-09')
      expect(detail.close).toEqual(closed)
      expect(detail.changed_since_close).toBe(false)
      expect((await db.listMonthly()).find(r => r.month === '2026-09' && r.kind === 'resale')!.closed).toBe(true)

      // 締めても経費を足せる・販売を足せる（ロックしない）。締めた数字は動かず、変わったことが分かる
      await db.createExpense({ occurred_at: '2026-09-20', category: 'supplies', amount: 100 })
      await createCompletedSale({ title: '遅れて入った販売', sold_at: '2026-09-25', price: 1000 })
      detail = await db.getMonthDetail('2026-09')
      expect(detail.close).toEqual(closed)
      expect(detail.totals).toMatchObject({ sales_count: 2, revenue: 4000, expense_total: 500 })
      expect(detail.changed_since_close).toBe(true)
    })

    it('締め直すと数字が新しくなる。解除すると数字は消えるが按分方法は残る', async () => {
      await createCompletedSale({ title: '九月の販売', sold_at: '2026-09-10', price: 3000 })
      await db.setMonthAllocMethod('2026-09', 'by_quantity')
      const first = await db.closeMonth('2026-09')
      expect(first.alloc_method).toBe('by_quantity')

      await createCompletedSale({ title: '追加の販売', sold_at: '2026-09-11', price: 1000 })
      const second = await db.closeMonth('2026-09')
      expect(second).toMatchObject({ sales_count: 2, revenue: 4000 })

      await db.reopenMonth('2026-09')
      const detail = await db.getMonthDetail('2026-09')
      expect(detail.close).toBeNull()
      expect(detail.changed_since_close).toBe(false)
      expect(detail.alloc_method).toBe('by_quantity')
      const [book] = await db.sql<Record<string, unknown>>(`select * from month_book where month = '2026-09'`)
      expect(book).toMatchObject({
        closed_at: null, sales_count: null, revenue: null, gross_profit: null, expense_total: null, net_profit: null,
        alloc_method: 'by_quantity',
      })
      expect((await db.listMonthly()).find(r => r.month === '2026-09' && r.kind === 'resale')!.closed).toBe(false)
    })

    it('終わった月だけ締められる（今月・未来は断る）。按分方法の変更は締め済みでもできる', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-03T03:00:00Z')) // 日本時間 2026-10-03
      await expect(db.closeMonth('2026-10')).rejects.toThrow('終わった月だけ締められます')
      await expect(db.closeMonth('2026-11')).rejects.toThrow('終わった月だけ締められます')
      expect(await db.sql('select 1 from month_book')).toHaveLength(0)

      await db.closeMonth('2026-09')
      await db.setMonthAllocMethod('2026-09', 'by_quantity')
      const detail = await db.getMonthDetail('2026-09')
      expect(detail.alloc_method).toBe('by_quantity')
      expect(detail.close).not.toBeNull() // 締めは外れない
    })

    it('按分方法を締めていない月に設定しても月の行ができる（既定は金額按分）', async () => {
      expect((await db.getMonthDetail('2026-03')).alloc_method).toBe('by_amount')
      await db.setMonthAllocMethod('2026-03', 'by_quantity')
      await db.setMonthAllocMethod('2026-03', 'by_amount')
      expect((await db.getMonthDetail('2026-03')).alloc_method).toBe('by_amount')
      expect(await db.sql('select 1 from month_book')).toHaveLength(1)
    })
  })

  describe('deleteExpense', () => {
    it('経費を消すと明細も消える。無い id でも落ちない', async () => {
      const id = await db.createExpense({
        occurred_at: '2026-01-10', category: 'packaging', lines: [{ name: '袋', unit_price: 100 }, { name: '箱', unit_price: 200 }],
      })
      expect(await db.sql('select 1 from expense_line')).toHaveLength(2)
      await db.deleteExpense(id)
      expect(await db.listExpenses()).toHaveLength(0)
      expect(await db.sql('select 1 from expense_line')).toHaveLength(0)
      await db.deleteExpense(id)
    })
  })
})
