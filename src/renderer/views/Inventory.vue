<script setup lang="ts">
import { ref, onMounted, computed, watch, inject, type Ref } from 'vue'
import type { InventoryItem, InventoryStatus, MonthlySummary } from '../../shared/types'

const items = ref<InventoryItem[]>([])
const monthly = ref<MonthlySummary[]>([])
const status = ref<InventoryStatus>('in_stock')
const warnDays = ref(90)
const tab = ref<'stock' | 'monthly'>('stock')
const revision = inject<Ref<number>>('revision')!

const yen = (n: number) => '¥' + n.toLocaleString('ja-JP')

async function load() {
  items.value = await window.soroban.listInventory(status.value)
  monthly.value = await window.soroban.listMonthly()
  const s = await window.soroban.getSettings()
  warnDays.value = Number(s.aging_warn_days ?? 90)
}
onMounted(load)
watch([revision, status], load)

const total = computed(() => items.value.reduce((s, i) => s + i.landed_cost, 0))

// 月次は転売/私物を横に並べる
const months = computed(() => {
  const map = new Map<string, { resale?: MonthlySummary; personal?: MonthlySummary }>()
  for (const m of monthly.value) {
    const e = map.get(m.month) ?? {}
    e[m.kind] = m
    map.set(m.month, e)
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]))
})

async function dispose(item: InventoryItem, status: 'disposed' | 'personal_use') {
  const label = status === 'personal_use' ? '自家消費' : '廃棄'
  if (!confirm(`「${item.name}」を${label}として在庫から外しますか？`)) return
  await window.soroban.disposeInventory(item.id, label, status)
  await load()
}
</script>

<template>
  <div class="wrap">
    <div class="bar">
      <button class="ghost" :class="{ on: tab === 'stock' }" @click="tab = 'stock'">在庫</button>
      <button class="ghost" :class="{ on: tab === 'monthly' }" @click="tab = 'monthly'">月次</button>
    </div>

    <!-- 在庫 -->
    <template v-if="tab === 'stock'">
      <div class="bar">
        <select v-model="status">
          <option value="in_stock">未販売</option>
          <option value="sold">販売済み</option>
          <option value="disposed">廃棄</option>
          <option value="personal_use">自家消費</option>
        </select>
        <span class="grow" />
        <span class="faint">{{ items.length }}点 ／ 原価計 {{ yen(total) }}</span>
      </div>

      <table v-if="items.length">
        <thead>
          <tr>
            <th>商品</th>
            <th>仕入先</th>
            <th>仕入日</th>
            <th class="num">滞留</th>
            <th class="num">原価</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="i in items" :key="i.id">
            <td>{{ i.name }}</td>
            <td class="faint">{{ i.shop_account_name ?? '—' }}</td>
            <td class="faint">{{ i.acquired_at }}</td>
            <td class="num">
              <span :class="{ warn: i.aging_days >= warnDays }">{{ i.aging_days }}日</span>
            </td>
            <td class="num">{{ yen(i.landed_cost) }}</td>
            <td class="actions">
              <button
                v-if="i.status === 'in_stock'"
                class="ghost small" @click="dispose(i, 'disposed')" title="在庫から外して廃棄にする"
              >廃棄</button>
              <button
                v-if="i.status === 'in_stock'"
                class="ghost small" @click="dispose(i, 'personal_use')" title="在庫から外して自家消費にする"
              >自家消費</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">該当する在庫がありません</div>
    </template>

    <!-- 月次 -->
    <template v-else>
      <table v-if="months.length">
        <thead>
          <tr>
            <th>月</th>
            <th class="num">件数</th>
            <th class="num">売上</th>
            <th class="num">原価</th>
            <th class="num">手数料</th>
            <th class="num">送料</th>
            <th class="num">粗利</th>
            <th class="num">私物売上</th>
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
            <td class="num faint">
              {{ e.personal ? yen(e.personal.revenue) : '—' }}
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">まだ販売がありません</div>

      <p class="note faint">
        私物の売却は転売と税務上の扱いが異なるため、列を分けています。
        粗利は転売分のみの集計です。
      </p>
    </template>
  </div>
</template>

<style scoped>
.wrap { max-width: 1000px; }
.bar { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
.bar button.on { background: var(--surface-hi); color: var(--text); }
.warn { color: var(--warn); }
.note { font-size: 12px; margin-top: 16px; }
.actions { display: flex; gap: 4px; }
.actions .small { font-size: 12px; padding: 2px 8px; }
</style>
