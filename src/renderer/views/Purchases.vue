<script setup lang="ts">
import { ref, onMounted, computed, watch, inject, nextTick, type Ref } from 'vue'
import type {
  PurchaseSummary, ShopAccount, PurchaseLineInput, AllocMethod, PurchaseInput, Tag, Fulfillment,
  PurchaseAccountCard,
} from '../../shared/types'
import { todayLocal } from '../../shared/date'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import TagPicker from '../components/TagPicker.vue'
import PurchaseDrawer from '../components/PurchaseDrawer.vue'
import PurchaseCsvDrawer from '../components/PurchaseCsvDrawer.vue'
import SearchBox, { matchesSearch } from '../components/SearchBox.vue'
import PeriodSelect, { inPeriod, periodRange, type Period } from '../components/PeriodSelect.vue'
import SortTh from '../components/SortTh.vue'
import { useSort } from '../composables/useSort'
import type { PromptOptions } from '../components/InputDialog.vue'
import type { ConfirmChoice } from '../components/ConfirmDialog.vue'

type SortKey = 'ordered_at' | 'subtotal' | 'shipping_fee' | 'total_cost'
type ShipStageState = 'done' | 'now' | 'pending'
interface ShipStage { label: string; state: ShipStageState }

const MODEL_CODE_PREVIEW_RE = /【?([A-Z]\d{3}(?:-\d+)?)】?/

const purchases = ref<PurchaseSummary[]>([])
const accounts = ref<ShopAccount[]>([])
const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
const ask = inject<(title: string, opts?: PromptOptions) => Promise<string | null>>('prompt')!
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const choose = inject<(title: string, choices: ConfirmChoice[], opts?: { message?: string }) => Promise<string | null>>('choose')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!
// 横断検索から goto('purchases', { search, focusId }) で開かれる
const gotoPayload = inject<Ref<{ search?: string; focusId?: string } | null>>('gotoPayload', ref(null))
const showForm = ref(false)
const showCsvDrawer = ref(false)
const loaded = ref(false)
/** 下書きを確定中の仕入 id。null なら新規登録 */
const editingId = ref<string | null>(null)

const form = ref({
  shop_account_id: '',
  ordered_at: todayLocal(),
  order_no: '',
  shipping_fee: 0,
  other_cost: 0,
  discount: 0,
  alloc_method: 'by_amount' as AllocMethod,
  note: '' as string,
  fulfillment: null as Fulfillment | null,
  lines: [{ name: '', unit_price: 0, quantity: 1 }] as PurchaseLineInput[],
})

const yen = (n: number) => '¥' + n.toLocaleString('ja-JP')

// --- サムネイル。仕入は画像を持たないためプレースホルダのみ（仕入先名の頭文字） ---
function shopMarkChar(p: PurchaseSummary): string {
  const name = p.shop_account_name?.trim()
  return name ? name.charAt(0) : '—'
}

/** MM-DD だけ（年をまたぐ表示は他画面でも省いている） */
function shortDate(d: string | null): string {
  return d ? d.slice(5) : ''
}

/**
 * 配送の進行：注文 › 発送 › 配送中 › 到着。fulfillment が 'delivered' または
 * null（手入力で分からない）は全段「到着」まで点灯（PurchaseDrawer と同じ扱い）
 */
function shippingStages(p: Pick<PurchaseSummary, 'fulfillment' | 'shipped_at' | 'delivered_at'>): ShipStage[] {
  const f = p.fulfillment
  const shipped = f === 'shipped' || f === 'delivered' || f === null
  const delivered = f === 'delivered' || f === null
  return [
    { label: '注文', state: 'done' },
    { label: p.shipped_at ? `発送 ${shortDate(p.shipped_at)}` : '発送', state: shipped ? 'done' : 'now' },
    { label: '配送中', state: delivered ? 'done' : (f === 'shipped' ? 'now' : 'pending') },
    { label: p.delivered_at ? `到着 ${shortDate(p.delivered_at)}` : '到着', state: delivered ? 'done' : 'pending' },
  ]
}

