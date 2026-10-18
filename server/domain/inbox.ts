import type { Ctx } from '../context'
import { registerHandler } from '../rpc'
import { CHANNEL_LABEL } from '../../src/shared/types'
import type {
  ExpenseCategory, Inbox, InboxGroup, InboxItem, InboxKind, InventoryItem, MonthlySummary,
  PurchaseSummary, ReminderType, SaleProfit, SalesChannel,
} from '../../src/shared/types'
import {
  argEnum, argOptText, forecastTotals, mediaUrl, subtractDaysJst, thisMonthJst, todayJst, yenText,
} from './_shared'
import { getDashboard } from './home'
import { suggestInventory } from './inventory'
import { getSettings, listShippingMethods, setSetting } from './master'
import { listMonthly } from './monthly'
import { listVariantSummary } from './product'
import { listPurchases } from './purchase'
import { listSales } from './sale'

// ============================================================
// ホーム（受信箱）。今やること・利益ストリップ・見直すものを1画面分組み立てる。
//
// src/main/inbox.ts の移植。毎日いちばん最初に見る画面なので、種類と並び順は変えない。
// ここでは利益を再計算しない（sale_profit / monthly_summary の値をそのまま使う）。
// 「見込み」だけは estimateSaleProfit と同じ考え方（手数料は確定値、送料・原価は
// 分かっていればそれ、無ければ発送方法の相場・型番一致の候補）で組み立てる。
// 紐付けはここでも確定しない。候補（型番一致・先入先出）を1点だけ添えるだけ。
//
// 日付：サーバー（Workers）は UTC。「今日」「今月」「今日片付けた」は日本時間で決める。
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

const REMINDER_TYPES: readonly ReminderType[] = ['manual_purchase', 'delivery', 'expense', 'close_month']
const SNOOZE_ID_MAX = 100
const SNOOZE_DAYS = 7
const AGING_WARN_DAYS_DEFAULT = 60

// ------------------------------------------------------------
// 日付ヘルパー
// ------------------------------------------------------------

/** 'YYYY-MM' を1か月戻す（暦の計算だけ。サーバーのタイムゾーンに依らない） */
function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** YYYY-MM-DD 同士の日数差（today − date） */
function daysSinceDate(dateStr: string, today: string): number {
  const a = Date.parse(`${dateStr}T00:00:00Z`)
  const b = Date.parse(`${today}T00:00:00Z`)
  return Math.floor((b - a) / 86400000)
}

/** timestamptz（ISO。UTC の 'YYYY-MM-DDTHH:MM:SS.sssZ'）から今までの日数 */
function daysSinceDatetime(dt: string): number {
  const iso = dt.includes('T') ? dt : `${dt.replace(' ', 'T')}Z`
  const t = Date.parse(iso)
  return Math.floor((Date.now() - t) / 86400000)
}

/** ISO の時刻を日本時間の 'M/D HH:MM' にする（サーバーの時計の地域に依らない） */
function formatDateTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function mmdd(dateStr: string): string {
  return `${dateStr.slice(5, 7)}/${dateStr.slice(8, 10)}`
}

// ------------------------------------------------------------
// スヌーズ（「忘れていませんか」を7日消す）
//
// 世帯ごとの設定（setting）に「いつまで消すか」を入れる。デスクトップ版と同じキーの形。
// ------------------------------------------------------------

function snoozeKey(type: ReminderType, id: string | null): string {
  return `snooze:${type}:${id ?? '-'}`
}

function isSnoozed(settings: Record<string, string>, type: ReminderType, id: string | null, today: string): boolean {
  const until = settings[snoozeKey(type, id)]
  return !!until && until >= today
}

/** 「忘れていませんか」を7日消す。今日（日本時間）＋7日を保存する */
export async function snoozeReminder(ctx: Ctx, type: ReminderType, id?: string | null): Promise<void> {
  const t = argEnum('リマインドの種類', type, REMINDER_TYPES)
  const target = argOptText('リマインドの対象', id, { max: SNOOZE_ID_MAX }) ?? null
  const until = subtractDaysJst(todayJst(), -SNOOZE_DAYS)
  await setSetting(ctx, snoozeKey(t, target), until)
}

