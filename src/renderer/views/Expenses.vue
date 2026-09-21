<script setup lang="ts">
// 経費タブ：レシート1枚＝経費1件。購入店・購入日・明細・金額・レシート画像・計上月を管理する。
// 月次の按分・純利益はこの経費を月（計上月）で拾う（Monthly.vue 側。ここでは再計算しない）。
import { ref, onMounted, computed, watch, inject, type Ref } from 'vue'
import type { AiStatus, Expense, ExpenseCategory, ExpenseInput, ExpenseLineInput, ReceiptDraft, ReceiptRead } from '../../shared/types'
import { todayLocal } from '../../shared/date'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import ExpenseDrawer from '../components/ExpenseDrawer.vue'
import SearchBox, { matchesSearch } from '../components/SearchBox.vue'
import PeriodSelect, { inPeriod, type Period } from '../components/PeriodSelect.vue'
import SortTh from '../components/SortTh.vue'
import { useSort } from '../composables/useSort'

type SortKey = 'occurred_at' | 'shop' | 'month' | 'amount'

const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  packaging: '梱包費',
  supplies: '消耗品',
  shipping: '送料',
  fee: '手数料',
  transfer_fee: '振込手数料',
  other: 'その他',
}
const CATEGORY_OPTIONS: Array<{ value: ExpenseCategory; label: string }> = [
  { value: 'packaging', label: '梱包費' },
  { value: 'supplies', label: '消耗品' },
  { value: 'shipping', label: '送料' },
  { value: 'fee', label: '手数料' },
  { value: 'transfer_fee', label: '振込手数料' },
  { value: 'other', label: 'その他' },
]

const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!
const goto = inject<(t: string) => void>('goto')!

const expenses = ref<Expense[]>([])
const loaded = ref(false)
const showForm = ref(false)
const editingId = ref<string | null>(null)
const aiStatus = ref<AiStatus | null>(null)

type LineForm = ExpenseLineInput & { category: ExpenseCategory }

function blankLine(): LineForm {
  return { name: '', unit_price: 0, quantity: 1, category: 'packaging' }
}

const form = ref({
  shop: '',
  occurred_at: todayLocal(),
  month: todayLocal().slice(0, 7),
  category: 'packaging' as ExpenseCategory,
  amount: 0,
  note: '',
  lines: [blankLine()] as LineForm[],
  /** readReceiptImage で読んだ一時ファイル名。登録・保存時にそのまま渡す */
  receipt_temp_file: null as string | null,
})

const yen = (n: number) => '¥' + n.toLocaleString('ja-JP')

async function load() {
  expenses.value = await window.soroban.listExpenses()
  aiStatus.value = await window.soroban.getAiStatus()
  loaded.value = true
  // ドロワーを開いたまま更新された場合は表示中の内容も差し替える
  if (drawerExpense.value) {
    drawerExpense.value = expenses.value.find(e => e.id === drawerExpense.value!.id) ?? null
  }
}
onMounted(load)
watch(revision, load)

// --- 検索・期間・項目（クライアント側で絞る）。既定の期間は今月 ---

const searchText = ref('')
const period = ref<Period>('this_month')
const categoryFilter = ref<ExpenseCategory | ''>('')

const filteredExpenses = computed(() =>
  expenses.value.filter(e =>
    (categoryFilter.value === '' || e.category === categoryFilter.value) &&
    matchesSearch([e.shop, e.note, ...e.lines.map(l => l.name)], searchText.value) &&
    inPeriod(e.occurred_at, period.value),
  ),
)

const { sortKey, sortDir, toggle, sortRows } = useSort<SortKey>('occurred_at', 'desc')
function onSort(key: string) {
  toggle(key as SortKey)
}
function sortValue(e: Expense, key: SortKey): string | number | null {
  switch (key) {
    case 'occurred_at': return e.occurred_at
    case 'shop': return e.shop
    case 'month': return e.month
    case 'amount': return e.amount
  }
}
const sortedExpenses = computed(() => sortRows(filteredExpenses.value, sortValue))

const periodTotal = computed(() => filteredExpenses.value.reduce((s, e) => s + e.amount, 0))

