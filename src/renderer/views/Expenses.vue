<script setup lang="ts">
// 経費タブ：レシート1枚＝経費1件。購入店・購入日・明細・金額・レシート画像・計上月を管理する。
// 月次の按分・純利益はこの経費を月（計上月）で拾う（Monthly.vue 側。ここでは再計算しない）。
//
// 画面は「上に項目別サマリ、左に一覧（月で区切り）、右にレシート画像×フォーム」の3段。
// 右ペインは選んだ経費の編集、または新規登録（レシートを読み取る／手で登録）のどちらかを表示する。
// AI が読んだ位置（ReceiptDraft.boxes / lines[].box）はレシート画像の上に半透明の枠で重ね、
// フォームの欄にフォーカス・ホバーすると濃くなる。枠をクリックすると欄にフォーカスする。
import { ref, onMounted, computed, watch, inject, type Ref } from 'vue'
import type {
  AiStatus, Expense, ExpenseCategory, ExpenseInput, ExpenseLineInput,
  ReceiptBox, ReceiptDraft,
} from '../../shared/types'
import { thisMonthLocal, todayLocal } from '../../shared/date'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import StatusPill from '../components/StatusPill.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import SearchBox, { matchesSearch } from '../components/SearchBox.vue'
import PeriodSelect, { inPeriod, type Period } from '../components/PeriodSelect.vue'
import { yen } from '../format'

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
/** 上の「消耗品・その他」カードにまとめる項目 */
const OTHER_CATEGORIES: ExpenseCategory[] = ['supplies', 'fee', 'transfer_fee', 'other']

const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!
const goto = inject<(t: string) => void>('goto')!

const expenses = ref<Expense[]>([])
const loaded = ref(false)
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

async function load() {
  expenses.value = await window.soroban.listExpenses()
  aiStatus.value = await window.soroban.getAiStatus()
  loaded.value = true
}
onMounted(load)
watch(revision, load)

// --- 検索・期間・項目・並び替え（一覧だけを絞る。上のサマリは常に今月／先月） ---

const searchText = ref('')
const period = ref<Period>('this_month')
const categoryFilter = ref<ExpenseCategory | ''>('')

type SortOrder = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc'
const sortOrder = ref<SortOrder>('date_desc')
/** 日付順のときだけ月で区切る。金額順は区切りの意味が無いのでフラットに出す */
const isDateSort = computed(() => sortOrder.value === 'date_desc' || sortOrder.value === 'date_asc')

const filteredExpenses = computed(() =>
  expenses.value.filter(e =>
    (categoryFilter.value === '' || e.category === categoryFilter.value || e.lines.some(l => l.category === categoryFilter.value)) &&
    matchesSearch([e.shop, e.note, ...e.lines.map(l => l.name)], searchText.value) &&
    // 経費は計上月（month）で数える。期間は日付前提なので月の初日を当てる
    inPeriod(`${e.month}-01`, period.value),
  ),
)
const periodTotal = computed(() => filteredExpenses.value.reduce((s, e) => s + e.amount, 0))

const sortedExpenses = computed(() => {
  const list = [...filteredExpenses.value]
  switch (sortOrder.value) {
    case 'date_asc':
      return list.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id))
    case 'amount_desc':
      return list.sort((a, b) => b.amount - a.amount)
    case 'amount_asc':
      return list.sort((a, b) => a.amount - b.amount)
    default:
      return list.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.id.localeCompare(a.id))
  }
})

/** 一覧は購入日の月で区切る（計上月とは別。ずれている行は行内のピルで示す）。金額順のときは区切らない */
const displayGroups = computed(() => {
  const sorted = sortedExpenses.value
  if (!isDateSort.value) return [{ month: null as string | null, items: sorted }]
  const map = new Map<string, Expense[]>()
  for (const e of sorted) {
    const key = e.occurred_at.slice(0, 7)
    const arr = map.get(key)
    if (arr) arr.push(e)
    else map.set(key, [e])
  }
  const entries = [...map.entries()]
  entries.sort((a, b) => sortOrder.value === 'date_asc' ? a[0].localeCompare(b[0]) : b[0].localeCompare(a[0]))
  return entries.map(([month, items]) => ({ month: month as string | null, items }))
})

