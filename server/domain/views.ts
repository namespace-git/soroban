import type { Ctx } from '../context'
import { UserError } from '../errors'
import { registerHandler } from '../rpc'
import type {
  InventoryGroup, InventoryGroupFilter, InventoryItem, InventoryOverview, InventoryStatus,
  MonthStatement, ProductKarte, PurchaseAccountCard, SalesProgress, Tag,
} from '../../src/shared/types'
import {
  argEnum, argNullableDate, mediaUrl, setting, subtractDaysJst, thisMonthJst, todayJst,
} from './_shared'
import { productImageFiles } from './derive'
import { getDashboard } from './home'
import { listInventory } from './inventory'
import { listListings } from './listing'
import { listShopAccounts } from './master'
import { getMonthDetail } from './monthly'
import { getProduct, listProducts } from './product'
import { listSales } from './sale'

// ============================================================
// v0.2 画面用の集計（売上タブの進捗、在庫タブの型番グループ、商品カルテ、月次の計算書、
// 仕入タブの仕入先カード）。
//
// src/main/views.ts の移植。
// ここでは利益を再計算しない。sale_profit / variant_summary / getMonthDetail の値を
// そのまま集めて画面向けの形に組み替えるだけ（各ドメインの関数・ビューに寄せる）。
//
// 日付：サーバー（Workers）は UTC。「今月」「90 日前」は日本時間で決める。
// ============================================================

const AGING_WARN_DAYS_DEFAULT = 60
const SOLD_RECENT_DAYS = 90

const INVENTORY_GROUP_FILTERS: readonly InventoryGroupFilter[] = [
  'unlisted', 'unlisted_arrived', 'not_arrived', 'listed', 'sold', 'other', 'split', 'all',
]

/** 滞留とみなす日数の設定。数でなければ（手で壊れた値）既定にして、画面が開けなくなるのを避ける */
async function agingWarnDays(ctx: Ctx): Promise<number> {
  const days = await setting(ctx, 'aging_warn_days', AGING_WARN_DAYS_DEFAULT)
  return Number.isSafeInteger(days) ? days : AGING_WARN_DAYS_DEFAULT
}

// ------------------------------------------------------------
// 売上タブ：進捗（メルカリ側の状態）と入力（アプリ側の状態）
// ------------------------------------------------------------

export async function getSalesProgress(ctx: Ctx): Promise<SalesProgress> {
  const allSales = await listSales(ctx)
  const month = thisMonthJst()

  const toShip = allSales.filter(s => s.status === 'waiting_shipment')
  const inTransit = allSales.filter(s => s.status === 'shipped' || s.status === 'delivered')
  const completed = allSales.filter(s => s.status === 'completed' && s.sold_at.slice(0, 7) === month)

  // 「出品中」のカードは一覧の既定（出品中のみ＝active）と数を一致させる。
  // 出品停止中まで数えると、押した先の一覧より件数が多くなり食い違う。
  // 「すべて」の件数だけは停止中も含む（一覧も active+suspended を全部出す）。
  // 一覧の既定（active+suspended）を 1 回だけ引いて、active だけに絞ったものを出品中として数える
  const listingsAll = await listListings(ctx)
  const listings = listingsAll.filter(l => l.status === 'active')
  const reserved = listings.filter(l => l.items.length > 0)

  const resaleSales = allSales.filter(s => s.kind === 'resale')
  const needs_shipping = resaleSales.filter(s => s.is_shipping_confirmed === 0).length
  const needs_link = resaleSales.filter(s => s.unmatched === 1).length
  const done = resaleSales.filter(s => s.is_shipping_confirmed === 1 && s.unmatched === 0).length

  return {
    listed: {
      count: listings.length,
      expected_profit: reserved.reduce((s, l) => s + (l.expected_profit ?? 0), 0),
      unallocated: listings.length - reserved.length,
    },
    to_ship: { count: toShip.length, revenue: toShip.reduce((s, x) => s + x.price, 0) },
    in_transit: { count: inTransit.length, revenue: inTransit.reduce((s, x) => s + x.price, 0) },
    completed_this_month: { count: completed.length, revenue: completed.reduce((s, x) => s + x.price, 0) },
    all: allSales.length + listingsAll.length,
    inputs: { needs_shipping, needs_link, done },
  }
}

