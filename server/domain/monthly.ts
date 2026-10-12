import type { Ctx } from '../context'
import { UserError } from '../errors'
import { registerHandler, registerPhasedHandler, registerWebHandler } from '../rpc'
import {
  assertUploadPath, bytesToBase64, isOwnPath, removeAfterCommit, requireStorageConfig, storageClient, storageConfigOf,
  type StorageConfig,
} from '../storage'
import type {
  AllocMethod, Expense, ExpenseCategory, ExpenseInput, ExpenseLine, MonthClose, MonthDetail, MonthSaleRow,
  MonthTotals, MonthlySummary, ReceiptDraft, ReceiptRead, SaleKind, Tag,
} from '../../src/shared/types'
import {
  applyLearnedShop, logAiError, RECEIPT_MAX_BYTES, receiptImageType, receiptRegistrationNo, requestReceiptDraft,
  toAiErrorMessage,
} from '../../src/main/gemini-core'
import {
  MAX_INT4, argEnum, argId, argMonth, argNullableText, argObject, argOptArray, argOptId, argOptMonth, argOptObject,
  argText, assertDateText, assertQty, assertYen, forecastTotals, isRealized, monthBounds, nowIso, rowsToCsv,
  thisMonthJst, todayJst,
} from './_shared'
import { requireGeminiCredentials } from './integrations'
import { learnShopAlias, lookupShopAlias } from './purchase'
import { listSales, sumSaleTotals } from './sale'

// ============================================================
// 月次・経費・月の締め
//
// src/main/db.ts の listMonthly / 期間費用（expense・expense_line）/ getMonthDetail / closeMonth ほかの移植。
// 帳簿の締めなので、経費の按分が 1 円ずれると月の純利益がずれる。
//
//   * 利益はビュー（monthly_summary・sale_profit）から読む。ここで販売ごとの利益を計算し直さない
//   * 月次の数字は**実績だけ**（取引完了＋状態のない手入力。isRealized）。見込みは forecast に別に出す
//   * 経費はその月の販売用の販売（kind='resale'）の実績だけに按分する。**私物には配賦しない**。
//     金額按分＝販売価格の比、数量按分＝点数の比。floor で配って**余りは最後の行**に寄せ、合計を経費の額と一致させる
//   * month_book は「締めた時点の数字」の記録。締めても編集はロックしない（締め後に数字が変われば changed_since_close）
//   * 今月は日本時間（todayJst と同じ +9 時間。Workers は UTC）で決める
//
// レシートの画像（非公開バケット receipts。docs/web/02-porting-guide.md の 4 節）：
//   * 画面が prepareUpload でもらった置き場所（`<世帯>/receipt/<uuid>.<ext>`）へ直接上げ、そのパスを
//     attachReceiptPath／createExpense・updateExpense の receipt_temp_file で帳簿（expense.receipt_path）に結ぶ
//   * 受け取るパスは assertUploadPath で検査する（他の世帯・`..`・別の種類は 400）
//   * Expense.receipt_url は署名つき URL（期限 1 時間）。1 回の一覧で 1 回のまとめ署名。署名できなければ null（一覧は止めない）
//   * 前のレシートの Storage からの削除は**コミットの後**（ctx.afterCommit）。消せなくても帳簿は巻き戻さない
//   * AI 読み取り（readReceipt / readReceiptAt）は Gemini と通信するあいだトランザクションを握らない
//     （rpc.ts の registerPhasedHandler：読み出し → 通信 → 整えて返す）。中身はデスクトップと同じ（gemini-core.ts）
// ============================================================

const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  'packaging', 'supplies', 'shipping', 'fee', 'transfer_fee', 'other',
]
const ALLOC_METHODS: readonly AllocMethod[] = ['by_amount', 'by_quantity']

const SHOP_MAX = 200 // learnShopAlias の店名の上限と同じ
const REGISTRATION_NO_MAX = 100 // learnShopAlias の登録番号の上限と同じ
const NOTE_MAX = 5000
const LINE_NAME_MAX = 1000
const LINES_MAX = 1000

// ------------------------------------------------------------
// 月の計算
// ------------------------------------------------------------

/** 'YYYY-MM' を 1 か月進める（暦の計算だけ。時計には依らない） */
export function nextMonth(month: string): string {
  argMonth('月', month)
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m, 1)) // m は 1〜12（次の月がそのまま Date の月の添字になる）
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// ------------------------------------------------------------
// 集計
// ------------------------------------------------------------

type MonthKey = `${string}:${SaleKind}`

interface RealizedRow {
  month: string
  kind: SaleKind
  sales_count: number
  revenue: number
  total_fee: number
  total_shipping: number
  total_packaging: number
  total_cost: number
  gross_profit: number
}

interface PendingRow {
  month: string
  kind: SaleKind
  forecast_count: number
  forecast_revenue: number
  forecast_gross_profit: number
  unconfirmed: number
}

