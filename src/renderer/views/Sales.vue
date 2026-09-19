<script setup lang="ts">
import { ref, onMounted, computed, watch, inject, type Ref } from 'vue'
import type { SaleProfit, ShippingMethod, InventoryItem, SaleKind, SaleInput, SaleFilter, SaleTotals, Tag } from '../../shared/types'
import { todayLocal } from '../../shared/date'
import Icon from '../components/Icon.vue'
import Drawer from '../components/Drawer.vue'
import StatusChip from '../components/StatusChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import TagPicker from '../components/TagPicker.vue'
import type { PromptOptions } from '../components/InputDialog.vue'

const ask = inject<(title: string, opts?: PromptOptions) => Promise<string | null>>('prompt')!
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!

const sales = ref<SaleProfit[]>([])
const methods = ref<ShippingMethod[]>([])
const allTags = ref<Tag[]>([])
const onlyPending = ref(true)
const tagFilter = ref('')
const totals = ref<SaleTotals | null>(null)
const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
const loaded = ref(false)

// 販売の手入力フォーム
const showForm = ref(false)
const form = ref<SaleInput>({
  title: '',
  sold_at: todayLocal(),
  price: 0,
  kind: 'resale',
  note: '',
})

// 紐付けパネルを開いている販売
const matching = ref<SaleProfit | null>(null)
const matchedItems = ref<InventoryItem[]>([])
const candidates = ref<InventoryItem[]>([])
const picked = ref<Set<string>>(new Set())
const search = ref('')

// タグピッカーを開いている販売
const tagPickerSale = ref<SaleProfit | null>(null)
const tagPickerAnchor = ref<HTMLElement | null>(null)

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

// --- サムネイル。読み込み失敗したら以後プレースホルダに固定する ---
const thumbFailed = ref<Set<string>>(new Set())
function showThumb(s: SaleProfit): boolean {
  return !!s.thumb_url && !thumbFailed.value.has(s.id)
}
function onThumbError(id: string) {
  thumbFailed.value = new Set(thumbFailed.value).add(id)
}
function placeholderChar(s: SaleProfit): string {
  const c = s.model_codes[0]?.[0] ?? s.title.trim().charAt(0)
  return (c || '?').toUpperCase()
}

function currentFilter(): SaleFilter {
  const filter: SaleFilter = {}
  if (onlyPending.value) filter.onlyPending = true
  if (tagFilter.value) filter.tagId = tagFilter.value
  return filter
}

async function load() {
  const filter = currentFilter()
  sales.value = await window.soroban.listSales(
    Object.keys(filter).length ? filter : undefined,
  )
  totals.value = tagFilter.value ? await window.soroban.saleTotals(filter) : null
  loaded.value = true
}

async function loadTags() {
  allTags.value = await window.soroban.listTags()
}

onMounted(async () => {
  methods.value = await window.soroban.listShippingMethods()
  await loadTags()
  await load()
})
watch(revision, loadTags)
watch([revision, onlyPending, tagFilter], load)

// --- 手入力登録 ---

async function submit() {
  if (!form.value.title.trim()) { toast('商品名を入力してください', 'warn'); return }
  if (!form.value.price || form.value.price <= 0) { toast('価格を入力してください', 'warn'); return }

  await window.soroban.createSale({
    ...form.value,
    title: form.value.title.trim(),
    note: form.value.note?.trim() || null,
  })

  form.value = { title: '', sold_at: todayLocal(), price: 0, kind: 'resale', note: '' }
  showForm.value = false
  await load()
  changed()
}

// --- 送料・梱包材費 ---

async function setShipping(sale: SaleProfit, methodId: string) {
  await window.soroban.updateSale(sale.id, { shipping_method_id: methodId || null })
  await load()
  changed()
}

async function setPackaging(sale: SaleProfit, value: number) {
  const packaging_cost = Math.max(0, Math.round(value || 0))
  await window.soroban.updateSale(sale.id, { packaging_cost })
  await load()
  changed()
}

