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
  SorobanApi, ShopAccount, ShopAccountKind, ShippingMethod, ShippingSource,
  SaleProfit, SaleInput, SalePatch, SaleKind, SaleSource, SaleFilter, SaleTotals, SaleStatus,
  PurchaseDetail, PurchaseInput, PurchaseLine,
  InventoryItem, InventoryStatus, InventoryPatch,
  MonthlySummary, DashboardStats, CollectorRun,
  Material, VariantSummary, Tag, Fulfillment,
  ProductSummary, ProductDetail, ProductMonthPoint, ItemTimeline, TimelineEvent,
} from '../../shared/types'
import { todayLocal, thisMonthLocal } from '../../shared/date'

// ------------------------------------------------------------
// 小さなユーティリティ
// ------------------------------------------------------------

function uid(): string {
  return crypto.randomUUID()
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
  { id: uid(), name: 'メロジョイA', kind: 'mellojoy', note: null, is_active: 1 },
  { id: uid(), name: 'メロジョイB', kind: 'mellojoy', note: null, is_active: 1 },
  { id: uid(), name: 'TikTok Shop', kind: 'tiktok', note: null, is_active: 1 },
]

/** タグ。deleteTag で配列ごと差し替えるので let */
let tags: Tag[] = [
  { id: uid(), name: 'セール', sort_order: 1 },
  { id: uid(), name: 'まとめ売り', sort_order: 2 },
  { id: uid(), name: '福袋', sort_order: 3 },
]

const shippingMethods: ShippingMethod[] = [
  { id: uid(), name: 'ネコポス', carrier: 'らくらくメルカリ便', fee: 210, sort_order: 1, is_active: 1 },
  { id: uid(), name: 'ゆうパケット', carrier: 'ゆうゆうメルカリ便', fee: 230, sort_order: 2, is_active: 1 },
  { id: uid(), name: 'ゆうパケットポスト', carrier: 'ゆうゆうメルカリ便', fee: 215, sort_order: 3, is_active: 1 },
  { id: uid(), name: '宅急便コンパクト', carrier: 'らくらくメルカリ便', fee: 450, sort_order: 4, is_active: 1 },
  { id: uid(), name: 'ゆうパック60', carrier: 'ゆうゆうメルカリ便', fee: 770, sort_order: 5, is_active: 1 },
  { id: uid(), name: '宅急便60', carrier: 'らくらくメルカリ便', fee: 750, sort_order: 6, is_active: 1 },
]

let settings: Record<string, string> = {
  fee_rate_bp: '1000',
  transfer_fee: '200',
  collect_interval_h: '1',
  aging_warn_days: '90',
  mercari_keyword: '【',
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

    lines.push({
      id: uid(),
      name: rawName(v),
      unit_price: v.price,
      quantity: l.qty,
      model_code: v.model,
      series_code: v.series,
      material: v.material,
      allocated_cost: shares[li],
      landed_unit_cost: v.price + Math.floor(shares[li] / l.qty),
    })

    for (let n = 0; n < l.qty; n++) {
      const itemId = uid()
      inventory.push({
        id: itemId,
        name: displayName(v),
        landed_cost: v.price + parts[n],
        acquired_at: opts.orderedAt,
        status: 'in_stock',
        aging_days: diffDays(opts.orderedAt),
        order_no: orderNo,
        shop_account_name: opts.shopName,
        model_code: v.model,
        series_code: v.series,
        material: v.material,
        parent_id: null,
        note: null,
        tags: [],
        fulfillment,
        thumb_url: null,
      })
      itemPurchaseId.set(itemId, purchaseId)
    }
  })

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
  })
}

