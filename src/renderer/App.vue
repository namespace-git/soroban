<script setup lang="ts">
import { ref, onMounted, provide } from 'vue'
import Dashboard from './views/Dashboard.vue'
import Sales from './views/Sales.vue'
import Purchases from './views/Purchases.vue'
import Inventory from './views/Inventory.vue'
import Settings from './views/Settings.vue'
import type { CollectorRun } from '../shared/types'

type Tab = 'dashboard' | 'sales' | 'purchases' | 'inventory' | 'settings'

const tabs: Array<{ key: Tab; label: string }> = [
  { key: 'dashboard', label: 'ホーム' },
  { key: 'sales', label: '売上' },
  { key: 'purchases', label: '仕入' },
  { key: 'inventory', label: '在庫' },
  { key: 'settings', label: '設定' },
]

const tab = ref<Tab>('dashboard')
const collecting = ref(false)
const notice = ref<{ text: string; kind: 'ok' | 'warn' } | null>(null)

// 子からデータ再読み込みを促すためのカウンタ
const revision = ref(0)
provide('revision', revision)
provide('goto', (t: Tab) => { tab.value = t })

function reportRun(run: CollectorRun) {
  const messages: Record<string, { text: string; kind: 'ok' | 'warn' }> = {
    ok: { text: `取り込み ${run.inserted}件（取得 ${run.fetched}件）`, kind: 'ok' },
    empty: { text: run.message ?? '0件でした', kind: 'warn' },
    auth_required: { text: run.message ?? 'ログインが必要です', kind: 'warn' },
    failed: { text: `失敗：${run.message ?? '不明なエラー'}`, kind: 'warn' },
  }
  notice.value = messages[run.status] ?? null
  revision.value++
}

async function collect() {
  collecting.value = true
  notice.value = null
  try {
    reportRun(await window.soroban.collect())
  } finally {
    collecting.value = false
  }
}

async function login() {
  await window.soroban.openLogin()
  notice.value = { text: 'ログイン画面を閉じました。取り込みを試してください', kind: 'ok' }
}

onMounted(() => {
  // 起動時の自動取り込みが終わったら知らせる
  ;(window as any).sorobanEvents?.onCollectDone((run: CollectorRun) => reportRun(run))
})
</script>

<template>
  <div class="shell">
    <header>
      <h1>そろばん</h1>
      <nav>
        <button
          v-for="t in tabs" :key="t.key"
          class="ghost" :class="{ active: tab === t.key }"
          @click="tab = t.key"
        >{{ t.label }}</button>
      </nav>
      <div class="grow" />
      <button @click="login">メルカリにログイン</button>
      <button class="primary" :disabled="collecting" @click="collect">
        {{ collecting ? '取り込み中…' : '取り込む' }}
      </button>
    </header>

    <div v-if="notice" class="notice" :class="notice.kind">
      {{ notice.text }}
      <button class="ghost" @click="notice = null">閉じる</button>
    </div>

    <main>
      <Dashboard v-if="tab === 'dashboard'" />
      <Sales v-else-if="tab === 'sales'" />
      <Purchases v-else-if="tab === 'purchases'" />
      <Inventory v-else-if="tab === 'inventory'" />
      <Settings v-else />
    </main>
  </div>
</template>

<style scoped>
.shell {
  height: 100%;
  display: flex;
  flex-direction: column;
}

header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

h1 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  letter-spacing: .08em;
}

nav { display: flex; gap: 2px; }

nav button.active {
  color: var(--text);
  background: var(--surface-hi);
}

.notice {
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  border-bottom: 1px solid var(--line);
}
.notice.ok   { background: #1e2a20; color: var(--profit); }
.notice.warn { background: var(--warn-bg); color: var(--warn); }
.notice button { margin-left: auto; }

main {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}
</style>
