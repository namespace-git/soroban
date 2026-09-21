<script setup lang="ts">
import { ref, onMounted, computed, watch, inject, nextTick, type Ref } from 'vue'
import type { InventoryItem, Tag } from '../../shared/types'
import type { PromptOptions } from '../components/InputDialog.vue'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import CodeChip from '../components/CodeChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import TagPicker from '../components/TagPicker.vue'
import TimelineDrawer from '../components/TimelineDrawer.vue'
import SearchBox, { matchesSearch } from '../components/SearchBox.vue'
import PeriodSelect, { inPeriod, type Period } from '../components/PeriodSelect.vue'
import SortTh from '../components/SortTh.vue'
import { useSort } from '../composables/useSort'

const MODEL_CODE_RE = /^[A-Z]\d{3}(-\d+)?$/

type StatusFilter = 'all' | 'unlisted' | 'listed' | 'sold' | 'other'
type SortKey = 'name' | 'shop_account_name' | 'acquired_at' | 'aging_days' | 'landed_cost'

const items = ref<InventoryItem[]>([])
const statusFilter = ref<StatusFilter>('unlisted')
const warnDays = ref(90)
const loaded = ref(false)
const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
const ask = inject<(title: string, opts?: PromptOptions) => Promise<string | null>>('prompt')!
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!
// 横断検索から goto('inventory', { search, focusId }) で開かれる
const gotoPayload = inject<Ref<{ search?: string; focusId?: string } | null>>('gotoPayload', ref(null))

const yen = (n: number) => '¥' + n.toLocaleString('ja-JP')

// --- サムネイル。読み込み失敗したら以後プレースホルダに固定する ---
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

// --- 履歴ドロワー ---
const timelineItemId = ref<string | null>(null)
function openTimeline(item: InventoryItem) {
  timelineItemId.value = item.id
}

const allTags = ref<Tag[]>([])
const tagFilter = ref('')
const searchText = ref('')
const period = ref<Period>('all')
// 検索中は状態の絞り込みを無視して全状態から探す（検索したのに見つからないと誤認させないため）
const hasSearch = computed(() => !!searchText.value.trim())

// --- 並び替え（列見出しクリック）。既定は滞留 desc（現状の並びと同じ） ---
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

async function load() {
  // 未出品／出品中は在庫としては同じ in_stock。listing の有無で client 側に分ける。
  // 「その他」は listInventory が単一の状態しか取れないため 3 回に分けて合わせる。
  // 「すべて」は検索中と同じく全状態を並列で取って結合する。
  if (hasSearch.value || statusFilter.value === 'all') {
    const [inStock, sold, disposed, personalUse, split] = await Promise.all([
      window.soroban.listInventory('in_stock'),
      window.soroban.listInventory('sold'),
      window.soroban.listInventory('disposed'),
      window.soroban.listInventory('personal_use'),
      window.soroban.listInventory('split'),
    ])
    items.value = [...inStock, ...sold, ...disposed, ...personalUse, ...split]
  } else if (statusFilter.value === 'sold') {
    items.value = await window.soroban.listInventory('sold')
  } else if (statusFilter.value === 'other') {
    const [disposed, personalUse, split] = await Promise.all([
      window.soroban.listInventory('disposed'),
      window.soroban.listInventory('personal_use'),
      window.soroban.listInventory('split'),
    ])
    items.value = [...disposed, ...personalUse, ...split]
  } else {
    items.value = await window.soroban.listInventory('in_stock')
  }
  const s = await window.soroban.getSettings()
  warnDays.value = Number(s.aging_warn_days ?? 90)
  loaded.value = true
}
onMounted(load)
watch([revision, statusFilter, hasSearch], load)

async function loadTags() {
  allTags.value = await window.soroban.listTags()
}
onMounted(loadTags)
watch(revision, loadTags)

// --- 横断検索からの遷移：検索語を引き継ぎ、該当行を一時的にハイライトする ---
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
  if (p.search) searchText.value = p.search
  if (p.focusId) focusRow(p.focusId)
  gotoPayload.value = null
}, { immediate: true })

// 「すべて」のときの並び：状態（未出品 → 出品中 → 販売済 → その他）→ 既存の並び
function statusRank(i: InventoryItem): number {
  if (i.status === 'in_stock') return i.listing === null ? 0 : 1
  if (i.status === 'sold') return 2
  return 3
}

