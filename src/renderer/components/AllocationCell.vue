<script setup lang="ts">
import CodeChip from './CodeChip.vue'
import StatusChip from './StatusChip.vue'
import Icon from './Icon.vue'
import { yen } from '../format'

defineProps<{ linked: boolean; cost: number; codes: string[]; automatic?: boolean; hint?: string | null; readonly?: boolean }>()
defineEmits<{ open: [] }>()
</script>

<template>
  <div class="allocation-cell">
    <div class="allocation-state">
      <span v-if="linked" class="num">{{ yen(cost) }}</span>
      <StatusChip v-else tone="warn" label="未紐付け" />
    </div>
    <button type="button" class="sm link-btn" @click="$emit('open')">
      <Icon name="link" :size="14" />
      {{ readonly ? '紐付けを確認' : linked ? '紐付けを編集' : '在庫を選ぶ' }}
    </button>
    <div v-if="codes.length" class="allocation-codes">
      <CodeChip v-for="code in codes" :key="code" kind="item" :code="code" />
    </div>
    <span v-if="automatic" class="faint">自動紐付け</span>
    <span v-if="hint" class="faint">{{ hint }}</span>
  </div>
</template>

<style scoped>
.allocation-cell { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; }
.allocation-state { min-height: 22px; display: flex; align-items: center; }
.allocation-codes { display: flex; flex-wrap: wrap; gap: 4px; }
.link-btn { white-space: nowrap; }
.faint { font-size: var(--fs-12); }
</style>