// --- 並び替え（列見出しクリック） ---

const { sortKey, sortDir, toggle, sortRows } = useSort<SortKey>('ordered_at', 'desc')
function onSort(key: string) {
  toggle(key as SortKey)
}
function sortValue(p: PurchaseSummary, key: SortKey): string | number | null {
  switch (key) {
    case 'ordered_at': return p.ordered_at
    case 'subtotal': return p.subtotal
    case 'shipping_fee': return p.shipping_fee
    case 'total_cost': return p.total_cost
  }
}

/** 下書きを一覧の先頭に（それぞれの中の順序は選んだ並び替えのまま） */
const sortedPurchases = computed(() =>
  [...sortRows(purchases.value, sortValue)]
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'draft' ? -1 : 1)),
)

// --- 検索・期間（クライアント側で絞る） ---

const searchText = ref('')
const period = ref<Period>('all')
/** 仕入先の絞り込み。空文字列なら「すべて」（上の仕入先カードと連動） */
const shopAccountFilter = ref('')

/** 検索語より前に、期間と仕入先だけで絞った行（明細検索の対象を決めるのに使う） */
const periodShopFiltered = computed(() =>
  sortedPurchases.value.filter(p =>
    inPeriod(p.ordered_at, period.value)
    && (!shopAccountFilter.value || p.shop_account_id === shopAccountFilter.value),
  ),
)

// --- 検索は明細名まで。PurchaseSummary は代表商品名しか持たないため、検索語が
//     入ったら「表示中」（期間・仕入先で絞った後）の仕入について getPurchase を
//     並列で読み、明細名をキャッシュして検索対象に加える。全件読むと重いので上限50件 ---
const MAX_SEARCH_DETAIL_FETCH = 50
const lineNamesCache = ref<Map<string, string[]>>(new Map())

watch([searchText, periodShopFiltered], async ([text, rows]) => {
  if (!text.trim()) return
  const targets = rows.slice(0, MAX_SEARCH_DETAIL_FETCH).filter(p => !lineNamesCache.value.has(p.id))
  if (!targets.length) return
  const details = await Promise.all(targets.map(p => window.soroban.getPurchase(p.id).catch(() => null)))
  details.forEach((d, i) => {
    if (d) lineNamesCache.value.set(targets[i].id, d.lines.map(l => l.name))
  })
}, { immediate: true })

const filteredPurchases = computed(() =>
  periodShopFiltered.value.filter(p =>
    matchesSearch(
      [
        p.first_line_name, p.order_no, p.shop_account_name, p.note,
        ...p.tags.map(t => t.name),
        ...(lineNamesCache.value.get(p.id) ?? []),
      ],
      searchText.value,
    ),
  ),
)

/** 絞り込んだ範囲の総原価合計（下書きは価格未入力なので除く） */
const periodTotalCost = computed(() =>
  filteredPurchases.value.filter(p => p.status !== 'draft').reduce((s, p) => s + p.total_cost, 0),
)

/** 仕入先で絞ったときの明細・商品計・送料・支払合計（絞り込み後の行から。下書きは価格未入力なので除く） */
const shopAccountSummary = computed(() => {
  const rows = filteredPurchases.value.filter(p => p.status !== 'draft')
  return {
    lineCount: rows.reduce((s, p) => s + p.line_count, 0),
    subtotal: rows.reduce((s, p) => s + p.subtotal, 0),
    shippingFee: rows.reduce((s, p) => s + p.shipping_fee, 0),
    totalCost: rows.reduce((s, p) => s + p.total_cost, 0),
  }
})

function previewModelCode(line: PurchaseLineInput): string {
  if (line.model_code) return line.model_code
  const m = line.name.match(MODEL_CODE_PREVIEW_RE)
  return m ? m[1] : ''
}