// --- 購入店の候補（datalist）。読み込み済みの経費から集計する。使用回数の多い順、同数なら最近使った順 ---
const shopOptions = computed(() => {
  const stats = new Map<string, { count: number; recent: string }>()
  for (const e of expenses.value) {
    const shop = e.shop?.trim()
    if (!shop) continue
    const cur = stats.get(shop)
    if (cur) {
      cur.count++
      if (e.occurred_at > cur.recent) cur.recent = e.occurred_at
    } else {
      stats.set(shop, { count: 1, recent: e.occurred_at })
    }
  }
  return [...stats.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].recent.localeCompare(a[1].recent))
    .map(([shop]) => shop)
})

function contentLabel(e: Expense): string {
  if (!e.lines.length) return e.note?.trim() || '—'
  if (e.lines.length === 1) return e.lines[0].name
  return `${e.lines[0].name} ほか${e.lines.length - 1}点`
}

function monthDiffers(e: Expense): boolean {
  return e.month !== e.occurred_at.slice(0, 7)
}

// --- レシートのサムネイル。読み込み失敗したら以後「—」に固定する ---
const thumbFailed = ref<Set<string>>(new Set())
function showThumb(e: Expense): boolean {
  return !!e.receipt_url && !thumbFailed.value.has(e.id)
}
function onThumbError(id: string) {
  thumbFailed.value = new Set(thumbFailed.value).add(id)
}

// --- 登録・編集フォーム ---

/** 計上月を人が触ったら true。購入日を変えても以後は自動追随しない */
const monthTouched = ref(false)

watch(() => form.value.occurred_at, (v) => {
  if (!monthTouched.value) form.value.month = v.slice(0, 7)
})

function resetForm() {
  editingId.value = null
  form.value = {
    shop: '',
    occurred_at: todayLocal(),
    month: todayLocal().slice(0, 7),
    category: 'packaging',
    amount: 0,
    note: '',
    lines: [blankLine()],
    receipt_temp_file: null,
  }
  monthTouched.value = false
  clearReceiptDraft()
}

function toggleForm() {
  if (showForm.value) {
    showForm.value = false
    resetForm()
  } else {
    resetForm()
    showForm.value = true
  }
}

function addLine() {
  form.value.lines.push(blankLine())
}
function removeLine(i: number) {
  form.value.lines.splice(i, 1)
}

function lineAmount(l: LineForm): number {
  return (l.unit_price || 0) * (l.quantity || 1)
}
const lineSubtotal = computed(() => form.value.lines.reduce((s, l) => s + lineAmount(l), 0))

// --- レシートを読み取る（OCR の下書きをフォームに入れる） ---

const receiptBusy = ref(false)
/** 画像を選んで読んだときだけ入る（サムネ表示用）。添付済みレシートの再読み取りでは入らない */
const receiptPreviewUrl = ref<string | null>(null)
const receiptRawText = ref<string | null>(null)
/** レシートの「合計」行の値。明細合計と食い違っていたら警告する */
const receiptDraftTotal = ref<number | null>(null)
/** AI が読んだ消費税などの差額。明細合計＋この値＝合計 なら「税として追加」ボタンを出す */
const receiptDraftTax = ref<number | null>(null)
/** AI が気づいたこと（事業と関係なさそうな行、分類の判断など） */
const receiptWarnings = ref<string[]>([])
/** レシートの登録番号（T＋13桁）。登録・保存時に渡すと「この番号＝この店名」を覚える（shop_alias） */
const receiptRegistrationNo = ref<string | null>(null)
/** 店名が前回の学習から決まったら true（購入店の横に出す） */
const receiptShopLearned = ref(false)

// --- AI が入れた値の印（薄い黄色の枠）。人が触ったら該当欄だけ解除する ---
const aiFilledShop = ref(false)
const aiFilledOccurredAt = ref(false)
const aiFilledLines = ref<Set<number>>(new Set())
function clearAiLine(i: number) {
  if (!aiFilledLines.value.has(i)) return
  const next = new Set(aiFilledLines.value)
  next.delete(i)
  aiFilledLines.value = next
}

/** 明細合計＋税＝レシート合計 が成り立つときだけ「税として追加」ボタンを出す */
const taxAddable = computed(() => {
  const tax = receiptDraftTax.value
  const total = receiptDraftTotal.value
  if (tax == null || tax <= 0 || total == null) return false
  return lineSubtotal.value + tax === total
})

