import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import { UserError } from '../../errors'
import * as monthly from '../../domain/monthly'
import { allocateExpenseToSales, nextMonth } from '../../domain/monthly'
import type { ExpenseInput, SaleInput } from '../../../src/shared/types'
import { newWorld, openDomainDb, type DomainDb, type Member, type World } from './helpers'
import { bindDb } from './core-helpers'

// Web 版で足したテスト（デスクトップ版には無いもの）：
//   * 経費の按分の金額：合計が経費の額と一致する／余りは最後の行／私物・見込みには配賦しない／大きな数でも floor がずれない
//   * 世帯の分離：B から A の経費・販売・月の締めが見えない・触れない（id を知っていても）
//   * 引数の検査：変な型は UserError（500 にしない）
//   * dispatch（API の入口）経由
//   * 偽の時計（UTC の 15:00〜23:59）で、日本時間の今月・締められる月の線引きが翌日・翌月になること
//   * 明細の一括投入（unnest）に引用符・カンマ・波括弧・バックスラッシュが入っても壊れない

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const A = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)
const B = <T>(fn: (ctx: Ctx) => Promise<T>) => w.b.run(fn)
const core = bindDb(() => w.a)

const mo = (m: Member) => ({
  listMonthly: () => m.run((c) => monthly.listMonthly(c)),
  listExpenses: (month?: string) => m.run((c) => monthly.listExpenses(c, month)),
  createExpense: (i: ExpenseInput) => m.run((c) => monthly.createExpense(c, i)),
  updateExpense: (id: string, i: ExpenseInput) => m.run((c) => monthly.updateExpense(c, id, i)),
  deleteExpense: (id: string) => m.run((c) => monthly.deleteExpense(c, id)),
  getMonthDetail: (month: string, opts?: { tagId?: string | null }) => m.run((c) => monthly.getMonthDetail(c, month, opts)),
  setMonthAllocMethod: (month: string, method: 'by_amount' | 'by_quantity') =>
    m.run((c) => monthly.setMonthAllocMethod(c, month, method)),
  closeMonth: (month: string) => m.run((c) => monthly.closeMonth(c, month)),
  reopenMonth: (month: string) => m.run((c) => monthly.reopenMonth(c, month)),
  exportExpenseRows: (month?: string) => m.run((c) => monthly.exportExpenseRows(c, month)),
})
const ma = () => mo(w.a)
const mb = () => mo(w.b)

async function completedSale(input: SaleInput): Promise<string> {
  const id = await core.createSale(input)
  await core.applySaleActuals(id, { status: 'completed' })
  return id
}

const userError = { name: 'UserError' }

