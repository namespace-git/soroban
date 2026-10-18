<script setup lang="ts">
import { isRealized } from '../../shared/recognition'
// 在庫の引き当て／紐付け。出品（mode='listing'）と販売（mode='sale'）の両方から使う。
// チェックした瞬間に下端の原価合計・粗利プレビューが動く。確定は「引き当てる／紐付ける」ボタンで初めて起きる。
import { ref, computed, watch, inject } from 'vue'
import type { Listing, InventoryItem, ListingStatus, SaleProfit, ProductSummary, SalesChannel, AutoLinkBlocker } from '../../shared/types'
import { CHANNEL_LABEL, LISTING_STATUS_LABEL } from '../../shared/types'
import Drawer from './Drawer.vue'
import StatusChip from './StatusChip.vue'
import CodeChip from './CodeChip.vue'
import EmptyState from './EmptyState.vue'
import Icon from './Icon.vue'
import { matchesSearch } from './SearchBox.vue'
import type { ConfirmChoice } from './ConfirmDialog.vue'
import { yen, shortDate } from '../format'

type MatchedRow = { id: string; item_code: string; name: string; model_code?: string | null; product_name?: string | null; landed_cost: number; aging_days?: number }
type ProfitEstimate = { fee: number; shipping_fee: number; packaging_cost: number; cost: number; gross_profit: number }

const props = defineProps<{
  open: boolean
  mode: 'listing' | 'sale'
  listing?: Listing | null
  sale?: SaleProfit | null
}>()
const emit = defineEmits<{ close: []; changed: [] }>()

const toast = inject<(text: string, kind: 'ok' | 'warn', action?: { label: string; run: () => void | Promise<void> }) => void>('toast')!
const choose = inject<(title: string, choices: ConfirmChoice[], opts?: { message?: string }) => Promise<string | null>>('choose')!

const candidates = ref<InventoryItem[]>([])
const matchedItems = ref<MatchedRow[]>([])
/**
 * 型番は合っているのに、別の出品（別の出品先のことがある）に取ってあるせいで
 * 候補（candidates）から外れている在庫。sale モードだけで使う。「外して選ぶ」で
 * unreserveInventory を呼んだ直後に picked へ入れる（外す→選ぶを2手にしない）
 */
const blockers = ref<AutoLinkBlocker[]>([])
const takingBlockerId = ref<string | null>(null)
const picked = ref<Set<string>>(new Set())
const search = ref('')
const loading = ref(false)
const productInfo = ref(new Map<string, ProductSummary>())
const failedProductImages = ref(new Set<string>())
// 毎日ここで紐付けるので、開いた瞬間から「商品から選ぶ（先入れ先出し）」になっている
const selectionMode = ref<'inventory' | 'product'>('product')
const productQuantity = ref(1)
const pickingProduct = ref(false)
let productPickRequest = 0
// メンテ用：販売済み（他の販売に紐付いた）在庫も候補に出す。ドロワーを開き直すたびに off に戻す
const includeSold = ref(false)
// 「ほかの型番から探す」の畳み（型番が一致する在庫があるときだけ畳む）。下端の「選択中」の展開も、開き直すたびに閉じる
const othersOpen = ref(false)
const pickedOpen = ref(false)
// 開いた時点で自動でチェックした在庫（型番一致の候補が 1 点だけのとき）。印を出すためだけに覚える。確定は人
const autoPickedId = ref<string | null>(null)
// 開いて最初の読み込みが終わったときだけ、自動チェックを試す（紐付け解除のあとの再読み込みでは試さない）
let autoPickPending = false

// チェックが変わるたびに main へ見積もりを頼む（手数料・送料は画面で計算しない）。
// 150ms デバウンスし、応答が前後しても最後に投げた要求の結果だけを反映する。
// （下の開閉の watch が immediate で先に走るので、状態はここで先に宣言しておく）
const estimate = ref<ProfitEstimate | null>(null)
// estimate がどの在庫の組み合わせの見積もりか。確定の通知に出す粗利が、いま選んでいる分のものか確かめるのと、
// 下端の計算行が「古い見積もり」を出さないかの両方に使う
const estimateKey = ref('')
// 見積もりの取得に失敗した（「計算中…」のまま止めない）
const estimateFailed = ref(false)
let estimateTimer: ReturnType<typeof setTimeout> | undefined
let estimateSeq = 0

const STATUS_TONE: Record<ListingStatus, 'brand' | 'neutral' | 'ok' | 'info'> = {
  active: 'info', suspended: 'neutral', sold: 'ok', ended: 'neutral',
}

const title = computed(() => (props.mode === 'listing' ? props.listing?.title : props.sale?.title) ?? '')
const price = computed(() => (props.mode === 'listing' ? props.listing?.price : props.sale?.price) ?? 0)

let loadRequest = 0
async function load() {
  const request = ++loadRequest
  const mode = props.mode, listing = props.listing, sale = props.sale
  const opts = { includeSold: includeSold.value }
  loading.value = true
  candidates.value = []
  matchedItems.value = []
  blockers.value = []
  try {
    if ((mode === 'listing' && !listing) || (mode === 'sale' && !sale)) return
    // 検索前に件数を切らず、どの注文の在庫も検索できるようにする。
    const [products, suggestions, linked, blockerList] = await Promise.all([
      window.soroban.listProducts(),
      mode === 'listing'
        ? window.soroban.suggestForListing(listing!.mercari_item_id, Number.MAX_SAFE_INTEGER, opts)
        : window.soroban.suggestInventory(sale!.id, Number.MAX_SAFE_INTEGER, opts),
      mode === 'listing' ? Promise.resolve(listing!.items) : window.soroban.listSaleLines(sale!.id),
      // 「型番は合っているのに出品に取ってあるせいで候補から外れた在庫」。sale モードだけ
      mode === 'sale' ? window.soroban.getAutoLinkBlockers(sale!.id) : Promise.resolve([]),
    ])
    if (request !== loadRequest || !props.open) return
    productInfo.value = new Map(products.map(p => [p.model_code, p]))
    candidates.value = suggestions
    matchedItems.value = linked
    blockers.value = blockerList
    if (autoPickPending) {
      autoPickPending = false
      applyAutoPick()
    }
  } catch (e) {
    if (request === loadRequest) {
      autoPickPending = false
      toast(e instanceof Error ? e.message : String(e), 'warn')
    }
  } finally {
    if (request === loadRequest) loading.value = false
  }
}

