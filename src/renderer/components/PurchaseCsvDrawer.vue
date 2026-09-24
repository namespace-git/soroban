<script setup lang="ts">
// 仕入の CSV 一括登録。ひな形のダウンロード → 読み込み → プレビュー → 登録の4段階。
// 「同じ注文番号の行は1つの仕入にまとめる」以外の計算（按分・型番抽出）は main 側（createPurchase）に任せる。
// ここでは登録できる形に整えて渡すだけで、粗利やlanded_costの計算はしない。
import { ref, computed, watch } from 'vue'
import type { ShopAccount, PurchaseInput, Fulfillment, PurchaseImportResult } from '../../shared/types'
import Drawer from './Drawer.vue'
import Icon from './Icon.vue'
import StatusChip from './StatusChip.vue'
import { parseCsv, toCsv } from '../utils/csv'
import { yen } from '../format'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; imported: [created: number, skipped: number] }>()

const HEADERS = ['仕入先', '注文日', '注文番号', '商品名', '型番', '単価', '数量', '送料', 'その他費用', '割引', '配送状態', 'メモ']
const MODEL_CODE_RE = /【?([A-Z]\d{3}(?:-\d+)?)】?/

type ParsedLine = {
  name: string
  unit_price: number
  quantity: number
  model_code: string | null
  series_code: string | null
}

type ParsedOrder = {
  key: string
  shopName: string
  orderNo: string | null
  orderedAtRaw: string
  orderedAt: string | null
  lineCount: number
  subtotal: number
  shippingFee: number
  totalCost: number
  problems: string[]
  /** 問題が無ければ登録できる形（main へそのまま渡せる） */
  input: PurchaseInput | null
}

const accounts = ref<ShopAccount[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const fileName = ref<string | null>(null)
const orders = ref<ParsedOrder[]>([])
const headerError = ref<string | null>(null)
const importing = ref(false)
const result = ref<PurchaseImportResult | null>(null)
/** result.skipped の index（inputs の添字）→ 対応する ParsedOrder。登録実行時に確定する */
const resultOrders = ref<ParsedOrder[]>([])

watch(() => props.open, async (isOpen) => {
  if (!isOpen) return
  accounts.value = await window.soroban.listShopAccounts()
  reset()
})

function reset() {
  fileName.value = null
  orders.value = []
  headerError.value = null
  result.value = null
  resultOrders.value = []
  if (fileInput.value) fileInput.value.value = ''
}

function close() {
  emit('close')
}

// --- ひな形のダウンロード ---

function downloadTemplate() {
  const rows = [
    HEADERS,
    ['メロジョイ', '2026-09-21', '264129', '【Z078-2】ムースクリーム S', 'Z078-2', '2699', '2', '499', '', '', '到着済', ''],
    ['TikTok Shop', '2026/9/20', '', 'クリーミークリーム ポーチ', '', '1500', '1', '', '', '', '未発送', '手入力の仕入'],
  ]
  const csv = toCsv(rows)
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'soroban-purchases.csv'
  a.click()
  URL.revokeObjectURL(url)
}

// --- 読み込み：UTF-8 が読めなければ Shift_JIS で読み直す ---

function pickFile() {
  fileInput.value?.click()
}

async function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  result.value = null
  resultOrders.value = []
  fileName.value = file.name
  const buf = await file.arrayBuffer()
  let text = new TextDecoder('utf-8').decode(buf)
  if (text.includes('�')) text = new TextDecoder('shift_jis').decode(buf)
  parseFile(text)
}

// --- 数値・日付の読み取り ---

function normalizeHeader(h: string): string {
  return h.replace(/[　\s]/g, '')
}

/** 空なら 0（送料・その他費用・割引用）。数値として読めなければ null */
function parseOptionalMoney(raw: string): number | null {
  const s = raw.trim()
  if (!s) return 0
  const cleaned = s.replace(/[¥,\s]/g, '')
  if (!/^-?\d+$/.test(cleaned)) return null
  return Math.round(Number(cleaned))
}

/** 空・非数値なら null（単価用。必須項目） */
function parseRequiredMoney(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  const cleaned = s.replace(/[¥,\s]/g, '')
  if (!/^\d+$/.test(cleaned)) return null
  return Math.round(Number(cleaned))
}

function parseQuantity(raw: string): number | null {
  const s = raw.trim()
  if (!/^\d+$/.test(s)) return null
  return Number(s)
}

/** YYYY-MM-DD / YYYY/M/D → YYYY-MM-DD。読めなければ null */
function parseDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/)
  if (!m) return null
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function parseFulfillment(raw: string): Fulfillment | null {
  const s = raw.trim()
  if (s === '未発送') return 'pending'
  if (s === '配送中') return 'shipped'
  return null // 「到着済」・空・不明は到着扱い
}

// --- CSV → 注文ごとにまとめる ---

