<script setup lang="ts">
import { isRealized } from '../../shared/recognition'
// 在庫 1 点の追跡（仕入→到着→出品→売れた→発送→受取→取引完了）を読むだけのドロワー。
// 編集はしない。開くたびに getItemTimeline を呼び直す（購入元の詳細は「いっしょに買ったもの」用に別途取る）。
import { ref, computed, inject, watch } from 'vue'
import type { ItemTimeline, SaleStatus, PurchaseDetail, PurchaseLine, PurchaseLineItem } from '../../shared/types'
import Drawer from './Drawer.vue'
import StatusChip from './StatusChip.vue'
import StatusPill from './StatusPill.vue'
import CodeChip from './CodeChip.vue'
import Icon from './Icon.vue'
import { yen, smartDate, dateTimeWithYear } from '../format'

const props = defineProps<{
  open: boolean
  inventoryItemId: string | null
}>()
const emit = defineEmits<{ close: [] }>()

const goto = inject<(tab: string, payload?: { modelCode?: string; search?: string; focusId?: string }) => void>('goto')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!

const timeline = ref<ItemTimeline | null>(null)
const purchaseDetail = ref<PurchaseDetail | null>(null)
const loading = ref(false)
const refetchBusy = ref(false)

// --- 取引の進み具合のチップ。Sales.vue と同じ表記に揃える ---
const SALE_STATUS_CHIP: Record<SaleStatus, { tone: 'warn' | 'info' | 'ok'; label: string }> = {
  waiting_payment: { tone: 'warn', label: '支払い待ち' },
  waiting_shipment: { tone: 'warn', label: '発送してください' },
  shipped: { tone: 'info', label: '受取評価待ち' },
  delivered: { tone: 'info', label: '評価してください' },
  completed: { tone: 'ok', label: '取引完了' },
}

async function load() {
  if (!props.inventoryItemId) {
    timeline.value = null
    purchaseDetail.value = null
    return
  }
  loading.value = true
  timeline.value = await window.soroban.getItemTimeline(props.inventoryItemId)
  purchaseDetail.value = timeline.value?.purchase
    ? await window.soroban.getPurchase(timeline.value.purchase.id)
    : null
  loading.value = false
}

watch(() => [props.open, props.inventoryItemId], ([isOpen]) => {
  if (isOpen) load()
}, { immediate: true })

// 今年でなければ年も出す。date が null（まだ起きていない予定の段）は「予定」と薄く出す
const formatDate = (d: string | null) => smartDate(d, '予定')

const purchasedAtLabel = computed(() => dateTimeWithYear(timeline.value?.sale?.purchased_at ?? null))

async function refetchPurchasedAt() {
  const sale = timeline.value?.sale
  if (!sale || refetchBusy.value) return
  refetchBusy.value = true
  try {
    const result = await window.soroban.refetchSaleDates(sale.id)
    toast(
      result.purchased_at ? '購入日時を取り直しました' : '取引画面に購入日時が見つかりませんでした',
      result.purchased_at ? 'ok' : 'warn',
    )
    await load()
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'warn')
  } finally {
    refetchBusy.value = false
  }
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

// --- 「今」の状態ピル・チップ。売れていれば取引の進み具合、未販売なら在庫の状態 ---
type PillTone = 'solid-ok' | 'solid-loss' | 'solid-warn' | 'solid-info' | 'neutral' | 'ok' | 'warn' | 'info' | 'brand'
type ChipTone = 'warn' | 'ok' | 'neutral' | 'info' | 'brand' | 'loss'
const nowPill = computed<{ tone: PillTone; label: string } | null>(() => {
  const item = timeline.value?.item
  if (!item || timeline.value?.sale) return null
  if (item.status === 'in_stock') {
    if (item.fulfillment === 'pending' || item.fulfillment === 'shipped') return { tone: 'solid-warn', label: '未着' }
    if (item.listing) {
      return {
        tone: item.listing.status === 'suspended' ? 'neutral' : 'brand',
        label: `${item.listing.status === 'suspended' ? '公開停止中' : '出品中'} ${yen(item.listing.price)}`,
      }
    }
    return { tone: 'neutral', label: '未出品' }
  }
  return null
})
const nowChip = computed<{ tone: ChipTone; label: string } | null>(() => {
  const item = timeline.value?.item
  const sale = timeline.value?.sale
  if (!item) return null
  if (sale?.status && SALE_STATUS_CHIP[sale.status]) return SALE_STATUS_CHIP[sale.status]
  if (sale) return { tone: 'ok', label: '販売済' }
  if (item.status === 'disposed') return { tone: 'neutral', label: '廃棄' }
  if (item.status === 'personal_use') return { tone: 'neutral', label: '自家消費' }
  if (item.status === 'split') return { tone: 'neutral', label: '分割済' }
  return null
})

