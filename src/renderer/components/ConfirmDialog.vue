<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

// OS の confirm() / alert() の代わり。確認の2択にも、複数ボタンの選択にも使う
export type ConfirmChoice = {
  label: string
  value: string
  tone?: 'primary' | 'danger' | 'ghost'
}

const props = defineProps<{
  open: boolean
  title: string
  message?: string
  choices: ConfirmChoice[]
}>()

const emit = defineEmits<{ choose: [value: string]; cancel: [] }>()

const primaryBtn = ref<HTMLButtonElement | null>(null)
let lastFocused: HTMLElement | null = null

function choose(value: string) {
  emit('choose', value)
}

function cancel() {
  emit('cancel')
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
  if (downOnScrim && !moved && e.target === e.currentTarget) cancel()
  downOnScrim = false
}
function onScrimPointerCancel() {
  downOnScrim = false
}

// 明示指定が無ければ、最後の選択肢を主ボタン（primary）として扱う
function toneOf(c: ConfirmChoice, isLast: boolean): 'primary' | 'danger' | 'ghost' {
  return c.tone ?? (isLast ? 'primary' : 'ghost')
}

function setPrimaryRef(el: Element | null, isLast: boolean) {
  if (isLast) primaryBtn.value = el as HTMLButtonElement | null
}

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Escape') {
    cancel()
    return
  }
  if (e.key === 'Enter') {
    const last = props.choices[props.choices.length - 1]
    if (last) {
      e.preventDefault()
      choose(last.value)
    }
  }
}

watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    lastFocused = document.activeElement as HTMLElement | null
    await nextTick()
    primaryBtn.value?.focus()
  } else {
    lastFocused?.focus()
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="open" class="scrim" @pointerdown="onScrimPointerDown" @pointerup="onScrimPointerUp" @pointercancel="onScrimPointerCancel" @keydown="onKeydown">
        <div
          class="panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
        >
          <header class="dialog-head">
            <h2 id="confirm-dialog-title" class="dialog-title">{{ title }}</h2>
          </header>

          <div v-if="message" class="dialog-body">
            <p class="message">{{ message }}</p>
          </div>

          <footer class="dialog-footer">
            <button
              v-for="(c, i) in choices" :key="c.value"
              :ref="(el) => setPrimaryRef(el as Element | null, i === choices.length - 1)"
              :class="{
                primary: toneOf(c, i === choices.length - 1) === 'primary',
                ghost: toneOf(c, i === choices.length - 1) === 'ghost',
                'danger-solid': toneOf(c, i === choices.length - 1) === 'danger',
              }"
              @click="choose(c.value)"
            >{{ c.label }}</button>
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
  z-index: 110; /* ドロワー（100）より上。ドロワーの中から出す確認は上に重ねる */
  display: flex;
  align-items: center;
  justify-content: center;
}

.panel {
  width: 420px;
  max-width: 92vw;
  max-height: 84vh;
  padding: 0;
  border: none;
  border-radius: var(--radius);
  box-shadow: var(--shadow-2);
  display: flex;
  flex-direction: column;
}

.dialog-head { padding: 20px 20px 0; flex-shrink: 0; }
.dialog-title { margin: 0; font-size: var(--fs-16); font-weight: 600; }

.dialog-body { padding: 16px 20px; overflow-y: auto; }
.message { margin: 0; color: var(--text-dim); white-space: pre-line; }

.dialog-footer {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--line);
}

/* button.danger は style.css では地のままの弱い赤文字。確認ダイアログの
   破壊的操作は主ボタンとして塗りつぶした赤にする */
.danger-solid {
  background: var(--loss-solid);
  border-color: var(--loss-solid);
  color: #fff;
}
.danger-solid:hover:not(:disabled) {
  background: var(--loss);
  border-color: var(--loss);
}

/* 開閉とも 180ms でスクリムのフェード + パネルのスケール */
.dialog-enter-active,
.dialog-leave-active {
  transition: opacity var(--dur) var(--ease);
}
.dialog-enter-active .panel,
.dialog-leave-active .panel {
  transition: transform var(--dur) var(--ease);
}
.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}
.dialog-enter-from .panel,
.dialog-leave-to .panel {
  transform: scale(.98);
}

@media (prefers-reduced-motion: reduce) {
  .dialog-enter-active,
  .dialog-leave-active,
  .dialog-enter-active .panel,
  .dialog-leave-active .panel {
    transition: none;
  }
}

/* スマホ幅（768px 未満）：画面の下に全幅で出す（親指が届く）。ボタンは 48px、2 つずつ横に並べる。
   下の余白はホームバー（env(safe-area-inset-bottom)）に被らない分だけ足す */
@media (max-width: 767px) {
  .scrim {
    align-items: flex-end;
  }
  .panel {
    width: 100%;
    max-width: 100%;
    max-height: 80vh;
    max-height: 80dvh;
    border-radius: var(--radius) var(--radius) 0 0;
  }
  .dialog-head { padding: 20px 16px 0; }
  .dialog-body { padding: 12px 16px; }
  .dialog-footer {
    flex-wrap: wrap;
    padding: 12px 16px max(12px, env(safe-area-inset-bottom));
  }
  .dialog-footer button {
    flex: 1 1 calc(50% - 4px);
    height: auto;
    min-height: 48px;
  }
  .dialog-enter-from .panel,
  .dialog-leave-to .panel {
    transform: translateY(24px);
  }
}
</style>
