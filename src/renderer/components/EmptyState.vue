<script setup lang="ts">
defineProps<{
  title: string
  hint?: string
}>()
</script>

<template>
  <div class="empty-state">
    <p class="empty-title">{{ title }}</p>
    <p v-if="hint" class="empty-hint">{{ hint }}</p>
    <div v-if="$slots.action" class="empty-action">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  padding: 48px 16px;
  text-align: center;
}
.empty-title { margin: 0; font-size: var(--fs-14); color: var(--text-dim); }
.empty-hint  { margin: 6px 0 0; font-size: var(--fs-13); color: var(--text-faint); }
.empty-action { margin-top: 16px; display: flex; justify-content: center; }
</style>
