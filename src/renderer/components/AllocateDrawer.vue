<script setup lang="ts">
// 出品 1 件への在庫の引き当て。Sales.vue の紐付けドロワーと同じ体験：
// チェックした瞬間に下端の原価合計・見込み粗利が動く。確定は「引き当てる」ボタンで初めて起きる。
import { ref, computed, watch, inject } from 'vue'
import type { Listing, InventoryItem, ListingStatus } from '../../shared/types'
import Drawer from './Drawer.vue'
import StatusChip from './StatusChip.vue'
import EmptyState from './EmptyState.vue'
import Icon from './Icon.vue'

const props = defineProps<{
  open: boolean
  listing: Listing | null
}>()
const emit = defineEmits<{ close: []; changed: [] }>()

const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!

const candidates = ref<InventoryItem[]>([])
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

// 実際の手数料計算（src/main/money.ts の calcFee と同じ：切り捨て）。
// ここは「チェックした瞬間の見込み粗利プレビュー」のための例外的な再計算。
function calcFee(price: number, rateBp: number): number {
  return Math.floor((price * rateBp) / 10000)
}

async function load() {
  if (!props.listing) { candidates.value = []; return }
  loading.value = true
  const [sugg, settings] = await Promise.all([
    window.soroban.suggestForListing(props.listing.mercari_item_id, 50),
    window.soroban.getSettings(),
  ])
  candidates.value = sugg
  feeRateBp.value = Number(settings.fee_rate_bp ?? 1000)
  loading.value = false
}

watch(() => [props.open, props.listing?.mercari_item_id], ([isOpen]) => {
  picked.value = new Set()
  search.value = ''
  if (isOpen) load()
}, { immediate: true })

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return candidates.value
  return candidates.value.filter(c =>
    c.name.toLowerCase().includes(q) || (c.model_code ?? '').toLowerCase().includes(q),
  )
})

function toggle(id: string) {
  const s = new Set(picked.value)
  s.has(id) ? s.delete(id) : s.add(id)
  picked.value = s
}

const reservedCost = computed(() => props.listing?.items.reduce((s, it) => s + it.landed_cost, 0) ?? 0)
const pickedCost = computed(() =>
  candidates.value.filter(c => picked.value.has(c.id)).reduce((s, c) => s + c.landed_cost, 0),
)
const totalCost = computed(() => reservedCost.value + pickedCost.value)
const totalCount = computed(() => (props.listing?.items.length ?? 0) + picked.value.size)

const previewProfit = computed(() => {
  if (!props.listing) return 0
  const fee = calcFee(props.listing.price, feeRateBp.value)
  return props.listing.price - fee - totalCost.value
})

async function confirmReserve() {
  if (!props.listing || picked.value.size === 0) return
  try {
    await window.soroban.reserveInventory(props.listing.mercari_item_id, [...picked.value])
    picked.value = new Set()
    emit('changed')
    await load()
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'warn')
  }
}

async function unreserve(itemId: string) {
  if (!props.listing) return
  try {
    await window.soroban.unreserveInventory(props.listing.mercari_item_id, itemId)
    emit('changed')
    await load()
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'warn')
  }
}

const thumbFailed = ref(false)
watch(() => props.listing?.mercari_item_id, () => { thumbFailed.value = false })
function placeholderChar(): string {
  const l = props.listing
  const c = l?.model_codes[0]?.[0] ?? l?.title.trim().charAt(0)
  return (c || '?').toUpperCase()
}
</script>

<template>
  <Drawer :open="open" :title="listing?.title ?? ''" :width="560" @close="emit('close')">
    <template #header-sub>
      <div v-if="listing" class="head-sub">
        <img
          v-if="listing.thumb_url && !thumbFailed"
          class="thumb" :src="listing.thumb_url" alt=""
          @error="thumbFailed = true"
        />
        <span v-else class="thumb-placeholder">{{ placeholderChar() }}</span>
        <span class="faint">出品価格 {{ yen(listing.price) }}</span>
        <StatusChip :tone="STATUS_TONE[listing.status]" :label="STATUS_LABEL[listing.status]" />
      </div>
    </template>

    <label class="search-field">
      <Icon name="search" :size="16" />
      <input v-model="search" placeholder="在庫を検索" />
    </label>

    <div v-if="listing?.items.length" class="matched-block">
      <p class="panel-title">引き当て済み</p>
      <div v-for="it in listing.items" :key="it.id" class="item matched-item">
        <StatusChip v-if="it.model_code" tone="neutral" :label="it.model_code" />
        <span class="grow">{{ it.name }}</span>
        <span class="num">{{ yen(it.landed_cost) }}</span>
        <button class="sm ghost" @click="unreserve(it.id)">解除</button>
      </div>
    </div>

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
        <span class="grow">{{ c.name }}</span>
        <span class="faint nowrap">{{ c.aging_days }}日</span>
        <span class="num">{{ yen(c.landed_cost) }}</span>
      </label>
      <EmptyState v-if="!loading && !filtered.length" title="候補になる在庫がありません" />
    </div>

    <template #footer>
      <div class="match-footer">
        <div class="calc">
          <span class="faint">{{ totalCount }}点</span>
          <span class="num">原価 {{ yen(totalCost) }}</span>
          <strong class="num" :class="previewProfit >= 0 ? 'profit' : 'loss'">
            見込み粗利（送料・梱包前） {{ yen(previewProfit) }}
          </strong>
        </div>
        <button class="primary" :disabled="!picked.size" @click="confirmReserve">
          引き当てる
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