async function load() {
  purchases.value = await window.soroban.listPurchases()
  accounts.value = await window.soroban.listShopAccounts()
  if (!form.value.shop_account_id && accounts.value.length) {
    form.value.shop_account_id = accounts.value[0].id
  }
  // 仕入が変わった（確定・削除・配送更新など）可能性があるので明細名キャッシュは作り直す
  lineNamesCache.value.clear()
  loaded.value = true
}
onMounted(load)
watch(revision, load)

// --- 上の仕入先カード：期間（toolbar のセレクトと連動）で絞った「今いくら払ったか」。押すと絞る ---
const accountCards = ref<PurchaseAccountCard[]>([])
async function loadAccountCards() {
  const range = periodRange(period.value)
  accountCards.value = await window.soroban.listPurchaseAccountCards(range?.from ?? null, range?.to ?? null)
}
onMounted(loadAccountCards)
watch(period, loadAccountCards)
watch(revision, loadAccountCards)

function selectAccountCard(c: PurchaseAccountCard) {
  shopAccountFilter.value = c.shop_account_id ?? ''
}

// --- 横断検索からの遷移：検索語を引き継ぎ、該当行を一時的にハイライトする ---
const focusedId = ref<string | null>(null)

async function focusRow(id: string) {
  await load()
  await nextTick()
  focusedId.value = id
  document.querySelector(`[data-row-id="${id}"]`)?.scrollIntoView({ block: 'center' })
  setTimeout(() => { if (focusedId.value === id) focusedId.value = null }, 2000)
}

watch(gotoPayload, (p) => {
  if (!p) return
  if (p.search) searchText.value = p.search
  if (p.focusId) focusRow(p.focusId)
  gotoPayload.value = null
}, { immediate: true })

const subtotal = computed(() =>
  form.value.lines.reduce((s, l) => s + (l.unit_price || 0) * (l.quantity || 0), 0),
)
const totalQty = computed(() =>
  form.value.lines.reduce((s, l) => s + (l.quantity || 0), 0),
)
// 送料 + その他費用 − 割引 が原価に乗る
const pool = computed(
  () => (form.value.shipping_fee || 0) + (form.value.other_cost || 0) - (form.value.discount || 0),
)

function addLine() {
  form.value.lines.push({ name: '', unit_price: 0, quantity: 1 })
}
function removeLine(i: number) {
  form.value.lines.splice(i, 1)
  if (!form.value.lines.length) addLine()
}

// --- 送料の既定値：仕入先ごとに設定タブで決めたもの。人が送料を触ったら以後は上書きしない ---

/** 送料の入力欄を人が触ったら true。フォームを開き直す／送信後のリセットで false に戻る */
const shippingTouched = ref(false)

function accountDefaultFee(accountId: string): number {
  return accounts.value.find(a => a.id === accountId)?.default_shipping_fee ?? 0
}

/** 選んだ仕入先の送料の既定値。無ければ null（ヒント表示の有無に使う） */
const selectedAccountDefaultFee = computed(
  () => accounts.value.find(a => a.id === form.value.shop_account_id)?.default_shipping_fee ?? null,
)

/** 送料をまだ人が触っていなければ既定値を入れる。下書きの確定中は取り込んだ値が正なので触らない */
function applyDefaultShippingFee() {
  if (editingId.value || shippingTouched.value) return
  form.value.shipping_fee = accountDefaultFee(form.value.shop_account_id)
}

watch(() => form.value.shop_account_id, applyDefaultShippingFee)
watch(showForm, (open) => {
  if (!open) return
  shippingTouched.value = false
  applyDefaultShippingFee()
})

