<script setup lang="ts">
// 仕入の取引詳細（読み取り＋タグ／メモ／下書きの確定への入口）。
// 何を何個買って、そこから生まれた在庫が今どうなっているかを1画面で見せる。
// タグ・メモ・確定は Purchases.vue にある既存の処理をそのまま呼ぶ（ここでは持たない）。
import { ref, watch, inject } from 'vue'
import type { PurchaseDetail, PurchaseLineItem, Fulfillment } from '../../shared/types'
import Drawer from './Drawer.vue'
import StatusChip from './StatusChip.vue'
import CodeChip from './CodeChip.vue'
import Icon from './Icon.vue'

const props = defineProps<{
  open: boolean
  purchaseId: string | null
}>()
const emit = defineEmits<{
  close: []
  confirmDraft: [purchase: PurchaseDetail]
  editTag: [purchase: PurchaseDetail, event: MouseEvent]
  editNote: [purchase: PurchaseDetail]
}>()

// ホームの型番ランキング・商品タブと同じ inject。売れた在庫のチップから売上タブの該当行へ飛ぶ
const goto = inject<(t: string, payload?: { stage?: 'listed' | 'pending' | 'done' | 'all'; focusId?: string }) => void>('goto')!

const detail = ref<PurchaseDetail | null>(null)
const loading = ref(false)

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

async function load() {
  if (!props.purchaseId) {
    detail.value = null
    return
  }
  loading.value = true
  detail.value = await window.soroban.getPurchase(props.purchaseId)
  loading.value = false
}

watch(() => [props.open, props.purchaseId], ([isOpen]) => {
  if (isOpen) load()
}, { immediate: true })

defineExpose({ reload: load })

function placeholderChar(): string {
  if (!detail.value) return '—'
  if (detail.value.first_model_code) return detail.value.first_model_code.charAt(0)
  const name = detail.value.first_line_name?.trim()
  return name ? name.charAt(0) : '—'
}

type ChipInfo = { tone: 'neutral' | 'ok' | 'warn' | 'info'; label: string }

function fulfillmentChip(f: Fulfillment | null): ChipInfo {
  if (f === 'pending') return { tone: 'neutral', label: '未発送' }
  if (f === 'shipped') return { tone: 'info', label: '配送中' }
  // delivered、または分からない（手入力など）は到着扱い
  return { tone: 'ok', label: '到着済' }
}

/** MM-DD だけ（年をまたぐ表示は他画面でも省いている） */
function shortDate(d: string | null): string {
  return d ? d.slice(5) : ''
}

function itemChip(it: PurchaseLineItem): ChipInfo {
  if (it.status === 'sold') return { tone: 'ok', label: `販売済 ${yen(it.sale_price ?? 0)} ${shortDate(it.sold_at)}` }
  if (it.status === 'disposed') return { tone: 'neutral', label: '廃棄' }
  if (it.status === 'personal_use') return { tone: 'neutral', label: '自家消費' }
  if (it.status === 'split') return { tone: 'neutral', label: '分割済' }
  if (it.listing_price != null) return { tone: 'info', label: `出品中 ${yen(it.listing_price)}` }
  return { tone: 'neutral', label: '未出品' }
}

function itemClickable(it: PurchaseLineItem): boolean {
  return it.status === 'sold' && !!it.sale_id
}

function openSale(it: PurchaseLineItem) {
  if (!itemClickable(it) || !it.sale_id) return
  goto('sales', { stage: 'all', focusId: it.sale_id })
}

function onConfirmDraft() {
  if (detail.value) emit('confirmDraft', detail.value)
}
function onEditTag(e: MouseEvent) {
  if (detail.value) emit('editTag', detail.value, e)
}
function onEditNote() {
  if (detail.value) emit('editNote', detail.value)
}
</script>

