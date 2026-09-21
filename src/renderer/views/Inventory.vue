<script setup lang="ts">
import { ref, onMounted, computed, watch, inject, nextTick, type Ref } from 'vue'
import type {
  InventoryItem, InventoryGroup, InventoryOverview, InventoryGroupFilter, Tag,
} from '../../shared/types'
import type { PromptOptions } from '../components/InputDialog.vue'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import StatusPill from '../components/StatusPill.vue'
import CodeChip from '../components/CodeChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import TagPicker from '../components/TagPicker.vue'
import TimelineDrawer from '../components/TimelineDrawer.vue'
import SearchBox, { matchesSearch } from '../components/SearchBox.vue'
import PeriodSelect, { inPeriod, type Period } from '../components/PeriodSelect.vue'
import SortTh from '../components/SortTh.vue'
import StageStrip from '../components/StageStrip.vue'
import type { StageStripStage } from '../components/StageStrip.vue'
import { useSort } from '../composables/useSort'

const MODEL_CODE_RE = /^[A-Z]\d{3}(-\d+)?$/

// 「1点ずつ」表の並び替え列
type SortKey = 'name' | 'shop_account_name' | 'acquired_at' | 'aging_days' | 'landed_cost'
type GroupSortKey = 'aging' | 'acquired_at' | 'cost'
type ViewMode = 'group' | 'flat'

const viewMode = ref<ViewMode>('group')

const overview = ref<InventoryOverview | null>(null)
const groups = ref<InventoryGroup[]>([])
const items = ref<InventoryItem[]>([])
const loaded = ref(false)
const warnDays = ref(90)

// 状態カード（getInventoryOverview）が選ぶ絞り込み。長期滞留は 'all' ＋ agingMinFilter
const groupFilter = ref<InventoryGroupFilter>('unlisted_arrived')
const agingMinFilter = ref<number | null>(null)

const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
const ask = inject<(title: string, opts?: PromptOptions) => Promise<string | null>>('prompt')!
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!
const goto = inject<(tab: string, payload?: { modelCode?: string; search?: string; focusId?: string }) => void>('goto')!
// 横断検索から goto('inventory', { search, focusId }) で開かれる。ホームの長期滞留からは
// inventoryStatus（'all'）と agingMin（滞留日数の下限）が来る
const gotoPayload = inject<Ref<{
  search?: string
  focusId?: string
  inventoryStatus?: InventoryGroupFilter
  agingMin?: number
} | null>>('gotoPayload', ref(null))

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

// --- 状態カード ---
const stages = computed<StageStripStage[]>(() => {
  const o = overview.value
  const agingDays = o?.aging.days ?? 60
  return [
    { key: 'unlisted_arrived', label: '届いていて未出品', count: o?.unlisted_arrived.count ?? 0, money: o?.unlisted_arrived.cost ?? 0, sub: 'いま出せるもの' },
    { key: 'not_arrived', label: '未着', count: o?.not_arrived.count ?? 0, money: o?.not_arrived.cost ?? 0, sub: '注文済み・届いていない' },
    { key: 'listed', label: '出品中', count: o?.listed.count ?? 0, money: o?.listed.expected_profit ?? 0, sub: '見込み粗利' },
    {
      key: 'aging', label: `長期滞留（${agingDays}日以上）`, count: o?.aging.count ?? 0, money: o?.aging.cost ?? 0,
      sub: '値下げや自家消費を検討', tone: 'warn',
    },
  ]
})
const activeStage = computed(() => (
  agingMinFilter.value != null && groupFilter.value === 'all' ? 'aging' : groupFilter.value
))

function selectStage(key: string) {
  if (key === 'aging') {
    groupFilter.value = 'all'
    agingMinFilter.value = overview.value?.aging.days ?? 60
  } else {
    groupFilter.value = key as InventoryGroupFilter
    agingMinFilter.value = null
  }
}

// --- 読み込み ---
async function loadOverview() {
  overview.value = await window.soroban.getInventoryOverview()
}

async function loadGroups() {
  groups.value = await window.soroban.listInventoryGroups(groupFilter.value)
}

async function loadFlatItems() {
  const f = groupFilter.value
  if (f === 'all') {
    const [inStock, sold, disposed, personalUse, split] = await Promise.all([
      window.soroban.listInventory('in_stock'),
      window.soroban.listInventory('sold'),
      window.soroban.listInventory('disposed'),
      window.soroban.listInventory('personal_use'),
      window.soroban.listInventory('split'),
    ])
    items.value = [...inStock, ...sold, ...disposed, ...personalUse, ...split]
  } else if (f === 'sold') {
    items.value = await window.soroban.listInventory('sold')
  } else if (f === 'other') {
    const [disposed, personalUse, split] = await Promise.all([
      window.soroban.listInventory('disposed'),
      window.soroban.listInventory('personal_use'),
      window.soroban.listInventory('split'),
    ])
    items.value = [...disposed, ...personalUse, ...split]
  } else {
    // unlisted / unlisted_arrived / not_arrived / listed はすべて in_stock の中
    items.value = await window.soroban.listInventory('in_stock')
  }
}