watch(
  () => [props.open, props.mode, props.listing?.mercari_item_id, props.sale?.id] as const,
  ([isOpen, mode, listingId, saleId], prev) => {
    loadRequest++
    picked.value = new Set()
    search.value = ''
    selectionMode.value = 'product'
    productQuantity.value = 1
    productPickRequest++
    pickingProduct.value = false
    includeSold.value = false
    blockers.value = []
    takingBlockerId.value = null
    othersOpen.value = false
    pickedOpen.value = false
    autoPickedId.value = null
    // 前の販売・出品の見積もりを引きずらない（同じ在庫を選んだときに、前の粗利が一瞬出るのを防ぐ）
    clearTimeout(estimateTimer)
    estimateSeq++
    estimate.value = null
    estimateKey.value = ''
    estimateFailed.value = false
    // 開いた時点（または別の販売・出品に切り替わった時点）だけ自動チェックを試す。
    // 親が同じ販売のデータを更新し直しただけのときは試さない（解除した在庫をまたチェックしてしまうため）
    const fresh = isOpen && (!prev || !prev[0] || prev[1] !== mode || prev[2] !== listingId || prev[3] !== saleId)
    autoPickPending = fresh
    if (isOpen) load()
  },
  { immediate: true },
)

watch(includeSold, () => {
  if (props.open) load()
})

const filtered = computed(() => {
  if (!search.value.trim()) return candidates.value
  return candidates.value.filter(c => matchesSearch([
    c.name, c.product_name, c.model_code, c.item_code, c.order_no, c.shop_account_name,
  ], search.value))
})

watch(selectionMode, () => { search.value = '' })

const pickedItems = computed(() => candidates.value.filter(c => picked.value.has(c.id)))

// --- 型番が一致する候補を先頭に、ほかの型番は畳む ---------------------------------
// 一致の定義は main の suggestInventory / 自動紐付けと同じ：販売（出品）の型番と在庫の model_code が
// 文字列として完全一致（枝番の有無は問わない）。タイトルに【S-0012】と在庫コードで名指ししてある在庫も、
// 型番一致と同じく先頭に出す（候補の並びでも先頭に来るもの。畳みの中に隠さない）
const targetModelCodes = computed(() =>
  new Set((props.mode === 'listing' ? props.listing?.model_codes : props.sale?.model_codes) ?? []))
const titleItemCodes = computed(() => new Set(title.value.match(/\bS-\d{4,}\b/g) ?? []))
function isModelMatch(modelCode: string | null | undefined): boolean {
  return !!modelCode && targetModelCodes.value.has(modelCode)
}
function isMatchedCandidate(c: InventoryItem): boolean {
  return isModelMatch(c.model_code) || titleItemCodes.value.has(c.item_code)
}

type ProductGroup = { code: string; name: string; available: number; picked: number; names: string[] }
type ListHead = { kind: 'head'; key: string; label: string }
type ListToggle = { kind: 'toggle'; key: string; label: string }
type InventoryListRow = ListHead | ListToggle | { kind: 'item'; key: string; c: InventoryItem }
type ProductListRow = ListHead | ListToggle | { kind: 'product'; key: string; p: ProductGroup }

const searching = computed(() => search.value.trim() !== '')

// 商品ごとのまとめ（検索で絞る前）。選んだ分も数えて行を残す＝選んでも行が消えて下の行がせり上がらない
const allProductGroups = computed(() => {
  const groups = new Map<string, ProductGroup>()
  for (const c of candidates.value) {
    if (!c.model_code || c.status !== 'in_stock' || c.listing || c.sold_to) continue
    const group = groups.get(c.model_code) ?? { code: c.model_code, name: productInfo.value.get(c.model_code)?.name ?? c.product_name ?? c.name, available: 0, picked: 0, names: [] }
    if (picked.value.has(c.id)) group.picked++
    else group.available++
    group.names.push(c.name, c.product_name ?? '')
    groups.set(c.model_code, group)
  }
  return [...groups.values()]
})
const productGroups = computed(() =>
  allProductGroups.value.filter(p => matchesSearch([p.code, ...p.names], search.value)))

// 型番一致があるときだけ「ほかの型番」を畳む。検索欄に文字があるあいだは畳みを解いて全部から探す
const hasMatched = computed(() => selectionMode.value === 'product'
  ? allProductGroups.value.some(p => isModelMatch(p.code))
  : candidates.value.some(isMatchedCandidate))
const foldable = computed(() => hasMatched.value && !searching.value)
const showOthers = computed(() => !foldable.value || othersOpen.value)

const inventoryRows = computed<InventoryListRow[]>(() => {
  const matched = filtered.value.filter(isMatchedCandidate)
  const others = filtered.value.filter(c => !isMatchedCandidate(c))
  const rows: InventoryListRow[] = []
  if (matched.length) {
    rows.push({ kind: 'head', key: 'head-match', label: '型番が一致する在庫' })
    for (const c of matched) rows.push({ kind: 'item', key: c.id, c })
  }
  if (others.length) {
    if (foldable.value) rows.push({ kind: 'toggle', key: 'toggle-others', label: `ほかの型番から探す（${others.length}点）` })
    else if (matched.length) rows.push({ kind: 'head', key: 'head-others', label: 'ほかの型番' })
    if (showOthers.value) for (const c of others) rows.push({ kind: 'item', key: c.id, c })
  }
  return rows
})