describe('経費の按分（allocateExpenseToSales：純粋な計算）', () => {
  const sale = (id: string, price: number, item_count = 1) => ({ id, price, item_count })
  const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0)

  it('金額按分：floor で配り、余りは最後の行。合計は経費の額と一致する', () => {
    const m = allocateExpenseToSales([sale('a', 1001), sale('b', 2003), sale('c', 4999)], 1001, 'by_amount')
    // 1001*1001/8003=125.2 → 125、1001*2003/8003=250.5 → 250、最後は 1001−125−250
    expect([...m.values()]).toEqual([125, 250, 626])
    expect(sum(m)).toBe(1001)
  })

  it('数量按分：点数の比（0点は1として数える）。余りは最後の行', () => {
    const m = allocateExpenseToSales([sale('a', 500, 2), sale('b', 800, 0), sale('c', 900, 1)], 1001, 'by_quantity')
    // 重み 2:1:1 → 500、250、最後は 1001−750
    expect([...m.values()]).toEqual([500, 250, 251])
    expect(sum(m)).toBe(1001)
  })

  it('販売が 0 件なら誰にも配賦しない。経費 0 なら全員 0', () => {
    expect(allocateExpenseToSales([], 500, 'by_amount').size).toBe(0)
    expect([...allocateExpenseToSales([sale('a', 100), sale('b', 200)], 0, 'by_amount').values()]).toEqual([0, 0])
  })

  it('販売が 1 件ならその 1 件が経費を全部受ける', () => {
    expect([...allocateExpenseToSales([sale('a', 777)], 12345, 'by_amount').values()]).toEqual([12345])
  })

  it('金額按分で価格が全部 0 なら数量按分にフォールバックする。数量按分の指定は価格 0 でもそのまま', () => {
    expect([...allocateExpenseToSales([sale('a', 0, 3), sale('b', 0, 1)], 101, 'by_amount').values()]).toEqual([75, 26])
    expect([...allocateExpenseToSales([sale('a', 0, 3), sale('b', 0, 1)], 101, 'by_quantity').values()]).toEqual([75, 26])
  })

  it('価格 0 の販売が混じっても、価格のある販売の比で配る（0 の販売は 0 円）', () => {
    const m = allocateExpenseToSales([sale('a', 0), sale('b', 1000), sale('c', 3000)], 400, 'by_amount')
    expect([...m.values()]).toEqual([0, 100, 300])
  })

  it('経費 × 価格が 2^53 を超えても、floor がずれずに合計が合う（BigInt で掛ける）', () => {
    const total = 2_000_000_000
    const prices = [1_999_999_999, 1_999_999_999, 2]
    const m = allocateExpenseToSales(prices.map((p, i) => sale(`s${i}`, p)), total, 'by_amount')
    const weightSum = BigInt(prices.reduce((s, p) => s + p, 0))
    const exact = prices.slice(0, 2).map(p => Number((BigInt(total) * BigInt(p)) / weightSum))
    const values = [...m.values()]
    expect(values.slice(0, 2)).toEqual(exact)
    expect(values[2]).toBe(total - exact[0] - exact[1])
    expect(sum(m)).toBe(total)
  })

  it('いろいろな組み合わせで、合計が必ず経費の額と一致し、どの行も 0 以上', () => {
    // 疑似乱数（固定の種）。実行ごとに結果が変わらない
    let seed = 20261012
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let round = 0; round < 300; round++) {
      const n = 1 + rnd(8)
      const sales = Array.from({ length: n }, (_, i) => sale(`s${i}`, rnd(5) === 0 ? 0 : rnd(20000), rnd(4)))
      const total = rnd(100000)
      for (const method of ['by_amount', 'by_quantity'] as const) {
        const m = allocateExpenseToSales(sales, total, method)
        expect(m.size).toBe(n)
        expect(sum(m)).toBe(total)
        for (const v of m.values()) {
          expect(Number.isInteger(v)).toBe(true)
          expect(v).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })
})

describe('月次の経費の按分（getMonthDetail。DB を通した合計）', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  it('金額按分：販売価格の比で配り、余りは最後の行（並びは計上日の新しい順）。販売ごとの純利益の合計＝月の純利益', async () => {
    await completedSale({ title: '一番新しい', sold_at: '2026-04-20', price: 1001 })
    await completedSale({ title: '真ん中', sold_at: '2026-04-15', price: 2003 })
    await completedSale({ title: '一番古い', sold_at: '2026-04-10', price: 4999 })
    await ma().createExpense({ occurred_at: '2026-04-02', category: 'packaging', amount: 1001 })

    const d = await ma().getMonthDetail('2026-04')
    expect(d.alloc_method).toBe('by_amount')
    expect(d.sales.map(s => [s.title, s.allocated_expense])).toEqual([['一番新しい', 125], ['真ん中', 250], ['一番古い', 626]])
    expect(d.sales.reduce((s, r) => s + r.allocated_expense, 0)).toBe(d.totals.expense_total)
    expect(d.sales.reduce((s, r) => s + r.net_profit, 0)).toBe(d.totals.net_profit)
    // 粗利 = 価格 − 手数料(10% を floor)。1001→100、2003→200、4999→499
    expect(d.totals.gross_profit).toBe((1001 - 100) + (2003 - 200) + (4999 - 499))
    expect(d.totals.net_profit).toBe(d.totals.gross_profit - 1001)
  })

  it('数量按分：紐付けた点数の比（紐付けが無い販売は 1 点として数える）', async () => {
    const shopId = await core.createShopAccount('メロジョイA')
    await core.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-04-01', shipping_fee: 0,
      lines: [{ name: '数量按分の仕入', unit_price: 100, quantity: 3 }],
    })
    const items = await core.listInventory('in_stock')
    const s1 = await completedSale({ title: '二点まとめ', sold_at: '2026-04-20', price: 500 })
    await core.linkInventory(s1, [items[0].id, items[1].id])
    await completedSale({ title: '未紐付け', sold_at: '2026-04-15', price: 800 })
    const s3 = await completedSale({ title: '一点', sold_at: '2026-04-10', price: 900 })
    await core.linkInventory(s3, [items[2].id])
    await ma().createExpense({ occurred_at: '2026-04-02', category: 'packaging', amount: 1001 })
    await ma().setMonthAllocMethod('2026-04', 'by_quantity')

    const d = await ma().getMonthDetail('2026-04')
    expect(d.alloc_method).toBe('by_quantity')
    // 点数 2:1:1 → 500、250、最後は 1001−750
    expect(d.sales.map(s => [s.title, s.item_count, s.allocated_expense])).toEqual([
      ['二点まとめ', 2, 500], ['未紐付け', 0, 250], ['一点', 1, 251],
    ])
    expect(d.sales.reduce((s, r) => s + r.allocated_expense, 0)).toBe(1001)
    expect(d.pending).toEqual({ unconfirmed_shipping: 3, unmatched: 1 })
  })

  it('私物と見込み（未完了）には配賦しない。合計は販売用の実績だけに乗る', async () => {
    await completedSale({ title: '実績A', sold_at: '2026-04-20', price: 1000 })
    await completedSale({ title: '実績B', sold_at: '2026-04-10', price: 3000 })
    await core.createSale({ title: '私物', sold_at: '2026-04-12', price: 9000, kind: 'personal' })
    const pendingId = await core.createSale({ title: '発送待ち', sold_at: '2026-04-13', price: 7000 })
    await core.applySaleActuals(pendingId, { status: 'shipped' })
    await ma().createExpense({ occurred_at: '2026-04-02', category: 'packaging', amount: 400 })

    const d = await ma().getMonthDetail('2026-04')
    expect(d.sales.map(s => [s.title, s.allocated_expense])).toEqual([['実績A', 100], ['実績B', 300]])
    expect(d.personal_sales.map(s => s.title)).toEqual(['私物'])
    expect(d.forecast_sales!.map(s => s.title)).toEqual(['発送待ち'])
    expect(d.forecast).toEqual({ count: 1, revenue: 7000, gross_profit: 7000 - 700 })
    expect(d.personal_forecast).toEqual({ count: 0, revenue: 0, gross_profit: 0 })
    expect(d.totals).toMatchObject({ sales_count: 2, revenue: 4000, expense_total: 400 })
    expect(d.sales.reduce((s, r) => s + r.allocated_expense, 0)).toBe(400)
  })

  it('実績が 1 件も無い月でも経費は月の合計に載る（誰にも配賦しない）', async () => {
    await ma().createExpense({ occurred_at: '2026-04-02', category: 'packaging', amount: 400 })
    const d = await ma().getMonthDetail('2026-04')
    expect(d.sales).toEqual([])
    expect(d.totals).toMatchObject({ sales_count: 0, expense_total: 400, net_profit: -400 })
  })

  it('仕入先ごとの支払合計：その月に注文した確定済みの仕入だけ（月の最終日を含み、翌月と下書きは入れない）', async () => {
    const shopA = await core.createShopAccount('メロジョイA')
    const shopB = await core.createShopAccount('メロジョイB')
    await core.createPurchase({
      shop_account_id: shopA, ordered_at: '2026-02-28', shipping_fee: 100,
      lines: [{ name: '二月末の仕入', unit_price: 1000, quantity: 2 }],
    })
    await core.createPurchase({
      shop_account_id: shopA, ordered_at: '2026-02-01', shipping_fee: 0,
      lines: [{ name: '二月頭の仕入', unit_price: 500, quantity: 1 }],
    })
    await core.createPurchase({
      shop_account_id: shopB, ordered_at: '2026-02-10', shipping_fee: 0,
      lines: [{ name: 'B の仕入', unit_price: 300, quantity: 3 }],
    })
    await core.createPurchase({
      shop_account_id: shopA, ordered_at: '2026-03-01', shipping_fee: 0,
      lines: [{ name: '三月の仕入', unit_price: 9999, quantity: 1 }],
    })
    await core.sqlRun(
      `insert into purchase (shop_account_id, ordered_at, status) values (?, '2026-02-15', 'draft')`, shopA,
    )

    const d = await ma().getMonthDetail('2026-02')
    expect(d.purchases_by_account).toEqual([
      { shop_account_id: shopA, shop_account_name: 'メロジョイA', count: 2, total_cost: 2000 + 100 + 500 },
      { shop_account_id: shopB, shop_account_name: 'メロジョイB', count: 1, total_cost: 900 },
    ])
  })
})