// ------------------------------------------------------------
// 未紐付けの販売の候補（型番一致・先入先出）。
// suggestInventory はランク順（在庫コード一致 → 型番一致 → …）＋滞留日数の
// 降順（＝先入先出）で返すため、model_code が sale.model_codes に入っているものだけに絞る。
// 同じ販売を送料の見積もりと紐付けの候補で 2 回引くので、1 回の getInbox の中では覚えておく。
// ------------------------------------------------------------

type CandidateFinder = (sale: SaleProfit) => Promise<InventoryItem[]>

function makeCandidateFinder(ctx: Ctx): CandidateFinder {
  const cache = new Map<string, InventoryItem[]>()
  return async (sale) => {
    if (sale.model_codes.length === 0) return []
    const cached = cache.get(sale.id)
    if (cached) return cached
    const codes = new Set(sale.model_codes)
    const found = (await suggestInventory(ctx, sale.id, 50)).filter(item => item.model_code && codes.has(item.model_code))
    cache.set(sale.id, found)
    return found
  }
}

/** 名前は在庫の商品名（型番に付けた表示名があればそれ、無ければ明細の名前。release の items と同じ） */
function toCandidate(item: InventoryItem): NonNullable<InboxItem['candidate']> {
  return {
    inventory_item_id: item.id, item_code: item.item_code, name: item.product_name ?? item.name,
    landed_cost: item.landed_cost, acquired_at: item.acquired_at,
  }
}

/** 紐付け済みならその原価、未紐付けなら候補1点（型番一致・先入先出）の原価、無ければ0 */
async function estimateCost(sale: SaleProfit, findCandidates: CandidateFinder): Promise<number> {
  if (sale.unmatched === 0) return sale.cost
  const candidate = (await findCandidates(sale))[0]
  return candidate ? candidate.landed_cost : 0
}

// ------------------------------------------------------------
// 送料の見積もり（発送方法が決まっていなければ相場を使う）
// ------------------------------------------------------------

type MethodMap = Map<string, { name: string; fee: number }>

/** 無効にした発送方法も含む（過去の販売が引き続き料金を引けるように。名前の表示にも使う） */
async function shippingMethodMap(ctx: Ctx): Promise<MethodMap> {
  const rows = await ctx.sql.all<{ id: string; name: string; fee: number }>('select id, name, fee from shipping_method')
  return new Map(rows.map(r => [r.id, { name: r.name, fee: r.fee }]))
}

/** 相場は有効な発送方法の最小〜最大。count は有効な発送方法の数（0 なら min/max は 0 で、相場が無い） */
type FeeRange = { min: number; max: number; count: number }

async function shippingFeeRange(ctx: Ctx): Promise<FeeRange> {
  const fees = (await listShippingMethods(ctx)).map(m => m.fee)
  if (fees.length === 0) return { min: 0, max: 0, count: 0 }
  return { min: Math.min(...fees), max: Math.max(...fees), count: fees.length }
}

/** 送料が既に分かっていれば（出品時に決めた／選択済み）その額、まだなら null */
function knownShippingFee(sale: SaleProfit, methods: MethodMap): number | null {
  if (sale.is_shipping_confirmed) return sale.shipping_fee
  if (sale.shipping_method_id) {
    const m = methods.get(sale.shipping_method_id)
    if (m) return m.fee
  }
  return null
}

/** 発送方法が決まっていれば1値（min=max）、未定なら料金の最小〜最大で幅 */
async function shipProfitHint(
  sale: SaleProfit, methods: MethodMap, range: { min: number; max: number }, findCandidates: CandidateFinder,
): Promise<{ min: number; max: number }> {
  const cost = await estimateCost(sale, findCandidates)
  const known = knownShippingFee(sale, methods)
  if (known !== null) {
    const p = sale.price - sale.fee - known - sale.packaging_cost - cost
    return { min: p, max: p }
  }
  return {
    min: sale.price - sale.fee - range.max - sale.packaging_cost - cost,
    max: sale.price - sale.fee - range.min - sale.packaging_cost - cost,
  }
}

