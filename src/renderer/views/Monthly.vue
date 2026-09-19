<script setup lang="ts">
import { ref, onMounted, computed, watch, inject, type Ref } from 'vue'
import type { MonthlySummary } from '../../shared/types'
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
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">月次</h1>
    </div>

    <div class="panel table-panel">
      <Skeleton v-if="!loaded" :rows="4" />
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
.group-l { border-left: 1px solid var(--line); }
.note { font-size: var(--fs-12); margin: 12px 4px 0; }
</style>
