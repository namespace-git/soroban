// ============================================================
// 開発用モック（`window.soroban` が無いときだけ main.ts から差し込まれる）
//
// 目的：Electron 外の素のブラウザで画面を開けるようにする。
// 本番ビルドには入らない（main.ts が import.meta.env.DEV で動的 import する）。
//
// データはメモリ上に持ち、操作すると変わる（紐付け・分割・削除・登録が試せる）。
// 金額は integer（円）。按分・手数料・型番抽出の考え方は
// src/main/db.ts・money.ts・docs/01-requirements.md の Phase 2 節に合わせる。
// ============================================================

import type {
  SorobanApi, ShopAccount, ShopAccountKind, ShopAccountStats, ShippingMethod, ShippingSource,
  SaleProfit, SaleInput, SalePatch, SaleKind, SaleSource, SaleFilter, SaleTotals, SaleStatus,
  PurchaseDetail, PurchaseInput, PurchaseLine, PurchaseImportResult,
  InventoryItem, InventoryStatus, InventoryPatch,
  MonthlySummary, DashboardStats, CollectorRun,
  Material, VariantSummary, Tag, Fulfillment,
  ProductSummary, ProductDetail, ProductMonthPoint, ItemTimeline, TimelineEvent,
  Listing, ListingStatus,
  Expense, ExpenseInput, ExpenseLineInput, ExpenseLine, ExpenseCategory,
  ReceiptDraft, ReceiptRead, AiStatus,
  AllocMethod, MonthClose, MonthDetail, MonthSaleRow, MonthTotals,
  SearchHit,
  UpdateStatus,
  Inbox, InboxGroup, InboxItem, InboxKind, ProfitStrip, ReminderType,
  SalesProgress, InventoryOverview, InventoryGroupFilter, InventoryGroup,
  ProductKarte, MonthStatement, PurchaseAccountCard,
} from '../../shared/types'
import { todayLocal, thisMonthLocal } from '../../shared/date'
import { matchesSearch } from '../components/SearchBox.vue'

// ------------------------------------------------------------
// 小さなユーティリティ
// ------------------------------------------------------------

function uid(): string {
  return crypto.randomUUID()
}

/** 在庫コード（S-0001, S-0002, ...）。生成順に連番を振る。絶対に重複しない */
let itemCodeSeq = 0
function nextItemCode(): string {
  itemCodeSeq += 1
  return `S-${String(itemCodeSeq).padStart(4, '0')}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}

/** 今日からの経過日数（暦日ベース、JSTのローカル日付で比較） */
function diffDays(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  const then = new Date(y, m - 1, d)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((today.getTime() - then.getTime()) / 86400000)
}

function isoLocal(d: Date): string {
  return `${todayLocal(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
}

/** 仕入の到着状態から shipped_at / delivered_at を合成する（実データは main が到着状態の観測日を記録する） */
function fulfillmentDates(orderedAt: string, fulfillment: Fulfillment | null): { shipped_at: string | null; delivered_at: string | null } {
  const [y, m, d] = orderedAt.split('-').map(Number)
  const ordered = new Date(y, m - 1, d)
  const addDays = (n: number) => todayLocal(new Date(ordered.getTime() + n * 86400000))
  if (fulfillment === 'shipped') return { shipped_at: addDays(2), delivered_at: null }
  if (fulfillment === 'delivered') return { shipped_at: addDays(2), delivered_at: addDays(5) }
  return { shipped_at: null, delivered_at: null }
}

/** 買い手の伏せ字（'ゆ***' のような表示）。実データはメルカリの取引詳細から取る */
const BUYER_PREFIXES = ['ゆ', 'み', 'あ', 'た', 'さ', 'は', 'こ', 'の']
function buyerFor(seed: number): string {
  return `${BUYER_PREFIXES[seed % BUYER_PREFIXES.length]}***`
}

/**
 * 自動取得（collector）の販売のうち、十分に日数が経ったものだけ取引完了まで進んでいることにする。
 * 手入力（manual）や日が浅いものは status = null（まだ取れていない）のまま。
 */
function saleStatusFor(source: SaleSource, soldAt: string): {
  status: SaleStatus | null; shipped_at: string | null; delivered_at: string | null; completed_at: string | null; buyer: string | null
} {
  if (source !== 'collector') return { status: null, shipped_at: null, delivered_at: null, completed_at: null, buyer: null }
  const k = diffDays(soldAt) // 販売から何日経ったか
  if (k < 6) return { status: null, shipped_at: null, delivered_at: null, completed_at: null, buyer: null }
  const [y, m, d] = soldAt.split('-').map(Number)
  const sold = new Date(y, m - 1, d)
  const addDays = (n: number) => todayLocal(new Date(sold.getTime() + n * 86400000))
  return {
    status: 'completed',
    shipped_at: addDays(1),
    delivered_at: addDays(3),
    completed_at: addDays(5),
    buyer: buyerFor(k),
  }
}

/**
 * 特定の販売を狙って「発送してください」「受取評価待ち」「評価してください」の見本にするための、
 * 状態を明示指定したバージョン（saleStatusFor は経過日数から自動で決めるため、狙った状態を作れない）。
 */
function statusInfoFor(status: SaleStatus, soldAt: string, seed: number): {
  status: SaleStatus; shipped_at: string | null; delivered_at: string | null; completed_at: string | null; buyer: string | null
} {
  const [y, m, d] = soldAt.split('-').map(Number)
  const sold = new Date(y, m - 1, d)
  const addDays = (n: number) => todayLocal(new Date(sold.getTime() + n * 86400000))
  const buyer = buyerFor(seed)
  switch (status) {
    case 'waiting_payment':
      return { status, shipped_at: null, delivered_at: null, completed_at: null, buyer }
    case 'waiting_shipment':
      return { status, shipped_at: null, delivered_at: null, completed_at: null, buyer }
    case 'shipped':
      return { status, shipped_at: addDays(1), delivered_at: null, completed_at: null, buyer }
    case 'delivered':
      return { status, shipped_at: addDays(1), delivered_at: addDays(3), completed_at: null, buyer }
    case 'completed':
      return { status, shipped_at: addDays(1), delivered_at: addDays(3), completed_at: addDays(5), buyer }
  }
}

/**
 * 購入日時（取引画面の「購入日時」）のモック。取引完了なら販売日の2〜5日前 21:34、
 * 取引中（発送待ち等、状態は取れている）ならまだ確定していないので当日、
 * 状態がまだ取れていなければ（手入力・観測不足）null
 */
function purchasedAtFor(status: SaleStatus | null, soldAt: string, seed: number): string | null {
  if (!status) return null
  if (status !== 'completed') return todayLocal()
  const [y, m, d] = soldAt.split('-').map(Number)
  const sold = new Date(y, m - 1, d)
  const days = 2 + (seed % 4) // 2〜5日前
  return `${todayLocal(new Date(sold.getTime() - days * 86400000))}T21:34`
}

/** 開発中に Skeleton が一瞬見えるよう、擬似的な遅延を入れる */
function wait<T>(value: T): Promise<T> {
  const ms = 80 + Math.random() * 70
  return new Promise(resolve => setTimeout(() => resolve(value), ms))
}

/**
 * pool を bases の比率で配賦する。端数は最終要素に寄せて合計を一致させる。
 * src/main/money.ts の allocate と同じ考え方（レンダラー側で main のコードは import しない）。
 */
function allocateAmount(bases: number[], pool: number): number[] {
  const total = bases.reduce((s, b) => s + b, 0)
  if (bases.length === 0) return []
  if (total === 0) return bases.map(() => 0)

  let assigned = 0
  return bases.map((b, i) => {
    if (i === bases.length - 1) return pool - assigned
    const share = Math.round((pool * b) / total)
    assigned += share
    return share
  })
}

/** total を count 個に均等配分する。合計は必ず total と一致する（余りは末尾へ）。 */
function splitEvenly(total: number, count: number): number[] {
  if (count === 0) return []
  const base = Math.floor(total / count)
  const r = total - base * count
  return Array.from({ length: count }, (_, i) => base + (i >= count - r ? 1 : 0))
}

function normalizeName(s: string): string {
  return s.replace(/[\s　【】[\]（）()／/・,、。]/g, '').toLowerCase()
}

/** 2つの文字列の共通文字数（簡易な類似度） */
function commonCharCount(a: string, b: string): number {
  const freq = new Map<string, number>()
  for (const ch of a) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let count = 0
  for (const ch of b) {
    const c = freq.get(ch) ?? 0
    if (c > 0) { count++; freq.set(ch, c - 1) }
  }
  return count
}

function calcFeeMock(price: number, rateBp: number): number {
  return Math.round((price * rateBp) / 10000)
}

// ------------------------------------------------------------
// 横断検索：種類ごとの状態表示語
// ------------------------------------------------------------

const LISTING_STATUS_LABEL: Record<ListingStatus, string> = {
  active: '出品中', suspended: '公開停止中', sold: '売れた', ended: '取り下げ',
}

function inventorySearchStatusLabel(i: InventoryItem): string {
  if (i.status === 'sold') return '販売済'
  if (i.status === 'disposed') return '廃棄'
  if (i.status === 'personal_use') return '自家消費'
  if (i.status === 'split') return '分割済'
  if (i.listing) return i.listing.status === 'suspended' ? '公開停止中' : '出品中'
  return '未出品'
}

function saleSearchStatusLabel(s: SaleProfit): string {
  if (!s.is_shipping_confirmed) return '送料未入力'
  if (s.kind === 'resale' && s.unmatched) return '未紐付け'
  if (s.kind === 'personal') return '私物'
  return '完了'
}

// ------------------------------------------------------------
// 型番（K-01〜K-03）
// ------------------------------------------------------------

const MATERIALS: Material[] = ['ムースクリーム', 'ねっとりヨーグルト', 'もちもちもち', 'クリーミークリーム']

/** K-01: 【Z078-2】のようなコードを商品名から1つ抜く（明細用） */
function extractModelCode(name: string): { model_code: string | null; series_code: string | null } {
  const m = name.match(/【([A-Z]\d{3}(?:-\d+)?)】/)
  if (!m) return { model_code: null, series_code: null }
  return { model_code: m[1], series_code: m[1].split('-')[0] }
}

/** K-03: 素材を名前から抜く */
function extractMaterial(name: string): Material | null {
  return MATERIALS.find(mm => name.includes(mm)) ?? null
}

/** K-05: 販売タイトル・説明文から型番をすべて抜く（重複除去、まとめ売り対応） */
function extractAllCodes(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/【?([A-Z]\d{3}(?:-\d+)?)】?/g)) out.add(m[1])
  return [...out]
}

// ------------------------------------------------------------
// マスタ
// ------------------------------------------------------------

const shopAccounts: ShopAccount[] = [
  { id: uid(), name: 'メロジョイA', kind: 'mellojoy', note: null, is_active: 1, import_keywords: null, auto_tags: [], default_shipping_fee: null },
  { id: uid(), name: 'メロジョイB', kind: 'mellojoy', note: null, is_active: 1, import_keywords: null, auto_tags: [], default_shipping_fee: null },
  { id: uid(), name: 'TikTok Shop', kind: 'tiktok', note: null, is_active: 1, import_keywords: null, auto_tags: [], default_shipping_fee: 399 },
]

/** タグ。deleteTag で配列ごと差し替えるので let */
let tags: Tag[] = [
  { id: uid(), name: 'セール', sort_order: 1 },
  { id: uid(), name: 'まとめ売り', sort_order: 2 },
  { id: uid(), name: '福袋', sort_order: 3 },
]

/** 商品（型番）に直接付けたタグ。型番 → タグ[]（setProductTags で置き換える） */
const productTags = new Map<string, Tag[]>()

/** 商品（型番）の表示名。型番 → 表示名（setProductName で置き換える。無い型番は最新の在庫名を使う） */
const productCustomName = new Map<string, string>()

/**
 * 人が固定した商品画像。型番 → サムネURL（setProductImage / setProductImageAuto(code, false) で入る。
 * 取り込みで上書きしない）。キーが無ければ自動判定（①出品の最新画像 ②販売の最新画像）
 */
const productManualImage = new Map<string, string | null>()

const shippingMethods: ShippingMethod[] = [
  { id: uid(), name: 'ネコポス', carrier: 'らくらくメルカリ便', fee: 210, sort_order: 1, is_active: 1 },
  { id: uid(), name: 'ゆうパケット', carrier: 'ゆうゆうメルカリ便', fee: 230, sort_order: 2, is_active: 1 },
  { id: uid(), name: 'ゆうパケットポスト', carrier: 'ゆうゆうメルカリ便', fee: 215, sort_order: 3, is_active: 1 },
  { id: uid(), name: '宅急便コンパクト', carrier: 'らくらくメルカリ便', fee: 450, sort_order: 4, is_active: 1 },
  { id: uid(), name: 'ゆうパック60', carrier: 'ゆうゆうメルカリ便', fee: 770, sort_order: 5, is_active: 1 },
  { id: uid(), name: '宅急便60', carrier: 'らくらくメルカリ便', fee: 750, sort_order: 6, is_active: 1 },
]

/** 削除済み発送方法の料金（id→fee）。estimateSaleProfit が削除後も送料を引けるように残す */
const deletedShippingMethodFees = new Map<string, number>()

let settings: Record<string, string> = {
  fee_rate_bp: '1000',
  collect_interval_h: '1',
  aging_warn_days: '90',
  mercari_keyword: '【',
}

// --- AI 読み取り（Gemini）。キー本体は返さない。安全な保存は常に使える体で動かす ---
let aiKeyConfigured = true
let aiModelSetting = 'gemini-flash-latest'
const AI_SAFE_STORAGE = true

/** 実際の Gemini 呼び出しは数秒かかる想定に寄せて 1 秒待つ */
function waitAi<T>(value: T): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(value), 1000))
}

// ------------------------------------------------------------
// 商品バリアント（メロジョイの型番付き商品。実物の型番一覧に寄せる）
// ------------------------------------------------------------

interface Variant {
  model: string
  series: string
  material: Material | null
  base: string
  price: number
}

const VARIANTS: Variant[] = [
  { model: 'Z080-1', series: 'Z080', material: 'ねっとりヨーグルト', base: 'クリームわん', price: 1200 },
  { model: 'Z080-2', series: 'Z080', material: 'ムースクリーム', base: 'クリームわん', price: 1250 },
  { model: 'Z001-4', series: 'Z001', material: 'クリーミークリーム', base: 'シーソルト', price: 900 },
  { model: 'Z088-2', series: 'Z088', material: 'ねっとりヨーグルト', base: 'プレミアム抹茶アイス', price: 1600 },
  { model: 'A035', series: 'A035', material: null, base: 'ミニランド', price: 2400 },
  { model: 'Z056-1', series: 'Z056', material: 'ムースクリーム', base: 'クリームミルフィーユ', price: 1300 },
  { model: 'Z056-2', series: 'Z056', material: 'もちもちもち', base: 'クリームミルフィーユ', price: 1300 },
  { model: 'Z012-1', series: 'Z012', material: 'もちもちもち', base: 'いちごみるく', price: 1000 },
  { model: 'Z012-3', series: 'Z012', material: 'クリーミークリーム', base: 'いちごみるく', price: 1000 },
  { model: 'Z045-2', series: 'Z045', material: 'ねっとりヨーグルト', base: 'マスカットオレ', price: 1400 },
  { model: 'Z099-1', series: 'Z099', material: 'ムースクリーム', base: 'キャラメルバナナ', price: 1100 },
  { model: 'A012', series: 'A012', material: null, base: 'パステルボックス', price: 2000 },
]

function variantOf(model: string): Variant {
  const v = VARIANTS.find(x => x.model === model)
  if (!v) throw new Error(`unknown variant ${model}`)
  return v
}
/** メロジョイ上の実際の商品名（【型番】つき） */
function rawName(v: Variant): string {
  return `【${v.model}】${v.material ? v.material + ' ' : ''}${v.base}`
}
/** K-03: 在庫の表示名は素材を含める */
function displayName(v: Variant): string {
  return v.material ? `${v.material} ${v.base}` : v.base
}

// ------------------------------------------------------------
// 仕入・在庫
// ------------------------------------------------------------

let purchases: PurchaseDetail[] = []
let inventory: InventoryItem[] = []
/** 在庫アイテム → どの仕入から生まれたか（deletePurchase の判定用） */
const itemPurchaseId = new Map<string, string>()
/** 仕入明細 id → 生まれた在庫 id[]（PurchaseLine.items は都度組み立てて現在の状態を反映する） */
const lineItemIds = new Map<string, string[]>()
/**
 * 仕入明細 id → 仕入先の商品画像 URL（メロジョイの注文詳細から）。同じ明細の items は同じ URL を持つ。
 * モックでは見本として数明細だけに入れ、他は無し（null）にする
 */
const lineImageUrl = new Map<string, string>()
/** 在庫アイテム → 廃棄／自家消費にした日（履歴タイムライン用。実データは main が操作時刻を記録する） */
const itemDisposedAt = new Map<string, string>()
/** 在庫アイテム → 分割した日（履歴タイムライン用） */
const itemSplitAt = new Map<string, string>()

function addConfirmedPurchase(opts: {
  shopId: string
  shopName: string
  orderedAt: string
  shippingFee: number
  lines: Array<{ model: string; qty: number }>
  note?: string | null
  importKey?: string | null
  fulfillment?: Fulfillment | null
}): void {
  const purchaseId = uid()
  const orderNo = `MJ-${opts.orderedAt.replace(/-/g, '').slice(0, 6)}-${pad(purchases.length + 1)}`
  const fulfillment = opts.fulfillment ?? null
  const { shipped_at, delivered_at } = fulfillmentDates(opts.orderedAt, fulfillment)

  const bases = opts.lines.map(l => variantOf(l.model).price * l.qty)
  const shares = allocateAmount(bases, opts.shippingFee)

  const lines: PurchaseLine[] = []
  let subtotal = 0
  let totalCost = 0

  opts.lines.forEach((l, li) => {
    const v = variantOf(l.model)
    subtotal += v.price * l.qty
    totalCost += v.price * l.qty + shares[li]
    const parts = splitEvenly(shares[li], l.qty)
    const lineId = uid()
    const itemIds: string[] = []

    lines.push({
      id: lineId,
      name: rawName(v),
      unit_price: v.price,
      quantity: l.qty,
      model_code: v.model,
      series_code: v.series,
      material: v.material,
      allocated_cost: shares[li],
      landed_unit_cost: v.price + Math.floor(shares[li] / l.qty),
      items: [],
    })

    for (let n = 0; n < l.qty; n++) {
      const itemId = uid()
      inventory.push({
        id: itemId,
        item_code: nextItemCode(),
        name: displayName(v),
        landed_cost: v.price + parts[n],
        acquired_at: opts.orderedAt,
        status: 'in_stock',
        aging_days: diffDays(opts.orderedAt),
        order_no: orderNo,
        shop_account_name: opts.shopName,
        model_code: v.model,
        product_name: productCustomName.get(v.model) ?? null,
        series_code: v.series,
        material: v.material,
        parent_id: null,
        note: null,
        tags: [],
        inherited_tags: [],
        fulfillment,
        thumb_url: null,
        listing: null,
        sold_to: null,
      })
      itemPurchaseId.set(itemId, purchaseId)
      itemIds.push(itemId)
    }
    lineItemIds.set(lineId, itemIds)
  })

  const shop = shopAccounts.find(s => s.id === opts.shopId)

  purchases.push({
    id: purchaseId,
    status: 'confirmed',
    ordered_at: opts.orderedAt,
    order_no: orderNo,
    shop_account_id: opts.shopId,
    shop_account_name: opts.shopName,
    shipping_fee: opts.shippingFee,
    discount: 0,
    note: opts.note ?? null,
    import_key: opts.importKey ?? null,
    fulfillment,
    shipped_at,
    delivered_at,
    line_count: lines.length,
    first_line_name: lines[0]?.name ?? null,
    first_model_code: lines[0]?.model_code ?? null,
    subtotal,
    total_cost: totalCost,
    other_cost: 0,
    alloc_method: 'by_amount',
    lines,
    // 仕入先の自動タグ（作成時に確定。後から仕入先の設定を変えても遡って付け直さない）
    tags: [...(shop?.auto_tags ?? [])],
  })
}