const productRows = computed<ProductListRow[]>(() => {
  const matched = productGroups.value.filter(p => isModelMatch(p.code))
  const others = productGroups.value.filter(p => !isModelMatch(p.code))
  const rows: ProductListRow[] = []
  if (matched.length) {
    rows.push({ kind: 'head', key: 'head-match', label: '型番が一致する在庫' })
    for (const p of matched) rows.push({ kind: 'product', key: p.code, p })
  }
  if (others.length) {
    if (foldable.value) rows.push({ kind: 'toggle', key: 'toggle-others', label: `ほかの型番から探す（${others.length}商品）` })
    else if (matched.length) rows.push({ kind: 'head', key: 'head-others', label: 'ほかの型番' })
    if (showOthers.value) for (const p of others) rows.push({ kind: 'product', key: p.code, p })
  }
  return rows
})

// 「追加する点数」は、いま見えている商品に同じ型番の在庫が 2 点以上あるときだけ出す（1 点以下なら選ぶ点数は 1 で決まり）
const visibleProductGroups = computed(() =>
  productRows.value.flatMap(r => (r.kind === 'product' ? [r.p] : [])))
const showQuantity = computed(() => visibleProductGroups.value.some(p => p.available >= 2))
const maxQuantity = computed(() => Math.max(1, ...visibleProductGroups.value.map(p => p.available)))
// 欄が見えないときの点数は 1（前に増やした値を持ち越して「指定 3 点」にしない）
const effectiveQuantity = computed(() => (showQuantity.value ? productQuantity.value : 1))
const validProductQuantity = computed(() => Number.isSafeInteger(effectiveQuantity.value) && effectiveQuantity.value > 0)
function stepQuantity(delta: number) {
  const current = Number.isSafeInteger(productQuantity.value) ? productQuantity.value : 1
  productQuantity.value = Math.min(maxQuantity.value, Math.max(1, current + delta))
}
watch(maxQuantity, (max) => {
  if (Number.isSafeInteger(productQuantity.value) && productQuantity.value > max) productQuantity.value = max
})

/**
 * 開いた時点の自動チェック。未紐付け（すでに紐付けた在庫が無い）で、型番一致の候補が 1 点だけのときだけ。
 * 他の出品に取ってある在庫・販売済みの在庫は対象外（奪わない）。チェックを入れるだけで、確定は人が押す
 */
function applyAutoPick() {
  if (!canReserve.value || matchedItems.value.length > 0 || picked.value.size > 0) return
  const matches = candidates.value.filter(isMatchedCandidate)
  if (matches.length !== 1) return
  const only = matches[0]
  if (only.status !== 'in_stock' || only.listing || only.sold_to) return
  picked.value = new Set([only.id])
  autoPickedId.value = only.id
}
const autoPicked = computed(() =>
  candidates.value.find(c => c.id === autoPickedId.value && picked.value.has(c.id)) ?? null)
const autoPickedMark = computed(() =>
  !autoPicked.value ? null : isModelMatch(autoPicked.value.model_code) ? '型番一致の候補' : '在庫コード一致の候補')
function markFor(c: InventoryItem): string | null {
  return autoPicked.value?.id === c.id ? autoPickedMark.value : null
}
function markForProduct(p: ProductGroup): string | null {
  return autoPicked.value?.model_code === p.code ? autoPickedMark.value : null
}
function productStock(p: ProductGroup): string {
  return p.picked > 0
    ? `選択中 ${p.picked}点 ・ 残り ${p.available}点`
    : `選べる在庫 ${p.available}点`
}

// 下端の固定バーの 1 行要約：「選択中 2点：S-0007、S-0012」。コードは 3 つまで、残りは …
const pickedSummary = computed(() => {
  const codes = pickedItems.value.map(c => c.item_code)
  return codes.slice(0, 3).join('、') + (codes.length > 3 ? '…' : '')
})
watch(() => pickedItems.value.length, (n) => { if (n === 0) pickedOpen.value = false })

async function pickProduct(modelCode: string) {
  if (!validProductQuantity.value || pickingProduct.value) return
  const request = ++productPickRequest
  const quantity = effectiveQuantity.value
  pickingProduct.value = true
  try {
    const ids = await window.soroban.suggestProductInventory(modelCode, quantity,
      [...matchedItems.value.map(i => i.id), ...picked.value])
    if (request !== productPickRequest || !props.open) return
    const candidateIds = new Set(candidates.value.map(c => c.id))
    if (ids.some(id => !candidateIds.has(id))) {
      toast('在庫が更新されています。画面を開き直してください', 'warn')
      return
    }
    picked.value = new Set([...picked.value, ...ids])
    if (ids.length < quantity) toast(`選べる在庫は${ids.length}点です（指定${quantity}点）`, 'warn')
  } catch (e) {
    if (request === productPickRequest) toast(e instanceof Error ? e.message : String(e), 'warn')
  } finally {
    if (request === productPickRequest) pickingProduct.value = false
  }
}

function candidateDescription(c: InventoryItem): string {
  return [c.product_name ? c.name : null, c.shop_account_name, c.order_no ? `注文 ${c.order_no}` : null]
    .filter(Boolean).join(' ・ ')
}

// 出品モード：終了済み（sold／ended）の出品には新規に引き当てられない。引き当て済みの表示だけ残す
const canReserve = computed(() =>
  props.mode === 'sale' || props.listing?.status === 'active' || props.listing?.status === 'suspended',
)

function toggle(id: string) {
  const s = new Set(picked.value)
  s.has(id) ? s.delete(id) : s.add(id)
  picked.value = s
}

const matchedCost = computed(() => matchedItems.value.reduce((s, m) => s + m.landed_cost, 0))
const pickedCost = computed(() =>
  candidates.value.filter(c => picked.value.has(c.id)).reduce((s, c) => s + c.landed_cost, 0),
)
const totalCost = computed(() => matchedCost.value + pickedCost.value)
const totalCount = computed(() => matchedItems.value.length + picked.value.size)

// チェック済みの候補のうち、他の出品からの移動になるもの（出品モードのみ）
const movingCount = computed(() =>
  props.mode === 'listing'
    ? candidates.value.filter(c => picked.value.has(c.id) && c.listing).length
    : 0,
)
const confirmLabel = computed(() => {
  return movingCount.value > 0 ? `紐付けを確定（${movingCount.value}点を移す）` : '紐付けを確定'
})

