<script setup lang="ts">
import { isRealized, realizedTotals } from '../../shared/recognition'
// 売上タブ：出品中（メルカリの出品）と販売（成約済み）を1つの作業リストにまとめる。
// 上＝進捗ストリップ（getSalesProgress）で段階を選ぶ、その下＝利益の入力（送料未入力／未紐付け）で絞る、
// 下＝行のグリッド（1行1販売）。既定の並びは「未確定（粗利が出ていない行）が先、次に日付降順」。1件10秒。
import { ref, reactive, onMounted, onBeforeUnmount, computed, watch, inject, nextTick, type Ref } from 'vue'
import type {
  SaleProfit, ShippingMethod, SaleKind, SaleInput, SaleFilter, SaleTotals, Tag,
  Listing, ListingStatus, CollectorRun, SaleStatus, SalesProgress, SalesChannel, InventoryItem,
} from '../../shared/types'
import { CHANNEL_LABEL, LISTING_STATUS_LABEL, SALE_KIND_LABEL } from '../../shared/types'
import { todayLocal } from '../../shared/date'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import StatusPill from '../components/StatusPill.vue'
import CodeChip from '../components/CodeChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import TagPicker from '../components/TagPicker.vue'
import ActionSheet from '../components/ActionSheet.vue'
import TimelineDrawer from '../components/TimelineDrawer.vue'
import AllocateDrawer from '../components/AllocateDrawer.vue'
import AllocationCell from '../components/AllocationCell.vue'
import SalesSummary from '../components/SalesSummary.vue'
import SearchBox, { matchesSearch } from '../components/SearchBox.vue'
import PeriodSelect, { inPeriod, type Period } from '../components/PeriodSelect.vue'
import StageStrip, { type StageStripStage } from '../components/StageStrip.vue'
import type { PromptOptions } from '../components/InputDialog.vue'
import { yen, shortDate, dateTime } from '../format'

/** 進捗ストリップの段階（メルカリ側の状態）。旧「未処理／完了」の段階タブは廃止し、
    利益の入力（送料未入力／未紐付け）は下の inputs バンドで別軸として扱う */
type Stage = 'listed' | 'to_ship' | 'in_transit' | 'done' | 'all'
/** 利益の入力バンドの絞り込みキー。'pending' は「送料未入力 または 未紐付け」（App の下のタブ・縦のナビのバッジと同じ未処理）。
    下のタブ・縦のナビから開いたときだけ入り、2 つのピルが両方とも選ばれた形で見える（スマホ幅は「要対応」チップ） */
type InputFilterKey = 'needs_shipping' | 'needs_link' | 'pending'

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
  /** 出品中タブの「出品の状態」。既定は 'active'。停止中を見せたい要対応だけが渡す */
  listingStatus?: ListingStatus
}

const ask = inject<(title: string, opts?: PromptOptions) => Promise<string | null>>('prompt')!
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn', action?: { label: string; run: () => void | Promise<void> }) => void>('toast')!

const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
const gotoPayload = inject<Ref<SalesGotoPayload | null>>('gotoPayload', ref(null))
// 下のタブ・縦のナビから開かれたか（goto の指定＝ホームの通知・検索結果などが付いていない）。
// 付いていれば、その指定が優先（要対応で開かない）。判定は開いた瞬間の 1 回だけ（このあと watch(gotoPayload) が null に戻す前に読む）
const openedFromTab = !gotoPayload.value

const STATUS_TONE: Record<ListingStatus, 'brand' | 'neutral' | 'ok' | 'info'> = {
  active: 'info', suspended: 'neutral', sold: 'ok', ended: 'neutral',
}

// --- 販売の状態ピル（StatusPill）。発送してください＝solid-info、受取評価待ち＝info、
//     取引完了＝solid-ok（意味の強い状態は塗り）。それ以外は薄いまま ---
const SALE_STATUS_PILL: Record<SaleStatus, { tone: 'solid-info' | 'info' | 'solid-ok' | 'warn'; label: string; title?: string }> = {
  waiting_payment: { tone: 'warn', label: '支払い待ち' },
  waiting_shipment: { tone: 'solid-info', label: '発送してください' },
  shipped: { tone: 'info', label: '受取評価待ち', title: '発送済み。買い手の受取待ち' },
  delivered: { tone: 'info', label: '評価してください', title: '買い手が受け取りました。こちらの評価待ち' },
  completed: { tone: 'solid-ok', label: '取引完了', title: '受取評価が終わり、売上金が入りました' },
}

const stage = ref<Stage>('to_ship')
type ListedFilter = 'all' | 'unallocated' | 'allocated'
const listedFilter = ref<ListedFilter>('all')
/** 出品の状態で絞り込む（すべて／出品中／出品停止中）。既定は「出品中」（停止中は普段見なくてよい）。
    「すべて」は出品中タブの守備範囲のまま（sold・endedは含めない） */
type ListingStatusFilter = 'all' | 'active' | 'suspended'
const listingStatusFilter = ref<ListingStatusFilter>('active')
const tagFilter = ref('')
/** 出品先で絞り込む（すべて／メルカリ／Yahoo!フリマ）。出品・販売の両方に効く */
const channelFilter = ref<SalesChannel | ''>('')
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
/** 段階チップ列の中で「要対応」を表すキー（段階の名前とぶつからないもの） */
const PENDING_KEY = 'pending'
/** 未処理（送料未入力 または 未紐付け）の件数。App の下のタブ・縦のナビのバッジと同じ呼び出し（listSales({ onlyPending })）で数える。
    getSalesProgress の inputs は転売だけの数なので足し合わせても合わない（私物の送料未入力がバッジには入る） */
const pendingTotal = ref(0)
async function loadProgress() {
  const [p, pending] = await Promise.all([
    window.soroban.getSalesProgress(),
    window.soroban.listSales({ onlyPending: true }),
  ])
  progress.value = p
  pendingTotal.value = pending.length
}

// --- スマホ幅かどうか（段階チップに「要対応」を足す・グラフの入口を出す、など画面の幅で中身が変わるものに使う） ---
const MOBILE_QUERY = '(max-width: 767px)'
const isMobile = ref(typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_QUERY).matches)
let mobileMql: MediaQueryList | undefined
function onMobileChange(e: { matches: boolean }) { isMobile.value = e.matches }
onMounted(() => {
  if (typeof window.matchMedia !== 'function') return
  mobileMql = window.matchMedia(MOBILE_QUERY)
  isMobile.value = mobileMql.matches
  mobileMql.addEventListener('change', onMobileChange)
})
onBeforeUnmount(() => mobileMql?.removeEventListener('change', onMobileChange))

const stageCards = computed<StageStripStage[]>(() => {
  const p = progress.value
  const cards: StageStripStage[] = [
    { key: 'listed', label: '出品中', short: '出品中', count: p?.listed.count ?? 0, money: p ? p.listed.expected_profit : null, sub: `未紐付け ${p?.listed.unallocated ?? 0}` },
    { key: 'to_ship', label: '売れた・発送する', short: '発送する', count: p?.to_ship.count ?? 0, money: p ? p.to_ship.revenue : null, sub: '見込み売上・発送待ち' },
    { key: 'in_transit', label: '配送中・受取待ち', short: '配送中', count: p?.in_transit.count ?? 0, money: p ? p.in_transit.revenue : null, sub: '見込み売上・取引完了待ち' },
    { key: 'done', label: '取引完了', short: '取引完了', count: p?.completed_this_month.count ?? 0, money: p ? p.completed_this_month.revenue : null, sub: '今月・反映済み' },
    { key: 'all', label: 'すべて', short: 'すべて', count: p?.all ?? 0, sub: '出品も含む' },
  ]
  // スマホ幅だけ、先頭に「要対応」（段階は「すべて」＋送料未入力 or 未紐付け）。デスクトップ幅は 2 つのピルで同じことを押せる
  if (isMobile.value) cards.unshift({ key: PENDING_KEY, label: '要対応', short: '要対応', count: pendingTotal.value, tone: 'warn' })
  return cards
})
/** いま塗るチップ。要対応で絞っているあいだは「要対応」、それ以外は段階 */
const stripActive = computed<string>(() => (inputFilter.value === 'pending' ? PENDING_KEY : stage.value))
function onSelectStage(key: string) {
  if (key === PENDING_KEY) { void toggleInputFilter('pending'); return }
  // 「すべて」のまま利益の入力の絞り込み（要対応など）が効いているとき、もう一度「すべて」を押したら外して全部を見せる
  if (stage.value === key && key === 'all') { inputFilter.value = null; return }
  stage.value = key as Stage
}

// --- 紐付けの入口は全ステップ共通。利益だけ実績／見込みを区別する。
//     出品と販売が混ざる「すべて」はどちらの行にも通じる既定の言い回しのまま ---
const costHeaderLabel = '在庫の紐付け・原価'
const profitHeaderLabel = computed(() => stage.value === 'listed' ? '見込み粗利' : '粗利')

// --- スマホ幅：絞り込みは「絞り込み」ボタンの中にまとめる（デスクトップ幅では今までどおり常に並ぶ）。
//     閉じていても、いくつ効いているかはボタンの数字で分かる ---
const filtersOpen = ref(false)
const activeFilterCount = computed(() => {
  let n = 0
  if (stage.value === 'listed') {
    if (listingStatusFilter.value !== 'active') n++
    if (listedFilter.value !== 'all') n++
  } else {
    if (statusFilter.value) n++
    if (tagFilter.value) n++
  }
  if (channelFilter.value) n++
  if (period.value !== 'all') n++
  if (monthFilter.value) n++
  // 要対応（pending）は段階チップの「要対応」で見えているので数えない。送料未入力だけ・未紐付けだけと、並び替えは、シートの中にあるので数える
  if (inputFilter.value && inputFilter.value !== 'pending') n++
  if (sortOption.value !== 'default') n++
  return n
})

