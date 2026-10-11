import type { Ctx } from '../context'
import { UserError } from '../errors'
import { registerHandler } from '../rpc'
import type {
  CashAccount, CashAccountInput, CashAccountKind, CashAccountPatch, CashCategory, CashEntry, CashEntryInput, CashMonth,
  Liability, LiabilityInput, LiabilityKind, LiabilityPatch,
} from '../../src/shared/types'
import {
  argArray, argEnum, argId, argInt, argMonth, argNullableDate, argNullableMonth, argNullableText, argObject, argOptBool,
  argOptDate, argOptEnum, argOptFlag, argOptInt, argOptMonth, argOptObject, argOptText, argOptYen, argText,
  assertDateText, assertMonthText, assertPositiveYen, assertYen, isUuid, monthBounds, toolShareAmount, trimOrNull,
  yenText,
} from './_shared'

// ============================================================
// お金の出入り（資金繰り）
//
// 損益（sale_profit / monthly_summary / month_book）とは別の層。sale / sale_line /
// inventory_item / expense / month_book は書き換えない（債務を作るときの basis_sale_id の
// 存在確認で sale を引くだけ）。src/main/db.ts の同名の関数の移植。
//
//   * 残高は持たない。cash_account.opening_balance（opening_date の朝の残高）に
//     cash_entry を積んで出す。opening_date より前の入出金は作れない（残高に数えないため）
//   * 消込は liability_settlement（1回の振込で複数の債務を払える）。
//     債務ごとの消込合計 ≤ 債務の額、入出金ごとの消込合計 ≤ 入出金の額
//   * tool_share は根拠（basis_*）を作るときに固定する。タグから再計算しない
//   * transfer（口座間の移動）は出す側と入れる側の2件を作る。両方で全体の残高は動かない
//
// SQLite の rowid（挿入順）で決めていた並びは、created_at を insert のたびの時計（clock_timestamp()。
// now() はトランザクションの開始時刻で同じになる）で入れて、それで決める。消込だけは settle_order
// （20261012001000 で足した、挿入のたびに増える番号）。
// ============================================================

const CASH_ACCOUNT_KINDS: readonly CashAccountKind[] = ['bank', 'flea', 'cash', 'other']

/** 画面に出す順。月の明細の小計もこの順で並べる */
const CASH_CATEGORY_ORDER: readonly CashCategory[] = [
  'sale_payout', 'purchase_payment', 'loan_in', 'loan_repay', 'tool_share',
  'allowance', 'expense', 'transfer', 'other',
]

const CASH_CATEGORY_LABEL: Record<CashCategory, string> = {
  sale_payout: 'フリマの売上金',
  purchase_payment: '仕入の支払い',
  loan_in: '借りた',
  loan_repay: '返した',
  tool_share: 'ツール分',
  allowance: 'お小遣い',
  expense: '経費',
  transfer: '口座間の移動',
  other: 'その他',
}

/** 区分ごとの向き。null＝どちらでもよい */
const CASH_CATEGORY_DIRECTION: Record<CashCategory, 'in' | 'out' | null> = {
  sale_payout: 'in',
  purchase_payment: 'out',
  loan_in: 'in',
  loan_repay: 'out',
  tool_share: 'out',
  allowance: 'out',
  expense: 'out',
  transfer: null,
  other: null,
}

const LIABILITY_KINDS: readonly LiabilityKind[] = ['loan', 'tool_share', 'purchase']

const NAME_MAX = 100
const NOTE_MAX = 2000
/** 1 回の入出金で消し込める債務の数の上限（画面はせいぜい数件） */
const SETTLES_MAX = 100

// ---- 口座 ----

const CASH_ACCOUNT_SELECT = `
  select a.id, a.name, a.kind, a.opening_balance, a.opening_date, a.sort_order, a.is_active,
         a.opening_balance + coalesce((
           select sum(case e.direction when 'in' then e.amount else -e.amount end)
             from cash_entry e
            where e.household_id = a.household_id and e.account_id = a.id and e.occurred_at >= a.opening_date
         ), 0) as balance
    from cash_account a
`

export async function listCashAccounts(ctx: Ctx): Promise<CashAccount[]> {
  return ctx.sql.all<CashAccount>(`${CASH_ACCOUNT_SELECT} order by a.sort_order, a.created_at, a.id`)
}