const profitLabel = computed(() => {
  if (props.mode !== 'listing') return props.sale && isRealized(props.sale) ? '粗利' : '見込み粗利'
  return props.listing?.shipping_method_id ? '見込み粗利（送料込み・梱包前）' : '見込み粗利（送料・梱包前）'
})

function selectionKey(ids: string[]): string {
  return [...ids].sort().join(',')
}
const currentKey = computed(() => selectionKey([...matchedItems.value.map(m => m.id), ...picked.value]))

async function runEstimate() {
  const seq = ++estimateSeq
  const inventoryItemIds = [...matchedItems.value.map(m => m.id), ...picked.value]
  let priceVal: number
  let shippingMethodId: string | null
  let packagingCost: number | undefined
  let channel: SalesChannel | undefined
  let fee: number | null | undefined
  if (props.mode === 'listing') {
    if (!props.listing) { estimate.value = null; estimateKey.value = ''; return }
    priceVal = props.listing.price
    shippingMethodId = props.listing.shipping_method_id
    packagingCost = 0 // 出品はまだ梱包費が無い（見込み粗利は送料込み・梱包前）
    channel = props.listing.channel
  } else {
    if (!props.sale) { estimate.value = null; estimateKey.value = ''; return }
    priceVal = props.sale.price
    shippingMethodId = props.sale.shipping_method_id
    packagingCost = props.sale.packaging_cost
    channel = props.sale.channel
    // 手数料が実額で確定しているなら率では見積もらず、その実額をそのまま使う（0 も実額）
    if (props.sale.fee_source === 'actual') fee = props.sale.fee
  }
  try {
    const result = await window.soroban.estimateSaleProfit({
      price: priceVal,
      shipping_method_id: shippingMethodId,
      packaging_cost: packagingCost,
      inventory_item_ids: inventoryItemIds,
      channel,
      fee,
    })
    if (seq === estimateSeq) {
      estimate.value = result
      estimateKey.value = selectionKey(inventoryItemIds)
      estimateFailed.value = false
    }
  } catch {
    // 古い数字を残さない。計算行は「計算中…」のままにせず、出せなかったと言う
    if (seq === estimateSeq) {
      estimate.value = null
      estimateKey.value = ''
      estimateFailed.value = true
    }
  }
}

function scheduleEstimate() {
  clearTimeout(estimateTimer)
  estimateTimer = setTimeout(runEstimate, 150)
}

watch(
  [picked, matchedItems, () => props.listing, () => props.sale],
  scheduleEstimate,
  { deep: true },
)

const previewProfit = computed(() => estimate.value?.gross_profit ?? 0)
// 見積もりが「いま選んでいる在庫」のものか。チェックを変えてから main の見積もりが返るまで（Web 版は 300〜500ms）は
// 前の点数の数字が残っているので、計算行はそのあいだ数字を出さず「計算中…」にする
const estimateReady = computed(() => estimate.value !== null && estimateKey.value === currentKey.value)

function truncate(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) + '…' : text
}
function soldToLabel(sold: { title: string; price: number }): string {
  return `販売「${truncate(sold.title, 12)}」${yen(sold.price)} に紐付け済み`
}
/** 紐付けを確定したときの通知。在庫コードは 3 つまで、残りは「ほか n 点」。粗利が無ければその部分は出さない */
function linkedToastText(codes: string[], profit: number | null, label: string): string {
  const shown = codes.slice(0, 3).join('、')
  const rest = codes.length - 3
  const head = rest > 0 ? `${shown} ほか${rest}点` : shown
  return `${head} を紐付けました${profit === null ? '' : ` ・ ${label} ${yen(profit)}`}`
}

// picked の中に販売済み（他の販売に紐付いた）在庫が含まれるなら、付け替えの警告を出してから進む
async function confirmPick() {
  if (picked.value.size === 0) return
  const ids = [...picked.value]
  const soldPicks = candidates.value.filter(c => ids.includes(c.id) && c.sold_to)
  let takeFromSale = false
  if (soldPicks.length > 0) {
    const lines = soldPicks.slice(0, 5).map(c => {
      const s = c.sold_to!
      return `${c.item_code}「${truncate(c.product_name ?? c.name, 12)}」は販売「${truncate(s.title, 12)}」（${yen(s.price)}・${shortDate(s.sold_at)}）に紐付いています。`
    })
    if (soldPicks.length > 5) lines.push(`ほか${soldPicks.length - 5}点`)
    lines.push('外してこちらに付け替えると、元の販売は未紐付けに戻り、その粗利が変わります（ホームの要対応に出ます）。')
    const choice = await choose('販売済みの在庫を付け替えます', [
      { label: 'キャンセル', value: 'cancel', tone: 'ghost' },
      { label: '付け替える', value: 'replace', tone: 'danger' },
    ], { message: lines.join('\n') })
    if (choice !== 'replace') return
    takeFromSale = true
  }
  const opts = takeFromSale ? { takeFromSale: true } : undefined
  // 確定して閉じたあとの通知に使う。シートが出していた見積もり（粗利）はここで控える
  // （閉じると props が空になり、粗利の見出しも見積もりも使えなくなる）。いま選んでいる分の見積もりでなければ粗利は出さない
  const doneText = linkedToastText(
    candidates.value.filter(c => ids.includes(c.id)).map(c => c.item_code),
    estimate.value && estimateKey.value === currentKey.value ? estimate.value.gross_profit : null,
    profitLabel.value,
  )
  try {
    if (props.mode === 'listing' && props.listing) {
      const moved = candidates.value.filter(c => ids.includes(c.id) && c.listing).length
      await window.soroban.reserveInventory(props.listing.mercari_item_id, ids, opts)
      picked.value = new Set()
      emit('changed')
      await load()
      toast(
        moved > 0
          ? `${ids.length}点を紐付けました（${moved}点は別の出品から移しました）`
          : `${ids.length}点を紐付けました`,
        'ok',
      )
    } else if (props.mode === 'sale' && props.sale) {
      await window.soroban.linkInventory(props.sale.id, ids, opts)
      picked.value = new Set()
      emit('changed')
      emit('close')
      toast(doneText, 'ok')
    }
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'warn')
  }
}