/** 利益の入力バンドのピルをクリック：「すべて」に開いて絞る（もう一度押すと解除）。
    要対応（両方）が選ばれているときに片方を押したら、その片方だけに絞る */
async function toggleInputFilter(key: InputFilterKey) {
  const next = inputFilter.value === key ? null : key
  if (stage.value !== 'all') stage.value = 'all'
  await nextTick()
  inputFilter.value = next
}
/** 利益の入力のピルを「選ばれている」と見せるか。要対応（両方）のときは 2 つとも */
function inputPillOn(key: 'needs_shipping' | 'needs_link'): boolean {
  return inputFilter.value === key || inputFilter.value === 'pending'
}
const inputPills = computed(() => [
  { key: 'needs_shipping' as const, label: `送料未入力 ${progress.value?.inputs.needs_shipping ?? 0}` },
  { key: 'needs_link' as const, label: `未紐付け ${progress.value?.inputs.needs_link ?? 0}` },
])

// スマホ幅だけ：直近12か月のグラフの開閉（上のバーの「グラフ」ボタン。覚えない＝開き直すと閉じている）
const chartOpen = ref(false)

// 販売の手入力フォーム
const showForm = ref(false)
const form = ref<SaleInput>({
  title: '',
  sold_at: todayLocal(),
  price: 0,
  kind: 'resale',
  channel: 'mercari',
  note: '',
})
/**
 * 販売手数料（実額）の入力欄。文字列のまま持ち、空欄と '0' を区別する
 * （0 もキャンペーンなどで実際にある値）。空欄なら送らず、率からの計算に任せる
 */
const feeInput = ref('')
/** 商品ID（任意）。入れると一覧に出品先ページへのリンクボタンが出る */
const itemIdInput = ref('')

/**
 * 金額の手入力を正規化する。利用者は Yahoo!フリマ・メルカリの画面からそのままコピペするため、
 * 前後の空白・先頭の ¥ ￥・末尾の円・正しい位置の桁区切り , ，・全角数字（２９４ → 294）は受け入れて
 * 整数円に直す。記号を位置に関係なく全部消してから読むと、壊れた表記（`1,00円` → 100、`1円000` → 1000
 * など）を黙って別の金額に変えてしまうため、受け入れる形そのもの（¥は先頭に1つだけ・円は末尾に1つだけ・
 * 桁区切りは3桁ごとの正しい位置だけ）を1本の正規表現で確かめてから数字を取り出す。
 * 「Number(...) || 0」で黙って0円にしないための唯一の入口（新規登録・実額直しの両方で使う）。
 * 呼び出し側は空欄をここに渡さない（空欄と'0'の区別は呼び出し側の責務のまま）
 */
function normalizeYenInput(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = raw.trim()
  // 全角数字だけ先に半角へ直す（¥・円・桁区切りの位置はここでは変えない）
  const halfWidth = trimmed.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  if (halfWidth.startsWith('-')) {
    return { ok: false, error: '金額はマイナスにできません' }
  }
  if (halfWidth.includes('.')) {
    return { ok: false, error: '金額は整数（円）で入力してください（小数は使えません）' }
  }
  // 受け入れる形は「(¥|￥)? 数字（桁区切りは3桁ごとの正しい位置だけ） 円?」だけ。
  // ¥・数字・円の並び順と回数も同時に確かめる（`円¥100` や `¥1¥2` は弾く）
  const m = /^([¥￥])?(\d{1,3}(?:[,，]\d{3})+|\d+)(円)?$/.exec(halfWidth)
  if (!m) {
    return { ok: false, error: `「${trimmed}」は金額として読み取れません。数字だけにしてください` }
  }
  const digits = m[2].replace(/[,，]/g, '')
  return { ok: true, value: Number(digits) }
}

/**
 * 商品IDの形を保存前に確かめる（main の channelPageUrl と同じ正規表現）。
 * 出品先ページを開いたときに初めて気づいても訂正する手段が無いため、保存時に弾く
 */
const CHANNEL_ITEM_ID_PATTERN: Record<SalesChannel, RegExp> = {
  mercari: /^m\d{9,}$/,
  yahoo: /^[a-z]\d{8,}$/,
}
function itemIdMismatchError(channel: SalesChannel, id: string): string | null {
  if (CHANNEL_ITEM_ID_PATTERN[channel].test(id)) return null
  const example = channel === 'mercari' ? 'm123456789' : 'z12345678'
  return `商品IDの形が${CHANNEL_LABEL[channel]}と合いません（例: ${example}）`
}

// --- 出品先ごとの手数料率（設定 fee_rate_bp / fee_rate_bp_yahoo）。フォームの見込みプレビュー専用で、
//     登録自体は main 側が sale.fee_rate_bp に焼き付ける（ここでは再計算しない） ---
const channelFeeRates = ref<Record<SalesChannel, number>>({ mercari: 1000, yahoo: 500 })
async function loadChannelFeeRates() {
  const s = await window.soroban.getSettings()
  channelFeeRates.value = {
    mercari: Number(s.fee_rate_bp ?? 1000),
    yahoo: Number(s.fee_rate_bp_yahoo ?? 500),
  }
}
/**
 * 手入力フォームの見込み（手数料・粗利）。まだ送料・原価が決まっていない新規販売なので、
 * 価格と出品先の手数料率だけで見た「登録直後の見込み」。選ぶ・打つたびにその場で変わる。
 * 手数料（実額）を入れているときはそちらをそのまま使う（率では計算しない。0 も実額）
 */
