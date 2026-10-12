<script setup lang="ts">
import { isRealized } from '../../shared/recognition'
import { ref, computed, onMounted, watch, inject, nextTick, type Ref } from 'vue'
import type { ProductSummary, ProductKarte, InventoryItem, ShippingMethod, Tag } from '../../shared/types'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import StatusPill from '../components/StatusPill.vue'
import CodeChip from '../components/CodeChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import TagPicker from '../components/TagPicker.vue'
import SearchBox, { matchesSearch } from '../components/SearchBox.vue'
import PeriodSelect, { inPeriod, type Period } from '../components/PeriodSelect.vue'
import { todayLocal } from '../../shared/date'
import type { PromptOptions } from '../components/InputDialog.vue'
import { yen, percent } from '../format'

const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
// ダッシュボードの型番ランキングから goto('products', { modelCode }) で開かれたときに読む
const gotoPayload = inject<Ref<{ modelCode?: string } | null>>('gotoPayload', ref(null))
const goto = inject<(t: string, payload?: { search?: string; focusId?: string }) => void>('goto')!
const ask = inject<(title: string, opts?: PromptOptions) => Promise<string | null>>('prompt')!
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!

// ------------------------------------------------------------
// 左：型番の一覧
// ------------------------------------------------------------

const products = ref<ProductSummary[]>([])
const loaded = ref(false)
const searchText = ref('')
/** 最終販売日（last_sold_at）に対する絞り込み。既定は「すべて」 */
const period = ref<Period>('all')

type ListSort = 'profit' | 'sold' | 'stock' | 'aging'
const listSort = ref<ListSort>('profit')

// --- スマホ幅：絞り込みは「絞り込み」ボタンの中にまとめる（デスクトップ幅では今までどおり常に並ぶ）。
//     閉じていても、いくつ効いているかはボタンの数字で分かる ---
const filtersOpen = ref(false)
const activeFilterCount = computed(() => (period.value !== 'all' ? 1 : 0))

/** 在庫タブ・設定タブと同じ「長期滞留」のしきい値（日数） */
const agingWarnDays = ref(90)

async function load() {
  loaded.value = false
  products.value = await window.soroban.listProducts()
  loaded.value = true
}
async function loadSettings() {
  const s = await window.soroban.getSettings()
  agingWarnDays.value = Number(s.aging_warn_days ?? 90)
}

function daysSince(dateStr: string): number {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number)
  const [ty, tm, td] = todayLocal().split('-').map(Number)
  return Math.round((new Date(ty, tm - 1, td).getTime() - new Date(y, m - 1, d).getTime()) / 86400000)
}
/**
 * 型番ごとの滞留日数はまだ集計に無いため、在庫が残っている型番に限り「最終仕入日からの経過日数」を目安にする
 */
function agingDays(p: ProductSummary): number | null {
  if (p.in_stock <= 0 || !p.last_purchased_at) return null
  return daysSince(p.last_purchased_at)
}
function isStagnant(p: ProductSummary): boolean {
  const d = agingDays(p)
  return d != null && d >= agingWarnDays.value
}

const filteredProducts = computed(() => {
  const rows = products.value.filter(p =>
    matchesSearch([p.model_code, p.name, p.custom_name, ...p.tags.map(t => t.name)], searchText.value) &&
    inPeriod(p.last_sold_at, period.value),
  )
  return [...rows].sort((a, b) => {
    switch (listSort.value) {
      case 'sold': return b.sold - a.sold
      case 'stock': return b.in_stock - a.in_stock
      case 'aging': return (agingDays(b) ?? -1) - (agingDays(a) ?? -1)
      default: return b.total_profit - a.total_profit
    }
  })
})
/** 絞り込んだ商品の粗利計の合計。ツールバーの件数表示に添える（他画面と同じ形） */
const filteredTotalProfit = computed(() => filteredProducts.value.reduce((s, p) => s + p.total_profit, 0))

// --- サムネイル。同じURLの失敗だけを抑止し、取り込みでURLが変われば表示を再試行する ---

const thumbFailed = ref<Set<string>>(new Set())
function showThumb(url: string | null, key: string): boolean {
  return !!url && !thumbFailed.value.has(`${key}:${url}`)
}
function onThumbError(key: string, url: string | null) {
  thumbFailed.value = new Set(thumbFailed.value).add(`${key}:${url}`)
}
function placeholderChar(modelCode: string, name: string): string {
  const c = modelCode[0] ?? name.trim().charAt(0)
  return (c || '?').toUpperCase()
}

// ------------------------------------------------------------
// 右：カルテ（getProductKarte）
// ------------------------------------------------------------

const karte = ref<ProductKarte | null>(null)
const karteLoading = ref(false)

async function selectProduct(modelCode: string) {
  karteLoading.value = true
  karte.value = await window.soroban.getProductKarte(modelCode)
  karteLoading.value = false
  resetEstimate()
}

// --- スマホ幅：一覧とカルテは入れ替えて出す（デスクトップ幅では今までどおり並ぶ）。
//     入れ替えのたびに本文の先頭へ戻し、一覧へ戻るときは元の位置へ戻す ---
const pageEl = ref<HTMLElement | null>(null)
const mobileDetail = ref(false)
let listScrollTop = 0
const isMobileWidth = () => window.matchMedia('(max-width: 767px)').matches
const scrollerEl = () => pageEl.value?.closest('main') ?? null

