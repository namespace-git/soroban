<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, provide } from 'vue'
import Icon from './components/Icon.vue'
import InputDialog from './components/InputDialog.vue'
import type { PromptOptions } from './components/InputDialog.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import type { ConfirmChoice } from './components/ConfirmDialog.vue'
import SearchBox from './components/SearchBox.vue'
import GlobalSearch from './components/GlobalSearch.vue'
import Dashboard from './views/Dashboard.vue'
import Sales from './views/Sales.vue'
import Purchases from './views/Purchases.vue'
import Inventory from './views/Inventory.vue'
import Products from './views/Products.vue'
import Monthly from './views/Monthly.vue'
import Expenses from './views/Expenses.vue'
import Settings from './views/Settings.vue'
import Help from './views/Help.vue'
import type { CollectorRun, DashboardStats, SaleStatus, SearchHit, UpdateStatus } from '../shared/types'
import type { IconName } from './components/Icon.vue'

type Tab = 'dashboard' | 'sales' | 'purchases' | 'inventory' | 'products' | 'monthly' | 'expenses' | 'settings' | 'help'
/**
 * goto にタブと一緒に渡す情報。型番指定（商品タブ）・売上タブの段階指定（出品中／未処理／完了／すべて）・
 * 出品指定・未引き当てだけ絞る指定・横断検索からの遷移（検索語を引き継ぐ・該当行をハイライトする）
 */
export type GotoPayload = {
  modelCode?: string
  stage?: 'listed' | 'pending' | 'done' | 'all'
  onlyUnallocated?: boolean
  onlyPending?: boolean
  mercariItemId?: string
  search?: string
  focusId?: string
  /** 売上タブの取引状態の絞り込み（例：発送してください） */
  status?: SaleStatus
  /** 売上タブを月で絞る（YYYY-MM。グラフの月をクリックしたとき） */
  month?: string
}

const tabs: Array<{ key: Tab; label: string; icon: IconName }> = [
  { key: 'dashboard', label: 'ホーム', icon: 'home' },
  { key: 'sales', label: '売上', icon: 'sales' },
  { key: 'purchases', label: '仕入', icon: 'purchase' },
  { key: 'inventory', label: '在庫', icon: 'inventory' },
  { key: 'products', label: '商品', icon: 'product' },
  { key: 'monthly', label: '月次', icon: 'monthly' },
  { key: 'expenses', label: '経費', icon: 'receipt' },
  { key: 'settings', label: '設定', icon: 'settings' },
  { key: 'help', label: 'ヘルプ', icon: 'help' },
]

const tab = ref<Tab>('dashboard')
const collecting = ref(false)
const notice = ref<{ text: string; kind: 'ok' | 'warn' } | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | undefined

// 子からデータ再読み込みを促すためのカウンタ
const revision = ref(0)
provide('revision', revision)
// 直近の goto() 呼び出しに添えられた情報（型番など）。切替先の view が inject して読む
const gotoPayload = ref<GotoPayload | null>(null)
provide('gotoPayload', gotoPayload)
function goto(t: Tab, payload?: GotoPayload) { tab.value = t; gotoPayload.value = payload ?? null }
provide('goto', goto)

// --- 横断検索（Ctrl+K / Cmd+K でフォーカス。250ms デバウンスで searchAll） ---

const searchWrap = ref<HTMLElement | null>(null)
const searchQuery = ref('')
const searchOpen = ref(false)
const searchHits = ref<SearchHit[]>([])
const searchLoading = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined

watch(searchQuery, (q) => {
  clearTimeout(searchTimer)
  const trimmed = q.trim()
  if (!trimmed) {
    searchOpen.value = false
    searchHits.value = []
    return
  }
  searchOpen.value = true
  searchTimer = setTimeout(async () => {
    searchLoading.value = true
    try {
      searchHits.value = await window.soroban.searchAll(trimmed)
    } finally {
      searchLoading.value = false
    }
  }, 250)
})

function focusSearch() {
  searchWrap.value?.querySelector('input')?.focus()
}

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    focusSearch()
  }
}

const TAB_FOR_KIND: Record<SearchHit['kind'], Tab> = {
  inventory: 'inventory', listing: 'sales', sale: 'sales', purchase: 'purchases',
}

function onSearchSelect(hit: SearchHit) {
  const payload = hit.kind === 'listing'
    ? { stage: 'listed' as const, search: searchQuery.value, focusId: hit.id }
    : { search: searchQuery.value, focusId: hit.id }
  goto(TAB_FOR_KIND[hit.kind], payload)
  searchOpen.value = false
  searchQuery.value = ''
}

function closeSearch() {
  searchOpen.value = false
}

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

// window.prompt() は Electron では動かないため、入力ダイアログを共通で用意する
type PromptState = { title: string; opts: PromptOptions; resolve: (v: string | null) => void }
const promptState = ref<PromptState | null>(null)

