<script setup lang="ts">
import { ref, onMounted, computed, watch, inject, nextTick, type Ref } from 'vue'
import type {
  PurchaseSummary, ShopAccount, PurchaseLineInput, AllocMethod, PurchaseInput, Tag,
} from '../../shared/types'
import { todayLocal } from '../../shared/date'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import TagPicker from '../components/TagPicker.vue'
import PurchaseDrawer from '../components/PurchaseDrawer.vue'
import SearchBox, { matchesSearch } from '../components/SearchBox.vue'
import type { PromptOptions } from '../components/InputDialog.vue'

const MODEL_CODE_PREVIEW_RE = /【?([A-Z]\d{3}(?:-\d+)?)】?/

const purchases = ref<PurchaseSummary[]>([])
const accounts = ref<ShopAccount[]>([])
const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
const ask = inject<(title: string, opts?: PromptOptions) => Promise<string | null>>('prompt')!
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!
// 横断検索から goto('purchases', { search, focusId }) で開かれる
const gotoPayload = inject<Ref<{ search?: string; focusId?: string } | null>>('gotoPayload', ref(null))
const showForm = ref(false)
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
  lines: [{ name: '', unit_price: 0, quantity: 1 }] as PurchaseLineInput[],
})

const yen = (n: number) => '¥' + n.toLocaleString('ja-JP')

// --- サムネイル。仕入は画像を持たないためプレースホルダのみ
//     （代表商品の型番の頭文字。無ければ商品名の頭文字、それも無ければ「—」） ---
function placeholderChar(p: PurchaseSummary): string {
  if (p.first_model_code) return p.first_model_code.charAt(0)
  const name = p.first_line_name?.trim()
  if (name) return name.charAt(0)
  return '—'
}

/** 下書きを一覧の先頭に（それぞれの中の順序は listPurchases の並びのまま） */
const sortedPurchases = computed(() =>
  [...purchases.value].sort((a, b) => (a.status === b.status ? 0 : a.status === 'draft' ? -1 : 1)),
)

// --- 検索（クライアント側で絞る） ---

const searchText = ref('')
const filteredPurchases = computed(() =>
  sortedPurchases.value.filter(p => matchesSearch(
    [p.first_line_name, p.order_no, p.shop_account_name, p.note, ...p.tags.map(t => t.name)],
    searchText.value,
  )),
)

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
  loaded.value = true
}
onMounted(load)
watch(revision, load)

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
  form.value.lines = [{ name: '', unit_price: 0, quantity: 1 }]
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
      <button class="primary" @click="toggleForm">
        <Icon :name="showForm ? 'close' : 'plus'" :size="16" />
        {{ showForm ? '閉じる' : '仕入を登録' }}
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
          <input type="number" v-model.number="form.shipping_fee" />
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
      <SearchBox v-model="searchText" placeholder="代表商品名・注文番号・仕入先・メモを検索" />
      <span class="grow" />
      <span class="faint">{{ filteredPurchases.length }}件</span>
    </div>

    <Skeleton v-if="!loaded" :rows="5" />

    <template v-else>
      <div v-if="filteredPurchases.length" class="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>注文日</th>
              <th class="col-thumb"></th>
              <th>仕入先</th>
              <th>商品</th>
              <th class="num">明細</th>
              <th class="num">商品計</th>
              <th class="num">送料</th>
              <th class="num">総原価</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in filteredPurchases" :key="p.id"
              :data-row-id="p.id"
              :class="{ focused: focusedId === p.id }"
            >
              <td class="faint">{{ p.ordered_at }}</td>
              <td class="thumb-cell clickable" title="取引詳細を見る" @click="openPurchaseDrawer(p.id)">
                <span class="thumb-placeholder">{{ placeholderChar(p) }}</span>
              </td>
              <td>{{ p.shop_account_name }}</td>
              <td class="product-cell">
                <div class="product-name clickable" title="取引詳細を見る" @click="openPurchaseDrawer(p.id)">
                  {{ p.first_line_name ?? '—' }}
                  <span v-if="p.line_count > 1" class="faint">ほか{{ p.line_count - 1 }}点</span>
                </div>
                <div class="order-row">
                  <span v-if="p.order_no" class="faint clickable" title="取引詳細を見る" @click="openPurchaseDrawer(p.id)">{{ p.order_no }}</span>
                  <div class="chip-row">
                    <StatusChip v-if="p.status === 'draft'" tone="warn" label="価格未入力" />
                    <StatusChip v-if="p.import_key" tone="neutral" label="自動取得" />
                    <StatusChip v-if="p.fulfillment === 'pending'" tone="neutral" label="未発送" />
                    <StatusChip v-if="p.fulfillment === 'shipped'" tone="info" label="配送中" />
                    <StatusChip v-for="t in p.tags" :key="t.id" tone="info" :label="t.name" />
                  </div>
                </div>
                <div v-if="p.note" class="note-row">
                  <Icon name="note" :size="14" class="icon-note" />
                  <span class="note-label">メモ</span>
                  <span class="note-text">{{ p.note }}</span>
                </div>
              </td>
              <td class="num">{{ p.line_count }}</td>
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
              <td class="actions">
                <button v-if="p.status === 'draft'" class="sm primary" @click="confirmDraft(p)">確定</button>
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

.product-cell { overflow: hidden; }
.product-name {
  font-size: var(--fs-14);
  font-weight: 500;
  white-space: normal;
  word-break: break-word;
}
.order-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.table-panel { padding: 0; overflow: hidden; }
.table-panel td.actions { white-space: nowrap; text-align: right; }
.table-panel .actions > * { vertical-align: middle; margin-left: 4px; }
.table-panel th.col-thumb { width: 64px; }
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
</style>
