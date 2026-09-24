<script setup lang="ts">
// 横断検索（「あの商品どうなった？」）の結果ドロワー。App.vue のヘッダ検索欄から開く。
// 検索の実行（デバウンス・searchAll 呼び出し）は App.vue 側が持ち、ここは表示だけを担う。
import { ref, computed } from 'vue'
import type { SearchHit } from '../../shared/types'
import Drawer from './Drawer.vue'
import StatusChip from './StatusChip.vue'
import EmptyState from './EmptyState.vue'
import { yen } from '../format'

const props = defineProps<{
  open: boolean
  query: string
  hits: SearchHit[]
  loading: boolean
}>()
const emit = defineEmits<{ close: []; select: [hit: SearchHit] }>()

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  inventory: '在庫', listing: '出品', sale: '売上', purchase: '仕入',
}
const KIND_ORDER: SearchHit['kind'][] = ['inventory', 'listing', 'sale', 'purchase']

const groups = computed(() =>
  KIND_ORDER
    .map(kind => ({ kind, label: KIND_LABEL[kind], hits: props.hits.filter(h => h.kind === kind) }))
    .filter(g => g.hits.length > 0),
)

function statusTone(label: string): 'info' | 'ok' | 'warn' | 'neutral' {
  if (label.includes('未出品') || label.includes('出品中')) return 'info'
  if (label.includes('販売済') || label.includes('売れた') || label.includes('完了')) return 'ok'
  if (label.includes('送料未入力') || label.includes('未紐付け') || label.includes('未着')) return 'warn'
  if (label.includes('廃棄') || label.includes('取り下げ')) return 'neutral'
  return 'neutral'
}

function placeholderChar(h: SearchHit): string {
  const c = h.model_code?.[0] ?? h.title.replace(/【[^】]*】/g, '').replace(/\s+/g, '').charAt(0)
  return (c || '?').toUpperCase()
}

// --- サムネイル。読み込み失敗したら以後プレースホルダに固定する ---
const thumbFailed = ref<Set<string>>(new Set())
function rowKey(h: SearchHit): string {
  return `${h.kind}:${h.id}`
}
function showThumb(h: SearchHit): boolean {
  return !!h.thumb_url && !thumbFailed.value.has(rowKey(h))
}
function onThumbError(h: SearchHit) {
  thumbFailed.value = new Set(thumbFailed.value).add(rowKey(h))
}
</script>

<template>
  <Drawer :open="open" title="すべてから探す" :width="520" @close="emit('close')">
    <template #header-sub>
      <span v-if="query" class="faint">「{{ query }}」の検索結果</span>
    </template>

    <EmptyState v-if="!loading && !hits.length" title="見つかりません" />

    <div v-for="g in groups" :key="g.kind" class="group">
      <p class="section-head">{{ g.label }} {{ g.hits.length }}</p>
      <button
        v-for="h in g.hits" :key="rowKey(h)"
        type="button"
        class="hit-row"
        @click="emit('select', h)"
      >
        <img
          v-if="showThumb(h)"
          class="thumb" :src="h.thumb_url!" alt=""
          @error="onThumbError(h)"
        />
        <span v-else class="thumb-placeholder">{{ placeholderChar(h) }}</span>

        <span class="hit-main">
          <span class="hit-title" :title="h.title">{{ h.title }}</span>
          <span class="chip-row">
            <StatusChip v-if="h.model_code" tone="neutral" :label="h.model_code" />
            <StatusChip :tone="statusTone(h.status_label)" :label="h.status_label" />
          </span>
        </span>

        <span class="hit-amount num">{{ yen(h.amount) }}</span>
        <span class="faint hit-date">{{ h.date }}</span>
      </button>
    </div>
  </Drawer>
</template>

<style scoped>
.group + .group { margin-top: 12px; }

.section-head {
  font-size: var(--fs-13);
  font-weight: 600;
  color: var(--text-dim);
  letter-spacing: .02em;
  margin: 0 0 6px;
}

.hit-row {
  display: grid;
  grid-template-columns: 40px 1fr auto auto;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 8px 4px;
  height: auto;
  min-width: 0;
  font: inherit;
  color: inherit;
  border-radius: var(--radius-sm);
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
}
.hit-row:hover { background: var(--surface-hi); }

.thumb, .thumb-placeholder {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-sm);
}
.thumb { object-fit: cover; display: block; }
.thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-weight: 700;
  font-size: var(--fs-14);
}

.hit-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hit-title {
  font-size: var(--fs-14);
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.hit-amount { white-space: nowrap; }
.hit-date { white-space: nowrap; font-variant-numeric: tabular-nums; text-align: right; }
</style>