async function submit() {
  const lines = form.value.lines.filter(l => l.name.trim() && l.quantity > 0)
  if (!lines.length) { toast('明細を入力してください', 'warn'); return }
  if (!form.value.shop_account_id) { toast('仕入先を選んでください', 'warn'); return }
  if (editingId.value && lines.some(l => !l.unit_price)) {
    toast('単価を入力してください', 'warn')
    return
  }

  const input: PurchaseInput = {
    shop_account_id: form.value.shop_account_id,
    ordered_at: form.value.ordered_at,
    order_no: form.value.order_no || null,
    shipping_fee: form.value.shipping_fee,
    other_cost: form.value.other_cost,
    discount: form.value.discount,
    alloc_method: form.value.alloc_method,
    note: form.value.note || null,
    fulfillment: form.value.fulfillment,
    lines,
  }

  if (editingId.value) {
    await window.soroban.confirmPurchase(editingId.value, input)
  } else {
    await window.soroban.createPurchase(input)
  }

  editingId.value = null
  form.value.order_no = ''
  form.value.shipping_fee = 0
  form.value.other_cost = 0
  form.value.discount = 0
  form.value.note = ''
  form.value.fulfillment = null
  form.value.lines = [{ name: '', unit_price: 0, quantity: 1 }]
  shippingTouched.value = false
  showForm.value = false
  await load()
  changed()
}

/** 下書きを確定フォームに読み込む。既存の登録フォームを編集モードで開く */
async function confirmDraft(p: PurchaseSummary) {
  const detail = await window.soroban.getPurchase(p.id)
  editingId.value = detail.id
  form.value.shop_account_id = detail.shop_account_id
  form.value.ordered_at = detail.ordered_at
  form.value.order_no = ''
  form.value.shipping_fee = 0
  form.value.other_cost = 0
  form.value.discount = 0
  form.value.alloc_method = 'by_amount'
  form.value.note = detail.note ?? ''
  form.value.fulfillment = detail.fulfillment
  form.value.lines = detail.lines.map(l => ({
    name: l.name,
    unit_price: 0,
    quantity: l.quantity,
    model_code: l.model_code,
    series_code: l.series_code,
    material: l.material,
  }))
  showForm.value = true
}

function toggleForm() {
  if (showForm.value) {
    editingId.value = null
    showForm.value = false
  } else {
    showForm.value = true
  }
}

async function editNote(p: PurchaseSummary) {
  const input = await ask('メモ', { initial: p.note ?? '', multiline: true })
  if (input === null) return
  await window.soroban.updatePurchaseNote(p.id, input.trim() || null)
  await load()
  await purchaseDrawerRef.value?.reload()
}

// --- 取引詳細ドロワー：行のサムネ・商品名・注文番号をクリックで開く ---

const drawerPurchaseId = ref<string | null>(null)
const purchaseDrawerRef = ref<InstanceType<typeof PurchaseDrawer> | null>(null)

function openPurchaseDrawer(id: string) {
  drawerPurchaseId.value = id
}

async function onDrawerConfirmDraft(p: PurchaseSummary) {
  drawerPurchaseId.value = null
  await confirmDraft(p)
}

// --- 到着状態：チップ・行の「配送」ボタン・ドロワーの「配送」ボタン共通 ---

function fulfillmentAutoTitle(p: PurchaseSummary): string | undefined {
  return p.import_key ? '取り込みで自動更新されます（手で変えても次の取り込みで戻ります）' : undefined
}

async function editFulfillment(p: PurchaseSummary) {
  const value = await choose('配送状態', [
    { label: '到着済', value: 'delivered', tone: 'ghost' },
    { label: '未発送', value: 'pending', tone: 'ghost' },
    { label: '配送中', value: 'shipped', tone: 'ghost' },
  ])
  if (!value) return
  const fulfillment = value === 'delivered' ? null : (value as 'pending' | 'shipped')
  await window.soroban.updatePurchaseFulfillment(p.id, fulfillment)
  await load()
  await purchaseDrawerRef.value?.reload()
  changed()
}

function onDrawerEditFulfillment(p: PurchaseSummary) {
  editFulfillment(p)
}

// --- 仕入タグ：この仕入に直接付ける。在庫・販売には派生（コピーしない）で見える ---

const allTags = ref<Tag[]>([])
async function loadTags() {
  allTags.value = await window.soroban.listTags()
}
onMounted(loadTags)
watch(revision, loadTags)

