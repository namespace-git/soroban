<script setup lang="ts">
// 在庫の引き当て／紐付け。出品（mode='listing'）と販売（mode='sale'）の両方から使う。
// チェックした瞬間に下端の原価合計・粗利プレビューが動く。確定は「引き当てる／紐付ける」ボタンで初めて起きる。
import { ref, computed, watch, inject } from 'vue'
import type { Listing, InventoryItem, ListingStatus, SaleProfit } from '../../shared/types'
import Drawer from './Drawer.vue'
import StatusChip from './StatusChip.vue'
import CodeChip from './CodeChip.vue'
import EmptyState from './EmptyState.vue'
import Icon from './Icon.vue'
import { matchesSearch } from './SearchBox.vue'
import type { ConfirmChoice } from './ConfirmDialog.vue'

type MatchedRow = { id: string; item_code: string; name: string; model_code?: string | null; product_name?: string | null; landed_cost: number; aging_days?: number }
type ProfitEstimate = { fee: number; shipping_fee: number; packaging_cost: number; cost: number; gross_profit: number }

const props = defineProps<{
  open: boolean
  mode: 'listing' | 'sale'
  listing?: Listing | null
  sale?: SaleProfit | null
}>()
const emit = defineEmits<{ close: []; changed: [] }>()

const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!
const choose = inject<(title: string, choices: ConfirmChoice[], opts?: { message?: string }) => Promise<string | null>>('choose')!

const candidates = ref<InventoryItem[]>([])
const matchedItems = ref<MatchedRow[]>([])
const picked = ref<Set<string>>(new Set())
const search = ref('')
const loading = ref(false)
// メンテ用：販売済み（他の販売に紐付いた）在庫も候補に出す。ドロワーを開き直すたびに off に戻す
const includeSold = ref(false)

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

const STATUS_LABEL: Record<ListingStatus, string> = {
  active: '出品中', suspended: '公開停止中', sold: '売れた', ended: '取り下げ',
}
const STATUS_TONE: Record<ListingStatus, 'brand' | 'neutral' | 'ok' | 'info'> = {
  active: 'info', suspended: 'neutral', sold: 'ok', ended: 'neutral',
}

const title = computed(() => (props.mode === 'listing' ? props.listing?.title : props.sale?.title) ?? '')
const price = computed(() => (props.mode === 'listing' ? props.listing?.price : props.sale?.price) ?? 0)

async function load() {
  loading.value = true
  if (props.mode === 'listing') {
    const l = props.listing
    if (!l) { candidates.value = []; matchedItems.value = []; loading.value = false; return }
    const sugg = await window.soroban.suggestForListing(l.mercari_item_id, 50, { includeSold: includeSold.value })
    candidates.value = sugg
    matchedItems.value = l.items.map(it => ({ id: it.id, item_code: it.item_code, name: it.name, model_code: it.model_code, product_name: it.product_name, landed_cost: it.landed_cost }))
  } else {
    const s = props.sale
    if (!s) { candidates.value = []; matchedItems.value = []; loading.value = false; return }
    const [linked, sugg] = await Promise.all([
      window.soroban.listSaleLines(s.id),
      window.soroban.suggestInventory(s.id, 50, { includeSold: includeSold.value }),
    ])
    matchedItems.value = linked
    candidates.value = sugg
  }
  loading.value = false
}

watch(
  () => [props.open, props.mode, props.listing?.mercari_item_id, props.sale?.id],
  ([isOpen]) => {
    picked.value = new Set()
    search.value = ''
    includeSold.value = false
    if (isOpen) load()
  },
  { immediate: true },
)

watch(includeSold, () => {
  if (props.open) load()
})

const filtered = computed(() => {
  if (!search.value.trim()) return candidates.value
  return candidates.value.filter(c => matchesSearch([c.name, c.product_name, c.model_code, c.item_code], search.value))
})

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
  if (props.mode === 'sale') return '紐付ける'
  return movingCount.value > 0 ? `引き当てる（${movingCount.value}点を移す）` : '引き当てる'
})

const profitLabel = computed(() => {
  if (props.mode !== 'listing') return '粗利'
  return props.listing?.shipping_method_id ? '見込み粗利（送料込み・梱包前）' : '見込み粗利（送料・梱包前）'
})

// チェックが変わるたびに main へ見積もりを頼む（手数料・送料は画面で計算しない）。
// 150ms デバウンスし、応答が前後しても最後に投げた要求の結果だけを反映する
const estimate = ref<ProfitEstimate | null>(null)
let estimateTimer: ReturnType<typeof setTimeout> | undefined
let estimateSeq = 0

