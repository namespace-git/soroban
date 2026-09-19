<script setup lang="ts">
import { ref, onMounted, computed, watch, inject, type Ref } from 'vue'
import type { PurchaseSummary, ShopAccount, PurchaseLineInput, AllocMethod } from '../../shared/types'
import { todayLocal } from '../../shared/date'
import Icon from '../components/Icon.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'

const purchases = ref<PurchaseSummary[]>([])
const accounts = ref<ShopAccount[]>([])
const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})
const showForm = ref(false)
const loaded = ref(false)

const form = ref({
  shop_account_id: '',
  ordered_at: todayLocal(),
  order_no: '',
  shipping_fee: 0,
  other_cost: 0,
  discount: 0,
  alloc_method: 'by_amount' as AllocMethod,
  lines: [{ name: '', unit_price: 0, quantity: 1 }] as PurchaseLineInput[],
})

const yen = (n: number) => '¥' + n.toLocaleString('ja-JP')

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
  if (!lines.length) { alert('明細を入力してください'); return }
  if (!form.value.shop_account_id) { alert('仕入先を選んでください'); return }

  await window.soroban.createPurchase({ ...form.value, lines })

  form.value.order_no = ''
  form.value.shipping_fee = 0
  form.value.other_cost = 0
  form.value.discount = 0
  form.value.lines = [{ name: '', unit_price: 0, quantity: 1 }]
  showForm.value = false
  await load()
  changed()
}

async function remove(p: PurchaseSummary) {
  if (!confirm(`${p.ordered_at} の仕入を削除しますか？\n生成された在庫も消えます。`)) return
  try {
    await window.soroban.deletePurchase(p.id)
    await load()
    changed()
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
  }
}

async function addAccount() {
  const name = prompt('仕入先の名前（例：メロジョイA）')
  if (!name) return
  await window.soroban.createShopAccount(name)
  await load()
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">仕入</h1>
      <span class="grow" />
      <button class="ghost" @click="addAccount">仕入先を追加</button>
      <button class="primary" @click="showForm = !showForm">
        <Icon :name="showForm ? 'close' : 'plus'" :size="16" />
        {{ showForm ? '閉じる' : '仕入を登録' }}
      </button>
    </div>

    <!-- 登録フォーム -->
    <div v-if="showForm" class="panel form">
      <div class="fields">
        <label class="field">
          <span>仕入先</span>
          <select v-model="form.shop_account_id">
            <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
        </label>
        <label class="field">
          <span>注文日</span>
          <input type="date" v-model="form.ordered_at" />
        </label>
        <label class="field">
          <span>注文番号</span>
          <input v-model="form.order_no" placeholder="任意" />
        </label>
      </div>

      <table class="compact lines-table">
        <thead>
          <tr>
            <th>商品名</th>
            <th class="num col-price">単価</th>
            <th class="num col-qty">数量</th>
            <th class="num col-subtotal">小計</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(l, i) in form.lines" :key="i">
            <td><input v-model="l.name" class="full" placeholder="商品名" /></td>
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
          <span>送料</span>
          <input type="number" v-model.number="form.shipping_fee" />
        </label>
        <label class="field">
          <span>その他費用</span>
          <input type="number" v-model.number="form.other_cost" />
        </label>
        <label class="field">
          <span>割引・クーポン</span>
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
        <button class="primary" @click="submit">登録して在庫を作る</button>
      </div>
    </div>

    <Skeleton v-if="!loaded" :rows="5" />

    <template v-else>
      <div v-if="purchases.length" class="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>注文日</th>
              <th>仕入先</th>
              <th>注文番号</th>
              <th class="num">明細</th>
              <th class="num">商品計</th>
              <th class="num">送料</th>
              <th class="num">総原価</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in purchases" :key="p.id">
              <td class="faint">{{ p.ordered_at }}</td>
              <td>{{ p.shop_account_name }}</td>
              <td class="faint">{{ p.order_no ?? '—' }}</td>
              <td class="num">{{ p.line_count }}</td>
              <td class="num">{{ yen(p.subtotal) }}</td>
              <td class="num dim">{{ yen(p.shipping_fee) }}</td>
              <td class="num"><strong>{{ yen(p.total_cost) }}</strong></td>
              <td class="actions">
                <button class="icon ghost" aria-label="削除" @click="remove(p)">
                  <Icon name="trash" :size="16" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

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
  </div>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-bottom: 16px;
}

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
</style>