function contentLabel(e: Expense): string {
  if (!e.lines.length) return e.note?.trim() || '—'
  if (e.lines.length === 1) return e.lines[0].name
  return `${e.lines[0].name} ほか${e.lines.length - 1}点`
}

function monthDiffers(e: Expense): boolean {
  return e.month !== e.occurred_at.slice(0, 7)
}

/** 行の項目チップ（明細があれば明細の項目の重複無し集合、無ければ代表の項目） */
function rowCategories(e: Expense): ExpenseCategory[] {
  if (!e.lines.length) return [e.category]
  return [...new Set(e.lines.map(l => l.category))]
}

// --- レシートのサムネイル。読み込み失敗したら以後「なし」に固定する ---
const thumbFailed = ref<Set<string>>(new Set())
function showThumb(e: Expense): boolean {
  return !!e.receipt_url && !thumbFailed.value.has(e.id)
}
function onThumbError(id: string) {
  thumbFailed.value = new Set(thumbFailed.value).add(id)
}
/** レシート画像が無いときの頭文字（Products.vue の placeholderChar と同じ考え方） */
function placeholderChar(shop: string | null): string {
  const c = (shop ?? '').trim().charAt(0)
  return (c || '?').toUpperCase()
}

// --- 上の項目別サマリ（今月・先月。一覧の絞り込みの影響を受けない） ---

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const currentMonth = computed(() => thisMonthLocal())
const lastMonth = computed(() => shiftMonth(currentMonth.value, -1))

function monthList(month: string): Expense[] {
  return expenses.value.filter(e => e.month === month)
}
const thisMonthList = computed(() => monthList(currentMonth.value))
const lastMonthList = computed(() => monthList(lastMonth.value))

/** 経費 1 件のうち、指定した項目群に属する金額（明細があれば明細から、無ければ代表項目から） */
function categoryGroupAmount(e: Expense, cats: ExpenseCategory[]): number {
  if (e.lines.length) return e.lines.filter(l => cats.includes(l.category)).reduce((s, l) => s + l.amount, 0)
  return cats.includes(e.category) ? e.amount : 0
}
function sumCategoryGroup(list: Expense[], cats: ExpenseCategory[]): number {
  return list.reduce((s, e) => s + categoryGroupAmount(e, cats), 0)
}

const thisMonthTotal = computed(() => thisMonthList.value.reduce((s, e) => s + e.amount, 0))
const packagingThisMonth = computed(() => sumCategoryGroup(thisMonthList.value, ['packaging']))
const packagingLastMonth = computed(() => sumCategoryGroup(lastMonthList.value, ['packaging']))
const shippingThisMonth = computed(() => sumCategoryGroup(thisMonthList.value, ['shipping']))
const shippingLastMonth = computed(() => sumCategoryGroup(lastMonthList.value, ['shipping']))
const otherThisMonth = computed(() => sumCategoryGroup(thisMonthList.value, OTHER_CATEGORIES))
const otherLastMonth = computed(() => sumCategoryGroup(lastMonthList.value, OTHER_CATEGORIES))

/** 今月買って、計上月だけ来月に回した金額（今月の合計には含まれない） */
const carriedToNextMonth = computed(() => {
  const next = shiftMonth(currentMonth.value, 1)
  return expenses.value
    .filter(e => e.occurred_at.slice(0, 7) === currentMonth.value && e.month === next)
    .reduce((s, e) => s + e.amount, 0)
})

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

// --- 右ペイン：選んだ経費、または新規 ---

const editingId = ref<string | null>(null)
const showForm = ref(false)
const editingExpense = computed(() => expenses.value.find(e => e.id === editingId.value) ?? null)
const expenseHasReceipt = computed(() => !!editingExpense.value?.receipt_url)

/** 計上月を人が触ったら true。購入日を変えても以後は自動追随しない */
const monthTouched = ref(false)

watch(() => form.value.occurred_at, (v) => {
  if (!monthTouched.value) form.value.month = v.slice(0, 7)
})