describe('listMonthly の集計（ビューから読む）', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  it('実績・見込み・送料未入力・経費・締めを月×区分で出す。私物には経費も締めも載らない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-03T03:00:00Z'))
    try {
      // 九月：実績 2 件（片方は送料入力済み）、見込み 1 件、私物 1 件
      await completedSale({ title: '実績・送料未入力', sold_at: '2026-09-10', price: 1000 })
      const confirmed = await completedSale({ title: '実績・送料入力済み', sold_at: '2026-09-11', price: 2000 })
      await core.updateSale(confirmed, { shipping_fee: 300 })
      const waiting = await core.createSale({ title: '発送待ち', sold_at: '2026-09-12', price: 5000 })
      await core.applySaleActuals(waiting, { status: 'waiting_shipment' })
      const personal = await core.createSale({ title: '私物', sold_at: '2026-09-13', price: 700, kind: 'personal' })
      await core.applySaleActuals(personal, { status: 'completed' })
      await ma().createExpense({ occurred_at: '2026-09-02', category: 'packaging', amount: 250 })
      await ma().closeMonth('2026-09')

      const rows = await ma().listMonthly()
      expect(rows.map(r => `${r.month}:${r.kind}`)).toEqual(['2026-10:resale', '2026-09:personal', '2026-09:resale'])
      const resale = rows.find(r => r.month === '2026-09' && r.kind === 'resale')!
      expect(resale).toEqual({
        month: '2026-09', kind: 'resale', sales_count: 2, revenue: 3000, total_fee: 300, total_shipping: 300,
        total_packaging: 0, total_cost: 0, gross_profit: 3000 - 300 - 300,
        forecast: { count: 1, revenue: 5000, gross_profit: 5000 - 500 },
        unconfirmed_shipping: 1, expense_total: 250, net_profit: 3000 - 300 - 300 - 250, closed: true,
      })
      const pers = rows.find(r => r.month === '2026-09' && r.kind === 'personal')!
      expect(pers).toMatchObject({ sales_count: 1, revenue: 700, expense_total: 0, closed: false })
      expect(pers.net_profit).toBe(pers.gross_profit)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ビュー（monthly_summary）から読んだ数字が、販売の一覧（listSales）をデスクトップ版と同じく足し上げた数字と一致する', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-03T03:00:00Z'))
    try {
      const shopId = await core.createShopAccount('メロジョイA')
      await core.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-07-01', shipping_fee: 90,
        lines: [{ name: '紐付ける仕入', unit_price: 400, quantity: 4 }],
      })
      const items = await core.listInventory('in_stock')
      const statuses = [undefined, 'completed', 'waiting_payment', 'waiting_shipment', 'shipped', 'delivered'] as const
      let n = 0
      for (const month of ['2026-07', '2026-08', '2026-09', '2026-10']) {
        for (const kind of ['resale', 'personal'] as const) {
          for (const status of statuses) {
            n++
            const id = await core.createSale({ title: `${month}-${kind}-${status ?? 'manual'}-${n}`, sold_at: `${month}-0${1 + (n % 9)}`, price: 700 + n * 37, kind })
            if (status) await core.applySaleActuals(id, { status })
            if (n % 3 === 0) await core.updateSale(id, { shipping_fee: 100 + n })
            if (n % 5 === 0) await core.updateSale(id, { packaging_cost: n })
            if (kind === 'resale' && n % 4 === 0 && items.length > 0) await core.linkInventory(id, [items.shift()!.id])
          }
        }
      }
      await ma().createExpense({ occurred_at: '2026-08-02', category: 'packaging', amount: 321 })
      await ma().createExpense({ occurred_at: '2026-06-02', category: 'other', amount: 55 })
      await ma().closeMonth('2026-08')

      // デスクトップ版の listMonthly と同じ手順（listSales を月×区分に分け、isRealized で実績を足す）
      const sales = await core.listSales()
      const groups = new Map<string, typeof sales>()
      for (const s of sales) {
        const key = `${s.sold_at.slice(0, 7)}:${s.kind}`
        groups.set(key, [...(groups.get(key) ?? []), s])
      }
      const expectedRows = [...groups].map(([key, group]) => {
        const [month, kind] = key.split(':')
        const done = group.filter(s => s.status === 'completed' || (s.source === 'manual' && s.status === null))
        const pend = group.filter(s => !done.includes(s))
        return {
          month, kind,
          sales_count: done.length,
          revenue: done.reduce((s, x) => s + x.price, 0),
          total_fee: done.reduce((s, x) => s + x.fee, 0),
          total_shipping: done.reduce((s, x) => s + x.shipping_fee, 0),
          total_packaging: done.reduce((s, x) => s + x.packaging_cost, 0),
          total_cost: done.reduce((s, x) => s + x.cost, 0),
          gross_profit: done.reduce((s, x) => s + x.gross_profit, 0),
          unconfirmed_shipping: done.filter(x => x.is_shipping_confirmed === 0).length,
          forecast: {
            count: pend.length, revenue: pend.reduce((s, x) => s + x.price, 0),
            gross_profit: pend.reduce((s, x) => s + x.gross_profit, 0),
          },
        }
      })
      const rows = await ma().listMonthly()
      for (const e of expectedRows) {
        const r = rows.find(x => x.month === e.month && x.kind === e.kind)!
        const expense = e.kind === 'resale' ? (e.month === '2026-08' ? 321 : 0) : 0
        expect(r, `${e.month}:${e.kind}`).toEqual({
          ...e, expense_total: expense, net_profit: e.gross_profit - expense, closed: e.kind === 'resale' && e.month === '2026-08',
        })
      }
      // 販売のある月×区分（4 か月 × 2 区分。それぞれ 6 件）に加え、経費だけの 6 月（resale）が増える
      expect(rows).toHaveLength(expectedRows.length + 1)
      expect(rows.find(r => r.month === '2026-06')).toMatchObject({ kind: 'resale', sales_count: 0, expense_total: 55, net_profit: -55 })
      expect(expectedRows.some(e => e.sales_count > 0 && e.forecast.count > 0)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('見込みしかない月も行が出る（実績は 0）。経費だけの月は forecast の無い 0 件の行', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-03T03:00:00Z'))
    try {
      const id = await core.createSale({ title: '発送待ちだけ', sold_at: '2026-07-05', price: 2000 })
      await core.applySaleActuals(id, { status: 'shipped' })
      await ma().createExpense({ occurred_at: '2026-06-05', category: 'supplies', amount: 300 })

      const rows = await ma().listMonthly()
      expect(rows.find(r => r.month === '2026-07')).toMatchObject({
        sales_count: 0, revenue: 0, gross_profit: 0, forecast: { count: 1, revenue: 2000, gross_profit: 1800 },
      })
      expect(rows.find(r => r.month === '2026-06')).toMatchObject({ sales_count: 0, expense_total: 300, net_profit: -300 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('偽の時計（UTC の 15:00〜23:59 は日本ではもう翌日）', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('UTC 9/30 15:30（日本時間 10/1 00:30）：今月は 10 月。9 月は締められ、10 月は締められない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-30T15:30:00Z'))
    expect((await ma().listMonthly())[0].month).toBe('2026-10')
    await expect(ma().closeMonth('2026-10')).rejects.toThrow('終わった月だけ締められます')
    const closed = await ma().closeMonth('2026-09')
    expect(closed.month).toBe('2026-09')
    expect(closed.closed_at).toBe('2026-09-30T15:30:00.000Z')
  })

  it('UTC 9/30 14:59（日本時間 9/30 23:59）：今月はまだ 9 月。9 月は締められず、8 月は締められる', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-30T14:59:00Z'))
    expect((await ma().listMonthly())[0].month).toBe('2026-09')
    await expect(ma().closeMonth('2026-09')).rejects.toMatchObject(userError)
    await expect(ma().closeMonth('2026-08')).resolves.toMatchObject({ month: '2026-08' })
  })

  it('大晦日の UTC 12/31 20:00（日本時間 1/1 05:00）：今月は翌年の 1 月', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-12-31T20:00:00Z'))
    expect((await ma().listMonthly())[0]).toMatchObject({ month: '2027-01', kind: 'resale', sales_count: 0 })
  })
})

