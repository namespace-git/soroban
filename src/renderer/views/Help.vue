<script setup lang="ts">
// ヘルプ：「こういうときは…？」から探す静的な FAQ。データは help/topics.ts に集約し、
// ここでは検索の絞り込み・目次スクロール・図の表示（スクショ／説明図）と拡大表示だけを扱う
// （window.soroban は呼ばない）。
import { ref, computed, inject, watch, nextTick } from 'vue'
import Icon from '../components/Icon.vue'
import SearchBox, { matchesSearch } from '../components/SearchBox.vue'
import EmptyState from '../components/EmptyState.vue'
import { HELP, type HelpTab, type HelpGotoPayload, type HelpTopic } from '../help/topics'
import { SHOTS, DIAGRAMS, hasShot, hasDiagram, type HelpFigure } from '../help/shots'

const goto = inject<(t: HelpTab, payload?: HelpGotoPayload) => void>('goto')!

const query = ref('')

// topics.ts の HelpTopic はまだ figures を持たない環境（並行タスクが追加中）でも壊れないよう、
// ここでだけ形を足しておく。追加された後もこの交差型は同じ形の optional を重ねるだけで無害
type TopicWithFigures = HelpTopic & { figures?: HelpFigure[] }

// そのトピックに出す図（スクショ／説明図）。画像・図がまだ無い（撮影・作図の途中）ものは
// 枠だけ残さず、無かったことにする
function figuresOf(t: HelpTopic): HelpFigure[] {
  const figs = (t as TopicWithFigures).figures
  if (!figs?.length) return []
  return figs.filter(f => (f.kind === 'shot' ? hasShot(f.id) : hasDiagram(f.id)))
}

function topicHaystacks(t: HelpTopic): string[] {
  return [
    t.q,
    ...(t.steps ?? []),
    ...(t.notes ?? []),
    ...(t.example ?? []),
    ...(t.keywords ?? []),
    ...figuresOf(t).map(f => f.caption),
  ]
}

function topicMatches(t: HelpTopic): boolean {
  return matchesSearch(topicHaystacks(t), query.value)
}

// 検索に一致したトピックだけを残す。カテゴリはトピックが1つも残らなければ丸ごと消す
const filteredCategories = computed(() =>
  HELP
    .map(cat => ({ ...cat, topics: cat.topics.filter(topicMatches) }))
    .filter(cat => cat.topics.length > 0),
)

const hasResults = computed(() => filteredCategories.value.length > 0)

function scrollToCategory(id: string) {
  document.getElementById(`help-cat-${id}`)?.scrollIntoView({ block: 'start' })
}

// ------------------------------------------------------------
// 図の拡大表示（ライトボックス）
// ウィンドウが狭いとスクショの細部が読めないため、押すと大きく見せる。
// Drawer.vue / ConfirmDialog.vue と同じ作法に揃える：
//   スクリムは mousedown/mouseup が両方ともスクリム自身のときだけ閉じる、
//   開いたら閉じるボタンへフォーカス、閉じたら元の要素へ戻す、Esc で閉じる
// ------------------------------------------------------------
const lightboxFigure = ref<HelpFigure | null>(null)
const lightboxCloseBtn = ref<HTMLButtonElement | null>(null)
let lightboxLastFocused: HTMLElement | null = null

function openLightbox(f: HelpFigure) {
  lightboxFigure.value = f
}
function closeLightbox() {
  lightboxFigure.value = null
}

watch(lightboxFigure, async (f) => {
  if (f) {
    lightboxLastFocused = document.activeElement as HTMLElement | null
    await nextTick()
    lightboxCloseBtn.value?.focus()
  } else {
    lightboxLastFocused?.focus()
  }
})

function onLightboxKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeLightbox()
}

