<script setup lang="ts">
import { ref, onMounted, computed, watch, inject, type Ref } from 'vue'
import type { MonthlySummary, Expense, ExpenseCategory } from '../../shared/types'
import { todayLocal, thisMonthLocal } from '../../shared/date'
import Icon from '../components/Icon.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'
import StatusChip from '../components/StatusChip.vue'

const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!

const monthly = ref<MonthlySummary[]>([])
const loaded = ref(false)
const revision = inject<Ref<number>>('revision')!

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')

async function load() {
  monthly.value = await window.soroban.listMonthly()
  loaded.value = true
}
onMounted(load)
watch(revision, load)

// 転売/私物を横に並べる
const months = computed(() => {
  const map = new Map<string, { resale?: MonthlySummary; personal?: MonthlySummary }>()
  for (const m of monthly.value) {
    const e = map.get(m.month) ?? {}
    e[m.kind] = m
    map.set(m.month, e)
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]))
})

// 表示中の全月の合計行
const totals = computed(() => {
  let salesCount = 0, revenue = 0, cost = 0, fee = 0, shipping = 0, profit = 0
  let expenseTotal = 0, netProfit = 0
  let personalCount = 0, personalRevenue = 0
  for (const [, e] of months.value) {
    if (e.resale) {
      salesCount += e.resale.sales_count
      revenue += e.resale.revenue
      cost += e.resale.total_cost
      fee += e.resale.total_fee
      shipping += e.resale.total_shipping
      profit += e.resale.gross_profit
      expenseTotal += e.resale.expense_total
      netProfit += e.resale.net_profit
    }
    if (e.personal) {
      personalCount += e.personal.sales_count
      personalRevenue += e.personal.revenue
    }
  }
  return { salesCount, revenue, cost, fee, shipping, profit, expenseTotal, netProfit, personalCount, personalRevenue }
})

// --- 期間費用の内訳。転売の行だけ、期間費用セルをクリックして展開する ---

const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  transfer_fee: '振込手数料',
  supplies: '梱包材',
  other: 'その他',
}

interface ExpenseFormState {
  occurred_at: string
  category: ExpenseCategory
  amount: number
  note: string
}

/** 追加フォームの既定日：今月ならその日、それ以外の月は月末（未来日にはしない） */
function defaultExpenseDate(month: string): string {
  if (month === thisMonthLocal()) return todayLocal()
  const [y, m] = month.split('-').map(Number)
  const lastDay = new Date(y, m, 0).getDate()
  const end = `${month}-${String(lastDay).padStart(2, '0')}`
  return end > todayLocal() ? todayLocal() : end
}

function emptyForm(month: string): ExpenseFormState {
  return { occurred_at: defaultExpenseDate(month), category: 'other', amount: 0, note: '' }
}

const expandedMonth = ref<string | null>(null)
const expensesByMonth = ref<Record<string, Expense[]>>({})
const form = ref<ExpenseFormState>(emptyForm(thisMonthLocal()))

async function loadExpenses(month: string) {
  expensesByMonth.value[month] = await window.soroban.listExpenses(month)
}

async function toggleExpenses(month: string) {
  if (expandedMonth.value === month) {
    expandedMonth.value = null
    return
  }
  expandedMonth.value = month
  form.value = emptyForm(month)
  if (!expensesByMonth.value[month]) await loadExpenses(month)
}

async function addExpense(month: string) {
  if (!form.value.amount || form.value.amount <= 0) {
    toast('金額を入力してください', 'warn')
    return
  }
  await window.soroban.createExpense({
    occurred_at: form.value.occurred_at,
    category: form.value.category,
    amount: Math.round(form.value.amount),
    note: form.value.note.trim() || null,
  })
  form.value = emptyForm(month)
  await loadExpenses(month)
  await load()
  toast('期間費用を追加しました', 'ok')
}

