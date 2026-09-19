<script lang="ts">
// 検索の絞り込みロジック（正規化 + 空白区切り AND）。各画面で検索対象の項目が
// 違うため、絞り込み自体は呼び出し側（各 view の computed）で行う。
export function normalizeSearchText(s: string): string {
  return s.normalize('NFKC').toLowerCase()
}

/** query を空白区切りにし、haystacks のどれかに全語が含まれるか（AND） */
export function matchesSearch(haystacks: Array<string | null | undefined>, query: string): boolean {
  const terms = normalizeSearchText(query).trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const normalized = haystacks.filter((h): h is string => !!h).map(normalizeSearchText)
  return terms.every(term => normalized.some(h => h.includes(term)))
}
</script>

<script setup lang="ts">
// 全画面共通の検索ボックス。呼び出し側は v-model="text" で文字列を受け取る。
import Icon from './Icon.vue'

withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
}>(), {
  placeholder: '検索',
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}
function clear() {
  emit('update:modelValue', '')
}
</script>

<template>
  <label class="search-box">
    <Icon name="search" :size="16" class="search-box-icon" />
    <input
      type="text"
      class="search-box-input"
      :value="modelValue"
      :placeholder="placeholder"
      @input="onInput"
    />
    <button
      v-if="modelValue"
      type="button"
      class="icon ghost search-box-clear"
      aria-label="検索をクリア"
      @click="clear"
    >
      <Icon name="close" :size="12" />
    </button>
  </label>
</template>

<style scoped>
.search-box {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 260px;
  flex-shrink: 0;
}
.search-box-icon {
  position: absolute;
  left: 10px;
  color: var(--text-faint);
  pointer-events: none;
}
.search-box-input {
  width: 100%;
  height: 36px;
  border-radius: var(--radius-md);
  padding: 6px 30px;
}
.search-box-clear {
  position: absolute;
  right: 4px;
  width: 24px;
  height: 24px;
  color: var(--text-faint);
}
</style>
