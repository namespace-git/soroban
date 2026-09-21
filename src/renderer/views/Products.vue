<script setup lang="ts">
import { ref, computed, onMounted, watch, inject, type Ref } from 'vue'
import type { ProductSummary, ProductDetail, InventoryItem, SaleProfit, Tag } from '../../shared/types'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import CodeChip from '../components/CodeChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import MiniChart from '../components/MiniChart.vue'
import TimelineDrawer from '../components/TimelineDrawer.vue'
import TagPicker from '../components/TagPicker.vue'
import SearchBox, { matchesSearch } from '../components/SearchBox.vue'
import PeriodSelect, { inPeriod, type Period } from '../components/PeriodSelect.vue'
import SortTh from '../components/SortTh.vue'
import { useSort } from '../composables/useSort'

type SortKey = 'name' | 'in_stock' | 'purchase_total' | 'avg_cost' | 'avg_price' | 'avg_profit' | 'total_profit' | 'last_purchased_at' | 'last_sold_at'
type ChipInfo = { tone: 'neutral' | 'ok' | 'warn' | 'info'; label: string }

const revision = inject<Ref<number>>('revision')!
// ダッシュボードの型番ランキングから goto('products', { modelCode }) で開かれたときに読む
const gotoPayload = inject<Ref<{ modelCode?: string } | null>>('gotoPayload', ref(null))

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

// --- 一覧 ---

const products = ref<ProductSummary[]>([])
const loaded = ref(false)
const searchText = ref('')
/** 最終販売日（last_sold_at）に対する絞り込み。既定は「すべて」 */
const period = ref<Period>('all')

async function load() {
  loaded.value = false
  products.value = await window.soroban.listProducts()
  loaded.value = true
}
onMounted(load)
watch(revision, load)

// --- 並び替え（列見出しクリック）。既定は現状のまま粗利合計 desc ---
const { sortKey, sortDir, toggle, sortRows } = useSort<SortKey>('total_profit', 'desc')
function onSort(key: string) {
  toggle(key as SortKey)
}
function sortValue(p: ProductSummary, key: SortKey): string | number | null {
  switch (key) {
    case 'name': return p.name
    case 'in_stock': return p.in_stock
    case 'purchase_total': return p.purchase_total
    case 'avg_cost': return p.avg_cost
    case 'avg_price': return p.avg_price
    case 'avg_profit': return p.avg_profit
    case 'total_profit': return p.total_profit
    case 'last_purchased_at': return p.last_purchased_at
    case 'last_sold_at': return p.last_sold_at
  }
}

// --- 商品（型番）タグ：この型番の在庫・販売に派生で見える ---

const allTags = ref<Tag[]>([])
async function loadTags() {
  allTags.value = await window.soroban.listTags()
}
onMounted(loadTags)
watch(revision, loadTags)

const tagPickerModelCode = ref<string | null>(null)
const tagPickerAnchor = ref<HTMLElement | null>(null)
const tagPickerSelected = computed(() => {
  const target = tagPickerModelCode.value
  if (!target) return []
  const source = detail.value?.model_code === target ? detail.value : products.value.find(p => p.model_code === target)
  return source?.tags.map(t => t.id) ?? []
})

function openProductTagPicker(modelCode: string, e: MouseEvent) {
  tagPickerModelCode.value = modelCode
  tagPickerAnchor.value = e.currentTarget as HTMLElement
}

function closeProductTagPicker() {
  tagPickerModelCode.value = null
  tagPickerAnchor.value = null
}

async function onProductTagChange(tagIds: string[]) {
  if (!tagPickerModelCode.value) return
  await window.soroban.setProductTags(tagPickerModelCode.value, tagIds)
  await load()
  if (detail.value?.model_code === tagPickerModelCode.value) await openDetail(tagPickerModelCode.value)
}

async function onProductTagCreate(name: string) {
  if (!tagPickerModelCode.value) return
  const newTagId = await window.soroban.createTag(name)
  await loadTags()
  await window.soroban.setProductTags(tagPickerModelCode.value, [...tagPickerSelected.value, newTagId])
  await load()
  if (detail.value?.model_code === tagPickerModelCode.value) await openDetail(tagPickerModelCode.value)
}

const filteredProducts = computed(() =>
  sortRows(products.value, sortValue).filter(p =>
    matchesSearch([p.model_code, p.name], searchText.value) && inPeriod(p.last_sold_at, period.value),
  ),
)

// --- サムネイル。読み込み失敗したら以後プレースホルダに固定する ---