describe('明細の一括投入と経費の並び', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  it('品名に引用符・カンマ・波括弧・バックスラッシュ・絵文字があっても、そのまま保存され、入力の順に並ぶ', async () => {
    const names = ['"引用符"', 'カンマ,入り', '{波括弧}', 'バック\\スラッシュ', "シングル'クォート", '絵文字🎁', 'NULL', '  前後に空白  ']
    const id = await ma().createExpense({
      occurred_at: '2026-01-10', category: 'packaging',
      lines: names.map((name, i) => ({ name, unit_price: 100 + i, quantity: i + 1 })),
    })
    const e = (await ma().listExpenses('2026-01')).find(x => x.id === id)!
    expect(e.lines.map(l => l.name)).toEqual(names.map(n => n.trim()))
    expect(e.lines.map(l => l.amount)).toEqual(names.map((_, i) => (100 + i) * (i + 1)))
    expect(e.amount).toBe(e.lines.reduce((s, l) => s + l.amount, 0))
    // 更新でも入れ替えられる
    await ma().updateExpense(id, { occurred_at: '2026-01-10', category: 'packaging', lines: [{ name: 'C,{"x"}', unit_price: 5 }] })
    const u = (await ma().listExpenses('2026-01')).find(x => x.id === id)!
    expect(u.lines.map(l => l.name)).toEqual(['C,{"x"}'])
  })

  it('一覧は購入日の新しい順。同じ日なら作った時刻の新しい方が先', async () => {
    const ids: string[] = []
    for (const n of [1, 2, 3]) {
      ids.push(await ma().createExpense({ occurred_at: '2026-01-10', category: 'other', amount: n * 100 }))
    }
    const older = await ma().createExpense({ occurred_at: '2026-01-09', category: 'other', amount: 1 })
    // 作った時刻は PGlite だと同じミリ秒になりうるので、順序を決める時刻を明示する
    await A(async (c) => {
      for (const [i, id] of ids.entries()) {
        await c.sql.run(`update expense set created_at = '2026-01-10T00:00:0${i}Z' where id = ?`, id)
      }
    })
    expect((await ma().listExpenses('2026-01')).map(e => e.id)).toEqual([ids[2], ids[1], ids[0], older])
    // 全期間でも同じ順
    expect((await ma().listExpenses()).map(e => e.id)).toEqual([ids[2], ids[1], ids[0], older])
  })

  it('レシートの無い経費の receipt_url は null。receipt_temp_file は Storage のパスの形だけ受ける（デスクトップの一時ファイル名は 400）。詳しくは upload/', async () => {
    const id = await ma().createExpense({ occurred_at: '2026-01-10', category: 'other', amount: 100 })
    const e = (await ma().listExpenses()).find(x => x.id === id)!
    expect(e.receipt_url).toBeNull()
    await expect(ma().createExpense({
      occurred_at: '2026-01-10', category: 'other', amount: 100, receipt_temp_file: 'receipt-tmp-x.jpg',
    })).rejects.toMatchObject(userError)
  })

  it('金額は整数の円：小数・負・文字・integer を超える数は断る。明細の合計も上限を超えたら断る', async () => {
    const base = { occurred_at: '2026-01-10', category: 'other' as const }
    for (const amount of [10.5, -1, '100', 2_147_483_648, Number.NaN, Infinity]) {
      await expect(ma().createExpense({ ...base, amount: amount as never })).rejects.toMatchObject(userError)
    }
    await expect(ma().createExpense({
      ...base, lines: [{ name: 'a', unit_price: 2_000_000_000 }, { name: 'b', unit_price: 2_000_000_000 }],
    })).rejects.toThrow('金額が大きすぎます')
    await expect(ma().createExpense({
      ...base, lines: [{ name: 'a', unit_price: 2_000_000_000, quantity: 2 }],
    })).rejects.toThrow('1行目の金額が大きすぎます')
    await expect(ma().createExpense({ ...base, amount: 2_147_483_647 })).resolves.toEqual(expect.any(String))
    expect(await ma().listExpenses()).toHaveLength(1)
  })
})