// --- お金の4枚 ---
const saleCard = computed(() => {
  const item = timeline.value?.item
  const sale = timeline.value?.sale
  if (!item) return null
  if (sale) {
    return {
      price: yen(sale.price),
      priceSub: `${formatDate(sale.sold_at)} メルカリ`,
      fee: `−${yen(sale.fee + sale.shipping_fee)}`,
      feeSub: `手数料 ${yen(sale.fee)}・送料 ${yen(sale.shipping_fee)}`,
      profit: sale.gross_profit,
      profitSub: (!isRealized(sale) ? '見込み・取引未完了 / ' : '実績 / ') + (sale.item_count > 1 ? `まとめ売り ${sale.item_count}点の粗利` : 'この販売の粗利'),
    }
  }
  if (item.listing) {
    return {
      price: yen(item.listing.price),
      priceSub: '出品中（メルカリ）',
      fee: '—',
      feeSub: '未確定',
      profit: null,
      profitSub: '売れるまで未確定',
    }
  }
  return { price: '—', priceSub: '未出品', fee: '—', feeSub: '未確定', profit: null, profitSub: '未販売' }
})

// --- メルカリのページを開く。出品ページは在庫が引き当て中ならその id、
//     売れたあとは販売の id が同じ出品を指す ---
const listingMercariId = computed(() => timeline.value?.item.listing?.mercari_item_id ?? timeline.value?.sale?.mercari_item_id ?? null)
const saleMercariId = computed(() => timeline.value?.sale?.mercari_item_id ?? null)

async function openMercariLink(kind: 'item' | 'transaction', id: string | null) {
  if (!id) return
  await window.soroban.openMercari(kind, id)
}

// --- いっしょに買ったもの（同じ注文の他の在庫） ---
function siblingState(it: PurchaseLineItem): string {
  if (it.status === 'sold') return `販売済 ${yen(it.sale_price ?? 0)}`
  if (it.status === 'in_stock') return it.listing_price != null ? `出品中 ${yen(it.listing_price)}（紐付け済み）` : '未出品'
  if (it.status === 'disposed') return '廃棄'
  if (it.status === 'personal_use') return '自家消費'
  return '分割済'
}
function siblingName(line: PurchaseLine): string {
  const currentModelCode = timeline.value?.item.model_code
  if (line.model_code && currentModelCode && line.model_code === currentModelCode) return '同じ型番'
  return line.model_code ? `【${line.model_code}】${line.name}` : line.name
}
const siblings = computed(() => {
  const currentId = timeline.value?.item.id
  if (!purchaseDetail.value || !currentId) return []
  const list: Array<{ item_code: string; label: string }> = []
  for (const line of purchaseDetail.value.lines) {
    for (const it of line.items) {
      if (it.id === currentId) continue
      list.push({ item_code: it.item_code, label: `${siblingName(line)} ・ ${siblingState(it)}` })
    }
  }
  return list
})

// --- フッターの導線 ---
function openPurchase() {
  if (!timeline.value?.purchase) return
  emit('close')
  goto('purchases', { focusId: timeline.value.purchase.id })
}
function openSaleRow() {
  if (!timeline.value?.sale) return
  emit('close')
  goto('sales', { focusId: timeline.value.sale.id })
}
function openProduct() {
  if (!timeline.value?.item.model_code) return
  emit('close')
  goto('products', { modelCode: timeline.value.item.model_code })
}
</script>