/** 月次集計。expense_total は expense.month（計上月）で集計する */
export async function listMonthly(ctx: Ctx): Promise<MonthlySummary[]> {
  // 実績（取引完了＋状態のない手入力）の月×区分の合計は、ビュー monthly_summary から読む
  const realizedRows = await ctx.sql.all<RealizedRow>(`
    select month, kind, sales_count, revenue, total_fee, total_shipping, total_packaging, total_cost, gross_profit
      from monthly_summary
  `)
  const realizedMap = new Map<MonthKey, RealizedRow>(realizedRows.map(r => [`${r.month}:${r.kind}`, r]))

  // 見込み（未完了）の件数・売上・粗利と、実績のうち送料未入力の件数。
  // 月×区分の行は、見込みだけの月にも作る（実績が 0 件でも行が消えない）
  const pendingRows = await ctx.sql.all<PendingRow>(`
    select month, kind,
           count(*) filter (where not realized) as forecast_count,
           coalesce(sum(price) filter (where not realized), 0) as forecast_revenue,
           coalesce(sum(gross_profit) filter (where not realized), 0) as forecast_gross_profit,
           count(*) filter (where realized and is_shipping_confirmed = 0) as unconfirmed
      from (
        select to_char(sold_at, 'YYYY-MM') as month, kind, price, gross_profit, is_shipping_confirmed,
               coalesce(status = 'completed' or (source = 'manual' and status is null), false) as realized
          from sale_profit
      ) s
     group by month, kind
  `)

  // 期間費用の月合計（計上月＝expense.month）。kind='resale' の行にだけ乗せる（私物は税務上別扱い）
  const expenseRows = await ctx.sql.all<{ month: string; total: number }>(`
    select month, coalesce(sum(amount), 0) as total from expense group by month
  `)
  const expenseMap = new Map(expenseRows.map(r => [r.month, r.total]))

  const closedMonths = new Set(
    (await ctx.sql.all<{ month: string }>('select month from month_book where closed_at is not null')).map(r => r.month),
  )

  const result: MonthlySummary[] = pendingRows.map(p => {
    const realized = realizedMap.get(`${p.month}:${p.kind}`)
    const expense_total = p.kind === 'resale' ? (expenseMap.get(p.month) ?? 0) : 0
    const gross_profit = realized?.gross_profit ?? 0
    return {
      month: p.month,
      kind: p.kind,
      sales_count: realized?.sales_count ?? 0,
      revenue: realized?.revenue ?? 0,
      total_fee: realized?.total_fee ?? 0,
      total_shipping: realized?.total_shipping ?? 0,
      total_packaging: realized?.total_packaging ?? 0,
      total_cost: realized?.total_cost ?? 0,
      gross_profit,
      forecast: { count: p.forecast_count, revenue: p.forecast_revenue, gross_profit: p.forecast_gross_profit },
      unconfirmed_shipping: p.unconfirmed,
      expense_total,
      net_profit: gross_profit - expense_total,
      closed: p.kind === 'resale' && closedMonths.has(p.month),
    }
  })

  // 売上がまだ無いが費用だけある月：resale の行が消えてしまうと期間費用も画面から消えるため、
  // 0件のresale行を補って出す
  const resaleMonths = new Set(result.filter(r => r.kind === 'resale').map(r => r.month))
  for (const [month, total] of expenseMap) {
    if (resaleMonths.has(month)) continue
    result.push({
      month, kind: 'resale',
      sales_count: 0, revenue: 0, total_fee: 0, total_shipping: 0, total_packaging: 0,
      total_cost: 0, gross_profit: 0,
      unconfirmed_shipping: 0, expense_total: total, net_profit: -total,
      closed: closedMonths.has(month),
    })
  }

  // 今月は販売が 0 件でも resale の行を必ず返す。無いと月次画面が前月のまま固まる
  // （月の帯は listMonthly の行から作るので、今月を選べない）。私物の行は帯に出ないので補わない。
  // 今月は日本時間で決める（Workers は UTC。日本の 0〜9 時台に前の月のままにしない）
  const currentMonth = thisMonthJst()
  if (!result.some(r => r.month === currentMonth && r.kind === 'resale')) {
    result.push({
      month: currentMonth, kind: 'resale',
      sales_count: 0, revenue: 0, total_fee: 0, total_shipping: 0, total_packaging: 0,
      total_cost: 0, gross_profit: 0,
      unconfirmed_shipping: 0, expense_total: 0, net_profit: 0,
      closed: closedMonths.has(currentMonth),
      forecast: { count: 0, revenue: 0, gross_profit: 0 },
    })
  }

  result.sort((a, b) => {
    if (a.month !== b.month) return a.month < b.month ? 1 : -1 // month DESC
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0 // kind ASC（personal, resale の順）
  })
  return result
}

// ------------------------------------------------------------
// 期間費用（レシート単位。梱包材・消耗品・送料実費・手数料など、販売1件に紐付かない費用）
//
// amount は明細（expense_line）があればその合計、無ければ入力した合計。
// 計上月（month）は購入日（occurred_at）の月が既定だが、変えられる。
// 月次の純利益・按分は occurred_at ではなく month で集計する。
// ------------------------------------------------------------

interface ExpenseRow {
  id: string
  occurred_at: string
  month: string
  shop: string | null
  category: ExpenseCategory
  amount: number
  note: string | null
  auto: number
  registration_no: string | null
  /** レシートの Storage のパス（receipts バケット）。画面には出さず、署名つき URL（receipt_url）にして返す */
  receipt_path: string | null
}

