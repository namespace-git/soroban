<script setup lang="ts">
import { isRealized } from '../../shared/recognition'
import { ref, computed, onMounted, watch, inject, type Ref } from 'vue'
import type { ProductSummary, ProductKarte, InventoryItem, ShippingMethod, Tag } from '../../shared/types'
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

const revision = inject<Ref<number>>('revision')!
// ダッシュボードの型番ランキングから goto('products', { modelCode }) で開かれたときに読む
const gotoPayload = inject<Ref<{ modelCode?: string } | null>>('gotoPayload', ref(null))
const goto = inject<(t: string, payload?: { search?: string; focusId?: string }) => void>('goto')!
const ask = inject<(title: string, opts?: PromptOptions) => Promise<string | null>>('prompt')!
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

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

/** 選んでいる型番はそのままに、数字だけ更新する（データ更新後の再読み込み用。試算の入力は消さない） */
async function refreshKarte() {
  if (!karte.value) return
  karte.value = await window.soroban.getProductKarte(karte.value.summary.model_code)
}

onMounted(async () => {
  await Promise.all([load(), loadSettings(), loadTags(), loadMethods()])
  if (gotoPayload.value?.modelCode) {
    await selectProduct(gotoPayload.value.modelCode)
    gotoPayload.value = null
  } else if (filteredProducts.value.length) {
    await selectProduct(filteredProducts.value[0].model_code)
  }
})