<template>
  <Drawer :open="open" :title="timeline?.item.name ?? '在庫の履歴'" :width="560" @close="emit('close')">
    <template v-if="timeline" #header-sub>
      <div class="head-sub">
        <CodeChip kind="item" :code="timeline.item.item_code" />
        <StatusChip v-if="timeline.item.model_code" tone="neutral" :label="timeline.item.model_code" />
        <StatusChip v-for="t in timeline.item.tags" :key="t.id" tone="info" :label="t.name" />
        <span class="faint sub-text">
          <template v-if="timeline.purchase">
            仕入 {{ timeline.purchase.shop_account_name }}<template v-if="timeline.purchase.order_no"> #{{ timeline.purchase.order_no }}</template>（{{ timeline.purchase.ordered_at }}）・
          </template>
          原価 {{ yen(timeline.item.landed_cost) }} ・ 今：
        </span>
        <StatusPill v-if="nowPill" :tone="nowPill.tone" :label="nowPill.label" />
        <StatusChip v-else-if="nowChip" :tone="nowChip.tone" :label="nowChip.label" />
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

      <div class="money-grid">
        <div class="money-card">
          <div class="money-label">原価</div>
          <div class="money-value">{{ yen(timeline.item.landed_cost) }}</div>
          <div class="money-sub">仕入時に確定</div>
        </div>
        <div class="money-card">
          <div class="money-label">売価</div>
          <div class="money-value">{{ saleCard?.price ?? '—' }}</div>
          <div class="money-sub">{{ saleCard?.priceSub }}</div>
        </div>
        <div class="money-card">
          <div class="money-label">手数料・送料</div>
          <div class="money-value">{{ saleCard?.fee ?? '—' }}</div>
          <div class="money-sub">{{ saleCard?.feeSub }}</div>
        </div>
        <div class="money-card">
          <div class="money-label">粗利</div>
          <div
            class="money-value"
            :class="saleCard?.profit != null ? (saleCard.profit >= 0 ? 'profit' : 'loss') : 'faint'"
          >{{ saleCard?.profit != null ? yen(saleCard.profit) : '未販売' }}</div>
          <div class="money-sub">{{ saleCard?.profitSub }}</div>
        </div>
      </div>

      <div v-if="timeline.sale" class="purchased-row">
        <span class="faint">購入日時 {{ purchasedAtLabel }}</span>
        <button
          v-if="saleMercariId"
          type="button" class="sm ghost"
          title="取引画面を1ページ開いて購入日時を読み直します"
          :disabled="refetchBusy"
          @click="refetchPurchasedAt"
        >取り直す</button>
      </div>

      <h3>この1点の足あと</h3>
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
            <div class="tl-title row-title one-line" :title="e.title">{{ e.title }}</div>
            <div class="tl-detail row-sub" :title="e.detail ?? ''">{{ e.detail }}</div>
            <button
              v-if="e.kind === 'listed' && listingMercariId"
              type="button" class="tl-link" @click="openMercariLink('item', listingMercariId)"
            >出品ページ <Icon name="external" :size="12" /></button>
            <button
              v-if="e.kind === 'sale_completed' && saleMercariId"
              type="button" class="tl-link" @click="openMercariLink('transaction', saleMercariId)"
            >取引画面 <Icon name="external" :size="12" /></button>
          </div>
          <div v-if="e.amount != null" class="tl-amount num">{{ yen(e.amount) }}</div>
        </li>
      </ol>

      <template v-if="siblings.length">
        <h3>いっしょに買ったもの（同じ注文）</h3>
        <div class="kv">
          <template v-for="s in siblings" :key="s.item_code">
            <span class="k">{{ s.item_code }}</span><span>{{ s.label }}</span>
          </template>
        </div>
      </template>

      <h3>メモ</h3>
      <div class="kv">
        <span class="k">在庫</span><span>{{ timeline.item.note || '—' }}</span>
        <span class="k">販売</span><span>{{ timeline.sale?.note || '—' }}</span>
      </div>
    </template>

    <template #footer>
      <div class="drawer-actions">
        <button type="button" class="ghost sm" :disabled="!timeline?.purchase" @click="openPurchase">仕入の伝票を開く</button>
        <button v-if="timeline?.sale" type="button" class="ghost sm" @click="openSaleRow">売上の行へ</button>
        <button type="button" class="ghost sm" :disabled="!timeline?.item.model_code" @click="openProduct">商品カルテ</button>
        <span class="grow" />
        <button type="button" class="ghost sm" @click="emit('close')">閉じる</button>
      </div>
    </template>
  </Drawer>
</template>

<style scoped>
.head-sub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.sub-text { white-space: normal; }

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

/* --- お金の4枚 --- */
.money-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 16px;
}
.money-card {
  background: var(--surface-hi);
  border-radius: var(--radius-md);
  padding: 10px 12px;
}
.money-label { font-size: var(--fs-11); color: var(--text-dim); }
.money-value {
  margin-top: 2px;
  font-size: var(--fs-20);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.money-value.profit { color: var(--profit); }
.money-value.loss { color: var(--loss); }
.money-value.faint { color: var(--text-faint); font-size: var(--fs-16); }
.money-sub { margin-top: 2px; font-size: var(--fs-11); color: var(--text-faint); }

.purchased-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}

h3 {
  margin: 14px 0 8px;
  font-size: var(--fs-13);
  color: var(--text-dim);
}

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
.tl-row.pending .tl-title { color: var(--text-faint); font-weight: 500; }
.tl-amount {
  flex-shrink: 0;
  padding-top: 1px;
  font-size: var(--fs-13);
}
.tl-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  margin-right: 10px;
  padding: 0;
  background: transparent;
  border: none;
  height: auto;
  font-size: var(--fs-12);
  color: var(--text-dim);
  text-decoration: underline dotted;
  cursor: pointer;
}
.tl-link:hover:not(:disabled) { background: transparent; color: var(--text); }

.kv {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 4px 10px;
  font-size: var(--fs-13);
}
.kv .k { color: var(--text-faint); }

.drawer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
</style>