/** TikTok Shop 仕入。型番なし（日用品） */
function addTiktokPurchase(opts: {
  shopId: string
  shopName: string
  orderedAt: string
  shippingFee: number
  lines: Array<{ name: string; price: number; qty: number }>
  /** 自動取得が無い仕入先向けに、到着状態を手で入れておける（reminder の見本用） */
  fulfillment?: Fulfillment | null
}): void {
  const purchaseId = uid()
  const orderNo = `TK-${opts.orderedAt.replace(/-/g, '').slice(0, 6)}-${pad(purchases.length + 1)}`
  const fulfillment = opts.fulfillment ?? null
  const { shipped_at, delivered_at } = fulfillmentDates(opts.orderedAt, fulfillment)
  const bases = opts.lines.map(l => l.price * l.qty)
  const shares = allocateAmount(bases, opts.shippingFee)

  const lines: PurchaseLine[] = []
  let subtotal = 0
  let totalCost = 0

  opts.lines.forEach((l, li) => {
    subtotal += l.price * l.qty
    totalCost += l.price * l.qty + shares[li]
    const parts = splitEvenly(shares[li], l.qty)
    const lineId = uid()
    const itemIds: string[] = []

    lines.push({
      id: lineId,
      name: l.name,
      unit_price: l.price,
      quantity: l.qty,
      model_code: null,
      series_code: null,
      material: null,
      allocated_cost: shares[li],
      landed_unit_cost: l.price + Math.floor(shares[li] / l.qty),
      items: [],
    })

    for (let n = 0; n < l.qty; n++) {
      const itemId = uid()
      inventory.push({
        id: itemId,
        item_code: nextItemCode(),
        name: l.name,
        landed_cost: l.price + parts[n],
        acquired_at: opts.orderedAt,
        status: 'in_stock',
        aging_days: diffDays(opts.orderedAt),
        order_no: orderNo,
        shop_account_name: opts.shopName,
        model_code: null,
        product_name: null,
        series_code: null,
        material: null,
        parent_id: null,
        note: null,
        tags: [],
        inherited_tags: [],
        fulfillment,
        thumb_url: null,
        listing: null,
        sold_to: null,
      })
      itemPurchaseId.set(itemId, purchaseId)
      itemIds.push(itemId)
    }
    lineItemIds.set(lineId, itemIds)
  })

  const shop = shopAccounts.find(s => s.id === opts.shopId)

  purchases.push({
    id: purchaseId,
    status: 'confirmed',
    ordered_at: opts.orderedAt,
    order_no: orderNo,
    shop_account_id: opts.shopId,
    shop_account_name: opts.shopName,
    shipping_fee: opts.shippingFee,
    discount: 0,
    note: null,
    import_key: null,
    fulfillment,
    shipped_at,
    delivered_at,
    line_count: lines.length,
    first_line_name: lines[0]?.name ?? null,
    first_model_code: lines[0]?.model_code ?? null,
    subtotal,
    total_cost: totalCost,
    other_cost: 0,
    alloc_method: 'by_amount',
    lines,
    tags: [...(shop?.auto_tags ?? [])],
  })
}

/** mellojoy-watch から積んだ下書き。価格未入力・在庫なし（P-06） */
function addDraftPurchase(opts: {
  shopId: string
  shopName: string
  orderedAt: string
  lines: Array<{ model: string; qty: number }>
  importKey?: string | null
}): void {
  const lines: PurchaseLine[] = opts.lines.map(l => {
    const v = variantOf(l.model)
    return {
      id: uid(),
      name: rawName(v),
      unit_price: 0,
      quantity: l.qty,
      model_code: v.model,
      series_code: v.series,
      material: v.material,
      allocated_cost: 0,
      landed_unit_cost: 0,
      items: [], // 下書きはまだ在庫が無い
    }
  })
  const shop = shopAccounts.find(s => s.id === opts.shopId)
  purchases.push({
    id: uid(),
    status: 'draft',
    ordered_at: opts.orderedAt,
    order_no: null,
    shop_account_id: opts.shopId,
    shop_account_name: opts.shopName,
    shipping_fee: 0,
    discount: 0,
    note: '注文履歴から取り込み（価格未入力）',
    import_key: opts.importKey ?? null,
    fulfillment: null,
    shipped_at: null,
    delivered_at: null,
    line_count: lines.length,
    first_line_name: lines[0]?.name ?? null,
    first_model_code: lines[0]?.model_code ?? null,
    subtotal: 0,
    total_cost: 0,
    other_cost: 0,
    alloc_method: 'by_amount',
    lines,
    tags: [...(shop?.auto_tags ?? [])],
  })
}

function buildInitialPurchasesAndInventory(): void {
  const [mA, mB, tk] = shopAccounts

  // 型番の表示名（setProductName で付けたものの見本。1〜2件だけ入れ、残りは無し（name をそのまま使う見た目を確認するため）
  productCustomName.set('Z080-1', 'ジェラート ピケ ルームウェア')
  productCustomName.set('A035', 'ミニランド定番セット')

  addConfirmedPurchase({
    shopId: mA.id, shopName: mA.name, orderedAt: todayLocal(daysAgo(170)), shippingFee: 900,
    lines: [{ model: 'Z080-1', qty: 4 }, { model: 'Z001-4', qty: 3 }, { model: 'A035', qty: 2 }],
    importKey: 'mellojoy:#255890',
    fulfillment: 'pending',
  })
  addConfirmedPurchase({
    shopId: mB.id, shopName: mB.name, orderedAt: todayLocal(daysAgo(150)), shippingFee: 850,
    lines: [{ model: 'Z080-1', qty: 3 }, { model: 'Z056-1', qty: 3 }, { model: 'Z056-2', qty: 3 }],
    importKey: 'mellojoy:#256112',
    fulfillment: 'shipped',
  })
  addConfirmedPurchase({
    shopId: mA.id, shopName: mA.name, orderedAt: todayLocal(daysAgo(125)), shippingFee: 950,
    lines: [{ model: 'Z088-2', qty: 4 }, { model: 'Z012-1', qty: 3 }, { model: 'Z012-3', qty: 3 }],
    note: '福袋つき',
  })
  addConfirmedPurchase({
    shopId: mB.id, shopName: mB.name, orderedAt: todayLocal(daysAgo(100)), shippingFee: 800,
    lines: [{ model: 'Z080-1', qty: 2 }, { model: 'Z045-2', qty: 4 }, { model: 'Z099-1', qty: 3 }],
  })
  addConfirmedPurchase({
    shopId: mA.id, shopName: mA.name, orderedAt: todayLocal(daysAgo(75)), shippingFee: 750,
    lines: [{ model: 'Z056-1', qty: 3 }, { model: 'A012', qty: 3 }, { model: 'Z080-2', qty: 3 }],
  })
  addConfirmedPurchase({
    shopId: mB.id, shopName: mB.name, orderedAt: todayLocal(daysAgo(45)), shippingFee: 700,
    lines: [{ model: 'Z001-4', qty: 3 }, { model: 'Z012-1', qty: 3 }, { model: 'Z099-1', qty: 3 }],
    note: '送料着払い分を含む',
  })
  addConfirmedPurchase({
    shopId: mA.id, shopName: mA.name, orderedAt: todayLocal(daysAgo(20)), shippingFee: 800,
    lines: [{ model: 'Z088-2', qty: 3 }, { model: 'Z045-2', qty: 3 }, { model: 'Z056-2', qty: 3 }],
  })
  addTiktokPurchase({
    shopId: tk.id, shopName: tk.name, orderedAt: todayLocal(daysAgo(60)), shippingFee: 500,
    lines: [
      { name: 'モバイルバッテリー 10000mAh', price: 1500, qty: 3 },
      { name: 'ハンドクリーム 3本セット', price: 800, qty: 3 },
      { name: '折りたたみ傘 軽量', price: 1200, qty: 2 },
    ],
    // TikTok は自動取得が無いため到着状態は手入力。発送から日が経った見本（reminder の delivery）
    fulfillment: 'shipped',
  })
  addDraftPurchase({
    shopId: mA.id, shopName: mA.name, orderedAt: todayLocal(daysAgo(5)),
    lines: [{ model: 'Z045-2', qty: 2 }, { model: 'Z099-1', qty: 1 }],
    importKey: 'mellojoy:#268526',
  })
  addDraftPurchase({
    shopId: mB.id, shopName: mB.name, orderedAt: todayLocal(daysAgo(2)),
    lines: [{ model: 'A012', qty: 2 }, { model: 'Z012-3', qty: 1 }],
    importKey: 'mellojoy:#271041',
  })

  // 仕入先の商品画像（メロジョイの注文詳細から）の見本：確定済みのメロジョイ仕入の最初の2〜3明細だけに入れる。
  // 同じ明細の items（在庫）は同じ URL を持つ（buildPurchaseLineItems 参照）
  purchases
    .filter(p => p.status === 'confirmed' && p.import_key?.startsWith('mellojoy:'))
    .flatMap(p => p.lines)
    .slice(0, 3)
    .forEach((l, i) => lineImageUrl.set(l.id, `soroban-thumb://m${8000 + i}.jpg`))
}

/** 型番一致の在庫を古い順（先入先出）に1点取る。M-06/M-09 と同じルール */
function takeOldestByModel(model: string): InventoryItem | undefined {
  return inventory.find(i => i.model_code === model && i.status === 'in_stock')
}

// ------------------------------------------------------------
// 販売
// ------------------------------------------------------------

let sales: SaleProfit[] = []
/** sale.id -> 紐付けた inventory_item.id[] */
const saleLines = new Map<string, string[]>()

/** 取り込んだ販売（source==='collector'）を削除したときの「もう取り込まない」記録。設定→データで見て解除できる */
let saleExclusions: Array<{ mercari_item_id: string; title: string; excluded_at: string }> = []

/** ホームの「忘れていませんか」を snoozeReminder で 7 日隠すための記録。キー→隠す期限（YYYY-MM-DD） */
const reminderSnoozes = new Map<string, string>()
function reminderKey(type: ReminderType, id?: string | null): string {
  return `${type}:${id ?? ''}`
}
function isReminderSnoozed(type: ReminderType, id?: string | null): boolean {
  const until = reminderSnoozes.get(reminderKey(type, id))
  return !!until && until > todayLocal()
}

function priceFor(i: number): number {
  return 800 + (((i * 733) % 60) * 100) // 800〜6800円、100円刻み
}

function packagingFor(i: number): number {
  const m = i % 3
  return m === 0 ? 0 : m === 1 ? 100 : 150
}

/** 今月1日〜先月1日までの経過日数。soldAtFor をこの範囲に収め「今月・先月」からはみ出さないようにする */
function daysSinceLastMonthStart(): number {
  const now = new Date()
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return Math.max(1, Math.floor((now.getTime() - lastMonthStart.getTime()) / 86400000))
}

function soldAtFor(i: number): string {
  const spread = daysSinceLastMonthStart()
  const k = 1 + ((i * 7) % spread) // 今月・先月の範囲に散らす
  return todayLocal(daysAgo(k))
}

function mercariId(): string {
  let s = ''
  for (let i = 0; i < 11; i++) s += Math.floor(Math.random() * 10)
  return 'm' + s
}

/**
 * 自動取得（collector）の販売のうち半分だけダミーのサムネURLを持たせる。
 * モックからは実ファイルを読めないので、画面側は @error でプレースホルダに落ちることの確認になる。
 * 手入力（manual）は常に null。
 */
function thumbUrlFor(i: number, source: SaleSource): string | null {
  if (source !== 'collector') return null
  return i % 4 === 0 ? `soroban-thumb://m${8000 + i}.jpg` : null
}

function buildSaleFixed(opts: {
  i: number
  title: string
  kind: SaleKind
  items: InventoryItem[]
  shipping: { id: string | null; fee: number; confirmed: boolean; source: ShippingSource | null }
  packaging?: number
  note?: string | null
  autoLinked?: boolean
  priceOverride?: number
  /** 取引の進み具合を明示指定する見本（省略時は saleStatusFor が経過日数から決める） */
  statusOverride?: SaleStatus
}): SaleProfit {
  const rateBp = Number(settings.fee_rate_bp)
  const price = opts.priceOverride ?? priceFor(opts.i)
  const fee = calcFeeMock(price, rateBp)
  const packaging = opts.packaging ?? 0
  const cost = opts.items.reduce((s, it) => s + it.landed_cost, 0)
  const itemCount = opts.items.length
  // 取り込み風・手入力風を半々にする（実際の収集は行わない）
  const source: SaleSource = opts.i % 2 === 0 ? 'collector' : 'manual'
  const soldAt = soldAtFor(opts.i)
  const statusInfo = opts.statusOverride ? statusInfoFor(opts.statusOverride, soldAt, opts.i) : saleStatusFor(source, soldAt)

  const sale: SaleProfit = {
    id: uid(),
    mercari_item_id: mercariId(),
    thumb_url: thumbUrlFor(opts.i, source),
    sold_at: soldAt,
    purchased_at: purchasedAtFor(statusInfo.status, soldAt, opts.i),
    title: opts.title,
    kind: opts.kind,
    price,
    fee,
    shipping_fee: opts.shipping.fee,
    packaging_cost: packaging,
    is_shipping_confirmed: opts.shipping.confirmed ? 1 : 0,
    shipping_method_id: opts.shipping.id,
    shipping_source: opts.shipping.source,
    note: opts.note ?? null,
    model_codes: extractAllCodes(opts.title),
    cost,
    gross_profit: price - fee - opts.shipping.fee - packaging - cost,
    item_count: itemCount,
    unmatched: itemCount === 0 ? 1 : 0,
    auto_linked: opts.autoLinked ? 1 : 0,
    source,
    tags: [],
    inherited_tags: [],
    ...statusInfo,
  }

  if (itemCount > 0) {
    saleLines.set(sale.id, opts.items.map(it => it.id))
    for (const it of opts.items) {
      it.status = 'sold'
      it.thumb_url = sale.thumb_url
      it.sold_to = { sale_id: sale.id, title: sale.title, price: sale.price, sold_at: sale.sold_at }
    }
  }
  return sale
}

function buildInitialSales(): void {
  let idx = 0
  const out: SaleProfit[] = []
  const sm = (i: number) => shippingMethods[i % shippingMethods.length]

  // --- 送料未入力 かつ 未紐付け（2件） ---
  for (const model of ['Z080-1', 'Z001-4']) {
    const i = idx++
    out.push(buildSaleFixed({
      i, title: `【${model}】${displayName(variantOf(model))}`, kind: 'resale', items: [],
      shipping: { id: null, fee: 0, confirmed: false, source: null },
    }))
  }

  // --- 送料未入力だが紐付け済み（1件） ---
  {
    const i = idx++
    const model = 'Z056-1'
    const item = takeOldestByModel(model)
    out.push(buildSaleFixed({
      i, title: `【${model}】${displayName(variantOf(model))}`, kind: 'resale',
      items: item ? [item] : [],
      shipping: { id: null, fee: 0, confirmed: false, source: null },
    }))
  }

  // --- 送料は確定しているが未紐付け（2件） ---
  for (const model of ['Z012-3', 'Z099-1']) {
    const i = idx++
    const method = sm(i)
    out.push(buildSaleFixed({
      i, title: `【${model}】${displayName(variantOf(model))}`, kind: 'resale', items: [],
      shipping: { id: method.id, fee: method.fee, confirmed: true, source: 'master' },
      packaging: packagingFor(i),
    }))
  }

  // --- 実額¥0（メルカリ便以外。取引詳細の送料表示が0円だった）。未確定のまま発送方法を選び直す見本 ---
  {
    const i = idx++
    const model = 'Z088-2'
    out.push(buildSaleFixed({
      i, title: `【${model}】${displayName(variantOf(model))}`, kind: 'resale', items: [],
      shipping: { id: null, fee: 0, confirmed: false, source: 'actual' },
    }))
  }

  // --- 私物（型番なし。S-09：型番の形式を含まない取引は私物として扱う） ---
  const personalTitles = ['ダイソン ドライヤー 中古美品', 'ワンピース Mサイズ 未使用', 'ハンドバッグ レザー 中古']
  for (const title of personalTitles) {
    const i = idx++
    const method = sm(i)
    out.push(buildSaleFixed({
      i, title, kind: 'personal', items: [],
      shipping: { id: method.id, fee: method.fee, confirmed: true, source: 'actual' },
      packaging: packagingFor(i),
    }))
  }

  // --- 単一型番・紐付け確定（自動/手動を半々。M-06 の先入先出で在庫を充てる） ---
  const singleModels = [
    'Z080-1', 'Z080-1', 'Z001-4', 'Z088-2', 'Z056-1', 'Z056-2', 'Z012-1', 'Z012-3',
    'Z045-2', 'Z099-1', 'A035', 'A012', 'Z080-2', 'Z088-2',
  ]
  const negativeAt = new Set([2, 9])
  // ホームの「発送してください」・履歴の状態チップの見本（K-XX：waiting_shipment 2件・shipped 1件・delivered 1件）
  const statusOverrideAt: Record<number, SaleStatus> = { 0: 'waiting_shipment', 1: 'waiting_shipment', 3: 'shipped', 4: 'delivered' }
  singleModels.forEach((model, k) => {
    const i = idx++
    const item = takeOldestByModel(model)
    const items = item ? [item] : []
    const method = sm(i)
    const cost = items.reduce((s, it) => s + it.landed_cost, 0)
    const packaging = packagingFor(i)

    let price: number
    if (negativeAt.has(k)) {
      // 原価・送料・梱包の合計より確実に安い価格にして赤字にする
      price = Math.max(500, Math.round((cost + method.fee + packaging) * 0.7))
    } else {
      const markup = 1.6 + (i % 5) * 0.15
      price = Math.max(800, Math.round((cost * markup) / 100) * 100)
    }

    out.push(buildSaleFixed({
      i, title: `【${model}】${displayName(variantOf(model))}`, kind: 'resale', items,
      shipping: { id: method.id, fee: method.fee, confirmed: true, source: k % 3 === 0 ? 'master' : 'actual' },
      packaging, autoLinked: k % 2 === 0, priceOverride: price,
      statusOverride: statusOverrideAt[k],
    }))
  })

  // --- まとめ売り（2件。M-08：複数型番） ---
  const bundles: Array<[string, string]> = [['Z001-4', 'Z012-1'], ['Z045-2', 'Z099-1']]
  bundles.forEach(([m1, m2], k) => {
    const i = idx++
    const items = [takeOldestByModel(m1), takeOldestByModel(m2)]
      .filter((x): x is InventoryItem => !!x)
    const method = sm(i)
    const cost = items.reduce((s, it) => s + it.landed_cost, 0)
    const markup = 1.5 + (i % 4) * 0.1
    const price = Math.max(1200, Math.round((cost * markup) / 100) * 100)

    out.push(buildSaleFixed({
      i,
      title: `【${m1}】【${m2}】まとめ売り ${displayName(variantOf(m1))} & ${displayName(variantOf(m2))}`,
      kind: 'resale', items,
      shipping: { id: method.id, fee: method.fee, confirmed: true, source: 'actual' },
      packaging: packagingFor(i), note: k === 0 ? 'まとめて発送' : null, priceOverride: price,
    }))
  })

  sales = out
}

// ------------------------------------------------------------
// 出品（メルカリの出品中タブ）
// ------------------------------------------------------------

interface ListingRecord {
  mercari_item_id: string
  title: string
  price: number
  status: ListingStatus
  first_seen_at: string
  last_seen_at: string
  /** 出品日。「n日前に更新」からの推定なので first_seen_at より前になる */
  listed_at: string
  likes: number | null
  /** 出品時に決めた発送方法。売れたとき販売に引き継ぐ */
  shipping_method_id: string | null
  thumb_url: string | null
  model_codes: string[]
}