// ------------------------------------------------------------
// 在庫タブ：上の状態カードと型番グループ
// ------------------------------------------------------------

export async function getInventoryOverview(ctx: Ctx): Promise<InventoryOverview> {
  const items = await listInventory(ctx, 'in_stock')
  const warnDays = await agingWarnDays(ctx)

  // 記録の上での在庫の総数（分割前の親・廃棄・自家消費・販売済みも含む）。
  // 空状態（まだ1点も無い）の判定にだけ使う
  const total = (await ctx.sql.get<{ c: number }>('select count(*) as c from inventory_item'))!.c

  const unlisted_arrived = { count: 0, cost: 0 }
  const not_arrived = { count: 0, cost: 0 }
  const aging = { count: 0, cost: 0, days: warnDays }

  for (const it of items) {
    if (!it.listing) {
      if (it.fulfillment === 'pending' || it.fulfillment === 'shipped') {
        not_arrived.count += 1
        not_arrived.cost += it.landed_cost
      } else {
        unlisted_arrived.count += 1
        unlisted_arrived.cost += it.landed_cost
      }
    }
    if (it.aging_days >= warnDays) {
      aging.count += 1
      aging.cost += it.landed_cost
    }
  }

  const reserved = (await listListings(ctx)).filter(l => l.items.length > 0)
  const listed = {
    count: reserved.reduce((s, l) => s + l.items.length, 0),
    expected_profit: reserved.reduce((s, l) => s + (l.expected_profit ?? 0), 0),
  }

  return { total, unlisted_arrived, not_arrived, listed, aging }
}

type Bucket = 'unlisted_arrived' | 'not_arrived' | 'listed' | 'sold' | 'other' | 'split'

function bucketOf(item: InventoryItem): Bucket {
  if (item.status === 'split') return 'split'
  if (item.status === 'sold') return 'sold'
  if (item.status === 'in_stock') {
    if (item.listing) return 'listed'
    if (item.fulfillment === 'pending' || item.fulfillment === 'shipped') return 'not_arrived'
    return 'unlisted_arrived'
  }
  // disposed / personal_use
  return 'other'
}

/** split（分割前の親）は 'all' にも 'other' にも含めない。メンテ用の 'split' でだけ見える */
function matchesFilter(bucket: Bucket, filter: InventoryGroupFilter): boolean {
  switch (filter) {
    case 'all': return bucket !== 'split'
    case 'unlisted': return bucket === 'unlisted_arrived' || bucket === 'not_arrived'
    case 'unlisted_arrived': return bucket === 'unlisted_arrived'
    case 'not_arrived': return bucket === 'not_arrived'
    case 'listed': return bucket === 'listed'
    case 'sold': return bucket === 'sold'
    case 'other': return bucket === 'other'
    case 'split': return bucket === 'split'
  }
}

const ALL_INVENTORY_STATUSES: InventoryStatus[] = ['in_stock', 'sold', 'disposed', 'personal_use', 'split']