const expanded = ref(false)

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
  expanded.value = false
  clearReceiptDraft()
}

/** 「手で登録」。空のフォームを右ペインに開く */
function newBlank() {
  resetForm()
  showForm.value = true
}

/** 「レシートを読み取って登録」。右ペインを新規で開き、そのまま読み取りに入る */
async function newFromReceipt() {
  resetForm()
  showForm.value = true
  await readReceiptForForm()
}

/** 一覧の行を選ぶ＝そのまま編集フォームを開く */
function selectRow(e: Expense) {
  editingId.value = e.id
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
  expanded.value = false
  clearReceiptDraft()
  showForm.value = true
}

function closePane() {
  showForm.value = false
  resetForm()
}

function addLine() {
  form.value.lines.push(blankLine())
  lineBoxes.value.push(null)
}
function removeLine(i: number) {
  form.value.lines.splice(i, 1)
  lineBoxes.value.splice(i, 1)
}

function lineAmount(l: LineForm): number {
  return (l.unit_price || 0) * (l.quantity || 1)
}
const lineSubtotal = computed(() => form.value.lines.reduce((s, l) => s + lineAmount(l), 0))

// --- レシートを読み取る（OCR の下書きをフォームに入れる） ---

const receiptBusy = ref(false)
const rereadBusy = ref(false)
const attachBusy = ref(false)
const removeBusy = ref(false)
/** 画像を選んで読んだときだけ入る（新規登録のプレビュー用）。添付済みレシートの再読み取りでは入らない（画像は変わらない） */
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
/** AI が読んだ店名・日付・合計の画像上の位置（確認用の枠） */
const draftBoxes = ref<{ shop: ReceiptBox | null; date: ReceiptBox | null; total: ReceiptBox | null } | null>(null)
/** 各明細行の画像上の位置。form.lines と同じ並び（行の追加・削除に合わせて動かす） */
const lineBoxes = ref<Array<ReceiptBox | null>>([])

/** 右ペインに表示する画像。新規で読んだプレビューが優先、無ければ編集中の経費に添付済みの画像 */
const displayImageUrl = computed(() => receiptPreviewUrl.value ?? editingExpense.value?.receipt_url ?? null)

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
  lineBoxes.value.push(null)
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
  draftBoxes.value = null
  lineBoxes.value = []
  focusedBox.value = null
  hoveredBox.value = null
}

/** 読み取った下書きをフォームへ反映する。draft の値がある項目だけ上書きする。
 * confirmLines のときは、明細を置き換える前に確認する（編集中の経費を読み直すとき） */
async function applyDraft(draft: ReceiptDraft, opts: { confirmLines?: boolean } = {}) {
  receiptRawText.value = draft.raw_text
  receiptDraftTotal.value = draft.total
  receiptDraftTax.value = draft.tax
  receiptWarnings.value = draft.warnings
  receiptRegistrationNo.value = draft.registration_no
  receiptShopLearned.value = draft.shop_learned
  draftBoxes.value = draft.boxes
  if (draft.shop) { form.value.shop = draft.shop; aiFilledShop.value = true }
  if (draft.occurred_at) { form.value.occurred_at = draft.occurred_at; aiFilledOccurredAt.value = true }
  if (draft.lines.length) {
    const proceed = opts.confirmLines
      ? await confirmDialog('読み取った明細で置き換えますか？', { message: '今の明細は消えます' })
      : true
    if (proceed) {
      form.value.lines = draft.lines.map(l => ({
        name: l.name, unit_price: l.unit_price, quantity: l.quantity, category: l.category ?? 'packaging',
      }))
      lineBoxes.value = draft.lines.map(l => l.box ?? null)
      aiFilledLines.value = new Set(form.value.lines.map((_, i) => i))
    }
  }
}

/** 新規登録：画像を選んで読む */
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
    if (result) {
      form.value.receipt_temp_file = result.temp_file
      receiptPreviewUrl.value = result.receipt_url
      await applyDraft(result.draft)
    }
  } catch (e: any) {
    toast(e.message, 'warn')
  } finally {
    receiptBusy.value = false
  }
}