let listingRecords: ListingRecord[] = []
/** listing.mercari_item_id -> 引き当てた在庫 id[] */
const listingItems = new Map<string, string[]>()

function buildListing(rec: ListingRecord): Listing {
  const ids = listingItems.get(rec.mercari_item_id) ?? []
  const items = ids
    .map(id => inventory.find(i => i.id === id))
    .filter((i): i is InventoryItem => !!i)
  const reservedCost = items.reduce((s, it) => s + it.landed_cost, 0)
  const rateBp = Number(settings.fee_rate_bp)
  const shippingMethod = rec.shipping_method_id
    ? shippingMethods.find(m => m.id === rec.shipping_method_id) ?? null
    : null
  const shippingFee = shippingMethod?.fee ?? 0
  const expectedProfit = items.length
    ? rec.price - calcFeeMock(rec.price, rateBp) - shippingFee - reservedCost
    : null
  return {
    mercari_item_id: rec.mercari_item_id,
    title: rec.title,
    price: rec.price,
    status: rec.status,
    first_seen_at: rec.first_seen_at,
    last_seen_at: rec.last_seen_at,
    listed_at: rec.listed_at,
    likes: rec.likes,
    shipping_method_id: rec.shipping_method_id,
    shipping_method_name: shippingMethod?.name ?? null,
    thumb_url: rec.thumb_url,
    model_codes: rec.model_codes,
    items: items.map(i => ({ id: i.id, item_code: i.item_code, name: i.name, model_code: i.model_code, product_name: i.product_name, landed_cost: i.landed_cost })),
    reserved_cost: reservedCost,
    expected_profit: expectedProfit,
  }
}

/** 型番から出品を1件合成する。reserve なら在庫の在庫から古い順に1点を引き当てる */
function addListing(opts: {
  model: string
  status: ListingStatus
  daysAgoFirstSeen: number
  reserve: boolean
  likes?: number | null
  shippingMethodId?: string | null
}): void {
  const v = variantOf(opts.model)
  const title = `【${opts.model}】${displayName(v)}`
  const price = Math.round((v.price * 1.8) / 100) * 100
  const id = mercariId()
  listingRecords.push({
    mercari_item_id: id,
    title,
    price,
    status: opts.status,
    first_seen_at: todayLocal(daysAgo(opts.daysAgoFirstSeen)),
    // active／suspended は直近の取り込みで見えた体（1 件だけ「前回見えず」の見本にする）。sold／ended は最終日に固定
    // 実データ（main）は last_seen_at を ISO で保存するため、モックも合わせる
    last_seen_at: (opts.status === 'active' || opts.status === 'suspended') && opts.daysAgoFirstSeen !== 3
      ? new Date().toISOString() : daysAgo(Math.max(0, opts.daysAgoFirstSeen - 1)).toISOString(),
    // 「n日前に更新」からの推定：初めて見た日よりさらに数日前
    listed_at: todayLocal(daysAgo(opts.daysAgoFirstSeen + 3)),
    likes: opts.likes ?? null,
    shipping_method_id: opts.shippingMethodId ?? null,
    thumb_url: null,
    model_codes: extractAllCodes(title),
  })
  if (opts.reserve) {
    const item = takeOldestByModel(opts.model)
    if (item) {
      listingItems.set(id, [item.id])
      item.listing = { mercari_item_id: id, price, status: opts.status }
    }
  }
}

/** 出品中6件（うち未引き当て3件）・公開停止中2件・売れた2件・取り下げ1件 */
function buildInitialListings(): void {
  addListing({ model: 'Z080-2', status: 'active', daysAgoFirstSeen: 10, reserve: true, likes: 5 })
  addListing({ model: 'Z012-1', status: 'active', daysAgoFirstSeen: 6, reserve: false, likes: 1 })
  addListing({ model: 'A035', status: 'active', daysAgoFirstSeen: 4, reserve: false, shippingMethodId: shippingMethods[0].id })
  addListing({ model: 'Z099-1', status: 'active', daysAgoFirstSeen: 8, reserve: true, likes: 0 })
  addListing({ model: 'Z045-2', status: 'active', daysAgoFirstSeen: 3, reserve: false, shippingMethodId: shippingMethods[2].id })
  addListing({ model: 'A012', status: 'active', daysAgoFirstSeen: 12, reserve: true, likes: 3 })
  addListing({ model: 'Z056-1', status: 'suspended', daysAgoFirstSeen: 20, reserve: true })
  addListing({ model: 'Z056-2', status: 'suspended', daysAgoFirstSeen: 18, reserve: true })
  addListing({ model: 'Z001-4', status: 'sold', daysAgoFirstSeen: 25, reserve: true })
  addListing({ model: 'Z088-2', status: 'sold', daysAgoFirstSeen: 22, reserve: true })
  addListing({ model: 'Z012-3', status: 'ended', daysAgoFirstSeen: 30, reserve: false })
}

// ------------------------------------------------------------
// 月次集計
// ------------------------------------------------------------

/** expense_total / net_profit は expenses（期間費用）から後付けで合成するため、ここでは持たない */
type MonthlyBase = Omit<MonthlySummary, 'expense_total' | 'net_profit' | 'closed'>

function monthlyFromSales(rows: SaleProfit[]): MonthlyBase[] {
  const map = new Map<string, MonthlyBase>()
  for (const s of rows) {
    const month = s.sold_at.slice(0, 7)
    const key = `${month}:${s.kind}`
    const cur = map.get(key) ?? {
      month, kind: s.kind, sales_count: 0, revenue: 0, total_fee: 0,
      total_shipping: 0, total_packaging: 0, total_cost: 0, gross_profit: 0,
      unconfirmed_shipping: 0,
    }
    cur.sales_count += 1
    cur.revenue += s.price
    cur.total_fee += s.fee
    cur.total_shipping += s.shipping_fee
    cur.total_packaging += s.packaging_cost
    cur.total_cost += s.cost
    cur.gross_profit += s.gross_profit
    if (!s.is_shipping_confirmed) cur.unconfirmed_shipping += 1
    map.set(key, cur)
  }
  return [...map.values()]
}

function monthAgoStr(n: number): string {
  const d = new Date()
  d.setDate(1) // 月末繰り上がりを避ける
  d.setMonth(d.getMonth() - n)
  return thisMonthLocal(d)
}

/** 直近4か月ぶん見せるため、実データが無い2か月ぶんは要約だけ合成する */
function extraOlderMonths(): MonthlyBase[] {
  const m2 = monthAgoStr(2)
  const m3 = monthAgoStr(3)
  return [
    { month: m2, kind: 'resale', sales_count: 9, revenue: 38000, total_fee: 3800, total_shipping: 1800, total_packaging: 600, total_cost: 19000, gross_profit: 12800, unconfirmed_shipping: 2 },
    { month: m2, kind: 'personal', sales_count: 2, revenue: 6200, total_fee: 620, total_shipping: 400, total_packaging: 0, total_cost: 0, gross_profit: 5180, unconfirmed_shipping: 0 },
    { month: m3, kind: 'resale', sales_count: 11, revenue: 45000, total_fee: 4500, total_shipping: 2200, total_packaging: 700, total_cost: 23000, gross_profit: 14600, unconfirmed_shipping: 0 },
    { month: m3, kind: 'personal', sales_count: 1, revenue: 3200, total_fee: 320, total_shipping: 210, total_packaging: 0, total_cost: 0, gross_profit: 2670, unconfirmed_shipping: 0 },
  ]
}

// ------------------------------------------------------------
// 期間費用（振込手数料・梱包材の買い足しなど、販売1件に紐付かない費用）
// ------------------------------------------------------------

let expenses: Expense[] = []

/**
 * レシート OCR の固定の下書き（readReceiptImage／readReceipt 共通）。
 * 実データは main が Tesseract で読む。モックはこの1件だけを返す
 */
const MOCK_RECEIPT_DRAFT: ReceiptDraft = {
  shop: 'ダイソー',
  registration_no: 'T2290801007056',
  shop_learned: false,
  occurred_at: '2026-09-15',
  total: 920,
  lines: [
    { name: 'ビニール袋 100枚', unit_price: 110, quantity: 1, category: 'packaging', box: [250, 80, 280, 500] },
    { name: 'OPP袋 A4', unit_price: 110, quantity: 2, category: 'packaging', box: [300, 80, 330, 500] },
    { name: '緩衝材 プチプチ', unit_price: 330, quantity: 1, category: 'packaging', box: [350, 80, 380, 500] },
    { name: 'レジ袋小 3', unit_price: 220, quantity: 1, category: 'packaging', box: [400, 80, 430, 500] },
  ],
  boxes: { shop: [20, 80, 60, 600], date: [120, 80, 150, 500], total: [700, 80, 740, 900] },
  tax: 40,
  warnings: ['「レジ袋小 3」は袋代として梱包費にしました'],
  raw_text: [
    'ダイソー ○○店',
    '2026/09/15 (火) 12:34',
    '',
    'ビニール袋100枚          ¥110',
    'OPP袋A4       2         ¥220',
    '緩衝材プチプチ           ¥330',
    'レジ袋小3              ¥220',
    '',
    '小計                     ¥880',
    '消費税                    ¥40',
    '合計                     ¥920',
  ].join('\n'),
  confidence: 76,
}

/** 実際の OCR は数秒かかる。モックも同じ体感になるよう 1.2 秒待つ */
function waitReceipt<T>(value: T): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(value), 1200))
}

/**
 * 月の按分方法・締めの記録。月次タブ／経費の計上月ごとに1つ。持っていない月は
 * 既定（金額按分・未締め）として扱う（monthBookEntry で都度作る）
 */
const monthBook = new Map<string, { alloc_method: AllocMethod; close: MonthClose | null }>()
function monthBookEntry(month: string): { alloc_method: AllocMethod; close: MonthClose | null } {
  let entry = monthBook.get(month)
  if (!entry) {
    entry = { alloc_method: 'by_amount', close: null }
    monthBook.set(month, entry)
  }
  return entry
}

function buildExpenseLines(inputs: ExpenseLineInput[] | undefined): ExpenseLine[] {
  if (!inputs || inputs.length === 0) return []
  return inputs.map(l => {
    const unit_price = Math.round(l.unit_price)
    const quantity = l.quantity ?? 1
    return {
      id: uid(),
      name: l.name,
      unit_price,
      quantity,
      amount: unit_price * quantity,
      category: l.category ?? 'packaging',
    }
  })
}

/** 今月・先月に梱包費／消耗品／送料のサンプル、過去月に旧・振込手数料の自動計上を1件残す */
function buildInitialExpenses(): void {
  const thisMonth = thisMonthLocal()
  const lastMonth = monthAgoStr(1)
  const nextMonth = monthAgoStr(-1)
  const oldMonth = monthAgoStr(3) // extraOlderMonths の m3 と同じ月にして月次にも出るようにする

  // 梱包費：レシート1枚に明細2行（ビニール袋＋緩衝材）
  expenses.push({
    id: uid(),
    occurred_at: todayLocal(daysAgo(6)),
    month: thisMonth,
    shop: 'ダイソー',
    category: 'packaging',
    amount: 2000,
    note: null,
    auto: 0,
    receipt_url: '/mock/receipt.svg',
    lines: [
      { id: uid(), name: 'ビニール袋 100枚', unit_price: 1200, amount: 1200, quantity: 1, category: 'packaging' },
      { id: uid(), name: '緩衝材', unit_price: 800, amount: 800, quantity: 1, category: 'packaging' },
    ],
  })
  // 消耗品
  expenses.push({
    id: uid(),
    occurred_at: todayLocal(daysAgo(4)),
    month: thisMonth,
    shop: '無印良品',
    category: 'supplies',
    amount: 650,
    note: null,
    auto: 0,
    receipt_url: null,
    lines: [],
  })
  // 送料
  expenses.push({
    id: uid(),
    occurred_at: todayLocal(daysAgo(3)),
    month: thisMonth,
    shop: '郵便局',
    category: 'shipping',
    amount: 1400,
    note: '梱包資材の発送',
    auto: 0,
    receipt_url: null,
    lines: [],
  })
  // 計上月を翌月に回した1件（購入は今月、計上は来月）
  expenses.push({
    id: uid(),
    occurred_at: todayLocal(daysAgo(1)),
    month: nextMonth,
    shop: 'Amazon',
    category: 'supplies',
    amount: 980,
    note: '来月分の梱包資材をまとめ買い',
    auto: 0,
    receipt_url: null,
    lines: [],
  })

  // 先月ぶん
  expenses.push({
    id: uid(),
    occurred_at: `${lastMonth}-08`,
    month: lastMonth,
    shop: 'ダイソー',
    category: 'packaging',
    amount: 1500,
    note: null,
    auto: 0,
    receipt_url: null,
    lines: [{ id: uid(), name: '段ボール 10枚', unit_price: 150, amount: 1500, quantity: 10, category: 'packaging' }],
  })
  expenses.push({
    id: uid(),
    occurred_at: `${lastMonth}-15`,
    month: lastMonth,
    shop: 'ヤマト運輸',
    category: 'shipping',
    amount: 1200,
    note: null,
    auto: 0,
    receipt_url: null,
    lines: [],
  })
  expenses.push({
    id: uid(),
    occurred_at: `${lastMonth}-22`,
    month: lastMonth,
    shop: null,
    category: 'supplies',
    amount: 500,
    note: 'ラベルシール',
    auto: 0,
    receipt_url: null,
    lines: [],
  })

  // 旧・振込手数料の自動計上（過去月の1件だけ残す。新規にはもう作らない）
  expenses.push({
    id: uid(),
    occurred_at: `${oldMonth}-28`,
    month: oldMonth,
    shop: null,
    category: 'transfer_fee',
    amount: 200,
    note: null,
    auto: 1,
    receipt_url: null,
    lines: [],
  })
}

/** MonthlyBase[] に期間費用（転売の行のみ）を足して MonthlySummary[] にする */
function withExpenses(rows: MonthlyBase[]): MonthlySummary[] {
  return rows.map(m => {
    const expenseTotal = m.kind === 'resale'
      ? expenses
        .filter(e => e.month === m.month)
        .reduce((s, e) => s + e.amount, 0)
      : 0
    const closed = m.kind === 'resale' && monthBook.get(m.month)?.close != null
    return { ...m, expense_total: expenseTotal, net_profit: m.gross_profit - expenseTotal, closed }
  })
}

/**
 * pool を weights の比率で配賦する。floor で配って余りは最後の要素へ（合計は必ず pool と一致）。
 * weights の合計が 0 なら全部 0（誰にも配らない）
 */
function allocateExpenseFloor(weights: number[], pool: number): number[] {
  const total = weights.reduce((s, w) => s + w, 0)
  if (weights.length === 0) return []
  if (total === 0) return weights.map(() => 0)

  let assigned = 0
  return weights.map((w, i) => {
    if (i === weights.length - 1) return pool - assigned
    const share = Math.floor((pool * w) / total)
    assigned += share
    return share
  })
}

/** 月次の明細（月次タブの月をクリック）。getMonthDetail・closeMonth の両方で使う */
function buildMonthDetail(month: string, tagId: string | null): MonthDetail {
  const entry = monthBookEntry(month)
  const resaleSales = sales
    .filter(s => s.kind === 'resale' && s.sold_at.slice(0, 7) === month)
    .slice()
    .sort((a, b) => (a.sold_at < b.sold_at ? 1 : a.sold_at > b.sold_at ? -1 : 0))
  const personalSales = sales
    .filter(s => s.kind === 'personal' && s.sold_at.slice(0, 7) === month)
    .slice()
    .sort((a, b) => (a.sold_at < b.sold_at ? 1 : a.sold_at > b.sold_at ? -1 : 0))
  const expensesForMonth = expenses
    .filter(e => e.month === month)
    .slice()
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0))
  const expenseTotal = expensesForMonth.reduce((s, e) => s + e.amount, 0)

  const weights = resaleSales.map(s => (entry.alloc_method === 'by_amount' ? s.price : (s.item_count || 1)))
  const shares = allocateExpenseFloor(weights, expenseTotal)
  const saleRows: MonthSaleRow[] = resaleSales.map((s, i) => ({
    ...s,
    allocated_expense: shares[i] ?? 0,
    net_profit: s.gross_profit - (shares[i] ?? 0),
  }))

  const sum = (f: (s: SaleProfit) => number) => resaleSales.reduce((acc, s) => acc + f(s), 0)
  const grossProfit = sum(s => s.gross_profit)
  const totals: MonthTotals = {
    sales_count: resaleSales.length,
    revenue: sum(s => s.price),
    total_fee: sum(s => s.fee),
    total_shipping: sum(s => s.shipping_fee),
    total_packaging: sum(s => s.packaging_cost),
    total_cost: sum(s => s.cost),
    gross_profit: grossProfit,
    expense_total: expenseTotal,
    net_profit: grossProfit - expenseTotal,
  }

  const catMap = new Map<ExpenseCategory, number>()
  for (const e of expensesForMonth) catMap.set(e.category, (catMap.get(e.category) ?? 0) + e.amount)
  const expense_by_category = [...catMap.entries()].map(([category, amount]) => ({ category, amount }))

  const purchasesThisMonth = purchases.filter(p => p.status === 'confirmed' && p.ordered_at.slice(0, 7) === month)
  const acctMap = new Map<string, { shop_account_id: string; shop_account_name: string; count: number; total_cost: number }>()
  for (const p of purchasesThisMonth) {
    const cur = acctMap.get(p.shop_account_id) ?? {
      shop_account_id: p.shop_account_id, shop_account_name: p.shop_account_name, count: 0, total_cost: 0,
    }
    cur.count += 1
    cur.total_cost += p.total_cost
    acctMap.set(p.shop_account_id, cur)
  }

  const pending = {
    unconfirmed_shipping: [...resaleSales, ...personalSales].filter(s => !s.is_shipping_confirmed).length,
    unmatched: resaleSales.filter(s => s.unmatched === 1).length,
  }

  let filtered: (MonthTotals & { tag: Tag }) | null = null
  if (tagId) {
    const tag = tags.find(t => t.id === tagId)
    if (tag) {
      const taggedRows = saleRows.filter(s => s.tags.some(t => t.id === tag.id) || s.inherited_tags.some(t => t.id === tag.id))
      const tsum = (f: (s: MonthSaleRow) => number) => taggedRows.reduce((acc, s) => acc + f(s), 0)
      filtered = {
        sales_count: taggedRows.length,
        revenue: tsum(s => s.price),
        total_fee: tsum(s => s.fee),
        total_shipping: tsum(s => s.shipping_fee),
        total_packaging: tsum(s => s.packaging_cost),
        total_cost: tsum(s => s.cost),
        gross_profit: tsum(s => s.gross_profit),
        expense_total: tsum(s => s.allocated_expense),
        net_profit: tsum(s => s.net_profit),
        tag,
      }
    }
  }

  const close = entry.close
  const changed_since_close = !!close && (
    close.sales_count !== totals.sales_count
    || close.revenue !== totals.revenue
    || close.gross_profit !== totals.gross_profit
    || close.expense_total !== totals.expense_total
    || close.net_profit !== totals.net_profit
  )

  return {
    month,
    alloc_method: entry.alloc_method,
    close,
    changed_since_close,
    sales: saleRows,
    personal_sales: personalSales,
    expenses: expensesForMonth,
    expense_by_category,
    totals,
    filtered,
    purchases_by_account: [...acctMap.values()],
    pending,
  }
}

// ------------------------------------------------------------
// 収集履歴
// ------------------------------------------------------------

let runs: CollectorRun[] = []

/**
 * ホームの「要対応」で recentRuns（取り込み元ごとの直近1件）の見本になるよう、
 * メルカリはok、メロジョイAはok、メロジョイBはauth_requiredにしておく
 * （db.ts の getDashboard() と同じ考え方：最後の1回だけ見ると他の元の失敗が隠れる）
 */