/** 一覧の行・ホームの型番ランキングからカルテを開く */
async function openKarte(modelCode: string) {
  if (isMobileWidth()) {
    const main = scrollerEl()
    listScrollTop = main?.scrollTop ?? 0
    mobileDetail.value = true
    if (main) main.scrollTop = 0
  }
  await selectProduct(modelCode)
}
async function closeKarte() {
  mobileDetail.value = false
  await nextTick()
  const main = scrollerEl()
  if (main) main.scrollTop = listScrollTop
}

/** 選んでいる型番はそのままに、数字だけ更新する（データ更新後の再読み込み用。試算の入力は消さない） */
async function refreshKarte() {
  if (!karte.value) return
  karte.value = await window.soroban.getProductKarte(karte.value.summary.model_code)
}

onMounted(async () => {
  await Promise.all([load(), loadSettings(), loadTags(), loadMethods()])
  if (gotoPayload.value?.modelCode) {
    await openKarte(gotoPayload.value.modelCode)
    gotoPayload.value = null
  } else if (filteredProducts.value.length) {
    await selectProduct(filteredProducts.value[0].model_code)
  }
})

watch(gotoPayload, async (p) => {
  if (p?.modelCode) {
    await openKarte(p.modelCode)
    gotoPayload.value = null
  }
})

watch(revision, async () => {
  await load()
  await loadTags()
  if (karte.value && filteredProducts.value.some(p => p.model_code === karte.value!.summary.model_code)) {
    await refreshKarte()
  } else if (filteredProducts.value.length) {
    await selectProduct(filteredProducts.value[0].model_code)
  } else {
    karte.value = null
  }
})

/** 仕入明細の元の名前（表示名と違うときだけ）。長くなりがちなので、シリーズ等とは別の行にする */
const headerSourceName = computed(() => {
  const k = karte.value
  return k?.source_name && k.source_name !== k.summary.name ? k.source_name : null
})
/** シリーズ・最終仕入・最終販売。1行に収め、収まらなければ末尾を省略する */
const headerMetaParts = computed(() => {
  const k = karte.value
  if (!k) return []
  const parts: string[] = []
  if (k.summary.series_code) parts.push(`シリーズ ${k.summary.series_code}`)
  if (k.summary.last_purchased_at) parts.push(`最終仕入 ${k.summary.last_purchased_at}`)
  if (k.summary.last_sold_at) parts.push(`最終販売 ${k.summary.last_sold_at}`)
  return parts
})

/** 出品中（引き当て済みも含めて履歴の下に一行で出す） */
const activeListings = computed(() =>
  karte.value?.listings.filter(l => l.status === 'active' || l.status === 'suspended') ?? [],
)

// --- 型番（商品）タグ：この型番の在庫・販売に派生で見える ---

const allTags = ref<Tag[]>([])
async function loadTags() {
  allTags.value = await window.soroban.listTags()
}