const EXPENSE_SELECT = `
  select id, occurred_at, month, shop, category, amount, note, auto, registration_no, receipt_path
    from expense
`

async function loadExpenseLinesFor(ctx: Ctx, expenseIds: string[]): Promise<Map<string, ExpenseLine[]>> {
  const map = new Map<string, ExpenseLine[]>()
  if (expenseIds.length === 0) return map

  const rows = await ctx.sql.all<ExpenseLine & { expense_id: string }>(`
    select id, expense_id, name, unit_price, amount, quantity, category
      from expense_line
     where expense_id = any(?::uuid[])
     order by sort_order, id
  `, expenseIds)

  for (const r of rows) {
    const { expense_id, ...line } = r
    const arr = map.get(expense_id) ?? []
    arr.push(line)
    map.set(expense_id, arr)
  }
  return map
}

/**
 * レシートの署名つき URL（期限 1 時間）を**まとめて 1 回**で作る。パス → URL。
 * 保存先の設定が無い・署名できなかったパスは入れない（＝呼ぶ側は null にする）。
 * Storage の不調で経費の一覧そのものを止めない（失敗は storage.ts がログに残す）。
 * 自分の世帯の receipt フォルダの外のパスは署名しない（DB の値が想定外でも、一括の署名を巻き込まない）
 */
async function signReceiptUrls(ctx: Ctx, paths: Array<string | null>): Promise<Map<string, string | null>> {
  const list = [...new Set(paths.filter((p): p is string => isOwnPath(ctx, 'receipt', p)))]
  const cfg = list.length > 0 ? storageConfigOf(ctx) : null
  if (!cfg) return new Map()
  try {
    return await storageClient(cfg, ctx.fetch).signUrls('receipts', list)
  } catch {
    return new Map()
  }
}

async function hydrateExpenseRows(ctx: Ctx, rows: ExpenseRow[]): Promise<Expense[]> {
  const lineMap = await loadExpenseLinesFor(ctx, rows.map(r => r.id))
  const urls = await signReceiptUrls(ctx, rows.map(r => r.receipt_path))
  return rows.map(({ receipt_path, ...r }) => ({
    ...r,
    receipt_url: (receipt_path && urls.get(receipt_path)) || null,
    lines: lineMap.get(r.id) ?? [],
  }))
}

/** month は YYYY-MM（計上月）で絞る。省略（空文字も）で全部。新しい順 */
export async function listExpenses(ctx: Ctx, month?: string | null): Promise<Expense[]> {
  const m = month === '' ? undefined : argOptMonth('月', month)
  const rows = await ctx.sql.all<ExpenseRow>(
    `${EXPENSE_SELECT} ${m ? 'where month = ?' : ''} order by occurred_at desc, created_at desc, id`,
    ...(m ? [m] : []),
  )
  return hydrateExpenseRows(ctx, rows)
}

interface ValidatedExpense {
  occurred_at: string
  month: string
  shop: string | null
  category: ExpenseCategory
  amount: number
  note: string | null
  /** undefined＝今の値を消さない（updateExpense）。null・空文字＝消す */
  registration_no: string | null | undefined
  lines: Array<{ name: string; unit_price: number; quantity: number; amount: number; category: ExpenseCategory }>
}

/**
 * createExpense / updateExpense 共通の入力チェック。DB のエラーが画面にそのまま出ないよう、
 * 分かる範囲で先に日本語で弾く。明細があれば amount・category を明細から導く。
 */
function validateExpenseInput(input: ExpenseInput): ValidatedExpense {
  const o = argObject('経費', input)
  assertDateText('購入日', o.occurred_at)
  const occurredAt = o.occurred_at
  const month = argOptMonth('計上月', o.month) ?? occurredAt.slice(0, 7)
  const inputCategory = argEnum('費用区分', o.category, EXPENSE_CATEGORIES)
  const shop = argNullableText('購入店', o.shop, { max: SHOP_MAX }) ?? null
  const note = argNullableText('メモ', o.note, { max: NOTE_MAX }) ?? null
  const regNo = argNullableText('登録番号', o.receipt_registration_no, { max: REGISTRATION_NO_MAX })

  const rawLines = argOptArray('明細', o.lines, { max: LINES_MAX }) ?? []
  const lines = rawLines.map((raw, i) => {
    const l = argObject(`${i + 1}行目`, raw)
    const name = argText(`${i + 1}行目の品名`, l.name, { max: LINE_NAME_MAX }).trim()
    if (!name) throw new UserError(`${i + 1}行目：品名を入力してください`)
    assertYen(`${i + 1}行目の単価`, l.unit_price)
    const quantity = l.quantity ?? 1
    assertQty(`${i + 1}行目の数量`, quantity)
    const category = l.category === undefined || l.category === null
      ? inputCategory
      : argEnum('費用区分', l.category, EXPENSE_CATEGORIES)
    const amount = l.unit_price * quantity
    if (amount > MAX_INT4) throw new UserError(`${i + 1}行目の金額が大きすぎます`)
    return { name, unit_price: l.unit_price, quantity, amount, category }
  })

  let amount: unknown
  if (lines.length > 0) {
    amount = lines.reduce((s, l) => s + l.amount, 0)
  } else {
    if (o.amount === undefined || o.amount === null) throw new UserError('金額を入れてください')
    amount = o.amount
  }
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
    throw new UserError('金額は0以上の整数で入力してください')
  }
  if (amount > MAX_INT4) throw new UserError('金額が大きすぎます')
  const category = lines.length > 0 ? lines[0].category : inputCategory

  return {
    occurred_at: occurredAt,
    month, shop, category, amount, note,
    registration_no: regNo === undefined ? undefined : regNo ? regNo : null,
    lines,
  }
}

