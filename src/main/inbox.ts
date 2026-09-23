import * as db from './db'
import { todayLocal, thisMonthLocal } from '../shared/date'
import type {
  ExpenseCategory, Inbox, InboxGroup, InboxItem, InboxKind, InventoryItem, MonthlySummary,
  PurchaseSummary, ReminderType, SaleProfit,
} from '../shared/types'

// ============================================================
// ホーム（受信箱）。今やること・利益ストリップ・見直すものを1画面分組み立てる。
//
// ここでは利益を再計算しない（sale_profit / monthly_summary の値をそのまま使う）。
// 「見込み」だけは estimateSaleProfit と同じ考え方（手数料は確定値、送料・原価は
// 分かっていればそれ、無ければ発送方法の相場・型番一致の候補）で組み立てる。
// 紐付けはここでも確定しない。候補（型番一致・先入先出）を1点だけ添えるだけ。
// ============================================================

const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  packaging: '梱包費',
  supplies: '消耗品',
  shipping: '送料',
  fee: '手数料',
  transfer_fee: '振込手数料',
  other: 'その他',
}

const LOGGED_KINDS = [
  'updateSale', 'linkInventory', 'confirmPurchase',
  'reserveInventory', 'setListingShipping', 'updatePurchaseFulfillment',
]

// ------------------------------------------------------------
// 日付ヘルパー
// ------------------------------------------------------------

/** 'YYYY-MM' を1か月戻す */
function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** YYYY-MM-DD 同士の日数差（today − date） */
function daysSinceDate(dateStr: string, today: string): number {
  const a = Date.parse(`${dateStr}T00:00:00Z`)
  const b = Date.parse(`${today}T00:00:00Z`)
  return Math.floor((b - a) / 86400000)
}