/** 在庫を型番ごとにまとめる。model_code が null の点は最後に1グループ「型番なし」 */
export async function listInventoryGroups(ctx: Ctx, filter: InventoryGroupFilter): Promise<InventoryGroup[]> {
  const f = argEnum('在庫の絞り込み', filter, INVENTORY_GROUP_FILTERS)

  const allItems: InventoryItem[] = []
  for (const status of ALL_INVENTORY_STATUSES) allItems.push(...await listInventory(ctx, status))
  const productMap = new Map((await listProducts(ctx)).map(p => [p.model_code, p]))

  // グループの代表サムネ：商品画像と同じ優先順位（①人がセット ②仕入先 ③最新の出品 ④最新の販売）
  const modelCodes = [...new Set(
    allItems.map(it => it.model_code).filter((c): c is string => c !== null),
  )]
  const imageMap = await productImageFiles(ctx, modelCodes)

  const byModel = new Map<string | null, InventoryItem[]>()
  for (const item of allItems) {
    const arr = byModel.get(item.model_code) ?? []
    arr.push(item)
    byModel.set(item.model_code, arr)
  }

  const groups: InventoryGroup[] = []
  for (const [modelCode, groupItems] of byModel) {
    const items = groupItems.filter(it => matchesFilter(bucketOf(it), f))
    if (items.length === 0) continue

    const unlisted_arrived = groupItems.filter(it => bucketOf(it) === 'unlisted_arrived').length
    const not_arrived = groupItems.filter(it => bucketOf(it) === 'not_arrived').length
    const listed = groupItems.filter(it => bucketOf(it) === 'listed').length
    const sold = groupItems.filter(it => bucketOf(it) === 'sold').length

    const inStock = groupItems.filter(it => it.status === 'in_stock')
    const cost_per_item = inStock.length > 0
      ? Math.round(inStock.reduce((s, i) => s + i.landed_cost, 0) / inStock.length)
      : null
    const oldest = inStock.length > 0
      ? inStock.reduce((a, b) => (a.acquired_at <= b.acquired_at ? a : b))
      : null

    const product = modelCode ? productMap.get(modelCode) : undefined

    groups.push({
      model_code: modelCode,
      name: product?.name ?? '型番なし',
      thumb_url: modelCode ? mediaUrl(ctx, imageMap.get(modelCode)?.path ?? null) : null,
      tags: product?.tags ?? [],
      unlisted: unlisted_arrived + not_arrived,
      unlisted_arrived,
      not_arrived,
      listed,
      sold,
      avg_price: product?.avg_price ?? null,
      avg_profit: product?.avg_profit ?? null,
      cost_per_item,
      oldest_acquired_at: oldest?.acquired_at ?? null,
      oldest_aging_days: oldest?.aging_days ?? null,
      items,
    })
  }

  // 型番なし（model_code === null）は常に最後。それ以外は滞留が長い順
  groups.sort((a, b) => {
    if (a.model_code === null) return 1
    if (b.model_code === null) return -1
    return (b.oldest_aging_days ?? -1) - (a.oldest_aging_days ?? -1)
  })

  return groups
}

// ------------------------------------------------------------
// 商品カルテ
// ------------------------------------------------------------

export async function getProductKarte(ctx: Ctx, modelCode: string): Promise<ProductKarte> {
  // getProduct は型番の検査をして、無ければ null。商品の一覧と同じ 1 行（ProductSummary）に、
  // 月別・在庫・販売をつけたもの。カルテの summary には ProductSummary の分だけを入れる
  const detail = await getProduct(ctx, modelCode)
  if (!detail) throw new UserError(`型番が見つかりません: ${modelCode}`, 'not_found')
  const { months: _months, items, sales, ...summary } = detail
  const inStockItems = items.filter(i => i.status === 'in_stock')

  // 仕入明細の元の名前（表示名と違うときだけ返す）。同じ日に仕入れた在庫は、在庫コードの新しい方
  const latest = await ctx.sql.get<{ name: string }>(`
    select name from inventory_item
     where model_code = ?
     order by acquired_at desc, created_at desc, length(item_code) desc, item_code collate "C" desc
     limit 1
  `, modelCode)
  const source_name = latest && latest.name !== summary.name ? latest.name : null

  const in_stock = {
    count: inStockItems.length,
    arrived: inStockItems.filter(i => i.fulfillment === 'delivered' || i.fulfillment === null).length,
    not_arrived: inStockItems.filter(i => i.fulfillment === 'pending' || i.fulfillment === 'shipped').length,
    cost: inStockItems.reduce((s, i) => s + i.landed_cost, 0),
  }

  const listings = (await listListings(ctx)).filter(l =>
    l.items.some(it => it.model_code === modelCode) || l.model_codes.includes(modelCode))
  const listed = {
    count: listings.length,
    price_total: listings.reduce((s, l) => s + l.price, 0),
    expected_profit: listings.reduce((s, l) => s + (l.expected_profit ?? 0), 0),
  }

  const cutoff = subtractDaysJst(todayJst(), SOLD_RECENT_DAYS)
  const sold_recent = { count: sales.filter(s => s.sold_at >= cutoff).length, days: SOLD_RECENT_DAYS }

  // 1点あたりの売れた価格（まとめ売りは按分後）で価格帯を出す
  const priceRows = await ctx.sql.all<{ price: number }>(`
    select sls.price_share as price
      from inventory_item i
      join sale_line       sl  on sl.household_id  = i.household_id and sl.inventory_item_id = i.id
      join sale_line_share sls on sls.household_id = i.household_id and sls.inventory_item_id = i.id
     where i.model_code = ?
  `, modelCode)
  const price_range = priceRows.length > 0
    ? { min: Math.min(...priceRows.map(r => r.price)), max: Math.max(...priceRows.map(r => r.price)) }
    : null

  const profit_rate = summary.avg_price
    ? Math.round(((summary.avg_profit ?? 0) / summary.avg_price) * 100)
    : null

  // 先入先出の未出品在庫1点（無ければ null）
  const fifo = inStockItems.length > 0
    ? inStockItems.reduce((a, b) => (a.acquired_at <= b.acquired_at ? a : b))
    : null
  // 最後に使った発送方法（sales は新しい順）
  const lastShippingMethod = sales.find(s => s.shipping_method_id)?.shipping_method_id ?? null

  return {
    summary,
    source_name,
    in_stock,
    listed,
    sold_recent,
    price_range,
    profit_rate,
    items: inStockItems,
    sales,
    listings,
    estimate_default: {
      inventory_item_id: fifo?.id ?? null,
      shipping_method_id: lastShippingMethod,
    },
  }
}