export async function createCashAccount(ctx: Ctx, input: CashAccountInput): Promise<string> {
  const o = argObject('口座', input)
  const name = argText('口座の名前', o.name, { max: NAME_MAX }).trim()
  if (!name) throw new UserError('口座の名前を入力してください')
  const kind = argEnum('口座の種類', o.kind, CASH_ACCOUNT_KINDS)
  assertYen('はじめの残高', o.opening_balance)
  assertDateText('残高の日付', o.opening_date)

  const next = await ctx.sql.get<{ n: number }>('select coalesce(max(sort_order), 0) + 1 as n from cash_account')
  const row = await ctx.sql.get<{ id: string }>(
    `insert into cash_account (name, kind, opening_balance, opening_date, sort_order, created_at)
     values (?, ?, ?, ?, ?, clock_timestamp()) returning id`,
    name, kind, o.opening_balance, o.opening_date, next?.n ?? 1,
  )
  return row!.id
}

/**
 * 残高の列は無い。直せるのは「どの日のいくらから積み始めるか」（opening_*）だけ。
 * その日より前の入出金が残っているときは断る（残高に数えられなくなるため）
 */
export async function updateCashAccount(ctx: Ctx, id: string, patch: CashAccountPatch): Promise<void> {
  const accountId = argId('口座', id)
  const p = argObject('口座の変更内容', patch)
  const cur = await ctx.sql.get<{
    name: string; kind: CashAccountKind; opening_balance: number; opening_date: string; sort_order: number; is_active: number
  }>('select name, kind, opening_balance, opening_date, sort_order, is_active from cash_account where id = ?', accountId)
  if (!cur) throw new UserError('口座が見つかりません', 'not_found')

  const newName = argOptText('口座の名前', p.name, { max: NAME_MAX })
  const name = newName !== undefined ? newName.trim() : cur.name
  if (!name) throw new UserError('口座の名前を入力してください')
  const kind = argOptEnum('口座の種類', p.kind, CASH_ACCOUNT_KINDS) ?? cur.kind
  const openingBalance = argOptYen('はじめの残高', p.opening_balance) ?? cur.opening_balance
  const openingDate = argOptDate('残高の日付', p.opening_date) ?? cur.opening_date
  const sortOrder = argOptInt('並び順', p.sort_order) ?? cur.sort_order
  const isActive = argOptFlag('表示', p.is_active) ?? cur.is_active

  const earlier = await ctx.sql.get<{ c: number }>(
    'select count(*) as c from cash_entry where account_id = ? and occurred_at < ?', accountId, openingDate,
  )
  if ((earlier?.c ?? 0) > 0) {
    throw new UserError(`${openingDate} より前の入出金が ${earlier!.c} 件あります。先にそれらを消すか、日付を前にしてください`)
  }

  await ctx.sql.run(
    `update cash_account
        set name = ?, kind = ?, opening_balance = ?, opening_date = ?, sort_order = ?, is_active = ?
      where id = ?`,
    name, kind, openingBalance, openingDate, sortOrder, isActive, accountId,
  )
}

// ---- 債務 ----

const LIABILITY_SELECT = `
  select l.id, l.kind, l.counterparty, l.occurred_at, l.due_at, l.amount,
         coalesce((
           select sum(s.amount) from liability_settlement s
            where s.household_id = l.household_id and s.liability_id = l.id
         ), 0) as settled,
         l.note, l.basis_sale_id, l.basis_amount, l.basis_rate_bp, l.month, l.created_at
    from liability l
`

// 期限の無いものは最後。同じ並びなら作った順
const LIABILITY_ORDER = 'order by l.due_at nulls last, l.occurred_at, l.created_at, l.id'

export function mapLiability(r: Omit<Liability, 'remaining'>): Liability {
  return { ...r, remaining: r.amount - r.settled }
}