/** 編集中：添付済みの画像をもう一度読み取る（画像そのものは変わらない） */
async function readReceiptForEdit() {
  if (!editingId.value) return
  const status = await window.soroban.getAiStatus()
  aiStatus.value = status
  if (!status.configured) {
    toast('AI 読み取りの設定がありません', 'warn')
    return
  }
  rereadBusy.value = true
  try {
    const draft = await window.soroban.readReceipt(editingId.value)
    await applyDraft(draft, { confirmLines: true })
  } catch (e: any) {
    toast(e.message, 'warn')
  } finally {
    rereadBusy.value = false
  }
}

/** 編集中：レシート画像を添付／差し替える */
async function attachForEdit() {
  if (!editingId.value) return
  attachBusy.value = true
  try {
    const url = await window.soroban.attachReceipt(editingId.value)
    if (url) await load()
  } finally {
    attachBusy.value = false
  }
}

/** 編集中：レシート画像を外す */
async function removeForEdit() {
  if (!editingId.value) return
  removeBusy.value = true
  try {
    await window.soroban.removeReceipt(editingId.value)
    expanded.value = false
    await load()
  } finally {
    removeBusy.value = false
  }
}

// --- AI が読んだ位置の枠（半透明）。フォーカス・ホバーで濃くする。枠クリックで欄にフォーカスする ---

type BoxKey = 'shop' | 'date' | 'total' | number | null

const hoveredBox = ref<BoxKey>(null)
const focusedBox = ref<BoxKey>(null)
/** フォーカス優先（フォーカス中はホバーが外れても濃いまま） */
const activeBox = computed<BoxKey>(() => focusedBox.value ?? hoveredBox.value)

function onBoxHover(key: BoxKey) { hoveredBox.value = key }
function onBoxHoverLeave(key: BoxKey) { if (hoveredBox.value === key) hoveredBox.value = null }
function onBoxFocus(key: BoxKey) { focusedBox.value = key }
function onBoxBlur(key: BoxKey) { if (focusedBox.value === key) focusedBox.value = null }

const shopInputEl = ref<HTMLInputElement | null>(null)
const dateInputEl = ref<HTMLInputElement | null>(null)
const lineNameInputEls = ref<Array<HTMLInputElement | null>>([])
function setLineNameInputEl(i: number, el: HTMLInputElement | null) {
  lineNameInputEls.value[i] = el
}

/** 枠をクリックしたら対応する欄にフォーカスする。合計は入力欄が無いので枠のハイライトだけ切り替える */
function focusBoxTarget(key: BoxKey) {
  if (key === 'shop') shopInputEl.value?.focus()
  else if (key === 'date') dateInputEl.value?.focus()
  else if (key === 'total') focusedBox.value = focusedBox.value === 'total' ? null : 'total'
  else if (typeof key === 'number') lineNameInputEls.value[key]?.focus()
}

function boxStyle(box: ReceiptBox) {
  const [ymin, xmin, ymax, xmax] = box
  return {
    top: `${ymin / 10}%`,
    left: `${xmin / 10}%`,
    height: `${(ymax - ymin) / 10}%`,
    width: `${(xmax - xmin) / 10}%`,
  }
}

// --- 保存・削除 ---

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

  // 計上月がいまの期間の外だと、保存した経費が一覧から消えて「入れたのに無い」と見える。
  // その月が見える期間（すべて）に切り替えてから読み直す
  const savedMonth = input.month ?? thisMonthLocal()
  showForm.value = false
  resetForm()
  if (!inPeriod(savedMonth + '-01', period.value)) {
    period.value = 'all'
    toast('計上月が今の期間の外なので、期間を「すべて」にしました', 'ok')
  }
  await load()
  changed()
}

async function remove(e: Expense) {
  if (!await confirmDialog(`${e.occurred_at} の経費を削除しますか？`, {
    message: e.shop ? `${e.shop}` : undefined,
    okLabel: '削除する',
    danger: true,
  })) return
  await window.soroban.deleteExpense(e.id)
  if (editingId.value === e.id) { showForm.value = false; resetForm() }
  await load()
  changed()
}