async function setKind(sale: SaleProfit, kind: SaleKind) {
  const label = kind === 'personal' ? '私物' : '転売'
  if (!await confirmDialog(`「${sale.title}」を${label}に変更しますか？`, { okLabel: '変更する' })) return
  await window.soroban.updateSale(sale.id, { kind })
  await load()
  changed()
  if (onlyPending.value && !sales.value.some(s => s.id === sale.id)) {
    toast(`${label}に変更しました。「未処理のみ」を外すと表示されます`, 'ok')
  }
}

async function editNote(sale: SaleProfit) {
  const v = await ask('メモ', { initial: sale.note ?? '', multiline: true })
  if (v === null) return
  await window.soroban.updateSale(sale.id, { note: v.trim() || null })
  await load()
  changed()
}

// --- 型番で自動紐付け ---

async function autoLinkPending() {
  const n = await window.soroban.autoLinkPending()
  if (n > 0) {
    toast(`${n}件を自動で紐付けました`, 'ok')
  } else {
    toast('型番が一致する在庫はありませんでした', 'warn')
  }
  await load()
  changed()
}

// --- タグ ---

function openTagPicker(sale: SaleProfit, e: MouseEvent) {
  tagPickerSale.value = sale
  tagPickerAnchor.value = e.currentTarget as HTMLElement
}

function closeTagPicker() {
  tagPickerSale.value = null
  tagPickerAnchor.value = null
}

async function onTagChange(tagIds: string[]) {
  if (!tagPickerSale.value) return
  const id = tagPickerSale.value.id
  await window.soroban.setSaleTags(id, tagIds)
  await load()
  tagPickerSale.value = sales.value.find(s => s.id === id) ?? null
}

async function onTagCreate(name: string) {
  if (!tagPickerSale.value) return
  const id = tagPickerSale.value.id
  const newTagId = await window.soroban.createTag(name)
  await loadTags()
  const tagIds = [...tagPickerSale.value.tags.map(t => t.id), newTagId]
  await window.soroban.setSaleTags(id, tagIds)
  await load()
  tagPickerSale.value = sales.value.find(s => s.id === id) ?? null
}

// --- 紐付け ---

async function refreshMatchPanel() {
  if (!matching.value) return
  const [linked, sugg] = await Promise.all([
    window.soroban.listSaleLines(matching.value.id),
    window.soroban.suggestInventory(matching.value.id, 50),
  ])
  matchedItems.value = linked
  candidates.value = sugg
}

async function openMatch(sale: SaleProfit) {
  matching.value = sale
  picked.value = new Set()
  search.value = ''
  await refreshMatchPanel()
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return candidates.value
  return candidates.value.filter(c => c.name.toLowerCase().includes(q))
})

function toggle(id: string) {
  const s = new Set(picked.value)
  s.has(id) ? s.delete(id) : s.add(id)
  picked.value = s
}

const matchedCost = computed(() =>
  matchedItems.value.reduce((s, c) => s + c.landed_cost, 0),
)
const pickedCost = computed(() =>
  candidates.value
    .filter(c => picked.value.has(c.id))
    .reduce((s, c) => s + c.landed_cost, 0),
)
const totalCost = computed(() => matchedCost.value + pickedCost.value)

const previewProfit = computed(() => {
  if (!matching.value) return 0
  return matching.value.price
    - matching.value.fee
    - matching.value.shipping_fee
    - matching.value.packaging_cost
    - totalCost.value
})

async function confirmMatch() {
  if (!matching.value || picked.value.size === 0) return
  try {
    await window.soroban.linkInventory(matching.value.id, [...picked.value])
    matching.value = null
    await load()
    changed()
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'warn')
  }
}

async function unlink(item: InventoryItem) {
  if (!matching.value) return
  try {
    await window.soroban.unlinkInventory(matching.value.id, item.id)
    await refreshMatchPanel()
    await load()
    changed()
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'warn')
  }
}