async function runEstimate() {
  const seq = ++estimateSeq
  const inventoryItemIds = [...matchedItems.value.map(m => m.id), ...picked.value]
  let priceVal: number
  let shippingMethodId: string | null
  let packagingCost: number | undefined
  if (props.mode === 'listing') {
    if (!props.listing) { estimate.value = null; return }
    priceVal = props.listing.price
    shippingMethodId = props.listing.shipping_method_id
    packagingCost = 0 // 出品はまだ梱包費が無い（見込み粗利は送料込み・梱包前）
  } else {
    if (!props.sale) { estimate.value = null; return }
    priceVal = props.sale.price
    shippingMethodId = props.sale.shipping_method_id
    packagingCost = props.sale.packaging_cost
  }
  const result = await window.soroban.estimateSaleProfit({
    price: priceVal,
    shipping_method_id: shippingMethodId,
    packaging_cost: packagingCost,
    inventory_item_ids: inventoryItemIds,
  })
  if (seq === estimateSeq) estimate.value = result
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

function truncate(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) + '…' : text
}
function soldDate(d: string): string {
  const [, m, day] = d.split('-')
  return m && day ? `${m}/${day}` : d
}
function soldToLabel(sold: { title: string; price: number }): string {
  return `販売「${truncate(sold.title, 12)}」${yen(sold.price)} に紐付け済み`
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
      return `${c.item_code}「${truncate(c.product_name ?? c.name, 12)}」は販売「${truncate(s.title, 12)}」（${yen(s.price)}・${soldDate(s.sold_at)}）に紐付いています。`
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
  try {
    if (props.mode === 'listing' && props.listing) {
      const moved = candidates.value.filter(c => ids.includes(c.id) && c.listing).length
      await window.soroban.reserveInventory(props.listing.mercari_item_id, ids, opts)
      picked.value = new Set()
      emit('changed')
      await load()
      toast(
        moved > 0
          ? `${ids.length}点を引き当てました（${moved}点は別の出品から移しました）`
          : `${ids.length}点を引き当てました`,
        'ok',
      )
    } else if (props.mode === 'sale' && props.sale) {
      await window.soroban.linkInventory(props.sale.id, ids, opts)
      picked.value = new Set()
      emit('changed')
      emit('close')
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
      <div v-if="mode === 'listing' && listing" class="head-sub">
        <img
          v-if="listing.thumb_url && !thumbFailed"
          class="thumb" :src="listing.thumb_url" alt=""
          @error="thumbFailed = true"
        />
        <span v-else class="thumb-placeholder">{{ placeholderChar() }}</span>
        <span class="faint">出品価格 {{ yen(listing.price) }}</span>
        <span v-if="listing.shipping_method_name" class="faint">{{ listing.shipping_method_name }}</span>
        <StatusChip :tone="STATUS_TONE[listing.status]" :label="STATUS_LABEL[listing.status]" />
      </div>
      <span v-else-if="mode === 'sale'" class="faint">販売 {{ yen(price) }}</span>
    </template>

    <div v-if="matchedItems.length" class="matched-block">
      <p class="panel-title">{{ mode === 'listing' ? '引き当て済み' : '紐付け済み' }}</p>
      <div v-for="m in matchedItems" :key="m.id" class="item matched-item">
        <CodeChip kind="item" :code="m.item_code" />
        <StatusChip v-if="m.model_code" tone="neutral" :label="m.model_code" />
        <span class="grow name-cell">
          <span class="name-main" :title="m.product_name ?? m.name">{{ m.product_name ?? m.name }}</span>
          <span class="name-sub" :title="m.product_name ? m.name : ''">{{ m.product_name ? m.name : '' }}</span>
        </span>
        <span v-if="m.aging_days != null" class="faint nowrap">{{ m.aging_days }}日</span>
        <span class="num">{{ yen(m.landed_cost) }}</span>
        <button class="sm ghost" @click="unlink(m.id)">解除</button>
      </div>
    </div>

    <p v-if="!canReserve" class="dim ended-note">この出品は終了しています（引き当てできません）</p>

    <template v-else>
      <label class="search-field">
        <Icon name="search" :size="16" />
        <input v-model="search" placeholder="在庫を検索" />
      </label>

      <div class="candidates">
        <label
          v-for="c in filtered" :key="c.id"
          class="item" :class="{ on: picked.has(c.id), sold: !!c.sold_to }"
        >
          <input
            type="checkbox"
            :checked="picked.has(c.id)"
            @change="toggle(c.id)"
          />
          <CodeChip kind="item" :code="c.item_code" />
          <StatusChip v-if="c.model_code" tone="neutral" :label="c.model_code" />
          <StatusChip
            v-if="mode === 'listing' && c.listing && c.listing.mercari_item_id !== listing?.mercari_item_id"
            tone="neutral"
            :label="`出品 ${yen(c.listing.price)} に引き当て済み`"
          />
          <StatusChip v-if="c.sold_to" tone="warn" :label="soldToLabel(c.sold_to)" />
          <span class="grow name-cell">
            <span class="name-main" :title="c.product_name ?? c.name">{{ c.product_name ?? c.name }}</span>
            <span class="name-sub" :title="c.product_name ? c.name : ''">{{ c.product_name ? c.name : '' }}</span>
          </span>
          <span class="faint nowrap">{{ c.aging_days }}日</span>
          <span class="num">{{ yen(c.landed_cost) }}</span>
        </label>
        <EmptyState v-if="!loading && !filtered.length" title="候補になる在庫がありません" />
      </div>

      <label class="faint maint-toggle">
        <input type="checkbox" v-model="includeSold" />
        販売済みの在庫も表示（付け替え）
      </label>
    </template>

    <template #footer>
      <div class="match-footer">
        <div class="calc">
          <span class="faint">{{ totalCount }}点</span>
          <span class="num">原価 {{ yen(totalCost) }}</span>
          <strong class="num" :class="previewProfit >= 0 ? 'profit' : 'loss'">
            {{ profitLabel }} {{ yen(previewProfit) }}
          </strong>
        </div>
        <button v-if="canReserve" class="primary" :disabled="!picked.size" @click="confirmPick">
          {{ confirmLabel }}
        </button>
      </div>
    </template>
  </Drawer>
</template>

<style scoped>
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

.ended-note { padding: 6px 8px; }

.candidates { display: flex; flex-direction: column; gap: 2px; }

.item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  line-height: 1.3;
}
.item:hover { background: var(--surface-hi); }
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

.match-footer { display: flex; align-items: center; gap: 16px; }
.calc { flex: 1; display: flex; gap: 14px; align-items: baseline; font-size: var(--fs-13); }
</style>
