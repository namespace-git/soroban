<script setup lang="ts">
// 在庫コード（S-0012）・型番チップ。クリックで【code】をコピーする（メルカリのタイトルに貼ると
// 自動で引き当て・紐付けされる）。見た目は StatusChip 相当だが、コピーの自己完結動作を持つため専用にする。
import { ref, inject } from 'vue'

const props = defineProps<{
  code: string
  kind: 'item' | 'model'
}>()

const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!

const copied = ref(false)

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

async function onClick() {
  const wrapped = `【${props.code}】`
  const ok = await copyText(wrapped)
  if (!ok) {
    toast('コピーできませんでした', 'warn')
    return
  }
  copied.value = true
  setTimeout(() => { copied.value = false }, 1000)
  toast(
    props.kind === 'model'
      ? `${wrapped}をコピーしました。メルカリのタイトルに貼ると型番で自動紐付けされます`
      : `${wrapped}をコピーしました。メルカリのタイトルに貼ると自動で引き当たります`,
    'ok',
  )
}
</script>

<template>
  <span
    class="chip code-chip" :class="kind"
    title="クリックでコピー（【】付き）"
    @click.stop="onClick"
  >{{ copied ? 'コピー済み' : code }}</span>
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
  cursor: pointer;
}
.chip.item  { background: var(--brand-soft); color: var(--brand-ink); }
.chip.model { background: var(--surface-hi); color: var(--text-dim); }
.chip:hover { filter: brightness(.97); }
</style>