export async function listLiabilities(ctx: Ctx, opts?: { kind?: LiabilityKind; onlyOpen?: boolean }): Promise<Liability[]> {
  const o = argOptObject('絞り込み', opts)
  const kind = argOptEnum('債務の種類', o?.kind, LIABILITY_KINDS)
  const onlyOpen = argOptBool('残りがあるものだけ', o?.onlyOpen) ?? false

  const rows = kind
    ? await ctx.sql.all<Omit<Liability, 'remaining'>>(`${LIABILITY_SELECT} where l.kind = ? ${LIABILITY_ORDER}`, kind)
    : await ctx.sql.all<Omit<Liability, 'remaining'>>(`${LIABILITY_SELECT} ${LIABILITY_ORDER}`)
  const all = rows.map(mapLiability)
  return onlyOpen ? all.filter(l => l.remaining > 0) : all
}

/**
 * 債務を 1 件引く。lock を立てると行を `for update` で押さえる（消込・額の変更・削除が同時に走って、
 * 債務の額を超えて消し込んだり、消込のある債務を消したりしないように）
 */
export async function getLiabilityOrThrow(ctx: Ctx, id: string, lock = false): Promise<Liability> {
  const row = await ctx.sql.get<Omit<Liability, 'remaining'>>(
    `${LIABILITY_SELECT} where l.id = ?${lock ? ' for update of l' : ''}`, argId('債務', id),
  )
  if (!row) throw new UserError('債務が見つかりません', 'not_found')
  return mapLiability(row)
}

export async function createLiability(ctx: Ctx, input: LiabilityInput): Promise<string> {
  const o = argObject('債務', input)
  const kind = argEnum('債務の種類', o.kind, LIABILITY_KINDS)
  const counterparty = argText('相手', o.counterparty, { max: NAME_MAX }).trim()
  if (!counterparty) throw new UserError('相手を入力してください')
  assertDateText('発生日', o.occurred_at)
  const dueAt = argNullableDate('支払期限', o.due_at) ?? null
  const note = trimOrNull(argNullableText('メモ', o.note, { max: NOTE_MAX }))

  let amount: number
  let basisSaleId: string | null = null
  let basisAmount: number | null = null
  let basisRateBp: number | null = null
  let month: string | null = null

  if (kind === 'tool_share') {
    if (!o.basis_sale_id) throw new UserError('ツール分は、もとにした販売が必要です')
    if (typeof o.basis_amount !== 'number' || !Number.isSafeInteger(o.basis_amount)) {
      throw new UserError('もとにした粗利は整数で入力してください')
    }
    const basis = argInt('もとにした粗利', o.basis_amount)
    if (typeof o.basis_rate_bp !== 'number' || !Number.isSafeInteger(o.basis_rate_bp)
      || o.basis_rate_bp < 1 || o.basis_rate_bp > 10000) {
      throw new UserError('割合は 0.01〜100%（1〜10000）の範囲で入力してください')
    }
    const rateBp = o.basis_rate_bp
    // 形が uuid でない id も「見つからない」として扱う（他の世帯の販売は RLS で見えない＝同じく見つからない）
    const sale = isUuid(o.basis_sale_id)
      ? await ctx.sql.get<{ id: string }>('select id from sale where id = ?', o.basis_sale_id.toLowerCase())
      : undefined
    if (!sale) throw new UserError('もとにした販売が見つかりません', 'not_found')
    amount = toolShareAmount(basis, rateBp)
    if (amount < 1) throw new UserError('ツール分が0円になります（粗利がプラスの販売だけ対象です）')
    if (o.amount !== undefined && o.amount !== null) {
      assertYen('金額', o.amount)
      if (o.amount !== amount) {
        throw new UserError(`ツール分は根拠から ${yenText(amount)} に決まります（渡された額: ${yenText(o.amount)}）`)
      }
    }
    basisSaleId = sale.id
    basisAmount = basis
    basisRateBp = rateBp
  } else {
    if (o.basis_sale_id || (o.basis_amount !== undefined && o.basis_amount !== null)
      || (o.basis_rate_bp !== undefined && o.basis_rate_bp !== null)) {
      throw new UserError('根拠（販売・粗利・割合）はツール分だけに付けられます')
    }
    assertPositiveYen('金額', o.amount)
    amount = o.amount
    if (kind === 'purchase') {
      month = argOptMonth('どの月ぶんか', o.month) ?? o.occurred_at.slice(0, 7)
      assertMonthText('どの月ぶんか', month)
    }
  }

  const row = await ctx.sql.get<{ id: string }>(
    `insert into liability (kind, counterparty, occurred_at, due_at, amount, note,
                            basis_sale_id, basis_amount, basis_rate_bp, month, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, clock_timestamp()) returning id`,
    kind, counterparty, o.occurred_at, dueAt, amount, note, basisSaleId, basisAmount, basisRateBp, month,
  )
  return row!.id
}