/** 明細を sort_order の順に入れる（1 本の insert … select unnest。N 本の往復にしない） */
async function insertExpenseLines(ctx: Ctx, expenseId: string, lines: ValidatedExpense['lines']): Promise<void> {
  if (lines.length === 0) return
  await ctx.sql.run(`
    insert into expense_line (expense_id, name, unit_price, amount, quantity, category, sort_order)
    select ?::uuid, t.name, t.unit_price, t.amount, t.quantity, t.category, t.sort_order
      from unnest(?::text[], ?::int[], ?::int[], ?::int[], ?::text[], ?::int[])
             as t(name, unit_price, amount, quantity, category, sort_order)
  `,
    expenseId,
    lines.map(l => l.name), lines.map(l => l.unit_price), lines.map(l => l.amount),
    lines.map(l => l.quantity), lines.map(l => l.category), lines.map((_, i) => i),
  )
}

/**
 * ExpenseInput.receipt_temp_file（Web では `prepareUpload` でもらって上げたレシートのパス）。
 * 無い・空なら undefined（レシートは変えない）。あれば**検査して**返す（他の世帯・`..`・別の種類・形式違いは 400）
 */
function receiptPathOf(ctx: Ctx, input: ExpenseInput): string | undefined {
  const raw = input.receipt_temp_file
  if (raw === undefined || raw === null || raw === '') return undefined
  return assertUploadPath(ctx, 'receipt', raw)
}

/** このレシートがほかの経費に付いていないこと（1 つのファイルを 2 つの経費が指すと、片方を外したときもう片方の画像が消える） */
async function assertReceiptFree(ctx: Ctx, path: string, exceptExpenseId: string | null): Promise<void> {
  const used = exceptExpenseId
    ? await ctx.sql.get('select id from expense where receipt_path = ? and id <> ?', path, exceptExpenseId)
    : await ctx.sql.get('select id from expense where receipt_path = ?', path)
  if (used) throw new UserError('このレシートはすでに別の経費に付いています', 'conflict')
}

/** 外した・付け替えた・消した経費の前のレシートを、コミットの後に Storage から消す（自分の世帯の receipt フォルダのものだけ） */
function removeReceiptFileAfterCommit(ctx: Ctx, path: string | null | undefined): void {
  if (isOwnPath(ctx, 'receipt', path)) removeAfterCommit(ctx, 'receipts', [path])
}

export async function createExpense(ctx: Ctx, input: ExpenseInput): Promise<string> {
  const v = validateExpenseInput(input)
  const receiptPath = receiptPathOf(ctx, input) ?? null
  if (receiptPath) await assertReceiptFree(ctx, receiptPath, null)
  const row = await ctx.sql.get<{ id: string }>(`
    insert into expense (occurred_at, month, shop, category, amount, note, auto, registration_no, receipt_path, created_at)
    values (?, ?, ?, ?, ?, ?, 0, ?, ?, clock_timestamp())
    returning id
  `, v.occurred_at, v.month, v.shop, v.category, v.amount, v.note, v.registration_no ?? null, receiptPath)
  const id = row!.id
  await insertExpenseLines(ctx, id, v.lines)
  if (v.registration_no && v.shop) await learnShopAlias(ctx, v.registration_no, v.shop)
  return id
}

/**
 * 明細は全部入れ替える。receipt_registration_no は省略（undefined）なら今の値を消さない、
 * null／空文字を渡すと消える
 */
export async function updateExpense(ctx: Ctx, id: string, input: ExpenseInput): Promise<void> {
  const expenseId = argId('経費', id)
  const current = await ctx.sql.get<{ receipt_path: string | null }>(
    'select receipt_path from expense where id = ? for update', expenseId,
  )
  if (!current) throw new UserError('経費が見つかりません', 'not_found')

  const v = validateExpenseInput(input)
  // receipt_temp_file があれば付け替える（無ければ今のレシートのまま）。検査は書き込みの前
  const receiptPath = receiptPathOf(ctx, input)
  const swapReceipt = receiptPath !== undefined && receiptPath !== current.receipt_path
  if (swapReceipt) await assertReceiptFree(ctx, receiptPath, expenseId)
  if (v.registration_no === undefined) {
    await ctx.sql.run(`
      update expense
         set occurred_at = ?, month = ?, shop = ?, category = ?, amount = ?, note = ?
       where id = ?
    `, v.occurred_at, v.month, v.shop, v.category, v.amount, v.note, expenseId)
  } else {
    await ctx.sql.run(`
      update expense
         set occurred_at = ?, month = ?, shop = ?, category = ?, amount = ?, note = ?, registration_no = ?
       where id = ?
    `, v.occurred_at, v.month, v.shop, v.category, v.amount, v.note, v.registration_no, expenseId)
  }
  await ctx.sql.run('delete from expense_line where expense_id = ?', expenseId)
  await insertExpenseLines(ctx, expenseId, v.lines)
  if (v.registration_no && v.shop) await learnShopAlias(ctx, v.registration_no, v.shop)
  if (swapReceipt) {
    await ctx.sql.run('update expense set receipt_path = ? where id = ?', receiptPath, expenseId)
    removeReceiptFileAfterCommit(ctx, current.receipt_path)
  }
}

