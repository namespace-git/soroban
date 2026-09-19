<script setup lang="ts">
defineProps<{
  tone: 'warn' | 'ok' | 'neutral' | 'info'
  label: string
}>()
</script>

<template>
  <span class="chip" :class="tone">{{ label }}</span>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: var(--fs-12);
  line-height: 1.6;
  white-space: nowrap;
}
.chip.warn    { background: var(--warn-bg); color: var(--warn); }
.chip.ok      { background: var(--profit-bg); color: var(--profit); }
.chip.neutral { background: var(--surface-hi); color: var(--text-dim); }
.chip.info    { background: var(--accent-soft); color: var(--accent); }
</style>
