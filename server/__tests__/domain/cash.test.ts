import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Ctx } from '../../context'
import * as cash from '../../domain/cash'
import { createTag } from '../../domain/master'
import type {
  CashAccountInput, CashAccountPatch, CashEntryInput, LiabilityInput, LiabilityKind, LiabilityPatch,
} from '../../../src/shared/types'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'

// src/main/__tests__/db.test.ts の describe('お金の出入り（cash_account / liability / cash_entry）') を移したもの。
// 期待値は変えていない。書き換えたのは「呼び方」だけ：
//   * 同期の db.xxx(...) → await db.xxx(...)（db は下の薄い包み。1 回の呼び出し＝1 リクエスト＝1 トランザクション）
//   * expect(() => …).toThrow(x) → await expect(…).rejects.toThrow(x)
//   * 販売・タグの付け外しは、このウェーブにまだ無い販売のドメインの代わりに SQL で直接行う
//   * PRAGMA table_info → information_schema
//   * 「マイグレーション不要：お金の4テーブルが無い既存DB（Phase1）」は SQLite の移行の話なので移していない

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
  listCashAccounts: () => A((c) => cash.listCashAccounts(c)),
  createCashAccount: (i: CashAccountInput) => A((c) => cash.createCashAccount(c, i)),
  updateCashAccount: (id: string, p: CashAccountPatch) => A((c) => cash.updateCashAccount(c, id, p)),
  listLiabilities: (o?: { kind?: LiabilityKind; onlyOpen?: boolean }) => A((c) => cash.listLiabilities(c, o)),
  createLiability: (i: LiabilityInput) => A((c) => cash.createLiability(c, i)),
  updateLiability: (id: string, p: LiabilityPatch) => A((c) => cash.updateLiability(c, id, p)),
  deleteLiability: (id: string) => A((c) => cash.deleteLiability(c, id)),
  listCashEntries: (m?: string) => A((c) => cash.listCashEntries(c, m)),
  createCashEntry: (i: CashEntryInput) => A((c) => cash.createCashEntry(c, i)),
  deleteCashEntry: (id: string) => A((c) => cash.deleteCashEntry(c, id)),
  getCashMonth: (m: string) => A((c) => cash.getCashMonth(c, m)),
  // ---- 販売・タグ（販売のドメインが入るまでの代わり。SQL で直接）----
  createSale: (i: { title: string; sold_at: string; price: number }) =>
    A(async (c) => (await c.sql.get<{ id: string }>(
      'insert into sale (title, sold_at, price) values (?, ?, ?) returning id', i.title, i.sold_at, i.price,
    ))!.id),
  deleteSale: (id: string) => A((c) => c.sql.run('delete from sale where id = ?', id)),
  createTag: (name: string) => A((c) => createTag(c, name)),
  setSaleTags: (saleId: string, tagIds: string[]) =>
    A(async (c) => {
      await c.sql.run('delete from sale_tag where sale_id = ?', saleId)
      for (const tagId of tagIds) await c.sql.run('insert into sale_tag (sale_id, tag_id) values (?, ?)', saleId, tagId)
    }),
}