async function deleteCurrent() {
  if (editingExpense.value) await remove(editingExpense.value)
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">経費</h1>
      <span class="grow" />
      <span v-if="aiStatus && !aiStatus.configured" class="faint ai-warn">
        <Icon name="alert" :size="14" />
        AI 読み取りの設定がありません
        <button class="ghost sm" @click="goto('settings')">設定を開く</button>
      </span>
      <button class="primary" :disabled="receiptBusy" @click="newFromReceipt">
        <Icon name="sparkle" :size="16" />
        {{ receiptBusy ? 'AI が読み取り中…（数秒）' : 'レシートを読み取って登録' }}
      </button>
      <button class="ghost" @click="newBlank">手で登録</button>
    </div>

    <Skeleton v-if="!loaded" kind="stats" :rows="4" />
    <div v-else class="stat-grid">
      <div class="stat-card">
        <span class="stat-card-label">今月の経費</span>
        <span class="stat-card-value">{{ yen(thisMonthTotal) }}</span>
        <span class="stat-card-sub">{{ thisMonthList.length }}件 ・ 純利益から引かれる</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">梱包費</span>
        <span class="stat-card-value">{{ yen(packagingThisMonth) }}</span>
        <span class="stat-card-sub">先月 {{ yen(packagingLastMonth) }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">送料</span>
        <span class="stat-card-value">{{ yen(shippingThisMonth) }}</span>
        <span class="stat-card-sub">先月 {{ yen(shippingLastMonth) }}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">消耗品・その他</span>
        <span class="stat-card-value">{{ yen(otherThisMonth) }}</span>
        <span class="stat-card-sub">
          <template v-if="carriedToNextMonth > 0">翌月に回した {{ yen(carriedToNextMonth) }} は含まない</template>
          <template v-else>先月 {{ yen(otherLastMonth) }}</template>
        </span>
      </div>
    </div>

    <div class="layout">
      <!-- 左：一覧（月で区切り） -->
      <div class="panel list-panel">
        <div class="list-toolbar">
          <SearchBox v-model="searchText" placeholder="購入店・品名・メモを検索" />
          <select v-model="categoryFilter">
            <option value="">すべての項目</option>
            <option v-for="o in CATEGORY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <PeriodSelect v-model="period" />
          <select v-model="sortOrder">
            <option value="date_desc">新しい順</option>
            <option value="date_asc">古い順</option>
            <option value="amount_desc">金額が大きい順</option>
            <option value="amount_asc">金額が小さい順</option>
          </select>
          <span class="grow" />
          <span class="toolbar-count">{{ filteredExpenses.length }} 件 ・ 合計 {{ yen(periodTotal) }}</span>
        </div>

        <Skeleton v-if="!loaded" :rows="6" />
        <template v-else-if="filteredExpenses.length">
          <template v-for="g in displayGroups" :key="g.month ?? 'flat'">
            <div v-if="g.month" class="month-head">{{ g.month }}</div>
            <button
              v-for="e in g.items" :key="e.id" type="button"
              class="expense-row" :class="{ on: e.id === editingId }"
              @click="selectRow(e)"
            >
              <span class="row-thumb">
                <img
                  v-if="showThumb(e)" :src="e.receipt_url!" alt=""
                  loading="lazy" @error="onThumbError(e.id)"
                />
                <span v-else class="row-thumb-empty">{{ placeholderChar(e.shop) }}</span>
              </span>
              <span class="row-main">
                <span class="row-labels">
                  <StatusChip v-for="c in rowCategories(e)" :key="c" tone="neutral" :label="CATEGORY_LABEL[c]" />
                  <StatusPill v-if="monthDiffers(e)" tone="warn" :label="'計上 ' + e.month" />
                  <StatusPill v-if="e.receipt_url" tone="ok" label="読み取り" />
                </span>
                <span class="row-title one-line" :title="e.shop || '—'">{{ e.shop || '—' }}</span>
                <span class="row-sub" :title="`${e.occurred_at} ・ ${contentLabel(e)}`">{{ e.occurred_at }} ・ {{ contentLabel(e) }}</span>
              </span>
              <span class="row-amt num">{{ yen(e.amount) }}</span>
            </button>
          </template>
        </template>
        <EmptyState
          v-else-if="searchText || categoryFilter || period !== 'all'"
          title="検索条件に一致する経費がありません"
        />
        <EmptyState v-else title="経費がまだありません" hint="上のボタンから登録してください" />
      </div>

      <!-- 右：レシート画像 × フォーム -->
      <div v-if="showForm" class="panel detail-panel">
        <div class="receipt-pane">
          <div class="receipt-frame" :class="{ empty: !displayImageUrl }">
            <template v-if="displayImageUrl">
              <img
                class="receipt-img" :class="{ expanded }"
                :src="displayImageUrl" alt="レシート画像"
                @click="expanded = !expanded"
              />
              <div class="boxes-overlay">
                <div
                  v-if="draftBoxes?.shop" class="box" :class="{ active: activeBox === 'shop' }"
                  :style="boxStyle(draftBoxes.shop)" title="購入店を読んだ位置"
                  @click="focusBoxTarget('shop')"
                />
                <div
                  v-if="draftBoxes?.date" class="box" :class="{ active: activeBox === 'date' }"
                  :style="boxStyle(draftBoxes.date)" title="購入日を読んだ位置"
                  @click="focusBoxTarget('date')"
                />
                <div
                  v-if="draftBoxes?.total" class="box" :class="{ active: activeBox === 'total' }"
                  :style="boxStyle(draftBoxes.total)" title="合計を読んだ位置"
                  @click="focusBoxTarget('total')"
                />
                <div
                  v-for="(b, i) in lineBoxes" v-show="!!b" :key="'lb' + i" class="box"
                  :class="{ active: activeBox === i }"
                  :style="b ? boxStyle(b) : {}" title="明細を読んだ位置"
                  @click="focusBoxTarget(i)"
                />
              </div>
            </template>
            <div v-else class="receipt-empty faint">
              <Icon name="receipt" :size="22" />
              <span>レシート画像はありません</span>
            </div>
          </div>

          <div class="receipt-ops">
            <button v-if="displayImageUrl" class="sm ghost" @click="expanded = !expanded">{{ expanded ? '縮小' : '拡大' }}</button>
            <button
              v-if="editingId && expenseHasReceipt" class="sm ghost" :disabled="rereadBusy"
              @click="readReceiptForEdit"
            >
              <Icon name="sparkle" :size="12" />
              {{ rereadBusy ? '読み取り中…' : 'もう一度読み取る' }}
            </button>
            <button v-if="editingId" class="sm ghost" :disabled="attachBusy" @click="attachForEdit">
              {{ expenseHasReceipt ? '画像を差し替え' : 'レシートを添付' }}
            </button>
            <button v-if="editingId && expenseHasReceipt" class="sm ghost" :disabled="removeBusy" @click="removeForEdit">外す</button>
            <button
              v-if="!editingId" class="sm ghost" :disabled="receiptBusy"
              @click="readReceiptForForm"
            >
              <Icon name="sparkle" :size="12" />
              {{ receiptBusy ? 'AI が読み取り中…' : (displayImageUrl ? '別の画像を選ぶ' : 'レシートを読み取る') }}
            </button>
            <button v-if="!editingId && displayImageUrl" class="sm ghost" @click="clearReceiptDraft">画像を外す</button>
          </div>
        </div>

        <div class="form-pane">
          <div class="form-head">
            <span class="row-labels">
              <StatusPill v-if="receiptShopLearned" tone="ok" label="登録番号で店名を確認" />
            </span>
            <h2 class="form-title row-title" :title="form.shop || (editingId ? '経費を編集' : '経費を登録')">{{ form.shop || (editingId ? '経費を編集' : '経費を登録') }}</h2>
          </div>

          <div class="fields">
            <label class="field">
              <span>購入店</span>
              <input
                ref="shopInputEl"
                v-model="form.shop" placeholder="任意" list="expense-shops"
                :class="{ 'ai-filled': aiFilledShop }"
                @input="aiFilledShop = false"
                @focus="onBoxFocus('shop')" @blur="onBoxBlur('shop')"
                @mouseenter="onBoxHover('shop')" @mouseleave="onBoxHoverLeave('shop')"
              />
              <datalist id="expense-shops">
                <option v-for="shop in shopOptions" :key="shop" :value="shop" />
              </datalist>
            </label>
            <label class="field">
              <span>購入日</span>
              <input
                ref="dateInputEl"
                type="date" v-model="form.occurred_at"
                :class="{ 'ai-filled': aiFilledOccurredAt }"
                @input="aiFilledOccurredAt = false"
                @focus="onBoxFocus('date')" @blur="onBoxBlur('date')"
                @mouseenter="onBoxHover('date')" @mouseleave="onBoxHoverLeave('date')"
              />
            </label>
            <label class="field">
              <span>計上月</span>
              <input type="month" v-model="form.month" @change="monthTouched = true" />
              <span class="faint">基本は購入月。翌月に回すときだけ変える</span>
            </label>
          </div>

          <table v-if="form.lines.length" class="compact lines-table">
            <colgroup>
              <col />
              <col class="col-price" />
              <col class="col-qty" />
              <col class="col-amount" />
              <col class="col-category" />
              <col class="col-actions" />
            </colgroup>
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
              <tr
                v-for="(l, i) in form.lines" :key="i"
                @mouseenter="onBoxHover(i)" @mouseleave="onBoxHoverLeave(i)"
                @focusin="onBoxFocus(i)" @focusout="onBoxBlur(i)"
              >
                <td>
                  <input
                    :ref="(el) => setLineNameInputEl(i, el as HTMLInputElement | null)"
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

          <div v-if="form.lines.length" class="row totals-row-line">
            <span class="grow" />
            <span class="faint">明細合計 <strong>{{ yen(lineSubtotal) }}</strong></span>
            <span
              v-if="receiptDraftTotal != null" class="faint total-readout"
              :class="{ active: activeBox === 'total' }"
              @mouseenter="onBoxHover('total')" @mouseleave="onBoxHoverLeave('total')"
            >レシートの合計 <strong>{{ yen(receiptDraftTotal) }}</strong></span>
          </div>

          <p v-if="receiptTotalMismatch !== null" class="faint">
            レシートの合計 {{ yen(receiptTotalMismatch) }} と明細合計 {{ yen(lineSubtotal) }} が違います。明細を直してください
          </p>
          <p v-if="taxAddable" class="faint tax-add-row">
            レシートの合計と明細合計の差額 {{ yen(receiptDraftTax!) }} は消費税のようです。
            <button class="ghost sm" @click="addTaxLine">差額 {{ yen(receiptDraftTax!) }} を税として追加</button>
          </p>

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

          <label class="field">
            <span>メモ</span>
            <input v-model="form.note" placeholder="任意" />
          </label>

          <p class="faint hint-row">金額はすべて税込</p>

          <div class="row form-foot">
            <button v-if="editingId" class="danger" @click="deleteCurrent">削除</button>
            <span class="grow" />
            <button class="ghost" @click="closePane">閉じる</button>
            <button class="primary" @click="submit">{{ editingId ? '保存する' : '登録する' }}</button>
          </div>
        </div>
      </div>
      <div v-else class="panel detail-empty">
        <EmptyState title="経費を選んでください" hint="左の一覧から選ぶか、上のボタンからレシートを読み取って登録します" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-warn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-13);
  color: var(--warn);
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}

