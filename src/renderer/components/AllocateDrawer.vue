<script setup lang="ts">
// 在庫の引き当て／紐付け。出品（mode='listing'）と販売（mode='sale'）の両方から使う。
// チェックした瞬間に下端の原価合計・粗利プレビューが動く。確定は「引き当てる／紐付ける」ボタンで初めて起きる。
import { ref, computed, watch, inject } from 'vue'
import type { Listing, InventoryItem, ListingStatus, SaleProfit } from '../../shared/types'
import Drawer from './Drawer.vue'
import StatusChip from './StatusChip.vue'
import EmptyState from './EmptyState.vue'
import Icon from './Icon.vue'
import { matchesSearch } from './SearchBox.vue'

type MatchedRow = { id: string; name: string; model_code?: string | null; landed_cost: number; aging_days?: number }

const props = defineProps<{
  open: boolean
  mode: 'listing' | 'sale'
  listing?: Listing | null
  sale?: SaleProfit | null
}>()
const emit = defineEmits<{ close: []; changed: [] }>()

const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!

const candidates = ref<InventoryItem[]>([])
const matchedItems = ref<MatchedRow[]>([])
const picked = ref<Set<string>>(new Set())
const search = ref('')
const feeRateBp = ref(1000)
const loading = ref(false)

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

const STATUS_LABEL: Record<ListingStatus, string> = {
  active: '出品中', suspended: '公開停止中', sold: '売れた', ended: '取り下げ',
}
const STATUS_TONE: Record<ListingStatus, 'brand' | 'neutral' | 'ok' | 'info'> = {
  active: 'info', suspended: 'neutral', sold: 'ok', ended: 'neutral',
}

const title = computed(() => (props.mode === 'listing' ? props.listing?.title : props.sale?.title) ?? '')
const price = computed(() => (props.mode === 'listing' ? props.listing?.price : props.sale?.price) ?? 0)

// 実際の手数料計算（src/main/money.ts の calcFee と同じ：切り捨て）。
// 出品はまだ手数料が確定していないため、ここは「チェックした瞬間の見込み粗利プレビュー」のための例外的な再計算。
function calcFee(p: number, rateBp: number): number {
  return Math.floor((p * rateBp) / 10000)
}

async function load() {
  loading.value = true
  if (props.mode === 'listing') {
    const l = props.listing
    if (!l) { candidates.value = []; matchedItems.value = []; loading.value = false; return }
    const [sugg, settings] = await Promise.all([
      window.soroban.suggestForListing(l.mercari_item_id, 50),
      window.soroban.getSettings(),
    ])
    candidates.value = sugg
    feeRateBp.value = Number(settings.fee_rate_bp ?? 1000)
    matchedItems.value = l.items.map(it => ({ id: it.id, name: it.name, model_code: it.model_code, landed_cost: it.landed_cost }))
  } else {
    const s = props.sale
    if (!s) { candidates.value = []; matchedItems.value = []; loading.value = false; return }
    const [linked, sugg] = await Promise.all([
      window.soroban.listSaleLines(s.id),
      window.soroban.suggestInventory(s.id, 50),
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
    if (isOpen) load()
  },
  { immediate: true },
)

const filtered = computed(() => {
  if (!search.value.trim()) return candidates.value
  return candidates.value.filter(c => matchesSearch([c.name, c.model_code], search.value))
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

const profitLabel = computed(() => (props.mode === 'listing' ? '見込み粗利（送料・梱包前）' : '粗利'))

const previewProfit = computed(() => {
  if (props.mode === 'listing') {
    if (!props.listing) return 0
    const fee = calcFee(props.listing.price, feeRateBp.value)
    return props.listing.price - fee - totalCost.value
  }
  if (!props.sale) return 0
  return props.sale.price - props.sale.fee - props.sale.shipping_fee - props.sale.packaging_cost - totalCost.value
})

async function confirmPick() {
  if (picked.value.size === 0) return
  const ids = [...picked.value]
  try {
    if (props.mode === 'listing' && props.listing) {
      const moved = candidates.value.filter(c => ids.includes(c.id) && c.listing).length
      await window.soroban.reserveInventory(props.listing.mercari_item_id, ids)
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
      await window.soroban.linkInventory(props.sale.id, ids)
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
        <StatusChip :tone="STATUS_TONE[listing.status]" :label="STATUS_LABEL[listing.status]" />
      </div>
      <span v-else-if="mode === 'sale'" class="faint">販売 {{ yen(price) }}</span>
    </template>

    <div v-if="matchedItems.length" class="matched-block">
      <p class="panel-title">{{ mode === 'listing' ? '引き当て済み' : '紐付け済み' }}</p>
      <div v-for="m in matchedItems" :key="m.id" class="item matched-item">
        <StatusChip v-if="m.model_code" tone="neutral" :label="m.model_code" />
        <span class="grow">{{ m.name }}</span>
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
          class="item" :class="{ on: picked.has(c.id) }"
        >
          <input
            type="checkbox"
            :checked="picked.has(c.id)"
            @change="toggle(c.id)"
          />
          <StatusChip v-if="c.model_code" tone="neutral" :label="c.model_code" />
          <StatusChip
            v-if="mode === 'listing' && c.listing && c.listing.mercari_item_id !== listing?.mercari_item_id"
            tone="neutral"
            :label="`出品 ${yen(c.listing.price)} に引き当て済み`"
          />
          <span class="grow">{{ c.name }}</span>
          <span class="faint nowrap">{{ c.aging_days }}日</span>
          <span class="num">{{ yen(c.landed_cost) }}</span>
        </label>
        <EmptyState v-if="!loading && !filtered.length" title="候補になる在庫がありません" />
      </div>
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
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  line-height: 1.3;
}
.item:hover { background: var(--surface-hi); }
.item.on { background: var(--accent-soft); }
.matched-item { cursor: default; }

.item input[type="checkbox"] {
  width: 14px;
  height: 14px;
  padding: 0;
  flex-shrink: 0;
}

.match-footer { display: flex; align-items: center; gap: 16px; }
.calc { flex: 1; display: flex; gap: 14px; align-items: baseline; font-size: var(--fs-13); }
</style>