/** 明細は expense_line の on delete cascade で消える。レシートがあれば、コミットの後に Storage から消す */
export async function deleteExpense(ctx: Ctx, id: string): Promise<void> {
  const row = await ctx.sql.get<{ receipt_path: string | null }>(
    'delete from expense where id = ? returning receipt_path', argId('経費', id),
  )
  removeReceiptFileAfterCommit(ctx, row?.receipt_path)
}

// ------------------------------------------------------------
// レシートの画像（付ける・外す・AI で読む）
// ------------------------------------------------------------

/**
 * 上げたレシートを経費に付ける（前のレシートがあれば、コミットの後に Storage から消す）。
 * 表示用の署名つき URL を返す。署名は「ファイルが本当に上がっているか」の確認も兼ねる（無ければ付けない）
 */
export async function attachReceiptPath(ctx: Ctx, expenseId: string, path: string): Promise<string | null> {
  const id = argId('経費', expenseId)
  const receiptPath = assertUploadPath(ctx, 'receipt', path)
  const cfg = requireStorageConfig(ctx)
  const current = await ctx.sql.get<{ receipt_path: string | null }>(
    'select receipt_path from expense where id = ? for update', id,
  )
  if (!current) throw new UserError('経費が見つかりません', 'not_found')
  await assertReceiptFree(ctx, receiptPath, id)

  let url: string
  try {
    url = await storageClient(cfg, ctx.fetch).signUrl('receipts', receiptPath)
  } catch (e) {
    if (e instanceof UserError && e.code === 'not_found') {
      throw new UserError('アップロードした画像が見つかりません。もう一度アップロードしてください', 'not_found')
    }
    throw e
  }
  if (current.receipt_path !== receiptPath) {
    await ctx.sql.run('update expense set receipt_path = ? where id = ?', receiptPath, id)
    removeReceiptFileAfterCommit(ctx, current.receipt_path)
  }
  return url
}

/** レシートを外す（コミットの後に Storage から消す）。経費が無ければ not_found。付いていなければ何もしない */
export async function removeReceipt(ctx: Ctx, id: string): Promise<void> {
  const expenseId = argId('経費', id)
  const current = await ctx.sql.get<{ receipt_path: string | null }>(
    'select receipt_path from expense where id = ? for update', expenseId,
  )
  if (!current) throw new UserError('経費が見つかりません', 'not_found')
  if (!current.receipt_path) return
  await ctx.sql.run('update expense set receipt_path = null where id = ?', expenseId)
  removeReceiptFileAfterCommit(ctx, current.receipt_path)
}

/** 読み取り（read 段）が集める、通信に要るもの。API キーは通信が終わるまでメモリにあるだけで、結果・ログには出さない */
interface ReceiptReadInput {
  apiKey: string
  model: string
  storage: StorageConfig
  /** receipts バケットのパス */
  path: string
  /** 日本時間の今日（未来日の判定） */
  today: string
  /** true なら、画面に出す署名つき URL も作る（readReceiptAt） */
  withUrl: boolean
}

interface ReceiptReadCalled {
  draft: ReceiptDraft
  receipt_url: string | null
}

async function prepareReceiptRead(ctx: Ctx, path: string, withUrl: boolean): Promise<ReceiptReadInput> {
  // 順番はデスクトップと同じ：キー（無ければ「設定がありません」）→ 画像
  const { apiKey, model } = await requireGeminiCredentials(ctx)
  return { apiKey, model, storage: requireStorageConfig(ctx), path, today: todayJst(), withUrl }
}

/**
 * call 段（トランザクションの外）：Storage からレシートを読み、Gemini で読んで下書きにする。
 * 失敗は日本語の UserError（デスクトップの readReceiptWithGemini と同じ文言）
 */
async function callReceiptRead(
  input: ReceiptReadInput, net: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> },
): Promise<ReceiptReadCalled> {
  const type = receiptImageType(input.path.slice(input.path.lastIndexOf('.') + 1))
  if ('error' in type) throw new UserError(type.error)

  const client = storageClient(input.storage, net.fetch)
  const { bytes } = await client.download('receipts', input.path, RECEIPT_MAX_BYTES)

  let draft: ReceiptDraft
  try {
    draft = await requestReceiptDraft(
      input.model, input.apiKey, { mimeType: type.mimeType, base64: bytesToBase64(bytes) }, input.today,
      { fetch: net.fetch, sleep: net.sleep },
    )
  } catch (e) {
    logAiError('Gemini でのレシート読み取りに失敗しました', e)
    throw new UserError(toAiErrorMessage(e, input.model))
  }
  const receipt_url = input.withUrl ? await client.signUrl('receipts', input.path) : null
  return { draft, receipt_url }
}

