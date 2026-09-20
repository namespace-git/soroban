<script setup lang="ts">
// 売上タブ：出品中（メルカリの出品）と販売（成約済み）を1つの一覧にまとめる。
// 段階の切替：出品中／未処理／完了／すべて。既定は「未処理」（毎日ここを触る）。
import { ref, onMounted, computed, watch, inject, nextTick, type Ref } from 'vue'
import type {
  SaleProfit, ShippingMethod, SaleKind, SaleInput, SaleFilter, SaleTotals, Tag,
  Listing, ListingStatus, CollectorRun,
} from '../../shared/types'
import { todayLocal } from '../../shared/date'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import TagPicker from '../components/TagPicker.vue'
import TimelineDrawer from '../components/TimelineDrawer.vue'
import AllocateDrawer from '../components/AllocateDrawer.vue'
import SalesSummary from '../components/SalesSummary.vue'
import SearchBox, { matchesSearch } from '../components/SearchBox.vue'
import type { PromptOptions } from '../components/InputDialog.vue'

type Stage = 'listed' | 'pending' | 'done' | 'all'

/**
 * goto('sales', payload) で渡ってくる情報。ホームの要対応・横断検索から開かれる。
 * modelCode は商品タブ向けのため、このビューでは無視する
 */
type SalesGotoPayload = {
  stage?: Stage
  onlyUnallocated?: boolean
  onlyPending?: boolean
  mercariItemId?: string
  search?: string
  focusId?: string
  modelCode?: string
}

const ask = inject<(title: string, opts?: PromptOptions) => Promise<string | null>>('prompt')!
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!

const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
const gotoPayload = inject<Ref<SalesGotoPayload | null>>('gotoPayload', ref(null))

const STAGE_LABEL: Record<Stage, string> = { listed: '出品中', pending: '売れた・要入力', done: '利益確定', all: 'すべて' }
const STAGE_HINT: Partial<Record<Stage, string>> = {
  listed: '出品したが売れていない。どの在庫を出したか引き当てる',
  pending: '送料か在庫の入力が残っている。入れると利益確定へ',
}
const STATUS_LABEL: Record<ListingStatus, string> = {
  active: '出品中', suspended: '公開停止中', sold: '売れた', ended: '取り下げ',
}
const STATUS_TONE: Record<ListingStatus, 'brand' | 'neutral' | 'ok' | 'info'> = {
  active: 'info', suspended: 'neutral', sold: 'ok', ended: 'neutral',
}

const stage = ref<Stage>('pending')
const onlyUnallocated = ref(false)
const tagFilter = ref('')
const searchText = ref('')

const methods = ref<ShippingMethod[]>([])
const allTags = ref<Tag[]>([])
const listings = ref<Listing[]>([])
const sales = ref<SaleProfit[]>([])
const totals = ref<SaleTotals | null>(null)
const loaded = ref(false)

// タブの件数（現在の段階に関わらず常に実数を出す）
const listedCount = ref(0)
const pendingCount = ref(0)

const stageHint = computed(() => STAGE_HINT[stage.value] ?? null)

const stageOptions = computed(() => ([
  { key: 'listed' as const, label: STAGE_LABEL.listed, count: listedCount.value },
  { key: 'pending' as const, label: STAGE_LABEL.pending, count: pendingCount.value },
  { key: 'done' as const, label: STAGE_LABEL.done, count: null as number | null },
  { key: 'all' as const, label: STAGE_LABEL.all, count: null as number | null },
]))

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

// --- 未処理／完了の判定（sale_profit ビューの is_shipping_confirmed / unmatched をそのまま見るだけ。
//     金額の再計算はしていない） ---
function isPendingSale(s: SaleProfit): boolean {
  return !s.is_shipping_confirmed || (s.kind === 'resale' && s.unmatched === 1)
}