// ------------------------------------------------------------
// 月次の計算書
// ------------------------------------------------------------

export async function getMonthStatement(ctx: Ctx, month: string): Promise<MonthStatement> {
  const detail = await getMonthDetail(ctx, month)
  const { totals } = detail

  const shipping_actual_count = detail.sales.filter(s => s.shipping_source === 'actual').length
  const cost_items = detail.sales.reduce((s, sale) => s + sale.item_count, 0)

  const gross_rate = totals.revenue === 0 ? null : Math.round((totals.gross_profit / totals.revenue) * 100)
  const net_rate = totals.revenue === 0 ? null : Math.round((totals.net_profit / totals.revenue) * 100)

  const awaiting_payout = (detail.forecast_sales ?? [])
    .filter(s => s.status === 'shipped' || s.status === 'delivered')
    .reduce((s, sale) => s + (sale.price - sale.fee), 0)

  const personal_revenue = detail.personal_sales.reduce((s, sale) => s + sale.price, 0)
  const purchase_paid = detail.purchases_by_account.reduce((s, p) => s + p.total_cost, 0)

  // タグ別集計。重複タグの販売は両方に数える（by_tag の合計は sales_count と一致しなくてよい）
  const byTag = new Map<string, { tag: Tag; count: number; gross_profit: number; allocated_expense: number; net_profit: number }>()
  let multi_tag_count = 0
  for (const sale of detail.sales) {
    const allTags = [...sale.tags, ...sale.inherited_tags]
    if (allTags.length >= 2) multi_tag_count += 1
    for (const tag of allTags) {
      const cur = byTag.get(tag.id) ?? { tag, count: 0, gross_profit: 0, allocated_expense: 0, net_profit: 0 }
      cur.count += 1
      cur.gross_profit += sale.gross_profit
      cur.allocated_expense += sale.allocated_expense
      cur.net_profit += sale.net_profit
      byTag.set(tag.id, cur)
    }
  }

  return {
    month: detail.month,
    sales_count: totals.sales_count,
    forecast: detail.forecast,
    personal_forecast: detail.personal_forecast,
    revenue: totals.revenue,
    fee: totals.total_fee,
    shipping: totals.total_shipping,
    shipping_actual_count,
    packaging: totals.total_packaging,
    cost: totals.total_cost,
    cost_items,
    gross_profit: totals.gross_profit,
    gross_rate,
    expenses: detail.expense_by_category,
    expense_total: totals.expense_total,
    net_profit: totals.net_profit,
    net_rate,
    awaiting_payout,
    personal_revenue,
    purchase_paid,
    by_tag: [...byTag.values()],
    multi_tag_count,
  }
}

// ------------------------------------------------------------
// 仕入タブ：上の仕入先カード（期間内の確定した仕入）
// ------------------------------------------------------------

/** 期間の絞り込み（両端を含む）。列名は呼び出し側の固定の文字列で、画面からの値は ? で渡す */
function rangeClause(col: string, from: string | null, to: string | null): { sql: string; vals: unknown[] } {
  const vals: unknown[] = []
  let sql = ''
  if (from) { sql += ` and ${col} >= ?::date`; vals.push(from) }
  if (to) { sql += ` and ${col} <= ?::date`; vals.push(to) }
  return { sql, vals }
}

