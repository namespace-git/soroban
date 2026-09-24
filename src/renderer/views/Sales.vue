<script setup lang="ts">
import { isRealized, realizedTotals } from '../../shared/recognition'
// 売上タブ：出品中（メルカリの出品）と販売（成約済み）を1つの作業リストにまとめる。
// 上＝進捗ストリップ（getSalesProgress）で段階を選ぶ、その下＝利益の入力（送料未入力／未紐付け）で絞る、
// 下＝行のグリッド（1行1販売）。既定の並びは「未確定（粗利が出ていない行）が先、次に日付降順」。1件10秒。
import { ref, onMounted, computed, watch, inject, nextTick, type Ref } from 'vue'
import type {
  SaleProfit, ShippingMethod, SaleKind, SaleInput, SaleFilter, SaleTotals, Tag,
  Listing, ListingStatus, CollectorRun, SaleStatus, SalesProgress,
} from '../../shared/types'
import { todayLocal } from '../../shared/date'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import StatusPill from '../components/StatusPill.vue'
import CodeChip from '../components/CodeChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import TagPicker from '../components/TagPicker.vue'
import TimelineDrawer from '../components/TimelineDrawer.vue'
import AllocateDrawer from '../components/AllocateDrawer.vue'
import AllocationCell from '../components/AllocationCell.vue'
import SalesSummary from '../components/SalesSummary.vue'
import SearchBox, { matchesSearch } from '../components/SearchBox.vue'
import PeriodSelect, { inPeriod, type Period } from '../components/PeriodSelect.vue'
import StageStrip, { type StageStripStage } from '../components/StageStrip.vue'
import type { PromptOptions } from '../components/InputDialog.vue'

/** 進捗ストリップの段階（メルカリ側の状態）。旧「未処理／完了」の段階タブは廃止し、
    利益の入力（送料未入力／未紐付け）は下の inputs バンドで別軸として扱う */
type Stage = 'listed' | 'to_ship' | 'in_transit' | 'done' | 'all'
/** 利益の入力バンドの絞り込みキー */
type InputFilterKey = 'needs_shipping' | 'needs_link'

/**
 * goto('sales', payload) で渡ってくる情報。ホームの要対応・横断検索から開かれる。
 * modelCode は商品タブ向けのため、このビューでは無視する。
 * stage:'pending'（旧・売れた要入力）は後方互換のため受け取り、'all' に開く
 * （新しい既定の並びなら「未確定が先」で自然に同じものが見える）
 */
type SalesGotoPayload = {
  stage?: Stage | 'pending'
  onlyUnallocated?: boolean
  onlyPending?: boolean
  status?: SaleStatus
  mercariItemId?: string
  search?: string
  focusId?: string
  modelCode?: string
  /** 月で絞り込む（YYYY-MM）。グラフの月をクリックしたとき */
  month?: string
}

const ask = inject<(title: string, opts?: PromptOptions) => Promise<string | null>>('prompt')!
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!

const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
const gotoPayload = inject<Ref<SalesGotoPayload | null>>('gotoPayload', ref(null))

const STATUS_LABEL: Record<ListingStatus, string> = {
  active: '出品中', suspended: '公開停止中', sold: '売れた', ended: '取り下げ',
}
const STATUS_TONE: Record<ListingStatus, 'brand' | 'neutral' | 'ok' | 'info'> = {
  active: 'info', suspended: 'neutral', sold: 'ok', ended: 'neutral',
}

// --- 販売の状態ピル（StatusPill）。発送してください＝solid-info、受取評価待ち＝info、
//     取引完了＝solid-ok（意味の強い状態は塗り）。それ以外は薄いまま ---
const SALE_STATUS_PILL: Record<SaleStatus, { tone: 'solid-info' | 'info' | 'solid-ok' | 'warn'; label: string }> = {
  waiting_payment: { tone: 'warn', label: '支払い待ち' },
  waiting_shipment: { tone: 'solid-info', label: '発送してください' },
  shipped: { tone: 'info', label: '受取評価待ち' },
  delivered: { tone: 'info', label: '評価してください' },
  completed: { tone: 'solid-ok', label: '取引完了' },
}

const stage = ref<Stage>('to_ship')
type ListedFilter = 'all' | 'unallocated' | 'allocated'
const listedFilter = ref<ListedFilter>('all')
const tagFilter = ref('')
/** 「発送してください」だけに絞るなど（タブは増やさない。ホームの要対応から来る） */
const statusFilter = ref<SaleStatus | ''>('')
const searchText = ref('')
/** 期間の絞り込み。販売行は sold_at、出品行は listed_at。既定は「すべて」 */
const period = ref<Period>('all')
/** グラフの月をクリックしたときの絞り込み（YYYY-MM）。段階を切り替えたら外す */
const monthFilter = ref<string | null>(null)
/** 利益の入力バンド（送料未入力／未紐付け）。段階を切り替えたら外す */
const inputFilter = ref<InputFilterKey | null>(null)
watch(stage, () => { monthFilter.value = null; inputFilter.value = null })

const methods = ref<ShippingMethod[]>([])
const allTags = ref<Tag[]>([])
const listings = ref<Listing[]>([])
const sales = ref<SaleProfit[]>([])
const totals = ref<SaleTotals | null>(null)
const loaded = ref(false)

// --- 進捗ストリップのデータ（メルカリ側の状態） ---
const progress = ref<SalesProgress | null>(null)
async function loadProgress() { progress.value = await window.soroban.getSalesProgress() }

const stageCards = computed<StageStripStage[]>(() => {
  const p = progress.value
  return [
    { key: 'listed', label: '出品中', count: p?.listed.count ?? 0, money: p ? p.listed.expected_profit : null, sub: `未紐付け ${p?.listed.unallocated ?? 0}` },
    { key: 'to_ship', label: '売れた・発送する', count: p?.to_ship.count ?? 0, money: p ? p.to_ship.revenue : null, sub: '見込み売上・発送待ち' },
    { key: 'in_transit', label: '配送中・受取待ち', count: p?.in_transit.count ?? 0, money: p ? p.in_transit.revenue : null, sub: '見込み売上・取引完了待ち' },
    { key: 'done', label: '取引完了', count: p?.completed_this_month.count ?? 0, money: p ? p.completed_this_month.revenue : null, sub: '今月・反映済み' },
    { key: 'all', label: 'すべて', count: p?.all ?? 0, sub: '出品も含む' },
  ]
})
function onSelectStage(key: string) { stage.value = key as Stage }

// --- 紐付けの入口は全ステップ共通。利益だけ実績／見込みを区別する。
//     出品と販売が混ざる「すべて」はどちらの行にも通じる既定の言い回しのまま ---
const costHeaderLabel = '在庫の紐付け・原価'
const profitHeaderLabel = computed(() => stage.value === 'listed' ? '見込み粗利' : '粗利')

/** 利益の入力バンドのピルをクリック：「すべて」に開いて絞る（もう一度押すと解除） */
async function toggleInputFilter(key: InputFilterKey) {
  const next = inputFilter.value === key ? null : key
  if (stage.value !== 'all') stage.value = 'all'
  await nextTick()
  inputFilter.value = next
}

