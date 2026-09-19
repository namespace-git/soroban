<script setup lang="ts">
import { ref, onMounted, computed, watch, inject, type Ref } from 'vue'
import type { InventoryItem, InventoryStatus, Tag } from '../../shared/types'
import type { PromptOptions } from '../components/InputDialog.vue'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import TagPicker from '../components/TagPicker.vue'

const MODEL_CODE_RE = /^[A-Z]\d{3}(-\d+)?$/

const items = ref<InventoryItem[]>([])
const status = ref<InventoryStatus>('in_stock')
const warnDays = ref(90)
const loaded = ref(false)
const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
const ask = inject<(title: string, opts?: PromptOptions) => Promise<string | null>>('prompt')!
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!

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

async function load() {
  items.value = await window.soroban.listInventory(status.value)
  const s = await window.soroban.getSettings()
  warnDays.value = Number(s.aging_warn_days ?? 90)
  loaded.value = true
}
onMounted(load)
watch([revision, status], load)

const total = computed(() => items.value.reduce((s, i) => s + i.landed_cost, 0))

const allTags = ref<Tag[]>([])
const tagFilter = ref('')
async function loadTags() {
  allTags.value = await window.soroban.listTags()
}
onMounted(loadTags)
watch(revision, loadTags)

const filteredItems = computed(() => {
  if (!tagFilter.value) return items.value
  return items.value.filter(i => i.tags.some(t => t.id === tagFilter.value))
})

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
    await window.soroban.splitInventory(item.id, n)
    await load()
    changed()
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
      <select v-model="status">
        <option value="in_stock">未販売</option>
        <option value="sold">販売済み</option>
        <option value="disposed">廃棄</option>
        <option value="personal_use">自家消費</option>
        <option value="split">分割済み</option>
      </select>
      <select v-model="tagFilter">
        <option value="">すべてのタグ</option>
        <option v-for="t in allTags" :key="t.id" :value="t.id">{{ t.name }}</option>
      </select>
      <span class="grow" />
      <span class="faint">{{ items.length }}点 ／ 原価計 {{ yen(total) }}</span>
    </div>

    <div class="panel table-panel">
      <Skeleton v-if="!loaded" :rows="6" />
      <table v-else-if="items.length">
        <thead>
          <tr>
            <th class="col-thumb"></th>
            <th>商品</th>
            <th>仕入先</th>
            <th>仕入日</th>
            <th class="num">滞留</th>
            <th class="num">原価</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="i in filteredItems" :key="i.id">
            <td class="thumb-cell">
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
              <div class="item-name" :title="i.name">{{ i.name }}</div>
              <div class="chip-row">
                <StatusChip
                  v-if="i.model_code" tone="neutral" :label="i.model_code"
                  @click="i.status === 'in_stock' && editModelCode(i)"
                  :class="{ clickable: i.status === 'in_stock' }"
                />
                <button v-else-if="i.status === 'in_stock'" class="sm ghost" @click="editModelCode(i)">型番</button>
                <StatusChip v-if="i.fulfillment === 'pending' || i.fulfillment === 'shipped'" tone="info" label="未着" />
                <StatusChip v-if="i.parent_id" tone="neutral" label="分割" />
                <StatusChip v-for="t in i.tags" :key="t.id" tone="info" :label="t.name" />
              </div>
              <div v-if="i.note" class="note-row">
                <Icon name="note" :size="14" class="icon-note" />
                <span class="note-label">メモ</span>
                <span class="note-text">{{ i.note }}</span>
              </div>
            </td>
            <td class="faint">{{ i.shop_account_name ?? '—' }}</td>
            <td class="faint">{{ i.acquired_at }}</td>
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
  </div>
</template>

<style scoped>
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

@media (max-width: 1099px) {
  .table-panel { overflow-x: auto; }
}
</style>
