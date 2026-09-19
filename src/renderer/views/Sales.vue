<script setup lang="ts">
import { ref, onMounted, computed, watch, inject, type Ref } from 'vue'
import type { SaleProfit, ShippingMethod, InventoryItem, SaleKind, SaleInput } from '../../shared/types'
import { todayLocal } from '../../shared/date'

const sales = ref<SaleProfit[]>([])
const methods = ref<ShippingMethod[]>([])
const onlyPending = ref(true)
const revision = inject<Ref<number>>('revision')!

// 販売の手入力フォーム
const showForm = ref(false)
const form = ref<SaleInput>({
  title: '',
  sold_at: todayLocal(),
  price: 0,
  kind: 'resale',
})

// 紐付けパネルを開いている販売
const matching = ref<SaleProfit | null>(null)
const matchedItems = ref<InventoryItem[]>([])
const candidates = ref<InventoryItem[]>([])
const picked = ref<Set<string>>(new Set())
const search = ref('')

const yen = (n: number) => '¥' + n.toLocaleString('ja-JP')

async function load() {
  sales.value = await window.soroban.listSales(
    onlyPending.value ? { onlyPending: true } : undefined,
  )
}

onMounted(async () => {
  methods.value = await window.soroban.listShippingMethods()
  await load()
})
watch([revision, onlyPending], load)

// --- 手入力登録 ---

async function submit() {
  if (!form.value.title.trim()) { alert('商品名を入力してください'); return }
  if (!form.value.price || form.value.price <= 0) { alert('価格を入力してください'); return }

  await window.soroban.createSale({ ...form.value, title: form.value.title.trim() })

  form.value = { title: '', sold_at: todayLocal(), price: 0, kind: 'resale' }
  showForm.value = false
  await load()
}

// --- 送料・梱包材費 ---

async function setShipping(sale: SaleProfit, methodId: string) {
  await window.soroban.updateSale(sale.id, { shipping_method_id: methodId || null })
  await load()
}

async function setPackaging(sale: SaleProfit, value: number) {
  const packaging_cost = Math.max(0, Math.round(value || 0))
  await window.soroban.updateSale(sale.id, { packaging_cost })
  await load()
}

async function setKind(sale: SaleProfit, kind: SaleKind) {
  await window.soroban.updateSale(sale.id, { kind })
  await load()
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
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
  }
}

async function unlink(item: InventoryItem) {
  if (!matching.value) return
  try {
    await window.soroban.unlinkInventory(matching.value.id, item.id)
    await refreshMatchPanel()
    await load()
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
  }
}

async function remove(sale: SaleProfit) {
  if (!confirm(`「${sale.title}」を削除しますか？`)) return
  await window.soroban.deleteSale(sale.id)
  await load()
}
</script>