describe('世帯の分離（B から A の経費・販売・月の締めは見えない／触れない）', () => {
  let expenseId: string
  let saleId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    expenseId = await ma().createExpense({
      occurred_at: '2026-09-05', category: 'packaging', shop: 'A の店', receipt_registration_no: 'T1111111111111',
      lines: [{ name: 'A の袋', unit_price: 300, quantity: 2 }],
    })
    saleId = await completedSale({ title: 'A の販売', sold_at: '2026-09-10', price: 3000 })
    await ma().closeMonth('2026-09')
  })

  it('B の一覧・月次・月の明細・CSV に A の行が出ない', async () => {
    expect(await mb().listExpenses()).toEqual([])
    expect(await mb().listExpenses('2026-09')).toEqual([])
    const d = await mb().getMonthDetail('2026-09')
    expect(d).toMatchObject({ sales: [], expenses: [], close: null, totals: { sales_count: 0, expense_total: 0 } })
    expect(d.expense_by_category).toEqual([])
    expect(d.purchases_by_account).toEqual([])
    expect(await mb().exportExpenseRows()).toBe('')
    const rows = await mb().listMonthly()
    expect(rows.every(r => r.sales_count === 0 && r.expense_total === 0 && !r.closed)).toBe(true)
    expect(rows.some(r => r.month === '2026-09')).toBe(false)
    // A の側は見えたまま
    expect((await ma().listExpenses('2026-09')).map(e => e.id)).toEqual([expenseId])
    expect((await ma().getMonthDetail('2026-09')).sales.map(s => s.id)).toEqual([saleId])
  })

  it('B は A の経費を更新できない（見つからない）。消そうとしても A の経費は残る', async () => {
    await expect(mb().updateExpense(expenseId, { occurred_at: '2026-09-05', category: 'other', amount: 1 }))
      .rejects.toMatchObject({ name: 'UserError', code: 'not_found' })
    await mb().deleteExpense(expenseId)
    const a = (await ma().listExpenses('2026-09'))[0]
    expect(a).toMatchObject({ id: expenseId, amount: 600, category: 'packaging', shop: 'A の店' })
    expect(a.lines.map(l => l.name)).toEqual(['A の袋'])
  })

  it('B が同じ月を締める・開く・按分方法を変えても、A の月の締めは動かない', async () => {
    await mb().setMonthAllocMethod('2026-09', 'by_quantity')
    await mb().closeMonth('2026-09')
    await mb().reopenMonth('2026-09')
    const a = await ma().getMonthDetail('2026-09')
    expect(a.alloc_method).toBe('by_amount')
    expect(a.close).toMatchObject({ month: '2026-09', sales_count: 1, revenue: 3000, expense_total: 600 })
    expect(a.changed_since_close).toBe(false)
  })

  it('B から A のタグ id で絞ると「タグが見つかりません」', async () => {
    const tagA = await core.createTag('A のタグ')
    await expect(mb().getMonthDetail('2026-09', { tagId: tagA })).rejects.toMatchObject({ name: 'UserError', code: 'not_found' })
    await expect(ma().getMonthDetail('2026-09', { tagId: tagA })).resolves.toMatchObject({ filtered: { sales_count: 0 } })
  })

  it('B が登録番号つきで経費を作っても、A の店名の学習は上書きされない', async () => {
    await mb().createExpense({
      occurred_at: '2026-09-06', category: 'other', amount: 100, shop: 'B の店', receipt_registration_no: 'T1111111111111',
    })
    const aliasA = await A((c) => c.sql.get<{ shop: string }>(`select shop from shop_alias where key = 'reg:T1111111111111'`))
    const aliasB = await B((c) => c.sql.get<{ shop: string }>(`select shop from shop_alias where key = 'reg:T1111111111111'`))
    expect(aliasA?.shop).toBe('A の店')
    expect(aliasB?.shop).toBe('B の店')
  })
})