const hasSearch = computed(() => !!searchText.value.trim())

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
  if (stage.value === 'all') {
    return [...listings.value.map(listingRow), ...sales.value.map(saleRow)]
      .sort((a, b) => b.date.localeCompare(a.date))
  }
  return sales.value.map(saleRow)
})

const filteredRows = computed(() => rows.value.filter(r => {
  if (r.kind === 'sale' && r.sale) {
    const s = r.sale
    return matchesSearch(
      [s.title, s.note, s.buyer, ...s.model_codes, ...s.tags.map(t => t.name), ...s.inherited_tags.map(t => t.name)],
      searchText.value,
    )
  }
  if (r.kind === 'listing' && r.listing) {
    const l = r.listing
    return matchesSearch([l.title, ...l.model_codes, ...l.items.flatMap(it => [it.name, it.model_code])], searchText.value)
  }
  return true
}))

// --- 列見出し・列の出し分け。段階ごとに colgroup も切り替える（幅が合わず見出しが
//     欠けるのを防ぐ）。出品中：日付／サムネ／商品／価格／状態／引き当てた在庫／見込み粗利／操作。
//     未処理・完了：日付／サムネ／商品／価格／手数料／発送方法／梱包／原価／粗利／操作。
//     すべて：未処理の列＋状態（出品行のときだけ埋まる） ---
// 「すべて」は閲覧用のため、手数料・発送方法・梱包の列そのものは出さない（発送方法は
// チップ列に短く出すだけ）。この3列は未処理・完了だけで編集操作として意味を持つ
const showFeePack = computed(() => stage.value === 'pending' || stage.value === 'done')
const showStatusCol = computed(() => stage.value === 'listed' || stage.value === 'all') // 出品の状態
// 出品中は出品時に発送方法を決められる（売れた・要入力の行と同じ select）
const showListedShipping = computed(() => stage.value === 'listed')
const dateColLabel = computed(() => (stage.value === 'listed' ? '出品日' : stage.value === 'all' ? '日付' : '販売日'))
const costColLabel = computed(() => (stage.value === 'listed' ? '引き当てた在庫' : stage.value === 'all' ? '在庫' : '原価'))
const profitColLabel = computed(() => (stage.value === 'listed' ? '見込み粗利' : '粗利'))

/** 見込み粗利のtitle：発送方法が決まっていれば送料込み、無ければ送料前であることを示す */
function profitCellTitle(r: Row): string | undefined {
  if (r.kind !== 'listing' || !r.listing) return undefined
  return r.listing.shipping_method_id ? '送料込み（梱包前）' : '送料前'
}

// 「すべて」の販売行：発送方法をチップ列に短く出す（列そのものは無いため）
function shippingChipTone(s: SaleProfit): 'neutral' | 'warn' {
  return s.is_shipping_confirmed ? 'neutral' : 'warn'
}
function shippingChipLabel(s: SaleProfit): string {
  if (!s.is_shipping_confirmed) return '送料未入力'
  if (s.shipping_source === 'actual') return '実額'
  return methods.value.find(m => m.id === s.shipping_method_id)?.name ?? '発送方法'
}

const STAGE_EMPTY: Record<Stage, { title: string; hint?: string }> = {
  listed: { title: '出品がありません', hint: 'メルカリの取り込みで出品中タブから見つかると、ここに並びます' },
  pending: { title: '未処理の販売はありません' },
  done: { title: '完了した販売はありません' },
  all: { title: '出品も販売もまだありません' },
}
const emptyTitle = computed(() => STAGE_EMPTY[stage.value].title)
const emptyHint = computed(() => STAGE_EMPTY[stage.value].hint)

function sumSaleTotals(rowsToSum: SaleProfit[]): SaleTotals {
  return rowsToSum.reduce((acc, s) => {
    acc.count += 1
    acc.revenue += s.price
    acc.total_fee += s.fee
    acc.total_shipping += s.shipping_fee
    acc.total_packaging += s.packaging_cost
    acc.total_cost += s.cost
    acc.gross_profit += s.gross_profit
    return acc
  }, { count: 0, revenue: 0, total_fee: 0, total_shipping: 0, total_packaging: 0, total_cost: 0, gross_profit: 0 })
}

