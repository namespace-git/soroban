<script setup lang="ts">
// 下から出る「その他の操作」のシート（スマホ幅で、カードの補助ボタンを「…」にまとめるときに使う）。
// 作法は App.vue の「その他」のシートと同じ：幕を押す・×・Esc・端末の「戻る」で閉じる。
// 中身（操作の一覧）は default スロットに <button> を並べる。押したあとに閉じるのは呼び出し側（emit('close')）。
// 危険な操作は button.danger（赤文字）にして、いちばん下に置く。
import { ref, watch, nextTick } from 'vue'
import Icon from './Icon.vue'
import { useBackClose } from '../composables/useBackClose'

const props = defineProps<{
  open: boolean
  /** 題。どの行への操作かが分かるように、商品名などを入れる */
  title?: string
}>()
const emit = defineEmits<{ close: [] }>()

useBackClose(() => props.open, () => emit('close'))

const panel = ref<HTMLElement | null>(null)
let lastFocused: HTMLElement | null = null

watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    lastFocused = document.activeElement as HTMLElement | null
    await nextTick()
    panel.value?.querySelector<HTMLElement>('.action-sheet-list button')?.focus()
  } else {
    // 操作の結果、別の層（入力・タグ選択など）が先にフォーカスを取っていたら、奪い返さない
    const now = document.activeElement
    if (!now || now === document.body || panel.value?.contains(now)) lastFocused?.focus?.()
  }
})

// 幕：押した場所と離した場所が両方とも幕のときだけ閉じる。スクロールのつもりで動かした指（10px 超）では閉じない（Drawer と同じ作法）
let downOnScrim = false
let downX = 0
let downY = 0
function onScrimPointerDown(e: PointerEvent) {
  downOnScrim = e.target === e.currentTarget
  downX = e.clientX
  downY = e.clientY
}
function onScrimPointerUp(e: PointerEvent) {
  const moved = e.pointerType !== 'mouse' && Math.hypot(e.clientX - downX, e.clientY - downY) > 10
  if (downOnScrim && !moved && e.target === e.currentTarget) emit('close')
  downOnScrim = false
}
function onScrimPointerCancel() { downOnScrim = false }
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="action-sheet">
      <div
        v-if="open"
        class="action-sheet-scrim"
        @pointerdown="onScrimPointerDown"
        @pointerup="onScrimPointerUp"
        @pointercancel="onScrimPointerCancel"
        @keydown="onKeydown"
      >
        <div ref="panel" class="action-sheet" role="dialog" aria-modal="true" aria-labelledby="action-sheet-title">
          <header class="action-sheet-head">
            <div class="action-sheet-head-main">
              <h2 id="action-sheet-title" class="action-sheet-title">その他の操作</h2>
              <p v-if="title" class="faint action-sheet-sub" :title="title">{{ title }}</p>
            </div>
            <button type="button" class="icon ghost action-sheet-close" aria-label="閉じる" @click="emit('close')">
              <Icon name="close" :size="18" />
            </button>
          </header>
          <div class="action-sheet-list">
            <slot />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.action-sheet-scrim {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(38, 38, 42, .32);
}

.action-sheet {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  max-width: 560px;
  margin: 0 auto;
  max-height: calc(100dvh - env(safe-area-inset-top, 0px) - 24px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: var(--radius) var(--radius) 0 0;
  box-shadow: var(--shadow-2);
}

.action-sheet-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 6px 8px 6px 16px;
  border-bottom: 1px solid var(--line-soft);
}
.action-sheet-head-main { flex: 1; min-width: 0; }
.action-sheet-title { margin: 0; font-size: var(--fs-16); font-weight: 600; }
.action-sheet-sub {
  margin: 0;
  font-size: var(--fs-12);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.action-sheet-close { width: 44px; height: 44px; flex-shrink: 0; }

.action-sheet-list {
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 8px max(8px, env(safe-area-inset-bottom));
}

/* 操作の行：左揃えの 52px。スロットに置かれた button に効かせる */
.action-sheet-list :slotted(button) {
  display: flex;
  align-items: center;
  width: 100%;
  height: 52px;
  padding: 0 12px;
  background: transparent;
  border-radius: var(--radius-md);
  font-size: var(--fs-16);
  text-align: left;
}
/* 危険な操作（削除）は赤文字で、いちばん下に区切って置く */
.action-sheet-list :slotted(button.danger) {
  margin-top: 4px;
  border-top: 1px solid var(--line-soft);
  border-radius: 0 0 var(--radius-md) var(--radius-md);
}

.action-sheet-enter-active,
.action-sheet-leave-active {
  transition: opacity var(--dur) var(--ease);
}
.action-sheet-enter-active .action-sheet,
.action-sheet-leave-active .action-sheet {
  transition: transform var(--dur) var(--ease);
}
.action-sheet-enter-from,
.action-sheet-leave-to {
  opacity: 0;
}
.action-sheet-enter-from .action-sheet,
.action-sheet-leave-to .action-sheet {
  transform: translateY(24px);
}
@media (prefers-reduced-motion: reduce) {
  .action-sheet-enter-active,
  .action-sheet-leave-active,
  .action-sheet-enter-active .action-sheet,
  .action-sheet-leave-active .action-sheet {
    transition: none;
  }
}
</style>
