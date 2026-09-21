<script setup lang="ts">
// 経費（レシート1枚）の詳細。明細・合計・メモ・レシート画像を見せる。
// 編集・削除は Expenses.vue の処理を呼んでもらう（ここでは持たない）。
// レシートの添付・取り外しだけはここで完結し、終わったら changed を投げて親に再読込させる。
import { ref, watch, inject } from 'vue'
import type { Expense, ExpenseCategory, ReceiptDraft } from '../../shared/types'
import Drawer from './Drawer.vue'
import StatusChip from './StatusChip.vue'
import Icon from './Icon.vue'

const props = defineProps<{
  open: boolean
  expense: Expense | null
}>()
const emit = defineEmits<{
  close: []
  edit: [expense: Expense]
  delete: [expense: Expense]
  changed: []
  /** 「レシートを読み取って編集」。親（Expenses.vue）が編集フォームを開いて下書きを反映する */
  'read-edit': [expense: Expense, draft: ReceiptDraft]
}>()

const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!

const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  packaging: '梱包費',
  supplies: '消耗品',
  shipping: '送料',
  fee: '手数料',
  transfer_fee: '振込手数料',
  other: 'その他',
}

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

const busy = ref(false)
const expanded = ref(false)
const readingReceipt = ref(false)

watch(() => props.open, (isOpen) => {
  if (!isOpen) expanded.value = false
})

function monthDiffers(): boolean {
  return !!props.expense && props.expense.month !== props.expense.occurred_at.slice(0, 7)
}

async function attach() {
  if (!props.expense) return
  busy.value = true
  try {
    const url = await window.soroban.attachReceipt(props.expense.id)
    if (url) emit('changed')
  } finally {
    busy.value = false
  }
}

async function removeReceipt() {
  if (!props.expense) return
  busy.value = true
  try {
    await window.soroban.removeReceipt(props.expense.id)
    expanded.value = false
    emit('changed')
  } finally {
    busy.value = false
  }
}

function onEdit() {
  if (props.expense) emit('edit', props.expense)
}
function onDelete() {
  if (props.expense) emit('delete', props.expense)
}

/** 添付済みのレシートを OCR で読み直し、親に編集フォームを開かせる */
async function readForEdit() {
  if (!props.expense) return
  readingReceipt.value = true
  try {
    const draft = await window.soroban.readReceipt(props.expense.id)
    emit('read-edit', props.expense, draft)
  } catch (e: any) {
    toast(e.message, 'warn')
  } finally {
    readingReceipt.value = false
  }
}
</script>

<template>
  <Drawer :open="open" :title="expense?.shop || '経費'" @close="emit('close')">
    <template v-if="expense" #header-sub>
      <div class="head-sub faint">
        <span>{{ expense.occurred_at }}</span>
        <span v-if="monthDiffers()" class="warn">計上 {{ expense.month }}</span>
      </div>
    </template>

    <template v-if="expense">
      <div class="chip-row head-chips">
        <StatusChip tone="neutral" :label="CATEGORY_LABEL[expense.category]" />
      </div>

      <table v-if="expense.lines.length" class="compact lines-table">
        <thead>
          <tr>
            <th>品名</th>
            <th class="num">単価</th>
            <th class="num">数量</th>
            <th class="num">金額</th>
            <th>項目</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in expense.lines" :key="l.id">
            <td class="line-name">{{ l.name }}</td>
            <td class="num">{{ yen(l.unit_price) }}</td>
            <td class="num">{{ l.quantity }}</td>
            <td class="num">{{ yen(l.amount) }}</td>
            <td>{{ CATEGORY_LABEL[l.category] }}</td>
          </tr>
        </tbody>
      </table>

      <div class="totals-block">
        <div class="totals-row total"><strong>合計</strong><strong class="num">{{ yen(expense.amount) }}</strong></div>
      </div>

      <div v-if="expense.note" class="note-row">
        <Icon name="note" :size="14" class="icon-note" />
        <span class="note-label">メモ</span>
        <span class="note-text">{{ expense.note }}</span>
      </div>

      <div class="receipt-block">
        <p class="panel-title">レシート</p>
        <div v-if="expense.receipt_url" class="receipt-wrap">
          <img
            class="receipt-img" :class="{ expanded }"
            :src="expense.receipt_url" alt="レシート画像"
            title="クリックで拡大／縮小"
            @click="expanded = !expanded"
          />
        </div>
        <p v-else class="faint">レシート画像はありません</p>
        <button
          v-if="expense.receipt_url"
          class="ghost sm receipt-read-btn" :disabled="readingReceipt"
          @click="readForEdit"
        >
          <Icon name="receipt" :size="14" />
          {{ readingReceipt ? '読み取り中…（数秒）' : 'レシートを読み取って編集' }}
        </button>
      </div>
    </template>

    <template v-if="expense" #footer>
      <div class="footer-row">
        <button
          v-if="expense.receipt_url"
          class="ghost sm" :disabled="busy"
          @click="removeReceipt"
        >レシートを外す</button>
        <button v-else class="ghost sm" :disabled="busy" @click="attach">レシートを添付</button>
        <span class="grow" />
        <button class="ghost sm" @click="onEdit">編集</button>
        <button class="danger sm" @click="onDelete">削除</button>
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

.head-chips { margin-bottom: 14px; }

.lines-table { margin-bottom: 4px; }
.line-name {
  font-size: var(--fs-14);
  white-space: normal;
  word-break: break-word;
}

.totals-block {
  margin-top: 8px;
  padding: 10px 14px;
  background: var(--surface-hi);
  border-radius: var(--radius-sm);
}
.totals-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: var(--fs-14);
}

.note-row { margin-top: 14px; }

.receipt-block { margin-top: 16px; }
.receipt-read-btn { margin-top: 10px; }
.receipt-wrap { display: flex; }
.receipt-img {
  max-width: 220px;
  max-height: 220px;
  border-radius: var(--radius-sm);
  cursor: zoom-in;
  object-fit: contain;
}
.receipt-img.expanded {
  max-width: 100%;
  max-height: 70vh;
  cursor: zoom-out;
}

.footer-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