async function loadTotals() {
  if (!tagFilter.value || stage.value === 'listed') { totals.value = null; return }
  if (stage.value === 'done') {
    // 「完了」は SaleFilter で直接絞れないため、既に読み込み済みの行を足すだけ（再計算はしない）
    totals.value = sumSaleTotals(sales.value)
    return
  }
  const filter: SaleFilter = { tagId: tagFilter.value }
  if (stage.value === 'pending') filter.onlyPending = true
  totals.value = await window.soroban.saleTotals(filter)
}

async function load() {
  loaded.value = false
  if (stage.value === 'listed') {
    listings.value = await window.soroban.listListings(
      hasSearch.value
        ? { status: ['active', 'suspended', 'sold', 'ended'] }
        : { status: ['active', 'suspended'], onlyUnallocated: onlyUnallocated.value || undefined },
    )
    sales.value = []
  } else if (stage.value === 'all') {
    const [ls, ss] = await Promise.all([
      window.soroban.listListings({ status: ['active', 'suspended', 'sold', 'ended'] }),
      window.soroban.listSales(tagFilter.value ? { tagId: tagFilter.value } : undefined),
    ])
    listings.value = ls
    sales.value = ss
  } else {
    const filter: SaleFilter = {}
    if (tagFilter.value) filter.tagId = tagFilter.value
    if (stage.value === 'pending') filter.onlyPending = true
    const rowsFetched = await window.soroban.listSales(Object.keys(filter).length ? filter : undefined)
    sales.value = stage.value === 'done' ? rowsFetched.filter(s => !isPendingSale(s)) : rowsFetched
    listings.value = []
  }
  await loadTotals()
  loaded.value = true
}

async function loadCounts() {
  const [ls, ps] = await Promise.all([
    window.soroban.listListings({ status: ['active', 'suspended'] }),
    window.soroban.listSales({ onlyPending: true }),
  ])
  listedCount.value = ls.length
  pendingCount.value = ps.length
}

async function loadTags() {
  allTags.value = await window.soroban.listTags()
}

onMounted(async () => {
  methods.value = await window.soroban.listShippingMethods()
  await loadTags()
  await loadCounts()
  await load()
})
watch(revision, loadTags)
watch(revision, loadCounts)
watch([revision, stage, onlyUnallocated, tagFilter, hasSearch], load)

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
/** 出品行は出品日（listed_at）を見せる。取れなければ初めて見た日（listing の date）のまま */
function rowDateDisplay(r: Row): string {
  return r.kind === 'listing' && r.listing ? r.listing.listed_at : r.date
}
function rowDateTitle(r: Row): string | undefined {
  return r.kind === 'listing' ? '更新日から推定' : undefined
}
function rowTitle(r: Row): string {
  return r.kind === 'sale' ? (r.sale?.title ?? '') : (r.listing?.title ?? '')
}
function placeholderChar(r: Row): string {
  const c = rowModelCodes(r)[0]?.[0] ?? rowTitle(r).trim().charAt(0)
  return (c || '?').toUpperCase()
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
  else if (r.kind === 'sale' && r.sale) openTimelineForSale(r.sale)
}
function rowClickable(r: Row): boolean {
  return r.kind === 'listing' || (r.kind === 'sale' && !!r.sale && canOpenTimeline(r.sale))
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
  if (p.stage) stage.value = p.stage
  else if (p.onlyPending) stage.value = 'pending'
  else if (p.focusId) stage.value = 'all' // どの段階にいても検索結果を必ず見つけられるようにする
  if (p.onlyUnallocated) onlyUnallocated.value = true
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
  await loadCounts()
  changed()
}

// --- 送料・梱包材費 ---