export async function updateLiability(ctx: Ctx, id: string, patch: LiabilityPatch): Promise<void> {
  const liabilityId = argId('債務', id)
  const p = argObject('債務の変更内容', patch)
  const cur = await getLiabilityOrThrow(ctx, liabilityId, true)

  const newCounterparty = argOptText('相手', p.counterparty, { max: NAME_MAX })
  const counterparty = newCounterparty !== undefined ? newCounterparty.trim() : cur.counterparty
  if (!counterparty) throw new UserError('相手を入力してください')
  const occurredAt = argOptDate('発生日', p.occurred_at) ?? cur.occurred_at
  const newDueAt = argNullableDate('支払期限', p.due_at)
  const dueAt = newDueAt === undefined ? cur.due_at : newDueAt
  const newNote = argNullableText('メモ', p.note, { max: NOTE_MAX })
  const note = newNote === undefined ? cur.note : trimOrNull(newNote)

  let amount = cur.amount
  if (p.amount !== undefined && p.amount !== null && p.amount !== cur.amount) {
    if (cur.kind === 'tool_share') throw new UserError('ツール分の額は根拠から決まるので変えられません')
    assertPositiveYen('金額', p.amount)
    if (p.amount < cur.settled) {
      throw new UserError(`すでに ${yenText(cur.settled)} 消し込み済みなので、それより小さくできません`)
    }
    amount = p.amount
  }

  let month = cur.month
  const newMonth = argNullableMonth('どの月ぶんか', p.month)
  if (newMonth !== undefined) {
    if (cur.kind !== 'purchase') {
      if (newMonth !== null) throw new UserError('月を持てるのは仕入だけです')
    } else {
      month = newMonth ?? occurredAt.slice(0, 7)
      assertMonthText('どの月ぶんか', month)
    }
  }

  await ctx.sql.run(
    `update liability
        set counterparty = ?, occurred_at = ?, due_at = ?, amount = ?, note = ?, month = ?
      where id = ?`,
    counterparty, occurredAt, dueAt, amount, note, month, liabilityId,
  )
}

/** 消込のある債務は消さない（払った記録の行き先が無くなる）。先にその入出金を消す */
export async function deleteLiability(ctx: Ctx, id: string): Promise<void> {
  const cur = await getLiabilityOrThrow(ctx, id, true)
  const used = await ctx.sql.get<{ c: number }>('select count(*) as c from liability_settlement where liability_id = ?', cur.id)
  if ((used?.c ?? 0) > 0) {
    throw new UserError(`すでに ${yenText(cur.settled)} 消し込み済みなので消せません。先にその入出金を消してください`, 'conflict')
  }
  await ctx.sql.run('delete from liability where id = ?', cur.id)
}

// ---- 入出金 ----

export async function listCashEntries(ctx: Ctx, month?: string): Promise<CashEntry[]> {
  const m = argOptMonth('月', month)
  const range = m ? monthBounds(m) : null
  const where = range ? 'where e.occurred_at >= ? and e.occurred_at <= ?' : ''
  const params = range ? [range.start, range.end] : []

  const rows = await ctx.sql.all<Omit<CashEntry, 'settles'>>(`
    select e.id, e.account_id, a.name as account_name, e.occurred_at, e.direction, e.amount,
           e.category, e.note, e.sale_id, e.created_at
      from cash_entry e
      join cash_account a on a.household_id = e.household_id and a.id = e.account_id
     ${where}
     order by e.occurred_at desc, e.created_at desc, e.id desc
  `, ...params)

  const settleRows = await ctx.sql.all<{ entry_id: string; liability_id: string; amount: number }>(`
    select s.entry_id, s.liability_id, s.amount
      from liability_settlement s
      join cash_entry e on e.household_id = s.household_id and e.id = s.entry_id
     ${where}
     order by s.settle_order
  `, ...params)
  const byEntry = new Map<string, Array<{ liability_id: string; amount: number }>>()
  for (const s of settleRows) {
    const list = byEntry.get(s.entry_id) ?? []
    list.push({ liability_id: s.liability_id, amount: s.amount })
    byEntry.set(s.entry_id, list)
  }
  return rows.map(r => ({ ...r, settles: byEntry.get(r.id) ?? [] }))
}