export async function listPurchaseAccountCards(
  ctx: Ctx, from: string | null, to: string | null,
): Promise<PurchaseAccountCard[]> {
  const fromDate = argNullableDate('開始日', from) ?? null
  const toDate = argNullableDate('終了日', to) ?? null

  const accounts = await listShopAccounts(ctx)
  const dashboard = await getDashboard(ctx)

  // 仕入先ごとに 1 回の問い合わせでまとめて数える（仕入先の数だけ投げない）
  const confirmedRange = rangeClause('p.ordered_at', fromDate, toDate)
  // 単価 × 数量は integer の範囲を超えうるので bigint で掛け、sum(bigint) は numeric＝文字列なので ::bigint に戻す
  const aggRows = await ctx.sql.all<{ shop_account_id: string; orders: number; items: number; total_cost: number }>(`
    select p.shop_account_id as shop_account_id,
           count(distinct p.id) as orders,
           coalesce(sum(pl.quantity), 0)::bigint as items,
           coalesce(sum(pl.unit_price::bigint * pl.quantity + pl.allocated_cost), 0)::bigint as total_cost
      from purchase p
      left join purchase_line pl on pl.household_id = p.household_id and pl.purchase_id = p.id
     where p.status = 'confirmed' ${confirmedRange.sql}
     group by p.shop_account_id
  `, ...confirmedRange.vals)
  const aggByAccount = new Map(aggRows.map(r => [r.shop_account_id, r]))

  const orderedRange = rangeClause('p.ordered_at', fromDate, toDate)
  const draftRows = await ctx.sql.all<{ shop_account_id: string; c: number }>(`
    select p.shop_account_id as shop_account_id, count(*) as c
      from purchase p
     where p.status = 'draft' ${orderedRange.sql}
     group by p.shop_account_id
  `, ...orderedRange.vals)
  const draftsByAccount = new Map(draftRows.map(r => [r.shop_account_id, r.c]))

  const notArrivedRows = await ctx.sql.all<{ shop_account_id: string; c: number }>(`
    select p.shop_account_id as shop_account_id, count(*) as c
      from purchase p
     where p.fulfillment in ('pending', 'shipped') ${orderedRange.sql}
     group by p.shop_account_id
  `, ...orderedRange.vals)
  const notArrivedByAccount = new Map(notArrivedRows.map(r => [r.shop_account_id, r.c]))

  const cards: PurchaseAccountCard[] = accounts.map(account => {
    const agg = aggByAccount.get(account.id)

    const auth_required = dashboard.recentRuns.some(r =>
      r.status === 'auth_required' && (
        r.shop_account_id === account.id
        || (r.shop_account_id == null && (r.message?.includes(account.name) ?? false))
      ))

    return {
      shop_account_id: account.id,
      name: account.name,
      kind: account.kind,
      orders: agg?.orders ?? 0,
      items: agg?.items ?? 0,
      total_cost: agg?.total_cost ?? 0,
      drafts: draftsByAccount.get(account.id) ?? 0,
      not_arrived: notArrivedByAccount.get(account.id) ?? 0,
      auth_required,
    }
  })

  const all: PurchaseAccountCard = {
    shop_account_id: null,
    name: 'すべて',
    kind: null,
    orders: cards.reduce((s, c) => s + c.orders, 0),
    items: cards.reduce((s, c) => s + c.items, 0),
    total_cost: cards.reduce((s, c) => s + c.total_cost, 0),
    drafts: cards.reduce((s, c) => s + c.drafts, 0),
    not_arrived: cards.reduce((s, c) => s + c.not_arrived, 0),
    auth_required: cards.some(c => c.auth_required),
  }

  return [all, ...cards]
}

// ------------------------------------------------------------
// API として登録する（引数は信用しない。型が違えば UserError）
// ------------------------------------------------------------

registerHandler('getSalesProgress', (ctx) => getSalesProgress(ctx))
registerHandler('getInventoryOverview', (ctx) => getInventoryOverview(ctx))
registerHandler('listInventoryGroups', (ctx, filter) => listInventoryGroups(ctx, filter))
registerHandler('getProductKarte', (ctx, modelCode) => getProductKarte(ctx, modelCode))
registerHandler('getMonthStatement', (ctx, month) => getMonthStatement(ctx, month))
registerHandler('listPurchaseAccountCards', (ctx, from, to) => listPurchaseAccountCards(ctx, from, to))