watch(gotoPayload, async (p) => {
  if (p?.modelCode) {
    await selectProduct(p.modelCode)
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
}
async function onProductTagCreate(name: string) {
  if (!tagPickerModelCode.value) return
  const newTagId = await window.soroban.createTag(name)
  await loadTags()
  await window.soroban.setProductTags(tagPickerModelCode.value, [...tagPickerSelected.value, newTagId])
  await load()
  if (karte.value?.summary.model_code === tagPickerModelCode.value) await refreshKarte()
}

// --- 表示名：仕入明細・在庫の元の名前とは別に、商品タブでの見た目だけ変える ---

async function renameProduct(modelCode: string, currentName: string | null): Promise<void> {
  const input = await ask('商品名（表示名）', { initial: currentName ?? '', placeholder: '空にすると元の名前に戻ります' })
  if (input === null) return
  await window.soroban.setProductName(modelCode, input.trim() || null)
  await load()
  if (karte.value?.summary.model_code === modelCode) await refreshKarte()
}

// --- 商品画像：人がセット（取り込みで上書きしない）／取り込みの自動更新に戻す ---

async function changeProductImage(modelCode: string) {
  const ok = await window.soroban.setProductImage(modelCode)
  if (!ok) return
  await load()
  if (karte.value?.summary.model_code === modelCode) await refreshKarte()
  toast('画像をセットしました（取り込みで上書きしません）', 'ok')
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
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">商品</h1>
    </div>

    <div class="layout">
      <!-- 左：型番の一覧 -->
      <div class="panel list-panel">
        <div class="toolbar">
          <SearchBox v-model="searchText" placeholder="型番・商品名・タグを検索" />
          <PeriodSelect v-model="period" />
          <select v-model="listSort">
            <option value="profit">粗利合計</option>
            <option value="sold">売れた数</option>
            <option value="stock">在庫が多い</option>
            <option value="aging">滞留が長い</option>
          </select>
          <span class="grow" />
          <span class="toolbar-count">{{ filteredProducts.length }} 件</span>
        </div>

        <Skeleton v-if="!loaded" :rows="6" />
        <div v-else-if="filteredProducts.length" class="prow-list">
          <button
            v-for="p in filteredProducts" :key="p.model_code"
            type="button"
            class="prow" :class="{ selected: karte?.summary.model_code === p.model_code }"
            @click="selectProduct(p.model_code)"
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
          title="型番付きの在庫がありません"
          hint="仕入を登録すると、ここに商品ごとの実績が並びます"
        />
      </div>

      <!-- 右：選んだ型番のカルテ -->
      <div class="karte">
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
                <button class="sm ghost" @click="changeProductImage(karte.summary.model_code)">画像を変える</button>
                <label class="thumb-auto-check">
                  <input
                    type="checkbox" :checked="!karte.summary.image_manual"
                    @change="onToggleAutoImage(karte.summary.model_code, $event)"
                  />
                  取り込みの画像で自動更新
                </label>
              </div>
            </div>
            <div class="karte-head-text">
              <div class="chip-row">
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
            </div>
            <div class="karte-head-actions">
              <button class="sm ghost" @click="openProductTagPicker(karte.summary.model_code, $event)">タグ</button>
              <button class="sm ghost" @click="renameProduct(karte.summary.model_code, karte.summary.custom_name ?? karte.summary.name)">名前</button>
            </div>
          </div>

          <div class="panel">
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
                <span class="stat-card-sub">{{ karte.profit_rate != null ? `粗利率 ${karte.profit_rate}%` : '—' }}</span>
              </div>
            </div>
          </div>

          <div class="panel">
            <p class="panel-title">この金額で売ったら？</p>
            <div class="calc">
              <div class="calc-in">
                <label class="calc-field">
                  売価
                  <input type="number" v-model.number="estimatePrice" min="0" />
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
                  <template v-if="estimateProfitRate != null"> ・ 粗利率 {{ estimateProfitRate }}%</template>
                  <template v-if="estimateCompare"> ・ {{ estimateCompare }}</template>
                </p>
              </div>
            </div>
          </div>

          <div class="panel table-panel">
            <p class="panel-title table-title">
              手元の在庫（{{ karte.in_stock.count }} 点<template v-if="karteListedCount">・うち出品中 {{ karteListedCount }}</template>）
            </p>
            <table v-if="karte.items.length" class="compact">
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
                  <td>
                    <CodeChip kind="item" :code="i.item_code" />
                    <span v-if="i.parent_id" class="faint split-hint">分割</span>
                  </td>
                  <td class="faint">{{ i.shop_account_name ?? '—' }} ・ {{ i.acquired_at }}</td>
                  <td class="num">{{ yen(i.landed_cost) }}</td>
                  <td class="num">{{ i.aging_days }}日</td>
                  <td><StatusPill :tone="itemStatePill(i).tone" :label="itemStatePill(i).label" /></td>
                  <td class="num"><button class="sm ghost" @click="trackItem(i)">追跡</button></td>
                </tr>
              </tbody>
            </table>
            <EmptyState v-else title="手元の在庫がありません" />
          </div>

          <div class="panel table-panel">
            <p class="panel-title table-title">販売の履歴</p>
            <table v-if="karte.sales.length" class="compact">
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
                <tr v-for="s in karte.sales" :key="s.id">
                  <td class="faint">{{ s.sold_at }}</td>
                  <td class="sale-title">{{ s.title }}</td>
                  <td class="num">{{ yen(s.price) }}</td>
                  <td class="num">
                    {{ yen(s.shipping_fee) }}
                    <StatusPill v-if="!s.is_shipping_confirmed" tone="warn" label="送料未入力" />
                  </td>
                  <td class="num">{{ yen(s.cost) }}</td>
                  <td class="num" :class="s.gross_profit >= 0 ? 'profit' : 'loss'">{{ !isRealized(s) ? '見込み ' : '' }}{{ yen(s.gross_profit) }}</td>
                  <td class="faint">{{ s.buyer ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
            <EmptyState v-else title="販売の記録がありません" />
            <p v-if="activeListings.length" class="dim listing-note">
              出品中：
              <template v-for="(l, i) in activeListings" :key="l.mercari_item_id">
                <span v-if="i > 0"> ・ </span>{{ l.listed_at }} {{ yen(l.price) }}（{{ l.items.length ? '引き当て済み' : '未引き当て' }}）<span v-if="l.likes != null"> ・いいね {{ l.likes }}</span>
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

@media (max-width: 1099px) {
  .layout { grid-template-columns: 1fr; }
  .stat-grid { grid-template-columns: repeat(2, 1fr); }
  .table-panel { overflow-x: auto; }
  .prow-list { max-height: 320px; overflow-y: auto; }
}
</style>
