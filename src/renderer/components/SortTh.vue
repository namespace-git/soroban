<script setup lang="ts">
// 並び替え可能な列見出し。table の <th> そのものを描画する（呼び出し側は
// <th>...</th> の代わりに <SortTh ... /> を置く）。
import { computed } from 'vue'
import type { SortDir } from '../composables/useSort'

const props = withDefaults(defineProps<{
  label: string
  sortKey: string
  activeKey: string | null
  dir: SortDir
  align?: 'left' | 'right'
}>(), {
  align: 'left',
})

const emit = defineEmits<{ sort: [key: string] }>()

const isActive = computed(() => props.activeKey === props.sortKey)
const ariaSort = computed<'ascending' | 'descending' | 'none'>(() =>
  !isActive.value ? 'none' : props.dir === 'asc' ? 'ascending' : 'descending',
)
</script>

<template>
  <th
    class="sortable"
    :class="{ num: align === 'right', active: isActive }"
    :aria-sort="ariaSort"
    @click="emit('sort', sortKey)"
  >
    {{ label }}
    <span v-if="isActive" class="sort-arrow">{{ dir === 'asc' ? '▲' : '▼' }}</span>
  </th>
</template>

<style scoped>
.sortable {
  cursor: pointer;
  user-select: none;
}
.sortable:hover {
  color: var(--text);
}
.sort-arrow {
  font-size: 10px;
  margin-left: 2px;
}
</style>