async function remove(sale: SaleProfit) {
  if (!await confirmDialog(`「${sale.title}」を削除しますか？`, { okLabel: '削除する', danger: true })) return
  await window.soroban.deleteSale(sale.id)
  await load()
  changed()
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">売上</h1>
      <span class="grow" />
      <button class="primary" @click="showForm = !showForm">
        <Icon :name="showForm ? 'close' : 'plus'" :size="16" />
        {{ showForm ? '閉じる' : '販売を登録' }}
      </button>
    </div>

    <!-- 登録フォーム -->
    <div v-if="showForm" class="panel form">
      <div class="fields">
        <label class="field field-wide">
          <span>商品名</span>
          <input v-model="form.title" placeholder="商品名" />
        </label>
        <label class="field">
          <span>販売日</span>
          <input type="date" v-model="form.sold_at" />
        </label>
        <label class="field">
          <span>価格</span>
          <input type="number" v-model.number="form.price" />
        </label>
        <label class="field">
          <span>区分</span>
          <select v-model="form.kind">
            <option value="resale">転売</option>
            <option value="personal">私物</option>
          </select>
        </label>
        <label class="field field-wide">
          <span>メモ</span>
          <input v-model="form.note" placeholder="任意" />
        </label>
      </div>
      <div class="row">
        <span class="grow" />
        <button class="primary" @click="submit">登録</button>
      </div>
    </div>

    <div class="toolbar">
      <label class="row">
        <input type="checkbox" v-model="onlyPending" />
        未処理のみ
      </label>
      <select v-model="tagFilter">
        <option value="">すべてのタグ</option>
        <option v-for="t in allTags" :key="t.id" :value="t.id">{{ t.name }}</option>
      </select>
      <span class="grow" />
      <button class="sm" @click="autoLinkPending">型番で自動紐付け</button>
      <span class="faint">{{ sales.length }}件</span>
    </div>

    <div v-if="tagFilter && totals" class="panel totals-bar">
      <span class="faint">{{ totals.count }}件</span>
      <span class="num">売上 {{ yen(totals.revenue) }}</span>
      <span class="num dim">手数料 {{ yen(totals.total_fee) }}</span>
      <span class="num dim">送料 {{ yen(totals.total_shipping) }}</span>
      <span class="num dim">原価 {{ yen(totals.total_cost) }}</span>
      <strong class="num" :class="totals.gross_profit >= 0 ? 'profit' : 'loss'">
        粗利 {{ yen(totals.gross_profit) }}
      </strong>
    </div>

    <Skeleton v-if="!loaded" :rows="6" />

    <template v-else>
      <div v-if="sales.length" class="panel table-panel">
        <table>
          <thead>
            <tr>
              <th class="col-date">販売日</th>
              <th class="col-thumb"></th>
              <th class="col-title">商品</th>
              <th class="num col-amt">価格</th>
              <th class="num col-amt">手数料</th>
              <th class="col-ship">発送方法</th>
              <th class="num col-pack">梱包</th>
              <th class="num col-amt">原価</th>
              <th class="num col-amt">粗利</th>
              <th class="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in sales" :key="s.id">
              <td class="faint nowrap">{{ s.sold_at.slice(5) }}</td>

              <td class="thumb-cell">
                <img
                  v-if="showThumb(s)"
                  class="thumb"
                  :src="s.thumb_url!"
                  alt=""
                  loading="lazy"
                  @error="onThumbError(s.id)"
                />
                <span v-else class="thumb-placeholder">{{ placeholderChar(s) }}</span>
              </td>

              <td class="title-cell">
                <div class="title-name" :title="s.title">{{ s.title }}</div>
                <div class="chip-row">
                  <button
                    class="kind-toggle"
                    title="転売／私物を切り替える（確認あり）"
                    @click="setKind(s, s.kind === 'resale' ? 'personal' : 'resale')"
                  >
                    <StatusChip
                      :tone="s.kind === 'personal' ? 'neutral' : 'brand'"
                      :label="s.kind === 'resale' ? '転売' : '私物'"
                    />
                  </button>
                  <StatusChip v-if="s.source === 'collector'" tone="neutral" label="自動取得" />
                  <StatusChip v-for="mc in s.model_codes" :key="mc" tone="neutral" :label="mc" />
                  <StatusChip v-for="t in s.tags" :key="t.id" tone="info" :label="t.name" />
                </div>
                <div v-if="s.note" class="note-row">
                  <Icon name="note" :size="14" class="icon-note" />
                  <span class="note-label">メモ</span>
                  <span class="note-text">{{ s.note }}</span>
                </div>
              </td>

              <td class="num">{{ yen(s.price) }}</td>
              <td class="num dim">−{{ yen(s.fee) }}</td>

              <td>
                <span v-if="s.shipping_source === 'actual'" class="shipping-actual">
                  {{ yen(s.shipping_fee) }}
                  <StatusChip tone="ok" label="実額" />
                </span>
                <select
                  v-else
                  class="ship-select"
                  :value="s.shipping_method_id ?? ''"
                  :class="{ invalid: !s.is_shipping_confirmed }"
                  @change="setShipping(s, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">選択…</option>
                  <option v-for="m in methods" :key="m.id" :value="m.id">
                    {{ m.name }}　{{ yen(m.fee) }}
                  </option>
                </select>
              </td>

              <td class="num dim col-pack">
                <input
                  type="number"
                  class="packaging-input"
                  :value="s.packaging_cost"
                  min="0"
                  @change="setPackaging(s, ($event.target as HTMLInputElement).valueAsNumber)"
                />
              </td>

              <td class="num">
                <button
                  v-if="s.kind === 'resale' && s.unmatched"
                  class="sm link-btn"
                  @click="openMatch(s)"
                >
                  <Icon name="link" :size="14" /> 紐付け
                </button>
                <span v-else-if="s.item_count" class="cost-cell">
                  <button
                    class="cost-btn"
                    @click="openMatch(s)"
                    title="クリックで紐付けを編集"
                  >
                    {{ yen(s.cost) }}<small class="faint"> ×{{ s.item_count }}</small>
                  </button>
                  <StatusChip v-if="s.auto_linked" tone="neutral" label="自動紐付け" />
                </span>
                <span v-else class="faint">—</span>
              </td>

              <td class="num">
                <Transition name="settle" mode="out-in">
                  <strong
                    v-if="s.is_shipping_confirmed && (!s.unmatched || s.kind === 'personal')"
                    :key="'c' + s.gross_profit"
                    :class="s.gross_profit >= 0 ? 'profit' : 'loss'"
                  >{{ yen(s.gross_profit) }}</strong>
                  <span v-else key="u" class="faint">未確定</span>
                </Transition>
              </td>

              <td class="actions">
                <button class="sm ghost fade-btn" @click="openTagPicker(s, $event)" title="タグを編集する">タグ</button>
                <button class="sm ghost fade-btn" @click="editNote(s)" title="メモを編集する">メモ</button>
                <button class="icon ghost" aria-label="削除" @click="remove(s)">
                  <Icon name="trash" :size="16" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <EmptyState
        v-else
        :title="onlyPending ? '未処理の販売はありません' : '販売がありません'"
        :hint="onlyPending ? '全件を表示するには「未処理のみ」を外してください' : undefined"
      />
    </template>

    <!-- 紐付けドロワー -->
    <Drawer :open="!!matching" :title="matching?.title ?? ''" :width="560" @close="matching = null">
      <template #header-sub>
        <span class="faint">販売 {{ matching ? yen(matching.price) : '' }}</span>
      </template>

      <label class="search-field">
        <Icon name="search" :size="16" />
        <input v-model="search" placeholder="在庫を検索" />
      </label>

      <div v-if="matchedItems.length" class="matched-block">
        <p class="panel-title">紐付け済み</p>
        <div v-for="m in matchedItems" :key="m.id" class="item matched-item">
          <span class="grow">{{ m.name }}</span>
          <span class="faint nowrap">{{ m.aging_days }}日</span>
          <span class="num">{{ yen(m.landed_cost) }}</span>
          <button class="sm ghost" @click="unlink(m)">解除</button>
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
          <span class="grow">{{ c.name }}</span>
          <span class="faint nowrap">{{ c.aging_days }}日</span>
          <span class="num">{{ yen(c.landed_cost) }}</span>
        </label>
        <EmptyState v-if="!filtered.length" title="在庫がありません。先に仕入を登録してください。" />
      </div>

      <template #footer>
        <div class="match-footer">
          <div class="calc">
            <span class="faint">{{ matchedItems.length + picked.size }}点</span>
            <span class="num">原価 {{ yen(totalCost) }}</span>
            <strong class="num" :class="previewProfit >= 0 ? 'profit' : 'loss'">
              粗利 {{ yen(previewProfit) }}
            </strong>
          </div>
          <button class="primary" :disabled="!picked.size" @click="confirmMatch">
            紐付ける
          </button>
        </div>
      </template>
    </Drawer>

    <TagPicker
      :open="!!tagPickerSale"
      :anchor="tagPickerAnchor"
      :all-tags="allTags"
      :selected="tagPickerSale?.tags.map(t => t.id) ?? []"
      @change="onTagChange"
      @create="onTagCreate"
      @close="closeTagPicker"
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
.field-wide input { width: 320px; }

.totals-bar {
  display: flex;
  align-items: baseline;
  gap: 16px;
  padding: 10px 20px;
  margin-bottom: 16px;
  font-size: var(--fs-13);
}

.table-panel { padding: 0; overflow: hidden; }
.table-panel table { table-layout: fixed; }
.table-panel td { padding: 8px 12px; }

.col-date    { width: 72px; }
.col-thumb   { width: 64px; }
.col-title   { min-width: 240px; }
.col-amt     { width: 84px; }
.col-ship    { width: 200px; }
.col-pack    { width: 76px; }
.col-actions { width: 112px; }

.nowrap { white-space: nowrap; }

.thumb-cell { padding-right: 4px; }
.thumb, .thumb-placeholder {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.thumb { object-fit: cover; display: block; }
.thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-weight: 700;
  font-size: var(--fs-14);
}

.title-cell { overflow: hidden; }
.title-name {
  font-size: var(--fs-14);
  font-weight: 500;
  white-space: normal;
  word-break: break-word;
}

.table-panel td.actions { white-space: nowrap; text-align: right; }
.table-panel .actions > * { vertical-align: middle; margin-left: 4px; }
.table-panel .actions button { white-space: nowrap; }

.fade-btn {
  padding: 3px 6px;
  opacity: .35;
  transition: opacity var(--dur) var(--ease);
}
tr:hover .fade-btn { opacity: 1; }

.kind-toggle {
  flex-shrink: 0;
  display: block;
  background: transparent;
  border: none;
  padding: 0;
  height: auto;
  cursor: pointer;
}
.kind-toggle:hover:not(:disabled) { background: transparent; }

.ship-select {
  width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 1099px 以下：コンテンツ幅が狭くなる（≒910px）。
   販売日・サムネ・金額列を詰めて商品名の可読幅を確保する。商品名は元々折り返すので追加調整は不要。
   合計 = 56 + 48 + 80*4(320) + 176 + 76 + 112 = 788px。商品列は残り約120px（min 240px 未満）。 */
@media (max-width: 1099px) {
  .col-date  { width: 56px; }
  .col-thumb { width: 48px; }
  .col-amt   { width: 80px; }
  .col-ship  { width: 176px; }
}

.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--warn);
  background: var(--warn-bg);
  border-color: var(--warn-line);
}

.cost-cell {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.cost-btn {
  background: transparent;
  border-color: transparent;
  padding: 0;
  height: auto;
  font: inherit;
  color: var(--text);
}
.cost-btn:hover:not(:disabled) {
  background: transparent;
  text-decoration: underline;
}

.shipping-actual {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}

.packaging-input { width: 72px; }

/* --- 紐付けドロワー --- */

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

/* style.css の input 既定（height:32px 等）がチェックボックスにも
   かかってしまうため、行の高さに影響しないよう明示的に上書きする */
.item input[type="checkbox"] {
  width: 14px;
  height: 14px;
  padding: 0;
  flex-shrink: 0;
}

.match-footer { display: flex; align-items: center; gap: 16px; }
.calc { flex: 1; display: flex; gap: 14px; align-items: baseline; font-size: var(--fs-13); }

/* --- 粗利確定の署名アニメーション --- */
.settle-enter-from  { opacity: 0; transform: translateY(4px); }
.settle-enter-active {
  transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.settle-leave-active { transition: opacity 80ms; }
.settle-leave-to     { opacity: 0; }
</style>