async function unlink(itemId: string) {
  try {
    if (props.mode === 'listing' && props.listing) {
      await window.soroban.unreserveInventory(props.listing.mercari_item_id, itemId)
    } else if (props.mode === 'sale' && props.sale) {
      await window.soroban.unlinkInventory(props.sale.id, itemId)
    }
    emit('changed')
    await load()
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'warn')
  }
}

/** 状態ラベル（①）。出品側の在庫状態が押す前に分かるよう、出品先と状態を短く出す */
function blockerStatusLabel(b: AutoLinkBlocker): string {
  return `${CHANNEL_LABEL[b.listing_channel]}・${LISTING_STATUS_LABEL[b.listing_status]}`
}
/** 補助（③）。元の出品からは外れることが押す前に分かる言い回しにする */
function blockerNote(b: AutoLinkBlocker): string {
  return `出品「${truncate(b.listing_title, 20)}」に取ってある`
}

/**
 * 出品に取ってある在庫を、その出品から外してこの販売の候補として選ぶ（1クリック）。
 * まだ売れていない出品から外すだけなので、付け替え（confirmPick の takeFromSale）のような
 * 確認ダイアログは要らない。外れた瞬間に picked へ入れ、粗利プレビューにそのまま反映させる
 */
async function takeFromListing(b: AutoLinkBlocker) {
  if (!props.sale || takingBlockerId.value) return
  takingBlockerId.value = b.inventory_item_id
  try {
    await window.soroban.unreserveInventory(b.listing_id, b.inventory_item_id)
    emit('changed')
    await load()
    picked.value = new Set([...picked.value, b.inventory_item_id])
    toast(`${b.item_code} を出品「${truncate(b.listing_title, 14)}」から外して選びました`, 'ok')
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'warn')
  } finally {
    takingBlockerId.value = null
  }
}

const thumbFailed = ref(false)
watch(() => [props.listing?.mercari_item_id, props.sale?.id], () => { thumbFailed.value = false })
function placeholderChar(): string {
  if (props.mode === 'listing') {
    const l = props.listing
    const c = l?.model_codes[0]?.[0] ?? l?.title.trim().charAt(0)
    return (c || '?').toUpperCase()
  }
  const s = props.sale
  const c = s?.model_codes[0]?.[0] ?? s?.title.trim().charAt(0)
  return (c || '?').toUpperCase()
}
</script>