// 販売の手入力フォーム
const showForm = ref(false)
const form = ref<SaleInput>({
  title: '',
  sold_at: todayLocal(),
  price: 0,
  kind: 'resale',
  note: '',
})

// 引き当て／紐付けドロワー（出品・販売の両方から開く）
type AllocTarget = { mode: 'listing'; data: Listing } | { mode: 'sale'; data: SaleProfit }
const allocating = ref<AllocTarget | null>(null)
function openListingAlloc(l: Listing) { allocating.value = { mode: 'listing', data: l } }
function openSaleAlloc(s: SaleProfit) { allocating.value = { mode: 'sale', data: s } }

// タグピッカーを開いている販売
const tagPickerSale = ref<SaleProfit | null>(null)
const tagPickerAnchor = ref<HTMLElement | null>(null)

// 履歴ドロワー
const timelineItemId = ref<string | null>(null)

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

// --- 粗利が出ていない販売の判定（sale_profit ビューの is_shipping_confirmed / unmatched をそのまま見るだけ。
//     金額の再計算はしていない）。私物は常に対象外（「利益の計算に入れない」） ---
function isPendingSale(s: SaleProfit): boolean {
  return !s.is_shipping_confirmed || (s.kind === 'resale' && s.unmatched === 1)
}

// --- 行の統一表現。出品（listing）と販売（sale）を同じ行の形で並べる ---
interface Row {
  kind: 'listing' | 'sale'
  id: string
  key: string
  date: string
  sale: SaleProfit | null
  listing: Listing | null
}

function listingRow(l: Listing): Row {
  return { kind: 'listing', id: l.mercari_item_id, key: 'l:' + l.mercari_item_id, date: l.first_seen_at, sale: null, listing: l }
}
function saleRow(s: SaleProfit): Row {
  return { kind: 'sale', id: s.id, key: 's:' + s.id, date: s.sold_at, sale: s, listing: null }
}

const rows = computed<Row[]>(() => {
  if (stage.value === 'listed') return listings.value.map(listingRow)
  if (stage.value === 'all') return [...listings.value.map(listingRow), ...sales.value.map(saleRow)]
  return sales.value.map(saleRow)
})

function rowDateDisplay(r: Row): string {
  return r.kind === 'listing' && r.listing ? r.listing.listed_at : r.date
}

/** 粗利が確定していない行（未確定）。並び替えの優先度づけに使う。私物は対象外 */
function rowUnresolved(r: Row): boolean {
  if (r.kind !== 'sale' || !r.sale) return false
  if (r.sale.kind === 'personal') return false
  return isPendingSale(r.sale)
}

function passesFilters(r: Row): boolean {
  if (!inPeriod(rowDateDisplay(r), period.value)) return false
  if (monthFilter.value && !rowDateDisplay(r).startsWith(monthFilter.value)) return false
  if (r.kind === 'sale' && r.sale) {
    const s = r.sale
    if (statusFilter.value && s.status !== statusFilter.value) return false
    if (inputFilter.value === 'needs_shipping' && s.is_shipping_confirmed) return false
    if (inputFilter.value === 'needs_link' && !(s.kind === 'resale' && s.unmatched === 1)) return false
    return matchesSearch(
      [s.title, s.note, s.buyer, ...s.model_codes, ...s.tags.map(t => t.name), ...s.inherited_tags.map(t => t.name)],
      searchText.value,
    )
  }
  if (r.kind === 'listing' && r.listing) {
    if (statusFilter.value) return false // 状態の絞り込みは販売行だけが対象
    if (inputFilter.value) return false // 利益の入力バンドは販売行だけが対象
    const l = r.listing
    return matchesSearch([l.title, ...l.model_codes, ...l.items.flatMap(it => [it.name, it.model_code])], searchText.value)
  }
  return true
}

// --- 並び替え（在庫タブと同じ形のセレクト）。既定は「未確定（粗利が出ていない行）が先、
//     次に日付降順」で、今までの挙動のまま。それ以外を選んだときだけ単純な並びに切り替える ---
type SortOption = 'default' | 'date_desc' | 'date_asc' | 'profit_desc' | 'profit_asc' | 'price_desc' | 'price_asc'
const sortOption = ref<SortOption>('default')

/** 粗利の並び替え用の値。私物・未確定（送料未入力／未紐付け）は値が無い扱いにして末尾へ送る */
function rowProfitValue(r: Row): number | null {
  if (r.kind === 'sale' && r.sale) {
    if (r.sale.kind === 'personal' || rowUnresolved(r)) return null
    return r.sale.gross_profit
  }
  if (r.kind === 'listing' && r.listing) return r.listing.expected_profit
  return null
}
function rowPriceValue(r: Row): number {
  return r.kind === 'sale' ? (r.sale?.price ?? 0) : (r.listing?.price ?? 0)
}

const filteredRows = computed(() => {
  const list = rows.value.filter(passesFilters)
  if (sortOption.value === 'date_desc' || sortOption.value === 'date_asc') {
    const dir = sortOption.value === 'date_desc' ? -1 : 1
    return list.sort((a, b) => {
      const ad = rowDateDisplay(a)
      const bd = rowDateDisplay(b)
      return ad === bd ? 0 : (ad < bd ? -1 : 1) * dir
    })
  }
  if (sortOption.value === 'profit_desc' || sortOption.value === 'profit_asc') {
    const dir = sortOption.value === 'profit_desc' ? -1 : 1
    return list.sort((a, b) => {
      const ap = rowProfitValue(a)
      const bp = rowProfitValue(b)
      if (ap === null && bp === null) return 0
      if (ap === null) return 1 // 値の無い行は常に末尾
      if (bp === null) return -1
      return (ap - bp) * dir
    })
  }
  if (sortOption.value === 'price_desc' || sortOption.value === 'price_asc') {
    const dir = sortOption.value === 'price_desc' ? -1 : 1
    return list.sort((a, b) => (rowPriceValue(a) - rowPriceValue(b)) * dir)
  }
  // 既定：未確定（粗利が出ていない行）が先、次に日付降順
  return list.sort((a, b) => {
    const au = rowUnresolved(a) ? 0 : 1
    const bu = rowUnresolved(b) ? 0 : 1
    if (au !== bu) return au - bu
    const ad = rowDateDisplay(a)
    const bd = rowDateDisplay(b)
    return ad === bd ? 0 : ad < bd ? 1 : -1
  })
})

// --- ツールバー右端の合計。いま表の中に見えている販売の売上合計（実績・見込みを分けない）。
//     見えている数と足し算が合わないと数え直したくなるため。出品中の段は成約前なので出さない ---
const toolbarRevenue = computed<number | null>(() => {
  if (stage.value === 'listed') return null
  return filteredRows.value.reduce((sum, r) => sum + (r.sale?.price ?? 0), 0)
})

function matchesStage(st: Stage, s: SaleProfit): boolean {
  if (st === 'to_ship') return s.status === 'waiting_shipment'
  if (st === 'in_transit') return s.status === 'shipped' || s.status === 'delivered'
  if (st === 'done') return s.status === 'completed'
  return true
}

function sumSaleTotals(rowsToSum: SaleProfit[]): SaleTotals {
  return realizedTotals(rowsToSum)
}