const tagPickerPurchase = ref<PurchaseSummary | null>(null)
const tagPickerAnchor = ref<HTMLElement | null>(null)

function openPurchaseTagPicker(p: PurchaseSummary, e: MouseEvent) {
  tagPickerPurchase.value = p
  tagPickerAnchor.value = e.currentTarget as HTMLElement
}

function closePurchaseTagPicker() {
  tagPickerPurchase.value = null
  tagPickerAnchor.value = null
}

async function onPurchaseTagChange(tagIds: string[]) {
  if (!tagPickerPurchase.value) return
  const id = tagPickerPurchase.value.id
  await window.soroban.setPurchaseTags(id, tagIds)
  await load()
  tagPickerPurchase.value = purchases.value.find(p => p.id === id) ?? null
  await purchaseDrawerRef.value?.reload()
}

async function onPurchaseTagCreate(name: string) {
  if (!tagPickerPurchase.value) return
  const id = tagPickerPurchase.value.id
  const newTagId = await window.soroban.createTag(name)
  await loadTags()
  const tagIds = [...tagPickerPurchase.value.tags.map(t => t.id), newTagId]
  await window.soroban.setPurchaseTags(id, tagIds)
  await load()
  tagPickerPurchase.value = purchases.value.find(p => p.id === id) ?? null
  await purchaseDrawerRef.value?.reload()
}

/** ドロワーの「タグ」ボタンから：既存の openPurchaseTagPicker をそのまま使う */
function onDrawerEditTag(p: PurchaseSummary, e: MouseEvent) {
  openPurchaseTagPicker(p, e)
}

/** ドロワーの「メモ」ボタンから：既存の editNote をそのまま使う（内部で drawer も再読込する） */
async function onDrawerEditNote(p: PurchaseSummary) {
  await editNote(p)
}

// --- CSV 一括登録 ---

async function onCsvImported(created: number, skipped: number) {
  await load()
  changed()
  toast(
    skipped ? `${created}件登録しました（${skipped}件は登録できませんでした）` : `${created}件登録しました`,
    skipped && !created ? 'warn' : 'ok',
  )
}