function addTaxLine() {
  const tax = receiptDraftTax.value
  if (tax == null) return
  const category = form.value.lines[0]?.category ?? 'packaging'
  form.value.lines.push({ name: '消費税', unit_price: tax, quantity: 1, category })
  aiFilledLines.value = new Set(aiFilledLines.value).add(form.value.lines.length - 1)
  receiptDraftTax.value = null
}

const receiptTotalMismatch = computed(() => {
  if (receiptDraftTotal.value == null) return null
  if (receiptDraftTotal.value === lineSubtotal.value) return null
  if (taxAddable.value) return null
  return receiptDraftTotal.value
})

function clearReceiptDraft() {
  form.value.receipt_temp_file = null
  receiptPreviewUrl.value = null
  receiptRawText.value = null
  receiptDraftTotal.value = null
  receiptDraftTax.value = null
  receiptWarnings.value = []
  receiptRegistrationNo.value = null
  receiptShopLearned.value = false
  aiFilledShop.value = false
  aiFilledOccurredAt.value = false
  aiFilledLines.value = new Set()
}

/** 画像を選んで読んだ下書きをフォームへ反映する。draft の値がある項目だけ上書きする */
function applyReceiptDraft(result: ReceiptRead) {
  form.value.receipt_temp_file = result.temp_file
  receiptPreviewUrl.value = result.receipt_url
  receiptRawText.value = result.draft.raw_text
  receiptDraftTotal.value = result.draft.total
  receiptDraftTax.value = result.draft.tax
  receiptWarnings.value = result.draft.warnings
  receiptRegistrationNo.value = result.draft.registration_no
  receiptShopLearned.value = result.draft.shop_learned
  if (result.draft.shop) { form.value.shop = result.draft.shop; aiFilledShop.value = true }
  if (result.draft.occurred_at) { form.value.occurred_at = result.draft.occurred_at; aiFilledOccurredAt.value = true }
  if (result.draft.lines.length) {
    form.value.lines = result.draft.lines.map(l => ({
      name: l.name, unit_price: l.unit_price, quantity: l.quantity, category: l.category ?? 'packaging',
    }))
    aiFilledLines.value = new Set(form.value.lines.map((_, i) => i))
  }
}

async function readReceiptForForm() {
  const status = await window.soroban.getAiStatus()
  aiStatus.value = status
  if (!status.configured) {
    toast('AI 読み取りの設定がありません', 'warn')
    return
  }
  receiptBusy.value = true
  try {
    const result = await window.soroban.readReceiptImage()
    if (result) applyReceiptDraft(result)
  } catch (e: any) {
    toast(e.message, 'warn')
  } finally {
    receiptBusy.value = false
  }
}

function openEdit(e: Expense) {
  editingId.value = e.id
  // 明細が無い経費（合計を直接入力していたもの）は明細行を空のまま開く
  form.value = {
    shop: e.shop ?? '',
    occurred_at: e.occurred_at,
    month: e.month,
    category: e.category,
    amount: e.lines.length ? 0 : e.amount,
    note: e.note ?? '',
    lines: e.lines.map(l => ({ name: l.name, unit_price: l.unit_price, quantity: l.quantity, category: l.category })),
    receipt_temp_file: null,
  }
  monthTouched.value = monthDiffers(e)
  clearReceiptDraft()
  drawerExpense.value = null
  showForm.value = true
}

/** ドロワーの「レシートを読み取って編集」。既存の値は上書きせず、空の項目だけ埋める */
async function onDrawerReadEdit(e: Expense, draft: ReceiptDraft) {
  openEdit(e)
  if (draft.shop && !form.value.shop.trim()) { form.value.shop = draft.shop; aiFilledShop.value = true }
  if (draft.occurred_at && !form.value.occurred_at) { form.value.occurred_at = draft.occurred_at; aiFilledOccurredAt.value = true }
  receiptRawText.value = draft.raw_text
  receiptDraftTotal.value = draft.total
  receiptDraftTax.value = draft.tax
  receiptWarnings.value = draft.warnings
  receiptRegistrationNo.value = draft.registration_no
  receiptShopLearned.value = draft.shop_learned
  if (draft.lines.length) {
    if (await confirmDialog('読み取った明細で置き換えますか？', { message: '今の明細は消えます' })) {
      form.value.lines = draft.lines.map(l => ({
        name: l.name, unit_price: l.unit_price, quantity: l.quantity, category: l.category ?? 'packaging',
      }))
      aiFilledLines.value = new Set(form.value.lines.map((_, i) => i))
    }
  }
}