function buildInitialRuns(): void {
  const [mA, mB] = shopAccounts
  type Spec = {
    minutesAgo: number
    status: CollectorRun['status']
    fetched: number
    inserted: number
    message: string | null
    source?: CollectorRun['source']
    shopId?: string | null
    shopName?: string | null
  }
  // listRuns はこの配列をそのまま返す（sortしない）ため、minutesAgo昇順＝新しい順に並べておく
  const specs: Spec[] = [
    { minutesAgo: 116, status: 'auth_required', fetched: 0, inserted: 0, message: 'ログインが必要です', source: 'mellojoy', shopId: mB.id, shopName: mB.name },
    { minutesAgo: 118, status: 'ok', fetched: 2, inserted: 1, message: null, source: 'mellojoy', shopId: mA.id, shopName: mA.name },
    { minutesAgo: 120, status: 'ok', fetched: 5, inserted: 2, message: null },
    { minutesAgo: 480, status: 'ok', fetched: 4, inserted: 1, message: null },
    { minutesAgo: 840, status: 'auth_required', fetched: 0, inserted: 0, message: 'セッション切れ。再ログインが必要です' },
    { minutesAgo: 1200, status: 'ok', fetched: 6, inserted: 3, message: null },
    { minutesAgo: 1920, status: 'empty', fetched: 0, inserted: 0, message: '0件取得（表示待ちの可能性）' },
    { minutesAgo: 2640, status: 'ok', fetched: 3, inserted: 1, message: null },
  ]
  const now = Date.now()
  runs = specs.map(s => {
    const start = new Date(now - s.minutesAgo * 60_000)
    const finish = new Date(start.getTime() + 8000)
    return {
      id: uid(),
      started_at: isoLocal(start),
      finished_at: isoLocal(finish),
      status: s.status,
      fetched: s.fetched,
      inserted: s.inserted,
      message: s.message,
      source: s.source ?? 'mercari',
      shop_account_id: s.shopId ?? null,
      shop_account_name: s.shopName ?? null,
    }
  })
}

/** started_at の新しい順。lastRun・recentRuns の両方で使う */
function sortedRuns(): CollectorRun[] {
  return runs.slice().sort((a, b) => b.started_at.localeCompare(a.started_at))
}

/** getDashboard の recentRuns：取り込み元（mercari + 有効なメロジョイ口座）ごとの直近1件 */
function recentRunsMock(): CollectorRun[] {
  const sorted = sortedRuns()
  const out: CollectorRun[] = []
  const mercari = sorted.find(r => r.source === 'mercari')
  if (mercari) out.push(mercari)
  const mellojoyAccounts = shopAccounts
    .filter(a => a.kind === 'mellojoy' && a.is_active)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const a of mellojoyAccounts) {
    const run = sorted.find(r => r.shop_account_id === a.id)
    if (run) out.push(run)
  }
  return out
}

// ------------------------------------------------------------
// SorobanApi 実装
// ------------------------------------------------------------

function recalcSale(sale: SaleProfit): void {
  const ids = saleLines.get(sale.id) ?? []
  const items = ids.map(id => inventory.find(it => it.id === id)).filter((it): it is InventoryItem => !!it)
  sale.item_count = items.length
  sale.cost = items.reduce((s, it) => s + it.landed_cost, 0)
  sale.unmatched = sale.item_count === 0 ? 1 : 0
  sale.gross_profit = sale.price - sale.fee - sale.shipping_fee - sale.packaging_cost - sale.cost
  recalcSaleInheritedTags(sale)
}

/** takeFromSale：販売済みの在庫を、いま紐付いている販売から外す（元の販売の cost・item_count が減る） */
function detachFromCurrentSale(item: InventoryItem): void {
  if (!item.sold_to) return
  const fromSaleId = item.sold_to.sale_id
  const fromIds = saleLines.get(fromSaleId) ?? []
  saleLines.set(fromSaleId, fromIds.filter(id => id !== item.id))
  const fromSale = sales.find(s => s.id === fromSaleId)
  if (fromSale) recalcSale(fromSale)
}

/**
 * 在庫の inherited_tags = 紐付く仕入のタグ ∪ 同じ型番の商品タグ
 * （在庫に直接付いたタグと重複するものは除く。出どころは tag.from に残す）
 */
function recalcItemInheritedTags(item: InventoryItem): void {
  const purchaseId = itemPurchaseId.get(item.id)
  const purchase = purchaseId ? purchases.find(p => p.id === purchaseId) : undefined
  const direct = new Set(item.tags.map(t => t.id))
  const merged = new Map<string, Tag>()
  for (const t of purchase?.tags ?? []) {
    if (!direct.has(t.id)) merged.set(t.id, { ...t, from: 'purchase' })
  }
  if (item.model_code) {
    for (const t of productTags.get(item.model_code) ?? []) {
      if (!direct.has(t.id) && !merged.has(t.id)) merged.set(t.id, { ...t, from: 'product' })
    }
  }
  item.inherited_tags = [...merged.values()]
}

/**
 * 販売の inherited_tags = 紐付いた在庫に直接付いたタグ（from: 'inventory'） ∪ その在庫の
 * inherited_tags（from はそのまま：'purchase' か 'product'）。販売に直接付いたタグと重複するものは除く
 */
function recalcSaleInheritedTags(sale: SaleProfit): void {
  const ids = saleLines.get(sale.id) ?? []
  const items = ids.map(id => inventory.find(it => it.id === id)).filter((it): it is InventoryItem => !!it)
  const direct = new Set(sale.tags.map(t => t.id))
  const merged = new Map<string, Tag>()
  for (const it of items) {
    for (const t of it.tags) if (!direct.has(t.id) && !merged.has(t.id)) merged.set(t.id, { ...t, from: 'inventory' })
    for (const t of it.inherited_tags) if (!direct.has(t.id) && !merged.has(t.id)) merged.set(t.id, t)
  }
  sale.inherited_tags = [...merged.values()]
}

/** 仕入・在庫すべての inherited_tags を仕入のタグから作り直す（初期データ構築の仕上げ用） */
function recalcAllInheritance(): void {
  for (const it of inventory) recalcItemInheritedTags(it)
  for (const s of sales) recalcSaleInheritedTags(s)
}

function findSale(id: string): SaleProfit {
  const s = sales.find(x => x.id === id)
  if (!s) throw new Error('販売が見つかりません')
  return s
}

/** listSales と saleTotals で共通の絞り込み */
function filterSales(filter?: SaleFilter): SaleProfit[] {
  let rows = sales.slice()
  if (filter?.month) rows = rows.filter(s => s.sold_at.slice(0, 7) === filter.month)
  if (filter?.kind) rows = rows.filter(s => s.kind === filter.kind)
  if (filter?.onlyPending) {
    rows = rows.filter(s => !s.is_shipping_confirmed || (s.kind === 'resale' && s.unmatched === 1))
  }
  if (filter?.tagId) {
    rows = rows.filter(s =>
      s.tags.some(t => t.id === filter.tagId) || s.inherited_tags.some(t => t.id === filter.tagId),
    )
  }
  return rows
}

function findPurchase(id: string): PurchaseDetail {
  const p = purchases.find(x => x.id === id)
  if (!p) throw new Error('仕入が見つかりません')
  return p
}

/**
 * 仕入明細から生まれた在庫 1 点ずつのいまの状態。呼ばれるたびに inventory / saleLines /
 * listingItems の現在の値から組み立てる（landed_cost は生成時に確定したまま動かさない）
 */
function buildPurchaseLineItems(lineId: string) {
  const ids = lineItemIds.get(lineId) ?? []
  const imageUrl = lineImageUrl.get(lineId) ?? null
  return ids
    .map(id => inventory.find(i => i.id === id))
    .filter((i): i is InventoryItem => !!i)
    .map(i => {
      const sale = saleForItem(i.id)
      return {
        id: i.id,
        item_code: i.item_code,
        status: i.status,
        landed_cost: i.landed_cost,
        listing_price: i.listing?.price ?? null,
        sale_id: sale?.id ?? null,
        sale_price: sale?.price ?? null,
        sold_at: sale?.sold_at ?? null,
        image_url: imageUrl,
      }
    })
}

/** getPurchase が返す PurchaseDetail：lines[].items を現在の状態で組み立て直す */
function hydratePurchase(p: PurchaseDetail): PurchaseDetail {
  return { ...p, lines: p.lines.map(l => ({ ...l, items: buildPurchaseLineItems(l.id) })) }
}

// ------------------------------------------------------------
// 商品（型番）ページ・在庫の履歴
// ------------------------------------------------------------

function allModelCodes(): string[] {
  const models = new Set<string>()
  for (const it of inventory) if (it.model_code) models.add(it.model_code)
  return [...models]
}

/** その在庫アイテムが紐付いている販売（無ければ undefined） */
function saleForItem(itemId: string): SaleProfit | undefined {
  for (const [saleId, ids] of saleLines) {
    if (ids.includes(itemId)) return sales.find(s => s.id === saleId)
  }
  return undefined
}

/** その型番の在庫が実際に紐付いた販売（タイトルの型番一致ではなく、紐付け済みのものだけ） */
function linkedSalesForModel(model: string): SaleProfit[] {
  const saleIds = new Set<string>()
  for (const [saleId, ids] of saleLines) {
    if (ids.some(itemId => inventory.find(it => it.id === itemId)?.model_code === model)) {
      saleIds.add(saleId)
    }
  }
  return sales.filter(s => saleIds.has(s.id))
}

function variantSummaryFor(model: string): VariantSummary {
  const items = inventory.filter(i => i.model_code === model)
  const soldItems = items.filter(i => i.status === 'sold')
  const inStockItems = items.filter(i => i.status === 'in_stock')
  const relatedSales = sales.filter(s => s.model_codes.includes(model) && s.item_count > 0)
  const avgPrice = relatedSales.length
    ? Math.round(relatedSales.reduce((s, x) => s + x.price, 0) / relatedSales.length)
    : null
  const avgProfit = relatedSales.length
    ? Math.round(relatedSales.reduce((s, x) => s + x.gross_profit, 0) / relatedSales.length)
    : null
  const sample = items[0]
  // 最新の在庫名（表示名が無いときのフォールバック。=最後に仕入れた明細の名前）
  const latest = items.reduce<InventoryItem | undefined>(
    (max, i) => (!max || i.acquired_at >= max.acquired_at ? i : max), undefined,
  )
  const customName = productCustomName.get(model) ?? null

  return {
    model_code: model,
    series_code: sample?.series_code ?? null,
    material: sample?.material ?? null,
    name: customName ?? latest?.name ?? model,
    custom_name: customName,
    purchased: items.length,
    sold: soldItems.length,
    in_stock: inStockItems.length,
    stock_value: inStockItems.reduce((s, i) => s + i.landed_cost, 0),
    avg_price: avgPrice,
    avg_profit: avgProfit,
    total_profit: relatedSales.reduce((s, x) => s + x.gross_profit, 0),
  }
}

/** 自動判定の商品画像：①最新の出品の画像 ＞ ②最新の販売の画像（人がセットした画像は考えない） */
function autoProductThumb(model: string): string | null {
  const latestListing = listingRecords
    .filter(r => r.model_codes.includes(model) && r.thumb_url)
    .sort((a, b) => (a.listed_at < b.listed_at ? 1 : a.listed_at > b.listed_at ? -1 : 0))[0]
  if (latestListing) return latestListing.thumb_url
  const linkedSales = linkedSalesForModel(model)
  return linkedSales.slice().sort((a, b) => b.sold_at.localeCompare(a.sold_at))[0]?.thumb_url ?? null
}

function buildProductSummary(model: string): ProductSummary {
  const summary = variantSummaryFor(model)
  const items = inventory.filter(i => i.model_code === model)
  const purchaseTotal = items.reduce((s, i) => s + i.landed_cost, 0)
  const avgCost = items.length ? Math.round(purchaseTotal / items.length) : null
  const lastPurchasedAt = items.reduce<string | null>(
    (max, i) => (!max || i.acquired_at > max ? i.acquired_at : max), null,
  )
  const linkedSales = linkedSalesForModel(model)
  const lastSoldAt = linkedSales.reduce<string | null>(
    (max, s) => (!max || s.sold_at > max ? s.sold_at : max), null,
  )
  const isManual = productManualImage.has(model)
  const thumbUrl = isManual ? (productManualImage.get(model) ?? null) : autoProductThumb(model)

  return {
    ...summary,
    purchase_total: purchaseTotal,
    avg_cost: avgCost,
    last_purchased_at: lastPurchasedAt,
    last_sold_at: lastSoldAt,
    thumb_url: thumbUrl,
    image_manual: isManual,
    tags: productTags.get(model) ?? [],
  }
}

/** YYYY-MM の from〜to（両端含む）を1か月刻みで列挙する */
function monthRange(from: string, to: string): string[] {
  const [fy, fm] = from.split('-').map(Number)
  const d = new Date(fy, fm - 1, 1)
  const out: string[] = []
  while (thisMonthLocal(d) <= to) {
    out.push(thisMonthLocal(d))
    d.setMonth(d.getMonth() + 1)
  }
  return out
}

/**
 * 月ごとの在庫の増減。分割の子（parent_id あり）は独立した仕入ではないので数えない。
 * 廃棄・自家消費・分割で在庫から抜けた日は追っていないため、仕入月に抜けたものとして扱う（近似）。
 */
function buildProductMonths(model: string): ProductMonthPoint[] {
  const items = inventory.filter(i => i.model_code === model && !i.parent_id)
  if (items.length === 0) return []

  const firstMonth = items.reduce((min, i) => {
    const m = i.acquired_at.slice(0, 7)
    return m < min ? m : min
  }, items[0].acquired_at.slice(0, 7))
  const months = monthRange(firstMonth, thisMonthLocal())

  const points = new Map<string, ProductMonthPoint>()
  for (const mo of months) {
    points.set(mo, { month: mo, purchased: 0, sold: 0, in_stock: 0, purchase_amount: 0, sales_amount: 0, profit: 0 })
  }
  const removedByMonth = new Map<string, number>()

  for (const item of items) {
    const purchaseMonth = item.acquired_at.slice(0, 7)
    const bucket = points.get(purchaseMonth)
    if (bucket) {
      bucket.purchased += 1
      bucket.purchase_amount += item.landed_cost
    }

    if (item.status === 'sold') {
      const sale = saleForItem(item.id)
      const soldMonth = sale?.sold_at.slice(0, 7) ?? purchaseMonth
      const soldBucket = points.get(soldMonth) ?? bucket
      if (soldBucket) {
        soldBucket.sold += 1
        if (sale) {
          const n = sale.item_count || 1
          const revenueShare = Math.round(sale.price / n)
          const feeShare = Math.round(sale.fee / n)
          const shipShare = Math.round(sale.shipping_fee / n)
          const packShare = Math.round(sale.packaging_cost / n)
          soldBucket.sales_amount += revenueShare
          soldBucket.profit += revenueShare - feeShare - shipShare - packShare - item.landed_cost
        }
      }
    } else if (item.status === 'disposed' || item.status === 'personal_use' || item.status === 'split') {
      removedByMonth.set(purchaseMonth, (removedByMonth.get(purchaseMonth) ?? 0) + 1)
    }
  }

  let running = 0
  for (const mo of months) {
    const p = points.get(mo)!
    running += p.purchased - p.sold - (removedByMonth.get(mo) ?? 0)
    p.in_stock = Math.max(0, running)
  }

  return months.map(mo => points.get(mo)!)
}

/** 在庫 1 点の履歴。仕入→到着→販売→発送→受取→取引完了 を時系列で並べる */
function buildItemTimeline(item: InventoryItem): ItemTimeline {
  const events: TimelineEvent[] = []
  const purchaseId = itemPurchaseId.get(item.id)
  const purchase = purchaseId ? purchases.find(p => p.id === purchaseId) ?? null : null

  if (purchase) {
    const line = purchase.lines.find(l => l.model_code === item.model_code) ?? purchase.lines[0] ?? null
    const detail = line
      ? `¥${line.unit_price.toLocaleString('ja-JP')} ＋送料按分 ¥${(item.landed_cost - line.unit_price).toLocaleString('ja-JP')} → 原価 ¥${item.landed_cost.toLocaleString('ja-JP')}`
      : `→ 原価 ¥${item.landed_cost.toLocaleString('ja-JP')}`
    events.push({
      date: purchase.ordered_at,
      kind: 'ordered',
      title: `メロジョイで注文 ${purchase.order_no ?? '（下書き）'}`,
      detail,
      amount: item.landed_cost,
    })

    if (purchase.fulfillment) {
      events.push({
        date: purchase.shipped_at,
        kind: 'purchase_shipped',
        title: '発送済み（仕入先）',
        detail: null,
        amount: null,
      })
      events.push({
        date: purchase.delivered_at,
        kind: 'purchase_delivered',
        title: '到着',
        detail: null,
        amount: null,
      })
    }
  }

  const sale = saleForItem(item.id)
  if (sale) {
    events.push({
      date: sale.sold_at,
      kind: 'sold',
      title: `メルカリで販売：${sale.title}`,
      detail: sale.buyer ? `購入者 ${sale.buyer}` : null,
      amount: sale.price,
    })
    events.push({
      date: sale.shipped_at,
      kind: 'sale_shipped',
      title: '発送済み',
      detail: null,
      amount: null,
    })
    events.push({
      date: sale.delivered_at,
      kind: 'sale_delivered',
      title: '受取済み',
      detail: null,
      amount: null,
    })
    events.push({
      date: sale.completed_at,
      kind: 'sale_completed',
      title: '取引完了',
      detail: null,
      amount: sale.gross_profit,
    })
  } else if (item.status === 'disposed') {
    events.push({
      date: itemDisposedAt.get(item.id) ?? null,
      kind: 'disposed',
      title: '廃棄',
      detail: null,
      amount: null,
    })
  } else if (item.status === 'personal_use') {
    events.push({
      date: itemDisposedAt.get(item.id) ?? null,
      kind: 'personal_use',
      title: '自家消費',
      detail: null,
      amount: null,
    })
  } else if (item.status === 'split') {
    events.push({
      date: itemSplitAt.get(item.id) ?? null,
      kind: 'split',
      title: '複数点に分割',
      detail: null,
      amount: null,
    })
  }

  return { item, events, sale: sale ?? null, purchase }
}

// ------------------------------------------------------------
// v0.2 画面（受信箱・進捗・在庫グループ・カルテ・計算書・仕入先カード）の下ごしらえ
// ------------------------------------------------------------

/** MM/DD に売れた ・ ¥3,400 ・ 買い手 taka ・ 発送方法 ネコポス の形（ホームの受信箱・要対応の1行） */
function formatSaleDetail(sale: SaleProfit): string {
  const [, m, d] = sale.sold_at.split('-')
  const parts = [`${Number(m)}/${Number(d)} に売れた`, `¥${sale.price.toLocaleString('ja-JP')}`]
  if (sale.buyer) parts.push(`買い手 ${sale.buyer}`)
  const methodName = sale.shipping_method_id
    ? shippingMethods.find(x => x.id === sale.shipping_method_id)?.name ?? null
    : null
  parts.push(`発送方法 ${methodName ?? '未定'}`)
  return parts.join(' ・ ')
}

/** 型番が1つだけの未紐付け販売に対する、先入先出の自動確定候補（M-06 と同じ規則） */
function linkCandidate(sale: SaleProfit): InventoryItem | null {
  if (sale.model_codes.length !== 1) return null
  return takeOldestByModel(sale.model_codes[0]) ?? null
}

/** 有効な発送方法の料金の中央値（送料未入力の見込み計算に使う） */
function shippingFeeMedian(): number {
  const fees = shippingMethods.filter(m => m.is_active).map(m => m.fee).sort((a, b) => a - b)
  if (fees.length === 0) return 0
  const mid = Math.floor(fees.length / 2)
  return fees.length % 2 ? fees[mid] : Math.round((fees[mid - 1] + fees[mid]) / 2)
}