async function remove(p: PurchaseSummary) {
  if (!await confirmDialog(`${p.ordered_at} の仕入を削除しますか？`, {
    message: '生成された在庫も消えます。',
    okLabel: '削除する',
    danger: true,
  })) return
  try {
    await window.soroban.deletePurchase(p.id)
    await load()
    changed()
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'warn')
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">仕入</h1>
      <span class="grow" />
      <button class="sm ghost" @click="showCsvDrawer = true">CSV で一括登録</button>
      <button class="primary" @click="toggleForm">
        <Icon :name="showForm ? 'close' : 'plus'" :size="16" />
        {{ showForm ? '閉じる' : '仕入を登録' }}
      </button>
    </div>

    <!-- 仕入先カード：期間内に「今いくら払ったか」。押すと仕入先で絞る -->
    <div v-if="accountCards.length" class="acc-row">
      <button
        v-for="c in accountCards" :key="c.shop_account_id ?? 'all'"
        type="button" class="acc"
        :class="{ active: shopAccountFilter === (c.shop_account_id ?? '') }"
        @click="selectAccountCard(c)"
      >
        <div class="acc-label">
          <span>{{ c.name }}</span>
          <StatusChip v-if="c.drafts" tone="warn" :label="`下書き ${c.drafts}`" />
          <StatusChip v-if="c.auth_required" tone="warn" label="ログインが必要" />
        </div>
        <div class="acc-value">{{ yen(c.total_cost) }}</div>
        <div class="acc-sub faint">
          {{ c.orders }} 注文
          <span v-if="c.items"> ・ {{ c.items }} 点</span>
          <span v-if="c.not_arrived"> ・ 到着待ち {{ c.not_arrived }}</span>
        </div>
      </button>
    </div>

    <!-- 登録フォーム -->
    <div v-if="showForm" class="panel form">
      <p v-if="editingId" class="panel-title">下書きを確定</p>
      <div class="fields">
        <label class="field">
          <span>仕入先</span>
          <select v-model="form.shop_account_id">
            <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
          <span v-if="!accounts.length" class="faint">仕入先は設定タブの「仕入先」で登録します</span>
        </label>
        <label class="field">
          <span>注文日</span>
          <input type="date" v-model="form.ordered_at" />
        </label>
        <label class="field">
          <span>注文番号</span>
          <input v-model="form.order_no" placeholder="任意" />
        </label>
        <label class="field">
          <span>メモ</span>
          <input v-model="form.note" placeholder="任意" />
        </label>
        <label class="field">
          <span>配送状態</span>
          <select v-model="form.fulfillment">
            <option :value="null">到着済</option>
            <option value="pending">未発送</option>
            <option value="shipped">配送中</option>
          </select>
          <span class="faint">メロジョイは取り込みで自動更新</span>
        </label>
      </div>
      <p class="faint tax-hint">金額はすべて税込。注文画面の表示どおりに入れてください</p>

      <table class="compact lines-table">
        <thead>
          <tr>
            <th>商品名</th>
            <th class="col-model">型番</th>
            <th class="num col-price">単価（税込）</th>
            <th class="num col-qty">数量</th>
            <th class="num col-subtotal">小計</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(l, i) in form.lines" :key="i">
            <td><input v-model="l.name" class="full" placeholder="商品名" /></td>
            <td class="faint">{{ previewModelCode(l) }}</td>
            <td><input type="number" v-model.number="l.unit_price" class="full" /></td>
            <td><input type="number" v-model.number="l.quantity" class="full" min="1" /></td>
            <td class="num dim">{{ yen((l.unit_price || 0) * (l.quantity || 0)) }}</td>
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

      <div class="fields">
        <label class="field">
          <span>送料（税込）</span>
          <input type="number" v-model.number="form.shipping_fee" @input="shippingTouched = true" />
          <span v-if="selectedAccountDefaultFee !== null" class="faint">仕入先の既定値：{{ yen(selectedAccountDefaultFee) }}</span>
        </label>
        <label class="field">
          <span>その他費用（税込）</span>
          <input type="number" v-model.number="form.other_cost" />
        </label>
        <label class="field">
          <span>割引（税込）</span>
          <input type="number" v-model.number="form.discount" />
        </label>
        <label class="field">
          <span>按分方式</span>
          <select v-model="form.alloc_method">
            <option value="by_amount">金額で按分</option>
            <option value="by_quantity">数量で按分</option>
          </select>
        </label>
      </div>

      <p class="alloc-note faint">
        明細合計 <strong>{{ yen(subtotal) }}</strong> ／ 配賦 <strong>{{ yen(pool) }}</strong> を
        {{ totalQty }}点に按分 → 総原価 <strong>{{ yen(subtotal + pool) }}</strong>
      </p>

      <div class="row">
        <span class="grow" />
        <button class="primary" @click="submit">{{ editingId ? '確定して在庫を作る' : '登録して在庫を作る' }}</button>
      </div>
    </div>

    <div class="toolbar">
      <SearchBox v-model="searchText" placeholder="商品名・注文番号・仕入先・メモ・明細を検索" />
      <PeriodSelect v-model="period" />
      <span class="grow" />
      <span v-if="shopAccountFilter" class="faint">
        {{ filteredPurchases.length }}件 ／ 明細 {{ shopAccountSummary.lineCount }} ／
        商品計 {{ yen(shopAccountSummary.subtotal) }} ／ 送料 {{ yen(shopAccountSummary.shippingFee) }} ／
        支払合計 {{ yen(shopAccountSummary.totalCost) }}
      </span>
      <span v-else class="faint">{{ filteredPurchases.length }}件 ／ 総原価 {{ yen(periodTotalCost) }}</span>
    </div>

    <Skeleton v-if="!loaded" :rows="5" />

    <template v-else>
      <div v-if="filteredPurchases.length" class="panel table-panel">
        <table>
          <thead>
            <tr>
              <th class="col-thumb"></th>
              <SortTh label="仕入" sort-key="ordered_at" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
              <th class="col-ship"><Icon name="truck" :size="14" class="col-ship-icon" />配送</th>
              <SortTh label="商品計" sort-key="subtotal" align="right" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
              <SortTh label="送料" sort-key="shipping_fee" align="right" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
              <SortTh label="総原価" sort-key="total_cost" align="right" :active-key="sortKey" :dir="sortDir" @sort="onSort" />
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in filteredPurchases" :key="p.id"
              :data-row-id="p.id"
              class="clickable"
              :class="{ focused: focusedId === p.id }"
              title="取引詳細を見る"
              @click="openPurchaseDrawer(p.id)"
            >
              <td class="thumb-cell">
                <span class="thumb-placeholder">{{ shopMarkChar(p) }}</span>
              </td>
              <td class="info-cell">
                <div class="info-title">
                  <span class="info-title-text">
                    {{ p.shop_account_name }}<span v-if="p.order_no"> ・ #{{ p.order_no }}</span>
                  </span>
                  <span class="chip-row inline">
                    <StatusChip v-if="p.status === 'draft'" tone="warn" label="価格未入力" />
                    <StatusChip v-if="p.import_key" tone="neutral" label="自動取得" />
                    <StatusChip v-else tone="neutral" label="手入力" />
                    <StatusChip v-for="t in p.tags" :key="t.id" tone="info" :label="t.name" />
                  </span>
                </div>
                <div class="info-sub faint">
                  {{ p.ordered_at }} 注文 ・ 明細 {{ p.line_count }} ・ {{ p.first_line_name ?? '—' }}
                  <span v-if="p.line_count > 1">ほか{{ p.line_count - 1 }}点</span>
                </div>
                <div v-if="p.note" class="note-row">
                  <Icon name="note" :size="14" class="icon-note" />
                  <span class="note-label">メモ</span>
                  <span class="note-text">{{ p.note }}</span>
                </div>
              </td>
              <td class="ship-cell">
                <div class="ship-progress">
                  <template v-for="(s, i) in shippingStages(p)" :key="i">
                    <span class="ship-stage" :class="s.state">
                      <span class="ship-dot"></span>{{ s.label }}
                    </span>
                    <span v-if="i < 3" class="ship-bar" :class="{ done: s.state === 'done' }"></span>
                  </template>
                </div>
              </td>
              <td class="num">
                <span v-if="p.status === 'draft'" class="faint">—</span>
                <template v-else>{{ yen(p.subtotal) }}</template>
              </td>
              <td class="num dim">
                <span v-if="p.status === 'draft'" class="faint">—</span>
                <template v-else>{{ yen(p.shipping_fee) }}</template>
              </td>
              <td class="num">
                <strong v-if="p.status !== 'draft'">{{ yen(p.total_cost) }}</strong>
                <span v-else class="faint">—</span>
              </td>
              <td class="actions" @click.stop>
                <button v-if="p.status === 'draft'" class="sm primary" @click="confirmDraft(p)">確定</button>
                <button class="sm ghost" :title="fulfillmentAutoTitle(p) ?? '配送状態を変える'" @click="editFulfillment(p)">配送</button>
                <button class="sm ghost" @click="openPurchaseTagPicker(p, $event)" title="タグを編集する">タグ</button>
                <button class="sm ghost" @click="editNote(p)">メモ</button>
                <button class="icon ghost" aria-label="削除" @click="remove(p)">
                  <Icon name="trash" :size="16" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <EmptyState
        v-else-if="searchText"
        title="検索条件に一致する仕入がありません"
      />

      <EmptyState
        v-else-if="!showForm"
        title="仕入がまだありません。"
        hint="「仕入を登録」から追加してください。"
      >
        <template #action>
          <button class="primary" @click="showForm = true">仕入を登録</button>
        </template>
      </EmptyState>
    </template>

    <p class="hint-row faint">仕入のタグは、その仕入の在庫と、売れたときの販売にそのまま表示されます</p>

    <TagPicker
      :open="!!tagPickerPurchase"
      :anchor="tagPickerAnchor"
      :all-tags="allTags"
      :selected="tagPickerPurchase?.tags.map(t => t.id) ?? []"
      @change="onPurchaseTagChange"
      @create="onPurchaseTagCreate"
      @close="closePurchaseTagPicker"
    />

    <PurchaseDrawer
      ref="purchaseDrawerRef"
      :open="!!drawerPurchaseId"
      :purchase-id="drawerPurchaseId"
      @close="drawerPurchaseId = null"
      @confirm-draft="onDrawerConfirmDraft"
      @edit-tag="onDrawerEditTag"
      @edit-note="onDrawerEditNote"
      @edit-fulfillment="onDrawerEditFulfillment"
    />

    <PurchaseCsvDrawer
      :open="showCsvDrawer"
      @close="showCsvDrawer = false"
      @imported="onCsvImported"
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
  margin: 12px 0 0;
  font-size: var(--fs-13);
}