const formPreview = computed(() => {
  const price = Math.max(0, Math.round(Number(form.value.price) || 0))
  const feeTrimmed = feeInput.value.trim()
  const feeParsed = feeTrimmed === '' ? null : normalizeYenInput(feeTrimmed)
  const feeOverride = feeParsed && feeParsed.ok ? feeParsed.value : null
  const bp = channelFeeRates.value[form.value.channel ?? 'mercari']
  const fee = feeOverride !== null ? feeOverride : Math.floor(price * bp / 10000)
  return { fee, profit: price - fee, isActual: feeOverride !== null }
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

/** 出品先（既存の販売・出品は移行の既定で 'mercari'） */
function rowChannel(r: Row): SalesChannel {
  return (r.kind === 'sale' ? r.sale?.channel : r.listing?.channel) ?? 'mercari'
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
  if (channelFilter.value && rowChannel(r) !== channelFilter.value) return false
  if (r.kind === 'sale' && r.sale) {
    const s = r.sale
    if (statusFilter.value && s.status !== statusFilter.value) return false
    if (inputFilter.value === 'needs_shipping' && s.is_shipping_confirmed) return false
    if (inputFilter.value === 'needs_link' && !(s.kind === 'resale' && s.unmatched === 1)) return false
    // 要対応＝送料未入力 または 未紐付け。App のバッジ（listSales の onlyPending）と同じ条件（isPendingSale）
    if (inputFilter.value === 'pending' && !isPendingSale(s)) return false
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

// --- 発送方法を選んだあとの「済」の行 ---
// 送料未入力の行は、選んで読み直すと一覧から外れる（「送料未入力」の絞り込み）か、既定の並びで下へ移る
// （粗利が出た行は「未確定が先」の外へ出る）。どちらも行が黙って消え、下の行が指の下にせり上がる（誤タップのもと）。
// そこで、選んだ行は読み直しの前に「済　<発送方法> ¥<料金>」に替えてその場に残し、1.2 秒後に高さを 180ms で畳んでから外す。
// 料金は表示だけで、計算には使わない（粗利などは main が返したものをそのまま出す）。
const HOLD_MS = 1200
const COLLAPSE_MS = 180 // style.css の --dur と同じ
interface Held {
  seq: number
  row: Row            // 押した時点の行。読み直しで消えても描ける
  index: number       // 一覧の中での位置（表示している行の中での位置）
  height: number      // 押した時点の行の高さ。「済」に替えても動かさない
  label: string       // 「ゆうパケット ¥200」
  reloaded: boolean   // 読み直しが終わった
  elapsed: boolean    // 1.2 秒たった
  collapsing: boolean
}
const held = reactive(new Map<string, Held>())
let holdSeq = 0
const holdTimers = new Set<ReturnType<typeof setTimeout>>()
function later(fn: () => void, ms: number) {
  const t = setTimeout(() => { holdTimers.delete(t); fn() }, ms)
  holdTimers.add(t)
}
onBeforeUnmount(() => { holdTimers.forEach(clearTimeout); holdTimers.clear() })
function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface DisplayRow { row: Row; hold: Held | null }
/** 読み直した行のうち「済」にした行は本物を出さず、押した時点の行を元の位置に差す。skipKey の「済」は無いものとして並べる */
function mergeHeld(real: Row[], skipKey?: string): DisplayRow[] {
  const out: DisplayRow[] = real
    .filter(r => r.key === skipKey || !held.has(r.key))
    .map(row => ({ row, hold: null }))
  const holds = [...held.values()].filter(h => h.row.key !== skipKey).sort((a, b) => a.index - b.index)
  for (const h of holds) out.splice(Math.min(h.index, out.length), 0, { row: h.row, hold: h })
  return out
}
const displayRows = computed<DisplayRow[]>(() => mergeHeld(filteredRows.value))

// 段階・絞り込み・並び替えを変えたら、残していた「済」は捨てる（別の一覧に前の行が混ざらないように）
watch(
  [stage, listedFilter, listingStatusFilter, tagFilter, searchText, period, monthFilter, inputFilter, statusFilter, channelFilter, sortOption],
  () => held.clear(),
)

function beginHold(row: Row, height: number, label: string) {
  const seq = ++holdSeq
  held.set(row.key, {
    seq, row, height, label,
    index: Math.max(displayRows.value.findIndex(d => d.row.key === row.key), 0),
    reloaded: false, elapsed: false, collapsing: false,
  })
  later(() => {
    const h = held.get(row.key)
    if (!h || h.seq !== seq) return // 早く外れた／同じ行でやり直した
    h.elapsed = true
    settleHold(row.key)
  }, HOLD_MS)
}
// 1.2 秒たち、読み直しも終わったら畳む。どちらかが遅れたら、遅れた方を待つ（読み直し前の古い行を出さないため）
function settleHold(key: string) {
  const h = held.get(key)
  if (!h || h.collapsing || !h.reloaded || !h.elapsed) return
  if (reducedMotion()) { held.delete(key); return }
  const seq = h.seq
  h.collapsing = true
  later(() => { if (held.get(key)?.seq === seq) held.delete(key) }, COLLAPSE_MS)
}
function endReload(key: string) {
  const h = held.get(key)
  if (!h) return
  h.reloaded = true
  // 読み直しても同じ位置にいる＝動かない行。「済」をやめて本物の行に戻す（粗利の確定の動きがそのまま見える）
  const at = mergeHeld(filteredRows.value, key).findIndex(d => d.row.key === key)
  if (at === h.index) held.delete(key)
  else settleHold(key)
}

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

/**
 * 読み直す。既定は一覧を Skeleton に戻してから（段階や絞り込みが変わったときは前の中身を見せない）。
 * quiet のときは一覧をそのままにして中身だけ入れ替える（行を「済」にして残している間に、一覧ごと消さないため）。
 * watch / @changed に直接渡さないこと（引数が quiet に入る）。
 */
async function load(quiet = false) {
  if (!quiet) loaded.value = false
  if (stage.value === 'listed') {
    const base = await window.soroban.listListings({
      status: listingStatusFilter.value === 'all' ? ['active', 'suspended'] : [listingStatusFilter.value],
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
//     紐付いている行だけ listSaleLinesBulk でまとめて引き直す（表示専用。金額の再計算はしない）。
//     1 回の上限は 500 件なので、それを超えたら 500 件ずつ順に呼ぶ ---
const saleItemCodes = ref<Map<string, string[]>>(new Map())
const saleItemIds = ref<Map<string, string[]>>(new Map())
const SALE_LINES_BULK_CHUNK = 500
async function loadSaleItemInfo() {
  const targets = sales.value.filter(s => s.item_count > 0)
  if (!targets.length) { saleItemCodes.value = new Map(); saleItemIds.value = new Map(); return }
  const ids = targets.map(s => s.id)
  const byId: Record<string, InventoryItem[]> = {}
  for (let i = 0; i < ids.length; i += SALE_LINES_BULK_CHUNK) {
    Object.assign(byId, await window.soroban.listSaleLinesBulk(ids.slice(i, i + SALE_LINES_BULK_CHUNK)))
  }
  // キーが無い販売（紐付けが外れた直後など）は、これまでの listSaleLines が [] を返していたのと同じ空として持つ
  saleItemCodes.value = new Map(ids.map(id => [id, (byId[id] ?? []).map(it => it.item_code)]))
  saleItemIds.value = new Map(ids.map(id => [id, (byId[id] ?? []).map(it => it.id)]))
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
    // 手数料が実額で確定しているなら率では見積もらず、その実額をそのまま使う（0 も実額）
    const feeOverride = s.fee_source === 'actual' ? s.fee : undefined
    if (which === 'shipping') {
      if (!activeMethods.length) return
      const ids = saleItemIds.value.get(s.id) ?? []
      const minM = activeMethods.reduce((a, b) => (a.fee <= b.fee ? a : b))
      const maxM = activeMethods.reduce((a, b) => (a.fee >= b.fee ? a : b))
      const [ra, rb] = await Promise.all([
        window.soroban.estimateSaleProfit({ price: s.price, shipping_method_id: minM.id, packaging_cost: s.packaging_cost, inventory_item_ids: ids, channel: s.channel, fee: feeOverride }),
        window.soroban.estimateSaleProfit({ price: s.price, shipping_method_id: maxM.id, packaging_cost: s.packaging_cost, inventory_item_ids: ids, channel: s.channel, fee: feeOverride }),
      ])
      next.set(s.id, { min: Math.min(ra.gross_profit, rb.gross_profit), max: Math.max(ra.gross_profit, rb.gross_profit) })
    } else if (which === 'link') {
      const cand = costCandidates.value.get(s.id)
      if (!cand) return
      const r = await window.soroban.estimateSaleProfit({
        price: s.price, shipping_method_id: s.shipping_method_id, packaging_cost: s.packaging_cost, inventory_item_ids: [cand.id], channel: s.channel, fee: feeOverride,
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
/** スマホ幅のカードで、粗利の数字の上に出す見出し（出品の行は見込み） */
function rowProfitLabel(r: Row): string {
  return r.kind === 'listing' ? '見込み粗利' : profitHeaderLabel.value
}

/**
 * 手数料の「実額」チップを出すかどうか。メルカリの取り込みは明細から手数料の実額が取れるため
 * fee_source='actual' がほぼ全行になり、チップを毎行に出すと情報量ゼロのノイズになる。
 * Yahoo!フリマは率で計算できない（見込みの精度が低い）ため、実額かどうかが意味を持つ。
 * 送料の「実額」チップ（cell-ship）とは色（tone）も分け、隣り合っても取り違えないようにする
 */
function showFeeActualChip(s: SaleProfit): boolean {
  return s.fee_source === 'actual' && s.channel === 'yahoo'
}

async function loadTags() {
  allTags.value = await window.soroban.listTags()
}

onMounted(async () => {
  methods.value = await window.soroban.listShippingMethods()
  await loadTags()
  await loadProgress()
  await loadChannelFeeRates()
  // 下のタブ・縦のナビから開いた（goto の指定が無い）とき、未処理（バッジの数）があれば、それが全部見える
  // 「すべて」＋要対応（送料未入力 または 未紐付け）で開く。0 件なら今までどおり（既定の段階）
  if (openedFromTab && pendingTotal.value > 0) {
    stage.value = 'all'
    // 段階を替えると月・入力の絞り込みを外す watch が走る。それが済んでから入れる（読み込みも、その段階の変更が引き受ける）
    await nextTick()
    inputFilter.value = 'pending'
    return
  }
  await load()
})
watch(revision, loadTags)
watch(revision, loadProgress)
watch([revision, stage, listedFilter, listingStatusFilter, tagFilter], () => load())

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
    ? [`購入 ${shortDate(s.purchased_at)}`]
    : [`${shortDate(s.sold_at)} に売れた`]
  if (s.status === 'completed' && s.completed_at) {
    parts.push(`完了 ${shortDate(s.completed_at)}`)
  }
  if (s.buyer) parts.push(`買い手 ${s.buyer}`)
  if (s.kind === 'personal') parts.push('利益の計算に入れない')
  return parts.join(' ・ ')
}
function listingSubText(l: Listing): string {
  return `出品 ${shortDate(l.listed_at)} ・ 確認 ${dateTime(l.last_seen_at)}`
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
// --- 行クリックで開くもの：紐付いている販売はその足あと（履歴）、紐付いていない販売・出品は紐付け。
//     「その行について分かるもの」を出す、という他画面（仕入＝明細、在庫＝足あと、商品＝カルテ）の約束に揃える ---
function onRowClick(r: Row) {
  if (r.kind === 'listing' && r.listing) { openListingAlloc(r.listing); return }
  if (r.kind === 'sale' && r.sale && r.sale.kind !== 'personal') {
    if (canOpenTimeline(r.sale)) openTimelineForSale(r.sale)
    else openSaleAlloc(r.sale)
  }
}
function rowClickable(r: Row): boolean {
  return r.kind === 'listing' || (r.kind === 'sale' && !!r.sale && r.sale.kind !== 'personal')
}
/** 行クリックのツールチップ。紐付いている販売＝足あと、それ以外＝紐付けの案内 */
function rowClickTitle(r: Row): string | undefined {
  if (!rowClickable(r)) return undefined
  if (r.kind === 'sale' && r.sale && canOpenTimeline(r.sale)) return 'この販売の足あとを開く'
  return '在庫の紐付けを開く'
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

const STAGE_EMPTY: Record<Stage, { title: string; hint?: string }> = {
  listed: { title: '出品がありません', hint: 'メルカリの取り込みで出品中タブから見つかると、ここに並びます' },
  to_ship: { title: '発送待ちの販売はありません', hint: '売れると、ここに並びます' },
  in_transit: { title: '配送中・受取待ちの販売はありません', hint: '発送すると、ここに並びます' },
  done: { title: '完了した販売はありません', hint: '受取評価が終わると、ここに並びます' },
  all: { title: '出品も販売もまだありません', hint: '右上の『販売を登録』から入れられます。メルカリの取り込みでも増えます' },
}
const emptyTitle = computed(() => STAGE_EMPTY[stage.value].title)
const emptyHint = computed(() => STAGE_EMPTY[stage.value].hint)
/** 絞り込みの結果が0件のときの文言。出品中の段は「出品」、それ以外は「販売」 */
const filteredEmptyTitle = computed(() =>
  allPendingDone.value ? '要対応の販売はありません'
    : stage.value === 'listed' ? '検索条件に一致する出品がありません' : '検索条件に一致する販売がありません',
)
/** 要対応（送料未入力 または 未紐付け）で絞っていて、ほかの絞り込みは無いのに 0 件＝全部片付いた（検索の取りこぼしではない） */
const allPendingDone = computed(() =>
  inputFilter.value === 'pending' && !searchText.value && !monthFilter.value && !statusFilter.value
  && !channelFilter.value && !tagFilter.value && period.value === 'all',
)
const filteredEmptyHint = computed(() => (allPendingDone.value ? '送料の入力と在庫の紐付けは、すべて済んでいます' : undefined))

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
  if (p.listingStatus === 'active' || p.listingStatus === 'suspended') listingStatusFilter.value = p.listingStatus
  if (p.status) statusFilter.value = p.status
  if (p.search) searchText.value = p.search
  if (p.mercariItemId) await openFromMercariId(p.mercariItemId)
  if (p.focusId) await focusRow(p.focusId)
  gotoPayload.value = null
}, { immediate: true })

// --- 手入力登録 ---

async function submit() {
  if (!form.value.title.trim()) { toast('商品名を入力してください', 'warn'); return }
  // type="number" は '294円' 等の貼り付けをブラウザ側で空欄にしてくれるが、'1.5' のような
  // 小数は通ってしまう。丸めて通すと**打った数字を黙って変える**ことになるので、
  // 手数料（normalizeYenInput）と同じく弾いて人に言う
  const rawPrice = Number(form.value.price)
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) { toast('価格を入力してください', 'warn'); return }
  if (!Number.isInteger(rawPrice)) { toast('価格は整数（円）で入力してください（小数は使えません）', 'warn'); return }
  const price = rawPrice

  const feeTrimmed = feeInput.value.trim()
  let fee: number | undefined
  if (feeTrimmed !== '') {
    const parsed = normalizeYenInput(feeTrimmed)
    if (!parsed.ok) { toast(parsed.error, 'warn'); return }
    fee = parsed.value
  }

  const itemIdTrimmed = itemIdInput.value.trim()
  const channel = form.value.channel ?? 'mercari'
  if (itemIdTrimmed) {
    const idError = itemIdMismatchError(channel, itemIdTrimmed)
    if (idError) { toast(idError, 'warn'); return }
  }

  await window.soroban.createSale({
    ...form.value,
    price,
    title: form.value.title.trim(),
    note: form.value.note?.trim() || null,
    fee,
    mercari_item_id: itemIdTrimmed || null,
  })

  form.value = { title: '', sold_at: todayLocal(), price: 0, kind: 'resale', channel: 'mercari', note: '' }
  feeInput.value = ''
  itemIdInput.value = ''
  showForm.value = false
  await load()
  await loadProgress()
  changed()
  toast('販売を登録しました', 'ok')
}

// --- 送料・梱包材費 ---

async function setShipping(row: Row, sale: SaleProfit, el: HTMLSelectElement) {
  const methodId = el.value
  // 「選択…」に戻した＝送料を空に戻す。「入れました」とも「済」とも言わない
  if (!methodId) {
    await window.soroban.updateSale(sale.id, { shipping_method_id: null })
    await load()
    await loadProgress()
    changed()
    return
  }
  const method = methods.value.find(m => m.id === methodId)
  const label = method ? `${method.name} ${yen(method.fee)}` : ''
  const height = el.closest<HTMLElement>('.work-row')?.offsetHeight ?? 0
  const needed = !sale.is_shipping_confirmed // 送料が決まっていなかった行だけ、読み直しで外れる／動く
  try {
    await window.soroban.updateSale(sale.id, { shipping_method_id: methodId })
  } catch (e) {
    el.value = sale.shipping_method_id ?? ''
    toast(e instanceof Error ? e.message : String(e), 'warn')
    return
  }
  toast(label ? `${label} を入れました` : '発送方法を入れました', 'ok')
  // 読み直しの前に「済」に替えておく（消える・動く瞬間を作らない）
  if (needed) beginHold(row, height, label || '発送方法')
  try {
    await load(true)
    await loadProgress()
    changed()
  } finally {
    endReload(row.key)
  }
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

/**
 * 販売手数料を実額に直す。空欄で決定すると率からの計算に戻す（fee: null）。
 * '0' は実額の0円（キャンペーンなど）として送る。梱包材費（editPackaging）と同じ作法
 */
async function editFee(sale: SaleProfit) {
  const v = await ask('販売手数料（実額・税込）', {
    initial: sale.fee_source === 'actual' ? String(sale.fee) : '',
    placeholder: '空なら率からの自動計算に戻ります',
  })
  if (v === null) return
  const trimmed = v.trim()
  let fee: number | null
  if (trimmed === '') {
    fee = null
  } else {
    const parsed = normalizeYenInput(trimmed)
    if (!parsed.ok) { toast(parsed.error, 'warn'); return }
    fee = parsed.value
  }
  await window.soroban.updateSale(sale.id, { fee })
  await load()
  changed()
}

async function setKind(sale: SaleProfit, kind: SaleKind) {
  const label = SALE_KIND_LABEL[kind]
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

/**
 * 実行前後で未紐付け（unmatched）の転売を突き合わせ、「なぜ引き当たらなかったか」を仕分ける。
 * 判定ルール自体（db.ts の autoLinkSale）は変えない。ここはメッセージのための後追いの数え上げだけ：
 *   型番0件 → タイトルから型番が読み取れなかった（取り込みの不具合／最初から型番が無い、両方を含む）
 *   型番2件以上 → 型番が複数あって1つに絞れない
 *   型番1件のうち getAutoLinkBlockers が非空 → **在庫はある。** 別の出品（他社サイトのこともある）に
 *     取ってあるせいで自動紐付けの検索から外れただけ（横取り防止のため）。「在庫が無い」と言ってはいけない
 *   型番1件のうち上記に当たらない → 本当に在庫が無い
 *
 * **絞り込みの外までは効かせない**：main へ渡す id は、いま画面に見えている行（filteredRows）から
 * そのまま取る。絞り込みを main 側で作り直さない（二重に書くと必ず食い違う）
 */
const visibleSaleIds = computed(() => filteredRows.value.filter(r => r.kind === 'sale').map(r => r.id))
const visibleListingIds = computed(() => filteredRows.value.filter(r => r.kind === 'listing').map(r => r.id))

async function autoLinkPending() {
  const targetIds = visibleSaleIds.value
  if (targetIds.length === 0) {
    toast('表示中の販売はありません', 'warn')
    return
  }
  const targetIdSet = new Set(targetIds)
  const before = filteredRows.value
    .filter((r): r is Row & { sale: SaleProfit } => r.kind === 'sale' && !!r.sale && r.sale.kind === 'resale' && r.sale.unmatched === 1)
    .map(r => r.sale)
  if (before.length === 0) {
    toast('表示中に未紐付けの販売はありません', 'ok')
    return
  }

  const n = await window.soroban.autoLinkPending(targetIds)

  await load()
  await loadProgress()
  changed()

  const after = new Map(
    sales.value.filter(s => targetIdSet.has(s.id) && s.unmatched === 1).map(s => [s.id, s]),
  )

  let noCode = 0
  let ambiguous = 0
  let blocked = 0
  let noMatch = 0
  const singleCode: SaleProfit[] = []
  for (const s of before) {
    const a = after.get(s.id)
    if (!a) continue // 引き当てられた
    if (a.model_codes.length === 0) noCode++
    else if (a.model_codes.length >= 2) ambiguous++
    else singleCode.push(a)
  }
  if (singleCode.length) {
    const blockerLists = await Promise.all(singleCode.map(s => window.soroban.getAutoLinkBlockers(s.id)))
    for (const list of blockerLists) { if (list.length > 0) blocked++; else noMatch++ }
  }

  const reasons: string[] = []
  if (blocked > 0) reasons.push(`在庫はあるが出品に取られている${blocked}件`)
  if (noCode > 0) reasons.push(`型番が読み取れない${noCode}件`)
  if (ambiguous > 0) reasons.push(`型番が複数あって絞れない${ambiguous}件`)
  if (noMatch > 0) reasons.push(`型番はあるが在庫が無い${noMatch}件`)
  const detail = reasons.length ? `${reasons.join('、')}は手で選んでください` : ''

  if (n > 0) {
    toast(detail ? `表示中の${n}件を紐付けました。${detail}` : `表示中の${n}件を紐付けました`, 'ok')
  } else {
    toast(detail ? `表示中に型番が一致する在庫がありませんでした。${detail}` : '表示中に型番が一致する在庫はありませんでした', 'warn')
  }
}

// --- 型番で自動引き当て（出品中） ---

async function autoReserveListings() {
  const targetIds = visibleListingIds.value
  if (targetIds.length === 0) {
    toast('表示中の出品はありません', 'warn')
    return
  }
  const n = await window.soroban.autoReserveListings(targetIds)
  if (n > 0) {
    toast(`表示中の${targetIds.length}件のうち${n}件を紐付けました`, 'ok')
  } else {
    toast('表示中に紐付けられる出品はありません', 'warn')
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
const TAG_ORIGIN_LABEL: Record<string, string> = { purchase: '仕入のタグ', product: '商品のタグ', inventory: '在庫のタグ' }
// 1 文字（「在」「仕」）では何のことか読めないので、どこから来たタグかを 2 文字で
const TAG_ORIGIN_MARK: Record<string, string> = { purchase: '仕入', product: '商品', inventory: '在庫' }
function tagOriginTitle(from?: Tag['from']): string {
  return from ? TAG_ORIGIN_LABEL[from] : ''
}
function tagOriginMark(from?: Tag['from']): string {
  return from ? TAG_ORIGIN_MARK[from] : ''
}

// --- .chip-row は行の高さを一定にするため1行に収め（nowrap）、収まらない分は隠す。
//     隠れた分も含めて全文を title で読めるようにする ---
function saleChipRowTitle(s: SaleProfit): string {
  return [
    SALE_KIND_LABEL[s.kind],
    s.source === 'collector' ? '自動取得' : null,
    ...s.model_codes,
    ...s.tags.map(t => t.name),
    ...s.inherited_tags.map(t => t.name),
  ].filter((x): x is string => !!x).join(' ・ ')
}
function listingChipRowTitle(l: Listing): string {
  return [
    ...l.model_codes,
    l.likes != null ? `いいね ${l.likes}` : null,
    seenStale(l) ? '前回の取り込みで見えず' : null,
  ].filter((x): x is string => !!x).join(' ・ ')
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

// --- スマホ幅：カードの補助ボタン（タグ・履歴・梱包・手数料・削除）は「…」の下からのシートにまとめる ---
const moreOpen = ref(false)
const moreSale = ref<SaleProfit | null>(null)
/** 「…」ボタン。シートからタグを開くときの、タグ選択の基準の要素（スマホ幅では下に出るので位置には使われないが、外を押した判定に使う） */
const moreAnchor = ref<HTMLElement | null>(null)
function openMore(sale: SaleProfit, e: MouseEvent) {
  moreSale.value = sale
  moreAnchor.value = e.currentTarget as HTMLElement
  moreOpen.value = true
}
/** シートの操作を実行してから閉じる（先に次の層［入力・確認・タグ選択］を出してから、シートの層を外す） */
function runMore(fn: (sale: SaleProfit) => unknown) {
  const sale = moreSale.value
  if (!sale) return
  void fn(sale)
  moreOpen.value = false
}
function moreOpenTags(sale: SaleProfit) {
  tagPickerSale.value = sale
  tagPickerAnchor.value = moreAnchor.value
}

async function onTagChange(tagIds: string[]) {
  if (!tagPickerSale.value) return
  const id = tagPickerSale.value.id
  await window.soroban.setSaleTags(id, tagIds)
  await load()
  tagPickerSale.value = sales.value.find(s => s.id === id) ?? null
  changed()
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
  changed()
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

// --- 出品先のページを開く（標準ブラウザ。読み取り専用）。id の形が出品先と合わないと Error ---
async function openChannelPageExternal(channel: SalesChannel, kind: 'item' | 'transaction', itemId: string) {
  try {
    await window.soroban.openChannelPage(channel, kind, itemId)
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'warn')
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">売上</h1>
      <span class="grow" />
      <!-- スマホ幅だけ：直近12か月のグラフの入口（デスクトップ幅ではグラフのカード自身が開閉を持つ） -->
      <button type="button" class="ghost m-chart-btn" :aria-pressed="chartOpen" @click="chartOpen = !chartOpen">
        <Icon name="sales" :size="16" />
        グラフ
      </button>
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
          <input type="number" inputmode="numeric" v-model.number="form.price" />
        </label>
        <label class="field">
          <span>区分</span>
          <select v-model="form.kind">
            <option value="resale">{{ SALE_KIND_LABEL.resale }}</option>
            <option value="personal">{{ SALE_KIND_LABEL.personal }}</option>
          </select>
        </label>
        <label class="field">
          <span>出品先</span>
          <select v-model="form.channel">
            <option value="mercari">{{ CHANNEL_LABEL.mercari }}</option>
            <option value="yahoo">{{ CHANNEL_LABEL.yahoo }}</option>
          </select>
        </label>
        <label class="field">
          <span>販売手数料（実額・任意）</span>
          <input type="text" inputmode="numeric" v-model="feeInput" placeholder="空なら自動計算" />
        </label>
        <label class="field">
          <span>商品ID（任意）</span>
          <input v-model="itemIdInput" :placeholder="form.channel === 'yahoo' ? '例: z999999999' : '例: m123456789'" />
        </label>
        <label class="field field-wide">
          <span>メモ</span>
          <input v-model="form.note" placeholder="任意" />
        </label>
      </div>
      <p v-if="form.channel === 'yahoo' && !feeInput.trim()" class="warn form-hint-warn">
        <Icon name="alert" :size="14" />
        Yahoo!フリマの手数料は率で計算できません。分かっている実額を入力してください（キャンペーンで0円のこともあります）
      </p>
      <p class="faint form-hint">
        金額はすべて税込。メルカリ・Yahoo!フリマの表示どおりに入れてください ・
        手数料 −{{ yen(formPreview.fee) }}{{ formPreview.isActual ? '（入力した実額）' : `（${CHANNEL_LABEL[form.channel ?? 'mercari']}の見込み）` }} ・ 粗利 {{ yen(formPreview.profit) }}
      </p>
      <div class="row">
        <span class="grow" />
        <button class="primary" @click="submit">登録</button>
      </div>
    </div>

    <SalesSummary v-model:mobileOpen="chartOpen" />

    <!-- 進捗ストリップ（メルカリ側の状態）。押すと絞る。スマホ幅では、高さ 44px の 1 行の横に動くチップ列（先頭に「要対応」） -->
    <StageStrip chips :stages="stageCards" :active="stripActive" @select="onSelectStage" />

    <!-- 利益の入力（アプリ側の状態）。進捗とは別の軸。スマホ幅ではここを隠し、同じ 2 つのピルを「絞り込み」の中に出す -->
    <p class="inputs-band">
      <span class="inputs-label">利益の入力：</span>
      <button
        v-for="p in inputPills" :key="p.key"
        type="button"
        class="input-pill-btn"
        :class="{ active: inputPillOn(p.key) }"
        @click="toggleInputFilter(p.key)"
      >
        <StatusPill tone="warn" :label="p.label" />
      </button>
      <StatusPill tone="ok" :label="`入力済み ${progress?.inputs.done ?? 0}`" />
      <span class="grow" />
      <span class="faint inputs-hint">粗利が出ていない行は上に来ます</span>
    </p>

    <div class="toolbar">
      <SearchBox v-model="searchText" placeholder="商品名・型番・メモ・タグ・買い手を検索" />
      <!-- スマホ幅だけ：絞り込みをこのボタンの中にまとめる。数字は効いている絞り込みの数 -->
      <button
        type="button"
        class="m-filter-toggle"
        :class="{ on: filtersOpen || activeFilterCount > 0 }"
        :aria-expanded="filtersOpen"
        @click="filtersOpen = !filtersOpen"
      >
        絞り込み<span v-if="activeFilterCount" class="m-filter-n">{{ activeFilterCount }}</span>
      </button>
      <!-- デスクトップ幅では display: contents（この入れ物は無いのと同じ） -->
      <div class="toolbar-filters" :class="{ 'm-open': filtersOpen }">
        <select v-if="stage === 'listed'" v-model="listingStatusFilter" title="出品の状態で絞り込む">
          <option value="all">すべての出品状態</option>
          <option value="active">{{ LISTING_STATUS_LABEL.active }}</option>
          <option value="suspended">{{ LISTING_STATUS_LABEL.suspended }}</option>
        </select>
        <select v-if="stage === 'listed'" v-model="listedFilter" title="紐付けの状態で絞り込む">
          <option value="all">すべての紐付け</option>
          <option value="unallocated">未紐付け</option>
          <option value="allocated">紐付け済み</option>
        </select>
        <select v-else v-model="statusFilter" title="取引の進み具合で絞り込む">
          <option value="">すべての状態</option>
          <option value="waiting_shipment">発送してください</option>
        </select>
        <select v-model="channelFilter" title="出品先で絞り込む">
          <option value="">すべての出品先</option>
          <option value="mercari">{{ CHANNEL_LABEL.mercari }}</option>
          <option value="yahoo">{{ CHANNEL_LABEL.yahoo }}</option>
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
        <PeriodSelect v-model="period" :class="{ 'is-custom': typeof period === 'object' }" />
        <button
          v-if="monthFilter"
          type="button"
          class="month-chip-btn"
          :title="`${monthFilter} の絞り込みを解除`"
          @click="monthFilter = null"
        >
          <StatusChip tone="brand" :label="`${monthFilter} ×`" />
        </button>
        <!-- 型番で自動紐付け・並び替えは、デスクトップ幅では絞り込みの右に並ぶ（この入れ物は無いのと同じ）。
             スマホ幅では「絞り込み」を開いた中に入る -->
        <button v-if="stage === 'listed'" class="sm auto-link-btn" :disabled="!visibleListingIds.length" @click="autoReserveListings">型番で自動紐付け</button>
        <button v-if="stage !== 'listed'" class="sm auto-link-btn" :disabled="!visibleSaleIds.length" @click="autoLinkPending">型番で自動紐付け</button>
        <select v-model="sortOption" class="sort-select" title="並び替え">
          <option value="default">既定（未確定が先）</option>
          <option value="date_desc">日付が新しい順</option>
          <option value="date_asc">日付が古い順</option>
          <option value="profit_desc">粗利が高い順</option>
          <option value="profit_asc">粗利が低い順</option>
          <option value="price_desc">価格が高い順</option>
          <option value="price_asc">価格が低い順</option>
        </select>
        <!-- スマホ幅だけ：利益の入力（上の 2 つのピルと同じもの） -->
        <div class="m-input-filters">
          <span class="m-input-filters-label">利益の入力</span>
          <button
            v-for="p in inputPills" :key="p.key"
            type="button"
            class="m-input-filter"
            :class="{ on: inputPillOn(p.key) }"
            :aria-pressed="inputPillOn(p.key)"
            @click="toggleInputFilter(p.key)"
          >{{ p.label }}</button>
        </div>
      </div>
      <span class="grow" />
      <!-- 読み込み中は件数も合計も出さない（まだ何も入っていないのに「0 件 ・ 合計 ¥0」と言わない）。スマホ幅で行の高さが動かないよう、空の行は残す -->
      <span class="toolbar-count" :aria-busy="!loaded">
        <template v-if="loaded">
          {{ filteredRows.length }} 件<template v-if="toolbarRevenue !== null"> ・ 合計 {{ yen(toolbarRevenue) }}</template><template v-if="monthFilter"> ・ {{ monthFilter }} の販売</template>
        </template>
        <template v-else>&nbsp;</template>
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
      <div v-if="displayRows.length" class="panel work-panel">
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

        <!-- .slot は畳むための入れ物（畳むとき以外は何もしない）。「済」にした行は高さを保ち、1.2 秒後に畳む -->
        <div
          v-for="{ row: r, hold } in displayRows" :key="r.key"
          class="slot"
          :class="{ collapsing: !!hold?.collapsing }"
          :style="hold && !hold.collapsing ? { minHeight: hold.height + 'px' } : undefined"
        >
          <div class="slot-in">
            <div
              :data-row-id="r.id"
              class="work-row"
              :class="{
                focused: focusedId === r.id,
                held: !!hold,
                settled: !hold && r.kind === 'sale' && !!r.sale && !rowUnresolved(r),
                'needs-shipment': r.kind === 'sale' && r.sale?.status === 'waiting_shipment',
                'needs-input': !hold && rowUnresolved(r),
              }"
            >
              <div
                class="cell-thumb"
                :class="{ clickable: rowClickable(r) }"
                :title="rowClickTitle(r)"
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
                  <StatusChip
                    :class="{ 'm-default-channel': rowChannel(r) === 'mercari' }"
                    tone="neutral" :label="CHANNEL_LABEL[rowChannel(r)]" :title="`出品先：${CHANNEL_LABEL[rowChannel(r)]}`"
                  />
                  <StatusPill v-if="r.kind === 'sale' && r.sale?.status && SALE_STATUS_PILL[r.sale.status]"
                    :tone="SALE_STATUS_PILL[r.sale.status].tone" :label="SALE_STATUS_PILL[r.sale.status].label"
                    :title="SALE_STATUS_PILL[r.sale.status].title" />
                  <StatusChip v-if="r.kind === 'listing' && r.listing" :tone="STATUS_TONE[r.listing.status]" :label="LISTING_STATUS_LABEL[r.listing.status]" />
                  <StatusChip v-if="r.sale && !r.sale.status" tone="neutral" :label="r.sale.source === 'manual' ? '手入力' : '状態未取得'" />
                  <!-- スマホ幅だけ：粗利がまだ出ない理由を状態ラベル（①）に出す。表の列が無いので、ここで一目で分かるように。
                       「未紐付け」はここに 1 回だけ出し、在庫の紐付けのセル（AllocationCell）のチップは隠す -->
                  <template v-if="r.sale && r.sale.kind === 'resale'">
                    <StatusPill v-if="!r.sale.is_shipping_confirmed && !hold" class="m-flag" tone="warn" label="送料未入力" />
                    <StatusPill v-if="r.sale.unmatched === 1" class="m-flag" tone="warn" label="未紐付け" />
                  </template>
                </div>
                <!-- 押せる範囲は .title-hit（スマホ幅では上下に広げて 44px 以上）。文字の大きさと並びは変えない -->
                <div
                  class="title-hit"
                  :class="{ clickable: rowClickable(r) }"
                  :role="rowClickable(r) ? 'button' : undefined"
                  :tabindex="rowClickable(r) ? 0 : undefined"
                  @keydown.enter="onRowClick(r)"
                  @keydown.space.prevent="onRowClick(r)"
                  @click="onRowClick(r)"
                ><span class="row-title" :title="rowTitle(r)">{{ rowTitle(r) }}</span></div>

                <template v-if="r.kind === 'sale' && r.sale">
                  <div class="row-sub">{{ saleSubText(r.sale) }}</div>
                  <div class="chip-row fixed-row" :title="saleChipRowTitle(r.sale)">
                    <button
                      v-if="r.sale.kind === 'resale'"
                      class="kind-toggle"
                      title="私物に変更する（確認あり）"
                      @click="r.sale && setKind(r.sale, 'personal')"
                    >
                      <StatusChip tone="brand" :label="SALE_KIND_LABEL.resale" />
                    </button>
                    <StatusChip v-else tone="neutral" label="私物" />
                    <StatusChip v-if="r.sale.source === 'collector'" tone="neutral" label="自動取得" />
                    <CodeChip v-for="mc in r.sale.model_codes" :key="mc" kind="model" :code="mc" />
                    <div class="chip-tags">
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
                  </div>
                  <div class="note-row fixed-row">
                    <template v-if="r.sale.note">
                      <Icon name="note" :size="14" class="icon-note" />
                      <span class="note-label">メモ</span>
                      <span class="note-text" :title="r.sale.note">{{ r.sale.note }}</span>
                    </template>
                  </div>
                </template>

                <template v-else-if="r.listing">
                  <div class="row-sub" title="更新日から推定">{{ listingSubText(r.listing) }}</div>
                  <div class="chip-row fixed-row" :title="listingChipRowTitle(r.listing)">
                    <div class="chip-tags">
                      <CodeChip v-for="mc in r.listing.model_codes" :key="mc" kind="model" :code="mc" />
                      <StatusChip v-if="r.listing.likes != null" tone="neutral" :label="`いいね ${r.listing.likes}`" />
                      <StatusChip
                        v-if="seenStale(r.listing)"
                        tone="neutral"
                        label="前回の取り込みで見えず"
                        title="1ページ目に無かっただけかもしれません。売れていれば売上に出ます"
                      />
                    </div>
                  </div>
                  <!-- 出品にはメモが無いが、販売行と高さを揃えるため同じ分だけ確保する -->
                  <div class="note-row fixed-row"></div>
                </template>
              </div>

              <div class="cell-meta">
                <div class="cell-price num">
                  <span class="m-label">価格</span>
                  {{ yen(r.kind === 'sale' ? (r.sale?.price ?? 0) : (r.listing?.price ?? 0)) }}
                  <div v-if="r.kind === 'sale' && r.sale && r.sale.kind !== 'personal'" class="faint fee-line">
                    手数料 −{{ yen(r.sale.fee) }}
                    <StatusChip
                      v-if="showFeeActualChip(r.sale)"
                      tone="info"
                      label="実額"
                      title="手数料の実額（率の見込みではなく実際にかかった手数料）"
                    />
                  </div>
                </div>

                <div class="cell-ship">
                  <span class="m-label">発送方法（送料）</span>
                  <!-- 発送方法を入れた行：選んだ場所に、入れたものを出す（1.2 秒後に畳まれる） -->
                  <span v-if="hold" class="held-done"><Icon name="check" :size="14" class="held-check" />済　{{ hold.label }}</span>
                  <template v-else-if="r.kind === 'listing' && r.listing">
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
                      <StatusChip tone="ok" label="実額" title="送料の実額（実際に払った送料）" />
                    </span>
                    <select
                      v-else
                      class="ship-select"
                      :value="r.sale.shipping_method_id ?? ''"
                      :class="{ invalid: !r.sale.is_shipping_confirmed }"
                      :title="(r.sale.shipping_source === 'actual' && r.sale.shipping_fee === 0 && !r.sale.is_shipping_confirmed) ? 'メルカリ側の送料は0円でした。自分で払った送料の発送方法を選んでください' : undefined"
                      @change="r.sale && setShipping(r, r.sale, $event.target as HTMLSelectElement)"
                    >
                      <option value="">{{ (r.sale.shipping_source === 'actual' && r.sale.shipping_fee === 0 && !r.sale.is_shipping_confirmed) ? '選択…（メルカリ便以外）' : '選択…' }}</option>
                      <option v-for="m in methods" :key="m.id" :value="m.id">
                        {{ m.name }}　{{ yen(m.fee) }}
                      </option>
                    </select>
                  </template>
                </div>

                <!-- has-flag：スマホ幅では「未紐付け」が状態ラベルに出ているので、ここのチップは隠す。
                     info-none：隠したあと、原価・コード・ひとことが何も無い（候補も無い）なら、情報の行ごと畳む -->
                <div
                  class="cell-cost"
                  :class="{
                    'has-flag': r.sale?.kind === 'resale' && r.sale?.unmatched === 1,
                    'info-none': r.sale?.kind === 'resale' && r.sale?.unmatched === 1 && r.sale?.item_count === 0 && !costCandidateText(r.sale),
                  }"
                >
                  <span class="m-label">{{ costHeaderLabel }}</span>
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
                  <span class="m-label">{{ rowProfitLabel(r) }}</span>
                  <Transition name="settle" mode="out-in">
                    <!-- 「済」の間は、送料を入れる前の言い方（「送料を選ぶと確定」）を出さない -->
                    <span v-if="hold" key="held" class="faint">—</span>
                    <span v-else-if="r.kind === 'sale' && r.sale && r.sale.kind === 'personal'" key="personal" class="faint">私物</span>
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
                  <!-- .m-more-item：スマホ幅では隠し、「…」のシート（下の ActionSheet）に同じ操作を並べる。外部ページ・メモはカードに残す -->
                  <button
                    v-if="r.sale.mercari_item_id"
                    class="icon ghost ops-ext"
                    :aria-label="`${CHANNEL_LABEL[r.sale.channel]}で開く`"
                    :title="`${CHANNEL_LABEL[r.sale.channel]}の取引画面を開く`"
                    @click.stop="r.sale && openChannelPageExternal(r.sale.channel, 'transaction', r.sale.mercari_item_id)"
                  >
                    <Icon name="external" :size="14" />
                  </button>
                  <button class="sm ghost fade-btn m-more-item" @click="r.sale && openTagPicker(r.sale, $event)" title="タグを編集する">タグ</button>
                  <button v-if="canOpenTimeline(r.sale)" class="sm ghost m-more-item" @click="openTimelineForSale(r.sale)">履歴</button>
                  <button class="sm ghost fade-btn" @click="r.sale && editNote(r.sale)" title="メモを編集する">メモ</button>
                  <button v-if="r.sale.kind !== 'personal'" class="sm ghost fade-btn m-more-item" @click="r.sale && editPackaging(r.sale)" title="梱包材費を編集する">梱包</button>
                  <button v-if="r.sale.kind !== 'personal'" class="sm ghost fade-btn m-more-item" @click="r.sale && editFee(r.sale)" title="販売手数料を実額に直す（空欄で率の計算に戻ります）">手数料</button>
                  <button v-if="r.sale.kind === 'personal'" class="sm ghost fade-btn m-more-item" @click="r.sale && setKind(r.sale, 'resale')">{{ SALE_KIND_LABEL.resale }}にする</button>
                  <button class="icon ghost m-more-item" aria-label="削除" @click="r.sale && remove(r.sale)">
                    <Icon name="trash" :size="16" />
                  </button>
                  <!-- スマホ幅だけ：その他（タグ・履歴・梱包・手数料・削除）。デスクトップ幅では出さない -->
                  <button type="button" class="ghost m-more-btn" aria-label="その他の操作" aria-haspopup="dialog" @click="r.sale && openMore(r.sale, $event)">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                      <circle cx="4" cy="10" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="16" cy="10" r="1.6" />
                    </svg>
                  </button>
                </template>
                <template v-else-if="r.listing && (r.listing.status === 'active' || r.listing.status === 'suspended')">
                  <button
                    class="icon ghost ops-ext"
                    :aria-label="`${CHANNEL_LABEL[r.listing.channel]}で開く`"
                    :title="`${CHANNEL_LABEL[r.listing.channel]}の商品ページを開く`"
                    @click.stop="r.listing && openChannelPageExternal(r.listing.channel, 'item', r.listing.mercari_item_id)"
                  >
                    <Icon name="external" :size="14" />
                  </button>
                  <button class="sm ghost" @click="r.listing && endListing(r.listing)">取り下げ</button>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>

      <EmptyState
        v-else-if="searchText || monthFilter || statusFilter || inputFilter || period !== 'all' || listingStatusFilter !== 'active' || listedFilter !== 'all'"
        :title="filteredEmptyTitle"
        :hint="filteredEmptyHint"
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
      :subject="tagPickerSale?.title"
      @change="onTagChange"
      @create="onTagCreate"
      @close="closeTagPicker"
    />

    <!-- スマホ幅：カードの「…」から開く、その他の操作（タグ・履歴・梱包・手数料・削除）。削除はいちばん下、赤文字で、今までの確認ダイアログのまま -->
    <ActionSheet :open="moreOpen" :title="moreSale?.title" @close="moreOpen = false">
      <template v-if="moreSale">
        <button type="button" @click="runMore(moreOpenTags)">タグ</button>
        <button v-if="canOpenTimeline(moreSale)" type="button" @click="runMore(openTimelineForSale)">履歴</button>
        <button v-if="moreSale.kind !== 'personal'" type="button" @click="runMore(editPackaging)">梱包材費</button>
        <button v-if="moreSale.kind !== 'personal'" type="button" @click="runMore(editFee)">販売手数料</button>
        <button v-if="moreSale.kind === 'personal'" type="button" @click="runMore(s => setKind(s, 'resale'))">{{ SALE_KIND_LABEL.resale }}にする</button>
        <button type="button" class="danger" @click="runMore(remove)">削除</button>
      </template>
    </ActionSheet>

    <TimelineDrawer
      :open="!!timelineItemId"
      :inventory-item-id="timelineItemId"
      @close="timelineItemId = null"
      @changed="load()"
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
.form-hint-warn {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: -4px 0 0;
  font-size: var(--fs-13);
}

/* 派生タグ（仕入・商品・在庫から引き継いだもの）は直接付けたタグより少し薄く見せる。
   先頭の小さな記号で出どころを示す */
.chip-inherited { opacity: .7; }
.chip-inherited-wrap {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.chip-origin-mark {
  font-size: var(--fs-12);
  color: var(--text-faint);
  white-space: nowrap;
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
@media (hover: hover) and (pointer: fine) {
  .input-pill-btn:hover:not(:disabled) { background: transparent; filter: brightness(.97); }
}
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
.work-row-hdr {
  padding: 6px 10px;
  border-top: 0;
  color: var(--text-faint);
  font-size: var(--fs-12);
}

/* --- 畳むための入れ物（.slot）---
   行を高さごと畳む。grid の行を 1fr → 0fr に動かすと、中身の高さを測らずに畳める。
   畳むとき以外は、幅いっぱいの 1 マスなだけで見た目は変わらない。
   行は padding・罫線を持つので、そのままでは 0 まで縮まない。padding の無い .slot-in で包んで、そちらを縮める。 */
.slot {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: 1fr;
  min-height: 0; /* 「済」の間だけ行の高さを保つ min-height（インライン）を、畳むときに 0 へ動かせるよう明示しておく */
}
.slot > * { min-height: 0; }
.slot-in { display: grid; grid-template-columns: minmax(0, 1fr); }
/* 動かすのは畳むときだけ。「済」に替える瞬間（min-height が 0 → 行の高さになる）は動かさない */
.slot.collapsing {
  grid-template-rows: 0fr;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
  transition: grid-template-rows var(--dur) var(--ease), min-height var(--dur) var(--ease), opacity var(--dur) var(--ease);
}

/* --- 発送方法を入れた行（「済」。1.2 秒だけ残って畳まれる）---
   行は元のまま（高さも変えない）。選んだ場所だけ「済」に替え、ほかは薄くして、触れないようにする */
.work-row.held { pointer-events: none; }
.work-row.held .cell-thumb,
.work-row.held .cell-product,
.work-row.held .cell-price,
.work-row.held .cell-cost,
.work-row.held .cell-profit,
.work-row.held .cell-ops { opacity: .55; }
.held-done {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  font-size: var(--fs-14);
  font-weight: 600;
  white-space: nowrap;
}
.held-check { color: var(--profit); flex: 0 0 auto; }
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

/* 「実額」チップは .cell-price の80px幅に収まらないことがある（Yahoo!フリマ）。
   .num の white-space: nowrap を継承すると折り返せず隣の発送方法セレクトに重なるため、
   ここだけ折り返しを許し、チップは右寄せのまま2行目に落ちる */
.fee-line {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 2px 4px;
  white-space: normal;
  font-size: var(--fs-12);
  margin-top: 2px;
}

.chip-row .fade-btn { padding: 3px 6px; }

.fade-btn {
  padding: 3px 6px;
  opacity: .35;
  transition: opacity var(--dur) var(--ease);
}
/* 行に触れたら濃くなる（マウスのある端末だけ）。マウスの無い端末では最初から濃くしておく */
@media (hover: hover) and (pointer: fine) {
  .work-row:hover .fade-btn { opacity: 1; }
}
@media (hover: none), (pointer: coarse) {
  .fade-btn { opacity: 1; }
}

.kind-toggle {
  flex-shrink: 0;
  display: block;
  background: transparent;
  border: none;
  padding: 0;
  height: auto;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .kind-toggle:hover:not(:disabled) { background: transparent; }
}

.month-chip-btn {
  flex-shrink: 0;
  display: block;
  background: transparent;
  border: none;
  padding: 0;
  height: auto;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .month-chip-btn:hover:not(:disabled) { background: transparent; }
}

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

/* --- スマホ幅だけで出すもの。デスクトップ幅では出さない（絞り込みの入れ物は無いのと同じ） --- */
.m-label,
.m-flag,
.m-filter-toggle,
.m-chart-btn,
.m-input-filters,
.m-more-btn { display: none; }
.toolbar-filters { display: contents; }

/* ============================================================
   スマホ幅（768px 未満）：表をカードの一覧に組み替える。
   1 枚のカード＝1 件の販売（出品）。上から ① 状態ラベル → ② 名前 → ③ 補助 → ④ チップ・メモ（style.css の
   行の規約のまま）、その下に 価格・粗利／送料／在庫の紐付け、いちばん下に補助の操作。
   粗利が出ていない（送料未入力・未紐付け）カードは左に橙の帯とラベルで目立たせ、
   送料の選択と在庫を選ぶボタンは 44px 以上の高さにする。
   ホバーでしか読めなかった title（チップの切り詰め・メモ・タイトル）は、ここでは切らずに見せる。
   デスクトップ幅（768px 以上）の見た目には一切効かせない。
   ============================================================ */
@media (max-width: 767px) {
  /* 上のバー：売上 ……[グラフ][販売を登録]。グラフは直近12か月の開閉（開くまでは 1 行も場所を取らない）。
     段階チップ（StageStrip）と検索まで、最初のカードが 260px より上に来るよう、上のバーの下の余白も詰める */
  .page-head { margin-bottom: 4px; }
  .page-head .primary { height: 44px; }
  .m-chart-btn { display: inline-flex; align-items: center; gap: 6px; height: 44px; }
  .m-chart-btn[aria-pressed="true"] { background: var(--brand-soft); color: var(--text); }

  /* 販売の手入力フォーム：1 列、入力欄は 44px */
  .form { gap: 12px; }
  .form .fields { gap: 12px; }
  .form .fields > .field { flex: 1 1 100%; }
  .field-wide input { width: 100%; }
  .form input, .form select { height: 44px; }
  .form .row .grow { display: none; }
  .form .row .primary { flex: 1 1 auto; height: 48px; }

  /* 段階チップ（StageStrip の chips）の横に動かす・選んだ段階を見える位置へ寄せる、は StageStrip.vue 自身が持つ */

  /* 利益の入力のピルは、ここでは出さない。同じ 2 つのボタンは「絞り込み」を開いた中にあり（.m-input-filters）、
     いちばん使う「要対応」（送料未入力 または 未紐付け）は、段階チップの先頭に出ている */
  .inputs-band { display: none; }

  /* ツールバー：検索 →（絞り込み）→ 件数・合計。並び替えと型番で自動紐付け、利益の入力は「絞り込み」の中 */
  .toolbar { gap: 4px 8px; margin-bottom: 8px; }
  .toolbar .search-box { flex: 1 1 160px; width: auto; min-width: 0; }
  .toolbar .search-box :deep(.search-box-input) { height: 44px; }
  .toolbar .search-box :deep(.search-box-clear) { width: 36px; height: 36px; }
  .toolbar .m-filter-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    height: 44px;
    padding: 0 14px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
  .toolbar .m-filter-toggle.on { background: var(--brand-soft); border-color: var(--brand); }
  .m-filter-n {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--primary);
    color: var(--surface);
    font-size: var(--fs-12);
    font-weight: 700;
  }
  .toolbar-filters { display: none; order: 1; flex: 1 1 100%; }
  /* 開いた「絞り込み」：白い面にまとめる（絞り込み・並び替え・型番で自動紐付け・利益の入力が入る） */
  .toolbar-filters.m-open {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    padding: 12px;
    background: var(--surface);
    border-radius: var(--radius);
    box-shadow: var(--shadow-1);
  }
  .toolbar-filters select { width: 100%; min-width: 0; height: 44px; }
  .toolbar-filters .period-select { display: flex; width: 100%; }
  .toolbar-filters .period-select.is-custom { grid-column: 1 / -1; }
  .toolbar-filters .period-select :deep(select) { flex: 1 1 100%; min-width: 0; width: 100%; height: 44px; }
  .toolbar-filters .period-select :deep(input) { flex: 1 1 120px; min-width: 0; height: 44px; }
  .toolbar-filters .month-chip-btn { grid-column: 1 / -1; justify-self: start; padding: 8px 0; }
  .toolbar-filters .sort-select { grid-column: 1 / -1; }
  .toolbar-filters .auto-link-btn { grid-column: 1 / -1; height: 44px; padding: 0 14px; }
  .toolbar-filters .m-input-filters {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .m-input-filters-label { flex: 0 0 auto; font-size: var(--fs-13); color: var(--text-dim); }
  .m-input-filter {
    flex: 1 1 0;
    min-width: 0;
    height: 44px;
    padding: 0 8px;
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
    color: var(--warn);
    font-size: var(--fs-13);
    font-weight: 600;
    white-space: nowrap;
  }
  .m-input-filter.on { background: var(--primary); border-color: var(--primary); color: var(--surface); }
  .toolbar .grow { display: none; }
  .toolbar .toolbar-count { order: 4; flex: 1 1 100%; text-align: right; line-height: 1.3; }

  .totals-bar { flex-wrap: wrap; gap: 4px 12px; padding: 10px 14px; }

  /* 作業リスト：1 件 1 枚のカード */
  .work-panel { padding: 0; background: transparent; box-shadow: none; border-radius: 0; overflow: visible; }
  .work-row-hdr { display: none; }
  /* カードの組み方（上から）：サムネ＋① 状態ラベル・② 名前・③ 補助・④ チップ／
     価格 …… 粗利／送料の選択／在庫の情報（原価・コード）／在庫の紐付けボタン …… 補助の操作（外部・メモ・…）。
     下の 2 行（在庫の情報と、ボタン＋補助の操作）で、カードの背を 1 段ぶん低くしている。
     縦の間隔は各項目の margin-top で持つ（空の行が余白だけ残さないように、行の gap は 0） */
  .work-row {
    grid-template-columns: 48px minmax(0, 1fr) auto;
    grid-template-areas:
      "thumb product product"
      "price price   profit"
      "ship  ship    ship"
      "info  info    info"
      "link  link    ops";
    gap: 0 12px;
    align-items: center;
    padding: 12px;
    margin-bottom: 10px;
    border-top: 0;
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow-1);
  }
  /* 今日の作業（発送してください）と、粗利がまだ出ないカードは、左に橙の帯 */
  .work-row.needs-shipment,
  .work-row.needs-input { box-shadow: inset 4px 0 0 var(--warn), var(--shadow-1); }

  .cell-thumb { align-self: start; }
  .thumb, .thumb-placeholder { width: 48px; height: 48px; }
  .cell-product { overflow: visible; }
  .cell-product .row-labels { min-height: 0; margin-bottom: 4px; }
  .m-flag { display: inline-flex; }
  /* 出品先は、メルカリ（既定）のときは出さない（毎枚同じで、状態ラベルの行を 2 段に押し下げるだけ）。ほかの出品先のときは出す */
  .row-labels .m-default-channel { display: none; }
  .work-row .row-title { -webkit-line-clamp: 3; min-height: 0; }
  /* 題を押せる範囲：文字の大きさと並びはそのまま、上下に 12px ずつ広げて高さ 44px 以上にする。
     広げた分は負の margin で打ち消す。前後の要素（状態ラベル・補助の行）に重なるが、どちらも押せない文字なので、
     上に出して（z-index）題の方が押される */
  .title-hit { position: relative; z-index: 1; margin: -12px 0; padding: 12px 0; }
  /* 「済」は、選んだセレクトがあった場所（44px）にそのまま出す */
  .cell-ship .held-done { min-height: 44px; }
  .work-row .row-sub { -webkit-line-clamp: 2; min-height: 0; }
  .work-row .chip-row.fixed-row { flex-wrap: wrap; min-height: 0; }
  .work-row .chip-row.fixed-row .chip-tags { flex-wrap: wrap; overflow: visible; }
  .work-row .note-row.fixed-row { min-height: 0; }
  .work-row .note-row.fixed-row:empty { display: none; }
  .work-row .note-row.fixed-row .note-text {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    white-space: normal;
  }

  /* 価格・粗利／送料／在庫の紐付け。カードを低くするため、価格と粗利は 1 行（小さな見出しは数字の左に並べる）、
     送料と在庫の紐付けは見出し無し（選ぶ欄・ボタンの文言そのものが何の欄かを言っている） */
  .cell-meta, .cell-cost, .cell-cost :deep(.allocation-cell) { display: contents; }
  .cell-price, .cell-ship, .cell-profit { margin-top: 8px; }
  .cell-price, .cell-ship { min-width: 0; }
  .m-label {
    display: block;
    margin-bottom: 2px;
    font-size: var(--fs-11);
    font-weight: 500;
    line-height: 1.4;
    color: var(--text-faint);
  }
  .cell-ship .m-label, .cell-cost .m-label { display: none; }
  .cell-price {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 8px;
    text-align: left;
    font-size: var(--fs-16);
    font-weight: 700;
  }
  /* 価格は、太字の金額と「手数料 −¥x」が並ぶので見出しを省く（393px でも 1 行に収める）。粗利は数字の左に見出し */
  .cell-price .m-label { display: none; }
  .cell-profit .m-label { display: inline; flex: 0 0 auto; margin: 0; }
  .cell-price .fee-line { justify-content: flex-start; margin-top: 0; font-size: var(--fs-12); font-weight: 400; }
  .cell-profit { display: flex; align-items: baseline; justify-content: flex-end; gap: 6px; justify-self: end; }
  .cell-profit strong { font-size: var(--fs-20); }
  .profit-na .why { font-size: var(--fs-12); }
  .cell-ship .ship-select { height: 44px; }
  .cell-ship .shipping-actual { min-height: 44px; }

  /* 在庫の紐付け：情報（原価・在庫コード・自動紐付けのひとこと・候補）は 1 行にまとめ、ボタン（44px 高）は下の行の左。
     「未紐付け」のチップは、状態ラベルに同じ語が出ているので隠す（.has-flag）。隠して何も残らないなら行ごと畳む（.info-none）。
     「済」の間に薄くする（.held の opacity）は、入れ物が無い（display: contents）ので、ここで中身に直接かける */
  .cell-cost :deep(.allocation-info) {
    grid-area: info;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    min-width: 0;
    margin-top: 6px;
  }
  .cell-cost > .faint { grid-area: info; margin-top: 6px; }
  .cell-cost.info-none :deep(.allocation-info) { display: none; }
  .cell-cost :deep(.allocation-state) { min-height: 0; }
  .cell-cost :deep(.allocation-cost-label) { display: inline; font-size: var(--fs-12); font-weight: 400; color: var(--text-faint); }
  .cell-cost.has-flag :deep(.allocation-unlinked) { display: none; }
  .cell-cost :deep(.allocation-hint) { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cell-cost :deep(.allocation-btn) {
    grid-area: link;
    justify-content: center;
    height: 44px;
    margin-top: 8px;
    padding: 0 14px;
    font-size: var(--fs-14);
    border-color: var(--line);
  }
  /* 橙（link-btn）のときは、橙の枠のまま */
  .cell-cost :deep(.allocation-btn.link-btn) { border-color: var(--warn-line); }
  .work-row.held .cell-cost :deep(.allocation-info),
  .work-row.held .cell-cost :deep(.allocation-btn) { opacity: .55; }

  /* 補助の操作：カードに残すのは「外部ページ」「メモ」と「…」だけ。タグ・履歴・梱包・手数料・削除は「…」のシートへ
     （.m-more-item）。ホバーが無いので薄くせず、44px 高。在庫の紐付けボタンの右に、同じ行で並べる */
  .cell-ops {
    justify-self: end;
    flex-wrap: nowrap;
    gap: 6px;
    margin-top: 8px;
  }
  .cell-ops:empty { display: none; }
  .cell-ops button {
    flex: 0 0 auto;
    min-width: 44px;
    height: 44px;
    padding: 0 12px;
    font-size: var(--fs-13);
    border-color: var(--line);
  }
  .cell-ops .m-more-item { display: none; }
  .cell-ops .m-more-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 56px; padding: 0; }
  .fade-btn { opacity: 1; }

  /* 「転売」チップ（押すと私物に変える）は見た目のまま、押せる範囲だけ広げる */
  .kind-toggle { position: relative; }
  .kind-toggle::after { content: ''; position: absolute; inset: -10px -6px; }
}
</style>