let downOnLightboxScrim = false
function onLightboxScrimDown(e: MouseEvent) {
  downOnLightboxScrim = e.target === e.currentTarget
}
function onLightboxScrimUp(e: MouseEvent) {
  if (downOnLightboxScrim && e.target === e.currentTarget) closeLightbox()
  downOnLightboxScrim = false
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">ヘルプ</h1>
    </div>
    <p class="help-lead">こういうときは…？ から探す</p>
    <div class="help-search-row">
      <SearchBox v-model="query" placeholder="質問や操作から探す（例：分割、セット、送料）" />
    </div>

    <div v-if="hasResults" class="help-layout">
      <nav class="help-toc">
        <button
          v-for="cat in filteredCategories" :key="cat.id"
          class="help-toc-item"
          @click="scrollToCategory(cat.id)"
        >{{ cat.title }}</button>
      </nav>

      <div class="help-content">
        <section
          v-for="cat in filteredCategories" :key="cat.id"
          :id="`help-cat-${cat.id}`"
          class="help-category"
        >
          <h2 class="help-category-title">{{ cat.title }}</h2>
          <div class="help-cards">
            <article v-for="t in cat.topics" :key="t.id" class="panel help-card">
              <h3 class="help-card-q">{{ t.q }}</h3>

              <ol v-if="t.steps?.length" class="help-steps">
                <li v-for="(s, i) in t.steps" :key="i">{{ s }}</li>
              </ol>

              <!-- 図：shot はスクショ（<img>）、diagram はビルド時の自前 SVG。
                   SVG は <img> ではなくインラインで差し込む（v-html）。理由は
                   help/shots.ts のコメントの通り：<img> では中の var(--…) が
                   アプリの配色トークンを受け取れずダークモードで文字が読めなくなる。
                   利用者の入力はここを一切通らない -->
              <div v-if="figuresOf(t).length" class="help-figures">
                <figure v-for="f in figuresOf(t)" :key="f.id" class="help-figure">
                  <span v-if="f.step" class="pill help-figure-step">手順{{ f.step }}</span>
                  <button
                    type="button"
                    class="help-figure-btn"
                    :aria-label="`${f.caption}を拡大表示`"
                    @click="openLightbox(f)"
                  >
                    <img
                      v-if="f.kind === 'shot'"
                      class="help-figure-img"
                      :src="SHOTS[f.id]"
                      :alt="f.caption"
                      loading="lazy"
                    >
                    <span v-else class="help-figure-diagram" v-html="DIAGRAMS[f.id]" />
                    <span class="help-figure-zoom" aria-hidden="true"><Icon name="search" :size="12" /></span>
                  </button>
                  <figcaption class="help-figure-caption">{{ f.caption }}</figcaption>
                </figure>
              </div>

              <pre v-if="t.example?.length" class="help-example">{{ t.example.join('\n') }}</pre>

              <div v-if="t.notes?.length" class="help-notes">
                <p v-for="(n, i) in t.notes" :key="i">{{ n }}</p>
              </div>

              <div v-if="t.links?.length" class="help-links">
                <button
                  v-for="(l, i) in t.links" :key="i"
                  class="sm ghost"
                  @click="goto(l.tab, l.payload)"
                >
                  {{ l.label }}
                  <Icon name="arrow-right" :size="12" />
                </button>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>

    <EmptyState v-else title="見つかりませんでした" hint="言葉を変えて試してください" />
  </div>

  <!-- 図の拡大表示。Drawer / ConfirmDialog と同じスクリム作法 -->
  <Teleport to="body">
    <Transition name="lightbox">
      <div
        v-if="lightboxFigure"
        class="lightbox-scrim"
        @mousedown="onLightboxScrimDown"
        @mouseup="onLightboxScrimUp"
        @keydown="onLightboxKeydown"
      >
        <div class="lightbox-panel" role="dialog" aria-modal="true" :aria-label="lightboxFigure.caption">
          <button
            ref="lightboxCloseBtn"
            type="button"
            class="icon ghost lightbox-close"
            aria-label="閉じる"
            @click="closeLightbox"
          >
            <Icon name="close" :size="18" />
          </button>
          <div class="lightbox-body">
            <img
              v-if="lightboxFigure.kind === 'shot'"
              class="lightbox-img"
              :src="SHOTS[lightboxFigure.id]"
              :alt="lightboxFigure.caption"
            >
            <div v-else class="lightbox-diagram" v-html="DIAGRAMS[lightboxFigure.id]" />
          </div>
          <p class="lightbox-caption">{{ lightboxFigure.caption }}</p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.help-lead {
  margin: 0 0 12px;
  font-size: var(--fs-13);
  color: var(--text-dim);
}
.help-search-row { margin-bottom: 20px; }
.help-search-row :deep(.search-box) { width: 360px; }

.help-layout {
  display: flex;
  align-items: flex-start;
  gap: 24px;
}

.help-toc {
  flex-shrink: 0;
  width: 200px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  position: sticky;
  top: 0;
}
.help-toc-item {
  background: transparent;
  border-color: transparent;
  color: var(--text-dim);
  font-size: var(--fs-13);
  text-align: left;
  justify-content: flex-start;
  height: 32px;
  padding: 0 10px;
}
.help-toc-item:hover:not(:disabled) { background: var(--surface-hi); color: var(--text); }

.help-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.help-category-title {
  font-size: var(--fs-16);
  font-weight: 600;
  margin: 0 0 12px;
}

.help-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.help-card { display: flex; flex-direction: column; gap: 10px; }

.help-card-q {
  font-size: var(--fs-16);
  font-weight: 600;
  margin: 0;
}

.help-steps {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--fs-14);
}

/* 図（スクショ／説明図）。スクショは用途どおりに切り抜いた原寸（等倍）で、
   格子に押し込むと文字が読めなくなるため、縦に積んで自然な幅のまま見せる。
   ヘルプを読むのは操作に慣れていない家族なので、密度より読めることを優先する */