/** 登録番号（T＋13 桁）が学習済み（shop_alias）なら、店名を学習したものにする。デスクトップの applyShopAlias と同じ */
async function applyShopAlias(ctx: Ctx, draft: ReceiptDraft): Promise<ReceiptDraft> {
  const registrationNo = receiptRegistrationNo(draft)
  if (!registrationNo) return draft
  return applyLearnedShop(draft, registrationNo, await lookupShopAlias(ctx, registrationNo))
}

/** 付いているレシートの path。無ければ日本語の UserError（デスクトップの readReceipt と同じ文言） */
async function attachedReceiptPath(ctx: Ctx, id: string): Promise<string> {
  const row = await ctx.sql.get<{ receipt_path: string | null }>(
    'select receipt_path from expense where id = ?', argId('経費', id),
  )
  if (!row) throw new UserError('経費が見つかりません', 'not_found')
  if (!row.receipt_path) throw new UserError('レシートが添付されていません')
  if (!isOwnPath(ctx, 'receipt', row.receipt_path)) throw new UserError('レシートの画像を読み出せません')
  return row.receipt_path
}

// ------------------------------------------------------------
// 月次の明細・締め
//
// 経費はその月の販売用の販売（kind='resale'）にだけ按分する。私物には配賦しない。
// 金額按分＝販売価格の比、数量按分＝紐付けた在庫の点数の比（0点なら1）。
// floor で配って余りは最後の行（sales の末尾）に寄せ、Σallocated_expense = 経費合計にする。
// 販売が0件なら誰にも配賦しない。販売はあるが金額按分の重みの合計が0円（価格0の月）だと
// 配賦先が消えて経費が誰にも乗らなくなるため、数量按分にフォールバックする（money.ts の
// allocate と同じ流儀。数量は必ず1以上あるので、販売が1件でもあれば重みの合計は0にならない）。
// ------------------------------------------------------------

/**
 * 経費を販売に按分する。sales の並びの最後の行に端数を寄せる（合計は expenseTotal と必ず一致する）。
 * 掛け算は BigInt で行い、経費 × 価格が 2^53 を超えても floor がずれない
 */
export function allocateExpenseToSales(
  sales: Array<{ id: string; price: number; item_count: number }>,
  expenseTotal: number,
  method: AllocMethod,
): Map<string, number> {
  const map = new Map<string, number>()
  if (sales.length === 0) return map

  const amountWeight = (s: { price: number; item_count: number }) => s.price
  const quantityWeight = (s: { price: number; item_count: number }) => Math.max(s.item_count, 1)

  let weight = method === 'by_quantity' ? quantityWeight : amountWeight
  let total = sales.reduce((sum, s) => sum + weight(s), 0)

  // 金額按分で重みの合計が0円（価格0の販売だけの月）なら、経費の配賦先が消えて
  // しまうため数量按分に切り替える（quantityWeight は必ず1以上なのでtotalは0にならない）
  if (total === 0 && method === 'by_amount') {
    weight = quantityWeight
    total = sales.reduce((sum, s) => sum + weight(s), 0)
  }

  let assigned = 0
  sales.forEach((s, idx) => {
    const isLast = idx === sales.length - 1
    // 端数は最終行へ。合計を expenseTotal と一致させるため
    const share = isLast
      ? expenseTotal - assigned
      : Number((BigInt(expenseTotal) * BigInt(weight(s))) / BigInt(total))
    if (!isLast) assigned += share
    map.set(s.id, share)
  })
  return map
}

interface BookRow {
  alloc_method: AllocMethod
  closed_at: string | null
  sales_count: number | null
  revenue: number | null
  gross_profit: number | null
  expense_total: number | null
  net_profit: number | null
}