function shippingFeeBounds(): { min: number; max: number } {
  const fees = shippingMethods.filter(m => m.is_active).map(m => m.fee)
  if (fees.length === 0) return { min: 0, max: 0 }
  return { min: Math.min(...fees), max: Math.max(...fees) }
}

/**
 * 送料未入力・未紐付けの販売 1 件の見込み粗利（ホームの利益ストリップ pending_profit_estimate 用）。
 * 送料は選択済みならそれ、無ければ発送方法の料金の中央値。原価は紐付け済みならそれ、
 * 無ければ型番一致の候補1点（無ければ0）
 */
function estimateSalePendingProfit(sale: SaleProfit): number {
  const shipping = sale.is_shipping_confirmed ? sale.shipping_fee : shippingFeeMedian()
  const cost = sale.kind === 'resale' && sale.unmatched
    ? (linkCandidate(sale)?.landed_cost ?? sale.cost)
    : sale.cost
  return sale.price - sale.fee - shipping - sale.packaging_cost - cost
}

/**
 * 受信箱の1行の粗利プレビュー（min/max）。送料が未確定なら発送方法の料金の幅、
 * 未紐付けなら候補在庫の原価の幅で見込みを出す（確定していれば min=max）
 */
function profitHintFor(sale: SaleProfit): { min: number; max: number } {
  const shipBounds = sale.is_shipping_confirmed
    ? { min: sale.shipping_fee, max: sale.shipping_fee }
    : shippingFeeBounds()

  let costBounds: { min: number; max: number }
  if (sale.kind === 'resale' && sale.unmatched) {
    const single = linkCandidate(sale)
    if (single) {
      costBounds = { min: single.landed_cost, max: single.landed_cost }
    } else {
      const costs = inventory
        .filter(i => i.status === 'in_stock' && i.model_code && sale.model_codes.includes(i.model_code))
        .map(i => i.landed_cost)
      costBounds = costs.length ? { min: Math.min(...costs), max: Math.max(...costs) } : { min: 0, max: 0 }
    }
  } else {
    costBounds = { min: sale.cost, max: sale.cost }
  }

  return {
    min: sale.price - sale.fee - shipBounds.max - sale.packaging_cost - costBounds.max,
    max: sale.price - sale.fee - shipBounds.min - sale.packaging_cost - costBounds.min,
  }
}

/** 在庫 1 点の状態バケット。listInventoryGroups・getInventoryOverview で共通 */
type InventoryBucket = 'unlisted_arrived' | 'not_arrived' | 'listed' | 'sold' | 'other'
function inventoryBucket(i: InventoryItem): InventoryBucket {
  if (i.status === 'sold') return 'sold'
  if (i.status !== 'in_stock') return 'other'
  if (i.listing) return 'listed'
  if (i.fulfillment === 'delivered' || i.fulfillment === null) return 'unlisted_arrived'
  return 'not_arrived' // pending / shipped
}

/** 型番なし（model_code が null）のグループの平均。variantSummaryFor はタイトルの型番一致で拾うため、
 *  型番を持たない在庫には使えない。紐付いた販売から直接拾う */
function groupAveragesFor(items: InventoryItem[]): { avg_price: number | null; avg_profit: number | null } {
  const relatedSales = new Map<string, SaleProfit>()
  for (const it of items) {
    if (it.status !== 'sold') continue
    const s = saleForItem(it.id)
    if (s) relatedSales.set(s.id, s)
  }
  const rows = [...relatedSales.values()]
  if (!rows.length) return { avg_price: null, avg_profit: null }
  return {
    avg_price: Math.round(rows.reduce((s, x) => s + x.price, 0) / rows.length),
    avg_profit: Math.round(rows.reduce((s, x) => s + x.gross_profit, 0) / rows.length),
  }
}

/** その型番の代表サムネイル（紐付いた販売のうち最新のもの。無ければ null） */
function groupThumbFor(items: InventoryItem[]): string | null {
  const soldSales = items
    .filter(i => i.status === 'sold')
    .map(i => saleForItem(i.id))
    .filter((s): s is SaleProfit => !!s)
    .sort((a, b) => b.sold_at.localeCompare(a.sold_at))
  return soldSales[0]?.thumb_url ?? null
}

/** MonthSaleRow[] からタグ別の集計を作る（直接＋派生タグ、重複タグは両方に数える） */
function computeByTag(rows: MonthSaleRow[]): { by_tag: MonthStatement['by_tag']; multi_tag_count: number } {
  const map = new Map<string, { tag: Tag; count: number; gross_profit: number; allocated_expense: number; net_profit: number }>()
  let multiTagCount = 0
  for (const r of rows) {
    const allTags = new Map<string, Tag>()
    for (const t of r.tags) allTags.set(t.id, t)
    for (const t of r.inherited_tags) allTags.set(t.id, t)
    if (allTags.size >= 2) multiTagCount += 1
    for (const t of allTags.values()) {
      const cur = map.get(t.id) ?? { tag: t, count: 0, gross_profit: 0, allocated_expense: 0, net_profit: 0 }
      cur.count += 1
      cur.gross_profit += r.gross_profit
      cur.allocated_expense += r.allocated_expense
      cur.net_profit += r.net_profit
      map.set(t.id, cur)
    }
  }
  return { by_tag: [...map.values()], multi_tag_count: multiTagCount }
}

/** ホームの「今やること」を組み立てる */
function buildInbox(): Inbox {
  const month = thisMonthLocal()
  const monthly = withExpenses([...monthlyFromSales(sales), ...extraOlderMonths()])
  const thisMonthRow = monthly.find(m => m.month === month && m.kind === 'resale') ?? null
  const lastMonth = monthAgoStr(1)
  const lastMonthRow = monthly.find(m => m.month === lastMonth && m.kind === 'resale') ?? null

  const pendingRows = sales.filter(s => !s.is_shipping_confirmed || (s.kind === 'resale' && s.unmatched === 1))
  const awaitingRows = sales.filter(s => s.status === 'shipped' || s.status === 'delivered')

  const strip: ProfitStrip = {
    month,
    gross_profit: thisMonthRow?.gross_profit ?? 0,
    net_profit: thisMonthRow?.net_profit ?? 0,
    revenue: thisMonthRow?.revenue ?? 0,
    sales_count: thisMonthRow?.sales_count ?? 0,
    pending_profit_estimate: pendingRows.reduce((s, x) => s + estimateSalePendingProfit(x), 0),
    pending_count: pendingRows.length,
    awaiting_payout: awaitingRows.reduce((s, x) => s + (x.price - x.fee), 0),
    awaiting_payout_count: awaitingRows.length,
    last_month: lastMonthRow ? { month: lastMonth, net_profit: lastMonthRow.net_profit, closed: lastMonthRow.closed } : null,
  }

  const groups: InboxGroup[] = []

  const shipItems = sales.filter(s => s.status === 'waiting_shipment')
  if (shipItems.length) {
    groups.push({
      kind: 'ship',
      label: '発送してください',
      hint: '売れた商品を発送します',
      items: shipItems.map(s => ({
        kind: 'ship' as InboxKind,
        id: s.id,
        title: s.title,
        detail: formatSaleDetail(s),
        thumb_url: s.thumb_url,
        sale: s,
        profit_hint: profitHintFor(s),
      })),
    })
  }

  const shippingItems = sales.filter(s => !s.is_shipping_confirmed)
  if (shippingItems.length) {
    groups.push({
      kind: 'shipping',
      label: '送料を入力',
      hint: '発送方法を選ぶと送料が決まります',
      items: shippingItems.map(s => ({
        kind: 'shipping' as InboxKind,
        id: s.id,
        title: s.title,
        detail: formatSaleDetail(s),
        thumb_url: s.thumb_url,
        sale: s,
        profit_hint: profitHintFor(s),
      })),
    })
  }

  const linkItems = sales.filter(s => s.kind === 'resale' && s.unmatched === 1)
  if (linkItems.length) {
    groups.push({
      kind: 'link',
      label: '在庫と紐付け',
      hint: '売れた商品がどの在庫か決めます',
      items: linkItems.map(s => {
        const cand = linkCandidate(s)
        return {
          kind: 'link' as InboxKind,
          id: s.id,
          title: s.title,
          detail: formatSaleDetail(s),
          thumb_url: s.thumb_url,
          sale: s,
          candidate: cand
            ? { inventory_item_id: cand.id, item_code: cand.item_code, landed_cost: cand.landed_cost, acquired_at: cand.acquired_at }
            : null,
          profit_hint: profitHintFor(s),
        }
      }),
    })
  }

  const confirmItems = purchases.filter(p => p.status === 'draft')
  if (confirmItems.length) {
    groups.push({
      kind: 'confirm',
      label: '仕入を確定',
      hint: '価格が入った下書きを確定して在庫にします',
      items: confirmItems.map(p => ({
        kind: 'confirm' as InboxKind,
        id: p.id,
        title: p.first_line_name ?? '仕入（下書き）',
        detail: `${p.shop_account_name} ・ ${p.ordered_at} 注文`,
        thumb_url: null,
        purchase: p,
      })),
    })
  }

  const collectItems = recentRunsMock().filter(r => r.status !== 'ok')
  if (collectItems.length) {
    groups.push({
      kind: 'collect',
      label: '取り込みを確認',
      hint: 'ログインが切れているか、取得に失敗しています',
      items: collectItems.map(r => ({
        kind: 'collect' as InboxKind,
        id: r.id,
        title: r.source === 'mercari' ? 'メルカリの取り込み' : `${r.shop_account_name ?? '仕入先'} の取り込み`,
        detail: r.message ?? (r.status === 'auth_required' ? 'ログインが必要です' : '取得に失敗しました'),
        thumb_url: null,
        run: r,
      })),
    })
  }

  const reminderItems: InboxItem[] = []
  const today = todayLocal()
  const dayOfMonth = Number(today.split('-')[2])

  // manual_purchase：TikTok の最後の仕入から7日
  for (const acc of shopAccounts.filter(a => a.kind === 'tiktok' && a.is_active)) {
    const last = purchases
      .filter(p => p.shop_account_id === acc.id)
      .reduce<string | null>((max, p) => (!max || p.ordered_at > max ? p.ordered_at : max), null)
    if (last && diffDays(last) >= 7 && !isReminderSnoozed('manual_purchase')) {
      reminderItems.push({
        kind: 'reminder',
        id: 'manual_purchase',
        title: `${acc.name} の仕入を確認`,
        detail: `最後の仕入から ${diffDays(last)} 日`,
        thumb_url: null,
        reminder: { type: 'manual_purchase', action_label: '確認した' },
      })
    }
  }

  // delivery：自動取得が無い仕入先（メロジョイ以外）で、手入力の到着状態が「発送済み」のまま5日
  for (const p of purchases) {
    if (p.status !== 'confirmed' || p.fulfillment !== 'shipped' || !p.shipped_at) continue
    const shop = shopAccounts.find(a => a.id === p.shop_account_id)
    if (shop?.kind === 'mellojoy') continue // メロジョイは次の取り込みで自動的に戻る
    if (diffDays(p.shipped_at) < 5) continue
    if (isReminderSnoozed('delivery', p.id)) continue
    reminderItems.push({
      kind: 'reminder',
      id: 'delivery',
      title: `${p.shop_account_name} の到着を確認`,
      detail: `発送から ${diffDays(p.shipped_at)} 日・${p.order_no ?? '（下書き）'}`,
      thumb_url: null,
      reminder: { type: 'delivery', action_label: '確認した', purchase_id: p.id },
    })
  }

  // expense：今月の経費が0件、かつ10日以降
  const thisMonthExpenses = expenses.filter(e => e.month === month)
  if (thisMonthExpenses.length === 0 && dayOfMonth >= 10 && !isReminderSnoozed('expense')) {
    reminderItems.push({
      kind: 'reminder',
      id: 'expense',
      title: '今月の経費を記録',
      detail: '今月はまだ経費の記録がありません',
      thumb_url: null,
      reminder: { type: 'expense', action_label: '記録する' },
    })
  }

  // close_month：先月が未締めのまま、かつ3日以降
  if (!monthBookEntry(lastMonth).close && dayOfMonth >= 3 && !isReminderSnoozed('close_month', lastMonth)) {
    reminderItems.push({
      kind: 'reminder',
      id: 'close_month',
      title: `${lastMonth} を締める`,
      detail: '先月の月次がまだ締まっていません',
      thumb_url: null,
      reminder: { type: 'close_month', action_label: '締める', month: lastMonth },
    })
  }

  if (reminderItems.length) {
    groups.push({ kind: 'reminder', label: '忘れていませんか', hint: '', items: reminderItems })
  }

  const warnDays = Number(settings.aging_warn_days ?? '90')
  const agingItems = inventory.filter(i => i.status === 'in_stock' && i.aging_days > warnDays)
  const unallocatedListings = listingRecords.filter(
    r => (r.status === 'active' || r.status === 'suspended') && (listingItems.get(r.mercari_item_id) ?? []).length === 0,
  ).length
  const products = allModelCodes().map(buildProductSummary)
  const topModel = products.slice().sort((a, b) => b.total_profit - a.total_profit)[0] ?? null

  return {
    strip,
    groups,
    done_today: 4,
    review: {
      aging_count: agingItems.length,
      aging_days: warnDays,
      unallocated_listings: unallocatedListings,
      last_month_unclosed: monthBookEntry(lastMonth).close ? null : lastMonth,
      top_model: topModel ? { model_code: topModel.model_code, name: topModel.name, total_profit: topModel.total_profit } : null,
    },
  }
}