.help-figures {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.help-figure {
  margin: 0;
  display: flex;
  flex-direction: column;
  /* 親（.help-figures）の幅いっぱいには広げず、画像の自然な幅で止める。
     画像が窓より大きいときだけ .help-figure-btn の max-width で縮む */
  align-items: flex-start;
  gap: 6px;
}
.help-figure-btn {
  position: relative;
  display: block;
  max-width: 100%;
  padding: 0;
  /* style.css のグローバル button は height: 36px。これを打ち消さないと
     画像も図も 36px に潰れて、見出し1行分しか見えなくなる（実測で確認） */
  height: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  /* 白（--surface）。図の帯は --surface-hi で塗ってあるので、器を --surface-hi に
     すると同色で消える。アプリ本体と同じ「白地に灰色の帯」に揃える（実測で確認） */
  background: var(--surface);
  overflow: hidden;
  cursor: zoom-in;
  transition: border-color var(--dur) var(--ease);
}
.help-figure-btn:hover { border-color: var(--text-faint); }
.help-figure-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.help-figure-img {
  display: block;
  max-width: 100%;
  height: auto;
}
/* SVG は幅を持たないので、器に作図どおりの幅（viewBox は 820 前後）を与える。
   これが無いと width: 100% の基準が決まらず、置換要素の既定 300px に落ちて
   文字が 4 割まで縮み読めなくなる（実測で確認） */
.help-figure-diagram { display: block; padding: 10px; width: 840px; max-width: 100%; }
.help-figure-diagram :deep(svg) { display: block; width: 100%; height: auto; }
/* 「手順N」の札は図の外（説明文と同じ並び）に出す。画像に重ねると中身を隠すため */
.help-figure-step {
  align-self: flex-start;
}
.help-figure-zoom {
  position: absolute;
  bottom: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-1);
}
.help-figure-caption {
  margin: 0;
  font-size: var(--fs-12);
  color: var(--text-dim);
}

.help-example {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-hi);
  color: var(--text-dim);
  font-size: var(--fs-13);
  white-space: pre-wrap;
  word-break: break-word;
}

.help-notes {
  padding-left: 12px;
  border-left: 2px solid var(--line-soft);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.help-notes p {
  margin: 0;
  font-size: var(--fs-13);
  color: var(--text-dim);
}

.help-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.help-links button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

@media (max-width: 1099px) {
  .help-layout { flex-direction: column; }
  .help-toc {
    position: static;
    width: 100%;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 6px;
  }
  .help-toc-item {
    border-radius: 999px;
    background: var(--surface-hi);
    height: 28px;
    padding: 0 12px;
    font-size: var(--fs-12);
  }
}

/* --- ライトボックス ---
   ドロワー（100、Drawer.vue:95）・ダイアログ（110、ConfirmDialog.vue:118 /
   InputDialog.vue:132）より上に固定する。ヘルプは単独の画面で通常は他の
   ドロワー／ダイアログと同時に開かないが、取り決めの最上位に合わせておく */
.lightbox-scrim {
  position: fixed;
  inset: 0;
  background: rgba(38, 38, 42, .32);
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.lightbox-panel {
  position: relative;
  max-width: min(1100px, 92vw);
  max-height: 88vh;
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: var(--shadow-2);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lightbox-close {
  position: absolute;
  top: 10px;
  right: 10px;
}

.lightbox-body {
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
}

.lightbox-img {
  display: block;
  max-width: 100%;
  max-height: 76vh;
  border-radius: var(--radius-sm);
  object-fit: contain;
}

.lightbox-diagram { width: 100%; }
.lightbox-diagram :deep(svg) { display: block; width: 100%; height: auto; }

.lightbox-caption {
  margin: 0;
  flex-shrink: 0;
  font-size: var(--fs-13);
  color: var(--text-dim);
  text-align: center;
}

/* 開閉とも 180ms でスクリムのフェード + パネルのスケール（Drawer / ConfirmDialog と同じ） */
.lightbox-enter-active,
.lightbox-leave-active {
  transition: opacity var(--dur) var(--ease);
}
.lightbox-enter-active .lightbox-panel,
.lightbox-leave-active .lightbox-panel {
  transition: transform var(--dur) var(--ease);
}
.lightbox-enter-from,
.lightbox-leave-to {
  opacity: 0;
}
.lightbox-enter-from .lightbox-panel,
.lightbox-leave-to .lightbox-panel {
  transform: scale(.98);
}

@media (prefers-reduced-motion: reduce) {
  .lightbox-enter-active,
  .lightbox-leave-active,
  .lightbox-enter-active .lightbox-panel,
  .lightbox-leave-active .lightbox-panel {
    transition: none;
  }
}
</style>