.layout {
  display: grid;
  grid-template-columns: 340px 1fr;
  gap: 16px;
  align-items: start;
}

/* --- 左：一覧 --- */

.list-panel { padding: 0; overflow: hidden; }

.list-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line-soft);
}

.month-head {
  padding: 6px 14px;
  font-size: var(--fs-11);
  font-weight: 600;
  letter-spacing: .04em;
  color: var(--text-faint);
  background: var(--surface-hi);
}

.expense-row {
  display: grid;
  grid-template-columns: 40px 1fr auto;
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 10px 14px;
  border-top: 1px solid var(--line-soft);
  border-radius: 0;
  background: var(--surface);
  height: auto;
  text-align: left;
  cursor: pointer;
}
.expense-row:hover:not(:disabled) { background: var(--surface-hi); }
.expense-row.on { background: var(--brand-soft); }

.row-thumb {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  flex-shrink: 0;
  display: flex;
}
.row-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.row-thumb-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-weight: 700;
  font-size: var(--fs-14);
}

.row-main { min-width: 0; display: flex; flex-direction: column; justify-content: center; }

.row-amt {
  font-size: var(--fs-14);
  font-weight: 700;
  white-space: nowrap;
}

/* --- 右：レシート画像 × フォーム --- */

.detail-panel {
  display: grid;
  grid-template-columns: minmax(200px, 260px) 1fr;
  gap: 20px;
  align-items: start;
  container-type: inline-size;
}
.detail-empty { display: flex; }