async function load() {
  loaded.value = false
  await Promise.all([
    loadOverview(),
    viewMode.value === 'group' ? loadGroups() : loadFlatItems(),
  ])
  // 表示していない側のデータは古いままにしない（タグ候補などが取り違えないように）
  if (viewMode.value === 'group') items.value = []
  else groups.value = []
  warnDays.value = overview.value?.aging.days ?? 90
  loaded.value = true
}
onMounted(load)
watch([revision, viewMode, groupFilter], load)

async function loadTags() {
  allTags.value = await window.soroban.listTags()
}
const allTags = ref<Tag[]>([])
onMounted(loadTags)
watch(revision, loadTags)

// --- 横断検索・ホームからの遷移：検索語・絞り込みを引き継ぎ、該当行を一時的にハイライトする ---
const tagFilter = ref('')
const searchText = ref('')
const period = ref<Period>('all')
const focusedId = ref<string | null>(null)

async function focusRow(id: string) {
  await load()
  await nextTick()
  focusedId.value = id
  document.querySelector(`[data-row-id="${id}"]`)?.scrollIntoView({ block: 'center' })
  setTimeout(() => { if (focusedId.value === id) focusedId.value = null }, 2000)
}

watch(gotoPayload, (p) => {
  if (!p) return
  // focusId 指定時は、対象行が今の絞り込みで隠れていても見えるよう「すべて」にしてから探す
  if (p.focusId) { viewMode.value = 'group'; groupFilter.value = 'all' }
  if (p.inventoryStatus) groupFilter.value = p.inventoryStatus
  if (p.agingMin != null) agingMinFilter.value = p.agingMin
  if (p.search) searchText.value = p.search
  if (p.focusId) focusRow(p.focusId)
  gotoPayload.value = null
}, { immediate: true })

