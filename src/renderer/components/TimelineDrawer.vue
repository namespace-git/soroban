<script setup lang="ts">
// 在庫 1 点の履歴（仕入→到着→販売→発送→受取→取引完了）を読むだけのドロワー。
// 編集はしない。開くたびに getItemTimeline を呼び直す。
import { ref, watch } from 'vue'
import type { ItemTimeline, SaleStatus } from '../../shared/types'
import Drawer from './Drawer.vue'
import StatusChip from './StatusChip.vue'
import CodeChip from './CodeChip.vue'

const props = defineProps<{
  open: boolean
  inventoryItemId: string | null
}>()
const emit = defineEmits<{ close: [] }>()

const timeline = ref<ItemTimeline | null>(null)
const loading = ref(false)

// --- 取引の進み具合のチップ。Sales.vue と同じ表記に揃える ---
const SALE_STATUS_CHIP: Record<SaleStatus, { tone: 'warn' | 'info' | 'ok'; label: string }> = {
  waiting_payment: { tone: 'warn', label: '支払い待ち' },
  waiting_shipment: { tone: 'warn', label: '発送してください' },
  shipped: { tone: 'info', label: '受取評価待ち' },
  delivered: { tone: 'info', label: '評価してください' },
  completed: { tone: 'ok', label: '取引完了' },
}

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

async function load() {
  if (!props.inventoryItemId) {
    timeline.value = null
    return
  }
  loading.value = true
  timeline.value = await window.soroban.getItemTimeline(props.inventoryItemId)
  loading.value = false
}

watch(() => [props.open, props.inventoryItemId], ([isOpen]) => {
  if (isOpen) load()
}, { immediate: true })

// 今年でなければ年も出す。date が null（まだ起きていない予定の段）は「予定」と薄く出す
function formatDate(d: string | null): string {
  if (!d) return '予定'
  const [y, m, day] = d.split('-')
  return Number(y) === new Date().getFullYear() ? `${m}/${day}` : `${y}/${m}/${day}`
}

function placeholderChar(): string {
  const item = timeline.value?.item
  const c = item?.model_code?.[0] ?? item?.name.trim().charAt(0)
  return (c || '?').toUpperCase()
}

const thumbFailed = ref(false)
function onThumbError() {
  thumbFailed.value = true
}
</script>

<template>
  <Drawer :open="open" :title="timeline?.item.name ?? '在庫の履歴'" :width="480" @close="emit('close')">
    <template v-if="timeline" #header-sub>
      <div class="head-sub">
        <CodeChip kind="item" :code="timeline.item.item_code" />
        <StatusChip v-if="timeline.item.model_code" tone="neutral" :label="timeline.item.model_code" />
        <StatusChip
          v-if="timeline.sale?.status && SALE_STATUS_CHIP[timeline.sale.status]"
          :tone="SALE_STATUS_CHIP[timeline.sale.status].tone"
          :label="SALE_STATUS_CHIP[timeline.sale.status].label"
        />
        <span class="faint">原価 {{ yen(timeline.item.landed_cost) }}</span>
      </div>
    </template>

    <p v-if="loading" class="dim">読み込み中…</p>

    <template v-else-if="timeline">
      <div class="item-head">
        <img
          v-if="timeline.item.thumb_url && !thumbFailed"
          class="thumb"
          :src="timeline.item.thumb_url"
          alt=""
          @error="onThumbError"
        />
        <span v-else class="thumb-placeholder">{{ placeholderChar() }}</span>
        <div class="item-head-text">
          <div class="item-name">{{ timeline.item.name }}</div>
          <div class="faint">{{ timeline.item.shop_account_name ?? '—' }}</div>
        </div>
      </div>

      <ol class="timeline">
        <li
          v-for="(e, i) in timeline.events" :key="i"
          class="tl-row" :class="{ pending: !e.date }"
        >
          <div class="tl-date faint">{{ formatDate(e.date) }}</div>
          <div class="tl-rail">
            <span class="tl-dot" />
            <span v-if="i < timeline.events.length - 1" class="tl-line" />
          </div>
          <div class="tl-body">
            <div class="tl-title">{{ e.title }}</div>
            <div v-if="e.detail" class="tl-detail">{{ e.detail }}</div>
          </div>
          <div v-if="e.amount != null" class="tl-amount num">{{ yen(e.amount) }}</div>
        </li>
      </ol>

      <div v-if="timeline.sale" class="total-row profit-row" :class="{ loss: timeline.sale.gross_profit < 0 }">
        粗利 {{ yen(timeline.sale.gross_profit) }}
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

.item-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line-soft);
}
.item-head .thumb,
.item-head .thumb-placeholder {
  width: 48px;
  height: 48px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.item-head .thumb { object-fit: cover; }
.item-head .thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-weight: 700;
  font-size: var(--fs-16);
}
.item-head-text { min-width: 0; }
.item-name { font-size: var(--fs-14); font-weight: 600; }

.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tl-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.tl-date {
  width: 60px;
  flex-shrink: 0;
  padding-top: 2px;
  font-size: var(--fs-12);
  text-align: right;
}
.tl-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 10px;
  flex-shrink: 0;
}
.tl-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--brand);
  flex-shrink: 0;
  margin-top: 3px;
}
.tl-row.pending .tl-dot {
  background: transparent;
  border: 2px solid var(--line);
  width: 6px;
  height: 6px;
}
.tl-line {
  flex: 1;
  width: 2px;
  min-height: 24px;
  background: var(--line);
  margin: 2px 0;
}
.tl-body {
  flex: 1;
  min-width: 0;
  padding-bottom: 18px;
}
.tl-title { font-size: var(--fs-14); font-weight: 600; }
.tl-row.pending .tl-title { color: var(--text-faint); font-weight: 500; }
.tl-detail { margin-top: 2px; font-size: var(--fs-13); color: var(--text-dim); }
.tl-amount {
  flex-shrink: 0;
  padding-top: 1px;
  font-size: var(--fs-13);
}

.profit-row {
  margin-top: 4px;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  text-align: right;
  font-size: var(--fs-14);
}
</style>