function parseFile(text: string) {
  const rows = parseCsv(text)
  if (!rows.length) {
    headerError.value = 'CSV が空です'
    orders.value = []
    return
  }
  const header = rows[0].map(normalizeHeader)
  const idx = (name: string) => header.indexOf(name)
  const col = {
    shop: idx('仕入先'), orderedAt: idx('注文日'), orderNo: idx('注文番号'),
    name: idx('商品名'), model: idx('型番'), price: idx('単価'), qty: idx('数量'),
    shipping: idx('送料'), other: idx('その他費用'), discount: idx('割引'),
    fulfillment: idx('配送状態'), note: idx('メモ'),
  }
  const missing = (['仕入先', '注文日', '商品名', '単価', '数量'] as const).filter(n => header.indexOf(n) < 0)
  if (missing.length) {
    headerError.value = `ヘッダに${missing.join('・')}がありません`
    orders.value = []
    return
  }
  headerError.value = null

  const get = (r: string[], i: number) => (i >= 0 && i < r.length ? (r[i] ?? '').trim() : '')

  // 注文番号でまとめる（空ならそれぞれ1行=1注文）
  const groupKeys: string[] = []
  const groups = new Map<string, string[][]>()
  let anon = 0
  for (const r of rows.slice(1)) {
    const orderNo = get(r, col.orderNo)
    const key = orderNo ? `#${orderNo}` : `_${anon++}`
    if (!groups.has(key)) { groups.set(key, []); groupKeys.push(key) }
    groups.get(key)!.push(r)
  }

  orders.value = groupKeys.map((key) => {
    const groupRows = groups.get(key)!
    const first = groupRows[0]
    const orderNo = get(first, col.orderNo) || null
    const problems: string[] = []

    const shopNames = new Set(groupRows.map(r => get(r, col.shop)))
    if (orderNo && shopNames.size > 1) problems.push('ファイル内で注文番号が重複')
    const shopName = get(first, col.shop)
    const account = shopName ? accounts.value.find(a => a.name === shopName) : undefined
    if (!shopName || !account) problems.push('仕入先が見つからない')

    const orderedAtRaw = get(first, col.orderedAt)
    const orderedAt = parseDate(orderedAtRaw)
    if (!orderedAt) problems.push('日付が読めない')

    const lines: ParsedLine[] = []
    for (const r of groupRows) {
      const name = get(r, col.name)
      const qty = parseQuantity(get(r, col.qty))
      const price = parseRequiredMoney(get(r, col.price))
      if (!name && !problems.includes('商品名が空の行がある')) problems.push('商品名が空の行がある')
      if ((qty === null || qty < 1) && !problems.includes('数量が0の行がある')) problems.push('数量が0の行がある')
      if (price === null && !problems.includes('単価が読み取れない行がある')) problems.push('単価が読み取れない行がある')
      const modelRaw = col.model >= 0 ? get(r, col.model) : ''
      const model_code = modelRaw || (name.match(MODEL_CODE_RE)?.[1] ?? null)
      lines.push({
        name,
        unit_price: price ?? 0,
        quantity: qty ?? 0,
        model_code,
        series_code: model_code ? model_code.split('-')[0] : null,
      })
    }

    const shippingRaw = col.shipping >= 0 ? get(first, col.shipping) : ''
    let shippingFee: number
    if (!shippingRaw) {
      shippingFee = account?.default_shipping_fee ?? 0
    } else {
      const parsed = parseOptionalMoney(shippingRaw)
      if (parsed === null) { problems.push('送料が読み取れない'); shippingFee = 0 } else { shippingFee = parsed }
    }
    const otherRaw = col.other >= 0 ? get(first, col.other) : ''
    const otherParsed = parseOptionalMoney(otherRaw)
    if (otherParsed === null) problems.push('その他費用が読み取れない')
    const otherCost = otherParsed ?? 0
    const discountRaw = col.discount >= 0 ? get(first, col.discount) : ''
    const discountParsed = parseOptionalMoney(discountRaw)
    if (discountParsed === null) problems.push('割引が読み取れない')
    const discount = discountParsed ?? 0

    const subtotal = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0)
    const totalCost = subtotal + shippingFee + otherCost - discount
    const noteRaw = col.note >= 0 ? get(first, col.note) : ''

    const input: PurchaseInput | null = problems.length === 0 && account && orderedAt
      ? {
          shop_account_id: account.id,
          ordered_at: orderedAt,
          order_no: orderNo,
          shipping_fee: shippingFee,
          other_cost: otherCost,
          discount,
          note: noteRaw || null,
          fulfillment: col.fulfillment >= 0 ? parseFulfillment(get(first, col.fulfillment)) : null,
          lines: lines.map(l => ({
            name: l.name,
            unit_price: l.unit_price,
            quantity: l.quantity,
            model_code: l.model_code,
            series_code: l.series_code,
          })),
        }
      : null

    return {
      key, shopName: shopName || '（未入力）', orderNo, orderedAtRaw, orderedAt,
      lineCount: lines.length, subtotal, shippingFee, totalCost, problems, input,
    }
  })
}