/** 月次の明細（月次タブの月をクリック）。tagId を渡すとそのタグの分だけの合計も返す */
export async function getMonthDetail(
  ctx: Ctx, month: string, opts?: { tagId?: string | null } | null,
): Promise<MonthDetail> {
  const monthText = argMonth('月', month)
  const o = argOptObject('絞り込み', opts)
  const tagId = argOptId('タグ', o?.tagId)
  const { start, end } = monthBounds(monthText)

  const allSales = await listSales(ctx, { month: monthText, kind: 'resale' })
  const sales = allSales.filter(isRealized)
  const forecast_sales = allSales.filter(s => !isRealized(s))
  const allPersonalSales = await listSales(ctx, { month: monthText, kind: 'personal' })
  const personal_sales = allPersonalSales.filter(isRealized)
  const expenses = await listExpenses(ctx, monthText)
  const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0)

  // 明細（expense_line）があるレシートは明細ごとの項目で、無いレシートは親の項目で集計する
  // （複数項目にまたがるレシートを先頭の項目にまとめて計上しない）
  const expense_by_category = await ctx.sql.all<{ category: ExpenseCategory; amount: number }>(`
    select category, coalesce(sum(amount), 0) as amount from (
      select el.category as category, el.amount as amount
        from expense e
        join expense_line el on el.household_id = e.household_id and el.expense_id = e.id
       where e.month = ?
      union all
      select e.category as category, e.amount as amount
        from expense e
       where e.month = ?
         and not exists (select 1 from expense_line el where el.household_id = e.household_id and el.expense_id = e.id)
    ) t
    group by category
    order by category collate "C"
  `, monthText, monthText)

  const bookRow = await ctx.sql.get<BookRow>(`
    select alloc_method, closed_at, sales_count, revenue, gross_profit, expense_total, net_profit
      from month_book where month = ?
  `, monthText)

  const alloc_method: AllocMethod = bookRow?.alloc_method ?? 'by_amount'

  const allocMap = allocateExpenseToSales(sales, expenseTotal, alloc_method)
  const monthSales: MonthSaleRow[] = sales.map(s => {
    const allocated_expense = allocMap.get(s.id) ?? 0
    return { ...s, allocated_expense, net_profit: s.gross_profit - allocated_expense }
  })

  const base = sumSaleTotals(sales)
  const totals: MonthTotals = {
    ...base,
    expense_total: expenseTotal,
    net_profit: base.gross_profit - expenseTotal,
  }

  let filtered: (MonthTotals & { tag: Tag }) | null = null
  if (tagId) {
    const tagRow = await ctx.sql.get<Tag>('select id, name, sort_order from tag where id = ?', tagId)
    if (!tagRow) throw new UserError('タグが見つかりません', 'not_found')

    const matched = monthSales.filter(s =>
      s.tags.some(t => t.id === tagId) || s.inherited_tags.some(t => t.id === tagId))
    const matchedBase = sumSaleTotals(matched)
    filtered = {
      ...matchedBase,
      expense_total: matched.reduce((sum, s) => sum + s.allocated_expense, 0),
      net_profit: matched.reduce((sum, s) => sum + s.net_profit, 0),
      tag: tagRow,
    }
  }

  // sum(bigint) は numeric＝文字列で返るので、bigint に戻す。unit_price × quantity も int4 を溢れさせない
  const purchases_by_account = await ctx.sql.all<
    { shop_account_id: string; shop_account_name: string; count: number; total_cost: number }
  >(`
    select p.shop_account_id as shop_account_id, sa.name as shop_account_name,
           count(distinct p.id) as count,
           coalesce(sum(pl.unit_price::bigint * pl.quantity + pl.allocated_cost), 0)::bigint as total_cost
      from purchase p
      join shop_account sa on sa.household_id = p.household_id and sa.id = p.shop_account_id
      left join purchase_line pl on pl.household_id = p.household_id and pl.purchase_id = p.id
     where p.ordered_at >= ?::date and p.ordered_at <= ?::date and p.status = 'confirmed'
     group by p.shop_account_id, sa.name
     order by sa.name collate "C"
  `, start, end)

  const pending = {
    unconfirmed_shipping: sales.filter(s => s.is_shipping_confirmed === 0).length,
    unmatched: sales.filter(s => s.unmatched === 1).length,
  }

  const close: MonthClose | null = bookRow?.closed_at
    ? {
        month: monthText,
        closed_at: bookRow.closed_at,
        alloc_method: bookRow.alloc_method,
        sales_count: bookRow.sales_count ?? 0,
        revenue: bookRow.revenue ?? 0,
        gross_profit: bookRow.gross_profit ?? 0,
        expense_total: bookRow.expense_total ?? 0,
        net_profit: bookRow.net_profit ?? 0,
      }
    : null

  const changed_since_close = close !== null && (
    close.sales_count !== totals.sales_count
    || close.revenue !== totals.revenue
    || close.gross_profit !== totals.gross_profit
    || close.expense_total !== totals.expense_total
    || close.net_profit !== totals.net_profit
  )

  return {
    month: monthText, alloc_method, close, changed_since_close,
    forecast_sales, forecast: forecastTotals(allSales),
    personal_forecast: forecastTotals(allPersonalSales),
    sales: monthSales, personal_sales, expenses, expense_by_category,
    totals, filtered, purchases_by_account, pending,
  }
}

/** その月の経費の按分方法（既定 by_amount）。締め済みでも変えられる */
export async function setMonthAllocMethod(ctx: Ctx, month: string, method: AllocMethod): Promise<void> {
  const m = argMonth('月', month)
  const am = argEnum('按分方法', method, ALLOC_METHODS)
  await ctx.sql.run(`
    insert into month_book (month, alloc_method) values (?, ?)
    on conflict (household_id, month) do update set alloc_method = excluded.alloc_method
  `, m, am)
}