describe('お金の出入り（cash_account / liability / cash_entry）', () => {
  let accountId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    accountId = await db.createCashAccount({
      name: '事業用の銀行', kind: 'bank', opening_balance: 0, opening_date: '2026-09-01',
    })
  })

  const balance = async (id: string) => (await db.listCashAccounts()).find(a => a.id === id)!.balance
  const totalBalance = async () => (await db.listCashAccounts()).reduce((s, a) => s + a.balance, 0)

  it('0円で作った口座に入金と出金を積むと残高が出る（残高の列は持たない）', async () => {
    expect(await balance(accountId)).toBe(0)
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-09-05', direction: 'in', amount: 44620, category: 'sale_payout' })
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-09-06', direction: 'out', amount: 1000, category: 'allowance' })
    expect(await balance(accountId)).toBe(43620)

    const cols = (await dom.pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'app' and table_name = 'cash_account'`,
    )).rows.map(c => c.column_name)
    expect(cols).not.toContain('balance')
  })

  it('はじめの残高から積む。残高の日付より前の入出金は作れない', async () => {
    const id = await db.createCashAccount({ name: '現金', kind: 'cash', opening_balance: 5000, opening_date: '2026-09-10' })
    await db.createCashEntry({ account_id: id, occurred_at: '2026-09-10', direction: 'in', amount: 700, category: 'other' })
    expect(await balance(id)).toBe(5700)
    await expect(db.createCashEntry({
      account_id: id, occurred_at: '2026-09-09', direction: 'in', amount: 700, category: 'other',
    })).rejects.toThrow('それより前の日付は入れられません')
  })

  it('金額は正の整数だけ。区分と向きが合わなければ断る', async () => {
    const base = { account_id: accountId, occurred_at: '2026-09-05', direction: 'in' as const, category: 'sale_payout' as const }
    await expect(db.createCashEntry({ ...base, amount: 0 })).rejects.toThrow()
    await expect(db.createCashEntry({ ...base, amount: -5 })).rejects.toThrow()
    await expect(db.createCashEntry({ ...base, amount: 10.5 })).rejects.toThrow()
    await expect(db.createCashEntry({ ...base, direction: 'out', amount: 100 })).rejects.toThrow('入金の区分です')
    await expect(db.createCashEntry({ ...base, occurred_at: '2026-9-5', amount: 100 })).rejects.toThrow()
    expect(await db.listCashEntries()).toHaveLength(0)
  })

  it('月をまたいだとき、前月の closing ＝ 今月の opening。opening + 入金 − 出金 = closing', async () => {
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-09-05', direction: 'in', amount: 44620, category: 'sale_payout' })
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-09-30', direction: 'out', amount: 4000, category: 'expense' })
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-10-01', direction: 'in', amount: 9000, category: 'sale_payout' })
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-10-31', direction: 'out', amount: 2500, category: 'allowance' })
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-11-01', direction: 'in', amount: 300, category: 'other' })

    const sep = await db.getCashMonth('2026-09')
    const oct = await db.getCashMonth('2026-10')
    const nov = await db.getCashMonth('2026-11')
    expect(sep.opening).toBe(0)
    expect(sep.closing).toBe(40620)
    expect(oct.opening).toBe(sep.closing)
    expect(oct.closing).toBe(40620 + 9000 - 2500)
    expect(nov.opening).toBe(oct.closing)
    for (const m of [sep, oct, nov]) {
      expect(m.opening + m.incoming_total - m.outgoing_total).toBe(m.closing)
      expect(m.net).toBe(m.incoming_total - m.outgoing_total)
    }
    // 月末の closing は、その月以降に入出金が無ければ口座残高と一致する
    expect(nov.closing).toBe(await totalBalance())
  })

  it('1回の入出金で複数の債務を消し込める（消し込んだ額が入出金に残る）', async () => {
    const purchase = await db.createLiability({
      kind: 'purchase', counterparty: 'メロジョイ', occurred_at: '2026-09-30', due_at: '2026-10-15', amount: 161505,
    })
    const loan = await db.createLiability({ kind: 'loan', counterparty: '夫', occurred_at: '2026-09-02', amount: 30000 })
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-09-03', direction: 'in', amount: 200000, category: 'loan_in' })

    const entryId = await db.createCashEntry({
      account_id: accountId, occurred_at: '2026-10-15', direction: 'out', amount: 191505, category: 'purchase_payment',
      settles: [{ liability_id: purchase, amount: 161505 }, { liability_id: loan, amount: 30000 }],
    })

    const byId = new Map((await db.listLiabilities()).map(l => [l.id, l]))
    expect(byId.get(purchase)).toMatchObject({ settled: 161505, remaining: 0 })
    expect(byId.get(loan)).toMatchObject({ settled: 30000, remaining: 0 })
    expect((await db.listCashEntries()).find(e => e.id === entryId)!.settles).toEqual([
      { liability_id: purchase, amount: 161505 }, { liability_id: loan, amount: 30000 },
    ])
    expect(await db.listLiabilities({ onlyOpen: true })).toHaveLength(0)
  })

  it('部分的に消し込める（¥161,505 のうち ¥100,000 → 残り ¥61,505）。続けて残りも払える', async () => {
    const purchase = await db.createLiability({
      kind: 'purchase', counterparty: 'メロジョイ', occurred_at: '2026-09-30', amount: 161505,
    })
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-09-03', direction: 'in', amount: 200000, category: 'loan_in' })
    await db.createCashEntry({
      account_id: accountId, occurred_at: '2026-10-15', direction: 'out', amount: 100000, category: 'purchase_payment',
      settles: [{ liability_id: purchase, amount: 100000 }],
    })
    expect((await db.listLiabilities()).find(l => l.id === purchase)).toMatchObject({ settled: 100000, remaining: 61505 })

    await db.createCashEntry({
      account_id: accountId, occurred_at: '2026-10-20', direction: 'out', amount: 61505, category: 'purchase_payment',
      settles: [{ liability_id: purchase, amount: 61505 }],
    })
    expect((await db.listLiabilities()).find(l => l.id === purchase)).toMatchObject({ settled: 161505, remaining: 0 })
  })

  it('消込の合計が債務の額を超えるとエラー（入出金は作られない）', async () => {
    const purchase = await db.createLiability({
      kind: 'purchase', counterparty: 'メロジョイ', occurred_at: '2026-09-30', amount: 161505,
    })
    await db.createCashEntry({
      account_id: accountId, occurred_at: '2026-10-15', direction: 'out', amount: 100000, category: 'purchase_payment',
      settles: [{ liability_id: purchase, amount: 100000 }],
    })
    const before = (await db.listCashEntries()).length
    // 残りは 61,505。61,506 は消せない
    await expect(db.createCashEntry({
      account_id: accountId, occurred_at: '2026-10-20', direction: 'out', amount: 70000, category: 'purchase_payment',
      settles: [{ liability_id: purchase, amount: 61506 }],
    })).rejects.toThrow('残り')
    expect(await db.listCashEntries()).toHaveLength(before)
    expect((await db.listLiabilities()).find(l => l.id === purchase)!.settled).toBe(100000)
  })

  it('入出金の額より多くは消し込めない。重複・入金への消込・0円も断る', async () => {
    const a = await db.createLiability({ kind: 'purchase', counterparty: 'A', occurred_at: '2026-09-30', amount: 80000 })
    const b = await db.createLiability({ kind: 'purchase', counterparty: 'B', occurred_at: '2026-09-30', amount: 80000 })
    const out = { account_id: accountId, occurred_at: '2026-10-15', direction: 'out' as const, category: 'purchase_payment' as const }
    // 合計 100,001 > 入出金 100,000
    await expect(db.createCashEntry({
      ...out, amount: 100000,
      settles: [{ liability_id: a, amount: 50001 }, { liability_id: b, amount: 50000 }],
    })).rejects.toThrow('超えています')
    await expect(db.createCashEntry({
      ...out, amount: 100000, settles: [{ liability_id: a, amount: 100 }, { liability_id: a, amount: 100 }],
    })).rejects.toThrow('2回')
    await expect(db.createCashEntry({
      ...out, amount: 100000, settles: [{ liability_id: a, amount: 0 }],
    })).rejects.toThrow()
    await expect(db.createCashEntry({
      account_id: accountId, occurred_at: '2026-10-15', direction: 'in', amount: 1000, category: 'other',
      settles: [{ liability_id: a, amount: 1000 }],
    })).rejects.toThrow('出金だけ')
    expect(await db.listCashEntries()).toHaveLength(0)
    // ちょうど入出金の額までなら通る
    await db.createCashEntry({ ...out, amount: 100000, settles: [{ liability_id: a, amount: 50000 }, { liability_id: b, amount: 50000 }] })
    expect((await db.listLiabilities()).map(l => l.settled)).toEqual([50000, 50000])
  })

  it('tool_share は根拠（販売・粗利・割合）を固定して保存する。タグを外しても・販売を消しても額は動かない', async () => {
    const saleId = await db.createSale({ title: 'ツール分の元になる販売', sold_at: '2026-09-10', price: 9000 })
    const tagId = await db.createTag('ツールA')
    await db.setSaleTags(saleId, [tagId])

    const id = await db.createLiability({
      kind: 'tool_share', counterparty: '夫', occurred_at: '2026-09-30',
      basis_sale_id: saleId, basis_amount: 4737, basis_rate_bp: 3000,
    })
    const created = (await db.listLiabilities()).find(l => l.id === id)!
    expect(created).toMatchObject({
      kind: 'tool_share', amount: 1421, remaining: 1421,
      basis_sale_id: saleId, basis_amount: 4737, basis_rate_bp: 3000,
    })

    // 紐付けの解除に相当する操作（タグを外す）と、販売そのものの削除
    await db.setSaleTags(saleId, [])
    await db.deleteSale(saleId)
    const after = (await db.listLiabilities()).find(l => l.id === id)!
    expect(after.amount).toBe(1421)
    expect(after.basis_amount).toBe(4737)
    expect(after.basis_rate_bp).toBe(3000)

    // 額と根拠は後から変えられない
    await expect(db.updateLiability(id, { amount: 2000 })).rejects.toThrow('変えられません')
  })

  it('tool_share は根拠が無い・額が根拠と食い違う・粗利がプラスでないと断る', async () => {
    const saleId = await db.createSale({ title: '販売', sold_at: '2026-09-10', price: 9000 })
    await expect(db.createLiability({
      kind: 'tool_share', counterparty: '夫', occurred_at: '2026-09-30', amount: 1421,
    })).rejects.toThrow('もとにした販売')
    await expect(db.createLiability({
      kind: 'tool_share', counterparty: '夫', occurred_at: '2026-09-30', amount: 1500,
      basis_sale_id: saleId, basis_amount: 4737, basis_rate_bp: 3000,
    })).rejects.toThrow('根拠から')
    await expect(db.createLiability({
      kind: 'tool_share', counterparty: '夫', occurred_at: '2026-09-30',
      basis_sale_id: saleId, basis_amount: -300, basis_rate_bp: 3000,
    })).rejects.toThrow('0円')
    await expect(db.createLiability({
      kind: 'tool_share', counterparty: '夫', occurred_at: '2026-09-30',
      basis_sale_id: 'no-such-sale', basis_amount: 4737, basis_rate_bp: 3000,
    })).rejects.toThrow('見つかりません')
    await expect(db.createLiability({
      kind: 'loan', counterparty: '夫', occurred_at: '2026-09-30', amount: 1000, basis_amount: 1,
    })).rejects.toThrow('ツール分だけ')
    expect(await db.listLiabilities()).toHaveLength(0)
  })

  it('債務の額は消込済みより小さくできない。消込のある債務は消せず、入出金を消すと消込も外れる', async () => {
    const purchase = await db.createLiability({ kind: 'purchase', counterparty: 'メロジョイ', occurred_at: '2026-09-30', amount: 100000 })
    const entryId = await db.createCashEntry({
      account_id: accountId, occurred_at: '2026-10-15', direction: 'out', amount: 60000, category: 'purchase_payment',
      settles: [{ liability_id: purchase, amount: 60000 }],
    })
    await expect(db.updateLiability(purchase, { amount: 59999 })).rejects.toThrow('消し込み済み')
    await db.updateLiability(purchase, { amount: 90000, due_at: '2026-10-20' })
    expect((await db.listLiabilities())[0]).toMatchObject({ amount: 90000, settled: 60000, remaining: 30000, due_at: '2026-10-20' })
    await expect(db.deleteLiability(purchase)).rejects.toThrow('消せません')

    await db.deleteCashEntry(entryId)
    expect((await db.listLiabilities())[0]).toMatchObject({ settled: 0, remaining: 90000 })
    expect(await A((c) => c.sql.get('select count(*) as c from liability_settlement'))).toEqual({ c: 0 })
    expect(await balance(accountId)).toBe(0)
    await db.deleteLiability(purchase)
    expect(await db.listLiabilities()).toHaveLength(0)
  })

  it('transfer（口座間の移動）は月の入金にも出金にも出るが、全体の残高は動かない', async () => {
    const flea = await db.createCashAccount({ name: 'フリマの売上金', kind: 'flea', opening_balance: 20000, opening_date: '2026-09-01' })
    const before = await db.getCashMonth('2026-09')
    expect(before.closing).toBe(20000)

    await db.createCashEntry({ account_id: flea, occurred_at: '2026-09-12', direction: 'out', amount: 15000, category: 'transfer' })
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-09-12', direction: 'in', amount: 15000, category: 'transfer' })

    const after = await db.getCashMonth('2026-09')
    expect(after.incoming).toEqual([{ category: 'transfer', label: '口座間の移動', amount: 15000 }])
    expect(after.outgoing).toEqual([{ category: 'transfer', label: '口座間の移動', amount: 15000 }])
    expect(after.net).toBe(0)
    expect(after.closing).toBe(before.closing)
    expect(await totalBalance()).toBe(20000)
    expect(await balance(flea)).toBe(5000)
    expect(await balance(accountId)).toBe(15000)
  })

  it('free_cash ＝ closing − upcoming_total。期限前の債務も数える。月末より後の発生・支払いは数えない', async () => {
    const purchase = await db.createLiability({
      kind: 'purchase', counterparty: 'メロジョイ', occurred_at: '2026-09-30', due_at: '2026-10-15', amount: 161505,
    })
    await db.createLiability({ kind: 'loan', counterparty: '夫', occurred_at: '2026-10-02', amount: 50000 })
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-09-20', direction: 'in', amount: 200000, category: 'loan_in' })
    await db.createCashEntry({
      account_id: accountId, occurred_at: '2026-10-15', direction: 'out', amount: 100000, category: 'purchase_payment',
      settles: [{ liability_id: purchase, amount: 100000 }],
    })

    const sep = await db.getCashMonth('2026-09')
    expect(sep.closing).toBe(200000)
    // 9月末の時点では 10/15 の支払いも、10/02 の借入もまだ無い
    expect(sep.upcoming).toEqual([
      { liability_id: purchase, kind: 'purchase', counterparty: 'メロジョイ', due_at: '2026-10-15', remaining: 161505 },
    ])
    expect(sep.upcoming_total).toBe(161505)
    expect(sep.free_cash).toBe(sep.closing - sep.upcoming_total)
    expect(sep.free_cash).toBe(38495)

    const oct = await db.getCashMonth('2026-10')
    expect(oct.closing).toBe(100000)
    expect(oct.upcoming_total).toBe(61505 + 50000)
    expect(oct.free_cash).toBe(oct.closing - oct.upcoming_total)
  })

  it('実データに近い1か月（口座0円・入金¥44,620・仕入の債務¥161,505・ツール分¥1,421）', async () => {
    const saleId = await db.createSale({ title: '9月の販売', sold_at: '2026-09-15', price: 9000 })
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-09-25', direction: 'in', amount: 44620, category: 'sale_payout' })
    const purchase = await db.createLiability({
      kind: 'purchase', counterparty: 'メロジョイ', occurred_at: '2026-09-30', due_at: '2026-10-15', amount: 161505,
    })
    const tool = await db.createLiability({
      kind: 'tool_share', counterparty: '夫', occurred_at: '2026-09-30',
      basis_sale_id: saleId, basis_amount: 4737, basis_rate_bp: 3000,
    })

    expect(await db.getCashMonth('2026-09')).toEqual({
      month: '2026-09',
      opening: 0,
      incoming: [{ category: 'sale_payout', label: 'フリマの売上金', amount: 44620 }],
      incoming_total: 44620,
      outgoing: [],
      outgoing_total: 0,
      net: 44620,
      closing: 44620,
      upcoming: [
        { liability_id: purchase, kind: 'purchase', counterparty: 'メロジョイ', due_at: '2026-10-15', remaining: 161505 },
        { liability_id: tool, kind: 'tool_share', counterparty: '夫', due_at: null, remaining: 1421 },
      ],
      upcoming_total: 162926,
      free_cash: 44620 - 162926,
    })
  })

  it('月の途中から数え始める口座があっても opening + 入金 − 出金 = closing', async () => {
    const late = await db.createCashAccount({ name: '現金', kind: 'cash', opening_balance: 3000, opening_date: '2026-09-15' })
    await db.createCashEntry({ account_id: late, occurred_at: '2026-09-20', direction: 'out', amount: 500, category: 'expense' })
    const m = await db.getCashMonth('2026-09')
    expect(m.opening).toBe(3000)
    expect(m.closing).toBe(2500)
    expect(m.opening + m.incoming_total - m.outgoing_total).toBe(m.closing)
    expect(m.closing).toBe(await totalBalance())
  })

  it('口座の更新：起点より前の入出金が残るときは日付を後ろにできない。残高の列は書き換えられない', async () => {
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-09-05', direction: 'in', amount: 1000, category: 'other' })
    await expect(db.updateCashAccount(accountId, { opening_date: '2026-09-10' })).rejects.toThrow('より前の入出金')
    await db.updateCashAccount(accountId, { name: '改名', opening_balance: 500, is_active: 0 })
    expect((await db.listCashAccounts())[0]).toMatchObject({ name: '改名', opening_balance: 500, is_active: 0, balance: 1500 })
  })

  it('既存の損益（sale / sale_line / expense / month_book）には触らない', async () => {
    const saleId = await db.createSale({ title: '販売', sold_at: '2026-09-10', price: 9000 })
    const snapshot = async () => JSON.stringify(await A(async (c) => {
      const rows = (table: string) => c.sql.all(`select to_jsonb(t) as r from ${table} t order by 1`)
      return {
        sale: await rows('sale'), line: await rows('sale_line'), expense: await rows('expense'),
        book: await rows('month_book'), profit: await rows('sale_profit'),
      }
    }))
    const before = await snapshot()
    await db.createLiability({ kind: 'tool_share', counterparty: '夫', occurred_at: '2026-09-30', basis_sale_id: saleId, basis_amount: 4737, basis_rate_bp: 3000 })
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-09-25', direction: 'in', amount: 44620, category: 'sale_payout' })
    await db.getCashMonth('2026-09')
    expect(await snapshot()).toBe(before)
  })
})

// ============================================================
// Postgres に移したことで足したテスト
// ============================================================
describe('お金の出入り：Postgres で足すもの', () => {
  let accountId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    accountId = await db.createCashAccount({ name: '銀行', kind: 'bank', opening_balance: 1000, opening_date: '2026-01-01' })
  })

  it('月の最後の日まで数える（2 月・うるう年の 2 月・31 日の月）。デスクトップ版の `${month}-31` は Postgres の date に入らない', async () => {
    const e = (occurred_at: string, amount: number) =>
      db.createCashEntry({ account_id: accountId, occurred_at, direction: 'in', amount, category: 'other' })
    await e('2027-01-31', 1)
    await e('2027-02-01', 10)
    await e('2027-02-28', 100)
    await e('2027-03-01', 1000)
    await e('2028-02-29', 10000)
    await e('2028-03-01', 100000)

    const feb = await db.getCashMonth('2027-02')
    expect(feb.incoming_total).toBe(110)
    expect(feb.opening).toBe(1000 + 1)
    expect(feb.closing).toBe(1000 + 1 + 110)
    expect((await db.listCashEntries('2027-02')).map(x => x.amount).sort((p, q) => p - q)).toEqual([10, 100])

    const leap = await db.getCashMonth('2028-02')
    expect(leap.incoming_total).toBe(10000)
    expect((await db.listCashEntries('2028-02')).map(x => x.amount)).toEqual([10000])

    expect((await db.getCashMonth('2027-01')).incoming_total).toBe(1)
    expect((await db.listCashEntries('2027-03')).map(x => x.amount)).toEqual([1000])
  })

  it('消込は入力した順に返る（債務の作成順や id の順ではない）', async () => {
    const first = await db.createLiability({ kind: 'loan', counterparty: '先', occurred_at: '2026-02-01', amount: 5000 })
    const second = await db.createLiability({ kind: 'loan', counterparty: '後', occurred_at: '2026-02-02', amount: 5000 })
    const third = await db.createLiability({ kind: 'loan', counterparty: '三', occurred_at: '2026-02-03', amount: 5000 })
    const settles = [
      { liability_id: third, amount: 300 }, { liability_id: first, amount: 100 }, { liability_id: second, amount: 200 },
    ]
    const entryId = await db.createCashEntry({
      account_id: accountId, occurred_at: '2026-02-10', direction: 'out', amount: 600, category: 'loan_repay', settles,
    })
    expect((await db.listCashEntries()).find(x => x.id === entryId)!.settles).toEqual(settles)
    expect((await db.listCashEntries('2026-02')).find(x => x.id === entryId)!.settles).toEqual(settles)
  })

  it('並びは SQLite と同じ：口座は sort_order（作った順）、入出金は日付の新しい順→作った新しい順、債務は期限（無いものは最後）→発生日→作った順', async () => {
    const second = await db.createCashAccount({ name: '二番目', kind: 'cash', opening_balance: 0, opening_date: '2026-01-01' })
    const third = await db.createCashAccount({ name: '三番目', kind: 'cash', opening_balance: 0, opening_date: '2026-01-01' })
    expect((await db.listCashAccounts()).map(a => a.id)).toEqual([accountId, second, third])

    const e1 = await db.createCashEntry({ account_id: accountId, occurred_at: '2026-03-05', direction: 'in', amount: 1, category: 'other' })
    const e2 = await db.createCashEntry({ account_id: accountId, occurred_at: '2026-03-05', direction: 'in', amount: 2, category: 'other' })
    const e3 = await db.createCashEntry({ account_id: accountId, occurred_at: '2026-03-06', direction: 'in', amount: 3, category: 'other' })
    expect((await db.listCashEntries()).map(x => x.id)).toEqual([e3, e2, e1])

    const noDue1 = await db.createLiability({ kind: 'loan', counterparty: '期限なし1', occurred_at: '2026-03-01', amount: 1 })
    const due = await db.createLiability({ kind: 'loan', counterparty: '期限あり', occurred_at: '2026-03-09', due_at: '2026-04-01', amount: 1 })
    const noDue0 = await db.createLiability({ kind: 'loan', counterparty: '期限なし0', occurred_at: '2026-02-01', amount: 1 })
    const noDue2 = await db.createLiability({ kind: 'loan', counterparty: '期限なし2', occurred_at: '2026-03-01', amount: 1 })
    expect((await db.listLiabilities()).map(l => l.id)).toEqual([due, noDue0, noDue1, noDue2])
    expect((await db.listLiabilities({ kind: 'loan' })).map(l => l.id)).toEqual([due, noDue0, noDue1, noDue2])
    expect(await db.listLiabilities({ kind: 'purchase' })).toEqual([])
  })

  it('値は契約の型（金額は number、日付は YYYY-MM-DD の文字列）で、JSON にできる', async () => {
    const entryId = await db.createCashEntry({ account_id: accountId, occurred_at: '2026-04-02', direction: 'in', amount: 1234, category: 'sale_payout' })
    const liabilityId = await db.createLiability({ kind: 'purchase', counterparty: 'メロジョイ', occurred_at: '2026-04-30', due_at: '2026-05-15', amount: 9999 })
    const [account] = await db.listCashAccounts()
    expect(account).toEqual({
      id: accountId, name: '銀行', kind: 'bank', opening_balance: 1000, opening_date: '2026-01-01',
      sort_order: 1, is_active: 1, balance: 2234,
    })
    const entry = (await db.listCashEntries()).find(x => x.id === entryId)!
    expect(entry).toMatchObject({ occurred_at: '2026-04-02', amount: 1234, account_name: '銀行', sale_id: null, note: null, settles: [] })
    expect(entry.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/)
    const liability = (await db.listLiabilities()).find(x => x.id === liabilityId)!
    expect(liability).toMatchObject({ occurred_at: '2026-04-30', due_at: '2026-05-15', amount: 9999, settled: 0, remaining: 9999, month: '2026-04' })
    expect(() => JSON.stringify([account, entry, liability])).not.toThrow()
  })

  it('メモは前後の空白を除き、空なら null。債務の更新で消せる', async () => {
    const entryId = await db.createCashEntry({ account_id: accountId, occurred_at: '2026-04-02', direction: 'in', amount: 10, category: 'other', note: '  メモ  ' })
    expect((await db.listCashEntries()).find(x => x.id === entryId)!.note).toBe('メモ')
    const blank = await db.createCashEntry({ account_id: accountId, occurred_at: '2026-04-02', direction: 'in', amount: 10, category: 'other', note: '   ' })
    expect((await db.listCashEntries()).find(x => x.id === blank)!.note).toBeNull()

    const id = await db.createLiability({ kind: 'loan', counterparty: '夫', occurred_at: '2026-04-01', amount: 100, note: '借りた' })
    await db.updateLiability(id, { note: null, due_at: '2026-05-01' })
    expect((await db.listLiabilities())[0]).toMatchObject({ note: null, due_at: '2026-05-01' })
    await db.updateLiability(id, { due_at: null })
    expect((await db.listLiabilities())[0].due_at).toBeNull()
  })

  it('purchase の債務は月（どの月ぶんか）を持つ。省略すると発生日の月。loan は月を持てない', async () => {
    const p = await db.createLiability({ kind: 'purchase', counterparty: 'メロジョイ', occurred_at: '2026-09-30', amount: 100 })
    expect((await db.listLiabilities()).find(l => l.id === p)!.month).toBe('2026-09')
    await db.updateLiability(p, { month: '2026-08' })
    expect((await db.listLiabilities()).find(l => l.id === p)!.month).toBe('2026-08')
    await db.updateLiability(p, { month: null })
    expect((await db.listLiabilities()).find(l => l.id === p)!.month).toBe('2026-09')
    const loan = await db.createLiability({ kind: 'loan', counterparty: '夫', occurred_at: '2026-09-02', amount: 100 })
    await expect(db.updateLiability(loan, { month: '2026-09' })).rejects.toThrow('仕入だけ')
    await db.updateLiability(loan, { month: null })
  })

  it('21 億円（integer の上限）を超える金額は、DB まで届かず日本語で断る', async () => {
    await expect(db.createCashEntry({
      account_id: accountId, occurred_at: '2026-04-02', direction: 'in', amount: 2_147_483_648, category: 'other',
    })).rejects.toThrow('大きすぎます')
    await expect(db.createCashAccount({
      name: '大きい', kind: 'bank', opening_balance: 2_147_483_648, opening_date: '2026-01-01',
    })).rejects.toThrow('大きすぎます')
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-04-02', direction: 'in', amount: 2_147_483_647, category: 'other' })
    // 合計が integer を超えても、残高・月の集計は bigint で数える
    await db.createCashEntry({ account_id: accountId, occurred_at: '2026-04-03', direction: 'in', amount: 2_147_483_647, category: 'other' })
    expect((await db.getCashMonth('2026-04')).incoming_total).toBe(2_147_483_647 * 2)
    expect((await db.listCashAccounts())[0].balance).toBe(1000 + 2_147_483_647 * 2)
  })

  it('消込を足すと検索用の列（settle_order）が増えるが、契約の CashEntry.settles には出ない', async () => {
    const liabilityId = await db.createLiability({ kind: 'loan', counterparty: '夫', occurred_at: '2026-04-01', amount: 100 })
    await db.createCashEntry({
      account_id: accountId, occurred_at: '2026-04-02', direction: 'out', amount: 50, category: 'loan_repay',
      settles: [{ liability_id: liabilityId, amount: 50 }],
    })
    const [entry] = await db.listCashEntries()
    expect(entry.settles).toEqual([{ liability_id: liabilityId, amount: 50 }])
    expect(Object.keys(entry).sort()).toEqual(
      ['account_id', 'account_name', 'amount', 'category', 'created_at', 'direction', 'id', 'note', 'occurred_at', 'sale_id', 'settles'],
    )
  })

  it('消し込み済みの額を引いた残りまでしか消し込めない（債務の行を押さえて、残りを見てから書く）', async () => {
    const liabilityId = await db.createLiability({ kind: 'loan', counterparty: '夫', occurred_at: '2026-04-01', amount: 100 })
    const entry = (amount: number): CashEntryInput => ({
      account_id: accountId, occurred_at: '2026-04-02', direction: 'out', amount, category: 'loan_repay',
      settles: [{ liability_id: liabilityId, amount }],
    })
    await db.createCashEntry(entry(60))
    await expect(db.createCashEntry(entry(60))).rejects.toThrow('残り')
    await db.createCashEntry(entry(40))
    expect((await db.listLiabilities())[0]).toMatchObject({ settled: 100, remaining: 0 })
  })
})

// ============================================================
// 世帯の分離：B から A の行は、id を知っていても見えない・書けない
// ============================================================
describe('お金の出入り：世帯の分離（B から A の行が見えない・書けない）', () => {
  let accountId: string
  let liabilityId: string
  let entryId: string
  let saleId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    accountId = await db.createCashAccount({ name: 'Aの銀行', kind: 'bank', opening_balance: 10000, opening_date: '2026-09-01' })
    liabilityId = await db.createLiability({ kind: 'purchase', counterparty: 'Aの仕入', occurred_at: '2026-09-30', due_at: '2026-10-15', amount: 5000 })
    entryId = await db.createCashEntry({
      account_id: accountId, occurred_at: '2026-10-01', direction: 'out', amount: 2000, category: 'purchase_payment',
      settles: [{ liability_id: liabilityId, amount: 2000 }],
    })
    saleId = await db.createSale({ title: 'Aの販売', sold_at: '2026-09-10', price: 9000 })
  })

  const B = <T>(fn: (ctx: Ctx) => Promise<T>) => w.b.run(fn)

  it('B の一覧・月の明細に A の行も金額も出ない', async () => {
    expect(await B((c) => cash.listCashAccounts(c))).toEqual([])
    expect(await B((c) => cash.listLiabilities(c))).toEqual([])
    expect(await B((c) => cash.listCashEntries(c))).toEqual([])
    expect(await B((c) => cash.listCashEntries(c, '2026-10'))).toEqual([])
    for (const month of ['2026-09', '2026-10']) {
      expect(await B((c) => cash.getCashMonth(c, month))).toEqual({
        month, opening: 0, incoming: [], incoming_total: 0, outgoing: [], outgoing_total: 0, net: 0, closing: 0,
        upcoming: [], upcoming_total: 0, free_cash: 0,
      })
    }
    // A 側は変わっていない
    expect((await db.getCashMonth('2026-10')).outgoing_total).toBe(2000)
    expect((await db.listLiabilities())[0]).toMatchObject({ settled: 2000, remaining: 3000 })
  })

  it('B から A の口座・債務・入出金を、id を知っていても変えられない（404）', async () => {
    await expect(B((c) => cash.updateCashAccount(c, accountId, { name: '乗っ取り' }))).rejects.toMatchObject({ code: 'not_found', message: '口座が見つかりません' })
    await expect(B((c) => cash.updateLiability(c, liabilityId, { amount: 1 }))).rejects.toMatchObject({ code: 'not_found', message: '債務が見つかりません' })
    await expect(B((c) => cash.deleteLiability(c, liabilityId))).rejects.toMatchObject({ code: 'not_found' })
    await expect(B((c) => cash.deleteCashEntry(c, entryId))).rejects.toMatchObject({ code: 'not_found', message: '入出金が見つかりません' })

    expect((await db.listCashAccounts())[0].name).toBe('Aの銀行')
    expect((await db.listLiabilities())[0]).toMatchObject({ amount: 5000, settled: 2000 })
    expect(await db.listCashEntries()).toHaveLength(1)
  })

  it('B の入出金を A の口座に作れない。A の債務を消し込めない。A の販売を根拠にできない', async () => {
    const bAccount = await B((c) => cash.createCashAccount(c, { name: 'Bの銀行', kind: 'bank', opening_balance: 0, opening_date: '2026-09-01' }))
    await expect(B((c) => cash.createCashEntry(c, {
      account_id: accountId, occurred_at: '2026-10-02', direction: 'in', amount: 100, category: 'other',
    }))).rejects.toMatchObject({ code: 'not_found', message: '口座が見つかりません' })
    await expect(B((c) => cash.createCashEntry(c, {
      account_id: bAccount, occurred_at: '2026-10-02', direction: 'out', amount: 100, category: 'purchase_payment',
      settles: [{ liability_id: liabilityId, amount: 100 }],
    }))).rejects.toMatchObject({ code: 'not_found', message: '債務が見つかりません' })
    await expect(B((c) => cash.createLiability(c, {
      kind: 'tool_share', counterparty: '夫', occurred_at: '2026-09-30', basis_sale_id: saleId, basis_amount: 4737, basis_rate_bp: 3000,
    }))).rejects.toMatchObject({ code: 'not_found', message: 'もとにした販売が見つかりません' })

    expect(await B((c) => cash.listCashEntries(c))).toEqual([])
    expect((await db.listLiabilities())[0].settled).toBe(2000)
  })

  it('SQL を直接書いても、他の世帯の口座に入出金は付けられない（外部キーは世帯をまたげない）。世帯 id の偽装も RLS が止める', async () => {
    const fk = await B((c) => c.sql.run(
      `insert into cash_entry (account_id, occurred_at, direction, amount, category) values (?, '2026-10-02', 'in', 100, 'other')`, accountId,
    )).then(() => undefined, (e: unknown) => e)
    expect((fk as { code?: string }).code).toBe('23503')
    const rls = await B((c) => c.sql.run(
      `insert into cash_account (household_id, name, opening_date) values (?, '偽装', '2026-01-01')`, w.a.householdId,
    )).then(() => undefined, (e: unknown) => e)
    expect((rls as { code?: string }).code).toBe('42501')
    expect(await db.listCashAccounts()).toHaveLength(1)
  })
})

// ============================================================
// API の入口（dispatch）経由：登録が効いていて、変な引数は 400（500 にならない）
// ============================================================
describe('お金の出入り：API として登録されている（dispatch 経由）', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  const ghost = '00000000-0000-4000-8000-0000000000aa'

  it('11 本が登録されていて、JSON の応答が返る', async () => {
    const account = await w.a.call('createCashAccount', { name: '銀行', kind: 'bank', opening_balance: 1000, opening_date: '2026-09-01' })
    expect(account.status).toBe(200)
    const accountId = account.body.result as string
    expect((await w.a.call('updateCashAccount', accountId, { name: '改名' })).body).toEqual({ result: null })
    expect((await w.a.call('listCashAccounts')).body.result).toEqual([
      { id: accountId, name: '改名', kind: 'bank', opening_balance: 1000, opening_date: '2026-09-01', sort_order: 1, is_active: 1, balance: 1000 },
    ])

    const liabilityId = (await w.a.call('createLiability', { kind: 'loan', counterparty: '夫', occurred_at: '2026-09-02', amount: 300 })).body.result as string
    expect((await w.a.call('updateLiability', liabilityId, { amount: 400 })).status).toBe(200)
    expect(((await w.a.call('listLiabilities', { kind: 'loan', onlyOpen: true })).body.result as Array<{ remaining: number }>)[0].remaining).toBe(400)
    expect(((await w.a.call('listLiabilities', null)).body.result as unknown[])).toHaveLength(1)

    const entryId = (await w.a.call('createCashEntry', {
      account_id: accountId, occurred_at: '2026-09-05', direction: 'out', amount: 400, category: 'loan_repay',
      settles: [{ liability_id: liabilityId, amount: 400 }],
    })).body.result as string
    const entries = (await w.a.call('listCashEntries', '2026-09')).body.result as Array<{ id: string; settles: unknown[] }>
    expect(entries.map(e => e.id)).toEqual([entryId])
    expect(entries[0].settles).toEqual([{ liability_id: liabilityId, amount: 400 }])
    expect(((await w.a.call('listCashEntries')).body.result as unknown[])).toHaveLength(1)
    expect(((await w.a.call('listCashEntries', null)).body.result as unknown[])).toHaveLength(1)

    expect((await w.a.call('getCashMonth', '2026-09')).body.result).toMatchObject({
      opening: 1000, outgoing_total: 400, closing: 600, upcoming: [], free_cash: 600,
    })
    expect((await w.a.call('deleteCashEntry', entryId)).body).toEqual({ result: null })
    expect((await w.a.call('deleteLiability', liabilityId)).body).toEqual({ result: null })
  })

  it.each([
    ['createCashAccount', [null]],
    ['createCashAccount', ['銀行']],
    ['createCashAccount', [[]]],
    ['createCashAccount', [{}]],
    ['createCashAccount', [{ name: 5, kind: 'bank', opening_balance: 0, opening_date: '2026-09-01' }]],
    ['createCashAccount', [{ name: '銀行', kind: 'bogus', opening_balance: 0, opening_date: '2026-09-01' }]],
    ['createCashAccount', [{ name: '銀行', kind: 'bank', opening_balance: '0', opening_date: '2026-09-01' }]],
    ['createCashAccount', [{ name: '銀行', kind: 'bank', opening_balance: -1, opening_date: '2026-09-01' }]],
    ['createCashAccount', [{ name: '銀行', kind: 'bank', opening_balance: 1.5, opening_date: '2026-09-01' }]],
    ['createCashAccount', [{ name: '銀行', kind: 'bank', opening_balance: 0, opening_date: '2026-02-30' }]],
    ['createCashAccount', [{ name: '銀行', kind: 'bank', opening_balance: 0, opening_date: 20260901 }]],
    ['updateCashAccount', ['bad', {}]],
    ['updateCashAccount', [ghost, 'x']],
    ['updateCashAccount', [ghost, null]],
    ['listLiabilities', ['x']],
    ['listLiabilities', [{ kind: 'bogus' }]],
    ['listLiabilities', [{ onlyOpen: 'yes' }]],
    ['createLiability', [null]],
    ['createLiability', [{ kind: 'loan' }]],
    ['createLiability', [{ kind: 'bogus', counterparty: '夫', occurred_at: '2026-09-02', amount: 1 }]],
    ['createLiability', [{ kind: 'loan', counterparty: 7, occurred_at: '2026-09-02', amount: 1 }]],
    ['createLiability', [{ kind: 'loan', counterparty: '夫', occurred_at: '2026-13-02', amount: 1 }]],
    ['createLiability', [{ kind: 'loan', counterparty: '夫', occurred_at: '2026-09-02', amount: 'x' }]],
    ['createLiability', [{ kind: 'loan', counterparty: '夫', occurred_at: '2026-09-02', amount: 1, due_at: 'soon' }]],
    ['createLiability', [{ kind: 'loan', counterparty: '夫', occurred_at: '2026-09-02', amount: 1, note: 5 }]],
    ['createLiability', [{ kind: 'purchase', counterparty: '店', occurred_at: '2026-09-02', amount: 1, month: '2026-13' }]],
    ['createLiability', [{ kind: 'tool_share', counterparty: '夫', occurred_at: '2026-09-02', basis_sale_id: ghost, basis_amount: 'x', basis_rate_bp: 3000 }]],
    ['createLiability', [{ kind: 'tool_share', counterparty: '夫', occurred_at: '2026-09-02', basis_sale_id: ghost, basis_amount: 100, basis_rate_bp: 0 }]],
    ['createLiability', [{ kind: 'tool_share', counterparty: '夫', occurred_at: '2026-09-02', basis_sale_id: { a: 1 }, basis_amount: 100, basis_rate_bp: 3000 }]],
    ['updateLiability', ['bad', {}]],
    ['updateLiability', [ghost, 5]],
    ['updateLiability', [ghost, { due_at: 'soon' }]],
    ['deleteLiability', [1]],
    ['deleteLiability', [null]],
    ['listCashEntries', [5]],
    ['listCashEntries', ['2026-13']],
    ['listCashEntries', [{}]],
    ['createCashEntry', [null]],
    ['createCashEntry', ['x']],
    ['createCashEntry', [[]]],
    ['createCashEntry', [{ account_id: 'bad' }]],
    ['createCashEntry', [{ account_id: ghost, occurred_at: '2026-09-05', direction: 'in', amount: 100, category: 'other' }]],
    ['deleteCashEntry', [null]],
    ['deleteCashEntry', ['bad']],
    ['getCashMonth', []],
    ['getCashMonth', [null]],
    ['getCashMonth', ['2026-13']],
    ['getCashMonth', [202609]],
    ['getCashMonth', [{}]],
  ])('変な引数は 400 か 404 の UserError（500 にならない）：%s %j', async (method, args) => {
    const r = await w.a.call(method, ...args)
    expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400)
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(500)
    expect(r.body.error?.message).toBeTruthy()
    expect(r.body.error?.message).not.toContain('サーバーでエラー')
  })

  it('入出金の変な引数（消し込み・向き・区分・メモ）も 400', async () => {
    const accountId = (await w.a.call('createCashAccount', { name: '銀行', kind: 'bank', opening_balance: 0, opening_date: '2026-09-01' })).body.result as string
    const base = { account_id: accountId, occurred_at: '2026-09-05', direction: 'out', amount: 100, category: 'allowance' }
    const bad: Array<Record<string, unknown>> = [
      { ...base, settles: 'x' },
      { ...base, settles: [null] },
      { ...base, settles: [{ liability_id: 'bad', amount: 1 }] },
      { ...base, settles: [{ liability_id: ghostId(), amount: 'x' }] },
      { ...base, settles: Array.from({ length: 101 }, () => ({ liability_id: ghostId(), amount: 1 })) },
      { ...base, direction: 'sideways' },
      { ...base, direction: 5 },
      { ...base, category: 'bogus' },
      { ...base, category: 5 },
      { ...base, note: 5 },
      { ...base, note: 'x'.repeat(2001) },
      { ...base, amount: 2_147_483_648 },
      { ...base, occurred_at: '2026-9-5' },
    ]
    for (const input of bad) {
      const r = await w.a.call('createCashEntry', input)
      expect(r.status, JSON.stringify(input).slice(0, 80)).toBe(400)
    }
    expect(((await w.a.call('listCashEntries')).body.result as unknown[])).toHaveLength(0)
  })
})

function ghostId(): string {
  return '00000000-0000-4000-8000-0000000000bb'
}