async function submit() {
  const lines = form.value.lines
    .filter(l => l.name.trim() && l.unit_price > 0)
    .map(l => ({ name: l.name.trim(), unit_price: Math.round(l.unit_price), quantity: l.quantity || 1, category: l.category }))

  if (!lines.length && (!form.value.amount || form.value.amount <= 0)) {
    toast('金額を入力してください', 'warn')
    return
  }

  const input: ExpenseInput = {
    occurred_at: form.value.occurred_at,
    receipt_temp_file: form.value.receipt_temp_file,
    receipt_registration_no: receiptRegistrationNo.value,
    month: form.value.month || null,
    shop: form.value.shop.trim() || null,
    category: lines.length ? lines[0].category! : form.value.category,
    amount: lines.length ? undefined : Math.round(form.value.amount),
    note: form.value.note.trim() || null,
    lines: lines.length ? lines : undefined,
  }

  if (editingId.value) {
    await window.soroban.updateExpense(editingId.value, input)
  } else {
    await window.soroban.createExpense(input)
  }

  showForm.value = false
  resetForm()
  await load()
  changed()
}

// --- ドロワー ---

const drawerExpense = ref<Expense | null>(null)
function openDrawer(e: Expense) {
  drawerExpense.value = e
}
function onDrawerEdit(e: Expense) {
  drawerExpense.value = null
  openEdit(e)
}
async function onDrawerChanged() {
  await load()
}

// --- 削除 ---