// --- タグの絞り込み候補：出どころで分ける（直接／仕入から／商品から）---
function tagOptionsOf(pick: (i: InventoryItem) => Tag[]): Array<{ id: string; name: string }> {
  const map = new Map<string, string>()
  for (const i of items.value.length ? items.value : groups.value.flatMap(g => g.items)) {
    for (const t of pick(i)) map.set(t.id, t.name)
  }
  return [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ja'))
}
const directTagOptions = computed(() => tagOptionsOf(i => i.tags))
const purchaseTagOptions = computed(() => tagOptionsOf(i => i.inherited_tags.filter(t => t.from === 'purchase')))
const productTagOptions = computed(() => tagOptionsOf(i => i.inherited_tags.filter(t => t.from === 'product')))

// views.ts の bucketOf/matchesFilter と同じ分類（在庫タブの状態カード・型番グループと揃える）
type Bucket = 'unlisted_arrived' | 'not_arrived' | 'listed' | 'sold' | 'other'
function bucketOf(i: InventoryItem): Bucket {
  if (i.status === 'sold') return 'sold'
  if (i.status === 'in_stock') {
    if (i.listing) return 'listed'
    if (i.fulfillment === 'pending' || i.fulfillment === 'shipped') return 'not_arrived'
    return 'unlisted_arrived'
  }
  return 'other'
}
function matchesGroupFilter(bucket: Bucket, filter: InventoryGroupFilter): boolean {
  switch (filter) {
    case 'all': return true
    case 'unlisted': return bucket === 'unlisted_arrived' || bucket === 'not_arrived'
    case 'unlisted_arrived': return bucket === 'unlisted_arrived'
    case 'not_arrived': return bucket === 'not_arrived'
    case 'listed': return bucket === 'listed'
    case 'sold': return bucket === 'sold'
    case 'other': return bucket === 'other'
  }
}

function itemMatchesFilters(i: InventoryItem): boolean {
  if (!matchesGroupFilter(bucketOf(i), groupFilter.value)) return false
  if (tagFilter.value && !(i.tags.some(t => t.id === tagFilter.value) || i.inherited_tags.some(t => t.id === tagFilter.value))) return false
  if (!matchesSearch(
    [
      i.item_code, i.name, i.model_code, i.series_code, i.material, i.note, i.shop_account_name,
      ...i.tags.map(t => t.name), ...i.inherited_tags.map(t => t.name),
    ],
    searchText.value,
  )) return false
  if (!inPeriod(i.acquired_at, period.value)) return false
  if (agingMinFilter.value != null && i.aging_days < agingMinFilter.value) return false
  return true
}

// --- 「1点ずつ」表 ---
const { sortKey, sortDir, toggle, sortRows } = useSort<SortKey>('aging_days', 'desc')
function onSort(key: string) {
  toggle(key as SortKey)
}
function sortValue(i: InventoryItem, key: SortKey): string | number | null {
  switch (key) {
    case 'name': return i.name
    case 'shop_account_name': return i.shop_account_name
    case 'acquired_at': return i.acquired_at
    case 'aging_days': return i.aging_days
    case 'landed_cost': return i.landed_cost
  }
}
// 「すべて」のときの並び：状態（未出品 → 出品中 → 販売済 → その他）→ 選んだ並び
function statusRank(i: InventoryItem): number {
  if (i.status === 'in_stock') return i.listing === null ? 0 : 1
  if (i.status === 'sold') return 2
  return 3
}
const filteredItems = computed(() => {
  const sorted = sortRows(items.value.filter(itemMatchesFilters), sortValue)
  return groupFilter.value === 'all' ? [...sorted].sort((a, b) => statusRank(a) - statusRank(b)) : sorted
})
// 「すべて」のときだけ、行に状態チップを出す（状態が絞られているときは自明なので出さない）
const showStatusChips = computed(() => groupFilter.value === 'all')

// --- 「型番ごと」表示 ---
const groupSortKey = ref<GroupSortKey>('aging')
function groupSortValue(g: InventoryGroup): number {
  switch (groupSortKey.value) {
    case 'aging': return g.oldest_aging_days ?? -1
    case 'acquired_at': return g.oldest_acquired_at ? Date.parse(g.oldest_acquired_at) : -1
    case 'cost': return g.cost_per_item ?? -1
  }
}

function groupMatchesFilters(g: InventoryGroup): boolean {
  if (tagFilter.value && !(
    g.tags.some(t => t.id === tagFilter.value)
    || g.items.some(i => i.tags.some(t => t.id === tagFilter.value) || i.inherited_tags.some(t => t.id === tagFilter.value))
  )) return false
  const fields = [
    g.model_code, g.name, ...g.tags.map(t => t.name),
    ...g.items.flatMap(i => [
      i.item_code, i.name, i.model_code, i.series_code, i.material, i.note, i.shop_account_name,
      ...i.tags.map(t => t.name), ...i.inherited_tags.map(t => t.name),
    ]),
  ]
  if (!matchesSearch(fields, searchText.value)) return false
  if (period.value !== 'all' && !g.items.some(i => inPeriod(i.acquired_at, period.value))) return false
  if (agingMinFilter.value != null && (g.oldest_aging_days == null || g.oldest_aging_days < agingMinFilter.value)) return false
  return true
}

const filteredGroups = computed(() => {
  const list = groups.value.filter(groupMatchesFilters)
  // 選んだ並びで一度ソートし、続けて「型番なし」だけを末尾へ（安定ソートなので順序は保たれる）
  list.sort((a, b) => groupSortValue(b) - groupSortValue(a))
  list.sort((a, b) => (a.model_code === null ? 1 : 0) - (b.model_code === null ? 1 : 0))
  return list
})

const totalCount = computed(() => viewMode.value === 'group'
  ? filteredGroups.value.reduce((s, g) => s + g.items.length, 0)
  : filteredItems.value.length)
const totalCost = computed(() => viewMode.value === 'group'
  ? filteredGroups.value.reduce((s, g) => s + g.items.reduce((ss, i) => ss + i.landed_cost, 0), 0)
  : filteredItems.value.reduce((s, i) => s + i.landed_cost, 0))

// --- 型番グループのヘッダー ---
function unlistedPart(g: InventoryGroup): string | null {
  if (g.unlisted === 0) return null
  const notArrived = g.not_arrived > 0 ? `・未着 ${g.not_arrived}` : ''
  return `未出品 ${g.unlisted} 点（届いている ${g.unlisted_arrived}${notArrived}）`
}
function listedPart(g: InventoryGroup): string | null {
  return g.listed > 0 ? `出品中 ${g.listed}` : null
}
function soldPart(g: InventoryGroup): string | null {
  if (g.sold === 0) return null
  const avg = []
  if (g.avg_price != null) avg.push(`平均売価 ${yen(g.avg_price)}`)
  if (g.avg_profit != null) avg.push(`平均粗利 ${yen(g.avg_profit)}`)
  return `販売済 ${g.sold} 点${avg.length ? `（${avg.join('・')}）` : ''}`
}
function groupSubLine(g: InventoryGroup): string {
  const parts = [unlistedPart(g), listedPart(g), soldPart(g)].filter((s): s is string => !!s)
  if (g.model_code === null) {
    return `${parts.length ? parts.join('・') : '在庫なし'}。型番を付けると自動引き当ての対象になります`
  }
  return parts.join('・') || '—'
}

const groupThumbFailed = ref<Set<string>>(new Set())
function groupKey(g: InventoryGroup): string {
  return g.model_code ?? '__none__'
}
function showGroupThumb(g: InventoryGroup): boolean {
  return !!g.thumb_url && !groupThumbFailed.value.has(groupKey(g))
}
function onGroupThumbError(g: InventoryGroup) {
  groupThumbFailed.value = new Set(groupThumbFailed.value).add(groupKey(g))
}
function groupPlaceholderChar(g: InventoryGroup): string {
  const c = g.model_code?.[0] ?? g.name.trim().charAt(0)
  return (c || '?').toUpperCase()
}

function assignGroupModelCode(g: InventoryGroup) {
  if (g.items[0]) editModelCode(g.items[0])
}

// --- 分割の子：同じ親を持つきょうだいの中の順番（グループ内に揃っている前提） ---
function splitLabel(i: InventoryItem, siblings: InventoryItem[]): string | null {
  if (!i.parent_id) return null
  const group = siblings.filter(x => x.parent_id === i.parent_id)
  const idx = group.findIndex(x => x.id === i.id) + 1
  return group.length > 1 ? `分割 ${idx}/${group.length}` : '分割'
}

// --- サムネイル（「1点ずつ」表）。読み込み失敗したら以後プレースホルダに固定する ---
const thumbFailed = ref<Set<string>>(new Set())
function showThumb(i: InventoryItem): boolean {
  return !!i.thumb_url && !thumbFailed.value.has(i.id)
}
function onThumbError(id: string) {
  thumbFailed.value = new Set(thumbFailed.value).add(id)
}
function placeholderChar(i: InventoryItem): string {
  const c = i.model_code?.[0] ?? i.name.trim().charAt(0)
  return (c || '?').toUpperCase()
}

// --- 在庫1点の状態（未出品／未着／出品中はピル、販売済・廃棄などはチップ）の表示 ---
type PillTone = 'solid-ok' | 'solid-loss' | 'solid-warn' | 'solid-info' | 'neutral' | 'ok' | 'warn' | 'info' | 'brand'
type ChipTone = 'warn' | 'ok' | 'neutral' | 'info' | 'brand' | 'loss'

/** status !== 'in_stock' なら該当なし（チップ側で表す） */
function itemPillState(i: InventoryItem): { tone: PillTone; label: string } | null {
  if (i.status !== 'in_stock') return null
  if (i.fulfillment === 'pending' || i.fulfillment === 'shipped') return { tone: 'solid-warn', label: '未着' }
  if (i.listing) {
    return {
      tone: i.listing.status === 'suspended' ? 'neutral' : 'brand',
      label: `${i.listing.status === 'suspended' ? '公開停止中' : '出品中'} ${yen(i.listing.price)}`,
    }
  }
  return { tone: 'neutral', label: '未出品' }
}

/** in_stock なら該当なし（ピル側で表す） */
function itemChipState(i: InventoryItem): { tone: ChipTone; label: string } | null {
  if (i.status === 'sold') return { tone: 'ok', label: '販売済' }
  if (i.status === 'disposed') return { tone: 'neutral', label: '廃棄' }
  if (i.status === 'personal_use') return { tone: 'neutral', label: '自家消費' }
  if (i.status === 'split') return { tone: 'neutral', label: '分割済' }
  return null
}

// --- 履歴ドロワー ---
const timelineItemId = ref<string | null>(null)
function openTimeline(item: InventoryItem) {
  timelineItemId.value = item.id
}

// --- 未着の在庫を「仕入の伝票」から到着済にする（在庫は purchase_id を持たないため、
//     一度履歴を読んで仕入の id を取り、仕入タブへ渡す） ---
async function openArrivalPurchase(item: InventoryItem) {
  const t = await window.soroban.getItemTimeline(item.id)
  if (t?.purchase) {
    goto('purchases', { focusId: t.purchase.id })
  } else {
    toast('仕入の情報が見つかりませんでした', 'warn')
  }
}

// --- タグ ---
const TAG_ORIGIN_LABEL: Record<string, string> = { purchase: '仕入から', product: '商品から', inventory: '在庫から' }
const TAG_ORIGIN_MARK: Record<string, string> = { purchase: '仕', product: '品', inventory: '在' }
function tagOriginTitle(from?: Tag['from']): string {
  return from ? TAG_ORIGIN_LABEL[from] : ''
}
function tagOriginMark(from?: Tag['from']): string {
  return from ? TAG_ORIGIN_MARK[from] : ''
}

const tagPickerForId = ref<string | null>(null)
const tagPickerAnchor = ref<HTMLElement | null>(null)
function findItem(id: string | null): InventoryItem | null {
  if (!id) return null
  return items.value.find(i => i.id === id) ?? groups.value.flatMap(g => g.items).find(i => i.id === id) ?? null
}
const tagPickerItem = computed(() => findItem(tagPickerForId.value))
const tagPickerSelected = computed(() => tagPickerItem.value?.tags.map(t => t.id) ?? [])

function openTagPicker(item: InventoryItem, e: MouseEvent) {
  tagPickerForId.value = item.id
  tagPickerAnchor.value = e.currentTarget as HTMLElement
}

function closeTagPicker() {
  tagPickerForId.value = null
  tagPickerAnchor.value = null
}

async function onTagsChange(tagIds: string[]) {
  if (!tagPickerForId.value) return
  await window.soroban.setInventoryTags(tagPickerForId.value, tagIds)
  await load()
}

async function onTagCreate(name: string) {
  const id = await window.soroban.createTag(name)
  await loadTags()
  if (!tagPickerForId.value) return
  await window.soroban.setInventoryTags(tagPickerForId.value, [...tagPickerSelected.value, id])
  await load()
}

async function dispose(item: InventoryItem, target: 'disposed' | 'personal_use') {
  const label = target === 'personal_use' ? '自家消費' : '廃棄'
  if (!await confirmDialog(`「${item.name}」を${label}として在庫から外しますか？`, { okLabel: `${label}にする` })) return
  await window.soroban.disposeInventory(item.id, label, target)
  await load()
  changed()
}

async function split(item: InventoryItem) {
  const input = await ask('何点に分けますか', { initial: '2', placeholder: '例：3' })
  if (input === null) return
  const n = Number(input)
  if (!Number.isInteger(n) || n < 2) return
  if (!await confirmDialog(
    `「${item.name}」を${n}点に分割しますか？`,
    { message: `原価 ${yen(item.landed_cost)} を等分します`, okLabel: '分割する' },
  )) return
  try {
    const newIds = await window.soroban.splitInventory(item.id, n)
    const created = await window.soroban.listInventory('in_stock')
    const codes = newIds
      .map(id => created.find(i => i.id === id)?.item_code)
      .filter((c): c is string => !!c)
    await load()
    changed()
    if (codes.length) toast(`${codes.join('・')}に分割しました`, 'ok')
  } catch (e) {
    toast((e as Error).message, 'warn')
  }
}

// --- 分割を戻す（結合）。子の行・「その他」で見える親の行（status==='split'）の両方から呼ぶ ---
function mergeMessage(item: InventoryItem, siblings: InventoryItem[]): string {
  const parentId = item.parent_id ?? item.id
  const rest = siblings.filter(i => i.parent_id === parentId && i.id !== item.id)
  if (!rest.length) return '同じ親から分けた在庫がまとめて1点に戻ります'
  const label = rest.length > 1 ? `${rest[0].item_code} ほか${rest.length - 1}点` : rest[0].item_code
  return `同じ親から分けた在庫（${label}）が1点に戻ります`
}

async function mergeSplit(item: InventoryItem) {
  const parentId = item.parent_id ?? item.id
  const siblings = items.value.length ? items.value : groups.value.flatMap(g => g.items)
  if (!await confirmDialog('分割を戻しますか？', { message: mergeMessage(item, siblings), okLabel: '戻す' })) return
  try {
    await window.soroban.mergeSplitInventory(parentId)
    await load()
    changed()
    toast('分割を戻しました', 'ok')
  } catch (e) {
    toast((e as Error).message, 'warn')
  }
}

async function editModelCode(item: InventoryItem) {
  const input = await ask('型番', { initial: item.model_code ?? '', placeholder: '例：Z078-2' })
  if (input === null) return
  const trimmed = input.trim().toUpperCase()
  if (trimmed === '') {
    await window.soroban.updateInventory(item.id, { model_code: null, series_code: null })
    await load()
    return
  }
  if (!MODEL_CODE_RE.test(trimmed)) {
    toast('型番の形式が違います（例：Z078-2）', 'warn')
    return
  }
  await window.soroban.updateInventory(item.id, { model_code: trimmed, series_code: trimmed.split('-')[0] })
  await load()
}

async function editNote(item: InventoryItem) {
  const input = await ask('メモ', { initial: item.note ?? '', multiline: true })
  if (input === null) return
  await window.soroban.updateInventory(item.id, { note: input })
  await load()
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">在庫</h1>
    </div>

    <Skeleton v-if="!overview" kind="stats" :rows="4" />
    <StageStrip v-else :stages="stages" :active="activeStage" @select="selectStage" />

    <div class="toolbar">
      <span class="seg">
        <button type="button" :class="{ on: viewMode === 'group' }" @click="viewMode = 'group'">型番ごと</button>
        <button type="button" :class="{ on: viewMode === 'flat' }" @click="viewMode = 'flat'">1点ずつ</button>
      </span>
      <select v-model="tagFilter">
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
      </select>
      <SearchBox v-model="searchText" placeholder="名前・型番・素材・メモ・タグ・仕入先を検索" />
      <PeriodSelect v-model="period" />
      <select v-if="viewMode === 'group'" v-model="groupSortKey">
        <option value="aging">滞留が長い順</option>
        <option value="acquired_at">仕入日</option>
        <option value="cost">原価</option>
      </select>
      <button
        v-if="agingMinFilter != null"
        type="button"
        class="aging-chip-btn"
        :title="`滞留 ${agingMinFilter} 日以上の絞り込みを解除`"
        @click="agingMinFilter = null"
      >
        <StatusChip tone="warn" :label="`滞留 ${agingMinFilter} 日以上 ×`" />
      </button>
      <span class="grow" />
      <span class="faint nowrap">{{ totalCount }}点 ／ 原価計 {{ yen(totalCost) }}</span>
    </div>
    <p class="faint hint-row">
      在庫コード（S-0012）をクリックするとコピーできます。メルカリのタイトルに貼るとその1点が自動で引き当たります。2個セットは【S-0012】【S-0013】のように並べます
    </p>

    <!-- 型番ごと -->
    <template v-if="viewMode === 'group'">
      <Skeleton v-if="!loaded" :rows="6" />
      <template v-else-if="filteredGroups.length">
        <div v-for="g in filteredGroups" :key="groupKey(g)" class="panel group">
          <div class="ghead">
            <div class="gimg">
              <img
                v-if="showGroupThumb(g)" class="gimg-img" :src="g.thumb_url!" alt=""
                loading="lazy" @error="onGroupThumbError(g)"
              />
              <span v-else class="gimg-ph">{{ groupPlaceholderChar(g) }}</span>
            </div>
            <div class="gmain">
              <div class="gt">
                <span class="gt-name">{{ g.name }}</span>
                <CodeChip v-if="g.model_code" kind="model" :code="g.model_code" />
                <StatusChip v-for="t in g.tags" :key="t.id" tone="info" :label="t.name" />
              </div>
              <div class="gs">{{ groupSubLine(g) }}</div>
            </div>
            <div class="gnum">
              <span v-if="g.cost_per_item != null" class="gnum-item">
                <span class="gnum-label">原価/点</span>
                <b>{{ yen(g.cost_per_item) }}</b>
              </span>
              <span v-if="g.oldest_acquired_at" class="gnum-item">
                <span class="gnum-label">最古の仕入</span>
                <b :class="{ warn: (g.oldest_aging_days ?? 0) >= warnDays }">
                  {{ g.oldest_acquired_at }}（{{ g.oldest_aging_days }}日）
                </b>
              </span>
              <button
                v-if="g.model_code" type="button" class="link-action"
                @click="goto('products', { modelCode: g.model_code })"
              >
                商品カルテ
                <Icon name="arrow-right" :size="16" />
              </button>
              <button v-else type="button" class="link-action" @click="assignGroupModelCode(g)">型番を付ける</button>
            </div>
          </div>

          <div class="gitems">
            <div
              v-for="i in g.items" :key="i.id"
              :data-row-id="i.id"
              class="git" :class="{ focused: focusedId === i.id }"
            >
              <div class="git-code clickable" @click="openTimeline(i)">
                <CodeChip kind="item" :code="i.item_code" />
                <span v-if="splitLabel(i, g.items)" class="dim split-label">{{ splitLabel(i, g.items) }}</span>
              </div>
              <div class="git-meta clickable" @click="openTimeline(i)">
                <span>{{ i.shop_account_name ?? '—' }} ・ {{ i.acquired_at }} 仕入</span>
                <div v-if="i.tags.length || i.inherited_tags.length" class="chip-row">
                  <StatusChip v-for="t in i.tags" :key="t.id" tone="info" :label="t.name" />
                  <span
                    v-for="t in i.inherited_tags" :key="'inh-' + t.id"
                    class="chip-inherited-wrap" :title="tagOriginTitle(t.from)"
                  >
                    <span class="chip-origin-mark">{{ tagOriginMark(t.from) }}</span>
                    <StatusChip tone="neutral" :label="t.name" class="chip-inherited" />
                  </span>
                </div>
                <div v-if="i.note" class="note-row">
                  <Icon name="note" :size="14" class="icon-note" />
                  <span class="note-label">メモ</span>
                  <span class="note-text">{{ i.note }}</span>
                </div>
              </div>
              <div class="git-cost num">{{ yen(i.landed_cost) }}</div>
              <div class="git-aging">
                <StatusChip v-if="i.aging_days >= warnDays" tone="warn" :label="`${i.aging_days}日`" />
                <span v-else class="faint">{{ i.aging_days }}日</span>
              </div>
              <div class="git-state">
                <StatusPill v-if="itemPillState(i)" :tone="itemPillState(i)!.tone" :label="itemPillState(i)!.label" />
                <StatusChip v-else-if="itemChipState(i)" :tone="itemChipState(i)!.tone" :label="itemChipState(i)!.label" />
              </div>
              <div class="git-ops">
                <template v-if="i.status === 'in_stock'">
                  <button
                    v-if="i.fulfillment === 'pending' || i.fulfillment === 'shipped'"
                    class="sm ghost" @click="openArrivalPurchase(i)" title="仕入の伝票で到着済にする"
                  >到着済にする</button>
                  <button
                    class="sm ghost" @click="editModelCode(i)"
                    :title="i.model_code ? '型番を編集する' : '型番を設定する'"
                  >{{ i.model_code ? '型番編集' : '型番' }}</button>
                  <button class="sm ghost" @click="openTagPicker(i, $event)" title="タグを編集する">タグ</button>
                  <button class="sm ghost" @click="split(i)" title="この在庫を複数点に分ける">分割</button>
                  <button
                    v-if="i.parent_id" class="sm ghost" @click="mergeSplit(i)"
                    title="同じ親から分けた在庫を全部まとめて、分割前の1点に戻します"
                  >分割を戻す</button>
                  <button class="sm ghost" @click="editNote(i)" title="メモを編集する">メモ</button>
                  <button class="sm ghost" @click="dispose(i, 'disposed')" title="在庫から外して廃棄にする">廃棄</button>
                  <button class="sm ghost" @click="dispose(i, 'personal_use')" title="在庫から外して自家消費にする">自家消費</button>
                </template>
                <template v-else-if="i.status === 'split'">
                  <button
                    class="sm ghost" @click="mergeSplit(i)"
                    title="同じ親から分けた在庫を全部まとめて、分割前の1点に戻します"
                  >戻す</button>
                </template>
              </div>
            </div>
          </div>
        </div>
      </template>
      <EmptyState v-else title="該当する在庫がありません" />
    </template>

    <!-- 1点ずつ -->
    <div v-else class="panel table-panel">
      <Skeleton v-if="!loaded" :rows="6" />
      <table v-else-if="filteredItems.length">
        <thead>
          <tr>
            <th class="col-thumb"></th>
            <SortTh label="商品" sort-key="name" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
            <SortTh label="仕入先" sort-key="shop_account_name" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
            <SortTh label="仕入日" sort-key="acquired_at" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
            <SortTh label="滞留" sort-key="aging_days" align="right" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
            <SortTh label="原価" sort-key="landed_cost" align="right" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="i in filteredItems" :key="i.id"
            :data-row-id="i.id"
            :class="{ focused: focusedId === i.id }"
          >
            <td class="thumb-cell clickable" @click="openTimeline(i)" title="履歴を見る">
              <img
                v-if="showThumb(i)"
                class="thumb"
                :src="i.thumb_url!"
                alt=""
                loading="lazy"
                @error="onThumbError(i.id)"
              />
              <span v-else class="thumb-placeholder">{{ placeholderChar(i) }}</span>
            </td>
            <td class="item-cell">
              <div class="item-name clickable" :title="i.name" @click="openTimeline(i)">{{ i.name }}</div>
              <div class="chip-row">
                <CodeChip kind="item" :code="i.item_code" />
                <CodeChip v-if="i.model_code" kind="model" :code="i.model_code" />
                <button
                  v-if="i.status === 'in_stock'" class="sm ghost" @click="editModelCode(i)"
                  :title="i.model_code ? '型番を編集する' : '型番を設定する'"
                >{{ i.model_code ? '型番編集' : '型番' }}</button>
                <StatusPill
                  v-if="itemPillState(i) && (showStatusChips || itemPillState(i)!.label !== '未出品')"
                  :tone="itemPillState(i)!.tone" :label="itemPillState(i)!.label"
                />
                <StatusChip v-if="showStatusChips && itemChipState(i)" :tone="itemChipState(i)!.tone" :label="itemChipState(i)!.label" />
                <StatusChip v-if="i.parent_id" tone="neutral" label="分割" />
                <StatusChip v-for="t in i.tags" :key="t.id" tone="info" :label="t.name" />
                <span
                  v-for="t in i.inherited_tags" :key="'inh-' + t.id"
                  class="chip-inherited-wrap"
                  :title="tagOriginTitle(t.from)"
                >
                  <span class="chip-origin-mark">{{ tagOriginMark(t.from) }}</span>
                  <StatusChip tone="neutral" :label="t.name" class="chip-inherited" />
                </span>
              </div>
              <div v-if="i.note" class="note-row">
                <Icon name="note" :size="14" class="icon-note" />
                <span class="note-label">メモ</span>
                <span class="note-text">{{ i.note }}</span>
              </div>
            </td>
            <td class="faint">{{ i.shop_account_name ?? '—' }}</td>
            <td class="faint nowrap">{{ i.acquired_at }}</td>
            <td class="num">
              <StatusChip
                v-if="i.aging_days >= warnDays"
                tone="warn" :label="`${i.aging_days}日`"
              />
              <span v-else>{{ i.aging_days }}日</span>
            </td>
            <td class="num">{{ yen(i.landed_cost) }}</td>
            <td class="actions">
              <template v-if="i.status === 'in_stock'">
                <button
                  v-if="i.fulfillment === 'pending' || i.fulfillment === 'shipped'"
                  class="sm ghost" @click="openArrivalPurchase(i)" title="仕入の伝票で到着済にする"
                >到着済にする</button>
                <button class="sm ghost" @click="openTagPicker(i, $event)" title="タグを編集する">タグ</button>
                <button class="sm ghost" @click="split(i)" title="この在庫を複数点に分ける">分割</button>
                <button
                  v-if="i.parent_id" class="sm ghost" @click="mergeSplit(i)"
                  title="同じ親から分けた在庫を全部まとめて、分割前の1点に戻します"
                >分割を戻す</button>
                <button class="sm ghost" @click="editNote(i)" title="メモを編集する">メモ</button>
                <button class="sm ghost" @click="dispose(i, 'disposed')" title="在庫から外して廃棄にする">廃棄</button>
                <button class="sm ghost" @click="dispose(i, 'personal_use')" title="在庫から外して自家消費にする">自家消費</button>
              </template>
              <template v-else-if="i.status === 'split'">
                <button
                  class="sm ghost" @click="mergeSplit(i)"
                  title="同じ親から分けた在庫を全部まとめて、分割前の1点に戻します"
                >戻す</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else title="該当する在庫がありません" />
    </div>

    <TagPicker
      :open="!!tagPickerForId"
      :anchor="tagPickerAnchor"
      :all-tags="allTags"
      :selected="tagPickerSelected"
      @change="onTagsChange"
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
/* 派生タグ（仕入・商品から引き継いだもの）は直接付けたタグより少し薄く見せる。
   先頭の小さな記号で出どころ（仕入／商品）を示す */
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

.hint-row { margin: -4px 0 12px; }

/* --- 状態カードのすぐ下のツールバー --- */
.toolbar { margin-top: 12px; }

.seg {
  display: inline-flex;
  flex-shrink: 0;
  border: 1px solid var(--line);
  border-radius: 999px;
  overflow: hidden;
}
.seg button {
  border: none;
  background: transparent;
  padding: 6px 14px;
  font: inherit;
  font-size: var(--fs-13);
  color: var(--text-dim);
  cursor: pointer;
}
.seg button.on { background: var(--primary); color: #fff; }

.aging-chip-btn {
  flex-shrink: 0;
  display: block;
  background: transparent;
  border: none;
  padding: 0;
  height: auto;
  cursor: pointer;
}
.aging-chip-btn:hover:not(:disabled) { background: transparent; }

.link-action {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: transparent;
  border: none;
  padding: 0;
  height: auto;
  color: var(--text-dim);
  font-size: var(--fs-12);
  text-decoration: underline dotted;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.link-action:hover:not(:disabled) { background: transparent; color: var(--text); }

/* --- 型番ごとのグループカード --- */
.group { padding: 0; margin-bottom: 16px; overflow: hidden; }
.group:last-child { margin-bottom: 0; }

.ghead {
  display: grid;
  grid-template-columns: 56px 1fr auto;
  gap: 14px;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid var(--line-soft);
}
.gimg, .gimg-img, .gimg-ph {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.gimg-img { object-fit: cover; display: block; }
.gimg-ph {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-weight: 700;
  font-size: var(--fs-16);
}
.gmain { min-width: 0; }
.gt {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: var(--fs-14);
  font-weight: 600;
}
.gt-name { word-break: break-word; }
.gs { margin-top: 4px; font-size: var(--fs-12); color: var(--text-dim); }

.gnum {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-shrink: 0;
  font-size: var(--fs-12);
  color: var(--text-dim);
  text-align: right;
}
.gnum-item { display: flex; flex-direction: column; gap: 2px; }
.gnum-label { font-size: var(--fs-11); color: var(--text-faint); }
.gnum-item b { font-size: var(--fs-14); color: var(--text); font-weight: 700; }
.gnum-item b.warn { color: var(--warn); }

.gitems { padding: 4px 20px 8px; }
.git {
  display: grid;
  grid-template-columns: 116px 1fr 92px 68px 150px auto;
  gap: 12px;
  align-items: center;
  padding: 8px 0;
  border-top: 1px solid var(--line-soft);
  font-size: var(--fs-13);
}
.git:first-child { border-top: 0; }
.git.focused { background: var(--brand-soft); }
.git-code { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.split-label { font-size: var(--fs-11); }
.git-meta { min-width: 0; }
.git-meta .chip-row { margin-top: 4px; }
.git-cost { text-align: right; font-variant-numeric: tabular-nums; }
.git-aging { text-align: center; }
.git-state { text-align: left; }
.git-ops { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
.clickable { cursor: pointer; }

.table-panel { padding: 0; overflow: hidden; }
.table-panel table { table-layout: fixed; }
.table-panel th.col-thumb { width: 64px; }
.table-panel th:nth-child(2) { width: 32%; min-width: 260px; }
.table-panel th:nth-child(3) { width: 18%; }
.table-panel th:nth-child(4) { width: 14%; }
.table-panel th:nth-child(5) { width: 12%; }
.table-panel th:nth-child(6) { width: 12%; }
.table-panel th:last-child,
.table-panel td.actions { width: 300px; white-space: nowrap; }
.table-panel .actions > * { vertical-align: middle; margin-left: 4px; }
.table-panel .actions button { white-space: nowrap; }
.table-panel .clickable { cursor: pointer; }
.table-panel .item-name {
  font-size: var(--fs-14);
  font-weight: 500;
  white-space: normal;
  word-break: break-word;
}

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

/* 横断検索・ホームから来たときに該当行を一時的に示す */
tr.focused { background: var(--brand-soft); }

@media (max-width: 1099px) {
  .table-panel { overflow-x: auto; }
  .git { grid-template-columns: 100px 1fr 80px 56px 120px auto; }
}
</style>