/** TikTok Shop 仕入。型番なし（日用品） */
function addTiktokPurchase(opts: {
  shopId: string
  shopName: string
  orderedAt: string
  shippingFee: number
  lines: Array<{ name: string; price: number; qty: number }>
}): void {
  const purchaseId = uid()
  const orderNo = `TK-${opts.orderedAt.replace(/-/g, '').slice(0, 6)}-${pad(purchases.length + 1)}`
  const bases = opts.lines.map(l => l.price * l.qty)
  const shares = allocateAmount(bases, opts.shippingFee)

  const lines: PurchaseLine[] = []
  let subtotal = 0
  let totalCost = 0

  opts.lines.forEach((l, li) => {
    subtotal += l.price * l.qty
    totalCost += l.price * l.qty + shares[li]
    const parts = splitEvenly(shares[li], l.qty)

    lines.push({
      id: uid(),
      name: l.name,
      unit_price: l.price,
      quantity: l.qty,
      model_code: null,
      series_code: null,
      material: null,
      allocated_cost: shares[li],
      landed_unit_cost: l.price + Math.floor(shares[li] / l.qty),
    })

    for (let n = 0; n < l.qty; n++) {
      const itemId = uid()
      inventory.push({
        id: itemId,
        name: l.name,
        landed_cost: l.price + parts[n],
        acquired_at: opts.orderedAt,
        status: 'in_stock',
        aging_days: diffDays(opts.orderedAt),
        order_no: orderNo,
        shop_account_name: opts.shopName,
        model_code: null,
        series_code: null,
        material: null,
        parent_id: null,
        note: null,
        tags: [],
        fulfillment: null,
        thumb_url: null,
      })
      itemPurchaseId.set(itemId, purchaseId)
    }
  })

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
    fulfillment: null,
    shipped_at: null,
    delivered_at: null,
    line_count: lines.length,
    first_line_name: lines[0]?.name ?? null,
    first_model_code: lines[0]?.model_code ?? null,
    subtotal,
    total_cost: totalCost,
    other_cost: 0,
    alloc_method: 'by_amount',
    lines,
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
    }
  })
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
  })
}