const tagPickerModelCode = ref<string | null>(null)
const tagPickerAnchor = ref<HTMLElement | null>(null)
const tagPickerSelected = computed(() => {
  const target = tagPickerModelCode.value
  if (!target) return []
  const source = karte.value?.summary.model_code === target ? karte.value.summary : products.value.find(p => p.model_code === target)
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
  if (karte.value?.summary.model_code === tagPickerModelCode.value) await refreshKarte()
  changed()
}
async function onProductTagCreate(name: string) {
  if (!tagPickerModelCode.value) return
  const newTagId = await window.soroban.createTag(name)
  await loadTags()
  await window.soroban.setProductTags(tagPickerModelCode.value, [...tagPickerSelected.value, newTagId])
  await load()
  if (karte.value?.summary.model_code === tagPickerModelCode.value) await refreshKarte()
  changed()
}

// --- 表示名：仕入明細・在庫の元の名前とは別に、商品タブでの見た目だけ変える ---

async function renameProduct(modelCode: string, currentName: string | null): Promise<void> {
  const input = await ask('商品名（表示名）', { initial: currentName ?? '', placeholder: '空にすると元の名前に戻ります' })
  if (input === null) return
  await window.soroban.setProductName(modelCode, input.trim() || null)
  await load()
  if (karte.value?.summary.model_code === modelCode) await refreshKarte()
  changed()
}

// --- 商品（型番）のメモ：在庫・売上・仕入と同じダイアログ・同じ流れ ---

async function editProductNote(modelCode: string, currentNote: string | null): Promise<void> {
  const input = await ask('メモ', { initial: currentNote ?? '', multiline: true })
  if (input === null) return
  await window.soroban.setProductNote(modelCode, input.trim() || null)
  await load()
  if (karte.value?.summary.model_code === modelCode) await refreshKarte()
  changed()
}

// --- 商品画像：人がセット（取り込みで上書きしない）／取り込みの自動更新に戻す ---

/** 画像を選んで上げている最中の型番（なければ null）。Web 版では回線によって 1〜3 秒かかるので、押せない・上げていると分かるようにする */
const imageBusyCode = ref<string | null>(null)

async function changeProductImage(modelCode: string) {
  if (imageBusyCode.value !== null) return
  imageBusyCode.value = modelCode
  try {
    const ok = await window.soroban.setProductImage(modelCode)
    if (!ok) return
    await load()
    if (karte.value?.summary.model_code === modelCode) await refreshKarte()
    changed()
    toast('画像をセットしました（取り込みで上書きしません）', 'ok')
  } catch (e: any) {
    toast(e.message, 'warn')
  } finally {
    imageBusyCode.value = null
  }
}

async function onToggleAutoImage(modelCode: string, e: Event) {
  const el = e.target as HTMLInputElement
  const auto = el.checked
  if (auto) {
    const ok = await confirmDialog('自動更新に戻しますか？', {
      message: 'セットした画像を捨てて、出品・販売の最新の画像に戻します',
      okLabel: '戻す',
    })
    if (!ok) { el.checked = false; return }
  }
  await window.soroban.setProductImageAuto(modelCode, auto)
  await load()
  if (karte.value?.summary.model_code === modelCode) await refreshKarte()
  changed()
}

// --- 手元の在庫：状態ピル・「追跡」で在庫タブへ ---

function itemStatePill(i: InventoryItem): { tone: 'info' | 'warn' | 'neutral'; label: string } {
  if (i.listing) return { tone: 'info', label: '出品中' }
  if (i.fulfillment === 'pending' || i.fulfillment === 'shipped') return { tone: 'warn', label: '未着' }
  return { tone: 'neutral', label: '未出品' }
}
/** 手元の在庫のうち、出品に引き当て済み（出品中）の点数。表の見出しで内訳として出す */
const karteListedCount = computed(() => karte.value?.items.filter(i => !!i.listing).length ?? 0)
function trackItem(i: InventoryItem) {
  goto('inventory', { focusId: i.id })
}

// ------------------------------------------------------------
// 「この金額で売ったら？」（estimateSaleProfit。粗利は画面で計算しない）
// ------------------------------------------------------------

const methods = ref<ShippingMethod[]>([])
async function loadMethods() {
  methods.value = await window.soroban.listShippingMethods()
}

const estimatePrice = ref(0)
const estimateShippingMethodId = ref<string | null>(null)
const estimateItemId = ref<string | null>(null)
type ProfitEstimate = { fee: number; shipping_fee: number; packaging_cost: number; cost: number; gross_profit: number }
const estimate = ref<ProfitEstimate | null>(null)

function resetEstimate() {
  const k = karte.value
  estimatePrice.value = k?.listings.find(l => l.status === 'active')?.price ?? k?.summary.avg_price ?? 0
  estimateShippingMethodId.value = k?.estimate_default.shipping_method_id ?? null
  estimateItemId.value = k?.estimate_default.inventory_item_id ?? null
  scheduleEstimate()
}

let estimateTimer: ReturnType<typeof setTimeout> | undefined
let estimateSeq = 0

async function runEstimate() {
  const seq = ++estimateSeq
  if (!karte.value) { estimate.value = null; return }
  const inventoryItemIds = estimateItemId.value ? [estimateItemId.value] : []
  const result = await window.soroban.estimateSaleProfit({
    price: estimatePrice.value || 0,
    shipping_method_id: estimateShippingMethodId.value,
    packaging_cost: 0, // まだ売れていない試算なので梱包費は考えない
    inventory_item_ids: inventoryItemIds,
  })
  if (seq === estimateSeq) estimate.value = result
}
// 入力のたびに150msデバウンス。応答が前後しても最後に投げた要求の結果だけを反映する
function scheduleEstimate() {
  clearTimeout(estimateTimer)
  estimateTimer = setTimeout(runEstimate, 150)
}
watch([estimatePrice, estimateShippingMethodId, estimateItemId], scheduleEstimate)

const estimateProfitRate = computed(() => {
  if (!estimate.value || !estimatePrice.value) return null
  return Math.round((estimate.value.gross_profit / estimatePrice.value) * 100)
})
const estimateCompare = computed(() => {
  const avg = karte.value?.summary.avg_profit
  if (avg == null || !estimate.value) return null
  if (estimate.value.gross_profit === avg) return `過去の平均 ${yen(avg)} と同じ`
  return estimate.value.gross_profit > avg
    ? `過去の平均 ${yen(avg)} より高い`
    : `過去の平均 ${yen(avg)} より低い`
})
</script>

<template>
  <div ref="pageEl" class="page">
    <div class="page-head">
      <h1 class="page-title">商品</h1>
    </div>

    <div class="layout" :class="{ 'm-detail': mobileDetail }">
      <!-- 左：型番の一覧 -->
      <div class="panel list-panel">
        <div class="toolbar">
          <SearchBox v-model="searchText" placeholder="型番・商品名・タグを検索" />
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
            <span class="m-filter-label">最終販売日で絞る</span>
            <PeriodSelect v-model="period" :class="{ 'is-custom': typeof period === 'object' }" />
          </div>
          <select v-model="listSort" class="sort-select">
            <option value="profit">粗利合計</option>
            <option value="sold">売れた数</option>
            <option value="stock">在庫が多い</option>
            <option value="aging">滞留が長い</option>
          </select>
          <span class="grow" />
          <span class="toolbar-count">{{ filteredProducts.length }} 件 ・ 合計 {{ yen(filteredTotalProfit) }}</span>
        </div>

        <Skeleton v-if="!loaded" :rows="6" />
        <div v-else-if="filteredProducts.length" class="prow-list">
          <button
            v-for="p in filteredProducts" :key="p.model_code"
            type="button"
            class="prow" :class="{ selected: karte?.summary.model_code === p.model_code }"
            title="この型番のカルテを開く"
            @click="openKarte(p.model_code)"
          >
            <span class="prow-thumb">
              <img
                v-if="showThumb(p.thumb_url, p.model_code)"
                class="thumb" :src="p.thumb_url!" alt="" loading="lazy"
                @error="onThumbError(p.model_code, p.thumb_url)"
              />
              <span v-else class="thumb-placeholder">{{ placeholderChar(p.model_code, p.name) }}</span>
            </span>
            <span class="prow-body">
              <span class="row-labels">
                <CodeChip kind="model" :code="p.model_code" />
                <Icon v-if="p.note" name="note" :size="12" class="prow-note-icon" title="メモあり" />
                <StatusPill v-if="isStagnant(p)" tone="warn" :label="`滞留 ${agingDays(p)}日`" />
              </span>
              <span class="row-title one-line" :title="p.name">{{ p.name }}</span>
              <span class="row-sub">在庫 {{ p.in_stock }} ・ 売れた {{ p.sold }}</span>
            </span>
            <span class="prow-profit">
              <span class="faint">粗利計</span>
              <strong :class="p.total_profit >= 0 ? 'profit' : 'loss'">{{ yen(p.total_profit) }}</strong>
              <span v-if="p.forecast_profit" class="faint">見込み {{ yen(p.forecast_profit) }}</span>
            </span>
          </button>
        </div>
        <EmptyState
          v-else-if="searchText || period !== 'all'"
          title="検索条件に一致する商品がありません"
        />
        <EmptyState
          v-else
          title="商品がまだありません"
          hint="仕入を登録すると、ここに商品ごとの実績が並びます"
        />
      </div>

      <!-- 右：選んだ型番のカルテ -->
      <div class="karte">
        <!-- スマホ幅だけ：カルテから一覧へ戻る（デスクトップ幅では出さない） -->
        <button type="button" class="m-back" @click="closeKarte">
          <Icon name="arrow-right" :size="16" class="m-back-icon" />商品の一覧
        </button>
        <Skeleton v-if="karteLoading" :rows="6" />

        <template v-else-if="karte">
          <div class="panel karte-head">
            <div class="karte-thumb-col">
              <span class="karte-thumb-wrap">
                <img
                  v-if="showThumb(karte.summary.thumb_url, karte.summary.model_code)"
                  class="thumb thumb-lg" :src="karte.summary.thumb_url!" :key="karte.summary.thumb_url ?? ''" alt=""
                  @error="onThumbError(karte.summary.model_code, karte.summary.thumb_url)"
                />
                <span v-else class="thumb-placeholder thumb-lg">{{ placeholderChar(karte.summary.model_code, karte.summary.name) }}</span>
                <StatusChip
                  v-if="karte.summary.image_manual" tone="neutral" label="固定" class="thumb-manual-chip"
                  title="人がセットした画像（取り込みで上書きしません）"
                />
              </span>
              <div class="karte-thumb-actions">
                <button
                  class="sm ghost" :disabled="imageBusyCode !== null"
                  @click="changeProductImage(karte.summary.model_code)"
                >{{ imageBusyCode === karte.summary.model_code ? '上げています…' : '画像を変える' }}</button>
                <label class="thumb-auto-check">
                  <input
                    type="checkbox" :checked="!karte.summary.image_manual" :disabled="imageBusyCode !== null"
                    @change="onToggleAutoImage(karte.summary.model_code, $event)"
                  />
                  取り込みの画像で自動更新
                </label>
              </div>
            </div>
            <div class="karte-head-text">
              <div
                class="chip-row"
                :title="[karte.summary.model_code, ...karte.summary.tags.map(t => t.name)].join(' ・ ')"
              >
                <CodeChip kind="model" :code="karte.summary.model_code" />
                <StatusChip
                  v-if="karte.summary.custom_name" tone="neutral" label="表示名"
                  title="仕入明細の元の名前とは別に付けた表示名"
                />
                <StatusChip v-for="t in karte.summary.tags" :key="t.id" tone="info" :label="t.name" />
              </div>
              <h2 class="karte-name">{{ karte.summary.name }}</h2>
              <p v-if="headerSourceName" class="faint karte-sub karte-sub-line">{{ headerSourceName }}</p>
              <p v-if="headerMetaParts.length" class="faint karte-sub karte-sub-line">{{ headerMetaParts.join(' ・ ') }}</p>
              <div v-if="karte.summary.note" class="note-row">
                <Icon name="note" :size="14" class="icon-note" />
                <span class="note-label">メモ</span>
                <span class="note-text">{{ karte.summary.note }}</span>
              </div>
            </div>
            <div class="karte-head-actions">
              <button class="sm ghost" @click="openProductTagPicker(karte.summary.model_code, $event)">タグ</button>
              <button class="sm ghost" @click="renameProduct(karte.summary.model_code, karte.summary.custom_name ?? karte.summary.name)">名前</button>
              <button class="sm ghost" @click="editProductNote(karte.summary.model_code, karte.summary.note)">メモ</button>
            </div>
          </div>

          <div class="panel stat-panel">
            <div class="stat-grid">
              <div class="stat-card">
                <span class="stat-card-label">手元の在庫</span>
                <span class="stat-card-value">{{ karte.in_stock.count }}<span class="unit">点</span></span>
                <span class="stat-card-sub">届いている {{ karte.in_stock.arrived }} ・ 未着 {{ karte.in_stock.not_arrived }} ・ 原価計 {{ yen(karte.in_stock.cost) }}</span>
              </div>
              <div class="stat-card">
                <span class="stat-card-label">出品中</span>
                <span class="stat-card-value">{{ karte.listed.count }}</span>
                <span class="stat-card-sub">{{ yen(karte.listed.price_total) }} ・ 見込み粗利 {{ yen(karte.listed.expected_profit) }}</span>
              </div>
              <div class="stat-card">
                <span class="stat-card-label">売れた</span>
                <span class="stat-card-value">{{ karte.sold_recent.count }}</span>
                <span class="stat-card-sub">直近 {{ karte.sold_recent.days }} 日</span>
              </div>
              <div class="stat-card">
                <span class="stat-card-label">平均売価（まるごと換算）</span>
                <span class="stat-card-value">{{ karte.summary.avg_price != null ? yen(karte.summary.avg_price) : '—' }}</span>
                <span class="stat-card-sub">{{ karte.price_range ? `最低 ${yen(karte.price_range.min)} 〜 最高 ${yen(karte.price_range.max)}` : '—' }}</span>
              </div>
              <div class="stat-card">
                <span class="stat-card-label">平均粗利（まるごと換算）</span>
                <span class="stat-card-value" :class="karte.summary.avg_profit != null ? (karte.summary.avg_profit >= 0 ? 'profit' : 'loss') : ''">
                  {{ karte.summary.avg_profit != null ? yen(karte.summary.avg_profit) : '—' }}
                </span>
                <span class="stat-card-sub">{{ karte.profit_rate != null ? `粗利率 ${percent(karte.profit_rate)}` : '—' }}</span>
              </div>
            </div>
          </div>

          <div class="panel">
            <p class="panel-title">この金額で売ったら？</p>
            <div class="calc">
              <div class="calc-in">
                <label class="calc-field">
                  売価
                  <input type="number" inputmode="numeric" v-model.number="estimatePrice" min="0" />
                </label>
                <label class="calc-field">
                  発送
                  <select v-model="estimateShippingMethodId">
                    <option :value="null">未定</option>
                    <option v-for="m in methods" :key="m.id" :value="m.id">{{ m.name }}　{{ yen(m.fee) }}</option>
                  </select>
                </label>
                <label class="calc-field">
                  在庫
                  <select v-model="estimateItemId" :disabled="!karte.items.length">
                    <option v-if="!karte.items.length" :value="null">在庫なし</option>
                    <option v-for="i in karte.items" :key="i.id" :value="i.id">
                      {{ i.item_code }}（原価 {{ yen(i.landed_cost) }}・{{ i.acquired_at }}）
                    </option>
                  </select>
                </label>
              </div>
              <div class="calc-out" v-if="estimate">
                <p class="calc-out-value" :class="estimate.gross_profit >= 0 ? 'profit' : 'loss'">粗利 {{ yen(estimate.gross_profit) }}</p>
                <p class="faint calc-out-sub">
                  {{ yen(estimatePrice) }} − 手数料 {{ yen(estimate.fee) }} − 送料 {{ yen(estimate.shipping_fee) }}
                  <template v-if="estimate.cost > 0"> − 原価 {{ yen(estimate.cost) }}</template>
                  <template v-if="estimateProfitRate != null"> ・ 粗利率 {{ percent(estimateProfitRate) }}</template>
                  <template v-if="estimateCompare"> ・ {{ estimateCompare }}</template>
                </p>
              </div>
            </div>
          </div>

          <div class="panel table-panel">
            <p class="panel-title table-title">
              手元の在庫（{{ karte.in_stock.count }} 点<template v-if="karteListedCount">・うち出品中 {{ karteListedCount }}</template>）
            </p>
            <table v-if="karte.items.length" class="compact item-table">
              <thead>
                <tr>
                  <th>コード</th>
                  <th>仕入</th>
                  <th class="num">原価</th>
                  <th class="num">滞留</th>
                  <th>状態</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="i in karte.items" :key="i.id">
                  <td class="c-code">
                    <CodeChip kind="item" :code="i.item_code" />
                    <span v-if="i.parent_id" class="faint split-hint">分割</span>
                  </td>
                  <td class="faint c-src">{{ i.shop_account_name ?? '—' }} ・ {{ i.acquired_at }}</td>
                  <td class="num c-cost" data-label="原価">{{ yen(i.landed_cost) }}</td>
                  <td class="num c-age" data-label="滞留">{{ i.aging_days }}日</td>
                  <td class="c-state"><StatusPill :tone="itemStatePill(i).tone" :label="itemStatePill(i).label" /></td>
                  <td class="num c-act"><button class="sm ghost" @click="trackItem(i)">追跡</button></td>
                </tr>
              </tbody>
            </table>
            <EmptyState v-else title="手元の在庫がありません" />
          </div>

          <div class="panel table-panel">
            <p class="panel-title table-title">販売の履歴</p>
            <table v-if="karte.sales.length" class="compact sale-table">
              <thead>
                <tr>
                  <th>販売日</th>
                  <th>商品</th>
                  <th class="num">価格</th>
                  <th class="num">送料</th>
                  <th class="num">原価</th>
                  <th class="num">粗利</th>
                  <th>買い手</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in karte.sales" :key="s.id" :class="{ 'needs-input': !s.is_shipping_confirmed }">
                  <td class="faint c-date">{{ s.sold_at }}</td>
                  <td class="sale-title c-title">{{ s.title }}</td>
                  <td class="num c-price" data-label="価格">{{ yen(s.price) }}</td>
                  <td class="num c-ship" data-label="送料">
                    {{ yen(s.shipping_fee) }}
                    <StatusPill v-if="!s.is_shipping_confirmed" tone="warn" label="送料未入力" />
                  </td>
                  <td class="num c-cost" data-label="原価">{{ yen(s.cost) }}</td>
                  <td class="num c-profit" data-label="粗利" :class="s.gross_profit >= 0 ? 'profit' : 'loss'">{{ !isRealized(s) ? '見込み ' : '' }}{{ yen(s.gross_profit) }}</td>
                  <td class="faint c-buyer" data-label="買い手">{{ s.buyer ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
            <EmptyState v-else title="販売の記録がありません" />
            <p v-if="activeListings.length" class="dim listing-note">
              出品中：
              <template v-for="(l, i) in activeListings" :key="l.mercari_item_id">
                <span v-if="i > 0"> ・ </span>{{ l.listed_at }} {{ yen(l.price) }}（{{ l.items.length ? '紐付け済み' : '未紐付け' }}）<span v-if="l.likes != null"> ・いいね {{ l.likes }}</span>
              </template>
            </p>
          </div>
        </template>

        <EmptyState v-else title="型番を選ぶとここにカルテが出ます" />
      </div>
    </div>

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
.layout {
  display: grid;
  grid-template-columns: 380px 1fr;
  gap: 16px;
  align-items: start;
}

/* --- 左：一覧 --- */

.list-panel { display: flex; flex-direction: column; gap: 10px; }

.prow-list { display: flex; flex-direction: column; }
.prow {
  display: grid;
  grid-template-columns: 44px 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 10px 8px;
  height: auto;
  min-height: 60px;
  border: none;
  border-top: 1px solid var(--line-soft);
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.prow:first-child { border-top: none; }
.prow:hover { background: var(--surface-hi); }
.prow.selected { background: var(--brand-soft); }

.prow-thumb .thumb, .prow-thumb .thumb-placeholder {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-sm);
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

.prow-body { min-width: 0; display: flex; flex-direction: column; }
.prow-body .row-title { font-size: var(--fs-13); }
.prow-note-icon { flex-shrink: 0; color: var(--text-faint); }

.prow-profit { text-align: right; font-size: var(--fs-12); color: var(--text-dim); display: flex; flex-direction: column; gap: 2px; }
.prow-profit strong { font-size: var(--fs-14); }

/* --- 右：カルテ --- */

.karte { display: flex; flex-direction: column; gap: 16px; }
.karte-head { display: flex; align-items: flex-start; gap: 16px; }
.thumb-lg.thumb, .thumb-lg.thumb-placeholder { width: 56px; height: 56px; font-size: var(--fs-16); flex-shrink: 0; }
.karte-thumb-col { display: flex; flex-direction: column; align-items: center; gap: 6px; flex-shrink: 0; }
.karte-thumb-wrap { position: relative; display: block; }
.thumb-manual-chip {
  position: absolute;
  bottom: -6px;
  right: -6px;
  padding: 1px 6px;
  font-size: 10px;
}
.karte-thumb-actions { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.thumb-auto-check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-11);
  color: var(--text-dim);
  white-space: nowrap;
  cursor: pointer;
}
.thumb-auto-check input { margin: 0; }
.karte-head-text { min-width: 0; flex: 1; }
.karte-name { margin: 4px 0 0; font-size: var(--fs-20); font-weight: 700; }
.karte-sub { margin: 4px 0 0; font-size: var(--fs-12); }
.karte-sub-line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.karte-head-actions { display: flex; gap: 6px; flex-shrink: 0; }

.stat-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 16px;
}

.calc { display: flex; flex-direction: column; gap: 12px; }
.calc-in { display: flex; gap: 16px; flex-wrap: wrap; }
.calc-field { display: flex; align-items: center; gap: 8px; font-size: var(--fs-13); }
.calc-field input[type="number"] { width: 110px; font-weight: 700; }
.calc-out { background: var(--profit-bg); border-radius: var(--radius-md); padding: 10px 14px; }
.calc-out-value { margin: 0; font-size: var(--fs-20); font-weight: 800; }
.calc-out-sub { margin: 4px 0 0; }

.table-title { padding: 16px 20px 0; margin: 0 0 8px; }
.split-hint { margin-left: 6px; }
.sale-title { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.listing-note { padding: 4px 20px 16px; margin: 0; font-size: var(--fs-12); }

/* --- スマホ幅だけで出すもの。デスクトップ幅では出さない（絞り込みの入れ物は無いのと同じ） --- */
.m-back, .m-filter-toggle, .m-filter-label { display: none; }
.toolbar-filters { display: contents; }

@media (max-width: 1099px) {
  .layout { grid-template-columns: 1fr; }
  .stat-grid { grid-template-columns: repeat(2, 1fr); }
  .table-panel { overflow-x: auto; }
  .prow-list { max-height: 320px; overflow-y: auto; }
}

/* ============================================================
   スマホ幅（768px 未満）：一覧とカルテを入れ替えて出す（一覧 → 行を押す → カルテ → 「商品の一覧」で戻る）。
   一覧は 1 型番 1 枚のカード（style.css の 4 段：ラベル → 名前 → 補助 → 粗利）。
   カルテの表（手元の在庫・販売の履歴）は、列を縦に積んだ行にする。
   デスクトップ幅（768px 以上）の見た目には一切効かせない。
   ============================================================ */
@media (max-width: 767px) {
  .layout { gap: 12px; }
  .layout:not(.m-detail) .karte { display: none; }
  .layout.m-detail .list-panel { display: none; }

  /* --- 一覧 --- */
  .list-panel { padding: 0; background: transparent; box-shadow: none; border-radius: 0; gap: 8px; }

  /* ツールバー：検索 →（絞り込み）→ 並び替え → 件数・合計（売上タブと同じ形） */
  .toolbar { gap: 8px; margin-bottom: 0; }
  .toolbar :deep(.search-box) { flex: 1 1 160px; width: auto; min-width: 0; }
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
  .toolbar-filters.m-open { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .toolbar-filters .m-filter-label { display: block; grid-column: 1 / -1; font-size: var(--fs-12); color: var(--text-dim); }
  .toolbar-filters .period-select { display: flex; width: 100%; grid-column: 1 / -1; }
  .toolbar-filters .period-select :deep(select) { flex: 1 1 100%; min-width: 0; width: 100%; height: 44px; }
  .toolbar-filters .period-select :deep(input) { flex: 1 1 120px; min-width: 0; height: 44px; }
  .toolbar .sort-select { order: 2; flex: 1 1 140px; min-width: 0; height: 44px; }
  .toolbar .grow { display: none; }
  .toolbar .toolbar-count { order: 3; flex: 0 0 auto; margin-left: auto; text-align: right; }

  /* 行＝カード */
  .prow-list { gap: 10px; max-height: none; overflow: visible; }
  .prow {
    grid-template-columns: 48px minmax(0, 1fr);
    grid-template-areas:
      "thumb body"
      "profit profit";
    align-items: start;
    gap: 8px 12px;
    padding: 12px;
    min-height: 0;
    background: var(--surface);
    border-radius: var(--radius);
    box-shadow: var(--shadow-1);
  }
  .prow:first-child { border-top: none; }
  .prow:hover { background: var(--surface); }
  /* 最後に見た型番：塗りつぶすとサムネイル（同じクリーム色）が消えるので、黄の枠で示す */
  .prow.selected,
  .prow.selected:hover { background: var(--surface); box-shadow: inset 0 0 0 2px var(--brand), var(--shadow-1); }
  .prow-thumb { grid-area: thumb; }
  .prow-thumb .thumb, .prow-thumb .thumb-placeholder { width: 48px; height: 48px; }
  .prow-body { grid-area: body; }
  .prow-body .row-labels { min-height: 0; }
  /* 名前は 2 行まで（ホバーの title は読めないので、切れにくくする） */
  .prow-body .row-title.one-line { -webkit-line-clamp: 2; min-height: 0; font-size: var(--fs-14); }
  .prow-profit {
    grid-area: profit;
    flex-direction: row;
    align-items: baseline;
    gap: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--line-soft);
    text-align: left;
    font-size: var(--fs-13);
  }
  .prow-profit strong { font-size: var(--fs-16); }
  .prow-profit .faint:last-child { margin-left: auto; }

  /* --- カルテ --- */
  .karte { gap: 12px; }
  .m-back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    min-height: 44px;
    padding: 0 16px 0 12px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--text-dim);
  }
  .m-back-icon { transform: scaleX(-1); }

  /* 見出し：写真と名前を並べ、画像の操作・タグ/名前/メモは下に 44px の押せる行で */
  .karte-head {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr);
    grid-template-areas:
      "thumb text"
      "tact  tact"
      "hact  hact";
    gap: 10px 12px;
    align-items: start;
  }
  .karte-thumb-col { display: contents; }
  .karte-thumb-wrap { grid-area: thumb; }
  .karte-head-text { grid-area: text; }
  .karte-name { font-size: var(--fs-16); overflow-wrap: anywhere; }
  .karte-sub-line { white-space: normal; overflow: visible; overflow-wrap: anywhere; }
  .karte-thumb-actions {
    grid-area: tact;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-start;
    gap: 4px 12px;
  }
  .karte-thumb-actions button { height: 44px; border-color: var(--line); }
  .thumb-auto-check { min-height: 44px; font-size: var(--fs-13); white-space: normal; }
  .karte-head-actions { grid-area: hact; gap: 8px; }
  .karte-head-actions button { flex: 1 1 0; height: 44px; border-color: var(--line); }

  /* 数字のカード：パネルをやめて、小さなカードを 2 列に。最初の「手元の在庫」だけ全幅 */
  .stat-panel { padding: 0; background: transparent; box-shadow: none; border-radius: 0; }
  .stat-grid { grid-template-columns: 1fr 1fr; gap: 8px; }
  .stat-grid .stat-card { padding: 12px 14px; gap: 4px; min-width: 0; }
  .stat-grid .stat-card:first-child { grid-column: 1 / -1; }
  .stat-grid .stat-card-value { font-size: var(--fs-20); }
  .stat-grid .stat-card:first-child .stat-card-value { font-size: var(--fs-28); }
  .stat-grid .stat-card-sub { overflow-wrap: anywhere; }

  /* 「この金額で売ったら？」：1 列。入力は 44px */
  .calc-in { flex-direction: column; gap: 10px; }
  .calc-field { flex-direction: column; align-items: stretch; gap: 4px; font-size: var(--fs-12); color: var(--text-dim); }
  .calc-field input[type="number"], .calc-field select { width: 100%; min-width: 0; height: 44px; }
  .calc-out-sub { overflow-wrap: anywhere; }

  /* 表（手元の在庫・販売の履歴）：列を縦に積んだ行にする。行ごとの区切りは細い罫 */
  .table-panel { overflow: visible; }
  .table-title { padding: 0; margin: 0 0 6px; }
  .listing-note { padding: 8px 0 0; overflow-wrap: anywhere; }
  .item-table, .item-table tbody, .item-table tr, .item-table td,
  .sale-table, .sale-table tbody, .sale-table tr, .sale-table td { display: block; }
  .item-table thead, .sale-table thead { display: none; }
  .item-table tr, .sale-table tr {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    padding: 12px 0;
    border-top: 1px solid var(--line-soft);
  }
  .item-table tbody tr:first-child, .sale-table tbody tr:first-child { border-top: 0; }
  .item-table tbody tr:hover, .sale-table tbody tr:hover { background: transparent; }
  .item-table td, .sale-table td { padding: 0; border: 0; min-width: 0; }
  .item-table td.num, .sale-table td.num { text-align: left; }
  .item-table td[data-label]::before,
  .sale-table td[data-label]::before {
    content: attr(data-label);
    display: block;
    font-size: var(--fs-11);
    line-height: 1.4;
    color: var(--text-faint);
  }

  /* 手元の在庫：状態（と「追跡」）→ コード → 仕入 → 原価・滞留（見出しは値の左に小さく） */
  .item-table .c-state { order: 1; flex: 1 1 auto; }
  .item-table .c-act { order: 2; flex: 0 0 auto; }
  .item-table .c-act button { height: 44px; min-width: 64px; border-color: var(--line); }
  .item-table .c-code { order: 3; flex: 1 1 100%; }
  .item-table .c-src { order: 4; flex: 1 1 100%; font-size: var(--fs-13); overflow-wrap: anywhere; }
  .item-table .c-cost,
  .item-table .c-age { order: 5; flex: 0 0 auto; }
  .item-table td.c-cost[data-label]::before,
  .item-table td.c-age[data-label]::before { display: inline; margin-right: 6px; font-size: var(--fs-12); }

  /* 販売の履歴：商品名 → 日付・買い手 → 価格・送料 → 原価・粗利（送料未入力は橙の左帯） */
  .sale-table tbody tr {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 4px 8px;
    align-items: start;
  }
  .sale-table tr.needs-input { padding-left: 10px; box-shadow: inset 3px 0 0 var(--warn); }
  .sale-table .c-title { grid-column: 1 / -1; grid-row: 1; max-width: none; white-space: normal; overflow: visible; font-weight: 600; overflow-wrap: anywhere; }
  .sale-table .c-date { grid-column: 1 / 3; grid-row: 2; font-size: var(--fs-13); }
  .sale-table .c-buyer { grid-column: 3 / -1; grid-row: 2; font-size: var(--fs-13); overflow-wrap: anywhere; }
  .sale-table td.c-buyer[data-label]::before { display: inline; margin-right: 4px; font-size: inherit; color: inherit; }
  .sale-table .c-price { grid-column: 1 / 3; grid-row: 3; }
  .sale-table .c-ship { grid-column: 3 / -1; grid-row: 3; }
  .sale-table .c-cost { grid-column: 1 / 3; grid-row: 4; }
  .sale-table .c-profit { grid-column: 3 / -1; grid-row: 4; font-weight: 700; }
}
</style>
