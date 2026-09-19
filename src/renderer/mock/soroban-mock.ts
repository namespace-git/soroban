// ============================================================
// 開発用モック（`window.soroban` が無いときだけ main.ts から差し込まれる）
//
// 目的：Electron 外の素のブラウザで画面を開けるようにする。
// 本番ビルドには入らない（main.ts が import.meta.env.DEV で動的 import する）。
//
// データはメモリ上に持ち、操作すると変わる（紐付け・削除・登録が試せる）。
// 金額は integer（円）。按分・手数料の考え方は src/main/db.ts・money.ts に合わせる。
// ============================================================

import type {
  SorobanApi, ShopAccount, ShippingMethod, SaleProfit, SaleInput, SalePatch,
  PurchaseSummary, PurchaseInput, InventoryItem, InventoryStatus, MonthlySummary,
  DashboardStats, CollectorRun, SaleKind,
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
// マスタ
// ------------------------------------------------------------

const shopAccounts: ShopAccount[] = [
  { id: uid(), name: 'メロジョイA', note: null, is_active: 1 },
  { id: uid(), name: 'メロジョイB', note: null, is_active: 1 },
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
  collect_interval_h: '6',
  aging_warn_days: '90',
}

// ------------------------------------------------------------
// 仕入・在庫の合成データ
//
// 化粧品・日用品っぽい商品名を6件の仕入にまとめ、数量分の在庫を生成する。
// createPurchase と同じ按分ロジック（端数は最終アイテムに寄せる）を使う。
// ------------------------------------------------------------

const PRODUCTS: Array<{ name: string; price: number }> = [
  { name: 'ラロッシュポゼ UVイデア XL 30ml', price: 2800 },
  { name: 'メディヒール N.M.F アクアリング 10枚', price: 1200 },
  { name: 'イニスフリー ノーセバム パウダー', price: 900 },
  { name: 'バニラコ クリーンイットゼロ 100ml', price: 1800 },
  { name: 'アヌア ドクダミ化粧水 250ml', price: 1600 },
  { name: 'CNP プロポリス アンプル', price: 2200 },
  { name: 'ラネージュ リップスリーピングマスク', price: 1500 },
  { name: 'ダーマトリー シカペア クリーム', price: 1300 },
  { name: 'ビフェスタ クレンジングリキッド', price: 600 },
  { name: 'センカ パーフェクトホイップ', price: 450 },
  { name: 'コパトーン パーフェクトUV', price: 1100 },
  { name: '肌ラボ 極潤ヒアルロン液', price: 750 },
  { name: 'アネッサ パーフェクトUV スキンケアミルク', price: 2400 },
  { name: 'なめらか本舗 豆乳イソフラボン乳液', price: 800 },
  { name: 'ビオレUV アクアリッチ ウォータリーエッセンス', price: 700 },
  { name: 'DHC 薬用リップクリーム', price: 400 },
  { name: 'メンソレータム ヒビケア', price: 500 },
  { name: 'アユーラ メディテーションバス', price: 1900 },
  { name: 'ミノン アミノモイスト しっとり化粧水', price: 1400 },
  { name: 'ソンバーユ 馬油クリーム', price: 600 },
]
// 商品ごとの数量（大半は2点、2品だけ3〜4点にしてまとめ売り候補を作る）
const QTY = [2, 2, 2, 2, 2, 2, 3, 2, 2, 2, 2, 2, 4, 2, 2, 2, 2, 2, 2, 2]

let purchases: PurchaseSummary[] = []
let inventory: InventoryItem[] = []
/** 在庫アイテム → どの仕入から生まれたか（deletePurchase の判定用） */
const itemPurchaseId = new Map<string, string>()

function buildInitialPurchasesAndInventory() {
  const chunkSizes = [4, 3, 3, 4, 3, 3]
  const purchaseAges = [160, 130, 95, 60, 25, 5] // 発注からの経過日数
  const shippingFees = [900, 700, 1100, 650, 800, 750]

  let cursor = 0
  chunkSizes.forEach((size, pi) => {
    const slice = PRODUCTS.slice(cursor, cursor + size)
    const qtySlice = QTY.slice(cursor, cursor + size)
    cursor += size

    const orderedAt = todayLocal(daysAgo(purchaseAges[pi]))
    const shop = shopAccounts[pi % shopAccounts.length]
    const orderNo = `MJ-${orderedAt.slice(0, 4)}${orderedAt.slice(5, 7)}-${pad(pi + 1)}`
    const shippingFee = shippingFees[pi]
    const purchaseId = uid()

    const lines = slice.map((p, li) => ({
      name: p.name,
      unit_price: p.price,
      quantity: qtySlice[li],
    }))

    const bases = lines.map(l => l.unit_price * l.quantity)
    const shares = allocateAmount(bases, shippingFee)

    let subtotal = 0
    let totalCost = 0

    lines.forEach((l, li) => {
      subtotal += l.unit_price * l.quantity
      totalCost += l.unit_price * l.quantity + shares[li]
      const parts = splitEvenly(shares[li], l.quantity)
      for (let n = 0; n < l.quantity; n++) {
        const itemId = uid()
        inventory.push({
          id: itemId,
          name: l.name,
          landed_cost: l.unit_price + parts[n],
          acquired_at: orderedAt,
          status: 'in_stock',
          aging_days: diffDays(orderedAt),
          order_no: orderNo,
          shop_account_name: shop.name,
        })
        itemPurchaseId.set(itemId, purchaseId)
      }
    })

    purchases.push({
      id: purchaseId,
      ordered_at: orderedAt,
      order_no: orderNo,
      shop_account_name: shop.name,
      shipping_fee: shippingFee,
      discount: 0,
      line_count: lines.length,
      subtotal,
      total_cost: totalCost,
    })
  })
}

/**
 * 紐付けドロワーの候補一覧は密度（30〜100点）で見え方が変わるため、
 * 販売に紐付かない在庫だけを追加で積む（sold の在庫には触れない）。
 * 既存6件の仕入のうち、日付が近いものの order_no・仕入先名を借りて登録する
 * （その仕入の subtotal / total_cost は変えない。表示用の簡易な紐付けでよい）。
 */
function buildExtraUnsoldStock(): void {
  const extra: Array<{ productIdx: number; qty: number; ageDays: number; purchaseIdx: number }> = [
    // 長期滞留（90日超）
    { productIdx: 0, qty: 3, ageDays: 150, purchaseIdx: 0 },
    { productIdx: 1, qty: 3, ageDays: 140, purchaseIdx: 1 },
    { productIdx: 4, qty: 2, ageDays: 120, purchaseIdx: 1 },
    { productIdx: 7, qty: 3, ageDays: 100, purchaseIdx: 2 },
    { productIdx: 9, qty: 3, ageDays: 95, purchaseIdx: 2 },
    // 新しめ（90日以内）
    { productIdx: 2, qty: 3, ageDays: 70, purchaseIdx: 3 },
    { productIdx: 5, qty: 3, ageDays: 50, purchaseIdx: 3 },
    { productIdx: 10, qty: 3, ageDays: 30, purchaseIdx: 4 },
    { productIdx: 15, qty: 3, ageDays: 15, purchaseIdx: 5 },
    { productIdx: 18, qty: 2, ageDays: 8, purchaseIdx: 5 },
  ]

  for (const e of extra) {
    const product = PRODUCTS[e.productIdx]
    const purchase = purchases[e.purchaseIdx]
    const acquiredAt = todayLocal(daysAgo(e.ageDays))
    for (let n = 0; n < e.qty; n++) {
      inventory.push({
        id: uid(),
        name: product.name,
        landed_cost: product.price,
        acquired_at: acquiredAt,
        status: 'in_stock',
        aging_days: diffDays(acquiredAt),
        order_no: purchase.order_no,
        shop_account_name: purchase.shop_account_name,
      })
    }
  }
}

// ------------------------------------------------------------
// 販売の合成データ
//
// 在庫は生成順で古い仕入（滞留デモ用に残す8点）→新しい仕入（販売に紐付ける31点）の順に並ぶ。
// 紐付けドロワーの候補密度を見せるための追加在庫（約28点）は buildExtraUnsoldStock で
// 別途積み、販売とは紐付かない
// ------------------------------------------------------------

let sales: SaleProfit[] = []
/** sale.id -> 紐付けた inventory_item.id[] */
const saleLines = new Map<string, string[]>()

function shipInfo(i: number): { id: string; fee: number } {
  const m = shippingMethods[i % shippingMethods.length]
  return { id: m.id, fee: m.fee }
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

function buildSale(opts: {
  i: number
  title: string
  kind: SaleKind
  price: number
  shipping: { id: string | null; fee: number; confirmed: boolean }
  items: InventoryItem[]
  packaging?: number
}): SaleProfit {
  const rateBp = Number(settings.fee_rate_bp)
  const fee = calcFeeMock(opts.price, rateBp)
  const packaging = opts.packaging ?? 0
  const cost = opts.items.reduce((s, it) => s + it.landed_cost, 0)
  const itemCount = opts.items.length

  const sale: SaleProfit = {
    id: uid(),
    mercari_item_id: mercariId(),
    sold_at: soldAtFor(opts.i),
    title: opts.title,
    kind: opts.kind,
    price: opts.price,
    fee,
    shipping_fee: opts.shipping.fee,
    packaging_cost: packaging,
    is_shipping_confirmed: opts.shipping.confirmed ? 1 : 0,
    shipping_method_id: opts.shipping.id,
    cost,
    gross_profit: opts.price - fee - opts.shipping.fee - packaging - cost,
    item_count: itemCount,
    unmatched: itemCount === 0 ? 1 : 0,
  }

  if (itemCount > 0) {
    saleLines.set(sale.id, opts.items.map(it => it.id))
    for (const it of opts.items) it.status = 'sold'
  }
  return sale
}

function buildInitialSales() {
  let idx = 0
  const out: SaleProfit[] = []

  // 在庫のうち、最初の8点（最古の仕入）は滞留デモのために売らずに残す。
  // 残り35点のうち31点だけ販売に紐付け、末尾の数点（最新の仕入）はそのまま
  // 在庫に残す＝滞留在庫と新しい在庫の両方を見せる
  const linkPool = inventory.slice(8)
  let linkCursor = 0
  const takeItems = (n: number): InventoryItem[] => {
    const taken = linkPool.slice(linkCursor, linkCursor + n)
    linkCursor += n
    return taken
  }

  // --- 送料未入力 かつ 未紐付け（2件） ---
  for (let k = 0; k < 2; k++) {
    const i = idx++
    out.push(buildSale({
      i,
      title: PRODUCTS[i % PRODUCTS.length].name,
      kind: 'resale',
      price: priceFor(i),
      shipping: { id: null, fee: 0, confirmed: false },
      items: [],
    }))
  }

  // --- 送料未入力だが紐付け済み（1件。送料未入力グループの残り1件） ---
  {
    const i = idx++
    const items = takeItems(1)
    out.push(buildSale({
      i,
      title: items[0]?.name ?? PRODUCTS[0].name,
      kind: 'resale',
      price: priceFor(i),
      shipping: { id: null, fee: 0, confirmed: false },
      items,
    }))
  }

  // --- 送料は確定しているが未紐付け（2件。未紐付け4件のうちの残り2件） ---
  for (let k = 0; k < 2; k++) {
    const i = idx++
    const sm = shipInfo(i)
    out.push(buildSale({
      i,
      title: PRODUCTS[(i + 3) % PRODUCTS.length].name,
      kind: 'resale',
      price: priceFor(i),
      shipping: { id: sm.id, fee: sm.fee, confirmed: true },
      items: [],
      packaging: packagingFor(i),
    }))
  }

  // --- 私物（3件） ---
  const personalTitles = ['ダイソン ドライヤー 中古美品', 'ワンピース Mサイズ 未使用', 'ハンドバッグ レザー 中古']
  for (let k = 0; k < 3; k++) {
    const i = idx++
    const sm = shipInfo(i)
    out.push(buildSale({
      i,
      title: personalTitles[k],
      kind: 'personal',
      price: priceFor(i),
      shipping: { id: sm.id, fee: sm.fee, confirmed: true },
      items: [],
      packaging: packagingFor(i),
    }))
  }

  // --- 確定済み（発送方法あり・紐付け1〜3点）22件。うち2件は粗利が赤字 ---
  const itemCounts = [
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 16件×1点
    2, 2, 2, 2, // 4件×2点
    3, 3, // 2件×3点
  ]
  const negativeAt = new Set([3, 14])

  itemCounts.forEach((n, k) => {
    const i = idx++
    const items = takeItems(n)
    const sm = shipInfo(i)
    const cost = items.reduce((s, it) => s + it.landed_cost, 0)
    const packaging = packagingFor(i)

    let price: number
    if (negativeAt.has(k)) {
      // 原価・送料・梱包の合計より確実に安い価格にして赤字にする
      price = Math.max(500, Math.round((cost + sm.fee + packaging) * 0.7))
    } else {
      // 原価に対して現実的な粗利が乗るよう、原価連動で価格を決める（1.6〜2.2倍）
      const markup = 1.6 + (i % 5) * 0.15
      price = Math.max(800, Math.round((cost * markup) / 100) * 100)
    }

    const title = items.length === 1
      ? items[0].name
      : `${items[0].name} 他${items.length - 1}点`

    out.push(buildSale({
      i,
      title,
      kind: 'resale',
      price,
      shipping: { id: sm.id, fee: sm.fee, confirmed: true },
      items,
      packaging,
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

function buildInitialRuns() {
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
    }
  })
}

// ------------------------------------------------------------
// SorobanApi 実装
// ------------------------------------------------------------

function recalcSale(sale: SaleProfit) {
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

const api: SorobanApi = {
  async getDashboard(): Promise<DashboardStats> {
    const needsShipping = sales.filter(s => !s.is_shipping_confirmed).length
    const needsMatch = sales.filter(s => s.kind === 'resale' && s.unmatched).length
    const stock = inventory.filter(i => i.status === 'in_stock')
    const stockCount = stock.length
    const stockValue = stock.reduce((s, i) => s + i.landed_cost, 0)
    const warnDays = Number(settings.aging_warn_days ?? '90')
    const agingCount = stock.filter(i => i.aging_days > warnDays).length
    const month = thisMonthLocal()
    const thisMonth = monthlyFromSales(sales).find(m => m.month === month && m.kind === 'resale') ?? null
    const lastRun = runs[0] ?? null
    return wait({ needsShipping, needsMatch, stockCount, stockValue, agingCount, thisMonth, lastRun })
  },

  async listSales(filter) {
    let rows = sales.slice()
    if (filter?.month) rows = rows.filter(s => s.sold_at.slice(0, 7) === filter.month)
    if (filter?.kind) rows = rows.filter(s => s.kind === filter.kind)
    if (filter?.onlyPending) {
      rows = rows.filter(s => !s.is_shipping_confirmed || (s.kind === 'resale' && s.unmatched === 1))
    }
    rows.sort((a, b) => (a.sold_at < b.sold_at ? 1 : a.sold_at > b.sold_at ? -1 : 0))
    return wait(rows)
  },

  async createSale(input: SaleInput) {
    const rateBp = Number(settings.fee_rate_bp)
    const price = input.price
    const sale: SaleProfit = {
      id: uid(),
      mercari_item_id: input.mercari_item_id ?? null,
      sold_at: input.sold_at,
      title: input.title,
      kind: input.kind ?? 'resale',
      price,
      fee: calcFeeMock(price, rateBp),
      shipping_fee: 0,
      packaging_cost: 0,
      is_shipping_confirmed: 0,
      shipping_method_id: null,
      cost: 0,
      gross_profit: price - calcFeeMock(price, rateBp),
      item_count: 0,
      unmatched: 1,
    }
    sales.unshift(sale)
    return wait(sale.id)
  },

  async updateSale(id: string, patch: SalePatch) {
    const sale = findSale(id)
    if (patch.title !== undefined) sale.title = patch.title
    if (patch.sold_at !== undefined) sale.sold_at = patch.sold_at
    if (patch.kind !== undefined) sale.kind = patch.kind
    if (patch.packaging_cost !== undefined) sale.packaging_cost = patch.packaging_cost
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
      } else {
        sale.shipping_fee = 0
        sale.is_shipping_confirmed = 0
      }
    } else if (patch.shipping_fee !== undefined) {
      sale.shipping_fee = patch.shipping_fee
      sale.is_shipping_confirmed = 1
    }
    recalcSale(sale)
    return wait(undefined)
  },

  async deleteSale(id: string) {
    // 紐付いていた在庫は在庫に戻す
    const ids = saleLines.get(id) ?? []
    for (const itemId of ids) {
      const item = inventory.find(it => it.id === itemId)
      if (item) item.status = 'in_stock'
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
    }
    saleLines.set(saleId, [...current, ...inventoryItemIds])
    recalcSale(sale)
    return wait(undefined)
  },

  async unlinkInventory(saleId: string, inventoryItemId: string) {
    const sale = findSale(saleId)
    const current = saleLines.get(saleId) ?? []
    saleLines.set(saleId, current.filter(id => id !== inventoryItemId))
    const item = inventory.find(it => it.id === inventoryItemId)
    if (item) item.status = 'in_stock'
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

    let subtotal = 0
    let totalCost = 0

    input.lines.forEach((l, li) => {
      subtotal += l.unit_price * l.quantity
      totalCost += l.unit_price * l.quantity + shares[li]
      const parts = splitEvenly(shares[li], l.quantity)
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
        })
        itemPurchaseId.set(itemId, purchaseId)
      }
    })

    purchases.push({
      id: purchaseId,
      ordered_at: input.ordered_at,
      order_no: input.order_no ?? null,
      shop_account_name: shop?.name ?? '',
      shipping_fee: shippingFee,
      discount,
      line_count: input.lines.length,
      subtotal,
      total_cost: totalCost,
    })

    return wait(purchaseId)
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

  async disposeInventory(id: string, _note: string, status: 'disposed' | 'personal_use' = 'disposed') {
    const item = inventory.find(i => i.id === id)
    if (!item) throw new Error('在庫が見つかりません')
    if (item.status !== 'in_stock') throw new Error('販売済みの在庫は外せません')
    item.status = status
    return wait(undefined)
  },

  async listMonthly() {
    const rows = [...monthlyFromSales(sales), ...extraOlderMonths()]
    rows.sort((a, b) => (a.month !== b.month ? (a.month < b.month ? 1 : -1) : a.kind.localeCompare(b.kind)))
    return wait(rows)
  },

  async listShopAccounts() {
    return wait(shopAccounts.slice())
  },

  async createShopAccount(name: string) {
    const id = uid()
    shopAccounts.push({ id, name, note: null, is_active: 1 })
    return wait(id)
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

  async collect(): Promise<CollectorRun> {
    await new Promise(resolve => setTimeout(resolve, 600))
    const now = new Date()
    const run: CollectorRun = {
      id: uid(),
      started_at: isoLocal(now),
      finished_at: isoLocal(new Date(now.getTime() + 3000)),
      status: 'ok',
      fetched: 3,
      inserted: 1,
      message: null,
    }
    runs.unshift(run)
    return run
  },

  async openLogin() {
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
}

export function installMock(): void {
  buildInitialPurchasesAndInventory()
  buildInitialSales()
  buildExtraUnsoldStock()
  buildInitialRuns()

  window.soroban = api
  ;(window as unknown as { sorobanEvents: { onCollectDone(cb: (run: CollectorRun) => void): void } }).sorobanEvents = {
    onCollectDone() {
      // モックでは自動収集イベントを発火しない（collect() は手動呼び出しのみ）
    },
  }
}