<template>
  <Drawer :open="open" :title="title" :width="560" @close="emit('close')">
    <template #header-sub>
      <!-- allocate-sheet：下の非 scoped な style が、スマホ幅でシートの高さを固定するための目印 -->
      <div v-if="mode === 'listing' && listing" class="head-sub allocate-sheet">
        <img
          v-if="listing.thumb_url && !thumbFailed"
          class="thumb" :src="listing.thumb_url" alt=""
          @error="thumbFailed = true"
        />
        <span v-else class="thumb-placeholder">{{ placeholderChar() }}</span>
        <span class="faint">出品価格 {{ yen(listing.price) }}</span>
        <span v-if="listing.shipping_method_name" class="faint">{{ listing.shipping_method_name }}</span>
        <StatusChip :tone="STATUS_TONE[listing.status]" :label="LISTING_STATUS_LABEL[listing.status]" />
      </div>
      <div v-else-if="mode === 'sale'" class="head-sub allocate-sheet">
        <img v-if="sale?.thumb_url && !thumbFailed" class="thumb" :src="sale.thumb_url" alt="" @error="thumbFailed = true" />
        <span v-else class="thumb-placeholder">{{ placeholderChar() }}</span>
        <span class="faint">販売価格 {{ yen(price) }}</span>
      </div>
    </template>

    <p class="panel-title">在庫の紐付け</p>
    <p class="faint allocation-help">{{ mode === 'listing' ? '出品中は在庫を予約します。売れたら、その在庫を販売に引き継ぎます。' : 'この販売の原価に使う在庫を選びます。' }}</p>
    <p v-if="loading" class="faint" role="status">在庫を読み込んでいます…</p>
    <div v-if="matchedItems.length" class="matched-block">
      <p class="panel-title">紐付け済み</p>
      <div v-for="m in matchedItems" :key="m.id" class="item matched-item">
        <CodeChip kind="item" :code="m.item_code" />
        <CodeChip v-if="m.model_code" kind="model" :code="m.model_code" />
        <span class="grow name-cell">
          <span class="name-main" :title="m.product_name ?? m.name">{{ m.product_name ?? m.name }}</span>
          <span class="name-sub" :title="m.product_name ? m.name : ''">{{ m.product_name ? m.name : '' }}</span>
        </span>
        <span v-if="m.aging_days != null" class="faint nowrap">{{ m.aging_days }}日</span>
        <span class="num">{{ yen(m.landed_cost) }}</span>
        <button class="sm ghost" @click="unlink(m.id)">解除</button>
      </div>
    </div>

    <!-- 型番は合っているのに、別の出品（他社サイトのこともある）に取ってあるせいで
         候補から外れている在庫。「在庫が無い」わけではないので、ふつうの候補（picked-block等）とは
         見た目を分け、1クリックで外して選べるようにする -->
    <div v-if="blockers.length" class="blocked-block">
      <p class="panel-title">在庫はあるが出品に取ってある</p>
      <p class="faint blocked-help">別の出品が押さえたままです。外すと、その場でこの販売の候補として選べます（出品はまだ売れていません）</p>
      <div v-for="b in blockers" :key="b.inventory_item_id" class="item blocked-item">
        <span class="grow name-cell">
          <span class="row-labels">
            <CodeChip kind="item" :code="b.item_code" />
            <CodeChip kind="model" :code="b.model_code" />
            <StatusChip tone="warn" :label="blockerStatusLabel(b)" />
          </span>
          <span class="name-main" :title="b.name">{{ b.name }}</span>
          <span class="name-sub" :title="blockerNote(b)">{{ blockerNote(b) }}</span>
        </span>
        <span class="num">{{ yen(b.landed_cost) }}</span>
        <button class="sm" :disabled="takingBlockerId === b.inventory_item_id" @click="takeFromListing(b)">
          {{ takingBlockerId === b.inventory_item_id ? '外しています…' : '外して選ぶ' }}
        </button>
      </div>
    </div>

    <p v-if="!canReserve" class="dim ended-note">この出品は終了しています（追加できません）</p>

    <template v-else>
      <div class="selection-modes" role="group" aria-label="在庫の選び方">
        <button class="sm" :class="selectionMode === 'inventory' ? 'primary' : 'ghost'" :aria-pressed="selectionMode === 'inventory'" @click="selectionMode = 'inventory'">在庫から選ぶ</button>
        <button class="sm" :class="selectionMode === 'product' ? 'primary' : 'ghost'" :aria-pressed="selectionMode === 'product'" @click="selectionMode = 'product'">商品から選ぶ（先入れ先出し）</button>
      </div>
      <label class="search-field">
        <Icon name="search" :size="16" />
        <input v-model="search" :placeholder="selectionMode === 'inventory' ? '商品名・型番・在庫コード・注文番号・仕入先で検索' : '商品名・型番で検索'" />
      </label>

      <!-- 選んだ在庫は、リストの上に差し込まない（行がずれて 2 度押しの誤タップになる）。
           下端の固定バー（footer の計算行の上）に 1 行で出す -->

      <template v-if="selectionMode === 'product'">
        <p class="faint product-help">型番が一致する未紐付け在庫を、仕入日の古い順に選びます。</p>
        <div v-if="showQuantity" class="qty-stepper" role="group" aria-label="追加する点数">
          <span class="qty-label">追加する点数</span>
          <button type="button" class="qty-btn" aria-label="1点減らす" :disabled="productQuantity <= 1" @click="stepQuantity(-1)">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="10" x2="16" y2="10" /></svg>
          </button>
          <input v-model.number="productQuantity" type="number" inputmode="numeric" min="1" :max="maxQuantity" step="1" aria-label="追加する点数" />
          <button type="button" class="qty-btn" aria-label="1点増やす" :disabled="productQuantity >= maxQuantity" @click="stepQuantity(1)">
            <Icon name="plus" :size="20" />
          </button>
        </div>
        <div class="candidates">
          <template v-for="row in productRows" :key="row.key">
            <p v-if="row.kind === 'head'" class="panel-title group-head">{{ row.label }}</p>
            <button
              v-else-if="row.kind === 'toggle'"
              type="button" class="group-toggle"
              :aria-expanded="showOthers" @click="othersOpen = !othersOpen"
            >
              <span>{{ row.label }}</span>
              <span class="caret" :class="{ open: showOthers }"><Icon name="arrow-right" :size="14" /></span>
            </button>
            <div v-else-if="row.kind === 'product'" class="product-row" :class="{ on: row.p.picked > 0 }">
              <img v-if="productInfo.get(row.p.code)?.thumb_url && !failedProductImages.has(productInfo.get(row.p.code)!.thumb_url!)"
                class="product-thumb" :src="productInfo.get(row.p.code)!.thumb_url!" alt="" loading="lazy"
                @error="failedProductImages.add(productInfo.get(row.p.code)!.thumb_url!)" />
              <span v-else class="product-thumb product-placeholder">{{ row.p.code.charAt(0) }}</span>
              <div class="grow name-cell">
                <span class="row-labels">
                  <CodeChip kind="model" :code="row.p.code" />
                  <StatusChip v-if="markForProduct(row.p)" tone="info" :label="markForProduct(row.p)!" />
                </span>
                <span :title="row.p.name">{{ row.p.name }}</span>
                <span :class="row.p.picked > 0 ? 'dim' : 'faint'">{{ productStock(row.p) }}</span>
              </div>
              <span v-if="row.p.available === 0" class="picked-done"><Icon name="check" :size="16" />選択済み</span>
              <button v-else class="sm" :disabled="!validProductQuantity || pickingProduct || loading" :aria-label="`${row.p.code}を古い順に選ぶ`" @click="pickProduct(row.p.code)">古い順に選ぶ</button>
            </div>
          </template>
          <EmptyState v-if="!loading && !productRows.length" title="選べる商品がありません" />
        </div>
        <p class="faint product-help">型番のない在庫や、紐付け済みの在庫は「在庫から選ぶ」で指定できます。</p>
      </template>

      <div v-else class="candidates">
        <template v-for="row in inventoryRows" :key="row.key">
          <p v-if="row.kind === 'head'" class="panel-title group-head">{{ row.label }}</p>
          <button
            v-else-if="row.kind === 'toggle'"
            type="button" class="group-toggle"
            :aria-expanded="showOthers" @click="othersOpen = !othersOpen"
          >
            <span>{{ row.label }}</span>
            <span class="caret" :class="{ open: showOthers }"><Icon name="arrow-right" :size="14" /></span>
          </button>
          <label
            v-else-if="row.kind === 'item'"
            class="item" :class="{ on: picked.has(row.c.id), sold: !!row.c.sold_to }"
          >
            <input
              type="checkbox"
              :checked="picked.has(row.c.id)"
              @change="toggle(row.c.id)"
            />
            <CodeChip kind="item" :code="row.c.item_code" />
            <CodeChip v-if="row.c.model_code" kind="model" :code="row.c.model_code" />
            <StatusChip v-if="markFor(row.c)" tone="info" :label="markFor(row.c)!" />
            <StatusChip
              v-if="mode === 'listing' && row.c.listing && row.c.listing.mercari_item_id !== listing?.mercari_item_id"
              tone="neutral"
              :label="`出品 ${yen(row.c.listing.price)} に紐付け済み`"
            />
            <StatusChip v-if="row.c.sold_to" tone="warn" :label="soldToLabel(row.c.sold_to)" />
            <span class="grow name-cell">
              <span class="name-main" :title="row.c.product_name ?? row.c.name">{{ row.c.product_name ?? row.c.name }}</span>
              <span class="name-sub" :title="candidateDescription(row.c)">{{ candidateDescription(row.c) }}</span>
            </span>
            <span class="faint nowrap">{{ row.c.aging_days }}日</span>
            <span class="num">{{ yen(row.c.landed_cost) }}</span>
          </label>
        </template>
        <EmptyState v-if="!loading && !inventoryRows.length" title="候補になる在庫がありません" />
      </div>

      <label v-if="selectionMode === 'inventory'" class="faint maint-toggle">
        <input type="checkbox" v-model="includeSold" />
        販売済みの在庫も表示（付け替え）
      </label>
    </template>

    <template #footer>
      <div class="match-footer">
        <!-- 選んだ在庫の 1 行要約。押すとバーの中で上に伸びて、1 点ずつ外せる -->
        <div v-if="pickedItems.length" class="picked-bar">
          <button
            type="button" class="picked-toggle"
            :aria-expanded="pickedOpen" aria-controls="picked-list"
            @click="pickedOpen = !pickedOpen"
          >
            <span class="picked-summary">選択中 {{ pickedItems.length }}点：{{ pickedSummary }}</span>
            <span class="caret" :class="{ open: pickedOpen }"><Icon name="arrow-right" :size="14" /></span>
          </button>
          <div v-if="pickedOpen" id="picked-list" class="picked-list">
            <p class="faint picked-note">まだ確定していません。「紐付けを確定」を押すと紐付きます</p>
            <div v-for="c in pickedItems" :key="c.id" class="picked-row">
              <CodeChip kind="item" :code="c.item_code" />
              <span class="grow faint">{{ c.acquired_at }} ・ {{ c.order_no ?? c.shop_account_name }}</span>
              <span class="num">{{ yen(c.landed_cost) }}</span>
              <button class="sm ghost" :aria-label="`${c.item_code}の選択を外す`" @click="toggle(c.id)">外す</button>
            </div>
          </div>
        </div>
        <div class="calc">
          <template v-if="totalCount > 0">
            <span class="faint">{{ totalCount }}点</span>
            <span class="num">原価 {{ yen(totalCost) }}</span>
            <!-- チェックを変えてから見積もりが返るまで（Web 版は 300〜500ms）は、前の点数の数字を出さない -->
            <span v-if="!estimateReady" class="faint calc-pending" role="status">
              {{ profitLabel }} {{ estimateFailed ? '出せませんでした' : '計算中…' }}
            </span>
            <strong v-else class="num" :class="previewProfit >= 0 ? 'profit' : 'loss'">
              {{ profitLabel }} {{ yen(previewProfit) }}
            </strong>
          </template>
          <!-- 何も選んでいないときの粗利は「在庫なし」の数字で、正常に見えてしまう。数字は出さず、やることを言う -->
          <span v-else class="faint">在庫を選ぶと粗利が出ます</span>
        </div>
        <button v-if="canReserve" class="primary" :disabled="!picked.size || pickingProduct || loading" @click="confirmPick">
          {{ confirmLabel }}
        </button>
      </div>
    </template>
  </Drawer>
