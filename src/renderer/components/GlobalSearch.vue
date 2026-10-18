<script setup lang="ts">
// 横断検索（「あの商品どうなった？」）の結果ドロワー。App.vue のヘッダ検索欄から開く。
// 検索の実行（デバウンス・searchAll 呼び出し）は App.vue 側が持ち、ここは表示だけを担う。
// スマホ幅（768px 未満）だけは、ドロワー（下からのシート）の代わりに上のバーの下へ結果の面を出す。
// シートだと上のバーの検索欄（入力のつづき・キャンセル）を覆って押せなくなるため
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { SearchHit } from '../../shared/types'
import Drawer from './Drawer.vue'
import StatusChip from './StatusChip.vue'
import EmptyState from './EmptyState.vue'
import { yen } from '../format'
import { useBackClose } from '../composables/useBackClose'

const props = defineProps<{
  open: boolean
  query: string
  hits: SearchHit[]
  loading: boolean
}>()
const emit = defineEmits<{ close: []; select: [hit: SearchHit] }>()

// App.vue のスマホ幅の外枠と同じ境界（768px 未満）
const isMobile = ref(false)
let mobileMql: MediaQueryList | undefined
function onMobileChange(e: { matches: boolean }) {
  isMobile.value = e.matches
}
onMounted(() => {
  mobileMql = window.matchMedia('(max-width: 767px)')
  onMobileChange(mobileMql)
  mobileMql.addEventListener('change', onMobileChange)
})
onUnmounted(() => mobileMql?.removeEventListener('change', onMobileChange))

// 「戻る」（Android の戻るボタンなど）で閉じる。スマホ幅の結果の面だけ（デスクトップ幅の Drawer は自分で持つ）。
// 上のバーの「キャンセル」と同じ意味で、閉じるのは親（App.vue）の close
useBackClose(() => props.open && isMobile.value, () => emit('close'))

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  inventory: '在庫', listing: '出品', sale: '売上', purchase: '仕入',
}
const KIND_ORDER_DESKTOP: SearchHit['kind'][] = ['inventory', 'listing', 'sale', 'purchase']
// スマホは「売れたもの・出品中のもの」を先に（毎日見るのは売上と出品）
const KIND_ORDER_MOBILE: SearchHit['kind'][] = ['sale', 'listing', 'purchase', 'inventory']

const groups = computed(() =>
  (isMobile.value ? KIND_ORDER_MOBILE : KIND_ORDER_DESKTOP)
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
  <Drawer v-if="!isMobile" :open="open" title="すべてから探す" :width="520" @close="emit('close')">
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

  <!-- スマホ幅：上のバー（検索欄・キャンセル）はそのまま見せ、その下の全面に結果を出す。
       閉じるのは上のバーの「キャンセル」か、結果を選んだとき（App.vue が検索を終える） -->
  <div v-else-if="open" class="gs-panel" role="dialog" aria-label="すべてから探す">
    <p class="gs-head faint">
      <template v-if="query">「{{ query }}」の検索結果</template>
      <template v-else>すべてから探す</template>
    </p>
    <div class="gs-body">
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
            <span class="hit-title">{{ h.title }}</span>
            <span class="chip-row">
              <StatusChip v-if="h.model_code" tone="neutral" :label="h.model_code" />
              <StatusChip :tone="statusTone(h.status_label)" :label="h.status_label" />
            </span>
          </span>

          <span class="hit-amount num">{{ yen(h.amount) }}</span>
          <span class="faint hit-date">{{ h.date }}</span>
        </button>
      </div>
    </div>
  </div>
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
/* タッチでは、タップしたあとに灰色が残る（hover が貼りつく）ので、マウスのときだけ */
@media (hover: hover) and (pointer: fine) {
  .hit-row:hover { background: var(--surface-hi); }
}

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

/* スマホ幅の結果の面。上のバー（検索欄・キャンセル）の下から画面の下端まで全面。
   下のタブバー（z-index 61）も覆う＝検索を終えるまで、ほかの画面へ移らない */
.gs-panel {
  position: fixed;
  top: calc(var(--topbar-h) + env(safe-area-inset-top, 0px));
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 62;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-top: 1px solid var(--line-soft);
}
.gs-head {
  flex-shrink: 0;
  margin: 0;
  padding: 10px max(16px, env(safe-area-inset-right)) 6px max(16px, env(safe-area-inset-left));
  font-size: var(--fs-12);
}
.gs-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 max(12px, env(safe-area-inset-right)) calc(12px + env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left));
}

/* スマホ幅（768px 未満）：結果は全幅の 1 行 1 件。金額と日付は右に 2 段で縦に並べ、
   商品名は切らずに 2 行まで見せる（ホバーの title は読めないので）。1 行は 64px 以上で押しやすく */
@media (max-width: 767px) {
  .hit-row {
    grid-template-columns: 44px minmax(0, 1fr) auto;
    grid-template-areas:
      "thumb main amount"
      "thumb main date";
    align-items: start;
    gap: 2px 12px;
    padding: 10px 4px;
    min-height: 64px;
    border-top: 1px solid var(--line-soft);
    border-radius: 0;
  }
  .group > .hit-row:first-of-type { border-top: 0; }
  .thumb, .thumb-placeholder { grid-area: thumb; width: 44px; height: 44px; }
  .hit-main { grid-area: main; }
  /* 一覧の行の 4 段：状態ラベル（と型番）を、名前の前に */
  .hit-main .chip-row { order: -1; margin: 0 0 4px; }
  .hit-title {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    white-space: normal;
    overflow-wrap: anywhere;
    line-height: 1.4;
  }
  .hit-amount { grid-area: amount; font-weight: 600; }
  .hit-date { grid-area: date; font-size: var(--fs-12); }
}
</style>