async function loadTotals() {
  if (!tagFilter.value || stage.value === 'listed') { totals.value = null; return }
  if (stage.value === 'all') {
    totals.value = await window.soroban.saleTotals({ tagId: tagFilter.value })
    return
  }
  // to_ship / in_transit / done は SaleFilter で直接絞れないため、既に読み込み済みの行を足すだけ（再計算はしない）
  totals.value = sumSaleTotals(sales.value)
}

async function load() {
  loaded.value = false
  if (stage.value === 'listed') {
    const base = await window.soroban.listListings({
      status: ['active', 'suspended'],
      onlyUnallocated: listedFilter.value === 'unallocated' || undefined,
    })
    // 「引き当て済み」はAPI側に絞り込みが無いためここで足す
    listings.value = listedFilter.value === 'allocated' ? base.filter(l => l.items.length > 0) : base
    sales.value = []
  } else if (stage.value === 'all') {
    const [ls, ss] = await Promise.all([
      // 売却済みは販売行で在庫・原価を表示する。出品時の予約は販売へ移管済みなので、
      // 古い出品行を重ねると紐付け済みでも「未引き当て」と誤表示してしまう。
      window.soroban.listListings({ status: ['active', 'suspended', 'ended'] }),
      window.soroban.listSales(tagFilter.value ? { tagId: tagFilter.value } : undefined),
    ])
    listings.value = ls
    sales.value = ss
  } else {
    const filter: SaleFilter = {}
    if (tagFilter.value) filter.tagId = tagFilter.value
    const rowsFetched = await window.soroban.listSales(Object.keys(filter).length ? filter : undefined)
    sales.value = rowsFetched.filter(s => matchesStage(stage.value, s))
    listings.value = []
  }
  await loadTotals()
  await loadSaleItemInfo()
  loaded.value = true
  await loadCostCandidates()
  await loadProfitPreviews()
}

// --- 原価セルに出す在庫コード・id。sale_profit には個々の item_code が無いため、
//     紐付いている行だけ listSaleLines で引き直す（表示専用。金額の再計算はしない） ---
const saleItemCodes = ref<Map<string, string[]>>(new Map())
const saleItemIds = ref<Map<string, string[]>>(new Map())
async function loadSaleItemInfo() {
  const targets = sales.value.filter(s => s.item_count > 0)
  if (!targets.length) { saleItemCodes.value = new Map(); saleItemIds.value = new Map(); return }
  const pairs = await Promise.all(targets.map(async s => {
    const items = await window.soroban.listSaleLines(s.id)
    return [s.id, items] as const
  }))
  saleItemCodes.value = new Map(pairs.map(([id, items]) => [id, items.map(it => it.item_code)]))
  saleItemIds.value = new Map(pairs.map(([id, items]) => [id, items.map(it => it.id)]))
}

// --- 未紐付けの候補（確定はしない。表示のヒントだけ）。原価セルの「候補」sub と、
//     粗利プレビュー（紐付けると確定のケース）の両方で使う ---
type CostCandidate = { id: string; item_code: string; landed_cost: number; model_code: string | null }
const costCandidates = ref<Map<string, CostCandidate | null>>(new Map())
async function loadCostCandidates() {
  const targets = sales.value.filter(s => s.kind === 'resale' && s.item_count === 0 && isPendingSale(s))
  if (!targets.length) { costCandidates.value = new Map(); return }
  const pairs = await Promise.all(targets.map(async s => {
    const sugg = await window.soroban.suggestInventory(s.id, 1)
    const top = sugg[0] ?? null
    return [s.id, top ? { id: top.id, item_code: top.item_code, landed_cost: top.landed_cost, model_code: top.model_code } : null] as const
  }))
  costCandidates.value = new Map(pairs)
}
function costCandidateText(s: SaleProfit): string | null {
  if (s.item_count > 0 || s.kind !== 'resale') return null
  const c = costCandidates.value.get(s.id)
  if (c === undefined) return null
  if (c === null) return '候補なし'
  const matched = c.model_code != null && s.model_codes.includes(c.model_code)
  return `候補 ${c.item_code} ${yen(c.landed_cost)}${matched ? '（型番一致）' : ''}`
}

// --- 粗利プレビュー（未確定行だけ。件数が多いと重いので表示中の段階に限る）。
//     送料が未入力なら発送方法の最小・最大料金で2回、送料は決まっていて未紐付けなら
//     候補の在庫で1回。両方欠けている行は二重の推測になるため見積もらない ---
const profitPreviews = ref<Map<string, { min: number; max: number }>>(new Map())
function needsSinglePreview(s: SaleProfit): 'shipping' | 'link' | null {
  const shipMissing = !s.is_shipping_confirmed
  const linkMissing = s.kind === 'resale' && s.unmatched === 1
  if (shipMissing === linkMissing) return null // 両方 or どちらも欠けていない
  return shipMissing ? 'shipping' : 'link'
}
async function loadProfitPreviews() {
  const activeMethods = methods.value.filter(m => m.is_active)
  const targets = sales.value.filter(s => s.kind === 'resale' && needsSinglePreview(s) !== null)
  if (!targets.length) { profitPreviews.value = new Map(); return }
  const next = new Map<string, { min: number; max: number }>()
  await Promise.all(targets.map(async (s) => {
    const which = needsSinglePreview(s)
    if (which === 'shipping') {
      if (!activeMethods.length) return
      const ids = saleItemIds.value.get(s.id) ?? []
      const minM = activeMethods.reduce((a, b) => (a.fee <= b.fee ? a : b))
      const maxM = activeMethods.reduce((a, b) => (a.fee >= b.fee ? a : b))
      const [ra, rb] = await Promise.all([
        window.soroban.estimateSaleProfit({ price: s.price, shipping_method_id: minM.id, packaging_cost: s.packaging_cost, inventory_item_ids: ids }),
        window.soroban.estimateSaleProfit({ price: s.price, shipping_method_id: maxM.id, packaging_cost: s.packaging_cost, inventory_item_ids: ids }),
      ])
      next.set(s.id, { min: Math.min(ra.gross_profit, rb.gross_profit), max: Math.max(ra.gross_profit, rb.gross_profit) })
    } else if (which === 'link') {
      const cand = costCandidates.value.get(s.id)
      if (!cand) return
      const r = await window.soroban.estimateSaleProfit({
        price: s.price, shipping_method_id: s.shipping_method_id, packaging_cost: s.packaging_cost, inventory_item_ids: [cand.id],
      })
      next.set(s.id, { min: r.gross_profit, max: r.gross_profit })
    }
  }))
  profitPreviews.value = next
}
function profitWhyText(s: SaleProfit): string | null {
  const p = profitPreviews.value.get(s.id)
  if (!p) return null
  return p.min === p.max ? yen(p.min) : `${yen(p.min)}〜${yen(p.max)}`
}
function pendingReasonLabel(s: SaleProfit): string {
  return s.is_shipping_confirmed ? '紐付けると確定' : '送料を選ぶと確定'
}

async function loadTags() {
  allTags.value = await window.soroban.listTags()
}

onMounted(async () => {
  methods.value = await window.soroban.listShippingMethods()
  await loadTags()
  await loadProgress()
  await load()
})
watch(revision, loadTags)
watch(revision, loadProgress)
watch([revision, stage, listedFilter, tagFilter], load)