export async function createCashEntry(ctx: Ctx, input: CashEntryInput): Promise<string> {
  const o = argObject('入出金', input)
  const accountId = argId('口座', o.account_id)
  const account = await ctx.sql.get<{ id: string; opening_date: string }>(
    'select id, opening_date from cash_account where id = ?', accountId,
  )
  if (!account) throw new UserError('口座が見つかりません', 'not_found')
  assertDateText('日付', o.occurred_at)
  if (o.occurred_at < account.opening_date) {
    throw new UserError(`この口座は ${account.opening_date} から数えています。それより前の日付は入れられません`)
  }
  if (o.direction !== 'in' && o.direction !== 'out') throw new UserError('入金か出金かを選んでください')
  const direction: 'in' | 'out' = o.direction
  assertPositiveYen('金額', o.amount)
  const amount = o.amount
  const category = argEnum('区分', o.category, CASH_CATEGORY_ORDER)
  const fixedDirection = CASH_CATEGORY_DIRECTION[category]
  if (fixedDirection && fixedDirection !== direction) {
    throw new UserError(`「${CASH_CATEGORY_LABEL[category]}」は${fixedDirection === 'in' ? '入金' : '出金'}の区分です`)
  }
  const note = trimOrNull(argNullableText('メモ', o.note, { max: NOTE_MAX }))

  const settles: Array<{ liability_id: string; amount: number }> = []
  const seen = new Set<string>()
  let settleTotal = 0
  for (const raw of argArray('消し込み', o.settles ?? [], { max: SETTLES_MAX })) {
    const s = argObject('消し込み', raw)
    assertPositiveYen('消し込む額', s.amount)
    const liabilityId = argId('債務', s.liability_id)
    if (seen.has(liabilityId)) throw new UserError('同じ債務を2回消し込めません。1行にまとめてください')
    seen.add(liabilityId)
    settleTotal += s.amount
    settles.push({ liability_id: liabilityId, amount: s.amount })
  }
  if (settles.length > 0 && direction !== 'out') {
    throw new UserError('債務を消し込めるのは出金だけです')
  }
  if (settleTotal > amount) {
    throw new UserError(`消し込みの合計（${yenText(settleTotal)}）が入出金の額（${yenText(amount)}）を超えています`)
  }

  // 債務の行を押さえてから残りを見る（同時に別の入出金が同じ債務を消し込んでも、額を超えない）
  for (const s of settles) {
    const l = await getLiabilityOrThrow(ctx, s.liability_id, true)
    if (s.amount > l.remaining) {
      throw new UserError(`${l.counterparty}の債務は残り ${yenText(l.remaining)} です。${yenText(s.amount)} は消し込めません`)
    }
  }
  const row = await ctx.sql.get<{ id: string }>(
    `insert into cash_entry (account_id, occurred_at, direction, amount, category, note, created_at)
     values (?, ?, ?, ?, ?, ?, clock_timestamp()) returning id`,
    accountId, o.occurred_at, direction, amount, category, note,
  )
  const id = row!.id
  for (const s of settles) {
    await ctx.sql.run(
      'insert into liability_settlement (entry_id, liability_id, amount) values (?, ?, ?)', id, s.liability_id, s.amount,
    )
  }
  return id
}

/** 消し込みも一緒に外れる（債務は残りが元に戻る） */
export async function deleteCashEntry(ctx: Ctx, id: string): Promise<void> {
  const entryId = argId('入出金', id)
  const exists = await ctx.sql.get<{ id: string }>('select id from cash_entry where id = ?', entryId)
  if (!exists) throw new UserError('入出金が見つかりません', 'not_found')
  await ctx.sql.run('delete from liability_settlement where entry_id = ?', entryId)
  await ctx.sql.run('delete from cash_entry where id = ?', entryId)
}

// ---- 月の明細 ----