/** 終わった月（今月・未来ではない月）だけ締められる。締めた時点の数字を month_book に記録する */
export async function closeMonth(ctx: Ctx, month: string): Promise<MonthClose> {
  const m = argMonth('月', month)
  if (m >= thisMonthJst()) {
    throw new UserError('終わった月だけ締められます')
  }

  const detail = await getMonthDetail(ctx, m)
  const closedAt = nowIso()

  await ctx.sql.run(`
    insert into month_book
      (month, alloc_method, closed_at, sales_count, revenue, gross_profit, expense_total, net_profit)
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (household_id, month) do update set
      closed_at = excluded.closed_at,
      sales_count = excluded.sales_count,
      revenue = excluded.revenue,
      gross_profit = excluded.gross_profit,
      expense_total = excluded.expense_total,
      net_profit = excluded.net_profit
  `,
    m, detail.alloc_method, closedAt,
    detail.totals.sales_count, detail.totals.revenue, detail.totals.gross_profit,
    detail.totals.expense_total, detail.totals.net_profit,
  )

  return {
    month: m,
    closed_at: closedAt,
    alloc_method: detail.alloc_method,
    sales_count: detail.totals.sales_count,
    revenue: detail.totals.revenue,
    gross_profit: detail.totals.gross_profit,
    expense_total: detail.totals.expense_total,
    net_profit: detail.totals.net_profit,
  }
}

/** 締めを解除する（数字は消える。alloc_method は残す） */
export async function reopenMonth(ctx: Ctx, month: string): Promise<void> {
  await ctx.sql.run(`
    update month_book
       set closed_at = null, sales_count = null, revenue = null, gross_profit = null,
           expense_total = null, net_profit = null
     where month = ?
  `, argMonth('月', month))
}

// ------------------------------------------------------------
// CSV
// ------------------------------------------------------------

/**
 * 経費（1行＝経費の1明細）のCSV行。month（YYYY-MM）を渡すと計上月（expense.month。
 * occurred_at ではない）で絞る。明細（expense_line）が無い経費（合計だけ入力）は
 * 経費本体の値を1行として出す（inner join で落とさない）。
 * 登録番号はレシートから読めた経費だけ（インボイスの控え）。0件は空文字
 */
export async function exportExpenseRows(ctx: Ctx, month?: string | null): Promise<string> {
  const m = month === '' ? undefined : argOptMonth('月', month)
  const rows = await ctx.sql.all<Record<string, unknown>>(`
    select
      e.month                                 as "計上月",
      e.occurred_at                           as "購入日",
      e.shop                                  as "購入店",
      coalesce(e.registration_no, '')         as "登録番号",
      case coalesce(el.category, e.category)
        when 'packaging'     then '梱包費'
        when 'supplies'      then '消耗品'
        when 'shipping'      then '送料'
        when 'fee'           then '手数料'
        when 'transfer_fee'  then '振込手数料'
        else 'その他'
      end                                     as "項目",
      coalesce(el.name, '')                   as "品名",
      coalesce(el.unit_price, e.amount)       as "単価",
      coalesce(el.quantity, 1)                as "数量",
      coalesce(el.amount, e.amount)           as "金額",
      e.note                                  as "メモ"
    from expense e
    left join expense_line el on el.household_id = e.household_id and el.expense_id = e.id
    ${m ? 'where e.month = ?' : ''}
    order by e.month, e.occurred_at, e.created_at, e.id, el.sort_order
  `, ...(m ? [m] : []))
  return rowsToCsv(rows)
}

// 登録するのは画面が使うものだけ。attachReceipt・readReceiptImage（ファイルを選ぶダイアログ）は Web では登録しない
// （画面が prepareUpload → Storage へ直接 → attachReceiptPath／readReceiptAt に置き換える）
registerHandler('listMonthly', (ctx) => listMonthly(ctx))
registerHandler('listExpenses', (ctx, month) => listExpenses(ctx, month ?? undefined))
registerHandler('createExpense', (ctx, input) => createExpense(ctx, input))
registerHandler('updateExpense', (ctx, id, input) => updateExpense(ctx, id, input))
registerHandler('deleteExpense', (ctx, id) => deleteExpense(ctx, id))
registerHandler('removeReceipt', (ctx, id) => removeReceipt(ctx, id))
registerWebHandler('attachReceiptPath', (ctx, expenseId, path) => attachReceiptPath(ctx, expenseId, path))
// AI 読み取りは Gemini と通信するので、3 段（読み出し → 通信 → 整えて返す）で走らせてトランザクションを握らない
registerPhasedHandler('readReceipt', {
  read: async (ctx, id): Promise<ReceiptReadInput> => prepareReceiptRead(ctx, await attachedReceiptPath(ctx, id), false),
  call: callReceiptRead,
  finish: async (ctx, _input, called): Promise<ReceiptDraft> => applyShopAlias(ctx, called.draft),
})
registerPhasedHandler('readReceiptAt', {
  read: async (ctx, path): Promise<ReceiptReadInput> =>
    prepareReceiptRead(ctx, assertUploadPath(ctx, 'receipt', path), true),
  call: callReceiptRead,
  finish: async (ctx, input, called): Promise<ReceiptRead> => ({
    temp_file: input.path,
    receipt_url: called.receipt_url!,
    draft: await applyShopAlias(ctx, called.draft),
  }),
})
registerHandler('getMonthDetail', (ctx, month, opts) => getMonthDetail(ctx, month, opts ?? undefined))
registerHandler('setMonthAllocMethod', (ctx, month, method) => setMonthAllocMethod(ctx, month, method))
registerHandler('closeMonth', (ctx, month) => closeMonth(ctx, month))
registerHandler('reopenMonth', (ctx, month) => reopenMonth(ctx, month))