// --- サムネイル。読み込み失敗したら以後プレースホルダに固定する ---
const thumbFailed = ref<Set<string>>(new Set())
function rowThumbUrl(r: Row): string | null {
  return r.kind === 'sale' ? (r.sale?.thumb_url ?? null) : (r.listing?.thumb_url ?? null)
}
function showThumb(r: Row): boolean {
  return !!rowThumbUrl(r) && !thumbFailed.value.has(r.key)
}
function onThumbError(key: string) {
  thumbFailed.value = new Set(thumbFailed.value).add(key)
}
function rowModelCodes(r: Row): string[] {
  return r.kind === 'sale' ? (r.sale?.model_codes ?? []) : (r.listing?.model_codes ?? [])
}
function rowTitle(r: Row): string {
  return r.kind === 'sale' ? (r.sale?.title ?? '') : (r.listing?.title ?? '')
}
function placeholderChar(r: Row): string {
  const c = rowModelCodes(r)[0]?.[0] ?? rowTitle(r).trim().charAt(0)
  return (c || '?').toUpperCase()
}

/** 日付＋買い手（＋私物の注記）の1行テキスト。MM/DD 表記でメルカリのタイトルに寄せる */
function saleSubText(s: SaleProfit): string {
  const parts = s.purchased_at
    ? [`購入 ${s.purchased_at.slice(5, 10).replace('-', '/')}`]
    : [`${s.sold_at.slice(5, 10).replace('-', '/')} に売れた`]
  if (s.status === 'completed' && s.completed_at) {
    parts.push(`完了 ${s.completed_at.slice(5).replace('-', '/')}`)
  }
  if (s.buyer) parts.push(`買い手 ${s.buyer}`)
  if (s.kind === 'personal') parts.push('利益の計算に入れない')
  return parts.join(' ・ ')
}
function listingSubText(l: Listing): string {
  return `出品 ${l.listed_at.slice(5).replace('-', '/')} ・ 確認 ${formatSeen(l.last_seen_at)}`
}

// --- 履歴ドロワー。紐付いていれば最初の在庫を開く。未紐付けは開けない ---
function canOpenTimeline(s: SaleProfit): boolean {
  return s.item_count > 0
}
async function openTimelineForSale(s: SaleProfit) {
  if (!canOpenTimeline(s)) return
  const items = await window.soroban.listSaleLines(s.id)
  if (items[0]) timelineItemId.value = items[0].id
}
function onRowClick(r: Row) {
  if (r.kind === 'listing' && r.listing) openListingAlloc(r.listing)
  else if (r.kind === 'sale' && r.sale && r.sale.kind !== 'personal') openSaleAlloc(r.sale)
}
function rowClickable(r: Row): boolean {
  return r.kind === 'listing' || (r.kind === 'sale' && !!r.sale && r.sale.kind !== 'personal')
}

// --- 最終取り込み時刻（メルカリ・成功のみ）。この時刻より last_seen_at が古い出品は
//     「1ページ目に無かっただけ」の可能性があるので目立たせる ---
const lastMercariRun = ref<CollectorRun | null>(null)
async function loadLastMercariRun() {
  const dash = await window.soroban.getDashboard()
  const run = dash.lastRun
  lastMercariRun.value = run && run.source === 'mercari' && run.status === 'ok' ? run : null
}
onMounted(loadLastMercariRun)
watch(revision, loadLastMercariRun)

function seenStale(l: Listing): boolean {
  if (l.status !== 'active' && l.status !== 'suspended') return false
  const finishedAt = lastMercariRun.value?.finished_at
  if (!finishedAt) return false
  return new Date(l.last_seen_at).getTime() < new Date(finishedAt).getTime()
}