function buildInitialPurchasesAndInventory(): void {
  const [mA, mB, tk] = shopAccounts

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

  const sale: SaleProfit = {
    id: uid(),
    mercari_item_id: mercariId(),
    thumb_url: thumbUrlFor(opts.i, source),
    sold_at: soldAt,
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
    ...saleStatusFor(source, soldAt),
  }

  if (itemCount > 0) {
    saleLines.set(sale.id, opts.items.map(it => it.id))
    for (const it of opts.items) {
      it.status = 'sold'
      it.thumb_url = sale.thumb_url
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
// 月次集計
// ------------------------------------------------------------

function monthlyFromSales(rows: SaleProfit[]): MonthlySummary[] {
  const map = new Map<string, MonthlySummary>()
  for (const s of rows) {
    const month = s.sold_at.slice(0, 7)
    const key = `${month}:${s.kind}`
    const cur = map.get(key) ?? {
      month, kind: s.kind, sales_count: 0, revenue: 0, total_fee: 0,
      total_shipping: 0, total_packaging: 0, total_cost: 0, gross_profit: 0,
    }
    cur.sales_count += 1
    cur.revenue += s.price
    cur.total_fee += s.fee
    cur.total_shipping += s.shipping_fee
    cur.total_packaging += s.packaging_cost
    cur.total_cost += s.cost
    cur.gross_profit += s.gross_profit
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
function extraOlderMonths(): MonthlySummary[] {
  const m2 = monthAgoStr(2)
  const m3 = monthAgoStr(3)
  return [
    { month: m2, kind: 'resale', sales_count: 9, revenue: 38000, total_fee: 3800, total_shipping: 1800, total_packaging: 600, total_cost: 19000, gross_profit: 12800 },
    { month: m2, kind: 'personal', sales_count: 2, revenue: 6200, total_fee: 620, total_shipping: 400, total_packaging: 0, total_cost: 0, gross_profit: 5180 },
    { month: m3, kind: 'resale', sales_count: 11, revenue: 45000, total_fee: 4500, total_shipping: 2200, total_packaging: 700, total_cost: 23000, gross_profit: 14600 },
    { month: m3, kind: 'personal', sales_count: 1, revenue: 3200, total_fee: 320, total_shipping: 210, total_packaging: 0, total_cost: 0, gross_profit: 2670 },
  ]
}

// ------------------------------------------------------------
// 収集履歴
// ------------------------------------------------------------

let runs: CollectorRun[] = []

function buildInitialRuns(): void {
  const specs: Array<{ hoursAgo: number; status: CollectorRun['status']; fetched: number; inserted: number; message: string | null }> = [
    { hoursAgo: 2, status: 'ok', fetched: 5, inserted: 2, message: null },
    { hoursAgo: 8, status: 'ok', fetched: 4, inserted: 1, message: null },
    { hoursAgo: 14, status: 'auth_required', fetched: 0, inserted: 0, message: 'セッション切れ。再ログインが必要です' },
    { hoursAgo: 20, status: 'ok', fetched: 6, inserted: 3, message: null },
    { hoursAgo: 32, status: 'empty', fetched: 0, inserted: 0, message: '0件取得（表示待ちの可能性）' },
    { hoursAgo: 44, status: 'ok', fetched: 3, inserted: 1, message: null },
  ]
  runs = specs.map(s => {
    const start = new Date()
    start.setHours(start.getHours() - s.hoursAgo)
    const finish = new Date(start.getTime() + 8000)
    return {
      id: uid(),
      started_at: isoLocal(start),
      finished_at: isoLocal(finish),
      status: s.status,
      fetched: s.fetched,
      inserted: s.inserted,
      message: s.message,
      source: 'mercari',
      shop_account_id: null,
      shop_account_name: null,
    }
  })
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
  if (filter?.tagId) rows = rows.filter(s => s.tags.some(t => t.id === filter.tagId))
  return rows
}

function findPurchase(id: string): PurchaseDetail {
  const p = purchases.find(x => x.id === id)
  if (!p) throw new Error('仕入が見つかりません')
  return p
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

  return {
    model_code: model,
    series_code: sample?.series_code ?? null,
    material: sample?.material ?? null,
    name: sample?.name ?? model,
    purchased: items.length,
    sold: soldItems.length,
    in_stock: inStockItems.length,
    stock_value: inStockItems.reduce((s, i) => s + i.landed_cost, 0),
    avg_price: avgPrice,
    avg_profit: avgProfit,
    total_profit: relatedSales.reduce((s, x) => s + x.gross_profit, 0),
  }
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
  const thumbUrl = linkedSales.slice().sort((a, b) => b.sold_at.localeCompare(a.sold_at))[0]?.thumb_url ?? null

  return {
    ...summary,
    purchase_total: purchaseTotal,
    avg_cost: avgCost,
    last_purchased_at: lastPurchasedAt,
    last_sold_at: lastSoldAt,
    thumb_url: thumbUrl,
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

const api: SorobanApi = {
  async getDashboard(): Promise<DashboardStats> {
    const needsShipping = sales.filter(s => !s.is_shipping_confirmed).length
    const needsMatch = sales.filter(s => s.kind === 'resale' && s.unmatched).length
    const needsPurchaseConfirm = purchases.filter(p => p.status === 'draft').length
    const stock = inventory.filter(i => i.status === 'in_stock')
    const stockCount = stock.length
    const stockValue = stock.reduce((s, i) => s + i.landed_cost, 0)
    const warnDays = Number(settings.aging_warn_days ?? '90')
    const agingCount = stock.filter(i => i.aging_days > warnDays).length
    const month = thisMonthLocal()
    const thisMonth = monthlyFromSales(sales).find(m => m.month === month && m.kind === 'resale') ?? null
    const lastRun = runs[0] ?? null
    return wait({ needsShipping, needsMatch, needsPurchaseConfirm, stockCount, stockValue, agingCount, thisMonth, lastRun })
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
    const ids = saleLines.get(id) ?? []
    for (const itemId of ids) {
      const item = inventory.find(it => it.id === itemId)
      if (item) {
        item.status = 'in_stock'
        item.thumb_url = null
      }
    }
    saleLines.delete(id)
    sales = sales.filter(s => s.id !== id)
    return wait(undefined)
  },

  async linkInventory(saleId: string, inventoryItemIds: string[]) {
    const sale = findSale(saleId)
    for (const itemId of inventoryItemIds) {
      const item = inventory.find(it => it.id === itemId)
      if (!item || item.status !== 'in_stock') {
        throw new Error('すでに販売済みの在庫です')
      }
    }
    const current = saleLines.get(saleId) ?? []
    for (const itemId of inventoryItemIds) {
      const item = inventory.find(it => it.id === itemId)!
      item.status = 'sold'
      item.thumb_url = sale.thumb_url
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
    }
    sale.auto_linked = 0
    recalcSale(sale)
    return wait(undefined)
  },

  async suggestInventory(saleId: string, limit = 20) {
    const sale = findSale(saleId)
    const target = normalizeName(sale.title)
    const items = inventory.filter(i => i.status === 'in_stock')
    const ranked = items
      .map(item => ({ item, score: commonCharCount(target, normalizeName(item.name)) }))
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.item.aging_days - a.item.aging_days))
      .slice(0, limit)
      .map(({ item }) => item)
    return wait(ranked)
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
    return wait(findPurchase(id))
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

      lines.push({
        id: uid(),
        name: l.name,
        unit_price: l.unit_price,
        quantity: l.quantity,
        model_code, series_code, material,
        allocated_cost: shares[li],
        landed_unit_cost: l.unit_price + Math.floor(shares[li] / l.quantity),
      })

      for (let n = 0; n < l.quantity; n++) {
        const itemId = uid()
        inventory.push({
          id: itemId,
          name: l.name,
          landed_cost: l.unit_price + parts[n],
          acquired_at: input.ordered_at,
          status: 'in_stock',
          aging_days: diffDays(input.ordered_at),
          order_no: input.order_no ?? null,
          shop_account_name: shop?.name ?? null,
          model_code, series_code, material,
          parent_id: null,
          note: null,
          tags: [],
          fulfillment: null,
          thumb_url: null,
        })
        itemPurchaseId.set(itemId, purchaseId)
      }
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
    })

    return wait(purchaseId)
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

      lines.push({
        id: uid(),
        name: l.name,
        unit_price: l.unit_price,
        quantity: l.quantity,
        model_code, series_code, material,
        allocated_cost: shares[li],
        landed_unit_cost: l.unit_price + Math.floor(shares[li] / l.quantity),
      })

      for (let n = 0; n < l.quantity; n++) {
        const itemId = uid()
        inventory.push({
          id: itemId,
          name: l.name,
          landed_cost: l.unit_price + parts[n],
          acquired_at: input.ordered_at,
          status: 'in_stock',
          aging_days: diffDays(input.ordered_at),
          order_no: input.order_no ?? p.order_no,
          shop_account_name: shop?.name ?? p.shop_account_name,
          model_code, series_code, material,
          parent_id: null,
          note: null,
          tags: [],
          fulfillment: null,
          thumb_url: null,
        })
        itemPurchaseId.set(itemId, p.id)
      }
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

    for (let n = 0; n < count; n++) {
      const childId = uid()
      inventory.push({
        id: childId,
        name: item.name,
        landed_cost: parts[n],
        acquired_at: item.acquired_at,
        status: 'in_stock',
        aging_days: item.aging_days,
        order_no: item.order_no,
        shop_account_name: item.shop_account_name,
        model_code: item.model_code,
        series_code: item.series_code,
        material: item.material,
        parent_id: item.id,
        note: null,
        tags: [],
        fulfillment: item.fulfillment,
        thumb_url: null,
      })
      childIds.push(childId)
      if (purchaseId) itemPurchaseId.set(childId, purchaseId)
    }
    item.status = 'split' // 過去の原価は動かさない。親はそのまま残す
    itemSplitAt.set(item.id, todayLocal())
    return wait(childIds)
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
    const rows = [...monthlyFromSales(sales), ...extraOlderMonths()]
    rows.sort((a, b) => (a.month !== b.month ? (a.month < b.month ? 1 : -1) : a.kind.localeCompare(b.kind)))
    return wait(rows)
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
    for (const s of sales) s.tags = s.tags.filter(t => t.id !== id)
    for (const it of inventory) it.tags = it.tags.filter(t => t.id !== id)
    return wait(undefined)
  },

  async setSaleTags(saleId: string, tagIds: string[]) {
    const sale = findSale(saleId)
    sale.tags = tagIds.map(id => tags.find(t => t.id === id)).filter((t): t is Tag => !!t)
    return wait(undefined)
  },

  async setInventoryTags(inventoryItemId: string, tagIds: string[]) {
    const item = inventory.find(i => i.id === inventoryItemId)
    if (!item) throw new Error('在庫が見つかりません')
    item.tags = tagIds.map(id => tags.find(t => t.id === id)).filter((t): t is Tag => !!t)
    return wait(undefined)
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

  async listShopAccounts() {
    return wait(shopAccounts.slice())
  },

  async createShopAccount(name: string, kind: ShopAccountKind = 'other') {
    const id = uid()
    shopAccounts.push({ id, name, kind, note: null, is_active: 1 })
    return wait(id)
  },

  async updateShopAccount(id: string, patch: { name?: string; kind?: ShopAccountKind; is_active?: number }) {
    const account = shopAccounts.find(s => s.id === id)
    if (!account) throw new Error('仕入先が見つかりません')
    if (patch.name !== undefined) account.name = patch.name
    if (patch.kind !== undefined) account.kind = patch.kind
    if (patch.is_active !== undefined) account.is_active = patch.is_active
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

  async openShopLogin(_shopAccountId: string) {
    return wait(undefined)
  },

  async listRuns(limit?: number) {
    const rows = runs.slice(0, limit ?? runs.length)
    return wait(rows)
  },

  async exportCsv() {
    return wait('C:/Users/suito/Desktop/soroban-export.csv')
  },

  async backupDb() {
    return wait('C:/Users/suito/Desktop/soroban-backup.db')
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
    saleLines.clear()
    itemPurchaseId.clear()
    itemDisposedAt.clear()
    itemSplitAt.clear()
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

export function installMock(): void {
  buildInitialPurchasesAndInventory()
  buildInitialSales()
  buildInitialRuns()
  assignInitialNote()
  assignInitialTags()

  window.soroban = api
  ;(window as unknown as { sorobanEvents: { onCollectDone(cb: (runs: CollectorRun[]) => void): void } }).sorobanEvents = {
    onCollectDone() {
      // モックでは自動収集イベントを発火しない（collect() は手動呼び出しのみ）
    },
  }
}