const api: SorobanApi = {
  async getDashboard(): Promise<DashboardStats> {
    const needsShipment = sales.filter(s => s.status === 'waiting_shipment').length
    const needsShipping = sales.filter(s => !s.is_shipping_confirmed).length
    const needsMatch = sales.filter(s => s.kind === 'resale' && s.unmatched).length
    const needsPurchaseConfirm = purchases.filter(p => p.status === 'draft').length
    const needsListingAllocation = listingRecords.filter(
      r => r.status === 'active' && (listingItems.get(r.mercari_item_id) ?? []).length === 0,
    ).length
    const stock = inventory.filter(i => i.status === 'in_stock')
    const stockCount = stock.length
    const stockValue = stock.reduce((s, i) => s + i.landed_cost, 0)
    const warnDays = Number(settings.aging_warn_days ?? '90')
    const agingCount = stock.filter(i => i.aging_days > warnDays).length
    const month = thisMonthLocal()
    const thisMonth = withExpenses(monthlyFromSales(sales)).find(m => m.month === month && m.kind === 'resale') ?? null
    const lastRun = sortedRuns()[0] ?? null
    return wait({
      needsShipment, needsShipping, needsMatch, needsPurchaseConfirm, needsListingAllocation,
      stockCount, stockValue, agingCount, thisMonth, lastRun,
      recentRuns: recentRunsMock(),
    })
  },

  async getInbox(): Promise<Inbox> {
    return wait(buildInbox())
  },

  async snoozeReminder(type: ReminderType, id?: string | null) {
    reminderSnoozes.set(reminderKey(type, id ?? null), todayLocal(daysAgo(-7)))
    return wait(undefined)
  },

  async getSalesProgress(): Promise<SalesProgress> {
    const month = thisMonthLocal()
    const listedRecs = listingRecords.filter(r => r.status === 'active').map(buildListing)
    const listedCount = listedRecs.reduce((s, l) => s + l.items.length, 0)
    const listedProfit = listedRecs.reduce((s, l) => s + (l.expected_profit ?? 0), 0)
    const unallocated = listedRecs.filter(l => l.items.length === 0).length

    const toShip = sales.filter(s => s.status === 'waiting_shipment')
    const inTransit = sales.filter(s => s.status === 'shipped' || s.status === 'delivered')
    const completed = sales.filter(s => s.status === 'completed' && s.completed_at?.slice(0, 7) === month)

    const needsShipping = sales.filter(s => !s.is_shipping_confirmed).length
    const needsLink = sales.filter(s => s.kind === 'resale' && s.unmatched === 1).length
    const done = sales.filter(s => s.is_shipping_confirmed && !(s.kind === 'resale' && s.unmatched === 1)).length

    return wait({
      listed: { count: listedCount, expected_profit: listedProfit, unallocated },
      to_ship: { count: toShip.length, revenue: toShip.reduce((s, x) => s + x.price, 0) },
      in_transit: { count: inTransit.length, revenue: inTransit.reduce((s, x) => s + x.price, 0) },
      completed_this_month: { count: completed.length, revenue: completed.reduce((s, x) => s + x.price, 0) },
      all: sales.length,
      inputs: { needs_shipping: needsShipping, needs_link: needsLink, done },
    })
  },

  async getInventoryOverview(): Promise<InventoryOverview> {
    const warnDays = Number(settings.aging_warn_days ?? '90')
    const unlistedArrived = inventory.filter(i => inventoryBucket(i) === 'unlisted_arrived')
    const notArrived = inventory.filter(i => inventoryBucket(i) === 'not_arrived')
    const listedRecs = listingRecords
      .filter(r => r.status === 'active' || r.status === 'suspended')
      .map(buildListing)
      .filter(l => l.items.length > 0)
    const listedCount = listedRecs.reduce((s, l) => s + l.items.length, 0)
    const listedProfit = listedRecs.reduce((s, l) => s + (l.expected_profit ?? 0), 0)
    const agingItems = inventory.filter(i => i.status === 'in_stock' && i.aging_days > warnDays)

    return wait({
      unlisted_arrived: { count: unlistedArrived.length, cost: unlistedArrived.reduce((s, i) => s + i.landed_cost, 0) },
      not_arrived: { count: notArrived.length, cost: notArrived.reduce((s, i) => s + i.landed_cost, 0) },
      listed: { count: listedCount, expected_profit: listedProfit },
      aging: { count: agingItems.length, cost: agingItems.reduce((s, i) => s + i.landed_cost, 0), days: warnDays },
    })
  },

  async listInventoryGroups(filter: InventoryGroupFilter): Promise<InventoryGroup[]> {
    const byModel = new Map<string | null, InventoryItem[]>()
    for (const it of inventory) {
      const key = it.model_code
      const arr = byModel.get(key) ?? []
      arr.push(it)
      byModel.set(key, arr)
    }

    const groups: InventoryGroup[] = []
    for (const [model, items] of byModel) {
      const buckets = { unlisted_arrived: 0, not_arrived: 0, listed: 0, sold: 0 }
      for (const it of items) {
        const b = inventoryBucket(it)
        if (b === 'unlisted_arrived' || b === 'not_arrived' || b === 'listed' || b === 'sold') buckets[b] += 1
      }

      const filtered = items
        .filter(i => {
          // split（分割前の親）は 'split' フィルタでだけ見る。'all'／'other' には含めない
          if (filter === 'split') return i.status === 'split'
          if (i.status === 'split') return false
          if (filter === 'all') return true
          const b = inventoryBucket(i)
          if (filter === 'unlisted') return b === 'unlisted_arrived' || b === 'not_arrived'
          return b === filter
        })
        .slice()
        .sort((a, b) => b.aging_days - a.aging_days)
      if (filter !== 'all' && filtered.length === 0) continue

      const inStockItems = items.filter(i => i.status === 'in_stock')
      const oldest = inStockItems.reduce<InventoryItem | null>(
        (min, i) => (!min || i.acquired_at < min.acquired_at ? i : min), null,
      )
      const latest = items.reduce<InventoryItem | undefined>(
        (max, i) => (!max || i.acquired_at >= max.acquired_at ? i : max), undefined,
      )
      const averages = model ? variantSummaryFor(model) : groupAveragesFor(items)
      const totalCost = items.reduce((s, i) => s + i.landed_cost, 0)
      const customName = model ? productCustomName.get(model) ?? null : null

      groups.push({
        model_code: model,
        name: customName ?? latest?.name ?? (model ?? '型番なし'),
        thumb_url: groupThumbFor(items),
        tags: model ? (productTags.get(model) ?? []) : [],
        unlisted: buckets.unlisted_arrived + buckets.not_arrived,
        unlisted_arrived: buckets.unlisted_arrived,
        not_arrived: buckets.not_arrived,
        listed: buckets.listed,
        sold: buckets.sold,
        avg_price: averages.avg_price,
        avg_profit: averages.avg_profit,
        cost_per_item: items.length ? Math.round(totalCost / items.length) : null,
        oldest_acquired_at: oldest?.acquired_at ?? null,
        oldest_aging_days: oldest?.aging_days ?? null,
        items: filtered,
      })
    }

    groups.sort((a, b) => {
      if (a.model_code === null) return 1
      if (b.model_code === null) return -1
      return a.model_code.localeCompare(b.model_code)
    })
    return wait(groups)
  },

  async getProductKarte(modelCode: string): Promise<ProductKarte> {
    if (!allModelCodes().includes(modelCode)) throw new Error('商品が見つかりません')
    const summary = buildProductSummary(modelCode)
    const items = inventory
      .filter(i => i.model_code === modelCode)
      .slice()
      .sort((a, b) => (a.acquired_at < b.acquired_at ? 1 : a.acquired_at > b.acquired_at ? -1 : 0))
    const modelSales = linkedSalesForModel(modelCode)
      .slice()
      .sort((a, b) => (a.sold_at < b.sold_at ? 1 : a.sold_at > b.sold_at ? -1 : 0))
    const listings = listingRecords
      .filter(r => r.model_codes.includes(modelCode))
      .map(buildListing)
      .sort((a, b) => (a.first_seen_at < b.first_seen_at ? 1 : -1))

    const sourceLine = purchases
      .flatMap(p => p.lines)
      .find(l => l.model_code === modelCode)
    const source_name = sourceLine && sourceLine.name !== summary.name ? sourceLine.name : null

    const inStockItems = items.filter(i => i.status === 'in_stock')
    const arrived = inStockItems.filter(i => i.fulfillment === 'delivered' || i.fulfillment === null)
    const notArrived = inStockItems.filter(i => i.fulfillment === 'pending' || i.fulfillment === 'shipped')

    const activeListings = listings.filter(l => l.status === 'active' || l.status === 'suspended')
    const listedProfit = activeListings.reduce((s, l) => s + (l.expected_profit ?? 0), 0)

    const cutoff = todayLocal(daysAgo(90))
    const recentSales = modelSales.filter(s => s.sold_at >= cutoff)

    const prices = modelSales.map(s => s.price)
    const totalRevenue = modelSales.reduce((s, x) => s + x.price, 0)
    const totalProfit = modelSales.reduce((s, x) => s + x.gross_profit, 0)

    const lastLinkedSale = modelSales.slice().sort((a, b) => (a.sold_at < b.sold_at ? 1 : -1))[0] ?? null
    const defaultItem = items.find(i => i.status === 'in_stock' && !i.listing) ?? null

    return wait({
      summary,
      source_name,
      in_stock: { count: inStockItems.length, arrived: arrived.length, not_arrived: notArrived.length, cost: inStockItems.reduce((s, i) => s + i.landed_cost, 0) },
      listed: { count: activeListings.length, price_total: activeListings.reduce((s, l) => s + l.price, 0), expected_profit: listedProfit },
      sold_recent: { count: recentSales.length, days: 90 },
      price_range: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
      profit_rate: totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 100) : null,
      items,
      sales: modelSales,
      listings,
      estimate_default: {
        inventory_item_id: defaultItem?.id ?? null,
        shipping_method_id: lastLinkedSale?.shipping_method_id ?? null,
      },
    })
  },

  async getMonthStatement(month: string): Promise<MonthStatement> {
    const detail = buildMonthDetail(month, null)
    const revenue = detail.totals.revenue
    const grossProfit = detail.totals.gross_profit
    const netProfit = detail.totals.net_profit
    const { by_tag, multi_tag_count } = computeByTag(detail.sales)
    const awaitingRows = sales.filter(s => s.sold_at.slice(0, 7) === month && (s.status === 'shipped' || s.status === 'delivered'))

    return wait({
      month,
      sales_count: detail.totals.sales_count,
      revenue,
      fee: detail.totals.total_fee,
      shipping: detail.totals.total_shipping,
      shipping_actual_count: detail.sales.filter(s => s.shipping_source === 'actual').length,
      packaging: detail.totals.total_packaging,
      cost: detail.totals.total_cost,
      cost_items: detail.sales.reduce((s, x) => s + x.item_count, 0),
      gross_profit: grossProfit,
      gross_rate: revenue > 0 ? Math.round((grossProfit / revenue) * 100) : null,
      expenses: detail.expense_by_category,
      expense_total: detail.totals.expense_total,
      net_profit: netProfit,
      net_rate: revenue > 0 ? Math.round((netProfit / revenue) * 100) : null,
      awaiting_payout: awaitingRows.reduce((s, x) => s + (x.price - x.fee), 0),
      personal_revenue: detail.personal_sales.reduce((s, x) => s + x.price, 0),
      purchase_paid: detail.purchases_by_account.reduce((s, a) => s + a.total_cost, 0),
      by_tag,
      multi_tag_count,
    })
  },

  async listPurchaseAccountCards(from: string | null, to: string | null): Promise<PurchaseAccountCard[]> {
    const inRange = (d: string) => (!from || d >= from) && (!to || d <= to)
    const confirmedInRange = purchases.filter(p => p.status === 'confirmed' && inRange(p.ordered_at))
    const runsSorted = sortedRuns()

    const buildCard = (shopId: string | null, name: string, kind: ShopAccountKind | null): PurchaseAccountCard => {
      const own = shopId ? confirmedInRange.filter(p => p.shop_account_id === shopId) : confirmedInRange
      const items = own.reduce((s, p) => s + p.lines.reduce((ls, l) => ls + l.quantity, 0), 0)
      const total_cost = own.reduce((s, p) => s + p.total_cost, 0)
      const drafts = (shopId
        ? purchases.filter(p => p.status === 'draft' && p.shop_account_id === shopId)
        : purchases.filter(p => p.status === 'draft')
      ).length
      const notArrived = (shopId
        ? purchases.filter(p => p.status === 'confirmed' && p.shop_account_id === shopId)
        : purchases.filter(p => p.status === 'confirmed')
      ).filter(p => p.fulfillment === 'pending' || p.fulfillment === 'shipped').length
      const lastRun = shopId ? runsSorted.find(r => r.shop_account_id === shopId) ?? null : null

      return {
        shop_account_id: shopId,
        name,
        kind,
        orders: own.length,
        items,
        total_cost,
        drafts,
        not_arrived: notArrived,
        auth_required: lastRun?.status === 'auth_required',
      }
    }

    const cards = [buildCard(null, 'すべて', null)]
    for (const shop of shopAccounts) cards.push(buildCard(shop.id, shop.name, shop.kind))
    return wait(cards)
  },

  async listSales(filter) {
    const rows = filterSales(filter)
    rows.sort((a, b) => (a.sold_at < b.sold_at ? 1 : a.sold_at > b.sold_at ? -1 : 0))
    return wait(rows)
  },

  async saleTotals(filter): Promise<SaleTotals> {
    const rows = filterSales(filter)
    const totals = rows.reduce((acc, s) => {
      acc.count += 1
      acc.revenue += s.price
      acc.total_fee += s.fee
      acc.total_shipping += s.shipping_fee
      acc.total_packaging += s.packaging_cost
      acc.total_cost += s.cost
      acc.gross_profit += s.gross_profit
      return acc
    }, { count: 0, revenue: 0, total_fee: 0, total_shipping: 0, total_packaging: 0, total_cost: 0, gross_profit: 0 })
    return wait(totals)
  },

  async createSale(input: SaleInput) {
    const rateBp = Number(settings.fee_rate_bp)
    const price = input.price
    const fee = calcFeeMock(price, rateBp)
    const modelCodes = extractAllCodes(input.title)
    const id = uid()

    const sale: SaleProfit = {
      id,
      mercari_item_id: input.mercari_item_id ?? null,
      thumb_url: null, // 手入力の販売はサムネイルを持たない
      sold_at: input.sold_at,
      purchased_at: null, // 手入力の販売は取引画面を取っていないので分からない
      title: input.title,
      kind: input.kind ?? 'resale',
      price,
      fee,
      shipping_fee: 0,
      packaging_cost: 0,
      is_shipping_confirmed: 0,
      shipping_method_id: null,
      shipping_source: null,
      note: input.note ?? null,
      model_codes: modelCodes,
      cost: 0,
      gross_profit: price - fee,
      item_count: 0,
      unmatched: 1,
      auto_linked: 0,
      source: 'manual',
      tags: [],
      inherited_tags: [],
      status: null,
      shipped_at: null,
      delivered_at: null,
      completed_at: null,
      buyer: null,
    }
    sales.unshift(sale)

    // M-06 相当：型番が1つだけ完全一致すれば自動で在庫を充てる
    if (modelCodes.length === 1) {
      const item = takeOldestByModel(modelCodes[0])
      if (item) {
        item.status = 'sold'
        item.thumb_url = sale.thumb_url
        item.sold_to = { sale_id: sale.id, title: sale.title, price: sale.price, sold_at: sale.sold_at }
        saleLines.set(id, [item.id])
        sale.auto_linked = 1
        recalcSale(sale)
      }
    }
    return wait(id)
  },

  async updateSale(id: string, patch: SalePatch) {
    const sale = findSale(id)
    if (patch.title !== undefined) {
      sale.title = patch.title
      sale.model_codes = extractAllCodes(patch.title)
    }
    if (patch.sold_at !== undefined) sale.sold_at = patch.sold_at
    if (patch.kind !== undefined) sale.kind = patch.kind
    if (patch.packaging_cost !== undefined) sale.packaging_cost = patch.packaging_cost
    if (patch.note !== undefined) sale.note = patch.note
    if (patch.price !== undefined) {
      sale.price = patch.price
      sale.fee = calcFeeMock(patch.price, Number(settings.fee_rate_bp))
    }
    if (patch.shipping_method_id !== undefined) {
      sale.shipping_method_id = patch.shipping_method_id
      if (patch.shipping_method_id) {
        const m = shippingMethods.find(x => x.id === patch.shipping_method_id)
        sale.shipping_fee = patch.shipping_fee ?? m?.fee ?? 0
        sale.is_shipping_confirmed = 1
        sale.shipping_source = 'master'
      } else {
        sale.shipping_fee = 0
        sale.is_shipping_confirmed = 0
        sale.shipping_source = null
      }
    } else if (patch.shipping_fee !== undefined) {
      sale.shipping_fee = patch.shipping_fee
      sale.is_shipping_confirmed = 1
      sale.shipping_source = 'manual'
    }
    recalcSale(sale)
    return wait(undefined)
  },

  async deleteSale(id: string) {
    const sale = sales.find(s => s.id === id)
    const ids = saleLines.get(id) ?? []
    for (const itemId of ids) {
      const item = inventory.find(it => it.id === itemId)
      if (item) {
        item.status = 'in_stock'
        item.thumb_url = null
        item.sold_to = null
      }
    }
    saleLines.delete(id)
    sales = sales.filter(s => s.id !== id)
    // 取り込んだ販売（手入力は再取り込みされないので対象外）は、次の取り込みで復活しないよう記録する
    if (sale && sale.source === 'collector' && sale.mercari_item_id) {
      saleExclusions = [
        { mercari_item_id: sale.mercari_item_id, title: sale.title, excluded_at: todayLocal() },
        ...saleExclusions.filter(e => e.mercari_item_id !== sale.mercari_item_id),
      ]
    }
    return wait(undefined)
  },

  async linkInventory(saleId: string, inventoryItemIds: string[], opts?: { takeFromSale?: boolean }) {
    const sale = findSale(saleId)
    const takeFromSale = opts?.takeFromSale ?? false
    for (const itemId of inventoryItemIds) {
      const item = inventory.find(it => it.id === itemId)
      if (!item) throw new Error('在庫が見つかりません')
      if (item.status === 'sold') {
        if (!takeFromSale) throw new Error('販売済み・廃棄済みの在庫は紐付けられません')
      } else if (item.status !== 'in_stock') {
        throw new Error('販売済み・廃棄済みの在庫は紐付けられません')
      }
    }
    const current = saleLines.get(saleId) ?? []
    for (const itemId of inventoryItemIds) {
      const item = inventory.find(it => it.id === itemId)!
      if (item.status === 'sold') detachFromCurrentSale(item)
      item.status = 'sold'
      item.thumb_url = sale.thumb_url
      item.sold_to = { sale_id: sale.id, title: sale.title, price: sale.price, sold_at: sale.sold_at }
    }
    saleLines.set(saleId, [...current, ...inventoryItemIds])
    sale.auto_linked = 0 // 人が確定した紐付けなので「自動」チップは外す
    recalcSale(sale)
    return wait(undefined)
  },

  async autoLinkPending(): Promise<number> {
    let confirmed = 0
    for (const sale of sales) {
      if (sale.kind !== 'resale' || sale.unmatched !== 1) continue
      if (sale.model_codes.length !== 1) continue
      const item = takeOldestByModel(sale.model_codes[0])
      if (!item) continue
      item.status = 'sold'
      item.thumb_url = sale.thumb_url
      item.sold_to = { sale_id: sale.id, title: sale.title, price: sale.price, sold_at: sale.sold_at }
      saleLines.set(sale.id, [item.id])
      sale.auto_linked = 1
      recalcSale(sale)
      confirmed++
    }
    return wait(confirmed)
  },

  async unlinkInventory(saleId: string, inventoryItemId: string) {
    const sale = findSale(saleId)
    const current = saleLines.get(saleId) ?? []
    saleLines.set(saleId, current.filter(id => id !== inventoryItemId))
    const item = inventory.find(it => it.id === inventoryItemId)
    if (item) {
      item.status = 'in_stock'
      item.thumb_url = null
      item.sold_to = null
    }
    sale.auto_linked = 0
    recalcSale(sale)
    return wait(undefined)
  },

  async suggestInventory(saleId: string, limit = 20, opts?: { includeSold?: boolean }) {
    const sale = findSale(saleId)
    const target = normalizeName(sale.title)
    const items = inventory.filter(i => i.status === 'in_stock')
    const ranked = items
      .map(item => ({ item, score: commonCharCount(target, normalizeName(item.name)) }))
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.item.aging_days - a.item.aging_days))
      .slice(0, limit)
      .map(({ item }) => item)
    if (!opts?.includeSold) return wait(ranked)
    // 販売済み（他の販売に紐付いた）在庫も末尾に足す。この販売自身が紐付けたものは除く
    const soldItems = inventory.filter(i => i.status === 'sold' && i.sold_to?.sale_id !== saleId)
    return wait([...ranked, ...soldItems])
  },

  async listSaleLines(saleId: string) {
    const ids = saleLines.get(saleId) ?? []
    const items = ids.map(id => inventory.find(it => it.id === id)).filter((it): it is InventoryItem => !!it)
    return wait(items)
  },

  async listPurchases() {
    const rows = purchases.slice().sort((a, b) => (a.ordered_at < b.ordered_at ? 1 : -1))
    return wait(rows)
  },

  async getPurchase(id: string) {
    return wait(hydratePurchase(findPurchase(id)))
  },

  async createPurchase(input: PurchaseInput) {
    const purchaseId = uid()
    const shippingFee = input.shipping_fee ?? 0
    const discount = input.discount ?? 0
    const otherCost = input.other_cost ?? 0
    const method = input.alloc_method ?? 'by_amount'
    const pool = shippingFee + otherCost - discount

    const shop = shopAccounts.find(s => s.id === input.shop_account_id)
    const bases = input.lines.map(l => (method === 'by_amount' ? l.unit_price * l.quantity : l.quantity))
    const shares = allocateAmount(bases, pool)

    const lines: PurchaseLine[] = []
    let subtotal = 0
    let totalCost = 0

    input.lines.forEach((l, li) => {
      const extracted = extractModelCode(l.name)
      const model_code = l.model_code ?? extracted.model_code
      const series_code = l.series_code ?? extracted.series_code
      const material = l.material ?? extractMaterial(l.name)

      subtotal += l.unit_price * l.quantity
      totalCost += l.unit_price * l.quantity + shares[li]
      const parts = splitEvenly(shares[li], l.quantity)
      const lineId = uid()
      const itemIds: string[] = []

      lines.push({
        id: lineId,
        name: l.name,
        unit_price: l.unit_price,
        quantity: l.quantity,
        model_code, series_code, material,
        allocated_cost: shares[li],
        landed_unit_cost: l.unit_price + Math.floor(shares[li] / l.quantity),
        items: [],
      })

      for (let n = 0; n < l.quantity; n++) {
        const itemId = uid()
        inventory.push({
          id: itemId,
          item_code: nextItemCode(),
          name: l.name,
          landed_cost: l.unit_price + parts[n],
          acquired_at: input.ordered_at,
          status: 'in_stock',
          aging_days: diffDays(input.ordered_at),
          order_no: input.order_no ?? null,
          shop_account_name: shop?.name ?? null,
          model_code, series_code, material,
          product_name: model_code ? productCustomName.get(model_code) ?? null : null,
          parent_id: null,
          note: null,
          tags: [],
          inherited_tags: [...(shop?.auto_tags ?? [])], // 仕入先の自動タグをそのまま引き継ぐ
          fulfillment: null,
          thumb_url: null,
          listing: null,
          sold_to: null,
        })
        itemPurchaseId.set(itemId, purchaseId)
        itemIds.push(itemId)
      }
      lineItemIds.set(lineId, itemIds)
    })

    purchases.push({
      id: purchaseId,
      status: 'confirmed',
      ordered_at: input.ordered_at,
      order_no: input.order_no ?? null,
      shop_account_id: input.shop_account_id,
      shop_account_name: shop?.name ?? '',
      shipping_fee: shippingFee,
      discount,
      note: input.note ?? null,
      import_key: input.import_key ?? null,
      fulfillment: input.fulfillment ?? null,
      ...fulfillmentDates(input.ordered_at, input.fulfillment ?? null),
      line_count: lines.length,
      first_line_name: lines[0]?.name ?? null,
      first_model_code: lines[0]?.model_code ?? null,
      subtotal,
      total_cost: totalCost,
      other_cost: otherCost,
      alloc_method: method,
      lines,
      // 仕入先の自動タグ（作成時に確定。後から仕入先の設定を変えても遡って付け直さない）
      tags: [...(shop?.auto_tags ?? [])],
    })

    return wait(purchaseId)
  },

  // CSV の一括登録：1件ずつ createPurchase と同じ検証（仕入先+注文番号の重複）で登録し、
  // 失敗した行は理由を付けて返す（全体を止めない）。同じCSVの中の重複もここで見る
  async importPurchases(inputs: PurchaseInput[]) {
    const skipped: PurchaseImportResult['skipped'] = []
    const seenInBatch = new Set<string>()
    let created = 0

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]
      const orderNo = input.order_no ?? null
      if (orderNo) {
        const key = `${input.shop_account_id}|${orderNo}`
        const existsAlready = purchases.some(p => p.shop_account_id === input.shop_account_id && p.order_no === orderNo)
        if (existsAlready || seenInBatch.has(key)) {
          skipped.push({ index: i, reason: `この仕入先には注文番号「${orderNo}」の仕入が既にあります` })
          continue
        }
        seenInBatch.add(key)
      }
      await api.createPurchase(input)
      created += 1
    }

    return wait({ created, skipped })
  },

  async confirmPurchase(id: string, input: PurchaseInput) {
    const p = findPurchase(id)
    if (p.status !== 'draft') throw new Error('この仕入はすでに確定しています')

    const shippingFee = input.shipping_fee ?? 0
    const discount = input.discount ?? 0
    const otherCost = input.other_cost ?? 0
    const method = input.alloc_method ?? 'by_amount'
    const pool = shippingFee + otherCost - discount
    const shop = shopAccounts.find(s => s.id === input.shop_account_id)

    const bases = input.lines.map(l => (method === 'by_amount' ? l.unit_price * l.quantity : l.quantity))
    const shares = allocateAmount(bases, pool)

    const lines: PurchaseLine[] = []
    let subtotal = 0
    let totalCost = 0

    input.lines.forEach((l, li) => {
      const extracted = extractModelCode(l.name)
      const model_code = l.model_code ?? extracted.model_code
      const series_code = l.series_code ?? extracted.series_code
      const material = l.material ?? extractMaterial(l.name)

      subtotal += l.unit_price * l.quantity
      totalCost += l.unit_price * l.quantity + shares[li]
      const parts = splitEvenly(shares[li], l.quantity)
      const lineId = uid()
      const itemIds: string[] = []

      lines.push({
        id: lineId,
        name: l.name,
        unit_price: l.unit_price,
        quantity: l.quantity,
        model_code, series_code, material,
        allocated_cost: shares[li],
        landed_unit_cost: l.unit_price + Math.floor(shares[li] / l.quantity),
        items: [],
      })

      for (let n = 0; n < l.quantity; n++) {
        const itemId = uid()
        inventory.push({
          id: itemId,
          item_code: nextItemCode(),
          name: l.name,
          landed_cost: l.unit_price + parts[n],
          acquired_at: input.ordered_at,
          status: 'in_stock',
          aging_days: diffDays(input.ordered_at),
          order_no: input.order_no ?? p.order_no,
          shop_account_name: shop?.name ?? p.shop_account_name,
          model_code, series_code, material,
          product_name: model_code ? productCustomName.get(model_code) ?? null : null,
          parent_id: null,
          note: null,
          tags: [],
          inherited_tags: [...p.tags], // 確定前に仕入へ付けたタグをそのまま引き継ぐ
          fulfillment: null,
          thumb_url: null,
          listing: null,
          sold_to: null,
        })
        itemPurchaseId.set(itemId, p.id)
        itemIds.push(itemId)
      }
      lineItemIds.set(lineId, itemIds)
    })

    p.status = 'confirmed'
    p.ordered_at = input.ordered_at
    p.order_no = input.order_no ?? p.order_no
    p.shop_account_id = input.shop_account_id
    p.shop_account_name = shop?.name ?? p.shop_account_name
    p.shipping_fee = shippingFee
    p.discount = discount
    p.import_key = input.import_key ?? p.import_key
    p.fulfillment = input.fulfillment ?? p.fulfillment
    Object.assign(p, fulfillmentDates(p.ordered_at, p.fulfillment))
    p.other_cost = otherCost
    p.alloc_method = method
    p.note = input.note ?? p.note
    p.line_count = lines.length
    p.first_line_name = lines[0]?.name ?? null
    p.first_model_code = lines[0]?.model_code ?? null
    p.subtotal = subtotal
    p.total_cost = totalCost
    p.lines = lines

    return wait(undefined)
  },

  async updatePurchaseNote(id: string, note: string | null) {
    findPurchase(id).note = note
    return wait(undefined)
  },

  async updatePurchaseFulfillment(id: string, fulfillment: Fulfillment | null) {
    const p = findPurchase(id)
    p.fulfillment = fulfillment
    Object.assign(p, fulfillmentDates(p.ordered_at, fulfillment))
    for (const it of inventory) {
      if (itemPurchaseId.get(it.id) === id) it.fulfillment = fulfillment
    }
    return wait(undefined)
  },

  async deletePurchase(id: string) {
    const soldCount = inventory.filter(it => itemPurchaseId.get(it.id) === id && it.status === 'sold').length
    if (soldCount > 0) {
      throw new Error(`この仕入には販売済みの在庫が${soldCount}点あります。先に紐付けを解除してください`)
    }
    inventory = inventory.filter(it => itemPurchaseId.get(it.id) !== id)
    purchases = purchases.filter(p => p.id !== id)
    return wait(undefined)
  },

  async listInventory(status: InventoryStatus = 'in_stock') {
    const rows = inventory.filter(i => i.status === status).sort((a, b) => b.aging_days - a.aging_days)
    return wait(rows)
  },

  async updateInventory(id: string, patch: InventoryPatch) {
    const item = inventory.find(i => i.id === id)
    if (!item) throw new Error('在庫が見つかりません')
    if (patch.name !== undefined) item.name = patch.name
    if (patch.model_code !== undefined) item.model_code = patch.model_code
    if (patch.series_code !== undefined) item.series_code = patch.series_code
    if (patch.material !== undefined) item.material = patch.material
    if (patch.note !== undefined) item.note = patch.note
    return wait(undefined)
  },

  async splitInventory(id: string, count: number) {
    const item = inventory.find(i => i.id === id)
    if (!item) throw new Error('在庫が見つかりません')
    if (item.status !== 'in_stock') throw new Error('在庫にある商品だけ分割できます')
    if (count < 2) throw new Error('分割数は2以上にしてください')

    const parts = splitEvenly(item.landed_cost, count) // 端数は最後の子へ
    const childIds: string[] = []
    const purchaseId = itemPurchaseId.get(item.id)
    const purchase = purchaseId ? purchases.find(p => p.id === purchaseId) : undefined

    for (let n = 0; n < count; n++) {
      const childId = uid()
      inventory.push({
        id: childId,
        item_code: nextItemCode(),
        name: `${item.name}（分割 ${n + 1}/${count}）`,
        landed_cost: parts[n],
        acquired_at: item.acquired_at,
        status: 'in_stock',
        aging_days: item.aging_days,
        order_no: item.order_no,
        shop_account_name: item.shop_account_name,
        model_code: item.model_code,
        product_name: item.product_name,
        series_code: item.series_code,
        material: item.material,
        parent_id: item.id,
        note: null,
        tags: [],
        inherited_tags: purchase ? [...purchase.tags] : [], // 分割元と同じ仕入のタグを引き継ぐ
        fulfillment: item.fulfillment,
        thumb_url: null,
        listing: null,
        sold_to: null,
      })
      childIds.push(childId)
      if (purchaseId) itemPurchaseId.set(childId, purchaseId)
    }
    item.status = 'split' // 過去の原価は動かさない。親はそのまま残す
    itemSplitAt.set(item.id, todayLocal())
    return wait(childIds)
  },

  async mergeSplitInventory(parentId: string) {
    const parent = inventory.find(i => i.id === parentId)
    if (!parent) throw new Error('在庫が見つかりません')
    const children = inventory.filter(i => i.parent_id === parentId)
    if (!children.length) throw new Error('分割した在庫が見つかりません')
    const blocked = children.find(c => c.status !== 'in_stock' || c.listing)
    if (blocked) {
      const reason = blocked.listing
        ? '出品に引き当てています'
        : blocked.status === 'sold' ? '販売済みです'
        : blocked.status === 'disposed' ? '廃棄済みです'
        : blocked.status === 'personal_use' ? '自家消費済みです'
        : '分割し直されています'
      throw new Error(`${blocked.item_code} が${reason}`)
    }
    for (const c of children) {
      const idx = inventory.indexOf(c)
      if (idx >= 0) inventory.splice(idx, 1)
    }
    parent.status = 'in_stock'
    itemSplitAt.delete(parent.id)
    return wait(undefined)
  },

  async disposeInventory(id: string, _note: string, status: 'disposed' | 'personal_use' = 'disposed') {
    const item = inventory.find(i => i.id === id)
    if (!item) throw new Error('在庫が見つかりません')
    if (item.status !== 'in_stock') throw new Error('販売済みの在庫は外せません')
    item.status = status
    itemDisposedAt.set(item.id, todayLocal())
    return wait(undefined)
  },

  async listMonthly() {
    const rows = withExpenses([...monthlyFromSales(sales), ...extraOlderMonths()])
    rows.sort((a, b) => (a.month !== b.month ? (a.month < b.month ? 1 : -1) : a.kind.localeCompare(b.kind)))
    return wait(rows)
  },

  async listExpenses(month?: string) {
    let rows = expenses.slice()
    if (month) rows = rows.filter(e => e.month === month)
    rows.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0))
    return wait(rows)
  },

  async createExpense(input: ExpenseInput) {
    const id = uid()
    const lines = buildExpenseLines(input.lines)
    const amount = lines.length ? lines.reduce((s, l) => s + l.amount, 0) : Math.round(input.amount ?? 0)
    const category = lines.length ? lines[0].category : input.category
    expenses.push({
      id,
      occurred_at: input.occurred_at,
      month: input.month ?? input.occurred_at.slice(0, 7),
      shop: input.shop?.trim() || null,
      category,
      amount,
      note: input.note?.trim() || null,
      auto: 0,
      receipt_url: input.receipt_temp_file ? '/mock/receipt.svg' : null,
      lines,
    })
    return wait(id)
  },

  async updateExpense(id: string, input: ExpenseInput) {
    const e = expenses.find(x => x.id === id)
    if (!e) throw new Error('経費が見つかりません')
    const lines = buildExpenseLines(input.lines)
    const amount = lines.length ? lines.reduce((s, l) => s + l.amount, 0) : Math.round(input.amount ?? e.amount)
    const category = lines.length ? lines[0].category : input.category
    e.occurred_at = input.occurred_at
    e.month = input.month ?? input.occurred_at.slice(0, 7)
    e.shop = input.shop?.trim() || null
    e.category = category
    e.amount = amount
    e.note = input.note?.trim() || null
    e.lines = lines
    if (input.receipt_temp_file) e.receipt_url = '/mock/receipt.svg'
    return wait(undefined)
  },

  async deleteExpense(id: string) {
    // auto=1 でも消してよい
    expenses = expenses.filter(e => e.id !== id)
    return wait(undefined)
  },

  async attachReceipt(id: string) {
    const e = expenses.find(x => x.id === id)
    if (!e) throw new Error('経費が見つかりません')
    // 本物はファイル選択でコピーする。モックは固定のサンプル画像を返す
    e.receipt_url = '/mock/receipt.svg'
    return wait(e.receipt_url)
  },

  async removeReceipt(id: string) {
    const e = expenses.find(x => x.id === id)
    if (e) e.receipt_url = null
    return wait(undefined)
  },

  async readReceiptImage() {
    if (!aiKeyConfigured) throw new Error('AI 読み取りの設定がありません（設定 → AI 読み取り）')
    const result: ReceiptRead = {
      temp_file: `receipt-draft-${uid()}.jpg`,
      receipt_url: '/mock/receipt.svg',
      draft: MOCK_RECEIPT_DRAFT,
    }
    return waitReceipt(result)
  },

  async readReceipt(id: string) {
    if (!aiKeyConfigured) throw new Error('AI 読み取りの設定がありません（設定 → AI 読み取り）')
    const e = expenses.find(x => x.id === id)
    if (!e || !e.receipt_url) throw new Error('レシートが添付されていません')
    return waitReceipt(MOCK_RECEIPT_DRAFT)
  },

  async getAiStatus(): Promise<AiStatus> {
    return wait({ configured: aiKeyConfigured, model: aiModelSetting, safe_storage: AI_SAFE_STORAGE })
  },

  async setGeminiApiKey(key: string | null) {
    aiKeyConfigured = !!key
    return wait(undefined)
  },

  async setAiModel(model: string) {
    aiModelSetting = model
    return wait(undefined)
  },

  async testGemini() {
    return waitAi({ ok: true, message: '接続できました' })
  },

  async listGeminiModels() {
    if (!aiKeyConfigured) throw new Error('AI 読み取りの設定がありません（設定 → AI 読み取り）')
    return waitAi([
      { name: 'gemini-flash-latest', display_name: 'Gemini Flash（最新）', description: '速い。無料枠が多い' },
      { name: 'gemini-pro-latest', display_name: 'Gemini Pro（最新）', description: '精度重視。無料枠は少なめ' },
      { name: 'gemini-2.5-flash', display_name: 'Gemini 2.5 Flash', description: '固定バージョンの Flash' },
    ])
  },

  async getMonthDetail(month: string, opts?: { tagId?: string | null }) {
    return wait(buildMonthDetail(month, opts?.tagId ?? null))
  },

  async setMonthAllocMethod(month: string, method: AllocMethod) {
    monthBookEntry(month).alloc_method = method
    return wait(undefined)
  },

  async closeMonth(month: string) {
    if (month >= thisMonthLocal()) throw new Error('終わった月だけ締められます')
    const detail = buildMonthDetail(month, null)
    const close: MonthClose = {
      month,
      closed_at: todayLocal(),
      alloc_method: detail.alloc_method,
      sales_count: detail.totals.sales_count,
      revenue: detail.totals.revenue,
      gross_profit: detail.totals.gross_profit,
      expense_total: detail.totals.expense_total,
      net_profit: detail.totals.net_profit,
    }
    monthBookEntry(month).close = close
    return wait(close)
  },

  async reopenMonth(month: string) {
    monthBookEntry(month).close = null
    return wait(undefined)
  },

  async listTags() {
    return wait(tags.slice().sort((a, b) => a.sort_order - b.sort_order))
  },

  async createTag(name: string) {
    if (tags.some(t => t.name === name)) throw new Error('同じ名前のタグがあります')
    const id = uid()
    tags.push({ id, name, sort_order: tags.length + 1 })
    return wait(id)
  },

  async renameTag(id: string, name: string) {
    const t = tags.find(x => x.id === id)
    if (!t) throw new Error('タグが見つかりません')
    if (tags.some(x => x.id !== id && x.name === name)) throw new Error('同じ名前のタグがあります')
    t.name = name
    // 付いている先の表示名（コピー）も揃える
    for (const s of sales) { const ref = s.tags.find(x => x.id === id); if (ref) ref.name = name }
    for (const it of inventory) { const ref = it.tags.find(x => x.id === id); if (ref) ref.name = name }
    return wait(undefined)
  },

  async deleteTag(id: string) {
    tags = tags.filter(t => t.id !== id)
    for (const s of sales) {
      s.tags = s.tags.filter(t => t.id !== id)
      s.inherited_tags = s.inherited_tags.filter(t => t.id !== id)
    }
    for (const it of inventory) {
      it.tags = it.tags.filter(t => t.id !== id)
      it.inherited_tags = it.inherited_tags.filter(t => t.id !== id)
    }
    for (const p of purchases) p.tags = p.tags.filter(t => t.id !== id)
    for (const [model, ts] of productTags) productTags.set(model, ts.filter(t => t.id !== id))
    for (const a of shopAccounts) a.auto_tags = a.auto_tags.filter(t => t.id !== id)
    return wait(undefined)
  },

  async setSaleTags(saleId: string, tagIds: string[]) {
    const sale = findSale(saleId)
    sale.tags = tagIds.map(id => tags.find(t => t.id === id)).filter((t): t is Tag => !!t)
    recalcSaleInheritedTags(sale)
    return wait(undefined)
  },

  async setInventoryTags(inventoryItemId: string, tagIds: string[]) {
    const item = inventory.find(i => i.id === inventoryItemId)
    if (!item) throw new Error('在庫が見つかりません')
    item.tags = tagIds.map(id => tags.find(t => t.id === id)).filter((t): t is Tag => !!t)
    recalcItemInheritedTags(item)
    const sale = saleForItem(item.id)
    if (sale) recalcSaleInheritedTags(sale)
    return wait(undefined)
  },

  /** 仕入に直接付いたタグを置き換える。この仕入から生まれた在庫の inherited_tags、
   *  さらにその在庫が紐付いた販売の inherited_tags も連動して作り直す */
  async setPurchaseTags(purchaseId: string, tagIds: string[]) {
    const p = findPurchase(purchaseId)
    p.tags = tagIds.map(id => tags.find(t => t.id === id)).filter((t): t is Tag => !!t)
    for (const it of inventory) {
      if (itemPurchaseId.get(it.id) !== purchaseId) continue
      recalcItemInheritedTags(it)
      const sale = saleForItem(it.id)
      if (sale) recalcSaleInheritedTags(sale)
    }
    return wait(undefined)
  },

  /** 商品（型番）に直接付いたタグを置き換える。その型番の在庫の inherited_tags、
   *  さらにその在庫が紐付いた販売の inherited_tags も連動して作り直す */
  async setProductTags(modelCode: string, tagIds: string[]) {
    productTags.set(modelCode, tagIds.map(id => tags.find(t => t.id === id)).filter((t): t is Tag => !!t))
    for (const it of inventory) {
      if (it.model_code !== modelCode) continue
      recalcItemInheritedTags(it)
      const sale = saleForItem(it.id)
      if (sale) recalcSaleInheritedTags(sale)
    }
    return wait(undefined)
  },

  /** 型番の表示名を付ける／外す（null）。仕入明細・在庫の元の名前は変えない */
  async setProductName(modelCode: string, name: string | null) {
    if (name) productCustomName.set(modelCode, name)
    else productCustomName.delete(modelCode)
    return wait(undefined)
  },

  /**
   * 商品画像を人がセットする（本物はファイル選択ダイアログを main が開く）。
   * ブラウザのモックではダイアログを開けないので、いまの自動判定の画像をそのまま固定する
   */
  async setProductImage(modelCode: string) {
    productManualImage.set(modelCode, autoProductThumb(modelCode))
    return wait(true)
  },

  /** auto=true：人がセットした画像を捨てて自動に戻す。auto=false：今の自動画像を固定する */
  async setProductImageAuto(modelCode: string, auto: boolean) {
    if (auto) productManualImage.delete(modelCode)
    else productManualImage.set(modelCode, autoProductThumb(modelCode))
    return wait(undefined)
  },

  /** 取引画面を1ページだけ開いて購入日時を取り直す（メンテ用）のモック */
  async refetchSaleDates(saleId: string) {
    const sale = findSale(saleId)
    sale.purchased_at = '2026-09-10T21:34'
    return wait({ purchased_at: sale.purchased_at })
  },

  /**
   * メロジョイの注文詳細を1ページだけ開き直して、明細の商品画像を取り込む（メンテ用）のモック。
   * まだ画像を持っていない明細（在庫が生成済みのもの）に最大2件だけ入れる
   */
  async refetchPurchaseImages(purchaseId: string) {
    const p = purchases.find(x => x.id === purchaseId)
    if (!p) throw new Error('仕入が見つかりません')
    let saved = 0
    for (const l of p.lines) {
      if (saved >= 2) break
      if (lineImageUrl.has(l.id)) continue
      if ((lineItemIds.get(l.id) ?? []).length === 0) continue // 下書きなど在庫が無い明細は対象外
      lineImageUrl.set(l.id, `soroban-thumb://mj-${l.id.slice(0, 6)}.jpg`)
      saved++
    }
    return wait({ saved })
  },

  /** 仕入先ごとの累計（確定した仕入のみ）。注文数・点数（明細の数量合計）・支払合計・最終注文日 */
  async listShopAccountStats(): Promise<ShopAccountStats[]> {
    const confirmed = purchases.filter(p => p.status === 'confirmed')
    const rows = shopAccounts.map(a => {
      const own = confirmed.filter(p => p.shop_account_id === a.id)
      const items = own.reduce((s, p) => s + p.lines.reduce((ls, l) => ls + l.quantity, 0), 0)
      const total_cost = own.reduce((s, p) => s + p.total_cost, 0)
      const last_ordered_at = own.reduce<string | null>(
        (max, p) => (!max || p.ordered_at > max ? p.ordered_at : max), null,
      )
      return { shop_account_id: a.id, orders: own.length, items, total_cost, last_ordered_at }
    })
    return wait(rows)
  },

  async listVariantSummary(sort = 'total_profit') {
    const rows = allModelCodes().map(variantSummaryFor)
    rows.sort((a, b) => (b[sort] ?? 0) - (a[sort] ?? 0))
    return wait(rows)
  },

  async listProducts(sort = 'total_profit') {
    const rows = allModelCodes().map(buildProductSummary)
    rows.sort((a, b) => {
      if (sort === 'last_purchased_at') return (b.last_purchased_at ?? '').localeCompare(a.last_purchased_at ?? '')
      return (b[sort] ?? 0) - (a[sort] ?? 0)
    })
    return wait(rows)
  },

  async getProduct(modelCode: string) {
    if (!allModelCodes().includes(modelCode)) return wait(null)
    const summary = buildProductSummary(modelCode)
    const items = inventory
      .filter(i => i.model_code === modelCode)
      .slice()
      .sort((a, b) => (a.acquired_at < b.acquired_at ? 1 : a.acquired_at > b.acquired_at ? -1 : 0))
    const modelSales = linkedSalesForModel(modelCode)
      .slice()
      .sort((a, b) => (a.sold_at < b.sold_at ? 1 : a.sold_at > b.sold_at ? -1 : 0))
    const detail: ProductDetail = {
      ...summary,
      months: buildProductMonths(modelCode),
      items,
      sales: modelSales,
    }
    return wait(detail)
  },

  async getItemTimeline(inventoryItemId: string) {
    const item = inventory.find(i => i.id === inventoryItemId)
    if (!item) return wait(null)
    return wait(buildItemTimeline(item))
  },

  async listListings(filter) {
    const statuses = filter?.status ?? ['active', 'suspended']
    let rows = listingRecords.filter(r => statuses.includes(r.status)).map(buildListing)
    if (filter?.onlyUnallocated) rows = rows.filter(r => r.items.length === 0)
    rows.sort((a, b) => (a.first_seen_at < b.first_seen_at ? 1 : a.first_seen_at > b.first_seen_at ? -1 : 0))
    return wait(rows)
  },

  async reserveInventory(mercariItemId: string, inventoryItemIds: string[], opts?: { takeFromSale?: boolean }) {
    const rec = listingRecords.find(r => r.mercari_item_id === mercariItemId)
    if (!rec) throw new Error('出品が見つかりません')
    if (rec.status !== 'active' && rec.status !== 'suspended') {
      throw new Error('この出品は終了しているため引き当てできません')
    }
    const takeFromSale = opts?.takeFromSale ?? false
    for (const id of inventoryItemIds) {
      const item = inventory.find(i => i.id === id)
      if (!item) throw new Error('在庫が見つかりません')
      if (item.status === 'sold') {
        if (!takeFromSale) throw new Error('販売済み・廃棄済みの在庫は紐付けられません')
      } else if (item.status !== 'in_stock') {
        throw new Error('販売済み・廃棄済みの在庫は紐付けられません')
      }
    }
    for (const id of inventoryItemIds) {
      const item = inventory.find(i => i.id === id)!
      if (item.status === 'sold') {
        // 販売から外して在庫に戻し、こちらの出品へ引き当てる
        detachFromCurrentSale(item)
        item.status = 'in_stock'
        item.thumb_url = null
        item.sold_to = null
      }
      // 他の出品に引き当て済みなら、そちらの引き当てを外してこちらへ移す
      if (item.listing && item.listing.mercari_item_id !== mercariItemId) {
        const fromId = item.listing.mercari_item_id
        listingItems.set(fromId, (listingItems.get(fromId) ?? []).filter(x => x !== id))
      }
      item.listing = { mercari_item_id: mercariItemId, price: rec.price, status: rec.status }
    }
    const current = listingItems.get(mercariItemId) ?? []
    listingItems.set(mercariItemId, [...new Set([...current, ...inventoryItemIds])])
    return wait(undefined)
  },

  async unreserveInventory(mercariItemId: string, inventoryItemId: string) {
    const current = listingItems.get(mercariItemId) ?? []
    listingItems.set(mercariItemId, current.filter(id => id !== inventoryItemId))
    const item = inventory.find(i => i.id === inventoryItemId)
    if (item) item.listing = null
    return wait(undefined)
  },

  async suggestForListing(mercariItemId: string, limit = 20, opts?: { includeSold?: boolean }) {
    const rec = listingRecords.find(r => r.mercari_item_id === mercariItemId)
    if (!rec) return wait([])
    const already = new Set(listingItems.get(mercariItemId) ?? [])
    const modelSet = new Set(rec.model_codes)
    const seriesSet = new Set(rec.model_codes.map(mc => mc.split('-')[0]))
    const target = normalizeName(rec.title)
    // 他の出品に引き当て済みの在庫も候補に含める（画面側で「出品Xから移す」と見せる）。
    // この出品自身に引き当て済みのものだけ除く
    const items = inventory.filter(i => i.status === 'in_stock' && !already.has(i.id))
    const ranked = items
      .map(item => {
        let score = 0
        if (item.model_code && modelSet.has(item.model_code)) score = 3
        else if (item.series_code && seriesSet.has(item.series_code)) score = 2
        else if (commonCharCount(target, normalizeName(item.name)) > 0) score = 1
        return { item, score }
      })
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.item.aging_days - a.item.aging_days))
      .slice(0, limit)
      .map(({ item }) => item)
    if (!opts?.includeSold) return wait(ranked)
    // 販売済み（他の販売に紐付いた）在庫も末尾に足す
    const soldItems = inventory.filter(i => i.status === 'sold' && !already.has(i.id))
    return wait([...ranked, ...soldItems])
  },

  async endListing(mercariItemId: string) {
    const rec = listingRecords.find(r => r.mercari_item_id === mercariItemId)
    if (!rec) throw new Error('出品が見つかりません')
    const ids = listingItems.get(mercariItemId) ?? []
    listingItems.set(mercariItemId, [])
    rec.status = 'ended'
    for (const id of ids) {
      const item = inventory.find(i => i.id === id)
      if (item) item.listing = null
    }
    return wait(undefined)
  },

  async autoReserveListings(): Promise<number> {
    let confirmed = 0
    for (const rec of listingRecords) {
      if (rec.status !== 'active' && rec.status !== 'suspended') continue
      if ((listingItems.get(rec.mercari_item_id) ?? []).length > 0) continue
      if (rec.model_codes.length !== 1) continue
      const model = rec.model_codes[0]
      if (!model.includes('-')) continue // 枝番ありのものだけ（M-09 と同じ規則）
      const item = takeOldestByModel(model)
      if (!item) continue
      listingItems.set(rec.mercari_item_id, [item.id])
      item.listing = { mercari_item_id: rec.mercari_item_id, price: rec.price, status: rec.status }
      confirmed++
    }
    return wait(confirmed)
  },

  async setListingShipping(mercariItemId: string, shippingMethodId: string | null) {
    const rec = listingRecords.find(r => r.mercari_item_id === mercariItemId)
    if (!rec) throw new Error('出品が見つかりません')
    rec.shipping_method_id = shippingMethodId
    return wait(undefined)
  },

  async searchAll(query: string, limit = 60): Promise<SearchHit[]> {
    const inventoryHits: SearchHit[] = inventory
      .filter(i => matchesSearch([i.name, i.model_code, i.series_code, i.note, i.order_no, i.shop_account_name], query))
      .sort((a, b) => (a.acquired_at < b.acquired_at ? 1 : -1))
      .map(i => ({
        kind: 'inventory' as const,
        id: i.id,
        title: i.name,
        model_code: i.model_code,
        status_label: inventorySearchStatusLabel(i),
        amount: i.landed_cost,
        date: i.acquired_at,
        thumb_url: i.thumb_url,
      }))

    const listingHits: SearchHit[] = listingRecords
      .filter(r => matchesSearch([r.title, ...r.model_codes], query))
      .sort((a, b) => (a.first_seen_at < b.first_seen_at ? 1 : -1))
      .map(r => ({
        kind: 'listing' as const,
        id: r.mercari_item_id,
        title: r.title,
        model_code: r.model_codes[0] ?? null,
        status_label: LISTING_STATUS_LABEL[r.status],
        amount: r.price,
        date: r.first_seen_at,
        thumb_url: r.thumb_url,
      }))

    const saleHits: SearchHit[] = sales
      .filter(s => matchesSearch([s.title, s.note, s.buyer, ...s.model_codes], query))
      .sort((a, b) => (a.sold_at < b.sold_at ? 1 : -1))
      .map(s => ({
        kind: 'sale' as const,
        id: s.id,
        title: s.title,
        model_code: s.model_codes[0] ?? null,
        status_label: saleSearchStatusLabel(s),
        amount: s.price,
        date: s.sold_at,
        thumb_url: s.thumb_url,
      }))

    const purchaseHits: SearchHit[] = purchases
      .filter(p => matchesSearch([p.first_line_name, p.order_no, p.note, p.shop_account_name, p.first_model_code], query))
      .sort((a, b) => (a.ordered_at < b.ordered_at ? 1 : -1))
      .map(p => ({
        kind: 'purchase' as const,
        id: p.id,
        title: p.first_line_name ?? p.order_no ?? '仕入',
        model_code: p.first_model_code,
        status_label: p.status === 'draft' ? '下書き' : '確定',
        amount: p.total_cost,
        date: p.ordered_at,
        thumb_url: null,
      }))

    const all = [...inventoryHits, ...listingHits, ...saleHits, ...purchaseHits]
    return wait(all.slice(0, limit))
  },

  async listShopAccounts() {
    return wait(shopAccounts.slice())
  },

  async createShopAccount(name: string, kind: ShopAccountKind = 'other') {
    const id = uid()
    shopAccounts.push({ id, name, kind, note: null, is_active: 1, import_keywords: null, auto_tags: [], default_shipping_fee: null })
    return wait(id)
  },

  async updateShopAccount(id: string, patch: { name?: string; kind?: ShopAccountKind; is_active?: number; import_keywords?: string | null; auto_tag_ids?: string[]; default_shipping_fee?: number | null }) {
    const account = shopAccounts.find(s => s.id === id)
    if (!account) throw new Error('仕入先が見つかりません')
    if (patch.name !== undefined) account.name = patch.name
    if (patch.kind !== undefined) account.kind = patch.kind
    if (patch.is_active !== undefined) account.is_active = patch.is_active
    if (patch.import_keywords !== undefined) {
      account.import_keywords = patch.import_keywords?.trim() ? patch.import_keywords : null
    }
    if (patch.auto_tag_ids !== undefined) {
      // 既存の仕入・在庫・販売には遡って付け直さない（次にこの仕入先で作る仕入から効く）
      account.auto_tags = patch.auto_tag_ids.map(tid => tags.find(t => t.id === tid)).filter((t): t is Tag => !!t)
    }
    if (patch.default_shipping_fee !== undefined) {
      const fee = patch.default_shipping_fee
      if (fee !== null && (!Number.isInteger(fee) || fee < 0)) {
        throw new Error('送料は 0 以上の整数で')
      }
      account.default_shipping_fee = fee
    }
    return wait(undefined)
  },

  async deleteShopAccount(id: string) {
    const used = purchases.some(p => p.shop_account_id === id)
    if (used) {
      throw new Error('この仕入先は仕入で使われています。無効にしてください')
    }
    shopAccounts.splice(0, shopAccounts.length, ...shopAccounts.filter(s => s.id !== id))
    return wait(undefined)
  },

  async listShippingMethods() {
    return wait(shippingMethods.slice().sort((a, b) => a.sort_order - b.sort_order))
  },

  async saveShippingMethod(m) {
    if (m.id) {
      const existing = shippingMethods.find(x => x.id === m.id)
      if (existing) {
        existing.name = m.name
        existing.fee = m.fee
        existing.carrier = m.carrier ?? existing.carrier
        existing.sort_order = m.sort_order ?? existing.sort_order
        existing.is_active = m.is_active ?? existing.is_active
        return wait(undefined)
      }
    }
    shippingMethods.push({
      id: m.id ?? uid(),
      name: m.name,
      fee: m.fee,
      carrier: m.carrier ?? null,
      sort_order: m.sort_order ?? shippingMethods.length + 1,
      is_active: m.is_active ?? 1,
    })
    return wait(undefined)
  },

  async deleteShippingMethod(id: string) {
    // 削除後も estimateSaleProfit が料金を引けるよう、料金だけ残しておく
    const m = shippingMethods.find(x => x.id === id)
    if (m) deletedShippingMethodFees.set(id, m.fee)
    shippingMethods.splice(0, shippingMethods.length, ...shippingMethods.filter(m => m.id !== id))
    return wait(undefined)
  },

  async getSettings() {
    return wait({ ...settings })
  },

  async setSetting(key: string, value: string) {
    settings = { ...settings, [key]: value }
    return wait(undefined)
  },

  async collect(): Promise<CollectorRun[]> {
    // メルカリ→有効な仕入先アカウントの順に直列で走る想定。モックでは1件ずつ合成する
    await new Promise(resolve => setTimeout(resolve, 600))
    const now = new Date()
    const mercariRun: CollectorRun = {
      id: uid(),
      started_at: isoLocal(now),
      finished_at: isoLocal(new Date(now.getTime() + 3000)),
      status: 'ok',
      fetched: 3,
      inserted: 1,
      message: null,
      source: 'mercari',
      shop_account_id: null,
      shop_account_name: null,
    }
    const shopStart = new Date(now.getTime() + 3000)
    const shop = shopAccounts.find(s => s.kind === 'mellojoy' && s.is_active) ?? null
    const mellojoyRun: CollectorRun = {
      id: uid(),
      started_at: isoLocal(shopStart),
      finished_at: isoLocal(new Date(shopStart.getTime() + 4000)),
      status: 'ok',
      fetched: 2,
      inserted: 1,
      message: null,
      source: 'mellojoy',
      shop_account_id: shop?.id ?? null,
      shop_account_name: shop?.name ?? null,
    }
    runs.unshift(mellojoyRun, mercariRun)
    return [mercariRun, mellojoyRun]
  },

  async openLogin() {
    return wait(undefined)
  },

  async estimateSaleProfit(input) {
    const rateBp = Number(settings.fee_rate_bp ?? 1000)
    const fee = calcFeeMock(input.price, rateBp)
    const method = input.shipping_method_id
      ? shippingMethods.find(m => m.id === input.shipping_method_id)
      : null
    const shipping_fee = method
      ? method.fee
      : input.shipping_method_id
        ? deletedShippingMethodFees.get(input.shipping_method_id) ?? 0
        : 0
    const packaging_cost = input.packaging_cost ?? 0
    const cost = input.inventory_item_ids.reduce(
      (s, id) => s + (inventory.find(i => i.id === id)?.landed_cost ?? 0),
      0,
    )
    const gross_profit = input.price - fee - shipping_fee - packaging_cost - cost
    return wait({ fee, shipping_fee, packaging_cost, cost, gross_profit })
  },

  async listSaleExclusions() {
    return wait(saleExclusions.map(e => ({ ...e })))
  },

  async removeSaleExclusion(mercariItemId: string) {
    saleExclusions = saleExclusions.filter(e => e.mercari_item_id !== mercariItemId)
    return wait(undefined)
  },

  async openShopLogin(_shopAccountId: string) {
    return wait(undefined)
  },

  async listRuns(limit?: number) {
    const rows = runs.slice(0, limit ?? runs.length)
    return wait(rows)
  },

  async exportCsv() {
    return wait('~/Desktop/soroban-export.csv')
  },

  async backupDb() {
    return wait('~/Desktop/soroban-backup.db')
  },

  async restoreBackup() {
    // 復元は実際にはアプリを再起動する。モックでは何もしない（選ぶダイアログもキャンセル扱い）
    return new Promise(resolve => setTimeout(() => resolve(null), 1000))
  },

  async revealDbFolder() {
    return wait(undefined)
  },

  async resetData() {
    // 取引データだけ消す。仕入先・発送方法・設定・タグ自体は残す。
    // 販売・在庫を空にすることで、そこに付いていたタグの紐付け（sale_tag/inventory_tag 相当）も一緒に消える
    sales = []
    purchases = []
    inventory = []
    runs = []
    listingRecords = []
    expenses = []
    saleLines.clear()
    itemPurchaseId.clear()
    itemDisposedAt.clear()
    itemSplitAt.clear()
    listingItems.clear()
    lineItemIds.clear()
    lineImageUrl.clear()
    productTags.clear()
    productManualImage.clear()
    monthBook.clear()
    return wait(undefined)
  },

  // メルカリのページを標準ブラウザで開く。モックにはブラウザ制御が無いため、開く先を確認できるよう
  // alert で知らせる（本物は shell.openExternal で新規タブに開く。読み取り専用・ログイン操作はしない）
  async openMercari(kind: 'item' | 'transaction', mercariItemId: string) {
    const url = `https://jp.mercari.com/${kind}/${mercariItemId}`
    window.alert(`ブラウザで開きます: ${url}`)
    return wait(undefined)
  },

  // 操作ログ（デバッグ用）。実データは main が app_log テーブルへ保存する。
  // モックには保存先が無いので console にだけ出す
  async logClient(kind: string, message: string, payload?: unknown) {
    console.debug('[soroban:logClient]', kind, message, payload)
    return wait(undefined)
  },

  // アプリの更新（GitHub Releases）。見た目の確認用に「新しい版がある」を返す
  async checkForUpdate(): Promise<UpdateStatus> {
    return wait({
      current: '0.1.0',
      state: 'available',
      latest: '0.2.0',
      notes: '- 出品の一括引き当てを追加\n- 月次のグラフを見やすく調整',
      url: 'https://github.com/namespace-git/soroban/releases/latest',
      canAutoInstall: true,
      message: null,
    })
  },

  async installUpdate() {
    return wait(undefined)
  },
}