function ask(title: string, opts: PromptOptions = {}): Promise<string | null> {
  // 連続呼び出しは前のものを cancel 扱いにする
  promptState.value?.resolve(null)
  return new Promise((resolve) => {
    promptState.value = { title, opts, resolve }
  })
}

function onPromptSubmit(value: string) {
  promptState.value?.resolve(value)
  promptState.value = null
}

function onPromptCancel() {
  promptState.value?.resolve(null)
  promptState.value = null
}

provide('prompt', ask)

// confirm() / alert() は Electron ではダサい OS ダイアログになるため、ConfirmDialog に統一する
type ChoiceState = { title: string; message?: string; choices: ConfirmChoice[]; resolve: (v: string | null) => void }
const choiceState = ref<ChoiceState | null>(null)

function chooseRaw(title: string, choices: ConfirmChoice[], message?: string): Promise<string | null> {
  choiceState.value?.resolve(null)
  return new Promise((resolve) => {
    choiceState.value = { title, message, choices, resolve }
  })
}

function onChoose(value: string) {
  choiceState.value?.resolve(value)
  choiceState.value = null
}

function onChooseCancel() {
  choiceState.value?.resolve(null)
  choiceState.value = null
}

// キャンセル／OK の2択。danger なら OK ボタンが赤くなる
function confirmDialog(
  title: string,
  opts: { message?: string; okLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return chooseRaw(title, [
    { label: 'キャンセル', value: '__cancel', tone: 'ghost' },
    { label: opts.okLabel ?? 'OK', value: '__ok', tone: opts.danger ? 'danger' : 'primary' },
  ], opts.message).then(v => v === '__ok')
}

// 複数ボタンから1つ選ばせる。キャンセル（Esc・スクリムクリック）は null
function chooseDialog(
  title: string,
  choices: ConfirmChoice[],
  opts: { message?: string } = {},
): Promise<string | null> {
  return chooseRaw(title, choices, opts.message)
}

provide('confirm', confirmDialog)
provide('choose', chooseDialog)
provide('toast', (text: string, kind: 'ok' | 'warn') => showNotice({ text, kind }))
// main.ts の errorHandler から。処理が失敗したのに何も起きない、を防ぐ
window.addEventListener('soroban:error', (e) => {
  // Electron の IPC が付ける "Error invoking remote method 'x': " は人には要らない
  const raw = (e as CustomEvent<string>).detail.replace(/^Error invoking remote method '[^']+': /, '').replace(/^(Sqlite)?Error: /, '')
  showNotice({ text: `エラー：${raw}`, kind: 'warn' })
})

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
  const label = run.source === 'mellojoy' ? `メロジョイ(${run.shop_account_name ?? '?'}) ` : ''
  return `最終取り込み：${label}${runLabel[run.status] ?? run.status} ${formatRunTime(run.started_at)}`
})

const runIsWarn = computed(() => {
  const run = stats.value?.lastRun
  return !!run && run.status !== 'ok'
})

function runLabelText(run: CollectorRun): string {
  return run.source === 'mercari' ? 'メルカリ' : (run.shop_account_name ?? 'メロジョイ')
}

function runMessage(run: CollectorRun): string {
  const messages: Record<string, string> = {
    ok: `新規 ${run.inserted}件（取得 ${run.fetched}件）`,
    empty: run.message ?? '0件でした',
    auth_required: run.message ?? 'ログインが必要です',
    failed: `失敗：${run.message ?? '不明なエラー'}`,
  }
  return messages[run.status] ?? run.status
}