const filteredItems = computed(() => {
  let list = items.value
  if (!hasSearch.value) {
    if (statusFilter.value === 'unlisted') list = list.filter(i => i.listing === null)
    if (statusFilter.value === 'listed') list = list.filter(i => i.listing !== null)
  }
  if (tagFilter.value) {
    list = list.filter(i =>
      i.tags.some(t => t.id === tagFilter.value) || i.inherited_tags.some(t => t.id === tagFilter.value),
    )
  }
  list = list.filter(i => matchesSearch(
    [
      i.item_code, i.name, i.model_code, i.series_code, i.material, i.note, i.shop_account_name,
      ...i.tags.map(t => t.name), ...i.inherited_tags.map(t => t.name),
    ],
    searchText.value,
  ))
  list = list.filter(i => inPeriod(i.acquired_at, period.value))
  list = sortRows(list, sortValue)
  // 「すべて」のときは状態順を優先し、その中を選んだ並びにする
  if (!hasSearch.value && statusFilter.value === 'all') {
    list = [...list].sort((a, b) => statusRank(a) - statusRank(b))
  }
  return list
})

// 状態が絞られていない（すべて／検索中）ときだけ、行に状態チップを出す
const showStatusChips = computed(() => hasSearch.value || statusFilter.value === 'all')

const total = computed(() => filteredItems.value.reduce((s, i) => s + i.landed_cost, 0))

// --- タグの絞り込み候補：出どころで分ける（直接／仕入から／商品から）。
//     現在読み込んでいる一覧（状態の絞り込み後、タグ・検索の絞り込み前）に実際に出ているタグだけ ---
function tagOptionsOf(pick: (i: InventoryItem) => Tag[]): Array<{ id: string; name: string }> {
  const map = new Map<string, string>()
  for (const i of items.value) for (const t of pick(i)) map.set(t.id, t.name)
  return [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ja'))
}
const directTagOptions = computed(() => tagOptionsOf(i => i.tags))
const purchaseTagOptions = computed(() => tagOptionsOf(i => i.inherited_tags.filter(t => t.from === 'purchase')))
const productTagOptions = computed(() => tagOptionsOf(i => i.inherited_tags.filter(t => t.from === 'product')))

// --- 派生タグの出どころ表示（chip-inherited の前に小さく出す印） ---
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
const tagPickerItem = computed(() => items.value.find(i => i.id === tagPickerForId.value) ?? null)
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

    <div class="toolbar">
      <select v-model="statusFilter">
        <option value="all">すべて</option>
        <option value="unlisted">未出品</option>
        <option value="listed">出品中</option>
        <option value="sold">販売済</option>
        <option value="other">その他（廃棄・自家消費・分割）</option>
      </select>
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
      <span v-if="hasSearch" class="faint search-hint">検索中は状態の絞り込みも解除して表示</span>
      <span class="grow" />
      <span class="faint nowrap">{{ filteredItems.length }}点 ／ 原価計 {{ yen(total) }}</span>
    </div>
    <p class="faint hint-row">
      在庫コード（S-0012）をクリックするとコピーできます。メルカリのタイトルに貼るとその1点が自動で引き当たります。2個セットは【S-0012】【S-0013】のように並べます
    </p>

    <div class="panel table-panel">
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
                <StatusChip
                  v-if="i.listing"
                  :tone="i.listing.status === 'suspended' ? 'neutral' : 'brand'"
                  :label="`${i.listing.status === 'suspended' ? '公開停止中' : '出品中'} ${yen(i.listing.price)}`"
                />
                <StatusChip v-if="i.fulfillment === 'pending' || i.fulfillment === 'shipped'" tone="info" label="未着" />
                <StatusChip v-if="i.parent_id" tone="neutral" label="分割" />
                <!-- 通常時は statusFilter で状態が絞られているため出さない。検索中・「すべて」は全状態が混ざるので目印を出す -->
                <StatusChip v-if="showStatusChips && i.status === 'in_stock' && !i.listing" tone="neutral" label="未出品" />
                <StatusChip v-if="showStatusChips && i.status === 'sold'" tone="ok" label="販売済" />
                <StatusChip v-if="showStatusChips && i.status === 'disposed'" tone="neutral" label="廃棄" />
                <StatusChip v-if="showStatusChips && i.status === 'personal_use'" tone="neutral" label="自家消費" />
                <StatusChip v-if="showStatusChips && i.status === 'split'" tone="neutral" label="分割済" />
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
                <button class="sm ghost" @click="openTagPicker(i, $event)" title="タグを編集する">タグ</button>
                <button class="sm ghost" @click="split(i)" title="この在庫を複数点に分ける">分割</button>
                <button class="sm ghost" @click="editNote(i)" title="メモを編集する">メモ</button>
                <button class="sm ghost" @click="dispose(i, 'disposed')" title="在庫から外して廃棄にする">廃棄</button>
                <button class="sm ghost" @click="dispose(i, 'personal_use')" title="在庫から外して自家消費にする">自家消費</button>
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

/* 横断検索から来たときに該当行を一時的に示す */
tr.focused { background: var(--brand-soft); }

@media (max-width: 1099px) {
  .table-panel { overflow-x: auto; }
}
</style>
