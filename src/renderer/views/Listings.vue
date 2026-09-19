<script setup lang="ts">
import { ref, computed, onMounted, watch, inject, type Ref } from 'vue'
import type { Listing, ListingStatus } from '../../shared/types'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import AllocateDrawer from '../components/AllocateDrawer.vue'

type StatusFilterKey = 'active_suspended' | 'active' | 'suspended' | 'sold' | 'ended' | 'all'

const STATUS_FILTER_MAP: Record<StatusFilterKey, ListingStatus[] | undefined> = {
  active_suspended: ['active', 'suspended'],
  active: ['active'],
  suspended: ['suspended'],
  sold: ['sold'],
  ended: ['ended'],
  all: undefined,
}

const STATUS_LABEL: Record<ListingStatus, string> = {
  active: '出品中', suspended: '公開停止中', sold: '売れた', ended: '取り下げ',
}
const STATUS_TONE: Record<ListingStatus, 'brand' | 'neutral' | 'ok' | 'info'> = {
  active: 'info', suspended: 'neutral', sold: 'ok', ended: 'neutral',
}

const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
// ダッシュボードの「未引き当ての出品」から goto('listings', { onlyUnallocated }) / goto('listings', { mercariItemId }) で開かれる
const gotoPayload = inject<Ref<{ mercariItemId?: string; onlyUnallocated?: boolean } | null>>('gotoPayload', ref(null))

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

const statusFilterKey = ref<StatusFilterKey>('active_suspended')
const onlyUnallocated = ref(false)
const search = ref('')
const listings = ref<Listing[]>([])
const loaded = ref(false)

// 検索中は状態・未引き当ての絞り込みを無視して全出品（売れた・取り下げも含む）から探す
const hasSearch = computed(() => !!search.value.trim())

async function load() {
  loaded.value = false
  listings.value = await window.soroban.listListings(
    hasSearch.value
      ? { status: ['active', 'suspended', 'sold', 'ended'] }
      : { status: STATUS_FILTER_MAP[statusFilterKey.value], onlyUnallocated: onlyUnallocated.value || undefined },
  )
  loaded.value = true
}
onMounted(load)
watch([revision, statusFilterKey, onlyUnallocated, hasSearch], load)

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return listings.value
  return listings.value.filter(l =>
    l.title.toLowerCase().includes(q)
    || l.model_codes.some(mc => mc.toLowerCase().includes(q))
    || l.items.some(it => it.name.toLowerCase().includes(q) || (it.model_code ?? '').toLowerCase().includes(q)),
  )
})

// --- サムネイル。読み込み失敗したら以後プレースホルダに固定する ---
const thumbFailed = ref<Set<string>>(new Set())
function showThumb(l: Listing): boolean {
  return !!l.thumb_url && !thumbFailed.value.has(l.mercari_item_id)
}
function onThumbError(id: string) {
  thumbFailed.value = new Set(thumbFailed.value).add(id)
}
function placeholderChar(l: Listing): string {
  const c = l.model_codes[0]?.[0] ?? l.title.trim().charAt(0)
  return (c || '?').toUpperCase()
}

// --- 引き当てドロワー ---
const allocating = ref<Listing | null>(null)
function openAllocate(l: Listing) {
  allocating.value = l
}
async function onAllocateChanged() {
  await load()
  changed()
  if (!allocating.value) return
  const id = allocating.value.mercari_item_id
  let found = listings.value.find(l => l.mercari_item_id === id)
  if (!found) {
    // 今の絞り込みから外れて消えた場合でも、開いているドロワーの中身は最新のまま保つ
    const all = await window.soroban.listListings({ status: ['active', 'suspended', 'sold', 'ended'] })
    found = all.find(l => l.mercari_item_id === id)
  }
  allocating.value = found ?? null
}

async function openFromId(id: string) {
  await load()
  let target = listings.value.find(l => l.mercari_item_id === id)
  if (!target) {
    const all = await window.soroban.listListings({ status: ['active', 'suspended', 'sold', 'ended'] })
    target = all.find(l => l.mercari_item_id === id)
  }
  if (target) openAllocate(target)
}

watch(gotoPayload, (p) => {
  if (!p) return
  if (p.onlyUnallocated) onlyUnallocated.value = true
  if (p.mercariItemId) openFromId(p.mercariItemId)
  gotoPayload.value = null
}, { immediate: true })