describe('引数の検査（変な型は UserError。500 にしない）', () => {
  const okInput: ExpenseInput = { occurred_at: '2026-01-10', category: 'other', amount: 100 }

  beforeEach(async () => {
    w = await newWorld(dom)
  })

  it('createExpense / updateExpense：入力の形・日付・月・区分・明細', async () => {
    const bad: unknown[] = [
      null, undefined, 'x', 1, [], {},
      { ...okInput, occurred_at: '2026-1-10' },
      { ...okInput, occurred_at: '2026-02-31' },
      { ...okInput, occurred_at: 20260110 },
      { ...okInput, month: '2026-13' },
      { ...okInput, month: 202601 },
      { ...okInput, category: 'weird' },
      { ...okInput, category: null },
      { ...okInput, shop: 5 },
      { ...okInput, note: {} },
      { ...okInput, receipt_registration_no: 5 },
      { ...okInput, lines: 'x' },
      { ...okInput, lines: [null] },
      { ...okInput, lines: [{ name: '', unit_price: 1 }] },
      { ...okInput, lines: [{ name: '   ', unit_price: 1 }] },
      { ...okInput, lines: [{ name: 5, unit_price: 1 }] },
      { ...okInput, lines: [{ name: 'a', unit_price: '1' }] },
      { ...okInput, lines: [{ name: 'a', unit_price: 1.5 }] },
      { ...okInput, lines: [{ name: 'a', unit_price: 1, quantity: 0 }] },
      { ...okInput, lines: [{ name: 'a', unit_price: 1, quantity: 1.5 }] },
      { ...okInput, lines: [{ name: 'a', unit_price: 1, quantity: '2' }] },
      { ...okInput, lines: [{ name: 'a', unit_price: 1, category: 'weird' }] },
      { ...okInput, lines: [{ name: 'a\u0000b', unit_price: 1 }] },
      { ...okInput, shop: 'x'.repeat(201) },
      { ...okInput, lines: Array.from({ length: 1001 }, () => ({ name: 'a', unit_price: 1 })) },
    ]
    const id = await ma().createExpense(okInput)
    for (const input of bad) {
      await expect(ma().createExpense(input as never)).rejects.toMatchObject(userError)
      await expect(ma().updateExpense(id, input as never)).rejects.toMatchObject(userError)
    }
    // 失敗したら何も残らない
    const list = await ma().listExpenses()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id, amount: 100, category: 'other', month: '2026-01' })
  })

  it('id・月・按分方法・タグ：形が違えば UserError', async () => {
    for (const id of [null, undefined, 5, '', 'not-a-uuid', {}]) {
      await expect(ma().updateExpense(id as never, okInput)).rejects.toMatchObject(userError)
      await expect(ma().deleteExpense(id as never)).rejects.toMatchObject(userError)
    }
    // 形は正しいが無い id
    await expect(ma().updateExpense('00000000-0000-4000-8000-000000000000', okInput))
      .rejects.toMatchObject({ name: 'UserError', code: 'not_found' })

    for (const month of [null, undefined, 5, '', '2026-1', '2026-13', '2026-00', '202601', '0099-01', {}]) {
      await expect(ma().getMonthDetail(month as never)).rejects.toMatchObject(userError)
      await expect(ma().setMonthAllocMethod(month as never, 'by_amount')).rejects.toMatchObject(userError)
      await expect(ma().closeMonth(month as never)).rejects.toMatchObject(userError)
      await expect(ma().reopenMonth(month as never)).rejects.toMatchObject(userError)
    }
    for (const month of [5, '2026-13', 'x', {}]) {
      await expect(ma().listExpenses(month as never)).rejects.toMatchObject(userError)
      await expect(ma().exportExpenseRows(month as never)).rejects.toMatchObject(userError)
    }
    for (const method of [null, undefined, 'x', 1, {}]) {
      await expect(ma().setMonthAllocMethod('2026-01', method as never)).rejects.toMatchObject(userError)
    }
    for (const tagId of ['x', 5, {}, '00000000-0000-4000-8000-00000000000g']) {
      await expect(ma().getMonthDetail('2026-01', { tagId } as never)).rejects.toMatchObject(userError)
    }
    await expect(ma().getMonthDetail('2026-01', 'x' as never)).rejects.toMatchObject(userError)
    await expect(ma().getMonthDetail('2026-01', { tagId: '00000000-0000-4000-8000-000000000000' }))
      .rejects.toMatchObject({ name: 'UserError', code: 'not_found' })
    // null・空は「指定なし」
    await expect(ma().getMonthDetail('2026-01', { tagId: null })).resolves.toMatchObject({ filtered: null })
    await expect(ma().listExpenses('' as never)).resolves.toEqual([])
    await expect(ma().exportExpenseRows('' as never)).resolves.toBe('')
    // 何も壊れていない
    expect(await ma().listExpenses()).toEqual([])
    expect(await A((c) => c.sql.all('select 1 from month_book'))).toEqual([])
  })

  it('nextMonth：年をまたぐ。形が違えば UserError', () => {
    expect(nextMonth('2026-01')).toBe('2026-02')
    expect(nextMonth('2026-09')).toBe('2026-10')
    expect(nextMonth('2026-12')).toBe('2027-01')
    expect(nextMonth('2099-12')).toBe('2100-01')
    expect(() => nextMonth('2026-13')).toThrow(UserError)
    expect(() => nextMonth('x')).toThrow(UserError)
  })
})