</template>

<style scoped>
.allocation-help { margin: 4px 0 16px; font-size: var(--fs-12); }
/* 出品／販売タイトル（Drawer.vue の見出し）は切れずに折り返して全文を見せる */
:deep(.drawer-title) {
  white-space: normal;
  overflow-wrap: anywhere;
}

.head-sub {
  display: flex;
  align-items: center;
  gap: 10px;
}
.head-sub .thumb, .head-sub .thumb-placeholder {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.head-sub .thumb { object-fit: cover; }
.head-sub .thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-weight: 700;
  font-size: var(--fs-13);
}

.search-field {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  margin-bottom: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--text-faint);
}
.search-field input {
  flex: 1;
  border: none;
  padding: 6px 0;
  background: transparent;
}

.matched-block {
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line-soft);
}

.blocked-block {
  margin-bottom: 14px;
  padding: 8px;
  background: var(--warn-bg);
  border: 1px solid var(--warn-line);
  border-radius: var(--radius-sm);
}
.blocked-help { margin: 2px 0 8px; }
.blocked-item { flex-wrap: wrap; cursor: default; }
@media (hover: hover) and (pointer: fine) {
  .blocked-item:hover { background: transparent; }
}

.ended-note { padding: 6px 8px; }

.selection-modes { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.product-help { font-size: var(--fs-12); margin: 8px 0; }
/* 追加する点数：同じ商品から 2 点以上選べるときだけ出る −／＋ の増減 */
.qty-stepper { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.qty-label { margin-right: 4px; }
.qty-btn {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
}
.qty-stepper input {
  width: 56px;
  text-align: center;
  -moz-appearance: textfield;
  appearance: textfield;
}
.qty-stepper input::-webkit-outer-spin-button,
.qty-stepper input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

.product-row { display: flex; gap: 12px; align-items: center; padding: 10px 8px; border-bottom: 1px solid var(--line-soft); }
/* 選んだ商品の行は消さずに残し、色で示す（選んだ瞬間に下の行がせり上がらない） */
.product-row.on { background: var(--accent-soft); border-radius: var(--radius-sm); }
.product-thumb { width: 48px; height: 48px; flex: 0 0 48px; object-fit: cover; border-radius: var(--radius-sm); }
.product-placeholder { display: grid; place-items: center; background: var(--accent-soft); color: var(--text-muted); }
.picked-done {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  font-size: var(--fs-13);
  font-weight: 600;
  color: var(--text-dim);
}
.picked-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

.candidates { display: flex; flex-direction: column; gap: 2px; }

/* 「型番が一致する在庫」「ほかの型番」の見出しと、ほかの型番を畳む／開くボタン */
.group-head { margin: 10px 0 2px; }
.group-head:first-child { margin-top: 0; }
.group-toggle,
.picked-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 0 12px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-13);
  font-weight: 600;
  text-align: left;
}
.group-toggle { height: 40px; margin-top: 8px; background: var(--surface-hi); color: var(--text-dim); }
@media (hover: hover) and (pointer: fine) {
  .group-toggle:hover { filter: brightness(.97); }
  .picked-toggle:hover { filter: brightness(.97); }
}
.caret { display: inline-flex; flex: 0 0 auto; transition: transform var(--dur) var(--ease); }
.group-toggle .caret.open { transform: rotate(90deg); }

