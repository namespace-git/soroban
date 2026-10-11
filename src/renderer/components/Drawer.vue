<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  width?: number
}>(), {
  width: 560,
})

const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)
let lastFocused: HTMLElement | null = null

function close() {
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

// スクリムでの pointerdown → pointerup が両方ともスクリム自身のときだけ閉じる（マウスもタッチも同じ）。
// 本文内でのドラッグ選択やスライダー操作が外に抜けて離しても閉じないようにする。
// タッチは指を置いた要素に pointerup が固定されるので、スクロールのつもりで動かした指（10px 超）では閉じない
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
  if (downOnScrim && !moved && e.target === e.currentTarget) close()
  downOnScrim = false
}
function onScrimPointerCancel() {
  downOnScrim = false
}

watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    lastFocused = document.activeElement as HTMLElement | null
    await nextTick()
    // 本文の最初の入力へ。ヘッダーの閉じるボタンに当てない
    const scope = panel.value?.querySelector<HTMLElement>('.drawer-body') ?? panel.value
    const target = scope?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    target?.focus()
  } else {
    lastFocused?.focus()
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="open" class="scrim" @pointerdown="onScrimPointerDown" @pointerup="onScrimPointerUp" @pointercancel="onScrimPointerCancel" @keydown="onKeydown">
        <div
          ref="panel"
          class="drawer"
          :style="{ width: `${width}px` }"
          role="dialog"
          aria-modal="true"
          aria-labelledby="drawer-title"
        >
          <header class="drawer-head">
            <div class="drawer-head-main">
              <h2 id="drawer-title" class="drawer-title">{{ title }}</h2>
              <div v-if="$slots['header-sub']" class="drawer-head-sub">
                <slot name="header-sub" />
              </div>
            </div>
            <button class="icon ghost" aria-label="閉じる" @click="close">
              <Icon name="close" :size="18" />
            </button>
          </header>

          <div class="drawer-body">
            <slot />
          </div>

          <footer v-if="$slots.footer" class="drawer-footer">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(38, 38, 42, .32);
  z-index: 100;
}

.drawer {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  max-width: 92vw;
  background: var(--surface);
  box-shadow: var(--shadow-2);
  display: flex;
  flex-direction: column;
}

/* 開閉とも 200ms でスクリムのフェード + パネルのスライド */
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity var(--dur) var(--ease);
}
.drawer-enter-active .drawer,
.drawer-leave-active .drawer {
  transition: transform var(--dur) var(--ease);
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
.drawer-enter-from .drawer,
.drawer-leave-to .drawer {
  transform: translateX(100%);
}

@media (prefers-reduced-motion: reduce) {
  .drawer-enter-active,
  .drawer-leave-active,
  .drawer-enter-active .drawer,
  .drawer-leave-active .drawer {
    transition: none;
  }
}

.drawer-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.drawer-head-main { flex: 1; min-width: 0; }
.drawer-title { margin: 0; font-size: var(--fs-16); font-weight: 600; }
.drawer-head-sub { margin-top: 4px; }

.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

.drawer-footer {
  flex-shrink: 0;
  padding: 14px 20px;
  border-top: 1px solid var(--line);
}

/* スマホ幅（768px 未満）：右から出る引き出しではなく、下からのシート（全幅）。
   幅は :style のインライン指定（デスクトップ用）に勝つため !important。
   高さは中身に合わせ、画面の上は少し空ける（そこを押すと閉じる）。
   下の余白はホームバー（env(safe-area-inset-bottom)）に被らない分だけ足す */
@media (max-width: 767px) {
  .drawer {
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100% !important;
    max-width: 100%;
    height: auto;
    min-height: 55vh;
    max-height: calc(100vh - env(safe-area-inset-top, 0px) - 24px);
    max-height: calc(100dvh - env(safe-area-inset-top, 0px) - 24px);
    border-radius: var(--radius) var(--radius) 0 0;
  }
  .drawer-enter-from .drawer,
  .drawer-leave-to .drawer {
    transform: translateY(100%);
  }
  .drawer-head {
    padding: 12px 8px 10px 16px;
  }
  .drawer-head button.icon {
    width: 44px;
    height: 44px;
  }
  .drawer-body {
    padding: 14px 16px;
    overscroll-behavior: contain;
  }
  .drawer-footer {
    padding: 12px 16px max(12px, env(safe-area-inset-bottom));
  }
}
</style>
