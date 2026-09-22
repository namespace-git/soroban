import * as db from './db'
import { thisMonthLocal, todayLocal } from '../shared/date'
import type {
  InventoryGroup, InventoryGroupFilter, InventoryItem, InventoryOverview, InventoryStatus,
  MonthStatement, ProductKarte, PurchaseAccountCard, SalesProgress, Tag,
} from '../shared/types'

// ============================================================
// v0.2 画面用の集計（売上タブの進捗、在庫タブの型番グループ、商品カルテ、月次の計算書、
// 仕入タブの仕入先カード）。
//
// ここでは利益を再計算しない。sale_profit / variant_summary / getMonthDetail の値を
// そのまま集めて画面向けの形に組み替えるだけ（db.ts の既存関数・ビューに寄せる）。
// ============================================================

/** 'YYYY-MM-DD' から days 日前（ローカル日付） */
function subtractDaysLocal(base: string, days: number): string {
  const [y, m, d] = base.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() - days)
  return todayLocal(dt)
}

// ------------------------------------------------------------
// 売上タブ：進捗（メルカリ側の状態）と入力（アプリ側の状態）
// ------------------------------------------------------------

export function getSalesProgress(): SalesProgress {
  const allSales = db.listSales()
  const month = thisMonthLocal()

  const toShip = allSales.filter(s => s.status === 'waiting_shipment')
  const inTransit = allSales.filter(s => s.status === 'shipped' || s.status === 'delivered')
  const completed = allSales.filter(s => s.status === 'completed' && s.sold_at.slice(0, 7) === month)

  const listings = db.listListings()
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
    all: allSales.length + listings.length,
    inputs: { needs_shipping, needs_link, done },
  }
}

// ------------------------------------------------------------
// 在庫タブ：上の状態カードと型番グループ
// ------------------------------------------------------------