/**
 * 未紐付けの販売に候補が 1 点あるとき、その候補を紐付けたときの粗利。shipProfitHint と同じ見積もり
 * （送料が分かっていれば1値、未入力なら有効な発送方法の最安〜最高の幅。原価は候補1点＝estimateCost）。
 * 送料が分からず有効な発送方法も無ければ null（未入力の送料を 0 円と見て、粗利を大きく見せない）
 */
async function linkProfitHint(
  sale: SaleProfit, methods: MethodMap, range: FeeRange, findCandidates: CandidateFinder,
): Promise<{ min: number; max: number } | null> {
  if (knownShippingFee(sale, methods) === null && range.count === 0) return null
  return shipProfitHint(sale, methods, range, findCandidates)
}

// ------------------------------------------------------------
// 表示用の1行（detail）
// ------------------------------------------------------------

function buildSaleDetail(sale: SaleProfit, methods: MethodMap): string {
  const methodName = sale.shipping_method_id ? (methods.get(sale.shipping_method_id)?.name ?? '未定') : '未定'
  return `${mmdd(sale.sold_at)} に売れた ・ ${yenText(sale.price)} ・ 買い手 ${sale.buyer ?? '不明'} ・ 発送方法 ${methodName}`
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
// 止めた出品が在庫を押さえている
//
// 自動紐付けの在庫検索は active／suspended の出品に引き当て済みの在庫を除外する
// （inventory.ts の RESERVED_BY_ACTIVE_LISTING）。止めたまま放置すると、その在庫は他の出品先で
// 売れても紐付けられない。active は押さえているのが正常なので対象外。読み取りだけ。
// ------------------------------------------------------------

type ReleaseItem = NonNullable<InboxItem['release']>['items'][number]

function buildReleaseDetail(channel: SalesChannel, items: ReleaseItem[]): string {
  const state = `${CHANNEL_LABEL[channel]}で出品停止中`
  const tail = '解除すると他の販売に紐付けられます'
  if (items.length === 1) {
    return `${state} ・ 在庫 ${items[0].item_code}（${items[0].name}）が紐付いたまま ・ ${tail}`
  }
  const codes = items.map(i => i.item_code).join('・')
  return `${state} ・ 在庫 ${items.length} 点（${codes}）が紐付いたまま ・ ${tail}`
}

/** 1クエリ。出品1件＝1項目。在庫の名前は inventory_view と同じ（商品名があればそれ、無ければ在庫名） */
async function buildReleaseItems(ctx: Ctx): Promise<InboxItem[]> {
  const rows = await ctx.sql.all<{
    listing_uuid: string; listing_id: string; listing_channel: SalesChannel; listing_title: string
    thumb_path: string | null; inventory_item_id: string; item_code: string; name: string; landed_cost: number
  }>(`
    select l.id as listing_uuid, l.channel_item_id as listing_id, l.channel as listing_channel,
           l.title as listing_title, l.thumb_path as thumb_path,
           i.id as inventory_item_id, i.item_code as item_code,
           coalesce(
             (select pn.name from product_name pn where pn.household_id = i.household_id and pn.model_code = i.model_code),
             i.name
           ) as name,
           i.landed_cost as landed_cost
      from listing l
      join listing_line ll on ll.household_id = l.household_id and ll.listing_id = l.id
      join inventory_item i on i.household_id = ll.household_id and i.id = ll.inventory_item_id
     where l.status = 'suspended' and i.status = 'in_stock'
     order by l.last_seen_at desc, l.channel_item_id collate "C", l.id,
              i.acquired_at, i.created_at, length(i.item_code), i.item_code collate "C"
  `)

  // 出品先をまたいで商品IDが重なっても別の出品として扱う（まとめる鍵は出品の uuid）
  const byListing = new Map<string, InboxItem>()
  for (const r of rows) {
    const item: ReleaseItem = {
      inventory_item_id: r.inventory_item_id, item_code: r.item_code, name: r.name, landed_cost: r.landed_cost,
    }
    const existing = byListing.get(r.listing_uuid)
    if (existing?.release) {
      existing.release.items.push(item)
      continue
    }
    byListing.set(r.listing_uuid, {
      kind: 'release',
      id: r.listing_id,
      title: r.listing_title,
      detail: '',
      thumb_url: mediaUrl(ctx, r.thumb_path),
      release: { listing_id: r.listing_id, listing_channel: r.listing_channel, items: [item] },
    })
  }
  const items = [...byListing.values()]
  for (const it of items) {
    it.detail = buildReleaseDetail(it.release!.listing_channel, it.release!.items)
  }
  return items
}

// ------------------------------------------------------------
// 「忘れていませんか」
// ------------------------------------------------------------

async function buildManualPurchaseReminders(
  ctx: Ctx, settings: Record<string, string>, today: string,
): Promise<InboxItem[]> {
  const rows = await ctx.sql.all<{
    id: string; name: string; created_at: string; last_ordered_at: string | null; last_order_no: string | null
  }>(`
    select sa.id, sa.name, sa.created_at,
      (select p.ordered_at from purchase p
        where p.household_id = sa.household_id and p.shop_account_id = sa.id and p.status = 'confirmed'
        order by p.ordered_at desc, p.created_at desc, p.id limit 1) as last_ordered_at,
      (select p.order_no from purchase p
        where p.household_id = sa.household_id and p.shop_account_id = sa.id and p.status = 'confirmed'
        order by p.ordered_at desc, p.created_at desc, p.id limit 1) as last_order_no
    from shop_account sa
    where sa.is_active = 1 and sa.kind != 'mellojoy'
    order by sa.created_at, sa.name collate "C", sa.id
  `)

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

async function buildDeliveryReminders(
  ctx: Ctx, settings: Record<string, string>, today: string,
): Promise<InboxItem[]> {
  const rows = await ctx.sql.all<{
    id: string; fulfillment: string; fulfillment_updated_at: string | null
    first_line_name: string | null; first_model_code: string | null
  }>(`
    select p.id, p.fulfillment, p.fulfillment_updated_at,
      (select pl.name from purchase_line pl
        where pl.household_id = p.household_id and pl.purchase_id = p.id
        order by pl.sort_order, pl.created_at, pl.id limit 1) as first_line_name,
      (select pl.model_code from purchase_line pl
        where pl.household_id = p.household_id and pl.purchase_id = p.id
        order by pl.sort_order, pl.created_at, pl.id limit 1) as first_model_code
    from purchase p
    where p.status = 'confirmed' and p.import_key is null and p.fulfillment in ('pending', 'shipped')
    order by p.created_at, p.id
  `)

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

async function buildExpenseReminder(
  ctx: Ctx, settings: Record<string, string>, today: string,
): Promise<InboxItem | null> {
  if (Number(today.slice(8, 10)) < 10) return null

  const month = today.slice(0, 7)
  const countRow = await ctx.sql.get<{ c: number }>('select count(*) as c from expense where month = ?', month)
  if (countRow!.c > 0) return null
  if (isSnoozed(settings, 'expense', month, today)) return null

  const lastMonth = prevMonth(month)
  // sum(integer) は bigint（アダプタが number にする）。同額の項目は名前順で毎回同じにする
  const catRow = await ctx.sql.get<{ category: ExpenseCategory; total: number }>(`
    select category, sum(amount) as total from expense
     where month = ? group by category order by total desc, category collate "C" limit 1
  `, lastMonth)
  const detail = catRow
    ? `先月は ${CATEGORY_LABEL[catRow.category]} ${yenText(catRow.total)}`
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
    detail: `売上 ${yenText(row.revenue)} ・ 純利益 ${yenText(row.net_profit)}`,
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
//
// 操作ログ（app_log）の書き込み系から数える目安。「今日」は日本時間の暦日。
// ------------------------------------------------------------

async function countDoneToday(ctx: Ctx, today: string): Promise<number> {
  const row = await ctx.sql.get<{ c: number }>(`
    select count(*) as c from app_log
     where source = 'ipc' and error is null and kind = any(?::text[])
       and (ts at time zone 'Asia/Tokyo')::date = ?::date
  `, LOGGED_KINDS, today)
  return row!.c
}

// ------------------------------------------------------------
// 本体
// ------------------------------------------------------------

export async function getInbox(ctx: Ctx): Promise<Inbox> {
  const today = todayJst()
  const month = thisMonthJst()
  const lastMonthStr = prevMonth(month)
  const settings = await getSettings(ctx)
  const monthly = await listMonthly(ctx)
  const methods = await shippingMethodMap(ctx)
  const feeRange = await shippingFeeRange(ctx)
  const findCandidates = makeCandidateFinder(ctx)

  const allSales = await listSales(ctx)

  // ---- ship / shipping / link ----
  const shipSales = allSales.filter(s => s.status === 'waiting_shipment')
  const shippingSales = allSales.filter(s => s.is_shipping_confirmed === 0 && s.status !== 'waiting_shipment')
  const linkSales = allSales.filter(s => s.kind === 'resale' && s.unmatched === 1)

  const shipItems: InboxItem[] = []
  for (const s of shipSales) {
    shipItems.push({
      kind: 'ship',
      id: s.id,
      title: s.title,
      detail: buildSaleDetail(s, methods),
      thumb_url: s.thumb_url,
      sale: s,
      profit_hint: await shipProfitHint(s, methods, feeRange, findCandidates),
    })
  }

  const shippingItems: InboxItem[] = []
  for (const s of shippingSales) {
    shippingItems.push({
      kind: 'shipping',
      id: s.id,
      title: s.title,
      detail: buildSaleDetail(s, methods),
      thumb_url: s.thumb_url,
      sale: s,
      profit_hint: await shipProfitHint(s, methods, feeRange, findCandidates),
    })
  }

  const linkItems: InboxItem[] = []
  for (const s of linkSales) {
    const candidates = await findCandidates(s)
    const candidate = candidates.length === 1 ? toCandidate(candidates[0]) : null
    const profit_hint = candidate ? await linkProfitHint(s, methods, feeRange, findCandidates) : null
    linkItems.push({
      kind: 'link',
      id: s.id,
      title: s.title,
      detail: buildSaleDetail(s, methods),
      thumb_url: s.thumb_url,
      sale: s,
      candidate,
      profit_hint,
    })
  }

  // ---- confirm（下書きの仕入） ----
  const confirmItems: InboxItem[] = (await listPurchases(ctx))
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
  // getDashboard は 1 回だけ引く（recentRuns と、下の見直すものの未引き当て出品の数の両方に使う）
  const dashboard = await getDashboard(ctx)
  const collectItems: InboxItem[] = dashboard.recentRuns
    .filter(r => r.status !== 'ok')
    .map(r => ({
      kind: 'collect',
      id: r.id,
      title: r.shop_account_name ?? (r.source === 'mercari' ? 'メルカリ' : r.source),
      detail: `${formatDateTime(r.started_at)} ・ ${r.message ?? runStatusLabel(r.status)}`,
      thumb_url: null,
      run: r,
    }))

  // ---- release（止めた出品が在庫を押さえている） ----
  const releaseItems = await buildReleaseItems(ctx)

  // ---- reminder（忘れていませんか） ----
  const expenseReminder = await buildExpenseReminder(ctx, settings, today)
  const closeMonthReminder = buildCloseMonthReminder(settings, today, monthly)
  const reminderItems: InboxItem[] = [
    ...await buildManualPurchaseReminders(ctx, settings, today),
    ...await buildDeliveryReminders(ctx, settings, today),
    ...(expenseReminder ? [expenseReminder] : []),
    ...(closeMonthReminder ? [closeMonthReminder] : []),
  ]

  const groups: InboxGroup[] = []
  const push = (kind: InboxKind, label: string, hint: string, items: InboxItem[]) => {
    if (items.length > 0) groups.push({ kind, label, hint, items })
  }
  push('ship', '発送する', '売れて未発送。メルカリで発送したら次の取り込みで消えます', shipItems)
  push('shipping', '送料を入れる', '売れたが送料が決まっていない。選べば利益が出ます', shippingItems)
  push('link', '在庫を紐付ける', 'どの仕入の品か決まっていない。型番が合えば自動で入ります', linkItems)
  push('release', '止めた出品の在庫を解除する', '出品を止めたのに在庫が紐付いたまま。解除しないと、他の販売にその在庫を紐付けられません', releaseItems)
  push('confirm', '仕入の価格を入れる', 'メロジョイの注文が下書きのまま。単価を入れると在庫ができます', confirmItems)
  push('collect', '取り込みの問題', 'ログインが切れているか、取得に失敗しています', collectItems)
  push('reminder', '忘れていませんか', '自分で入れるもの。済んでいれば「今はいい」で1週間消えます', reminderItems)

  // ---- ストリップ（今月の粗利） ----
  const thisMonthRow = monthly.find(r => r.month === month && r.kind === 'resale')
  const lastMonthRow = monthly.find(r => r.month === lastMonthStr && r.kind === 'resale')

  // sum(integer) は bigint（アダプタが number にする）
  const payoutRow = (await ctx.sql.get<{ c: number; total: number }>(`
    select count(*) as c, coalesce(sum(price - fee), 0) as total
      from sale where status in ('shipped', 'delivered')
  `))!

  // 見込みは月で切らない。未完了の sold_at は仮置きで、完了した日に動く（awaiting_payout と同じ）
  const pending = forecastTotals(allSales.filter(s => s.kind === 'resale'))

  const strip: Inbox['strip'] = {
    month,
    gross_profit: thisMonthRow?.gross_profit ?? 0,
    net_profit: thisMonthRow?.net_profit ?? 0,
    revenue: thisMonthRow?.revenue ?? 0,
    sales_count: thisMonthRow?.sales_count ?? 0,
    pending_profit_estimate: pending.gross_profit,
    pending_count: pending.count,
    awaiting_payout: payoutRow.total,
    awaiting_payout_count: payoutRow.c,
    last_month: lastMonthRow
      ? { month: lastMonthStr, net_profit: lastMonthRow.net_profit, closed: lastMonthRow.closed }
      : null,
  }

  // ---- 見直すもの ----
  // 設定が数でなければ（手で壊れた値）既定にする。ホームが開けなくなるのを避ける
  const warn = Number(settings['aging_warn_days'] ?? AGING_WARN_DAYS_DEFAULT)
  const agingWarnDays = Number.isSafeInteger(warn) ? warn : AGING_WARN_DAYS_DEFAULT
  const agingRow = (await ctx.sql.get<{ c: number }>(
    `select count(*) as c from inventory_view where status = 'in_stock' and aging_days >= ?`, agingWarnDays,
  ))!
  // 並びは listProducts('total_profit') と同じ（variant_summary の total_profit 降順・型番順）。
  // 先頭 1 件の型番・名前・粗利だけ要るので、タグや画像まで引く listProducts は使わない
  const topProduct = (await listVariantSummary(ctx, 'total_profit'))[0]

  const review: Inbox['review'] = {
    aging_count: agingRow.c,
    aging_days: agingWarnDays,
    unallocated_listings: dashboard.needsListingAllocation,
    last_month_unclosed: (lastMonthRow && !lastMonthRow.closed) ? lastMonthStr : null,
    top_model: topProduct
      ? { model_code: topProduct.model_code, name: topProduct.name, total_profit: topProduct.total_profit }
      : null,
  }

  return { strip, groups, done_today: await countDoneToday(ctx, today), review }
}

// ------------------------------------------------------------
// API として登録する（引数は信用しない。型が違えば UserError）
// ------------------------------------------------------------

registerHandler('getInbox', (ctx) => getInbox(ctx))
registerHandler('snoozeReminder', (ctx, type, id) => snoozeReminder(ctx, type, id ?? null))
