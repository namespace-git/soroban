<script setup lang="ts">
import { ref, onMounted, computed, watch, inject, type Ref } from 'vue'
import type { PurchaseSummary, ShopAccount, PurchaseLineInput, AllocMethod } from '../../shared/types'
import { todayLocal } from '../../shared/date'

const purchases = ref<PurchaseSummary[]>([])
const accounts = ref<ShopAccount[]>([])
const revision = inject<Ref<number>>('revision')!
const showForm = ref(false)

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
}

async function remove(p: PurchaseSummary) {
  if (!confirm(`${p.ordered_at} の仕入を削除しますか？\n生成された在庫も消えます。`)) return
  try {
    await window.soroban.deletePurchase(p.id)
    await load()
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
  <div class="wrap">
    <div class="bar">
      <button class="primary" @click="showForm = !showForm">
        {{ showForm ? '閉じる' : '仕入を登録' }}
      </button>
      <span class="grow" />
      <button class="ghost" @click="addAccount">仕入先を追加</button>
    </div>

    <!-- 登録フォーム -->
    <div v-if="showForm" class="card form">
      <div class="head">
        <label>
          <span>仕入先</span>
          <select v-model="form.shop_account_id">
            <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
        </label>
        <label>
          <span>注文日</span>
          <input type="date" v-model="form.ordered_at" />
        </label>
        <label>
          <span>注文番号</span>
          <input v-model="form.order_no" placeholder="任意" />
        </label>
      </div>

      <table class="lines">
        <thead>
          <tr>
            <th>商品名</th>
            <th style="width:110px">単価</th>
            <th style="width:80px">数量</th>
            <th style="width:110px">小計</th>
            <th style="width:36px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(l, i) in form.lines" :key="i">
            <td><input v-model="l.name" class="full" placeholder="商品名" /></td>
            <td><input type="number" v-model.number="l.unit_price" class="full" /></td>
            <td><input type="number" v-model.number="l.quantity" class="full" min="1" /></td>
            <td class="num dim">{{ yen((l.unit_price || 0) * (l.quantity || 0)) }}</td>
            <td><button class="ghost" @click="removeLine(i)">✕</button></td>
          </tr>
        </tbody>
      </table>

      <button class="ghost add" @click="addLine">＋ 明細を追加</button>

      <div class="head">
        <label>
          <span>送料</span>
          <input type="number" v-model.number="form.shipping_fee" />
        </label>
        <label>
          <span>その他費用</span>
          <input type="number" v-model.number="form.other_cost" />
        </label>
        <label>
          <span>割引・クーポン</span>
          <input type="number" v-model.number="form.discount" />
        </label>
        <label>
          <span>按分方式</span>
          <select v-model="form.alloc_method">
            <option value="by_amount">金額で按分</option>
            <option value="by_quantity">数量で按分</option>
          </select>
        </label>
      </div>

      <p class="alloc faint">
        明細合計 {{ yen(subtotal) }} ／ 配賦 {{ yen(pool) }} を
        {{ totalQty }}点に按分 → 総原価 {{ yen(subtotal + pool) }}
      </p>

      <div class="row">
        <span class="grow" />
        <button class="primary" @click="submit">登録して在庫を作る</button>
      </div>
    </div>

    <!-- 一覧 -->
    <table v-if="purchases.length">
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
          <td><button class="ghost" @click="remove(p)">✕</button></td>
        </tr>
      </tbody>
    </table>

    <div v-else-if="!showForm" class="empty">
      仕入がまだありません。「仕入を登録」から追加してください。
    </div>
  </div>
</template>

<style scoped>
.wrap { max-width: 1000px; }

.bar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }

.form { margin-bottom: 24px; display: flex; flex-direction: column; gap: 14px; }

.head { display: flex; gap: 16px; flex-wrap: wrap; }
.head label { display: flex; flex-direction: column; gap: 4px; }
.head span { font-size: 12px; color: var(--text-dim); }

.lines th { padding: 4px 6px; }
.lines td { padding: 4px 6px; border-bottom: none; }
.full { width: 100%; }

.add { align-self: flex-start; font-size: 13px; }

.alloc {
  font-size: 12px;
  padding: 8px 10px;
  background: var(--bg);
  border-radius: var(--radius-sm);
}
</style>
