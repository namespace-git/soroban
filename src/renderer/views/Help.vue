<script setup lang="ts">
// ヘルプ：「こういうときは…？」から探す静的な FAQ。データは help/topics.ts に集約し、
// ここでは検索の絞り込みと目次スクロールだけを扱う（window.soroban は呼ばない）。
import { ref, computed, inject } from 'vue'
import Icon from '../components/Icon.vue'
import SearchBox, { matchesSearch } from '../components/SearchBox.vue'
import EmptyState from '../components/EmptyState.vue'
import { HELP, type HelpTab, type HelpGotoPayload, type HelpTopic } from '../help/topics'

const goto = inject<(t: HelpTab, payload?: HelpGotoPayload) => void>('goto')!

const query = ref('')

function topicHaystacks(t: HelpTopic): string[] {
  return [t.q, ...(t.steps ?? []), ...(t.notes ?? []), ...(t.example ?? []), ...(t.keywords ?? [])]
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
</style>