const thumbFailed = ref<Set<string>>(new Set())
function showThumb(url: string | null, key: string): boolean {
  return !!url && !thumbFailed.value.has(key)
}
function onThumbError(key: string) {
  thumbFailed.value = new Set(thumbFailed.value).add(key)
}
function placeholderChar(modelCode: string, name: string): string {
  const c = modelCode[0] ?? name.trim().charAt(0)
  return (c || '?').toUpperCase()
}

// --- 詳細（同じページ内で切り替える） ---

const detail = ref<ProductDetail | null>(null)
const detailLoading = ref(false)

async function openDetail(modelCode: string) {
  detail.value = null
  detailLoading.value = true
  detail.value = await window.soroban.getProduct(modelCode)
  detailLoading.value = false
}

function backToList() {
  detail.value = null
}

const listedCount = computed(() => detail.value?.items.filter(i => i.listing !== null).length ?? 0)
const unlistedCount = computed(() => (detail.value?.items.length ?? 0) - listedCount.value)

watch(revision, () => {
  if (detail.value) openDetail(detail.value.model_code)
})

// 開いたあとは payload を消費する（タブを離れてまた「商品」を直接開いたときに前の型番へ飛ばないため）
watch(gotoPayload, (p) => {
  if (p?.modelCode) {
    openDetail(p.modelCode)
    gotoPayload.value = null
  }
}, { immediate: true })

// --- 在庫の履歴ドロワー ---

const timelineItemId = ref<string | null>(null)
function openTimeline(item: InventoryItem) {
  timelineItemId.value = item.id
}

// --- 状態チップ ---

function itemStatusChip(i: InventoryItem): ChipInfo {
  if (i.status === 'sold') return { tone: 'ok', label: '販売済' }
  if (i.status === 'disposed') return { tone: 'warn', label: '廃棄' }
  if (i.status === 'personal_use') return { tone: 'neutral', label: '自家消費' }
  if (i.status === 'split') return { tone: 'neutral', label: '分割済' }
  if (i.fulfillment === 'pending' || i.fulfillment === 'shipped') return { tone: 'info', label: '未着' }
  return { tone: 'neutral', label: '在庫' }
}

const saleStatusLabel: Record<string, string> = {
  waiting_shipment: '発送待ち',
  shipped: '発送済み',
  delivered: '受取済み',
  completed: '取引完了',
}
function saleStatusChip(s: SaleProfit): ChipInfo {
  if (!s.status) return { tone: 'neutral', label: '未取得' }
  if (s.status === 'completed') return { tone: 'ok', label: saleStatusLabel[s.status] }
  if (s.status === 'shipped' || s.status === 'delivered') return { tone: 'info', label: saleStatusLabel[s.status] }
  return { tone: 'neutral', label: saleStatusLabel[s.status] }
}
</script>