async function remove(e: Expense) {
  if (!await confirmDialog(`${e.occurred_at} の経費を削除しますか？`, {
    message: e.shop ? `${e.shop}` : undefined,
    okLabel: '削除する',
    danger: true,
  })) return
  await window.soroban.deleteExpense(e.id)
  if (drawerExpense.value?.id === e.id) drawerExpense.value = null
  await load()
  changed()
}
async function onDrawerDelete(e: Expense) {
  await remove(e)
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">経費</h1>
      <span class="grow" />
      <button class="primary" @click="toggleForm">
        <Icon :name="showForm ? 'close' : 'plus'" :size="16" />
        {{ showForm ? '閉じる' : '経費を登録' }}
      </button>
    </div>

    <!-- 登録・編集フォーム -->
    <div v-if="showForm" class="panel form">
      <p v-if="editingId" class="panel-title">経費を編集</p>

      <div class="receipt-scan">
        <div class="receipt-scan-main">
          <button class="ghost sm" :disabled="receiptBusy" @click="readReceiptForForm">
            <Icon name="receipt" :size="14" />
            {{ receiptBusy ? 'AI が読み取り中…（数秒）' : 'レシートを読み取る' }}
          </button>
          <button v-if="aiStatus && !aiStatus.configured" class="ghost sm" @click="goto('settings')">設定を開く</button>
          <span class="faint">画像を Google の Gemini に送って、店名・日付・明細・項目を推定して下に入れます（必ず確認してから登録）</span>
        </div>
        <div v-if="receiptPreviewUrl" class="receipt-scan-preview">
          <img class="receipt-scan-thumb" :src="receiptPreviewUrl" alt="" />
          <div class="receipt-scan-actions">
            <button class="ghost sm" :disabled="receiptBusy" @click="readReceiptForForm">別の画像を選ぶ</button>
            <button class="ghost sm" @click="clearReceiptDraft">画像を外す</button>
          </div>
        </div>
      </div>

      <p v-if="receiptTotalMismatch !== null" class="faint">
        レシートの合計 {{ yen(receiptTotalMismatch) }} と明細合計 {{ yen(lineSubtotal) }} が違います。明細を直してください
      </p>
      <p v-if="taxAddable" class="faint tax-add-row">
        レシートの合計と明細合計の差額 {{ yen(receiptDraftTax!) }} は消費税のようです。
        <button class="ghost sm" @click="addTaxLine">差額 {{ yen(receiptDraftTax!) }} を税として追加</button>
      </p>

      <div v-if="receiptWarnings.length" class="receipt-warnings faint">
        <p class="warnings-title">AI のメモ</p>
        <ul>
          <li v-for="(w, i) in receiptWarnings" :key="i">{{ w }}</li>
        </ul>
      </div>

      <details v-if="receiptRawText" class="receipt-raw">
        <summary>読み取ったテキストを見る</summary>
        <pre>{{ receiptRawText }}</pre>
      </details>

      <div class="fields">
        <label class="field">
          <span>購入店</span>
          <input
            v-model="form.shop" placeholder="任意" list="expense-shops"
            :class="{ 'ai-filled': aiFilledShop }" @input="aiFilledShop = false"
          />
          <datalist id="expense-shops">
            <option v-for="shop in shopOptions" :key="shop" :value="shop" />
          </datalist>
          <span v-if="receiptShopLearned" class="faint">前回の登録から</span>
        </label>
        <label class="field">
          <span>購入日</span>
          <input
            type="date" v-model="form.occurred_at"
            :class="{ 'ai-filled': aiFilledOccurredAt }" @input="aiFilledOccurredAt = false"
          />
        </label>
        <label class="field">
          <span>計上月</span>
          <input type="month" v-model="form.month" @change="monthTouched = true" />
          <span class="faint">基本は購入月。翌月に回すときだけ変える</span>
        </label>
      </div>

      <table v-if="form.lines.length" class="compact lines-table">
        <thead>
          <tr>
            <th>品名</th>
            <th class="num col-price">単価（税込）</th>
            <th class="num col-qty">数量</th>
            <th class="num col-amount">金額</th>
            <th class="col-category">項目</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(l, i) in form.lines" :key="i">
            <td>
              <input
                v-model="l.name" class="full" placeholder="品名"
                :class="{ 'ai-filled': aiFilledLines.has(i) }" @input="clearAiLine(i)"
              />
            </td>
            <td>
              <input
                type="number" v-model.number="l.unit_price" class="full"
                :class="{ 'ai-filled': aiFilledLines.has(i) }" @input="clearAiLine(i)"
              />
            </td>
            <td>
              <input
                type="number" v-model.number="l.quantity" class="full" min="1"
                :class="{ 'ai-filled': aiFilledLines.has(i) }" @input="clearAiLine(i)"
              />
            </td>
            <td class="num">{{ yen(lineAmount(l)) }}</td>
            <td>
              <select
                v-model="l.category" class="full"
                :class="{ 'ai-filled': aiFilledLines.has(i) }" @change="clearAiLine(i)"
              >
                <option v-for="o in CATEGORY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </td>
            <td class="actions">
              <button class="icon ghost" aria-label="削除" @click="removeLine(i)">
                <Icon name="trash" :size="16" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <button class="ghost sm add-line" @click="addLine">
        <Icon name="plus" :size="14" />
        明細を追加
      </button>

      <div v-if="form.lines.length" class="row">
        <span class="grow" />
        <span class="faint">明細合計 <strong>{{ yen(lineSubtotal) }}</strong></span>
      </div>

      <div v-if="!form.lines.length" class="fields">
        <label class="field">
          <span>合計（税込）</span>
          <input type="number" v-model.number="form.amount" />
        </label>
        <label class="field">
          <span>項目</span>
          <select v-model="form.category">
            <option v-for="o in CATEGORY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
      </div>

      <label class="field">
        <span>メモ</span>
        <input v-model="form.note" placeholder="任意" />
      </label>

      <p class="faint hint-row">レシートは登録後にドロワーから添付できます。金額はすべて税込</p>

      <div class="row">
        <span class="grow" />
        <button class="primary" @click="submit">{{ editingId ? '保存する' : '登録する' }}</button>
      </div>
    </div>

    <div class="toolbar">
      <select v-model="categoryFilter">
        <option value="">すべて</option>
        <option v-for="o in CATEGORY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <SearchBox v-model="searchText" placeholder="購入店・品名・メモを検索" />
      <PeriodSelect v-model="period" />
      <span class="grow" />
      <span class="faint">{{ filteredExpenses.length }}件 ／ 合計 {{ yen(periodTotal) }}</span>
    </div>

    <Skeleton v-if="!loaded" :rows="5" />

    <template v-else>
      <div v-if="sortedExpenses.length" class="panel table-panel">
        <table>
          <thead>
            <tr>
              <SortTh label="購入日" sort-key="occurred_at" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
              <SortTh label="購入店" sort-key="shop" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
              <th>内容</th>
              <th>項目</th>
              <SortTh label="計上月" sort-key="month" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
              <SortTh label="金額" sort-key="amount" align="right" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
              <th class="col-receipt">レシート</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in sortedExpenses" :key="e.id">
              <td class="faint nowrap">{{ e.occurred_at }}</td>
              <td class="nowrap">{{ e.shop || '—' }}</td>
              <td class="content-cell clickable" title="経費の詳細を見る" @click="openDrawer(e)">{{ contentLabel(e) }}</td>
              <td><StatusChip tone="neutral" :label="CATEGORY_LABEL[e.category]" /></td>
              <td class="nowrap">
                <span v-if="monthDiffers(e)" class="warn">計上 {{ e.month }}</span>
                <span v-else class="faint">—</span>
              </td>
              <td class="num">{{ yen(e.amount) }}</td>
              <td class="thumb-cell clickable" title="経費の詳細を見る" @click="openDrawer(e)">
                <img
                  v-if="showThumb(e)"
                  class="receipt-thumb"
                  :src="e.receipt_url!"
                  alt=""
                  loading="lazy"
                  @error="onThumbError(e.id)"
                />
                <span v-else class="faint">—</span>
              </td>
              <td class="actions">
                <button class="sm ghost" @click="openEdit(e)">編集</button>
                <button class="icon ghost" aria-label="削除" @click="remove(e)">
                  <Icon name="trash" :size="16" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <EmptyState
        v-else-if="searchText || categoryFilter"
        title="検索条件に一致する経費がありません"
      />

      <EmptyState
        v-else-if="!showForm"
        title="経費がまだありません。"
        hint="「経費を登録」から追加してください。"
      >
        <template #action>
          <button class="primary" @click="showForm = true">経費を登録</button>
        </template>
      </EmptyState>
    </template>

    <ExpenseDrawer
      :open="!!drawerExpense"
      :expense="drawerExpense"
      @close="drawerExpense = null"
      @edit="onDrawerEdit"
      @delete="onDrawerDelete"
      @changed="onDrawerChanged"
      @read-edit="onDrawerReadEdit"
    />
  </div>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-bottom: 16px;
}

