<script setup lang="ts">
import { ref, onMounted, computed, watch, inject, type Ref } from 'vue'
import type { InventoryItem, InventoryStatus } from '../../shared/types'
import StatusChip from '../components/StatusChip.vue'
import EmptyState from '../components/EmptyState.vue'
import Skeleton from '../components/Skeleton.vue'

const items = ref<InventoryItem[]>([])
const status = ref<InventoryStatus>('in_stock')
const warnDays = ref(90)
const loaded = ref(false)
const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})

const yen = (n: number) => '¥' + n.toLocaleString('ja-JP')

async function load() {
  items.value = await window.soroban.listInventory(status.value)
  const s = await window.soroban.getSettings()
  warnDays.value = Number(s.aging_warn_days ?? 90)
  loaded.value = true
}
onMounted(load)
watch([revision, status], load)

const total = computed(() => items.value.reduce((s, i) => s + i.landed_cost, 0))

async function dispose(item: InventoryItem, target: 'disposed' | 'personal_use') {
  const label = target === 'personal_use' ? '自家消費' : '廃棄'
  if (!confirm(`「${item.name}」を${label}として在庫から外しますか？`)) return
  await window.soroban.disposeInventory(item.id, label, target)
  await load()
  changed()
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">在庫</h1>
    </div>

    <div class="toolbar">
      <select v-model="status">
        <option value="in_stock">未販売</option>
        <option value="sold">販売済み</option>
        <option value="disposed">廃棄</option>
        <option value="personal_use">自家消費</option>
      </select>
      <span class="grow" />
      <span class="faint">{{ items.length }}点 ／ 原価計 {{ yen(total) }}</span>
    </div>

    <div class="panel table-panel">
      <Skeleton v-if="!loaded" :rows="6" />
      <table v-else-if="items.length">
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
              <StatusChip
                v-if="i.aging_days >= warnDays"
                tone="warn" :label="`${i.aging_days}日`"
              />
              <span v-else>{{ i.aging_days }}日</span>
            </td>
            <td class="num">{{ yen(i.landed_cost) }}</td>
            <td class="actions">
              <template v-if="i.status === 'in_stock'">
                <button class="sm ghost" @click="dispose(i, 'disposed')" title="在庫から外して廃棄にする">廃棄</button>
                <button class="sm ghost" @click="dispose(i, 'personal_use')" title="在庫から外して自家消費にする">自家消費</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-else title="該当する在庫がありません" />
    </div>
  </div>
</template>

<style scoped>
.table-panel { padding: 0; overflow: hidden; }
.table-panel table { table-layout: fixed; }
.table-panel th:nth-child(1) { width: 32%; }
.table-panel th:nth-child(2) { width: 18%; }
.table-panel th:nth-child(3) { width: 14%; }
.table-panel th:nth-child(4) { width: 12%; }
.table-panel th:nth-child(5) { width: 12%; }
.table-panel th:last-child,
.table-panel td.actions { width: 150px; white-space: nowrap; }
.table-panel .actions { display: flex; justify-content: flex-end; gap: 4px; }
.table-panel .actions button { white-space: nowrap; }
</style>