export function getInventoryOverview(): InventoryOverview {
  const items = db.listInventory('in_stock')
  const warnDays = Number(db.getSettings()['aging_warn_days'] ?? 60)

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

  const reserved = db.listListings().filter(l => l.items.length > 0)
  const listed = {
    count: reserved.reduce((s, l) => s + l.items.length, 0),
    expected_profit: reserved.reduce((s, l) => s + (l.expected_profit ?? 0), 0),
  }

  return { unlisted_arrived, not_arrived, listed, aging }
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
export function listInventoryGroups(filter: InventoryGroupFilter): InventoryGroup[] {
  const allItems = ALL_INVENTORY_STATUSES.flatMap(status => db.listInventory(status))
  const productMap = new Map(db.listProducts().map(p => [p.model_code, p]))

  // グループの代表サムネ：商品画像と同じ優先順位（①人がセット ②最新の出品 ③最新の販売）
  const modelCodes = [...new Set(
    allItems.map(it => it.model_code).filter((c): c is string => c !== null),
  )]
  const imageMap = db.productImageFiles(modelCodes)

  const byModel = new Map<string | null, InventoryItem[]>()
  for (const item of allItems) {
    const arr = byModel.get(item.model_code) ?? []
    arr.push(item)
    byModel.set(item.model_code, arr)
  }

  const groups: InventoryGroup[] = []
  for (const [modelCode, groupItems] of byModel) {
    const items = groupItems.filter(it => matchesFilter(bucketOf(it), filter))
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
      thumb_url: modelCode ? db.toThumbUrl(imageMap.get(modelCode)?.file ?? null) : null,
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

export function getProductKarte(modelCode: string): ProductKarte {
  const summary = db.listProducts().find(p => p.model_code === modelCode)
  if (!summary) throw new Error(`型番が見つかりません: ${modelCode}`)

  const detail = db.getProduct(modelCode)
  const items = detail?.items ?? []
  const sales = detail?.sales ?? [] // sold_at 新しい順（db.getProduct）
  const inStockItems = items.filter(i => i.status === 'in_stock')

  // 仕入明細の元の名前（表示名と違うときだけ返す）
  const latest = db.getDb().prepare(`
    SELECT name FROM inventory_item
     WHERE model_code = ?
     ORDER BY acquired_at DESC, created_at DESC LIMIT 1
  `).get(modelCode) as { name: string } | undefined
  const source_name = latest && latest.name !== summary.name ? latest.name : null

  const in_stock = {
    count: inStockItems.length,
    arrived: inStockItems.filter(i => i.fulfillment === 'delivered' || i.fulfillment === null).length,
    not_arrived: inStockItems.filter(i => i.fulfillment === 'pending' || i.fulfillment === 'shipped').length,
    cost: inStockItems.reduce((s, i) => s + i.landed_cost, 0),
  }

  const listings = db.listListings().filter(l =>
    l.items.some(it => it.model_code === modelCode) || l.model_codes.includes(modelCode))
  const listed = {
    count: listings.length,
    price_total: listings.reduce((s, l) => s + l.price, 0),
    expected_profit: listings.reduce((s, l) => s + (l.expected_profit ?? 0), 0),
  }

  const recentDays = 90
  const cutoff = subtractDaysLocal(todayLocal(), recentDays)
  const sold_recent = { count: sales.filter(s => s.sold_at >= cutoff).length, days: recentDays }

  // 1点あたりの売れた価格（まとめ売りは按分後）で価格帯を出す
  const priceRows = db.getDb().prepare(`
    SELECT sls.price_share AS price
      FROM inventory_item i
      JOIN sale_line       sl  ON sl.inventory_item_id = i.id
      JOIN sale_line_share sls ON sls.inventory_item_id = i.id
     WHERE i.model_code = ?
  `).all(modelCode) as Array<{ price: number }>
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

export function getMonthStatement(month: string): MonthStatement {
  const detail = db.getMonthDetail(month)
  const { totals } = detail

  const shipping_actual_count = detail.sales.filter(s => s.shipping_source === 'actual').length
  const cost_items = detail.sales.reduce((s, sale) => s + sale.item_count, 0)

  const gross_rate = totals.revenue === 0 ? null : Math.round((totals.gross_profit / totals.revenue) * 100)
  const net_rate = totals.revenue === 0 ? null : Math.round((totals.net_profit / totals.revenue) * 100)

  const awaiting_payout = detail.sales
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
    month,
    sales_count: totals.sales_count,
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

function rangeClause(col: string, from: string | null, to: string | null): { sql: string; vals: unknown[] } {
  const vals: unknown[] = []
  let sql = ''
  if (from) { sql += ` AND ${col} >= ?`; vals.push(from) }
  if (to) { sql += ` AND ${col} <= ?`; vals.push(to) }
  return { sql, vals }
}

export function listPurchaseAccountCards(from: string | null, to: string | null): PurchaseAccountCard[] {
  const conn = db.getDb()
  const accounts = db.listShopAccounts()
  const dashboard = db.getDashboard()

  const orderedRange = rangeClause('ordered_at', from, to)

  const cards: PurchaseAccountCard[] = accounts.map(account => {
    const confirmedRange = rangeClause('p.ordered_at', from, to)
    const agg = conn.prepare(`
      SELECT COUNT(DISTINCT p.id) AS orders,
             COALESCE(SUM(pl.quantity), 0) AS items,
             COALESCE(SUM(pl.unit_price * pl.quantity + pl.allocated_cost), 0) AS total_cost
        FROM purchase p
        LEFT JOIN purchase_line pl ON pl.purchase_id = p.id
       WHERE p.shop_account_id = ? AND p.status = 'confirmed' ${confirmedRange.sql}
    `).get(account.id, ...confirmedRange.vals) as { orders: number; items: number; total_cost: number }

    const drafts = conn.prepare(`
      SELECT COUNT(*) AS c FROM purchase
       WHERE shop_account_id = ? AND status = 'draft' ${orderedRange.sql}
    `).get(account.id, ...orderedRange.vals) as { c: number }

    const notArrived = conn.prepare(`
      SELECT COUNT(*) AS c FROM purchase
       WHERE shop_account_id = ? AND fulfillment IN ('pending','shipped') ${orderedRange.sql}
    `).get(account.id, ...orderedRange.vals) as { c: number }

    const auth_required = dashboard.recentRuns.some(r =>
      r.status === 'auth_required' && (
        r.shop_account_id === account.id
        || (r.shop_account_id == null && (r.message?.includes(account.name) ?? false))
      ))

    return {
      shop_account_id: account.id,
      name: account.name,
      kind: account.kind,
      orders: agg.orders,
      items: agg.items,
      total_cost: agg.total_cost,
      drafts: drafts.c,
      not_arrived: notArrived.c,
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
