<script setup lang="ts">
import { ref, onMounted, computed, watch, inject, type Ref } from 'vue'
import type { MonthlySummary } from '../../shared/types'
import Icon from '../components/Icon.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'

const monthly = ref<MonthlySummary[]>([])
const loaded = ref(false)
const revision = inject<Ref<number>>('revision')!

const yen = (n: number) => '¥' + n.toLocaleString('ja-JP')

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
  let personalCount = 0, personalRevenue = 0
  for (const [, e] of months.value) {
    if (e.resale) {
      salesCount += e.resale.sales_count
      revenue += e.resale.revenue
      cost += e.resale.total_cost
      fee += e.resale.total_fee
      shipping += e.resale.total_shipping
      profit += e.resale.gross_profit
    }
    if (e.personal) {
      personalCount += e.personal.sales_count
      personalRevenue += e.personal.revenue
    }
  }
  return { salesCount, revenue, cost, fee, shipping, profit, personalCount, personalRevenue }
})
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
            <th colspan="6">転売</th>
            <th class="group-l" colspan="2">私物</th>
          </tr>
          <tr>
            <th class="num">件数</th>
            <th class="num">売上</th>
            <th class="num">原価</th>
            <th class="num">手数料</th>
            <th class="num">送料</th>
            <th class="num">粗利</th>
            <th class="num group-l">件数</th>
            <th class="num">売上</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="[month, e] in months" :key="month">
            <td>{{ month }}</td>
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
            <td class="num group-l faint">{{ e.personal?.sales_count ?? 0 }}</td>
            <td class="num faint">{{ yen(e.personal?.revenue ?? 0) }}</td>
          </tr>
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
  </div>
</template>

<style scoped>
.table-panel { padding: 0; overflow: hidden; }
.table-panel .section-head { padding: 16px 20px 0; margin-bottom: 12px; }
.table-pad { padding: 0 20px 16px; }
.group-l { border-left: 1px solid var(--line); }
.note { font-size: var(--fs-12); margin: 12px 4px 0; }
</style>