function formatSeen(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const STAGE_EMPTY: Record<Stage, { title: string; hint?: string }> = {
  listed: { title: '出品がありません', hint: 'メルカリの取り込みで出品中タブから見つかると、ここに並びます' },
  to_ship: { title: '発送待ちの販売はありません' },
  in_transit: { title: '配送中・受取待ちの販売はありません' },
  done: { title: '完了した販売はありません' },
  all: { title: '出品も販売もまだありません' },
}
const emptyTitle = computed(() => STAGE_EMPTY[stage.value].title)
const emptyHint = computed(() => STAGE_EMPTY[stage.value].hint)

// --- 横断検索・ホームからの遷移：段階を合わせ、検索語を引き継ぎ、該当行を一時的にハイライトする ---
const focusedId = ref<string | null>(null)

async function focusRow(id: string) {
  await load()
  await nextTick()
  focusedId.value = id
  document.querySelector(`[data-row-id="${id}"]`)?.scrollIntoView({ block: 'center' })
  setTimeout(() => { if (focusedId.value === id) focusedId.value = null }, 2000)
}

async function openFromMercariId(id: string) {
  await load()
  let target = listings.value.find(l => l.mercari_item_id === id)
  if (!target) {
    const all = await window.soroban.listListings({ status: ['active', 'suspended', 'sold', 'ended'] })
    target = all.find(l => l.mercari_item_id === id)
  }
  if (target) openListingAlloc(target)
}

watch(gotoPayload, async (p) => {
  if (!p) return
  if (p.stage === 'pending' || p.onlyPending) {
    // 旧「売れた・要入力」。新設計では段階をまたぐため「すべて」に開き、既定の並び（未確定が先）で見せる
    stage.value = 'all'
  } else if (p.stage) {
    stage.value = p.stage
  } else if (p.focusId) {
    stage.value = 'all' // どの段階にいても検索結果を必ず見つけられるようにする
  }
  if (p.month) {
    // グラフの月クリックは「すべて」。段階の変更で monthFilter を消す watch が先に走るので、
    // 1 tick 待ってから月を入れる
    if (!p.stage) stage.value = 'all'
    await nextTick()
    monthFilter.value = p.month
  }
  if (p.onlyUnallocated) listedFilter.value = 'unallocated'
  if (p.status) statusFilter.value = p.status
  if (p.search) searchText.value = p.search
  if (p.mercariItemId) await openFromMercariId(p.mercariItemId)
  if (p.focusId) await focusRow(p.focusId)
  gotoPayload.value = null
}, { immediate: true })

// --- 手入力登録 ---

async function submit() {
  if (!form.value.title.trim()) { toast('商品名を入力してください', 'warn'); return }
  if (!form.value.price || form.value.price <= 0) { toast('価格を入力してください', 'warn'); return }

  await window.soroban.createSale({
    ...form.value,
    title: form.value.title.trim(),
    note: form.value.note?.trim() || null,
  })

  form.value = { title: '', sold_at: todayLocal(), price: 0, kind: 'resale', note: '' }
  showForm.value = false
  await load()
  await loadProgress()
  changed()
}

// --- 送料・梱包材費 ---

async function setShipping(sale: SaleProfit, methodId: string) {
  await window.soroban.updateSale(sale.id, { shipping_method_id: methodId || null })
  await load()
  await loadProgress()
  changed()
}

// --- 出品時に決める発送方法（出品中の行） ---

async function setListingShipping(listing: Listing, methodId: string) {
  await window.soroban.setListingShipping(listing.mercari_item_id, methodId || null)
  await load()
  changed()
}

async function editPackaging(sale: SaleProfit) {
  const v = await ask('梱包材費（税込）', { initial: String(sale.packaging_cost), placeholder: '例: 100' })
  if (v === null) return
  const packaging_cost = Math.max(0, Math.round(Number(v) || 0))
  await window.soroban.updateSale(sale.id, { packaging_cost })
  await load()
  changed()
}

async function setKind(sale: SaleProfit, kind: SaleKind) {
  const label = kind === 'personal' ? '私物' : '転売'
  if (!await confirmDialog(`「${sale.title}」を${label}に変更しますか？`, { okLabel: '変更する' })) return
  await window.soroban.updateSale(sale.id, { kind })
  await load()
  await loadProgress()
  changed()
  if (stage.value !== 'all' && !sales.value.some(s => s.id === sale.id)) {
    toast(`${label}に変更しました。「すべて」で確認できます`, 'ok')
  }
}

async function editNote(sale: SaleProfit) {
  const v = await ask('メモ', { initial: sale.note ?? '', multiline: true })
  if (v === null) return
  await window.soroban.updateSale(sale.id, { note: v.trim() || null })
  await load()
  changed()
}

// --- 型番で自動紐付け ---

async function autoLinkPending() {
  const n = await window.soroban.autoLinkPending()
  if (n > 0) {
    toast(`${n}件を自動で紐付けました`, 'ok')
  } else {
    toast('型番が一致する在庫はありませんでした', 'warn')
  }
  await load()
  await loadProgress()
  changed()
}

// --- 型番で自動引き当て（出品中） ---

async function autoReserveListings() {
  const n = await window.soroban.autoReserveListings()
  if (n > 0) {
    toast(`${n}件を紐付けました`, 'ok')
  } else {
    toast('紐付けられる出品はありません', 'warn')
  }
  await load()
  await loadProgress()
  changed()
}

// --- タグの絞り込み候補：出どころで分ける（直接／仕入から／商品から／在庫から）。
//     現在読み込んでいる販売一覧に実際に出ているタグだけ（選択中のタグは消えないよう常に残す） ---
function tagOptionsOf(pick: (s: SaleProfit) => Tag[]): Array<{ id: string; name: string }> {
  const map = new Map<string, string>()
  for (const s of sales.value) for (const t of pick(s)) map.set(t.id, t.name)
  if (tagFilter.value && !map.has(tagFilter.value)) {
    const t = allTags.value.find(x => x.id === tagFilter.value)
    if (t) map.set(t.id, t.name)
  }
  return [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ja'))
}
const directTagOptions = computed(() => tagOptionsOf(s => s.tags))
const purchaseTagOptions = computed(() => tagOptionsOf(s => s.inherited_tags.filter(t => t.from === 'purchase')))
const productTagOptions = computed(() => tagOptionsOf(s => s.inherited_tags.filter(t => t.from === 'product')))
const inventoryTagOptions = computed(() => tagOptionsOf(s => s.inherited_tags.filter(t => t.from === 'inventory')))

// --- 派生タグの出どころ表示（chip-inherited の前に小さく出す印） ---
const TAG_ORIGIN_LABEL: Record<string, string> = { purchase: '仕入から', product: '商品から', inventory: '在庫から' }
const TAG_ORIGIN_MARK: Record<string, string> = { purchase: '仕', product: '品', inventory: '在' }
function tagOriginTitle(from?: Tag['from']): string {
  return from ? TAG_ORIGIN_LABEL[from] : ''
}
function tagOriginMark(from?: Tag['from']): string {
  return from ? TAG_ORIGIN_MARK[from] : ''
}

// --- タグ ---

function openTagPicker(sale: SaleProfit, e: MouseEvent) {
  tagPickerSale.value = sale
  tagPickerAnchor.value = e.currentTarget as HTMLElement
}

function closeTagPicker() {
  tagPickerSale.value = null
  tagPickerAnchor.value = null
}

async function onTagChange(tagIds: string[]) {
  if (!tagPickerSale.value) return
  const id = tagPickerSale.value.id
  await window.soroban.setSaleTags(id, tagIds)
  await load()
  tagPickerSale.value = sales.value.find(s => s.id === id) ?? null
}

async function onTagCreate(name: string) {
  if (!tagPickerSale.value) return
  const id = tagPickerSale.value.id
  const newTagId = await window.soroban.createTag(name)
  await loadTags()
  const tagIds = [...tagPickerSale.value.tags.map(t => t.id), newTagId]
  await window.soroban.setSaleTags(id, tagIds)
  await load()
  tagPickerSale.value = sales.value.find(s => s.id === id) ?? null
}

// --- 引き当て／紐付けドロワーの後始末。他の出品へ移した／段階を跨いで消えた場合も
//     開いているドロワーの中身は最新のまま保つ ---
async function onAllocateChanged() {
  await load()
  await loadProgress()
  changed()
  if (!allocating.value) return
  if (allocating.value.mode === 'listing') {
    const id = allocating.value.data.mercari_item_id
    let found = listings.value.find(l => l.mercari_item_id === id)
    if (!found) {
      const all = await window.soroban.listListings({ status: ['active', 'suspended', 'sold', 'ended'] })
      found = all.find(l => l.mercari_item_id === id)
    }
    allocating.value = found ? { mode: 'listing', data: found } : null
  } else {
    const id = allocating.value.data.id
    let found = sales.value.find(s => s.id === id)
    if (!found) {
      const all = await window.soroban.listSales()
      found = all.find(s => s.id === id)
    }
    allocating.value = found ? { mode: 'sale', data: found } : null
  }
}

// --- 出品の取り下げ ---
async function endListing(l: Listing) {
  if (!await confirmDialog(`「${l.title}」を取り下げますか？`, { okLabel: '取り下げる', danger: true })) return
  await window.soroban.endListing(l.mercari_item_id)
  await load()
  await loadProgress()
  changed()
}

async function remove(sale: SaleProfit) {
  if (!await confirmDialog(`「${sale.title}」を削除しますか？`, { okLabel: '削除する', danger: true })) return
  await window.soroban.deleteSale(sale.id)
  await load()
  await loadProgress()
  changed()
}

// --- メルカリで開く（標準ブラウザ。読み取り専用） ---
async function openMercariExternal(kind: 'item' | 'transaction', mercariItemId: string) {
  await window.soroban.openMercari(kind, mercariItemId)
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">売上</h1>
      <span class="grow" />
      <button class="primary" @click="showForm = !showForm">
        <Icon :name="showForm ? 'close' : 'plus'" :size="16" />
        {{ showForm ? '閉じる' : '販売を登録' }}
      </button>
    </div>

    <!-- 登録フォーム -->
    <div v-if="showForm" class="panel form">
      <div class="fields">
        <label class="field field-wide">
          <span>商品名</span>
          <input v-model="form.title" placeholder="商品名" />
        </label>
        <label class="field">
          <span>販売日</span>
          <input type="date" v-model="form.sold_at" />
        </label>
        <label class="field">
          <span>価格（税込・受け取った額）</span>
          <input type="number" v-model.number="form.price" />
        </label>
        <label class="field">
          <span>区分</span>
          <select v-model="form.kind">
            <option value="resale">転売</option>
            <option value="personal">私物</option>
          </select>
        </label>
        <label class="field field-wide">
          <span>メモ</span>
          <input v-model="form.note" placeholder="任意" />
        </label>
      </div>
      <p class="faint form-hint">金額はすべて税込。メルカリの表示どおりに入れてください</p>
      <div class="row">
        <span class="grow" />
        <button class="primary" @click="submit">登録</button>
      </div>
    </div>

    <SalesSummary />

    <!-- 進捗ストリップ（メルカリ側の状態）。押すと絞る -->
    <StageStrip :stages="stageCards" :active="stage" @select="onSelectStage" />

    <!-- 利益の入力（アプリ側の状態）。進捗とは別の軸 -->
    <p class="inputs-band">
      利益の入力：
      <button
        type="button"
        class="input-pill-btn"
        :class="{ active: inputFilter === 'needs_shipping' }"
        @click="toggleInputFilter('needs_shipping')"
      >
        <StatusPill tone="warn" :label="`送料未入力 ${progress?.inputs.needs_shipping ?? 0}`" />
      </button>
      <button
        type="button"
        class="input-pill-btn"
        :class="{ active: inputFilter === 'needs_link' }"
        @click="toggleInputFilter('needs_link')"
      >
        <StatusPill tone="warn" :label="`未紐付け ${progress?.inputs.needs_link ?? 0}`" />
      </button>
      <StatusPill tone="ok" :label="`入力済み ${progress?.inputs.done ?? 0}`" />
      <span class="grow" />
      <span class="faint">粗利が出ていない行は上に来ます</span>
    </p>

    <div class="toolbar">
      <select v-if="stage === 'listed'" v-model="listedFilter" title="紐付けの状態で絞り込む">
        <option value="all">すべて</option>
        <option value="unallocated">未紐付け</option>
        <option value="allocated">紐付け済み</option>
      </select>
      <select v-else v-model="statusFilter" title="取引の進み具合で絞り込む">
        <option value="">すべての状態</option>
        <option value="waiting_shipment">発送してください</option>
      </select>
      <select
        v-model="tagFilter"
        :disabled="stage === 'listed'"
        :title="stage === 'listed' ? '出品中はタグで絞れません' : undefined"
      >
        <option value="">すべてのタグ</option>
        <optgroup v-if="directTagOptions.length" label="直接">
          <option v-for="t in directTagOptions" :key="t.id" :value="t.id">{{ t.name }}</option>
        </optgroup>
        <optgroup v-if="purchaseTagOptions.length" label="仕入から">
          <option v-for="t in purchaseTagOptions" :key="t.id" :value="t.id">{{ t.name }}</option>
        </optgroup>
        <optgroup v-if="productTagOptions.length" label="商品から">
          <option v-for="t in productTagOptions" :key="t.id" :value="t.id">{{ t.name }}</option>
        </optgroup>
        <optgroup v-if="inventoryTagOptions.length" label="在庫から">
          <option v-for="t in inventoryTagOptions" :key="t.id" :value="t.id">{{ t.name }}</option>
        </optgroup>
      </select>
      <SearchBox v-model="searchText" placeholder="商品名・型番・メモ・タグ・買い手を検索" />
      <PeriodSelect v-model="period" />
      <button
        v-if="monthFilter"
        type="button"
        class="month-chip-btn"
        :title="`${monthFilter} の絞り込みを解除`"
        @click="monthFilter = null"
      >
        <StatusChip tone="brand" :label="`${monthFilter} ×`" />
      </button>
      <button v-if="stage === 'listed'" class="sm" @click="autoReserveListings">型番で自動紐付け</button>
      <button v-if="stage !== 'listed'" class="sm" @click="autoLinkPending">型番で自動紐付け</button>
      <select v-model="sortOption" title="並び替え">
        <option value="default">既定（未確定が先）</option>
        <option value="date_desc">日付が新しい順</option>
        <option value="date_asc">日付が古い順</option>
        <option value="profit_desc">粗利が高い順</option>
        <option value="profit_asc">粗利が低い順</option>
        <option value="price_desc">価格が高い順</option>
        <option value="price_asc">価格が低い順</option>
      </select>
      <span class="grow" />
      <span class="toolbar-count">
        {{ filteredRows.length }} 件<template v-if="toolbarRevenue !== null"> ・ 合計 {{ yen(toolbarRevenue) }}</template><template v-if="monthFilter"> ・ {{ monthFilter }} の販売</template>
      </span>
    </div>

    <div v-if="tagFilter && totals" class="panel totals-bar">
      <span class="faint">{{ totals.count }}件</span>
      <span class="num">実績売上 {{ yen(totals.revenue) }}</span>
      <span v-if="totals.forecast?.count" class="num faint">見込み：売上 {{ yen(totals.forecast.revenue) }} ・ 粗利 {{ yen(totals.forecast.gross_profit) }}</span>
      <span class="num dim">手数料 {{ yen(totals.total_fee) }}</span>
      <span class="num dim">送料 {{ yen(totals.total_shipping) }}</span>
      <span class="num dim">原価 {{ yen(totals.total_cost) }}</span>
      <strong class="num" :class="totals.gross_profit >= 0 ? 'profit' : 'loss'">
        粗利 {{ yen(totals.gross_profit) }}
      </strong>
    </div>

    <Skeleton v-if="!loaded" :rows="6" />

    <template v-else>
      <div v-if="filteredRows.length" class="panel work-panel">
        <div class="work-row work-row-hdr">
          <div class="cell-thumb"></div>
          <div class="cell-product">商品</div>
          <div class="cell-meta">
            <div class="cell-price num">価格</div>
            <div class="cell-ship">発送方法（送料）</div>
            <div class="cell-cost">{{ costHeaderLabel }}</div>
            <div class="cell-profit num">{{ profitHeaderLabel }}</div>
          </div>
          <div class="cell-ops"></div>
        </div>

        <div
          v-for="r in filteredRows" :key="r.key"
          :data-row-id="r.id"
          class="work-row"
          :class="{
            focused: focusedId === r.id,
            settled: r.kind === 'sale' && !!r.sale && !rowUnresolved(r),
            'needs-shipment': r.kind === 'sale' && r.sale?.status === 'waiting_shipment',
          }"
        >
          <div
            class="cell-thumb"
            :class="{ clickable: rowClickable(r) }"
            :title="rowClickable(r) ? '在庫の紐付けを開く' : undefined"
            :role="rowClickable(r) ? 'button' : undefined"
            :tabindex="rowClickable(r) ? 0 : undefined"
            @keydown.enter="onRowClick(r)"
            @keydown.space.prevent="onRowClick(r)"
            @click="onRowClick(r)"
          >
            <img
              v-if="showThumb(r)"
              class="thumb"
              :src="rowThumbUrl(r)!"
              alt=""
              loading="lazy"
              @error="onThumbError(r.key)"
            />
            <span v-else class="thumb-placeholder">{{ placeholderChar(r) }}</span>
          </div>

          <div class="cell-product">
            <div class="row-labels">
              <StatusPill v-if="r.kind === 'sale' && r.sale?.status && SALE_STATUS_PILL[r.sale.status]"
                :tone="SALE_STATUS_PILL[r.sale.status].tone" :label="SALE_STATUS_PILL[r.sale.status].label" />
              <StatusChip v-if="r.kind === 'listing' && r.listing" :tone="STATUS_TONE[r.listing.status]" :label="STATUS_LABEL[r.listing.status]" />
              <StatusChip v-if="r.sale && !r.sale.status" tone="neutral" :label="r.sale.source === 'manual' ? '手入力' : '状態未取得'" />
            </div>
            <span
              class="row-title"
              :class="{ clickable: rowClickable(r) }"
              :title="rowTitle(r)"
              :role="rowClickable(r) ? 'button' : undefined"
              :tabindex="rowClickable(r) ? 0 : undefined"
              @keydown.enter="onRowClick(r)"
              @keydown.space.prevent="onRowClick(r)"
              @click="onRowClick(r)"
            >{{ rowTitle(r) }}</span>

            <template v-if="r.kind === 'sale' && r.sale">
              <div class="row-sub">{{ saleSubText(r.sale) }}</div>
              <div class="chip-row">
                <button
                  v-if="r.sale.kind === 'resale'"
                  class="kind-toggle"
                  title="私物に変更する（確認あり）"
                  @click="r.sale && setKind(r.sale, 'personal')"
                >
                  <StatusChip tone="brand" label="転売" />
                </button>
                <StatusChip v-else tone="neutral" label="私物" />
                <StatusChip v-if="r.sale.source === 'collector'" tone="neutral" label="自動取得" />
                <CodeChip v-for="mc in r.sale.model_codes" :key="mc" kind="model" :code="mc" />
                <StatusChip v-for="t in r.sale.tags" :key="t.id" tone="info" :label="t.name" />
                <span
                  v-for="t in r.sale.inherited_tags" :key="'inh-' + t.id"
                  class="chip-inherited-wrap"
                  :title="tagOriginTitle(t.from)"
                >
                  <span class="chip-origin-mark">{{ tagOriginMark(t.from) }}</span>
                  <StatusChip tone="neutral" :label="t.name" class="chip-inherited" />
                </span>
              </div>
              <div v-if="r.sale.note" class="note-row">
                <Icon name="note" :size="14" class="icon-note" />
                <span class="note-label">メモ</span>
                <span class="note-text">{{ r.sale.note }}</span>
              </div>
            </template>

            <template v-else-if="r.listing">
              <div class="row-sub" title="更新日から推定">{{ listingSubText(r.listing) }}</div>
              <div class="chip-row">
                <CodeChip v-for="mc in r.listing.model_codes" :key="mc" kind="model" :code="mc" />
                <StatusChip v-if="r.listing.likes != null" tone="neutral" :label="`いいね ${r.listing.likes}`" />
                <StatusChip
                  v-if="seenStale(r.listing)"
                  tone="neutral"
                  label="前回の取り込みで見えず"
                  title="1ページ目に無かっただけかもしれません。売れていれば売上に出ます"
                />
              </div>
            </template>
          </div>

          <div class="cell-meta">
            <div class="cell-price num">
              {{ yen(r.kind === 'sale' ? (r.sale?.price ?? 0) : (r.listing?.price ?? 0)) }}
              <div v-if="r.kind === 'sale' && r.sale && r.sale.kind !== 'personal'" class="faint fee-line">手数料 −{{ yen(r.sale.fee) }}</div>
            </div>

            <div class="cell-ship">
              <template v-if="r.kind === 'listing' && r.listing">
                <select
                  class="ship-select"
                  :value="r.listing.shipping_method_id ?? ''"
                  @change="r.listing && setListingShipping(r.listing, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">未定</option>
                  <option v-for="m in methods" :key="m.id" :value="m.id">
                    {{ m.name }}　{{ yen(m.fee) }}
                  </option>
                </select>
              </template>
              <template v-else-if="r.kind === 'sale' && r.sale">
                <span v-if="r.sale.kind === 'personal'" class="faint">—</span>
                <span v-else-if="r.sale.shipping_source === 'actual' && r.sale.shipping_fee > 0" class="shipping-actual">
                  {{ yen(r.sale.shipping_fee) }}
                  <StatusChip tone="ok" label="実額" />
                </span>
                <select
                  v-else
                  class="ship-select"
                  :value="r.sale.shipping_method_id ?? ''"
                  :class="{ invalid: !r.sale.is_shipping_confirmed }"
                  :title="(r.sale.shipping_source === 'actual' && r.sale.shipping_fee === 0 && !r.sale.is_shipping_confirmed) ? 'メルカリ側の送料は0円でした。自分で払った送料の発送方法を選んでください' : undefined"
                  @change="r.sale && setShipping(r.sale, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">{{ (r.sale.shipping_source === 'actual' && r.sale.shipping_fee === 0 && !r.sale.is_shipping_confirmed) ? '選択…（メルカリ便以外）' : '選択…' }}</option>
                  <option v-for="m in methods" :key="m.id" :value="m.id">
                    {{ m.name }}　{{ yen(m.fee) }}
                  </option>
                </select>
              </template>
            </div>

            <div class="cell-cost">
              <span v-if="r.sale?.kind === 'personal'" class="faint">対象外（私物）</span>
              <AllocationCell v-else-if="r.sale"
                :linked="r.sale.item_count > 0" :cost="r.sale.cost"
                :codes="saleItemCodes.get(r.sale.id) ?? []" :automatic="!!r.sale.auto_linked"
                :hint="!r.sale.item_count ? costCandidateText(r.sale) : null"
                @open="openSaleAlloc(r.sale)" />
              <AllocationCell v-else-if="r.listing"
                :linked="r.listing.items.length > 0" :cost="r.listing.reserved_cost"
                :codes="r.listing.items.map(it => it.item_code)"
                :readonly="!['active', 'suspended'].includes(r.listing.status)"
                @open="openListingAlloc(r.listing)" />
            </div>

            <div class="cell-profit num">
              <Transition name="settle" mode="out-in">
                <span v-if="r.kind === 'sale' && r.sale && r.sale.kind === 'personal'" key="personal" class="faint">私物</span>
                <strong
                  v-else-if="r.kind === 'sale' && r.sale && !rowUnresolved(r)"
                  :key="'c' + r.sale.gross_profit"
                  :class="r.sale.gross_profit >= 0 ? 'profit' : 'loss'"
                >{{ !isRealized(r.sale) ? '見込み ' : '' }}{{ yen(r.sale.gross_profit) }}</strong>
                <div v-else-if="r.kind === 'sale' && r.sale" key="u" class="profit-na">
                  <span class="faint">{{ pendingReasonLabel(r.sale) }}</span>
                  <span v-if="profitWhyText(r.sale)" class="why">{{ profitWhyText(r.sale) }}</span>
                </div>
                <strong
                  v-else-if="r.kind === 'listing' && r.listing && r.listing.expected_profit != null"
                  :key="'l' + r.listing.expected_profit"
                  :class="r.listing.expected_profit >= 0 ? 'profit' : 'loss'"
                >{{ yen(r.listing.expected_profit) }}</strong>
                <span v-else key="d" class="faint">—</span>
              </Transition>
            </div>
          </div>

          <div class="cell-ops">
            <template v-if="r.kind === 'sale' && r.sale">
              <button
                v-if="r.sale.mercari_item_id"
                class="icon ghost"
                aria-label="メルカリで開く"
                title="メルカリの取引画面を開く"
                @click.stop="r.sale && openMercariExternal('transaction', r.sale.mercari_item_id)"
              >
                <Icon name="external" :size="14" />
              </button>
              <button class="sm ghost fade-btn" @click="r.sale && openTagPicker(r.sale, $event)" title="タグを編集する">タグ</button>
              <button v-if="canOpenTimeline(r.sale)" class="sm ghost" @click="openTimelineForSale(r.sale)">履歴</button>
              <button class="sm ghost fade-btn" @click="r.sale && editNote(r.sale)" title="メモを編集する">メモ</button>
              <button v-if="r.sale.kind !== 'personal'" class="sm ghost fade-btn" @click="r.sale && editPackaging(r.sale)" title="梱包材費を編集する">梱包</button>
              <button v-if="r.sale.kind === 'personal'" class="sm ghost fade-btn" @click="r.sale && setKind(r.sale, 'resale')">転売にする</button>
              <button v-if="stage !== 'all'" class="icon ghost" aria-label="削除" @click="r.sale && remove(r.sale)">
                <Icon name="trash" :size="16" />
              </button>
            </template>
            <template v-else-if="r.listing && (r.listing.status === 'active' || r.listing.status === 'suspended')">
              <button
                class="icon ghost"
                aria-label="メルカリで開く"
                title="メルカリの商品ページを開く"
                @click.stop="r.listing && openMercariExternal('item', r.listing.mercari_item_id)"
              >
                <Icon name="external" :size="14" />
              </button>
              <button class="sm ghost" @click="r.listing && endListing(r.listing)">取り下げ</button>
            </template>
          </div>
        </div>
      </div>

      <EmptyState
        v-else-if="searchText || monthFilter || statusFilter || inputFilter || period !== 'all'"
        title="検索条件に一致する行がありません"
      />
      <EmptyState
        v-else
        :title="emptyTitle"
        :hint="emptyHint"
      />
    </template>

    <AllocateDrawer
      :open="!!allocating"
      :mode="allocating?.mode ?? 'sale'"
      :listing="allocating?.mode === 'listing' ? allocating.data : null"
      :sale="allocating?.mode === 'sale' ? allocating.data : null"
      @close="allocating = null"
      @changed="onAllocateChanged"
    />

    <TagPicker
      :open="!!tagPickerSale"
      :anchor="tagPickerAnchor"
      :all-tags="allTags"
      :selected="tagPickerSale?.tags.map(t => t.id) ?? []"
      @change="onTagChange"
      @create="onTagCreate"
      @close="closeTagPicker"
    />

    <TimelineDrawer
      :open="!!timelineItemId"
      :inventory-item-id="timelineItemId"
      @close="timelineItemId = null"
    />
  </div>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-bottom: 16px;
}
.field-wide input { width: 320px; }
.form-hint { margin: -4px 0 0; }

/* 派生タグ（仕入・商品・在庫から引き継いだもの）は直接付けたタグより少し薄く見せる。
   先頭の小さな記号で出どころを示す */
.chip-inherited { opacity: .7; }
.chip-inherited-wrap {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.chip-origin-mark {
  font-size: 10px;
  color: var(--text-faint);
}

/* --- 利益の入力バンド --- */
.inputs-band {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 12px;
  font-size: var(--fs-13);
  color: var(--text-dim);
}
.input-pill-btn {
  display: block;
  background: transparent;
  border: none;
  padding: 0;
  height: auto;
  cursor: pointer;
}
.input-pill-btn:hover:not(:disabled) { background: transparent; filter: brightness(.97); }
.input-pill-btn.active { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: 999px; }

.totals-bar {
  display: flex;
  align-items: baseline;
  gap: 16px;
  padding: 10px 20px;
  margin-bottom: 16px;
  font-size: var(--fs-13);
}

/* --- 作業リスト（表の代わりの行グリッド） --- */
.work-panel { padding: 6px 8px; overflow: hidden; }
.work-row {
  display: grid;
  grid-template-columns: 48px minmax(180px, 1fr) 80px 160px 170px 110px 200px;
  grid-template-areas: "thumb product price ship cost profit ops";
  align-items: center;
  gap: 10px;
  padding: 10px 10px;
  border-top: 1px solid var(--line-soft);
}
.work-row:first-child { border-top: 0; }
.work-row-hdr {
  padding: 6px 10px;
  color: var(--text-faint);
  font-size: var(--fs-12);
}
.work-row.focused { background: var(--brand-soft); }
/* 資産が確定した行（粗利確定・私物）はグレーに沈める。未確定の行が相対的に目立つ */
.work-row.settled { background: var(--surface-hi); }
/* 発送してください（waiting_shipment）は今日の作業として目立たせる */
.work-row.needs-shipment { box-shadow: inset 3px 0 0 var(--warn); }

.cell-thumb { grid-area: thumb; }
.cell-product { grid-area: product; min-width: 0; overflow: hidden; }
.cell-meta { display: contents; }
.cell-price { grid-area: price; }
.cell-ship { grid-area: ship; min-width: 0; }
.cell-cost {
  grid-area: cost;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}
.cell-profit { grid-area: profit; }
.cell-ops {
  grid-area: ops;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 6px;
  row-gap: 4px;
  white-space: nowrap;
}
.cell-ops button { white-space: nowrap; }

@media (max-width: 1199px) {
  .work-row {
    grid-template-columns: 48px minmax(0, 1fr);
    grid-template-areas:
      "thumb product"
      "meta  meta"
      "ops   ops";
    row-gap: 8px;
  }
  .cell-meta {
    grid-area: meta;
    display: flex;
    flex-wrap: wrap;
    gap: 10px 20px;
  }
  .cell-ops {
    grid-area: ops;
    justify-content: flex-end;
  }
  .cell-price, .cell-ship, .cell-cost { min-width: 140px; }
}

.thumb-cell,
.cell-thumb { padding-right: 0; }
.thumb, .thumb-placeholder {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.thumb { object-fit: cover; display: block; }
.thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-weight: 700;
  font-size: var(--fs-14);
}

.clickable { cursor: pointer; }

.fee-line { font-size: var(--fs-12); margin-top: 2px; }

.chip-row .fade-btn { padding: 3px 6px; }

.fade-btn {
  padding: 3px 6px;
  opacity: .35;
  transition: opacity var(--dur) var(--ease);
}
.work-row:hover .fade-btn { opacity: 1; }

.kind-toggle {
  flex-shrink: 0;
  display: block;
  background: transparent;
  border: none;
  padding: 0;
  height: auto;
  cursor: pointer;
}
.kind-toggle:hover:not(:disabled) { background: transparent; }

.month-chip-btn {
  flex-shrink: 0;
  display: block;
  background: transparent;
  border: none;
  padding: 0;
  height: auto;
  cursor: pointer;
}
.month-chip-btn:hover:not(:disabled) { background: transparent; }

.ship-select {
  width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}


.shipping-actual {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}

.profit-na {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}
.profit-na .why {
  font-size: var(--fs-11);
  color: var(--text-faint);
  font-weight: 500;
}
</style>