const registerableOrders = computed(() => orders.value.filter(o => o.input))
const problemCount = computed(() => orders.value.length - registerableOrders.value.length)

// --- 登録 ---

async function submit() {
  if (!registerableOrders.value.length || importing.value) return
  importing.value = true
  try {
    const targets = registerableOrders.value
    const inputs = targets.map(o => o.input!)
    const res = await window.soroban.importPurchases(inputs)
    result.value = res
    resultOrders.value = targets
    orders.value = []
    fileName.value = null
    if (fileInput.value) fileInput.value.value = ''
    emit('imported', res.created, res.skipped.length)
  } finally {
    importing.value = false
  }
}

function skipOrder(index: number): ParsedOrder | undefined {
  return resultOrders.value[index]
}
</script>

<template>
  <Drawer :open="open" title="CSV で一括登録" :width="760" @close="close">
    <div class="intro">
      <button class="sm ghost" @click="downloadTemplate">
        <Icon name="download" :size="14" />
        ひな形をダウンロード
      </button>
      <button class="sm ghost" @click="pickFile">
        <Icon name="folder" :size="14" />
        ファイルを選ぶ
      </button>
      <input ref="fileInput" type="file" accept=".csv,text/csv" class="hidden-input" @change="onFileChange" />
      <span v-if="fileName" class="faint filename">{{ fileName }}</span>
    </div>
    <p class="faint intro-note">
      同じ注文番号の行は1つの仕入にまとまります。金額はすべて税込で入力してください。<br />
      注文番号が同じ仕入先で既に登録されていれば、その注文は登録されません（空なら重複は見ません）。
    </p>

    <p v-if="headerError" class="warn header-error">{{ headerError }}</p>

    <template v-if="orders.length">
      <p class="summary-line">
        <strong>{{ registerableOrders.length }}</strong> 件を登録
        <span v-if="problemCount">（<strong class="warn">{{ problemCount }}</strong> 件は問題あり）</span>
      </p>
      <div class="table-scroll">
        <table class="compact preview-table">
          <thead>
            <tr>
              <th>仕入先</th>
              <th>注文日</th>
              <th>注文番号</th>
              <th class="num">明細数</th>
              <th class="num">商品計</th>
              <th class="num">送料</th>
              <th class="num">総原価の見込み</th>
              <th>問題</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in orders" :key="o.key" :class="{ problem: o.problems.length }">
              <td>{{ o.shopName }}</td>
              <td class="nowrap">{{ o.orderedAt ?? o.orderedAtRaw }}</td>
              <td class="nowrap">{{ o.orderNo ?? '—' }}</td>
              <td class="num">{{ o.lineCount }}</td>
              <td class="num">{{ yen(o.subtotal) }}</td>
              <td class="num dim">{{ yen(o.shippingFee) }}</td>
              <td class="num"><strong>{{ yen(o.totalCost) }}</strong></td>
              <td>
                <div class="chip-row">
                  <StatusChip v-for="p in o.problems" :key="p" tone="warn" :label="p" />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <div v-if="result" class="result-block">
      <p class="result-line">{{ result.created }} 件登録しました</p>
      <ul v-if="result.skipped.length" class="skip-list">
        <li v-for="s in result.skipped" :key="s.index">
          <span class="nowrap">{{ skipOrder(s.index)?.shopName }} {{ skipOrder(s.index)?.orderNo ?? '' }}</span>
          <span class="faint">— {{ s.reason }}</span>
        </li>
      </ul>
    </div>

    <template #footer>
      <div class="footer-row">
        <span class="grow" />
        <button
          class="primary"
          :disabled="!registerableOrders.length || importing"
          @click="submit"
        >
          {{ importing ? '登録中…' : '登録する' }}
        </button>
      </div>
    </template>
  </Drawer>
</template>

<style scoped>
.intro {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.hidden-input { display: none; }
.filename { margin-left: 2px; }

.intro-note {
  margin: 10px 0 0;
  font-size: var(--fs-13);
  line-height: 1.6;
}

.header-error {
  margin-top: 12px;
}

.summary-line {
  margin: 16px 0 8px;
  font-size: var(--fs-14);
}

.table-scroll {
  overflow-x: auto;
}

.preview-table { width: 100%; min-width: 720px; }
.preview-table td:first-child { white-space: nowrap; }
.chip-row { display: flex; flex-wrap: wrap; gap: 4px; min-width: 160px; }
.preview-table tr.problem { background: var(--warn-bg); }

.result-block {
  margin-top: 16px;
  padding: 12px 14px;
  background: var(--surface-hi);
  border-radius: var(--radius-sm);
}
.result-line { margin: 0 0 6px; font-weight: 600; }
.skip-list {
  margin: 0;
  padding-left: 18px;
  font-size: var(--fs-13);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.footer-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
