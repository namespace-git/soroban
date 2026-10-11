<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted } from 'vue'
import type { Tag } from '../../shared/types'

const props = defineProps<{
  open: boolean
  anchor: HTMLElement | null
  allTags: Tag[]
  selected: string[]
}>()

const emit = defineEmits<{
  change: [tagIds: string[]]
  create: [name: string]
  close: []
}>()

const panelEl = ref<HTMLElement | null>(null)
const newInput = ref<HTMLInputElement | null>(null)
const newName = ref('')

const pos = ref({ top: '0px', left: '0px' })
const PANEL_WIDTH = 240

function place() {
  if (!props.anchor) return
  const rect = props.anchor.getBoundingClientRect()
  let left = rect.left
  if (left + PANEL_WIDTH > window.innerWidth - 8) {
    left = rect.right - PANEL_WIDTH
  }
  left = Math.max(8, left)
  pos.value = { top: `${rect.bottom + 4}px`, left: `${left}px` }
}

function toggle(id: string) {
  const set = new Set(props.selected)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  emit('change', [...set])
}

function onNewKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault()
    const name = newName.value.trim()
    if (!name) return
    emit('create', name)
    newName.value = ''
  }
}

// 外を押したら閉じる。マウスもタッチも pointerdown で拾う（iOS は何も押せない場所をタップしても mousedown を出さない）
function onDocPointerDown(e: PointerEvent) {
  const target = e.target as Node
  if (panelEl.value?.contains(target)) return
  if (props.anchor?.contains(target)) return
  emit('close')
}

function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

function bindDocListeners() {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('keydown', onDocKeydown, true)
}
function unbindDocListeners() {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onDocKeydown, true)
}

watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    newName.value = ''
    place()
    await nextTick()
    bindDocListeners()
    const firstCheckbox = panelEl.value?.querySelector<HTMLElement>('input[type="checkbox"]')
    ;(firstCheckbox ?? newInput.value)?.focus()
  } else {
    unbindDocListeners()
  }
})

onUnmounted(unbindDocListeners)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panelEl"
      class="panel tagpicker"
      :style="{ position: 'fixed', top: pos.top, left: pos.left }"
      role="menu"
    >
      <div class="tagpicker-list">
        <label v-for="t in allTags" :key="t.id" class="item">
          <input
            type="checkbox"
            :checked="selected.includes(t.id)"
            @change="toggle(t.id)"
          />
          <span class="grow">{{ t.name }}</span>
        </label>
        <p v-if="!allTags.length" class="faint tagpicker-empty">タグがありません</p>
      </div>

      <div class="tagpicker-new">
        <input
          ref="newInput"
          v-model="newName"
          type="text"
          placeholder="新しいタグ"
          @keydown="onNewKeydown"
        />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.panel.tagpicker {
  width: 240px;
  padding: 6px;
  box-shadow: var(--shadow-2);
  z-index: 100;
}

.tagpicker-list {
  display: flex;
  flex-direction: column;
  max-height: 260px;
  overflow-y: auto;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  font-size: var(--fs-14);
  cursor: pointer;
}
.item:hover { background: var(--surface-hi); }

.item input[type="checkbox"] {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  accent-color: var(--accent);
}

.tagpicker-empty {
  padding: 6px 8px;
  margin: 0;
}

.tagpicker-new {
  border-top: 1px solid var(--line);
  margin-top: 4px;
  padding-top: 6px;
}
.tagpicker-new input { width: 100%; }

/* スマホ幅（768px 未満）：ボタンの横に小さく出すのではなく、画面の下に全幅で出す（親指が届き、画面の外にはみ出さない）。
   位置は :style のインライン指定（デスクトップ用）に勝つため !important。行は 48px、押す範囲は行全体 */
@media (max-width: 767px) {
  .panel.tagpicker {
    top: auto !important;
    left: 0 !important;
    right: 0;
    bottom: 0;
    width: auto;
    padding: 8px 12px max(8px, env(safe-area-inset-bottom));
    border-radius: var(--radius) var(--radius) 0 0;
  }
  .tagpicker-list { max-height: 50vh; max-height: 50dvh; }
  .item { height: 48px; font-size: var(--fs-16); }
  .item input[type="checkbox"] { width: 22px; height: 22px; }
  .tagpicker-new input { height: 44px; }
}
</style>