// --- 取り下げ ---
async function endListing(l: Listing) {
  if (!await confirmDialog(`「${l.title}」を取り下げますか？`, { okLabel: '取り下げる', danger: true })) return
  await window.soroban.endListing(l.mercari_item_id)
  await load()
  changed()
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">出品</h1>
    </div>

    <div class="toolbar">
      <select v-model="statusFilterKey">
        <option value="active_suspended">出品中＋公開停止中</option>
        <option value="active">出品中</option>
        <option value="suspended">公開停止中</option>
        <option value="sold">売れた</option>
        <option value="ended">取り下げ</option>
        <option value="all">すべて</option>
      </select>
      <label class="row">
        <input type="checkbox" v-model="onlyUnallocated" />
        未引き当てだけ
      </label>
      <label class="search-field">
        <Icon name="search" :size="16" />
        <input v-model="search" placeholder="タイトル・型番・在庫名で検索" />
      </label>
      <span v-if="hasSearch" class="faint search-hint">検索中は状態・未引き当ての絞り込みも解除して表示</span>
      <span class="grow" />
      <span class="faint">{{ filtered.length }}件</span>
    </div>

    <Skeleton v-if="!loaded" :rows="6" />

    <template v-else>
      <div v-if="filtered.length" class="panel table-panel">
        <table>
          <thead>
            <tr>
              <th class="col-thumb"></th>
              <th class="col-title">出品</th>
              <th class="num col-amt">出品価格</th>
              <th class="col-status">状態</th>
              <th class="col-reserved">引き当てた在庫</th>
              <th class="num col-amt">見込み粗利（送料前）</th>
              <th class="col-date">初めて見た日</th>
              <th class="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in filtered" :key="l.mercari_item_id">
              <td class="thumb-cell clickable" @click="openAllocate(l)">
                <img
                  v-if="showThumb(l)"
                  class="thumb"
                  :src="l.thumb_url!"
                  alt=""
                  loading="lazy"
                  @error="onThumbError(l.mercari_item_id)"
                />
                <span v-else class="thumb-placeholder">{{ placeholderChar(l) }}</span>
              </td>

              <td class="title-cell">
                <div class="title-name clickable" :title="l.title" @click="openAllocate(l)">{{ l.title }}</div>
                <div class="chip-row">
                  <StatusChip v-for="mc in l.model_codes" :key="mc" tone="neutral" :label="mc" />
                </div>
              </td>

              <td class="num">{{ yen(l.price) }}</td>

              <td><StatusChip :tone="STATUS_TONE[l.status]" :label="STATUS_LABEL[l.status]" /></td>

              <td>
                <div v-if="l.items.length" class="reserved-cell">
                  <div class="chip-row">
                    <StatusChip v-for="it in l.items" :key="it.id" tone="neutral" :label="it.model_code ?? it.name" />
                  </div>
                  <span class="num faint">{{ yen(l.reserved_cost) }}</span>
                </div>
                <StatusChip v-else tone="warn" label="未引き当て" />
              </td>

              <td class="num">
                <Transition name="settle" mode="out-in">
                  <strong
                    v-if="l.expected_profit != null"
                    :key="'c' + l.expected_profit"
                    :class="l.expected_profit >= 0 ? 'profit' : 'loss'"
                  >{{ yen(l.expected_profit) }}</strong>
                  <span v-else key="u" class="faint">—</span>
                </Transition>
              </td>

              <td class="faint nowrap">{{ l.first_seen_at }}</td>

              <td class="actions">
                <button class="sm" :class="l.items.length ? 'ghost' : 'link-btn'" @click="openAllocate(l)">
                  <Icon name="link" :size="14" /> {{ l.items.length ? '追加' : '引き当て' }}
                </button>
                <button
                  v-if="l.status === 'active' || l.status === 'suspended'"
                  class="sm ghost"
                  @click="endListing(l)"
                >取り下げ</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <EmptyState
        v-else
        title="出品がありません"
        hint="メルカリの取り込みで出品中タブから見つかると、ここに並びます"
      />
    </template>

    <AllocateDrawer
      :open="!!allocating"
      :listing="allocating"
      @close="allocating = null"
      @changed="onAllocateChanged"
    />
  </div>
</template>

<style scoped>
.toolbar { flex-wrap: wrap; }
label.row { white-space: nowrap; }

.search-field {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  height: 36px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  color: var(--text-faint);
  flex: 1 1 200px;
  min-width: 0;
}
.search-field input {
  flex: 1;
  width: auto;
  min-width: 0;
  border: none;
  padding: 0;
  height: auto;
  background: transparent;
}

.table-panel { padding: 0; overflow-x: auto; }
.table-panel table { table-layout: auto; }
.table-panel td { padding: 8px 12px; }

.col-thumb    { width: 64px; }
.col-title    { min-width: 220px; width: 40%; }
.col-amt      { width: 96px; }
.col-status   { width: 110px; }
.col-reserved { width: 200px; }
.col-date     { width: 96px; }
.col-actions  { width: 168px; }

/* 1099px 以下：狭幅で列を詰めて右側の列（状態・引き当て・日付・操作）が
   overflow で隠れないようにする。それでも収まらない分は表の中だけ横スクロールする */
@media (max-width: 1099px) {
  .col-thumb    { width: 48px; }
  .col-amt      { width: 80px; }
  .col-status   { width: 96px; }
  .col-reserved { width: 160px; }
  .col-date     { width: 72px; }
  .col-actions  { width: 140px; }
}

.nowrap { white-space: nowrap; }

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

.reserved-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.table-panel td.actions { white-space: nowrap; text-align: right; }
.table-panel .actions > * { vertical-align: middle; margin-left: 4px; }
</style>