<template>
  <div class="wrap">
    <div class="bar">
      <button class="primary" @click="showForm = !showForm">
        {{ showForm ? '閉じる' : '販売を登録' }}
      </button>
      <label class="row">
        <input type="checkbox" v-model="onlyPending" />
        未処理のみ
      </label>
      <span class="grow" />
      <span class="faint">{{ sales.length }}件</span>
    </div>

    <!-- 登録フォーム -->
    <div v-if="showForm" class="card form">
      <div class="head">
        <label>
          <span>商品名</span>
          <input v-model="form.title" class="full" placeholder="商品名" />
        </label>
        <label>
          <span>販売日</span>
          <input type="date" v-model="form.sold_at" />
        </label>
        <label>
          <span>価格</span>
          <input type="number" v-model.number="form.price" />
        </label>
        <label>
          <span>区分</span>
          <select v-model="form.kind">
            <option value="resale">転売</option>
            <option value="personal">私物</option>
          </select>
        </label>
      </div>
      <div class="row">
        <span class="grow" />
        <button class="primary" @click="submit">登録</button>
      </div>
    </div>

    <table v-if="sales.length">
      <thead>
        <tr>
          <th>販売日</th>
          <th>商品</th>
          <th class="num">価格</th>
          <th class="num">手数料</th>
          <th>発送方法</th>
          <th class="num dim">梱包</th>
          <th class="num">原価</th>
          <th class="num">粗利</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in sales" :key="s.id">
          <td class="faint nowrap">{{ s.sold_at.slice(5) }}</td>

          <td class="title">
            <div>{{ s.title }}</div>
            <button
              class="kind"
              :class="{ personal: s.kind === 'personal' }"
              @click="setKind(s, s.kind === 'resale' ? 'personal' : 'resale')"
              :title="'クリックで切り替え'"
            >{{ s.kind === 'resale' ? '転売' : '私物' }}</button>
          </td>

          <td class="num">{{ yen(s.price) }}</td>
          <td class="num dim">−{{ yen(s.fee) }}</td>

          <td>
            <select
              :value="s.shipping_method_id ?? ''"
              :class="{ unset: !s.is_shipping_confirmed }"
              @change="setShipping(s, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">選択…</option>
              <option v-for="m in methods" :key="m.id" :value="m.id">
                {{ m.name }}（{{ m.fee }}円）
              </option>
            </select>
          </td>

          <td class="num dim">
            <input
              type="number"
              class="packaging"
              :value="s.packaging_cost"
              min="0"
              @change="setPackaging(s, ($event.target as HTMLInputElement).valueAsNumber)"
            />
          </td>

          <td class="num">
            <button
              v-if="s.kind === 'resale' && s.unmatched"
              class="link-btn"
              @click="openMatch(s)"
            >紐付け</button>
            <button
              v-else-if="s.item_count"
              class="cost-btn"
              @click="openMatch(s)"
              title="クリックで紐付けを編集"
            >
              <span>{{ yen(s.cost) }}</span>
              <small class="faint"> ×{{ s.item_count }}</small>
            </button>
            <span v-else class="faint">—</span>
          </td>

          <td class="num">
            <template v-if="s.is_shipping_confirmed && (!s.unmatched || s.kind === 'personal')">
              <strong :class="s.gross_profit >= 0 ? 'profit' : 'loss'">
                {{ yen(s.gross_profit) }}
              </strong>
            </template>
            <span v-else class="faint">未確定</span>
          </td>

          <td>
            <button class="ghost" @click="remove(s)" title="削除">✕</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-else class="empty">
      {{ onlyPending ? '未処理の販売はありません' : '販売がありません' }}
    </div>

    <!-- 紐付けパネル -->
    <div v-if="matching" class="overlay" @click.self="matching = null">
      <div class="panel">
        <header>
          <div>
            <h3>{{ matching.title }}</h3>
            <span class="faint">販売 {{ yen(matching.price) }}</span>
          </div>
          <button class="ghost" @click="matching = null">✕</button>
        </header>

        <div v-if="matchedItems.length" class="matched">
          <div class="matched-head faint">紐付け済み</div>
          <div v-for="m in matchedItems" :key="m.id" class="item matched-item">
            <span class="grow">{{ m.name }}</span>
            <span class="faint nowrap">{{ m.aging_days }}日</span>
            <span class="num">{{ yen(m.landed_cost) }}</span>
            <button class="ghost small" @click="unlink(m)">解除</button>
          </div>
        </div>

        <input
          v-model="search"
          placeholder="在庫を検索"
          class="search"
        />

        <div class="list">
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
          <div v-if="!filtered.length" class="empty">
            在庫がありません。先に仕入を登録してください。
          </div>
        </div>

        <footer>
          <div class="calc">
            <span class="faint">{{ matchedItems.length + picked.size }}点</span>
            <span class="num">原価 {{ yen(totalCost) }}</span>
            <strong
              class="num"
              :class="previewProfit >= 0 ? 'profit' : 'loss'"
            >
              粗利 {{ yen(previewProfit) }}
            </strong>
          </div>
          <button class="primary" :disabled="!picked.size" @click="confirmMatch">
            紐付ける
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap { max-width: 1100px; }

.bar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
  font-size: 13px;
}
.bar label { cursor: pointer; }

.form { margin-bottom: 16px; display: flex; flex-direction: column; gap: 14px; }
.head { display: flex; gap: 16px; flex-wrap: wrap; }
.head label { display: flex; flex-direction: column; gap: 4px; }
.head span { font-size: 12px; color: var(--text-dim); }
.full { width: 100%; }

.nowrap { white-space: nowrap; }
.title div { line-height: 1.4; }

.kind {
  font-size: 11px;
  padding: 0 7px;
  margin-top: 3px;
  border-radius: 999px;
  color: var(--text-dim);
}
.kind.personal { color: var(--accent); border-color: #3c6488; }

select.unset {
  border-color: var(--warn);
  color: var(--warn);
}

.packaging {
  width: 70px;
}

.link-btn {
  font-size: 12px;
  padding: 3px 10px;
  color: var(--warn);
  border-color: var(--warn);
  background: var(--warn-bg);
}

.cost-btn {
  background: transparent;
  border-color: transparent;
  padding: 0;
  color: var(--text);
  font: inherit;
}
.cost-btn:hover:not(:disabled) {
  background: transparent;
  text-decoration: underline;
}

/* --- 紐付けパネル --- */

.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}

.panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  width: 640px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.panel header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  border-bottom: 1px solid var(--line-soft);
}
.panel h3 { margin: 0 0 2px; font-size: 15px; font-weight: 500; }
.panel header button { margin-left: auto; }

.matched {
  padding: 10px 16px 0;
  border-bottom: 1px solid var(--line-soft);
}
.matched-head {
  font-size: 12px;
  margin-bottom: 4px;
}
.matched-item {
  padding: 6px 8px;
  cursor: default;
}
.matched-item .small {
  font-size: 12px;
  padding: 2px 8px;
}

.search { margin: 12px 16px 8px; }

.list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px;
}

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.item:hover { background: var(--surface-hi); }
.item.on { background: #24332a; }

.panel footer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  border-top: 1px solid var(--line-soft);
}
.calc { display: flex; gap: 14px; align-items: baseline; font-size: 13px; }
.panel footer button { margin-left: auto; }
</style>