<template>
  <div class="page">
    <!-- 一覧 -->
    <template v-if="!detail && !detailLoading">
      <div class="page-head">
        <h1 class="page-title">商品</h1>
      </div>

      <div class="toolbar">
        <SearchBox v-model="searchText" placeholder="型番・商品名を検索" />
        <PeriodSelect v-model="period" />
        <span class="grow" />
        <span class="faint">{{ filteredProducts.length }}件</span>
      </div>

      <Skeleton v-if="!loaded" :rows="6" />
      <div v-else-if="filteredProducts.length" class="panel table-panel">
        <table>
          <thead>
            <tr>
              <th class="col-thumb"></th>
              <SortTh label="商品" sort-key="name" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
              <SortTh label="在庫" sort-key="in_stock" align="right" class="col-n" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
              <SortTh label="仕入合計" sort-key="purchase_total" align="right" class="col-amt" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
              <SortTh label="平均原価" sort-key="avg_cost" align="right" class="col-amt" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
              <SortTh
                label="平均売価（まるごと換算）" sort-key="avg_price" align="right" class="col-amt col-wrap"
                title="分割した子は 1/分割数 の重みで平均します。箱を 4 つに分けて 1 個 ¥1,000 で売ると ¥4,000／箱"
                :active-key="sortKey" :dir="sortDir" @sort="onSort"
              />
              <SortTh
                label="平均粗利（まるごと換算）" sort-key="avg_profit" align="right" class="col-amt col-wrap"
                title="分割した子は 1/分割数 の重みで平均します。箱を 4 つに分けて 1 個 ¥1,000 で売ると ¥4,000／箱"
                :active-key="sortKey" :dir="sortDir" @sort="onSort"
              />
              <SortTh label="粗利合計" sort-key="total_profit" align="right" class="col-amt" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
              <SortTh label="最終仕入" sort-key="last_purchased_at" class="col-date-sm" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
              <SortTh label="販売" sort-key="last_sold_at" class="col-date-sm" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in filteredProducts" :key="p.model_code"
              class="product-row"
              @click="openDetail(p.model_code)"
            >
              <td class="thumb-cell">
                <img
                  v-if="showThumb(p.thumb_url, p.model_code)"
                  class="thumb" :src="p.thumb_url!" alt="" loading="lazy"
                  @error="onThumbError(p.model_code)"
                />
                <span v-else class="thumb-placeholder">{{ placeholderChar(p.model_code, p.name) }}</span>
              </td>
              <td class="item-cell">
                <div class="item-name">{{ p.name }}</div>
                <div class="chip-row">
                  <StatusChip tone="neutral" :label="p.model_code" />
                  <StatusChip v-for="t in p.tags" :key="t.id" tone="info" :label="t.name" />
                  <button class="sm ghost" @click.stop="openProductTagPicker(p.model_code, $event)" title="タグを編集する">タグ</button>
                </div>
              </td>
              <td class="num">{{ p.in_stock }}</td>
              <td class="num">{{ yen(p.purchase_total) }}</td>
              <td class="num">{{ p.avg_cost != null ? yen(p.avg_cost) : '—' }}</td>
              <td class="num">{{ p.avg_price != null ? yen(p.avg_price) : '—' }}</td>
              <td class="num" :class="p.avg_profit != null ? (p.avg_profit >= 0 ? 'profit' : 'loss') : ''">
                {{ p.avg_profit != null ? yen(p.avg_profit) : '—' }}
              </td>
              <td class="num">
                <strong :class="p.total_profit >= 0 ? 'profit' : 'loss'">{{ yen(p.total_profit) }}</strong>
              </td>
              <td class="dim last-dates">{{ p.last_purchased_at ?? '—' }}</td>
              <td class="dim last-dates">{{ p.last_sold_at ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyState
        v-else-if="searchText || period !== 'all'"
        title="検索条件に一致する商品がありません"
      />
      <EmptyState
        v-else
        title="型番付きの在庫がありません"
        hint="仕入を登録すると、ここに商品ごとの実績が並びます"
      />
    </template>

    <!-- 詳細 -->
    <template v-else>
      <div class="page-head">
        <button class="ghost back-btn" @click="backToList">
          <Icon name="arrow-right" :size="14" class="flip" />
          商品一覧
        </button>
      </div>

      <Skeleton v-if="detailLoading" :rows="6" />

      <template v-else-if="detail">
        <div class="panel detail-head">
          <img
            v-if="showThumb(detail.thumb_url, detail.model_code)"
            class="thumb thumb-lg" :src="detail.thumb_url!" alt=""
            @error="onThumbError(detail.model_code)"
          />
          <span v-else class="thumb-placeholder thumb-lg">{{ placeholderChar(detail.model_code, detail.name) }}</span>
          <div class="detail-head-text">
            <div class="chip-row">
              <StatusChip tone="neutral" :label="detail.model_code" />
              <StatusChip v-for="t in detail.tags" :key="t.id" tone="info" :label="t.name" />
              <button class="sm ghost" @click="openProductTagPicker(detail.model_code, $event)" title="タグを編集する">タグ</button>
            </div>
            <h2 class="detail-name">{{ detail.name }}</h2>
            <p class="faint tag-hint">この型番の在庫と販売に引き継がれます</p>
          </div>
        </div>

        <div class="stat-grid">
          <div class="stat-card">
            <span class="stat-card-label">在庫数</span>
            <span class="stat-card-value">{{ detail.in_stock }}<span class="unit">点</span></span>
            <span class="stat-card-sub">未出品 {{ unlistedCount }}・出品中 {{ listedCount }}</span>
          </div>
          <div class="stat-card">
            <span class="stat-card-label">仕入合計</span>
            <span class="stat-card-value">{{ yen(detail.purchase_total) }}</span>
          </div>
          <div class="stat-card">
            <span class="stat-card-label">平均原価 → 平均売価</span>
            <span class="stat-card-value compact">
              {{ detail.avg_cost != null ? yen(detail.avg_cost) : '—' }}
              <Icon name="arrow-right" :size="14" />
              {{ detail.avg_price != null ? yen(detail.avg_price) : '—' }}
            </span>
          </div>
          <div class="stat-card">
            <span class="stat-card-label">粗利合計</span>
            <span class="stat-card-value" :class="detail.total_profit >= 0 ? 'profit' : 'loss'">
              {{ yen(detail.total_profit) }}
            </span>
          </div>
        </div>

        <div class="panel">
          <div class="section-head">
            <span class="section-head-icon"><Icon name="inventory" :size="16" /></span>
            <h2 class="section-head-title">在庫の増減</h2>
            <span class="legend">
              <span class="legend-item"><span class="dot purchase" />仕入</span>
              <span class="legend-item"><span class="dot sold" />販売</span>
              <span class="legend-item"><span class="dot stock" />在庫残</span>
            </span>
          </div>
          <MiniChart v-if="detail.months.length" :months="detail.months" />
          <p v-else class="dim">仕入・販売の記録がまだありません</p>
        </div>

        <div class="panel table-panel">
          <p class="panel-title table-title">仕入</p>
          <table v-if="detail.items.length" class="compact">
            <thead>
              <tr>
                <th>仕入日</th>
                <th class="num">原価</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="i in detail.items" :key="i.id"
                class="item-row"
                @click="openTimeline(i)"
              >
                <td class="faint">{{ i.acquired_at }}</td>
                <td class="num">{{ yen(i.landed_cost) }}</td>
                <td>
                  <div class="chip-row">
                    <CodeChip kind="item" :code="i.item_code" />
                    <StatusChip :tone="itemStatusChip(i).tone" :label="itemStatusChip(i).label" />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <EmptyState v-else title="仕入の記録がありません" />
        </div>

        <div class="panel table-panel">
          <p class="panel-title table-title">販売</p>
          <table v-if="detail.sales.length" class="compact">
            <thead>
              <tr>
                <th>販売日</th>
                <th class="num">価格</th>
                <th class="num">粗利</th>
                <th>取引状態</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in detail.sales" :key="s.id">
                <td class="faint">{{ s.sold_at }}</td>
                <td class="num">{{ yen(s.price) }}</td>
                <td class="num" :class="s.gross_profit >= 0 ? 'profit' : 'loss'">{{ yen(s.gross_profit) }}</td>
                <td><StatusChip :tone="saleStatusChip(s).tone" :label="saleStatusChip(s).label" /></td>
              </tr>
            </tbody>
          </table>
          <EmptyState v-else title="販売の記録がありません" />
        </div>
      </template>
    </template>

    <TimelineDrawer
      :open="!!timelineItemId"
      :inventory-item-id="timelineItemId"
      @close="timelineItemId = null"
    />

    <TagPicker
      :open="!!tagPickerModelCode"
      :anchor="tagPickerAnchor"
      :all-tags="allTags"
      :selected="tagPickerSelected"
      @change="onProductTagChange"
      @create="onProductTagCreate"
      @close="closeProductTagPicker"
    />
  </div>
</template>

<style scoped>
.table-panel { padding: 0; overflow: hidden; }
.table-panel table { table-layout: fixed; }
.table-panel th.col-thumb { width: 64px; }
/* 数字列は固定幅、商品列が残りを取る（商品名を 3 行に折らない） */
.table-panel th.col-n     { width: 64px; }
.table-panel th.col-amt   { width: 104px; }
.table-panel th.col-date-sm { width: 84px; }
/* 「（まるごと換算）」が入る2列は折り返しを許して2行にする */
.table-panel th.col-wrap  { width: 116px; white-space: normal; line-height: 1.3; }

.product-row { cursor: pointer; }
.item-row { cursor: pointer; }

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

.item-cell .item-name {
  font-size: var(--fs-14);
  font-weight: 500;
}

.last-dates { font-size: var(--fs-12); }

.back-btn { display: inline-flex; align-items: center; gap: 6px; }
.back-btn .flip { transform: scaleX(-1); }

.detail-head {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}
.thumb-lg.thumb, .thumb-lg.thumb-placeholder {
  width: 56px;
  height: 56px;
  font-size: var(--fs-16);
}
.detail-head-text { min-width: 0; }
.detail-name { margin: 4px 0 0; font-size: var(--fs-20); font-weight: 700; }
.tag-hint { margin: 4px 0 0; font-size: var(--fs-12); }

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}
.stat-card-value.compact {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-20);
  white-space: nowrap;
}

.section-head .legend {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: var(--fs-12);
  color: var(--text-dim);
}
.legend-item { display: inline-flex; align-items: center; gap: 5px; }
.legend .dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  display: inline-block;
}
.legend .dot.purchase { background: var(--brand); }
.legend .dot.sold { background: var(--profit-solid); }
.legend .dot.stock { background: var(--text); }

.table-title { padding: 16px 20px 0; margin: 0 0 8px; }

@media (max-width: 1099px) {
  .stat-grid { grid-template-columns: repeat(2, 1fr); }
  .table-panel { overflow-x: auto; }
}
</style>