/** メモ付きの在庫を1件（見え方の確認用。商品名の続きに見えないことを確かめる） */
function assignInitialNote(): void {
  const item = inventory.find(i => i.status === 'in_stock' && i.model_code === 'A012')
  if (item) item.note = '箱に凹みあり。写真を撮って発送前に確認する'
}

/** 販売の1/3、在庫の1/4にタグを付ける（見え方の確認用） */
function assignInitialTags(): void {
  sales.forEach((s, i) => {
    if (i % 3 === 0) s.tags = [tags[i % tags.length]]
  })
  inventory.forEach((it, i) => {
    if (i % 4 === 0) it.tags = [tags[i % tags.length]]
  })
}

/**
 * 仕入の一部にタグを付ける（見え方の確認用）。派生の見え方を確かめるため、
 * ここで付けたタグは recalcAllInheritance() で在庫・販売の inherited_tags に流し込む
 */
function assignInitialPurchaseTags(): void {
  purchases.forEach((p, i) => {
    if (i % 3 === 1) p.tags = [tags[(i + 1) % tags.length]]
  })
}

/**
 * 仕入先の1つに自動タグを付けておく（見え方の確認用）。ここで作った仕入から生まれる
 * 仕入・在庫・販売にそのまま流れることを確かめられる（buildInitialPurchasesAndInventory より先に呼ぶ）
 */
