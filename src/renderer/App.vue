<script setup lang="ts">
import { ref, computed, onMounted, watch, provide } from 'vue'
import Icon from './components/Icon.vue'
import Dashboard from './views/Dashboard.vue'
import Sales from './views/Sales.vue'
import Purchases from './views/Purchases.vue'
import Inventory from './views/Inventory.vue'
import Monthly from './views/Monthly.vue'
import Settings from './views/Settings.vue'
import type { CollectorRun, DashboardStats } from '../shared/types'
import type { IconName } from './components/Icon.vue'

type Tab = 'dashboard' | 'sales' | 'purchases' | 'inventory' | 'monthly' | 'settings'

const tabs: Array<{ key: Tab; label: string; icon: IconName }> = [
  { key: 'dashboard', label: 'ホーム', icon: 'home' },
  { key: 'sales', label: '売上', icon: 'sales' },
  { key: 'purchases', label: '仕入', icon: 'purchase' },
  { key: 'inventory', label: '在庫', icon: 'inventory' },
  { key: 'monthly', label: '月次', icon: 'monthly' },
  { key: 'settings', label: '設定', icon: 'settings' },
]

const tab = ref<Tab>('dashboard')
const collecting = ref(false)
const notice = ref<{ text: string; kind: 'ok' | 'warn' } | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | undefined

// 子からデータ再読み込みを促すためのカウンタ
const revision = ref(0)
provide('revision', revision)
provide('goto', (t: Tab) => { tab.value = t })

// ナビの要対応バッジ・上部バーの取り込み状態はシェル自身も読む
const stats = ref<DashboardStats | null>(null)
// 売上タブの未処理一覧（送料未入力 or 未紐付け）の件数。ナビバッジと売上タブの表示件数を一致させる
const pendingCount = ref(0)

async function loadStats() {
  const [dashboard, pending] = await Promise.all([
    window.soroban.getDashboard(),
    window.soroban.listSales({ onlyPending: true }),
  ])
  stats.value = dashboard
  pendingCount.value = pending.length
}

// 子の view がデータを変更したら呼ぶ。バッジと取り込み状態を再読み込みする
provide('changed', () => { loadStats() })

const needsTotal = computed(() => pendingCount.value)

const runLabel: Record<string, string> = {
  ok: '正常',
  empty: '0件（要確認）',
  auth_required: 'ログインが必要',
  failed: '失敗',
}

function formatRunTime(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const runStatusText = computed(() => {
  const run = stats.value?.lastRun
  if (!run) return '取り込み未実施'
  return `最終取り込み：${runLabel[run.status] ?? run.status} ${formatRunTime(run.started_at)}`
})

const runIsWarn = computed(() => {
  const run = stats.value?.lastRun
  return !!run && run.status !== 'ok'
})

function reportRun(run: CollectorRun) {
  const messages: Record<string, { text: string; kind: 'ok' | 'warn' }> = {
    ok: { text: `取り込み ${run.inserted}件（取得 ${run.fetched}件）`, kind: 'ok' },
    empty: { text: run.message ?? '0件でした', kind: 'warn' },
    auth_required: { text: run.message ?? 'ログインが必要です', kind: 'warn' },
    failed: { text: `失敗：${run.message ?? '不明なエラー'}`, kind: 'warn' },
  }
  showNotice(messages[run.status] ?? null)
  revision.value++
}

function showNotice(n: { text: string; kind: 'ok' | 'warn' } | null) {
  clearTimeout(noticeTimer)
  notice.value = n
  if (n?.kind === 'ok') {
    noticeTimer = setTimeout(() => { notice.value = null }, 5000)
  }
}

async function collect() {
  collecting.value = true
  showNotice(null)
  try {
    reportRun(await window.soroban.collect())
  } finally {
    collecting.value = false
  }
}

async function login() {
  await window.soroban.openLogin()
  showNotice({ text: 'ログイン画面を閉じました。取り込みを試してください', kind: 'ok' })
}

onMounted(() => {
  loadStats()
  // 起動時の自動取り込みが終わったら知らせる
  ;(window as any).sorobanEvents?.onCollectDone((run: CollectorRun) => {
    reportRun(run)
    loadStats()
  })
})

// 子側の revision カウンタが動くたびに要対応件数・取り込み状態も更新する
watch(revision, loadStats)
</script>

<template>
  <div class="shell">
    <aside class="nav">
      <div class="wordmark"><span class="wordmark-text">そろばん</span></div>
      <nav class="nav-list">
        <button
          v-for="t in tabs" :key="t.key"
          class="nav-item"
          :class="{ active: tab === t.key }"
          :aria-current="tab === t.key ? 'page' : undefined"
          :title="t.label"
          @click="tab = t.key"
        >
          <Icon :name="t.icon" :size="18" />
          <span class="nav-label">{{ t.label }}</span>
          <span v-if="t.key === 'sales' && needsTotal > 0" class="nav-badge">{{ needsTotal }}</span>
        </button>
      </nav>
      <div class="grow" />
      <div class="nav-version faint">v0.1</div>
    </aside>

    <div class="main-col">
      <header class="topbar">
        <div class="grow" />
        <span class="run-status" :class="{ warn: runIsWarn }">
          <Icon v-if="runIsWarn" name="alert" :size="14" />
          {{ runStatusText }}
        </span>
        <button @click="login">
          <Icon name="login" :size="16" />
          メルカリにログイン
        </button>
        <button class="primary" :disabled="collecting" @click="collect">
          <Icon name="refresh" :size="16" />
          {{ collecting ? '取り込み中…' : '取り込む' }}
        </button>
      </header>

      <div v-if="notice" class="toast" :class="notice.kind">
        {{ notice.text }}
        <button class="ghost sm" @click="notice = null">閉じる</button>
      </div>

      <main>
        <Dashboard v-if="tab === 'dashboard'" />
        <Sales v-else-if="tab === 'sales'" />
        <Purchases v-else-if="tab === 'purchases'" />
        <Inventory v-else-if="tab === 'inventory'" />
        <Monthly v-else-if="tab === 'monthly'" />
        <Settings v-else />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  height: 100%;
  display: flex;
}

/* --- サイドナビ --- */

.nav {
  width: var(--nav-w);
  flex-shrink: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--surface-nav);
  border-right: 1px solid var(--line);
  padding: 12px 12px 16px;
}

.wordmark {
  padding: 8px 8px 16px;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: .04em;
  color: var(--text);
}

.nav-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 0 10px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  font-size: var(--fs-14);
  text-align: left;
  cursor: pointer;
}
.nav-item:hover { background: var(--surface-hi); }
.nav-item.active { background: var(--accent-soft); color: var(--accent); }

.nav-label { flex: 1; }

.nav-version {
  padding: 8px;
  font-size: var(--fs-12);
}

/* --- 上部バー・本文 --- */

.main-col {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.topbar {
  flex-shrink: 0;
  height: var(--topbar-h);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}

.run-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-13);
  color: var(--text-dim);
  white-space: nowrap;
}
.run-status.warn { color: var(--warn); }

.topbar button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

main {
  flex: 1;
  overflow-y: auto;
  background: var(--canvas);
}

/* --- 1100px 未満：ナビをアイコン帯に畳む --- */

@media (max-width: 1099px) {
  .nav { width: 56px; padding-left: 8px; padding-right: 8px; }
  .wordmark-text { display: none; }
  .nav-item { justify-content: center; padding: 0; }
  .nav-label { display: none; }
  .nav-item .nav-badge { position: absolute; margin-left: 14px; margin-top: -14px; }
}
</style>
