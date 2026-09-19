<script setup lang="ts">
defineProps<{
  tone: 'warn' | 'ok' | 'neutral' | 'info' | 'brand' | 'loss'
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
  padding: 2px 10px;
  border-radius: 999px;
  font-size: var(--fs-12);
  font-weight: 600;
  line-height: 1.6;
  white-space: nowrap;
}
.chip.warn    { background: var(--warn-solid); color: #fff; }
.chip.ok      { background: var(--profit-solid); color: #fff; }
.chip.neutral { background: var(--surface-hi); color: var(--text-dim); }
.chip.info    { background: var(--info-bg); color: var(--info); }
.chip.brand   { background: var(--brand); color: var(--text); }
.chip.loss    { background: var(--loss-solid); color: #fff; }
</style>