/* 下端の固定バーの「選択中」。閉じているときは 1 行、開くとバーの中で上に伸びる */
.picked-bar { flex: 1 1 100%; background: var(--accent-soft); border-radius: var(--radius-sm); }
.picked-toggle { height: 36px; background: transparent; color: var(--text); }
.picked-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 閉じているときは上向き（押すと上に伸びる）、開いているときは下向き（押すと畳む） */
.picked-toggle .caret { transform: rotate(-90deg); }
.picked-toggle .caret.open { transform: rotate(90deg); }
.picked-list {
  max-height: 36vh;
  max-height: min(36dvh, 260px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 12px 8px;
}
.picked-note { margin: 0 0 6px; font-size: var(--fs-12); }

.item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  line-height: 1.3;
}
/* hover は、マウスのある端末だけ。指で触った行が「触れたまま」の色で残らないように */
@media (hover: hover) and (pointer: fine) {
  .item:hover { background: var(--surface-hi); }
}
.item.sold { background: var(--warn-bg); }
.item.on { background: var(--accent-soft); }
.matched-item { cursor: default; }

.maint-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: var(--fs-12);
  cursor: pointer;
}
.maint-toggle input { width: 13px; height: 13px; }

/* 行の高さを商品ごとに変えないよう、表示名（最大2行）・明細名（最大3行）の高さを常に確保する。
   はみ出す分は省略せず折り返す（-webkit-line-clamp）。全文は :title で見られる */
.name-cell { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.name-main {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  line-height: 1.3;
  min-height: calc(1.3em * 2);
}
.name-sub {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  font-size: var(--fs-12);
  color: var(--text-faint);
  line-height: 1.3;
  min-height: calc(1.3em * 3);
}

.item input[type="checkbox"] {
  width: 14px;
  height: 14px;
  padding: 0;
  flex-shrink: 0;
}

.match-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; }
.calc { flex: 1; display: flex; gap: 14px; align-items: baseline; font-size: var(--fs-13); }

/* スマホ幅（768px 未満）：下からのシート（Drawer.vue）の中。
   在庫の行は 1 行ごと押せる大きさ（タップ範囲は行全体）にし、チェックを入れた瞬間に動く
   原価・粗利は、シートの下に固定されたバーに大きく出す（下のボタンは全幅）。 */
@media (max-width: 767px) {
  .head-sub { flex-wrap: wrap; gap: 4px 10px; }
  .allocation-help { margin-bottom: 12px; }

  .selection-modes button { flex: 1 1 auto; height: 44px; }
  .search-field { padding: 0 12px; }
  .search-field input { height: 44px; }

  /* 候補の行：1 行目＝チェック・コード・型番・日数・原価、2 行目＝名前と補足（全幅） */
  .candidates { gap: 4px; }
  /* 在庫コードのチップ（CodeChip kind="item"）にも .item が付くので、行（label / div）だけに効かせる */
  .item:not(.chip) {
    flex-wrap: wrap;
    align-items: center;
    min-height: 44px;
    padding: 10px 8px;
    gap: 6px 8px;
  }
  .item input[type="checkbox"] { width: 22px; height: 22px; }
  .item > .chip { max-width: 100%; white-space: normal; }
  label.item > .name-cell,
  .matched-item > .name-cell { order: 2; flex: 1 1 100%; }
  label.item > .nowrap,
  .matched-item > .nowrap { margin-left: auto; }
  .name-main { min-height: 0; }
  .name-sub { min-height: 0; -webkit-line-clamp: 2; }
  .matched-item button,
  .picked-row button,
  .blocked-item button { height: 44px; border-color: var(--line); }
  .blocked-item .name-cell { flex: 1 1 100%; }
  .picked-row { gap: 6px 8px; }

  .product-row { gap: 10px; padding: 10px 8px; }
  .product-row button { flex: 0 0 auto; height: 44px; }
  /* 増減ボタンは各 44×44。数字の欄は 16px 以上（iOS がズームしない） */
  .qty-btn { width: 44px; height: 44px; }
  .qty-stepper input { width: 64px; height: 44px; }
  .group-toggle,
  .picked-toggle { min-height: 44px; }
  .group-toggle { margin-top: 6px; }
  .picked-list { padding: 0 12px 10px; }
  .picked-note { font-size: var(--fs-12); }
  .maint-toggle { min-height: 44px; font-size: var(--fs-13); }
  .maint-toggle input { width: 20px; height: 20px; }

  /* 下に固定のバー：点数・原価・粗利を 1 行、確定ボタンは全幅 */
  .match-footer { flex-wrap: wrap; gap: 10px; }
  .calc {
    flex: 1 1 100%;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 2px 12px;
    font-size: var(--fs-14);
  }
  .calc strong { font-size: var(--fs-16); }
  .match-footer .primary { flex: 1 1 100%; height: 48px; }
}
</style>

<!-- Drawer.vue のシートは Teleport で body 直下に出るので、この画面の scoped な指定は届かない（:deep も効かない）。
     そこで中身の目印（.allocate-sheet）を :has() で拾い、スマホ幅だけシートの高さを固定する。
     高さが中身で変わる（高さ auto で下端固定）と、選ぶたび・畳みを開くたびに上端が動いてリスト全体がずれ、
     2 度押しの誤タップになる。:has() に未対応の環境では今までどおり（高さは中身まかせ） -->
<style>
@media (max-width: 767px) {
  .scrim .drawer:has(.allocate-sheet) {
    height: min(calc(100vh - env(safe-area-inset-top, 0px) - 24px), 760px);
    height: min(calc(100dvh - env(safe-area-inset-top, 0px) - 24px), 760px);
  }
}
</style>