.hint-row {
  margin: 0;
  font-size: var(--fs-13);
}

.receipt-scan {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 16px;
}
.receipt-scan-main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.receipt-scan-preview {
  display: flex;
  align-items: center;
  gap: 8px;
}
.receipt-scan-thumb {
  width: 96px;
  height: 96px;
  border-radius: var(--radius-sm);
  object-fit: cover;
}
.tax-add-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.receipt-warnings {
  font-size: var(--fs-12);
}
.warnings-title {
  margin: 0 0 4px;
  font-weight: 600;
}
.receipt-warnings ul {
  margin: 0;
  padding-left: 18px;
}

.ai-filled {
  border-color: var(--brand) !important;
}

.receipt-scan-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.receipt-raw {
  font-size: var(--fs-13);
}
.receipt-raw summary {
  cursor: pointer;
  color: var(--text-faint);
}
.receipt-raw pre {
  margin: 8px 0 0;
  padding: 10px;
  background: var(--surface-hi);
  border-radius: var(--radius-sm);
  white-space: pre-wrap;
  max-height: 220px;
  overflow: auto;
}

.lines-table .col-price { width: 130px; }
.lines-table .col-qty { width: 80px; }
.lines-table .col-amount { width: 110px; }
.lines-table .col-category { width: 130px; }
.lines-table .col-actions { width: 36px; }
.full { width: 100%; }

.add-line { align-self: flex-start; }

.table-panel { padding: 0; overflow: hidden; }
.table-panel td.actions { white-space: nowrap; text-align: right; }
.table-panel .actions > * { vertical-align: middle; margin-left: 4px; }
.table-panel th.col-receipt { width: 72px; }
.clickable { cursor: pointer; }

.content-cell {
  max-width: 320px;
  white-space: normal;
  word-break: break-word;
}

.thumb-cell { padding-right: 4px; }
.receipt-thumb {
  display: block;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  object-fit: cover;
}
</style>