async function setShipping(sale: SaleProfit, methodId: string) {
  await window.soroban.updateSale(sale.id, { shipping_method_id: methodId || null })
  await load()
  await loadCounts()
  changed()
}

// --- 出品時に決める発送方法（出品中の行） ---

async function setListingShipping(listing: Listing, methodId: string) {
  await window.soroban.setListingShipping(listing.mercari_item_id, methodId || null)
  await load()
  changed()
}

async function setPackaging(sale: SaleProfit, value: number) {
  const packaging_cost = Math.max(0, Math.round(value || 0))
  await window.soroban.updateSale(sale.id, { packaging_cost })
  await load()
  changed()
}

async function setKind(sale: SaleProfit, kind: SaleKind) {
  const label = kind === 'personal' ? '私物' : '転売'
  if (!await confirmDialog(`「${sale.title}」を${label}に変更しますか？`, { okLabel: '変更する' })) return
  await window.soroban.updateSale(sale.id, { kind })
  await load()
  await loadCounts()
  changed()
  if ((stage.value === 'pending' || stage.value === 'done') && !sales.value.some(s => s.id === sale.id)) {
    toast(`${label}に変更しました。「すべて」タブで確認できます`, 'ok')
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
  await loadCounts()
  changed()
}

// --- 型番で自動引き当て（出品中） ---

async function autoReserveListings() {
  const n = await window.soroban.autoReserveListings()
  if (n > 0) {
    toast(`${n}件を引き当てました`, 'ok')
  } else {
    toast('引き当てられる出品はありません', 'warn')
  }
  await load()
  await loadCounts()
  changed()
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
  await loadCounts()
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
  await loadCounts()
  changed()
}

async function remove(sale: SaleProfit) {
  if (!await confirmDialog(`「${sale.title}」を削除しますか？`, { okLabel: '削除する', danger: true })) return
  await window.soroban.deleteSale(sale.id)
  await load()
  await loadCounts()
  changed()
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
          <span>価格</span>
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
      <div class="row">
        <span class="grow" />
        <button class="primary" @click="submit">登録</button>
      </div>
    </div>

    <SalesSummary />

    <div class="stage-tabs">
      <button
        v-for="opt in stageOptions" :key="opt.key"
        class="stage-tab" :class="{ active: stage === opt.key }"
        @click="stage = opt.key"
      >
        {{ opt.label }}<template v-if="opt.count !== null"> ({{ opt.count }})</template>
      </button>
    </div>
    <p v-if="stageHint" class="faint stage-hint">{{ stageHint }}</p>

    <div class="toolbar">
      <label v-if="stage === 'listed'" class="row">
        <input type="checkbox" v-model="onlyUnallocated" />
        未引き当てだけ
      </label>
      <select v-if="stage !== 'listed'" v-model="tagFilter">
        <option value="">すべてのタグ</option>
        <option v-for="t in allTags" :key="t.id" :value="t.id">{{ t.name }}</option>
      </select>
      <SearchBox v-model="searchText" placeholder="商品名・型番・メモ・タグ・買い手を検索" />
      <span v-if="hasSearch && stage === 'listed'" class="faint search-hint">検索中は状態・未引き当ての絞り込みも解除して表示</span>
      <span class="grow" />
      <button v-if="stage === 'listed'" class="sm" @click="autoReserveListings">型番で自動引き当て</button>
      <button v-if="stage !== 'listed'" class="sm" @click="autoLinkPending">型番で自動紐付け</button>
      <span class="faint">{{ filteredRows.length }}件</span>
    </div>

    <div v-if="tagFilter && totals" class="panel totals-bar">
      <span class="faint">{{ totals.count }}件</span>
      <span class="num">売上 {{ yen(totals.revenue) }}</span>
      <span class="num dim">手数料 {{ yen(totals.total_fee) }}</span>
      <span class="num dim">送料 {{ yen(totals.total_shipping) }}</span>
      <span class="num dim">原価 {{ yen(totals.total_cost) }}</span>
      <strong class="num" :class="totals.gross_profit >= 0 ? 'profit' : 'loss'">
        粗利 {{ yen(totals.gross_profit) }}
      </strong>
    </div>

    <Skeleton v-if="!loaded" :rows="6" />

    <template v-else>
      <div v-if="filteredRows.length" class="panel table-panel">
        <table>
          <colgroup v-if="stage === 'listed'">
            <col class="col-listed-date" />
            <col class="col-listed-thumb" />
            <col />
            <col class="col-listed-price" />
            <col class="col-listed-status" />
            <col class="col-listed-shipping" />
            <col class="col-listed-reserved" />
            <col class="col-listed-profit" />
            <col class="col-listed-actions" />
          </colgroup>
          <colgroup v-else-if="stage === 'all'">
            <col class="col-date-wide" />
            <col class="col-listed-thumb" />
            <col />
            <col class="col-listed-price" />
            <col class="col-status" />
            <col class="col-listed-reserved" />
            <col class="col-profit-narrow" />
            <col class="col-actions-wide" />
          </colgroup>
          <colgroup v-else>
            <col class="col-date" />
            <col class="col-thumb" />
            <col />
            <col class="col-amt" />
            <col class="col-amt" />
            <col class="col-ship" />
            <col class="col-pack" />
            <col class="col-amt" />
            <col class="col-amt" />
            <col class="col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>{{ dateColLabel }}</th>
              <th></th>
              <th>商品</th>
              <th class="num">価格</th>
              <th v-if="showFeePack" class="num">手数料</th>
              <th v-if="showStatusCol">状態</th>
              <th v-if="showListedShipping" title="出品時に決めておくと、売れたときそのまま販売に入ります">発送方法</th>
              <th v-if="showFeePack">発送方法</th>
              <th v-if="showFeePack" class="num">梱包</th>
              <th class="num">{{ costColLabel }}</th>
              <th class="num">{{ profitColLabel }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in filteredRows" :key="r.key"
              :data-row-id="r.id"
              :class="{ focused: focusedId === r.id }"
            >
              <td class="date-cell" :title="rowDateTitle(r)">
                <div class="faint nowrap">{{ rowDateDisplay(r).slice(5) }}</div>
                <div v-if="r.kind === 'listing' && r.listing" class="faint nowrap seen-note" title="最後に出品中タブで見た日時">
                  確認 {{ formatSeen(r.listing.last_seen_at) }}
                </div>
              </td>

              <td
                class="thumb-cell"
                :class="{ clickable: rowClickable(r) }"
                :title="r.kind === 'listing' ? '引き当てを編集' : (r.sale && canOpenTimeline(r.sale) ? '履歴を見る' : undefined)"
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
              </td>

              <td class="title-cell">
                <div
                  class="title-name"
                  :class="{ clickable: rowClickable(r) }"
                  :title="rowTitle(r)"
                  @click="onRowClick(r)"
                >{{ rowTitle(r) }}</div>

                <template v-if="r.kind === 'sale' && r.sale">
                  <div class="chip-row">
                    <button
                      class="kind-toggle"
                      title="転売／私物を切り替える（確認あり）"
                      @click="r.sale && setKind(r.sale, r.sale.kind === 'resale' ? 'personal' : 'resale')"
                    >
                      <StatusChip
                        :tone="r.sale.kind === 'personal' ? 'neutral' : 'brand'"
                        :label="r.sale.kind === 'resale' ? '転売' : '私物'"
                      />
                    </button>
                    <StatusChip v-if="r.sale.source === 'collector'" tone="neutral" label="自動取得" />
                    <StatusChip
                      v-if="stage === 'all'"
                      :tone="shippingChipTone(r.sale)"
                      :label="shippingChipLabel(r.sale)"
                    />
                    <StatusChip v-for="mc in r.sale.model_codes" :key="mc" tone="neutral" :label="mc" />
                    <StatusChip v-for="t in r.sale.tags" :key="t.id" tone="info" :label="t.name" />
                    <StatusChip
                      v-for="t in r.sale.inherited_tags" :key="'inh-' + t.id"
                      tone="neutral" :label="t.name" class="chip-inherited"
                      title="仕入／在庫から引き継いだタグ"
                    />
                  </div>
                  <div v-if="r.sale.note" class="note-row">
                    <Icon name="note" :size="14" class="icon-note" />
                    <span class="note-label">メモ</span>
                    <span class="note-text">{{ r.sale.note }}</span>
                  </div>
                </template>

                <div v-else-if="r.listing" class="chip-row">
                  <StatusChip v-for="mc in r.listing.model_codes" :key="mc" tone="neutral" :label="mc" />
                  <StatusChip v-if="r.listing.likes != null" tone="neutral" :label="`いいね ${r.listing.likes}`" />
                  <StatusChip
                    v-if="stage === 'all' && r.listing.shipping_method_id"
                    tone="neutral"
                    :label="r.listing.shipping_method_name ?? '発送方法'"
                  />
                </div>
              </td>

              <td class="num">{{ yen(r.kind === 'sale' ? (r.sale?.price ?? 0) : (r.listing?.price ?? 0)) }}</td>

              <td v-if="showFeePack" class="num dim">
                <span v-if="r.kind === 'sale' && r.sale">−{{ yen(r.sale.fee) }}</span>
                <span v-else class="faint">—</span>
              </td>

              <td v-if="showStatusCol">
                <div v-if="r.kind === 'listing' && r.listing" class="chip-row">
                  <StatusChip :tone="STATUS_TONE[r.listing.status]" :label="STATUS_LABEL[r.listing.status]" />
                  <StatusChip
                    v-if="seenStale(r.listing)"
                    tone="neutral"
                    label="前回の取り込みで見えず"
                    title="1ページ目に無かっただけかもしれません。売れていれば売上に出ます"
                  />
                </div>
                <span v-else class="faint">—</span>
              </td>

              <td v-if="showListedShipping">
                <select
                  v-if="r.listing"
                  class="ship-select"
                  :value="r.listing.shipping_method_id ?? ''"
                  @change="r.listing && setListingShipping(r.listing, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">未定</option>
                  <option v-for="m in methods" :key="m.id" :value="m.id">
                    {{ m.name }}　{{ yen(m.fee) }}
                  </option>
                </select>
              </td>

              <td v-if="showFeePack">
                <template v-if="r.kind === 'sale' && r.sale">
                  <span v-if="r.sale.shipping_source === 'actual'" class="shipping-actual">
                    {{ yen(r.sale.shipping_fee) }}
                    <StatusChip tone="ok" label="実額" />
                  </span>
                  <select
                    v-else
                    class="ship-select"
                    :value="r.sale.shipping_method_id ?? ''"
                    :class="{ invalid: !r.sale.is_shipping_confirmed }"
                    @change="r.sale && setShipping(r.sale, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">選択…</option>
                    <option v-for="m in methods" :key="m.id" :value="m.id">
                      {{ m.name }}　{{ yen(m.fee) }}
                    </option>
                  </select>
                </template>
                <span v-else class="faint">—</span>
              </td>

              <td v-if="showFeePack" class="num dim">
                <input
                  v-if="r.kind === 'sale' && r.sale"
                  type="number"
                  class="packaging-input"
                  :value="r.sale.packaging_cost"
                  min="0"
                  @change="r.sale && setPackaging(r.sale, ($event.target as HTMLInputElement).valueAsNumber)"
                />
                <span v-else class="faint">—</span>
              </td>

              <td class="num">
                <template v-if="r.kind === 'sale' && r.sale">
                  <button
                    v-if="r.sale.kind === 'resale' && r.sale.unmatched"
                    class="sm link-btn"
                    @click="r.sale && openSaleAlloc(r.sale)"
                  >
                    <Icon name="link" :size="14" /> 紐付け
                  </button>
                  <span v-else-if="r.sale.item_count" class="cost-cell">
                    <button
                      class="cost-btn"
                      @click="r.sale && openSaleAlloc(r.sale)"
                      title="クリックで紐付けを編集"
                    >
                      {{ yen(r.sale.cost) }}<small class="faint"> ×{{ r.sale.item_count }}</small>
                    </button>
                    <StatusChip v-if="r.sale.auto_linked" tone="neutral" label="自動紐付け" />
                  </span>
                  <span v-else class="faint">—</span>
                </template>
                <template v-else-if="r.listing">
                  <div v-if="r.listing.items.length" class="reserved-cell">
                    <div class="chip-row">
                      <StatusChip v-for="it in r.listing.items" :key="it.id" tone="neutral" :label="it.model_code ?? it.name" />
                    </div>
                    <span class="num faint">{{ yen(r.listing.reserved_cost) }}</span>
                  </div>
                  <div v-else class="reserved-cell"><StatusChip tone="warn" label="未引き当て" /></div>
                </template>
              </td>

              <td class="num" :title="profitCellTitle(r)">
                <Transition name="settle" mode="out-in">
                  <strong
                    v-if="r.kind === 'sale' && r.sale && r.sale.is_shipping_confirmed && (!r.sale.unmatched || r.sale.kind === 'personal')"
                    :key="'c' + r.sale.gross_profit"
                    :class="r.sale.gross_profit >= 0 ? 'profit' : 'loss'"
                  >{{ yen(r.sale.gross_profit) }}</strong>
                  <strong
                    v-else-if="r.kind === 'listing' && r.listing && r.listing.expected_profit != null"
                    :key="'l' + r.listing.expected_profit"
                    :class="r.listing.expected_profit >= 0 ? 'profit' : 'loss'"
                  >{{ yen(r.listing.expected_profit) }}</strong>
                  <span v-else key="u" class="faint">{{ r.kind === 'sale' ? '未確定' : '—' }}</span>
                </Transition>
              </td>

              <td class="actions">
                <template v-if="r.kind === 'sale' && r.sale">
                  <button class="sm ghost fade-btn" @click="r.sale && openTagPicker(r.sale, $event)" title="タグを編集する">タグ</button>
                  <button class="sm ghost fade-btn" @click="r.sale && editNote(r.sale)" title="メモを編集する">メモ</button>
                  <button
                    v-if="stage === 'all'"
                    class="icon ghost"
                    aria-label="履歴"
                    title="履歴を見る"
                    :disabled="!canOpenTimeline(r.sale)"
                    @click="r.sale && openTimelineForSale(r.sale)"
                  >
                    <Icon name="history" :size="16" />
                  </button>
                  <button v-else class="icon ghost" aria-label="削除" @click="r.sale && remove(r.sale)">
                    <Icon name="trash" :size="16" />
                  </button>
                </template>
                <template v-else-if="r.listing && (r.listing.status === 'active' || r.listing.status === 'suspended')">
                  <button class="sm" :class="r.listing.items.length ? 'ghost' : 'link-btn'" @click="r.listing && openListingAlloc(r.listing)">
                    <Icon name="link" :size="14" /> {{ r.listing.items.length ? '追加' : '引き当て' }}
                  </button>
                  <button class="sm ghost" @click="r.listing && endListing(r.listing)">取り下げ</button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <EmptyState
        v-else-if="searchText"
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

/* 派生タグ（仕入・在庫から引き継いだもの）は直接付けたタグより少し薄く見せる */
.chip-inherited { opacity: .7; }

/* --- 段階の切替 --- */
.stage-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
}
.stage-tab {
  height: 32px;
  padding: 0 14px;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-dim);
  font-size: var(--fs-13);
  font-variant-numeric: tabular-nums;
}
.stage-tab:hover:not(:disabled) { background: var(--surface-hi); }
.stage-tab.active {
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-weight: 700;
}

.stage-hint {
  margin: -6px 0 12px;
  font-size: var(--fs-12);
}

.totals-bar {
  display: flex;
  align-items: baseline;
  gap: 16px;
  padding: 10px 20px;
  margin-bottom: 16px;
  font-size: var(--fs-13);
}

.table-panel { padding: 0; overflow: hidden; }
.table-panel table { table-layout: fixed; }
.table-panel td { padding: 8px 12px; }
/* 列幅は colgroup（段階ごとに切り替え）で決める。見出しはここでは折り返さない */
.table-panel th { white-space: nowrap; }

/* --- 未処理・完了の列幅 --- */
.col-date         { width: 72px; }
.col-date-wide    { width: 140px; } /* 出品行の「最終確認」が入る分だけ広げる（すべて段階） */
.col-thumb        { width: 64px; }
.col-amt          { width: 84px; }
.col-ship         { width: 200px; }
.col-pack         { width: 76px; }
.col-status       { width: 110px; }
.col-actions      { width: 112px; }
.col-actions-wide { width: 200px; } /* 出品行の「引き当て／追加」＋「取り下げ」が入る分だけ広げる */
.col-profit-narrow { width: 100px; } /* すべて段階（閲覧用。手数料・発送方法・梱包は列を出さない） */

/* --- 出品中の列幅（旧 Listings.vue 相当。手数料・梱包が無い分、他の列を広めに） --- */
.col-listed-date     { width: 124px; }
.col-listed-thumb    { width: 56px; }
.col-listed-price    { width: 88px; }
.col-listed-status   { width: 96px; }
.col-listed-shipping { width: 150px; }
.col-listed-reserved { width: 140px; }
.col-listed-profit   { width: 96px; }
.col-listed-actions  { width: 180px; }

@media (max-width: 1099px) {
  .col-date            { width: 56px; }
  .col-date-wide       { width: 128px; }
  .col-thumb           { width: 48px; }
  .col-amt             { width: 76px; }
  .col-ship            { width: 168px; }
  .col-status          { width: 96px; }
  .col-actions-wide    { width: 184px; }
  .col-profit-narrow   { width: 84px; }
  .col-listed-thumb    { width: 48px; }
  .col-listed-status   { width: 120px; }
  .col-listed-shipping { width: 150px; }
  .col-listed-reserved { width: 140px; }
  .col-listed-profit   { width: 110px; }
  .col-listed-actions  { width: 184px; }
}

.nowrap { white-space: nowrap; }

.date-cell { display: flex; flex-direction: column; gap: 2px; }
.seen-note { font-size: var(--fs-12); overflow: hidden; text-overflow: ellipsis; }
.date-cell { overflow: hidden; }

/* 横断検索・要対応から来たときに該当行を一時的に示す */
tr.focused { background: var(--brand-soft); }

.thumb-cell { padding-right: 4px; }
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

.title-cell { overflow: hidden; }
.title-name {
  font-size: var(--fs-14);
  font-weight: 500;
  white-space: normal;
  word-break: break-word;
}

.clickable { cursor: pointer; }

.table-panel td.actions { white-space: nowrap; text-align: right; }
.table-panel .actions > * { vertical-align: middle; margin-left: 4px; }
.table-panel .actions button { white-space: nowrap; }

.fade-btn {
  padding: 3px 6px;
  opacity: .35;
  transition: opacity var(--dur) var(--ease);
}
tr:hover .fade-btn { opacity: 1; }

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

.ship-select {
  width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.cost-cell {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.cost-btn {
  background: transparent;
  border-color: transparent;
  padding: 0;
  height: auto;
  font: inherit;
  color: var(--text);
}
.cost-btn:hover:not(:disabled) {
  background: transparent;
  text-decoration: underline;
}

.shipping-actual {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}

.packaging-input { width: 72px; }

.reserved-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
</style>