/**
 * 月の入出金明細。opening + 入金 − 出金 = closing が必ず成り立つ（closing は積んで出す）。
 *
 *   * opening … 月初に持っていた額。月の途中（〜末日）から数え始める口座は、その起点の残高を
 *     月初に持っていたことにする（そうしないと opening + net = closing が崩れる）
 *   * upcoming … 月末時点でまだ残っている債務（期限が来ていないものも含む）。
 *     発生日が月末より後のもの・月末より後の入出金で消し込んだ分は数えない（過去の月が後から動かない）
 *   * free_cash … closing − upcoming_total。払うべきものを払った後に残る額
 */
export async function getCashMonth(ctx: Ctx, month: string): Promise<CashMonth> {
  const m = argMonth('月', month)
  const { start, end } = monthBounds(m)

  // sum(bigint) は numeric（文字列）で返るので ::bigint に戻す
  const openingRow = await ctx.sql.get<{ opening: number }>(`
    select coalesce(sum(
             a.opening_balance + coalesce((
               select sum(case e.direction when 'in' then e.amount else -e.amount end)
                 from cash_entry e
                where e.household_id = a.household_id and e.account_id = a.id
                  and e.occurred_at >= a.opening_date and e.occurred_at < ?
             ), 0)
           ), 0)::bigint as opening
      from cash_account a
     where a.opening_date <= ?
  `, start, end)

  const sums = await ctx.sql.all<{ direction: 'in' | 'out'; category: CashCategory; amount: number }>(`
    select e.direction, e.category, sum(e.amount) as amount
      from cash_entry e
      join cash_account a on a.household_id = e.household_id and a.id = e.account_id
     where e.occurred_at >= ? and e.occurred_at <= ? and e.occurred_at >= a.opening_date
     group by e.direction, e.category
  `, start, end)

  const pick = (direction: 'in' | 'out') => CASH_CATEGORY_ORDER
    .map(category => ({
      category,
      label: CASH_CATEGORY_LABEL[category],
      amount: sums.find(s => s.direction === direction && s.category === category)?.amount ?? 0,
    }))
    .filter(r => r.amount > 0)

  const incoming = pick('in')
  const outgoing = pick('out')
  const incomingTotal = incoming.reduce((s, r) => s + r.amount, 0)
  const outgoingTotal = outgoing.reduce((s, r) => s + r.amount, 0)
  const net = incomingTotal - outgoingTotal
  const opening = openingRow?.opening ?? 0
  const closing = opening + net

  const upcoming = (await ctx.sql.all<CashMonth['upcoming'][number]>(`
    select l.id as liability_id, l.kind, l.counterparty, l.due_at,
           l.amount - coalesce((
             select sum(s.amount)
               from liability_settlement s
               join cash_entry e on e.household_id = s.household_id and e.id = s.entry_id
              where s.household_id = l.household_id and s.liability_id = l.id and e.occurred_at <= ?
           ), 0) as remaining
      from liability l
     where l.occurred_at <= ?
     ${LIABILITY_ORDER}
  `, end, end)).filter(u => u.remaining > 0)
  const upcomingTotal = upcoming.reduce((s, u) => s + u.remaining, 0)

  return {
    month: m, opening, incoming, incoming_total: incomingTotal, outgoing, outgoing_total: outgoingTotal,
    net, closing, upcoming, upcoming_total: upcomingTotal, free_cash: closing - upcomingTotal,
  }
}

// ------------------------------------------------------------
// API として出す
// ------------------------------------------------------------

registerHandler('listCashAccounts', (ctx) => listCashAccounts(ctx))
registerHandler('createCashAccount', (ctx, input) => createCashAccount(ctx, input))
registerHandler('updateCashAccount', (ctx, id, patch) => updateCashAccount(ctx, id, patch))
registerHandler('listLiabilities', (ctx, opts) => listLiabilities(ctx, opts ?? undefined))
registerHandler('createLiability', (ctx, input) => createLiability(ctx, input))
registerHandler('updateLiability', (ctx, id, patch) => updateLiability(ctx, id, patch))
registerHandler('deleteLiability', (ctx, id) => deleteLiability(ctx, id))
registerHandler('listCashEntries', (ctx, month) => listCashEntries(ctx, month ?? undefined))
registerHandler('createCashEntry', (ctx, input) => createCashEntry(ctx, input))
registerHandler('deleteCashEntry', (ctx, id) => deleteCashEntry(ctx, id))
registerHandler('getCashMonth', (ctx, month) => getCashMonth(ctx, month))
