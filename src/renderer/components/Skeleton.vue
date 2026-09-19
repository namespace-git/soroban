<script setup lang="ts">
withDefaults(defineProps<{
  rows?: number
  kind?: 'table' | 'stats'
}>(), {
  rows: 5,
  kind: 'table',
})
</script>

<template>
  <div v-if="kind === 'table'" class="sk-table" aria-hidden="true">
    <div v-for="i in rows" :key="i" class="sk-row">
      <span class="sk-bar" style="width: 14%" />
      <span class="sk-bar" style="width: 32%" />
      <span class="sk-bar" style="width: 12%" />
      <span class="sk-bar" style="width: 18%" />
      <span class="sk-bar" style="width: 10%" />
    </div>
  </div>
  <div v-else class="sk-stats" aria-hidden="true">
    <span v-for="i in rows" :key="i" class="sk-bar sk-stat" />
  </div>
</template>

<style scoped>
.sk-table { display: flex; flex-direction: column; gap: 10px; }
.sk-row { display: flex; gap: 16px; align-items: center; }
.sk-stats { display: flex; gap: 24px; }

.sk-bar {
  display: inline-block;
  height: 14px;
  border-radius: var(--radius-sm);
  background: var(--surface-hi);
  animation: sk-pulse 1.2s ease-in-out infinite;
}
.sk-stat { width: 90px; height: 20px; }

@keyframes sk-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: .55; }
}

@media (prefers-reduced-motion: reduce) {
  .sk-bar { animation: none; opacity: .75; }
}
</style>