async function removeExpense(month: string, expense: Expense) {
  if (!await confirmDialog('この期間費用を削除しますか？', { okLabel: '削除する', danger: true })) return
  await window.soroban.deleteExpense(expense.id)
  await loadExpenses(month)
  await load()
  toast('削除しました', 'ok')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">月次</h1>
    </div>

    <div class="panel table-panel">
      <div class="section-head">
        <span class="section-head-icon"><Icon name="monthly" :size="16" /></span>
        <h2 class="section-head-title">月次</h2>
      </div>
      <div v-if="!loaded" class="table-pad"><Skeleton :rows="4" /></div>
      <table v-else-if="months.length">
        <thead>
          <tr>
            <th rowspan="2">月</th>
            <th colspan="8">転売</th>
            <th class="group-l" colspan="2">私物</th>
          </tr>
          <tr>
            <th class="num">件数</th>
            <th class="num">売上</th>
            <th class="num">原価</th>
            <th class="num">手数料</th>
            <th class="num">送料</th>
            <th class="num">粗利</th>
            <th class="num">期間費用</th>
            <th class="num">純利益</th>
            <th class="num group-l">件数</th>
            <th class="num">売上</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="[month, e] in months" :key="month">
            <tr>
              <td class="month-cell">
                {{ month }}
                <StatusChip
                  v-if="(e.resale?.unconfirmed_shipping ?? 0) > 0"
                  tone="warn"
                  :label="`送料未入力 ${e.resale?.unconfirmed_shipping}件`"
                  title="その分は送料0で集計しています"
                />
              </td>
              <td class="num">{{ e.resale?.sales_count ?? 0 }}</td>
              <td class="num">{{ yen(e.resale?.revenue ?? 0) }}</td>
              <td class="num dim">{{ yen(e.resale?.total_cost ?? 0) }}</td>
              <td class="num dim">{{ yen(e.resale?.total_fee ?? 0) }}</td>
              <td class="num dim">{{ yen(e.resale?.total_shipping ?? 0) }}</td>
              <td class="num">
                <strong :class="(e.resale?.gross_profit ?? 0) >= 0 ? 'profit' : 'loss'">
                  {{ yen(e.resale?.gross_profit ?? 0) }}
                </strong>
              </td>
              <td class="num">
                <button
                  v-if="e.resale"
                  class="expense-btn"
                  :class="{ open: expandedMonth === month }"
                  title="クリックで内訳を編集"
                  @click="toggleExpenses(month)"
                >{{ yen(e.resale.expense_total) }}</button>
                <span v-else class="faint">—</span>
              </td>
              <td class="num">
                <strong v-if="e.resale" :class="e.resale.net_profit >= 0 ? 'profit' : 'loss'">
                  {{ yen(e.resale.net_profit) }}
                </strong>
                <span v-else class="faint">—</span>
              </td>
              <td class="num group-l faint">{{ e.personal?.sales_count ?? 0 }}</td>
              <td class="num faint">{{ yen(e.personal?.revenue ?? 0) }}</td>
            </tr>
            <tr v-if="expandedMonth === month" class="expense-detail-row">
              <td colspan="11">
                <div class="expense-panel">
                  <table v-if="expensesByMonth[month]?.length" class="compact expense-table">
                    <thead>
                      <tr>
                        <th>日付</th>
                        <th>区分</th>
                        <th class="num">金額</th>
                        <th>メモ</th>
                        <th></th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="ex in expensesByMonth[month]" :key="ex.id">
                        <td class="faint nowrap">{{ ex.occurred_at }}</td>
                        <td>{{ CATEGORY_LABEL[ex.category] }}</td>
                        <td class="num">{{ yen(ex.amount) }}</td>
                        <td class="faint">{{ ex.note ?? '' }}</td>
                        <td><StatusChip v-if="ex.auto" tone="neutral" label="自動" /></td>
                        <td class="actions">
                          <button class="icon ghost" aria-label="削除" @click="removeExpense(month, ex)">
                            <Icon name="trash" :size="14" />
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <p v-else class="faint expense-empty">この月の期間費用はまだありません</p>

                  <div class="expense-form">
                    <input type="date" v-model="form.occurred_at" />
                    <select v-model="form.category">
                      <option value="transfer_fee">振込手数料</option>
                      <option value="supplies">梱包材</option>
                      <option value="other">その他</option>
                    </select>
                    <input
                      type="number" v-model.number="form.amount"
                      min="0" placeholder="金額" class="expense-amount"
                    />
                    <input v-model="form.note" placeholder="メモ（任意）" class="expense-note" />
                    <button class="sm primary" @click="addExpense(month)">追加</button>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
        <tfoot>
          <tr class="total-row" :class="{ loss: totals.profit < 0 }">
            <td>合計</td>
            <td class="num">{{ totals.salesCount }}</td>
            <td class="num">{{ yen(totals.revenue) }}</td>
            <td class="num">{{ yen(totals.cost) }}</td>
            <td class="num">{{ yen(totals.fee) }}</td>
            <td class="num">{{ yen(totals.shipping) }}</td>
            <td class="num">
              <strong :class="totals.profit >= 0 ? 'profit' : 'loss'">{{ yen(totals.profit) }}</strong>
            </td>
            <td class="num">{{ yen(totals.expenseTotal) }}</td>
            <td class="num">
              <strong :class="totals.netProfit >= 0 ? 'profit' : 'loss'">{{ yen(totals.netProfit) }}</strong>
            </td>
            <td class="num group-l">{{ totals.personalCount }}</td>
            <td class="num">{{ yen(totals.personalRevenue) }}</td>
          </tr>
        </tfoot>
      </table>
      <EmptyState
        v-else
        title="月次の集計はまだありません"
        hint="販売を登録すると月ごとに集計されます"
      />
    </div>

    <p v-if="loaded" class="note faint">
      私物の売却は転売と税務上の扱いが異なるため、列を分けています。
      粗利は転売分のみの集計です。
    </p>
    <p v-if="loaded" class="note faint">
      送料未入力の販売は送料0で集計されています。売上タブで発送方法を選ぶと直ります。
    </p>
  </div>
</template>

<style scoped>
.table-panel { padding: 0; overflow: hidden; }
.table-panel .section-head { padding: 16px 20px 0; margin-bottom: 12px; }
.table-pad { padding: 0 20px 16px; }
.group-l { border-left: 1px solid var(--line); }
.note { font-size: var(--fs-12); margin: 12px 4px 0; }

.month-cell {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.expense-btn {
  background: transparent;
  border-color: transparent;
  padding: 0;
  height: auto;
  font: inherit;
  color: var(--text);
}
.expense-btn:hover:not(:disabled) {
  background: transparent;
  text-decoration: underline;
}
.expense-btn.open { color: var(--accent); text-decoration: underline; }

.expense-detail-row td { padding: 0; background: var(--surface-hi); }
.expense-panel { padding: 14px 20px; }
.expense-table { width: 100%; }
.expense-table td.actions { text-align: right; }
.expense-empty { margin: 0 0 10px; }

.expense-form {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.expense-amount { width: 100px; }
.expense-note { flex: 1; min-width: 120px; }
</style>