/** SQLite の datetime('now')（UTC、'YYYY-MM-DD HH:MM:SS' か ISO）から今までの日数 */
function daysSinceDatetime(dt: string): number {
  const iso = dt.includes('T') ? dt : `${dt.replace(' ', 'T')}Z`
  const t = Date.parse(iso)
  return Math.floor((Date.now() - t) / 86400000)
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function mmdd(dateStr: string): string {
  return `${dateStr.slice(5, 7)}/${dateStr.slice(8, 10)}`
}

// ------------------------------------------------------------
// スヌーズ（「忘れていませんか」を7日消す）
// ------------------------------------------------------------

function snoozeKey(type: ReminderType, id: string | null): string {
  return `snooze:${type}:${id ?? '-'}`
}

function isSnoozed(settings: Record<string, string>, type: ReminderType, id: string | null, today: string): boolean {
  const until = settings[snoozeKey(type, id)]
  return !!until && until >= today
}

/** 「忘れていませんか」を7日消す。今日＋7日を保存する */
export function snoozeReminder(type: ReminderType, id?: string | null): void {
  const until = todayLocal(new Date(Date.now() + 7 * 86400000))
  db.setSetting(snoozeKey(type, id ?? null), until)
}

// ------------------------------------------------------------
// 未紐付けの販売の候補（型番一致・先入先出）。
// suggestInventory はランク順（在庫コード一致 → 型番一致 → …）＋滞留日数の
// 降順（＝先入先出）で返すため、model_code が sale.model_codes に入っているものだけに絞る。
// ------------------------------------------------------------

function modelMatchCandidates(sale: SaleProfit): InventoryItem[] {
  if (sale.model_codes.length === 0) return []
  const codes = new Set(sale.model_codes)
  return db.suggestInventory(sale.id, 50).filter(item => item.model_code && codes.has(item.model_code))
}

function toCandidate(item: InventoryItem): NonNullable<InboxItem['candidate']> {
  return {
    inventory_item_id: item.id, item_code: item.item_code,
    landed_cost: item.landed_cost, acquired_at: item.acquired_at,
  }
}

/** 紐付け済みならその原価、未紐付けなら候補1点（型番一致・先入先出）の原価、無ければ0 */
function estimateCost(sale: SaleProfit): number {
  if (sale.unmatched === 0) return sale.cost
  const candidate = modelMatchCandidates(sale)[0]
  return candidate ? candidate.landed_cost : 0
}

// ------------------------------------------------------------
// 送料の見積もり（発送方法が決まっていなければ相場を使う）
// ------------------------------------------------------------

function activeShippingFees(): number[] {
  return db.listShippingMethods().map(m => m.fee)
}

function shippingFeeRange(): { min: number; max: number } {
  const fees = activeShippingFees()
  if (fees.length === 0) return { min: 0, max: 0 }
  return { min: Math.min(...fees), max: Math.max(...fees) }
}

/** 送料が既に分かっていれば（出品時に決めた／選択済み）その額、まだなら null */
function knownShippingFee(sale: SaleProfit): number | null {
  if (sale.is_shipping_confirmed) return sale.shipping_fee
  if (sale.shipping_method_id) {
    const m = db.getDb().prepare('SELECT fee FROM shipping_method WHERE id = ?')
      .get(sale.shipping_method_id) as { fee: number } | undefined
    if (m) return m.fee
  }
  return null
}

/** 発送方法が決まっていれば1値（min=max）、未定なら料金の最小〜最大で幅 */
function shipProfitHint(sale: SaleProfit): { min: number; max: number } {
  const cost = estimateCost(sale)
  const known = knownShippingFee(sale)
  if (known !== null) {
    const p = sale.price - sale.fee - known - sale.packaging_cost - cost
    return { min: p, max: p }
  }
  const range = shippingFeeRange()
  return {
    min: sale.price - sale.fee - range.max - sale.packaging_cost - cost,
    max: sale.price - sale.fee - range.min - sale.packaging_cost - cost,
  }
}

// ------------------------------------------------------------
// 表示用の1行（detail）
// ------------------------------------------------------------

function shippingMethodNameMap(): Map<string, string> {
  const rows = db.getDb().prepare('SELECT id, name FROM shipping_method').all() as
    Array<{ id: string; name: string }>
  return new Map(rows.map(r => [r.id, r.name]))
}

function buildSaleDetail(sale: SaleProfit, methodNames: Map<string, string>): string {
  const methodName = sale.shipping_method_id ? (methodNames.get(sale.shipping_method_id) ?? '未定') : '未定'
  return `${mmdd(sale.sold_at)} に売れた ・ ¥${sale.price.toLocaleString()} ・ 買い手 ${sale.buyer ?? '不明'} ・ 発送方法 ${methodName}`
}

function fulfillmentLabel(f: string | null): string {
  if (f === 'delivered') return '到着済'
  if (f === 'shipped') return '配送中'
  return '未着'
}

function buildPurchaseDetail(p: PurchaseSummary): string {
  return `${mmdd(p.ordered_at)} 注文 ・ ${p.line_count} 明細 ・ ${fulfillmentLabel(p.fulfillment)}`
}

// ------------------------------------------------------------
// 「忘れていませんか」
// ------------------------------------------------------------

function buildManualPurchaseReminders(settings: Record<string, string>, today: string): InboxItem[] {
  const rows = db.getDb().prepare(`
    SELECT sa.id, sa.name, sa.created_at,
      (SELECT ordered_at FROM purchase WHERE shop_account_id = sa.id AND status = 'confirmed'
         ORDER BY ordered_at DESC, created_at DESC LIMIT 1) AS last_ordered_at,
      (SELECT order_no FROM purchase WHERE shop_account_id = sa.id AND status = 'confirmed'
         ORDER BY ordered_at DESC, created_at DESC LIMIT 1) AS last_order_no
    FROM shop_account sa
    WHERE sa.is_active = 1 AND sa.kind != 'mellojoy'
  `).all() as Array<{
    id: string; name: string; created_at: string
    last_ordered_at: string | null; last_order_no: string | null
  }>

  const items: InboxItem[] = []
  for (const r of rows) {
    let overdue: boolean
    let detail: string
    if (r.last_ordered_at) {
      overdue = daysSinceDate(r.last_ordered_at, today) >= 7
      detail = `最後の登録は ${mmdd(r.last_ordered_at)}（${r.last_order_no ?? '注文番号なし'}）`
    } else {
      overdue = daysSinceDatetime(r.created_at) >= 14
      detail = 'まだ仕入の登録がありません'
    }
    if (!overdue) continue
    if (isSnoozed(settings, 'manual_purchase', r.id, today)) continue

    items.push({
      kind: 'reminder',
      id: r.id,
      title: `${r.name} の仕入は登録しましたか？`,
      detail,
      thumb_url: null,
      reminder: { type: 'manual_purchase', action_label: '仕入を登録' },
    })
  }
  return items
}

function buildDeliveryReminders(settings: Record<string, string>, today: string): InboxItem[] {
  const rows = db.getDb().prepare(`
    SELECT p.id, p.fulfillment, p.fulfillment_updated_at,
      (SELECT name FROM purchase_line
         WHERE purchase_id = p.id ORDER BY sort_order, rowid LIMIT 1) AS first_line_name,
      (SELECT model_code FROM purchase_line
         WHERE purchase_id = p.id ORDER BY sort_order, rowid LIMIT 1) AS first_model_code
    FROM purchase p
    WHERE p.status = 'confirmed' AND p.import_key IS NULL AND p.fulfillment IN ('pending','shipped')
  `).all() as Array<{
    id: string; fulfillment: string; fulfillment_updated_at: string | null
    first_line_name: string | null; first_model_code: string | null
  }>

  const items: InboxItem[] = []
  for (const r of rows) {
    if (!r.fulfillment_updated_at) continue
    const days = daysSinceDatetime(r.fulfillment_updated_at)
    if (days < 5) continue
    if (isSnoozed(settings, 'delivery', r.id, today)) continue

    const name = r.first_model_code
      ? `【${r.first_model_code}】${r.first_line_name ?? ''}`
      : (r.first_line_name ?? '(商品名なし)')

    items.push({
      kind: 'reminder',
      id: r.id,
      title: `${name} は届きましたか？`,
      detail: `${fulfillmentLabel(r.fulfillment)}のまま ${days} 日`,
      thumb_url: null,
      reminder: { type: 'delivery', action_label: '到着済にする', purchase_id: r.id },
    })
  }
  return items
}

function buildExpenseReminder(settings: Record<string, string>, today: string): InboxItem | null {
  if (Number(today.slice(8, 10)) < 10) return null

  const month = today.slice(0, 7)
  const countRow = db.getDb().prepare('SELECT COUNT(*) AS c FROM expense WHERE month = ?')
    .get(month) as { c: number }
  if (countRow.c > 0) return null
  if (isSnoozed(settings, 'expense', month, today)) return null

  const lastMonth = prevMonth(month)
  const catRow = db.getDb().prepare(`
    SELECT category, SUM(amount) AS total FROM expense
     WHERE month = ? GROUP BY category ORDER BY total DESC LIMIT 1
  `).get(lastMonth) as { category: ExpenseCategory; total: number } | undefined
  const detail = catRow
    ? `先月は ${CATEGORY_LABEL[catRow.category]} ¥${catRow.total.toLocaleString()}`
    : '先月も経費の記録がありません'

  return {
    kind: 'reminder',
    id: month,
    title: '今月の経費がまだ0件です',
    detail,
    thumb_url: null,
    reminder: { type: 'expense', action_label: 'レシートを読み取る' },
  }
}

function buildCloseMonthReminder(
  settings: Record<string, string>, today: string, monthly: MonthlySummary[],
): InboxItem | null {
  if (Number(today.slice(8, 10)) < 3) return null

  const lastMonth = prevMonth(today.slice(0, 7))
  const row = monthly.find(r => r.month === lastMonth && r.kind === 'resale')
  if (!row || row.closed) return null
  if (isSnoozed(settings, 'close_month', lastMonth, today)) return null

  return {
    kind: 'reminder',
    id: lastMonth,
    title: `先月（${lastMonth}）を締めましょう`,
    detail: `売上 ¥${row.revenue.toLocaleString()} ・ 純利益 ¥${row.net_profit.toLocaleString()}`,
    thumb_url: null,
    reminder: { type: 'close_month', action_label: '月次を開く', month: lastMonth },
  }
}

// ------------------------------------------------------------
// 取り込みの問題
// ------------------------------------------------------------

function runStatusLabel(status: string): string {
  if (status === 'auth_required') return 'ログインが必要'
  if (status === 'empty') return '0件（取得できていない可能性）'
  return '失敗'
}

// ------------------------------------------------------------
// 今日片付けた件数
// ------------------------------------------------------------

function countDoneToday(today: string): number {
  try {
    const ph = LOGGED_KINDS.map(() => '?').join(',')
    const rows = db.getDb().prepare(
      `SELECT ts FROM app_log WHERE source = 'ipc' AND error IS NULL AND kind IN (${ph})`,
    ).all(...LOGGED_KINDS) as Array<{ ts: string }>
    return rows.filter(r => todayLocal(new Date(r.ts)) === today).length
  } catch {
    // app_log がまだ無い（initAppLog未実行）。0件扱いにする
    return 0
  }
}

// ------------------------------------------------------------
// 本体
// ------------------------------------------------------------

export function getInbox(): Inbox {
  const today = todayLocal()
  const month = thisMonthLocal()
  const lastMonthStr = prevMonth(month)
  const settings = db.getSettings()
  const monthly = db.listMonthly()
  const methodNames = shippingMethodNameMap()

  const allSales = db.listSales()

  // ---- ship / shipping / link ----
  const shipSales = allSales.filter(s => s.status === 'waiting_shipment')
  const shippingSales = allSales.filter(s => s.is_shipping_confirmed === 0 && s.status !== 'waiting_shipment')
  const linkSales = allSales.filter(s => s.kind === 'resale' && s.unmatched === 1)

  const shipItems: InboxItem[] = shipSales.map(s => ({
    kind: 'ship',
    id: s.id,
    title: s.title,
    detail: buildSaleDetail(s, methodNames),
    thumb_url: s.thumb_url,
    sale: s,
    profit_hint: shipProfitHint(s),
  }))

  const shippingItems: InboxItem[] = shippingSales.map(s => ({
    kind: 'shipping',
    id: s.id,
    title: s.title,
    detail: buildSaleDetail(s, methodNames),
    thumb_url: s.thumb_url,
    sale: s,
    profit_hint: shipProfitHint(s),
  }))

  const linkItems: InboxItem[] = linkSales.map(s => {
    const candidates = modelMatchCandidates(s)
    const candidate = candidates.length === 1 ? toCandidate(candidates[0]) : null
    const profit_hint = candidate
      ? {
          min: s.price - s.fee - s.shipping_fee - s.packaging_cost - candidates[0].landed_cost,
          max: s.price - s.fee - s.shipping_fee - s.packaging_cost - candidates[0].landed_cost,
        }
      : null
    return {
      kind: 'link',
      id: s.id,
      title: s.title,
      detail: buildSaleDetail(s, methodNames),
      thumb_url: s.thumb_url,
      sale: s,
      candidate,
      profit_hint,
    }
  })

  // ---- confirm（下書きの仕入） ----
  const confirmItems: InboxItem[] = db.listPurchases()
    .filter(p => p.status === 'draft')
    .map(p => ({
      kind: 'confirm',
      id: p.id,
      title: p.first_line_name ?? '(商品名未定)',
      detail: buildPurchaseDetail(p),
      thumb_url: null,
      purchase: p,
    }))

  // ---- collect（取り込みの問題） ----
  const collectItems: InboxItem[] = db.getDashboard().recentRuns
    .filter(r => r.status !== 'ok')
    .map(r => ({
      kind: 'collect',
      id: r.id,
      title: r.shop_account_name ?? (r.source === 'mercari' ? 'メルカリ' : r.source),
      detail: `${formatDateTime(r.started_at)} ・ ${r.message ?? runStatusLabel(r.status)}`,
      thumb_url: null,
      run: r,
    }))

  // ---- reminder（忘れていませんか） ----
  const reminderItems: InboxItem[] = [
    ...buildManualPurchaseReminders(settings, today),
    ...buildDeliveryReminders(settings, today),
    ...[buildExpenseReminder(settings, today)].filter((x): x is InboxItem => x !== null),
    ...[buildCloseMonthReminder(settings, today, monthly)].filter((x): x is InboxItem => x !== null),
  ]

  const groups: InboxGroup[] = []
  const push = (kind: InboxKind, label: string, hint: string, items: InboxItem[]) => {
    if (items.length > 0) groups.push({ kind, label, hint, items })
  }
  push('ship', '発送する', '売れて未発送。メルカリで発送したら次の取り込みで消えます', shipItems)
  push('shipping', '送料を入れる', '売れたが送料が決まっていない。選べば利益が出ます', shippingItems)
  push('link', '在庫を紐付ける', 'どの仕入の品か決まっていない。型番が合えば自動で入ります', linkItems)
  push('confirm', '仕入の価格を入れる', 'メロジョイの注文が下書きのまま。単価を入れると在庫ができます', confirmItems)
  push('collect', '取り込みの問題', 'ログインが切れているか、取得に失敗しています', collectItems)
  push('reminder', '忘れていませんか', '自分で入れるもの。済んでいれば「今はいい」で1週間消えます', reminderItems)

  // ---- ストリップ（今月の粗利） ----
  const thisMonthRow = monthly.find(r => r.month === month && r.kind === 'resale')
  const lastMonthRow = monthly.find(r => r.month === lastMonthStr && r.kind === 'resale')

  const payoutRow = db.getDb().prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(price - fee), 0) AS total
    FROM sale WHERE status IN ('shipped','delivered')
  `).get() as { c: number; total: number }

  const strip: Inbox['strip'] = {
    month,
    gross_profit: thisMonthRow?.gross_profit ?? 0,
    net_profit: thisMonthRow?.net_profit ?? 0,
    revenue: thisMonthRow?.revenue ?? 0,
    sales_count: thisMonthRow?.sales_count ?? 0,
    pending_profit_estimate: thisMonthRow?.forecast?.gross_profit ?? 0,
    pending_count: thisMonthRow?.forecast?.count ?? 0,
    awaiting_payout: payoutRow.total,
    awaiting_payout_count: payoutRow.c,
    last_month: lastMonthRow
      ? { month: lastMonthStr, net_profit: lastMonthRow.net_profit, closed: lastMonthRow.closed }
      : null,
  }

  // ---- 見直すもの ----
  const agingWarnDays = Number(settings['aging_warn_days'] ?? 60)
  const agingRow = db.getDb().prepare(
    `SELECT COUNT(*) AS c FROM inventory_view WHERE status = 'in_stock' AND aging_days >= ?`,
  ).get(agingWarnDays) as { c: number }
  const topProduct = db.listProducts('total_profit')[0]

  const review: Inbox['review'] = {
    aging_count: agingRow.c,
    aging_days: agingWarnDays,
    unallocated_listings: db.getDashboard().needsListingAllocation,
    last_month_unclosed: (lastMonthRow && !lastMonthRow.closed) ? lastMonthStr : null,
    top_model: topProduct
      ? { model_code: topProduct.model_code, name: topProduct.name, total_profit: topProduct.total_profit }
      : null,
  }

  return { strip, groups, done_today: countDoneToday(today), review }
}
