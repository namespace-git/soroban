<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { useBackClose } from '../composables/useBackClose'
import {
  SWIPE_SETTLE_MS, SWIPE_SLOP, pushSwipeSample, shouldCloseBySwipe, swipeVelocity,
  type SwipeSample,
} from './drawer-swipe'

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

// 「戻る」（Android の戻るボタンなど）で閉じる。ヘッダーの×と同じ意味
useBackClose(() => props.open, close)

// --- スマホ幅（767px 以下）の下からのシート：ヘッダーとつまみを下に引いて閉じる ---
// 引いている間は指についてくる（transform）。80px 以上引いて離すか、0.5px/ms 以上で払うと閉じ、
// 足りなければ 180ms で元に戻す。本文（.drawer-body）のスクロールとは別の面なので喧嘩しない。
// 判定の値と関数は drawer-swipe.ts。デスクトップ幅（768px 以上）では何もしない
type SheetMode = 'idle' | 'drag' | 'out' | 'back'
const SHEET_QUERY = '(max-width: 767px)'
const sheetMode = ref<SheetMode>('idle')
const sheetY = ref(0)
let sheetTimer: ReturnType<typeof setTimeout> | undefined
let drag: { id: number; startY: number; samples: SwipeSample[]; active: boolean } | null = null

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// idle のときは transform を付けない（開閉のスライドは CSS のクラスが担う。インラインが勝つと閉じる動きが消える）
const sheetStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = { width: `${props.width}px` }
  const settle = reducedMotion() ? 'none' : 'transform var(--dur) var(--ease)'
  if (sheetMode.value === 'drag') {
    style.transform = `translateY(${sheetY.value}px)`
    style.transition = 'none'
  } else if (sheetMode.value === 'out') {
    style.transform = 'translateY(100%)'
    style.transition = settle
  } else if (sheetMode.value === 'back') {
    style.transform = 'translateY(0)'
    style.transition = settle
  }
  return style
})

function springBack() {
  clearTimeout(sheetTimer)
  sheetY.value = 0
  if (reducedMotion()) {
    sheetMode.value = 'idle'
    return
  }
  sheetMode.value = 'back'
  sheetTimer = setTimeout(() => { sheetMode.value = 'idle' }, SWIPE_SETTLE_MS + 40)
}

async function dismissBySwipe() {
  sheetMode.value = 'out'
  close()
  await nextTick()
  // 親が閉じなかったときは、画面の外に置き去りにせず元に戻す
  if (props.open) springBack()
}

function onSheetPointerDown(e: PointerEvent) {
  if (drag || !props.open) return
  if (!window.matchMedia(SHEET_QUERY).matches) return
  if (e.pointerType === 'mouse' && e.button !== 0) return
  // ×ボタンやヘッダーに置かれた操作部品の押下は奪わない
  if ((e.target as HTMLElement).closest('button, a, input, select, textarea, [role="button"]')) return
  clearTimeout(sheetTimer)
  drag = { id: e.pointerId, startY: e.clientY, samples: [{ t: e.timeStamp, y: e.clientY }], active: false }
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    // 取れなくても、引く動き自体は続けられる
  }
}

function onSheetPointerMove(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return
  drag.samples = pushSwipeSample(drag.samples, { t: e.timeStamp, y: e.clientY })
  const dy = e.clientY - drag.startY
  if (!drag.active) {
    if (Math.abs(dy) < SWIPE_SLOP) return
    drag.active = true
    sheetMode.value = 'drag'
  }
  // 上へは動かさない（下へ引いた分だけついてくる）
  sheetY.value = Math.max(0, dy)
}

function onSheetPointerUp(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return
  const d = drag
  drag = null
  if (!d.active) return // タップ（引いていない）
  const dy = e.clientY - d.startY
  if (shouldCloseBySwipe(dy, swipeVelocity(d.samples, e.timeStamp))) void dismissBySwipe()
  else springBack()
}

function onSheetPointerCancel(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return
  const d = drag
  drag = null
  if (d.active) springBack()
}

onBeforeUnmount(() => clearTimeout(sheetTimer))

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
    // 開き直すときは、前に引いた状態を持ち越さない（閉じるときは触らない：閉じる動きの最中に位置が戻ると跳ねる）
    clearTimeout(sheetTimer)
    sheetMode.value = 'idle'
    sheetY.value = 0
    drag = null
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
          :style="sheetStyle"
          role="dialog"
          aria-modal="true"
          aria-labelledby="drawer-title"
        >
          <!-- つまみ（スマホ幅だけ）とヘッダーが、下に引いて閉じる面。本文は含めない -->
          <div
            class="drawer-top"
            @pointerdown="onSheetPointerDown"
            @pointermove="onSheetPointerMove"
            @pointerup="onSheetPointerUp"
            @pointercancel="onSheetPointerCancel"
          >
            <div class="drawer-grip" aria-hidden="true" />
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
          </div>

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

.drawer-top { flex-shrink: 0; }
/* つまみはスマホ幅のシートだけ（下の @media で出す） */
.drawer-grip { display: none; }

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
  /* 引いて閉じる面（つまみ＋ヘッダー）。縦の指の動きをブラウザに取られない（スクロール・引っ張って更新に化けない） */
  .drawer-top {
    touch-action: none;
  }
  /* つまみ：幅 36px・高さ 4px の丸い棒。ヘッダーの上の余白ぶんを詰めて、高さを増やしすぎない */
  .drawer-grip {
    display: flex;
    justify-content: center;
    padding-top: 6px;
  }
  .drawer-grip::before {
    content: '';
    width: 36px;
    height: 4px;
    border-radius: 999px;
    background: var(--line);
  }
  .drawer-head {
    padding: 4px 8px 10px 16px;
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