.tax-hint {
  margin: 0;
  font-size: var(--fs-13);
}

.lines-table .col-model { width: 96px; }
.lines-table .col-price { width: 110px; }
.lines-table .col-qty { width: 80px; }
.lines-table .col-subtotal { width: 110px; }
.lines-table .col-actions { width: 36px; }
.full { width: 100%; }

.add-line { align-self: flex-start; }

.alloc-note {
  margin: 0;
  padding: 8px 10px;
  background: var(--surface-hi);
  border-radius: var(--radius-sm);
}

.table-panel { padding: 0; overflow: hidden; }
.table-panel td.actions { white-space: nowrap; text-align: right; }
.table-panel .actions > * { vertical-align: middle; margin-left: 4px; }
.table-panel th.col-thumb { width: 64px; }
.table-panel th.col-ship { width: 200px; }
.col-ship-icon { margin-right: 4px; vertical-align: -2px; color: var(--text-faint); }
.clickable { cursor: pointer; }

/* 横断検索から来たときに該当行を一時的に示す */
tr.focused { background: var(--brand-soft); }

.thumb-cell { padding-right: 4px; }
.thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-weight: 700;
  font-size: var(--fs-14);
}

/* --- 行のヘッダ情報：仕入先・注文番号＋チップ／sub に注文日・明細・代表商品名 --- */
.info-cell { overflow: hidden; }
.info-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.info-title-text {
  font-size: var(--fs-14);
  font-weight: 500;
  white-space: normal;
  word-break: break-word;
}
.chip-row.inline { display: inline-flex; flex-wrap: wrap; gap: 6px; margin-top: 0; }
.info-sub {
  margin-top: 2px;
  font-size: var(--fs-13);
}

/* --- 配送の進行：注文 › 発送 › 配送中 › 到着 --- */
.ship-progress {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  font-size: var(--fs-12);
  color: var(--text-faint);
}
.ship-stage { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.ship-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--line);
  flex-shrink: 0;
}
.ship-stage.done { color: var(--text-dim); }
.ship-stage.done .ship-dot { background: var(--profit); }
.ship-stage.now { color: var(--info); font-weight: 600; }
.ship-stage.now .ship-dot { background: var(--info); }
.ship-bar { width: 14px; height: 2px; background: var(--line); flex-shrink: 0; }
.ship-bar.done { background: var(--profit); }

/* --- 上の仕入先カード --- */
.acc-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px;
  margin-bottom: 16px;
}
.acc {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--shadow-1);
  text-align: left;
  cursor: pointer;
}
.acc.active { background: var(--brand-soft); }
.acc-label {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: var(--fs-13);
  color: var(--text-dim);
}
.acc-value {
  font-size: var(--fs-20);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.acc-sub { font-size: var(--fs-12); }
</style>