/* 右ペインの幅が 700px を切ったら、画像を上・フォームを下に縦積みにする */
@container (max-width: 700px) {
  .detail-panel {
    grid-template-columns: 1fr;
  }
  .receipt-frame:not(.empty) { height: 260px; }
  .receipt-img { height: 100%; max-height: none; object-fit: contain; }
}

.receipt-pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.receipt-frame {
  position: relative;
  border-radius: var(--radius-md);
  background: var(--surface-hi);
  overflow: hidden;
}
.receipt-frame.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 220px;
}
.receipt-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-13);
}
.receipt-img {
  display: block;
  width: 100%;
  max-height: 420px;
  object-fit: contain;
  cursor: zoom-in;
}
.receipt-img.expanded {
  max-height: 76vh;
  cursor: zoom-out;
}

.boxes-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.box {
  position: absolute;
  border: 1.5px solid color-mix(in srgb, var(--brand) 65%, transparent);
  background: color-mix(in srgb, var(--brand) 30%, transparent);
  border-radius: var(--radius-sm);
  pointer-events: auto;
  cursor: pointer;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.box.active {
  background: color-mix(in srgb, var(--brand) 55%, transparent);
  border-color: var(--brand-hover);
}

.receipt-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.receipt-ops button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.form-pane {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.form-head {
  display: flex;
  flex-direction: column;
}
.form-title {
  margin: 0;
  font-size: var(--fs-16);
  min-width: 0;
}

.hint-row {
  margin: 0;
  font-size: var(--fs-13);
}

.tax-add-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.receipt-warnings { font-size: var(--fs-12); }
.warnings-title { margin: 0 0 4px; font-weight: 600; }
.receipt-warnings ul { margin: 0; padding-left: 18px; }

.ai-filled { border-color: var(--brand) !important; }

.receipt-raw { font-size: var(--fs-13); }
.receipt-raw summary { cursor: pointer; color: var(--text-faint); }
.receipt-raw pre {
  margin: 8px 0 0;
  padding: 10px;
  background: var(--surface-hi);
  border-radius: var(--radius-sm);
  white-space: pre-wrap;
  max-height: 220px;
  overflow: auto;
}

.lines-table { table-layout: fixed; }
.lines-table col.col-price { width: 78px; }
.lines-table col.col-qty { width: 52px; }
.lines-table col.col-amount { width: 72px; }
.lines-table col.col-category { width: 92px; }
.lines-table col.col-actions { width: 22px; }
.lines-table th, .lines-table td { padding: 6px 8px; }
.lines-table input, .lines-table select {
  padding: 6px;
  height: 30px;
  font-size: var(--fs-13);
}
.full { width: 100%; }

.add-line { align-self: flex-start; }

.totals-row-line { flex-wrap: wrap; }
.total-readout {
  border-radius: var(--radius-sm);
  padding: 2px 6px;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.total-readout.active {
  background: var(--brand-soft);
  color: var(--brand-ink);
}

.form-foot { align-items: center; }

@media (max-width: 1099px) {
  .stat-grid { grid-template-columns: repeat(2, 1fr); }
  .layout { grid-template-columns: 1fr; }
  .detail-panel { grid-template-columns: 1fr; }
}
</style>