function assignInitialAutoTags(): void {
  shopAccounts[0].auto_tags = [tags[0]]
}

/** 商品（型番）の一部にタグを付ける（見え方の確認用） */
function assignInitialProductTags(): void {
  allModelCodes().forEach((model, i) => {
    if (i % 4 === 2) productTags.set(model, [tags[(i + 2) % tags.length]])
  })
}

/** 商品画像を1件だけ人が固定したことにする（見え方の確認用。値は自動判定のものをそのまま） */
function assignInitialProductImage(): void {
  const model = allModelCodes().find(m => autoProductThumb(m) !== null)
  if (model) productManualImage.set(model, autoProductThumb(model))
}

export function installMock(): void {
  assignInitialAutoTags()
  buildInitialPurchasesAndInventory()
  buildInitialSales()
  buildInitialListings()
  buildInitialRuns()
  buildInitialExpenses()
  assignInitialNote()
  assignInitialTags()
  assignInitialPurchaseTags()
  assignInitialProductTags()
  assignInitialProductImage()
  recalcAllInheritance()

  window.soroban = api
  ;(window as unknown as {
    sorobanEvents: {
      onCollectDone(cb: (runs: CollectorRun[]) => void): void
      onUpdateStatus(cb: (status: UpdateStatus) => void): void
    }
  }).sorobanEvents = {
    onCollectDone() {
      // モックでは自動収集イベントを発火しない（collect() は手動呼び出しのみ）
    },
    onUpdateStatus() {
      // モックでは裏の自動確認イベントを発火しない（checkForUpdate() は手動呼び出しのみ）
    },
  }
}