// メルカリ→仕入先アカウントの順で1回分がまとめて返る。1つのトーストにまとめる
function reportRun(runs: CollectorRun[]) {
  if (!runs.length) return
  const text = runs.map(r => `${runLabelText(r)}: ${runMessage(r)}`).join('／')
  const kind: 'ok' | 'warn' = runs.every(r => r.status === 'ok') ? 'ok' : 'warn'
  showNotice({ text, kind })
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

// --- アプリの更新（GitHub Releases）。裏の自動確認から知らされたら薄いバナーで出す ---

const updateStatus = ref<UpdateStatus | null>(null)
// 「あとで」で閉じたらセッション中は出さない
const updateDismissed = ref(false)
const updateInstalling = ref(false)

const showUpdateBanner = computed(() =>
  !updateDismissed.value && !!updateStatus.value &&
  (updateStatus.value.state === 'available' || updateStatus.value.state === 'downloaded'),
)

function dismissUpdateBanner() {
  updateDismissed.value = true
}

async function installUpdateFromBanner() {
  updateInstalling.value = true
  try {
    await window.soroban.installUpdate()
  } finally {
    updateInstalling.value = false
  }
}

onMounted(() => {
  loadStats()
  // 起動時の自動取り込みが終わったら知らせる
  ;(window as any).sorobanEvents?.onCollectDone((runs: CollectorRun[]) => {
    reportRun(runs)
    loadStats()
  })
  // 裏の自動確認（起動10秒後・6時間ごと）で新しい版が見つかったら知らせる
  ;(window as any).sorobanEvents?.onUpdateStatus((status: UpdateStatus) => {
    updateStatus.value = status
  })
  window.addEventListener('keydown', onGlobalKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
})

// 子側の revision カウンタが動くたびに要対応件数・取り込み状態も更新する
watch(revision, loadStats)
</script>

<template>
  <div class="shell">
    <aside class="nav">
      <div class="brand-mark">
        <span class="brand-mark-badge">そ</span>
        <span class="brand-mark-text">そろばん</span>
      </div>
      <nav class="nav-list">
        <button
          v-for="t in tabs" :key="t.key"
          class="nav-item"
          :class="{ active: tab === t.key }"
          :aria-current="tab === t.key ? 'page' : undefined"
          :title="t.label"
          @click="tab = t.key"
        >
          <Icon :name="t.icon" :size="20" />
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
        <div ref="searchWrap" class="global-search">
          <SearchBox v-model="searchQuery" placeholder="すべてから探す（Ctrl+K）" />
        </div>
        <span class="run-status" :class="{ warn: runIsWarn }">
          <Icon v-if="runIsWarn" name="alert" :size="14" />
          {{ runStatusText }}
        </span>
        <button class="primary" :disabled="collecting" @click="collect">
          <Icon name="refresh" :size="16" />
          {{ collecting ? '取り込み中…' : '取り込む' }}
        </button>
      </header>

      <div v-if="showUpdateBanner" class="update-banner">
        <Icon name="refresh" :size="14" />
        <span>新しいバージョン v{{ updateStatus?.latest }} があります</span>
        <button class="sm" :disabled="updateInstalling" @click="installUpdateFromBanner">
          {{ updateStatus?.canAutoInstall ? '再起動して更新' : 'ダウンロード' }}
        </button>
        <button class="ghost sm" @click="dismissUpdateBanner">あとで</button>
      </div>

      <div v-if="notice" class="toast" :class="notice.kind">
        <Icon v-if="notice.kind === 'warn'" class="toast-warn-icon" name="alert" :size="14" />
        {{ notice.text }}
        <button class="ghost sm" @click="notice = null">閉じる</button>
      </div>

      <main>
        <Dashboard v-if="tab === 'dashboard'" />
        <Sales v-else-if="tab === 'sales'" />
        <Purchases v-else-if="tab === 'purchases'" />
        <Inventory v-else-if="tab === 'inventory'" />
        <Products v-else-if="tab === 'products'" />
        <Monthly v-else-if="tab === 'monthly'" />
        <Expenses v-else-if="tab === 'expenses'" />
        <Settings v-else-if="tab === 'settings'" />
        <Help v-else />
      </main>
    </div>

    <InputDialog
      :open="!!promptState"
      :title="promptState?.title ?? ''"
      :label="promptState?.opts.label"
      :initial="promptState?.opts.initial"
      :placeholder="promptState?.opts.placeholder"
      :multiline="promptState?.opts.multiline"
      :ok-label="promptState?.opts.okLabel"
      @submit="onPromptSubmit"
      @cancel="onPromptCancel"
    />

    <ConfirmDialog
      :open="!!choiceState"
      :title="choiceState?.title ?? ''"
      :message="choiceState?.message"
      :choices="choiceState?.choices ?? []"
      @choose="onChoose"
      @cancel="onChooseCancel"
    />

    <GlobalSearch
      :open="searchOpen"
      :query="searchQuery"
      :hits="searchHits"
      :loading="searchLoading"
      @close="closeSearch"
      @select="onSearchSelect"
    />
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
  box-shadow: var(--shadow-1);
  padding: 16px 10px;
  z-index: 1;
}

.brand-mark {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 4px 4px 20px;
}
.brand-mark-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  background: var(--brand);
  color: var(--text);
  font-size: var(--fs-16);
  font-weight: 700;
}
.brand-mark-text {
  font-size: var(--fs-12);
  font-weight: 600;
  letter-spacing: .02em;
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
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 64px;
  padding: 0 4px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-faint);
  font-size: var(--fs-11);
  text-align: center;
  cursor: pointer;
}
.nav-item:hover { background: var(--surface-hi); color: var(--text-dim); }
.nav-item.active { color: var(--text); font-weight: 700; }

.nav-label { flex: none; }

.nav-item .nav-badge {
  position: absolute;
  top: 4px;
  right: 12px;
}

.nav-version {
  padding: 8px;
  font-size: var(--fs-12);
  text-align: center;
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
  padding: 0 24px;
  background: var(--canvas);
  border-bottom: none;
}

.global-search { flex-shrink: 0; }

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

/* --- 更新バナー --- */

.update-banner {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 24px;
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-size: var(--fs-13);
}
.update-banner button { margin-left: 0; }
.update-banner button:last-child { margin-left: auto; }
</style>