<template>
  <Drawer :open="open" :title="detail?.first_line_name ?? '仕入の詳細'" :width="640" @close="emit('close')">
    <template v-if="detail" #header-sub>
      <div class="head-sub faint">
        <span>{{ detail.shop_account_name }}</span>
        <span>{{ detail.ordered_at }}</span>
      </div>
    </template>

    <p v-if="loading" class="dim">読み込み中…</p>

    <template v-else-if="detail">
      <div class="item-head">
        <span class="thumb-placeholder">{{ placeholderChar() }}</span>
        <div class="item-head-text">
          <div class="item-name">
            {{ detail.first_line_name ?? '仕入' }}
            <span v-if="detail.line_count > 1" class="faint"> ほか{{ detail.line_count - 1 }}点</span>
          </div>
          <div class="chip-row">
            <span v-if="detail.order_no" class="faint">#{{ detail.order_no }}</span>
            <StatusChip :tone="fulfillmentChip(detail.fulfillment).tone" :label="fulfillmentChip(detail.fulfillment).label" />
            <StatusChip v-if="detail.status === 'draft'" tone="warn" label="価格未入力" />
            <StatusChip v-if="detail.import_key" tone="neutral" label="自動取得" />
            <StatusChip v-for="t in detail.tags" :key="t.id" tone="info" :label="t.name" />
          </div>
        </div>
      </div>

      <table class="compact lines-table">
        <thead>
          <tr>
            <th>商品</th>
            <th class="num">数量</th>
            <th class="num">単価</th>
            <th class="num">原価／点</th>
            <th class="num">小計</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in detail.lines" :key="l.id">
            <td class="line-cell">
              <div class="line-name">{{ l.name }}</div>
              <div v-if="l.model_code" class="chip-row">
                <StatusChip tone="neutral" :label="l.model_code" />
              </div>
              <div v-if="l.items.length" class="chip-row items-row">
                <span v-for="it in l.items" :key="it.id" class="item-chip-group">
                  <CodeChip kind="item" :code="it.item_code" />
                  <button
                    class="item-chip-btn" :class="{ clickable: itemClickable(it) }"
                    :disabled="!itemClickable(it)"
                    :title="itemClickable(it) ? '売上タブの該当行を見る' : undefined"
                    @click="openSale(it)"
                  >
                    <StatusChip :tone="itemChip(it).tone" :label="itemChip(it).label" />
                  </button>
                </span>
              </div>
            </td>
            <td class="num">{{ l.quantity }}</td>
            <td class="num">{{ yen(l.unit_price) }}</td>
            <td class="num dim">{{ yen(l.landed_unit_cost) }}</td>
            <td class="num">{{ yen(l.unit_price * l.quantity) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="detail.status === 'draft'" class="faint hint-row">確定すると在庫が生まれます</p>

      <div class="totals-block">
        <div class="totals-row"><span class="dim">商品計</span><span class="num">{{ yen(detail.subtotal) }}</span></div>
        <div class="totals-row"><span class="dim">送料</span><span class="num">{{ yen(detail.shipping_fee) }}</span></div>
        <div v-if="detail.discount" class="totals-row"><span class="dim">割引</span><span class="num">{{ yen(-detail.discount) }}</span></div>
        <div v-if="detail.other_cost" class="totals-row"><span class="dim">その他費用</span><span class="num">{{ yen(detail.other_cost) }}</span></div>
        <div class="totals-row total"><strong>総原価</strong><strong class="num">{{ yen(detail.total_cost) }}</strong></div>
        <p class="faint alloc-label">{{ detail.alloc_method === 'by_amount' ? '金額按分' : '数量按分' }}</p>
      </div>

      <div v-if="detail.note" class="note-row">
        <Icon name="note" :size="14" class="icon-note" />
        <span class="note-label">メモ</span>
        <span class="note-text">{{ detail.note }}</span>
      </div>
    </template>

    <template v-if="detail" #footer>
      <div class="footer-row">
        <button v-if="detail.status === 'draft'" class="primary" @click="onConfirmDraft">確定する</button>
        <span class="grow" />
        <button class="ghost sm" @click="onEditTag">タグ</button>
        <button class="ghost sm" @click="onEditNote">メモ</button>
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
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line-soft);
}
.item-head .thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-weight: 700;
  font-size: var(--fs-16);
}
.item-head-text { min-width: 0; }
.item-name { font-size: var(--fs-14); font-weight: 600; }

.lines-table { margin-top: 4px; }
.line-cell { min-width: 0; }
.line-name {
  font-size: var(--fs-14);
  font-weight: 500;
  white-space: normal;
  word-break: break-word;
}
.items-row { margin-top: 6px; }

.item-chip-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.item-chip-btn {
  background: transparent;
  border: none;
  padding: 0;
  height: auto;
}
.item-chip-btn:not(.clickable) { cursor: default; }
.item-chip-btn.clickable { cursor: pointer; }
.item-chip-btn:disabled { opacity: 1; }

.hint-row { margin: 8px 0 0; }

.totals-block {
  margin-top: 16px;
  padding: 12px 14px;
  background: var(--surface-hi);
  border-radius: var(--radius-sm);
}
.totals-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
  font-size: var(--fs-13);
}
.totals-row.total {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
  font-size: var(--fs-14);
}
.alloc-label { margin: 6px 0 0; text-align: right; }

.note-row { margin-top: 14px; }

.footer-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
