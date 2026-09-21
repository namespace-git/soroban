<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

// Electron は window.prompt() を実装していないため、各画面はこれを使う。
export type PromptOptions = {
  label?: string
  initial?: string
  placeholder?: string
  multiline?: boolean
  okLabel?: string
}

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  label?: string
  initial?: string
  placeholder?: string
  multiline?: boolean
  okLabel?: string
}>(), {
  okLabel: '決定',
})

const emit = defineEmits<{ submit: [value: string]; cancel: [] }>()

const value = ref('')
const inputEl = ref<HTMLInputElement | HTMLTextAreaElement | null>(null)
let lastFocused: HTMLElement | null = null

function submit() {
  emit('submit', value.value)
}

function cancel() {
  emit('cancel')
}

// スクリムでの mousedown → mouseup が両方ともスクリム自身のときだけ閉じる。
// 本文内でのドラッグ選択やスライダー操作が外に抜けて mouseup しても閉じないようにする
let downOnScrim = false
function onScrimMouseDown(e: MouseEvent) {
  downOnScrim = e.target === e.currentTarget
}
function onScrimMouseUp(e: MouseEvent) {
  if (downOnScrim && e.target === e.currentTarget) cancel()
  downOnScrim = false
}

function onKeydown(e: KeyboardEvent) {
  // 日本語入力の変換中（IME）の Enter / Esc は確定・取消の操作なので、ダイアログは反応しない
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Escape') {
    cancel()
    return
  }
  if (e.key === 'Enter') {
    if (props.multiline) {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault()
        submit()
      }
    } else {
      e.preventDefault()
      submit()
    }
  }
}

watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    value.value = props.initial ?? ''
    lastFocused = document.activeElement as HTMLElement | null
    await nextTick()
    inputEl.value?.focus()
    inputEl.value?.select()
  } else {
    lastFocused?.focus()
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="open" class="scrim" @mousedown="onScrimMouseDown" @mouseup="onScrimMouseUp" @keydown="onKeydown">
        <div
          class="panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="input-dialog-title"
        >
          <header class="dialog-head">
            <h2 id="input-dialog-title" class="dialog-title">{{ title }}</h2>
          </header>

          <div class="dialog-body">
            <label class="field">
              <span v-if="label">{{ label }}</span>
              <textarea
                v-if="multiline"
                ref="inputEl"
                v-model="value"
                :placeholder="placeholder"
                rows="4"
              />
              <input
                v-else
                ref="inputEl"
                v-model="value"
                type="text"
                :placeholder="placeholder"
              />
            </label>
          </div>

          <footer class="dialog-footer">
            <button class="ghost" @click="cancel">キャンセル</button>
            <button class="primary" @click="submit">{{ okLabel }}</button>
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
.dialog-body textarea { resize: vertical; }

.dialog-footer {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--line);
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
</style>