describe('dispatch（API の入口）経由', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  it('経費を作る→一覧→月の明細→締める→開く。null は「指定なし」', async () => {
    const created = await w.a.call('createExpense', {
      occurred_at: '2026-09-05', category: 'packaging', shop: '店', receipt_registration_no: 'T1234567890123',
      lines: [{ name: '袋', unit_price: 150, quantity: 2 }],
    })
    expect(created.status).toBe(200)
    const id = created.body.result as string
    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    // 引数なし・null の月はどちらも「全部」
    for (const args of [[], [null]]) {
      const list = await w.a.call('listExpenses', ...args)
      expect(list.status).toBe(200)
      expect((list.body.result as Array<{ id: string; amount: number; receipt_url: null }>).map(e => [e.id, e.amount, e.receipt_url]))
        .toEqual([[id, 300, null]])
    }
    // registration_no を省略した更新は、JSON ではキーが無い＝消さない
    const upd = await w.a.call('updateExpense', id, { occurred_at: '2026-09-05', category: 'packaging', amount: 500 })
    expect(upd.status).toBe(200)
    const after = (await w.a.call('listExpenses', '2026-09')).body.result as Array<{ registration_no: string | null; amount: number }>
    expect(after[0]).toMatchObject({ registration_no: 'T1234567890123', amount: 500 })

    const detail = await w.a.call('getMonthDetail', '2026-09', null)
    expect(detail.status).toBe(200)
    expect(detail.body.result).toMatchObject({ month: '2026-09', totals: { expense_total: 500 }, filtered: null })

    expect((await w.a.call('setMonthAllocMethod', '2026-09', 'by_quantity')).status).toBe(200)
    const closed = await w.a.call('closeMonth', '2026-09')
    expect(closed.status).toBe(200)
    expect(closed.body.result).toMatchObject({ month: '2026-09', alloc_method: 'by_quantity', expense_total: 500 })
    const monthly = (await w.a.call('listMonthly')).body.result as Array<{ month: string; kind: string; closed: boolean }>
    expect(monthly.find(r => r.month === '2026-09' && r.kind === 'resale')!.closed).toBe(true)
    expect((await w.a.call('reopenMonth', '2026-09')).body.result).toBeNull()
    expect((await w.a.call('deleteExpense', id)).status).toBe(200)
    expect((await w.a.call('listExpenses')).body.result).toEqual([])
  })

  it('日本語のエラーがそのまま届く（400・404）。B からは A の経費が見つからない（404）', async () => {
    const bad = await w.a.call('closeMonth', '2999-01')
    expect(bad.status).toBe(400)
    expect(bad.body.error).toEqual({ code: 'bad_request', message: '終わった月だけ締められます' })

    const badMonth = await w.a.call('getMonthDetail', '2026-1')
    expect(badMonth.status).toBe(400)
    expect(badMonth.body.error?.message).toBe('月はYYYY-MMの形式で入力してください')

    const badAmount = await w.a.call('createExpense', { occurred_at: '2026-09-05', category: 'other' })
    expect(badAmount.status).toBe(400)
    expect(badAmount.body.error?.message).toBe('金額を入れてください')

    const id = (await w.a.call('createExpense', { occurred_at: '2026-09-05', category: 'other', amount: 1 })).body.result as string
    const notMine = await w.b.call('updateExpense', id, { occurred_at: '2026-09-05', category: 'other', amount: 2 })
    expect(notMine.status).toBe(404)
    expect(notMine.body.error?.message).toBe('経費が見つかりません')
  })

  it('ファイルを選ぶダイアログのメソッド（attachReceipt・readReceiptImage）は Web では使えない（501）。removeReceipt・readReceipt は使える', async () => {
    for (const method of ['attachReceipt', 'readReceiptImage']) {
      const r = await w.a.call(method, '00000000-0000-4000-8000-000000000000')
      expect(r.status).toBe(501)
    }
    // 無い経費は 404（登録されている）
    for (const method of ['removeReceipt', 'readReceipt']) {
      const r = await w.a.call(method, '00000000-0000-4000-8000-000000000000')
      expect(r.status, method).toBe(404)
    }
  })
})
