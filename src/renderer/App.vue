<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, provide, inject, nextTick } from 'vue'
import Icon from './components/Icon.vue'
import InputDialog from './components/InputDialog.vue'
import type { PromptOptions } from './components/InputDialog.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import type { ConfirmChoice } from './components/ConfirmDialog.vue'
import SearchBox from './components/SearchBox.vue'
import GlobalSearch from './components/GlobalSearch.vue'
import ProfitStripBar from './components/ProfitStripBar.vue'
import Dashboard from './views/Dashboard.vue'
import Sales from './views/Sales.vue'
import Purchases from './views/Purchases.vue'
import Inventory from './views/Inventory.vue'
import Products from './views/Products.vue'
import Monthly from './views/Monthly.vue'
import Expenses from './views/Expenses.vue'
import Settings from './views/Settings.vue'
import Help from './views/Help.vue'
import type { CollectorRun, DashboardStats, ListingStatus, ProfitStrip, SaleStatus, SearchHit, TrackingCheckSummary, UpdateStatus } from '../shared/types'
import type { IconName } from './components/Icon.vue'
import type { CollectJob } from '../shared/web-types'
import { useWebCollect, describeJob, formatRemaining } from './components/web-collect'
import { parseOpenTarget } from './components/web-glue'
import { runSourceLabel } from './utils/collector-run'
import { yen } from './format'
import { pushBackLayer, useBackClose } from './composables/useBackClose'

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
  /** 売上タブの出品中の絞り込み（例：出品停止中。既定は出品中のみ） */
  listingStatus?: ListingStatus
  /** 売上タブを月で絞る（YYYY-MM。グラフの月をクリックしたとき） */
  month?: string
  /** 在庫タブの状態（ホームの長期滞留から：'all'）と、滞留日数の下限 */
  inventoryStatus?: 'unlisted' | 'listed' | 'sold' | 'other' | 'all'
  agingMin?: number
}

const tabs: Array<{ key: Tab; label: string; icon: IconName }> = [
  { key: 'dashboard', label: 'ホーム', icon: 'home' },
  { key: 'sales', label: '売上', icon: 'sales' },
  { key: 'purchases', label: '仕入', icon: 'purchase' },
  { key: 'inventory', label: '在庫', icon: 'inventory' },
  { key: 'products', label: '商品', icon: 'product' },
  { key: 'expenses', label: '経費', icon: 'receipt' },
  { key: 'monthly', label: '月次', icon: 'monthly' },
  { key: 'settings', label: '設定', icon: 'settings' },
  { key: 'help', label: 'ヘルプ', icon: 'help' },
]

const tab = ref<Tab>('dashboard')
const collecting = ref(false)
// 通知（トースト）。action があるときは通知の中にボタンを出す（例：「元に戻す」。押すと run() して通知を閉じる）
type NoticeAction = { label: string; run: () => void | Promise<void> }
type Notice = { text: string; kind: 'ok' | 'warn'; action?: NoticeAction }
const notice = ref<Notice | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | undefined

// 本文（<main>）。タブを替えたら先頭から読ませるために、ここのスクロールを触る
const mainEl = ref<HTMLElement | null>(null)

/** 本文を先頭へ。smooth は「今いるタブをもう一度押した」とき（動きを減らす設定なら即時）。タブを替えたときは描画のあとに即時 */
function scrollMainTop(smooth = false) {
  if (smooth) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    mainEl.value?.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
    return
  }
  void nextTick(() => { if (mainEl.value) mainEl.value.scrollTop = 0 })
}

// 子からデータ再読み込みを促すためのカウンタ
const revision = ref(0)
provide('revision', revision)
// 直近の goto() 呼び出しに添えられた情報（型番など）。切替先の view が inject して読む
const gotoPayload = ref<GotoPayload | null>(null)
provide('gotoPayload', gotoPayload)
function goto(t: Tab, payload?: GotoPayload) {
  tab.value = t
  gotoPayload.value = payload ?? null
  // 行を指定された（focusId）ときは、各画面がその行へスクロールする。それ以外は先頭から
  if (!payload?.focusId) scrollMainTop()
}
provide('goto', goto)

// 端末の「戻る」：ホーム以外のタブにいるあいだ、履歴に「タブの層」を 1 段だけ積む。
// 一番上のシート → ホーム → アプリを閉じる、の順で戻れる。ホーム以外のタブ同士の移動では積み増さない
let tabLayer: { release(): void } | null = null
watch(tab, (t) => {
  if (t === 'dashboard') {
    const layer = tabLayer
    tabLayer = null
    layer?.release()
  } else if (!tabLayer) {
    tabLayer = pushBackLayer(() => {
      tabLayer = null // 戻るで外れた層。ここで release すると履歴を余計に戻してしまう
      goto('dashboard')
    })
  }
})

// --- Web 版：「取り込む」は取り込み担当の PC への依頼。通知から開く ---
// window.sorobanWeb は Web 版（auth/boot.ts）だけが差す。Electron 版では undefined で、この節は何もしない

const webApi = window.sorobanWeb ?? null
// queued・running の間だけ数秒ごとに状態を読み、終わったら reportJob で知らせる
const webCollect = webApi ? useWebCollect({ api: webApi, onFinished: reportJob }) : null
// ホームの「もう一度取り込む」も、このボタンと同じ流れにする
if (webCollect) provide('collect', collect)

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
  if (e.key === 'Escape' && moreOpen.value) moreOpen.value = false
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
  mobileSearch.value = false
}

function closeSearch() {
  searchOpen.value = false
  // スマホ幅は上のバーが検索欄に替わっている。「戻る」で結果を閉じたら、欄と入力も「キャンセル」と同じく戻す
  if (isMobile.value) closeMobileSearch()
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

// トップバーの「今月の粗利／純利益」ピル。全タブで常に表示する
const profitStrip = ref<ProfitStrip | null>(null)
provide('profitStrip', profitStrip)

async function loadProfitStrip() {
  // モックが getInbox にまだ対応していないとき（renderer-review 用）は getDashboard で代用する
  if (typeof window.soroban.getInbox === 'function') {
    profitStrip.value = (await window.soroban.getInbox()).strip
    return
  }
  const m = (await window.soroban.getDashboard()).thisMonth
  profitStrip.value = m
    ? {
        month: m.month,
        gross_profit: m.gross_profit,
        net_profit: m.net_profit,
        revenue: m.revenue,
        sales_count: m.sales_count,
        pending_profit_estimate: 0,
        pending_count: 0,
        awaiting_payout: 0,
        awaiting_payout_count: 0,
        last_month: null,
      }
    : null
}

// 子の view がデータを変更したら呼ぶ。バッジと取り込み状態を再読み込みし、
// 同じ画面に居る兄弟（売上サマリなど）にも知らせる（revision は取り込み後だけ動く）
const dataRevision = ref(0)
provide('dataRevision', dataRevision)
provide('changed', () => { loadStats(); loadProfitStrip(); dataRevision.value++ })

// --- スマホ幅（768px 未満）の外枠 ---
// サイドナビの代わりに下のタブバー。毎日触る 5 つ（ホーム・売上・仕入・在庫・月次）を並べ、
// 残り（商品・経費・設定・ヘルプ）は「その他」の中に置く。ホーム（今やること）は 1 タップ

const tabByKey = (key: Tab) => tabs.find(t => t.key === key)!
const barTabs = (['dashboard', 'sales', 'purchases', 'inventory', 'monthly'] as Tab[]).map(tabByKey)
const moreTabs = (['products', 'expenses', 'settings', 'help'] as Tab[]).map(tabByKey)

const MOBILE_QUERY = '(max-width: 767px)'
const isMobile = ref(false)
let mobileMql: MediaQueryList | undefined
function onMobileChange(e: { matches: boolean }) {
  isMobile.value = e.matches
  if (!e.matches) {
    moreOpen.value = false
    mobileSearch.value = false
  }
}

// 「その他」のシート。タブを選ぶ・外を押す・Esc で閉じる
const moreOpen = ref(false)
// 端末の「戻る」で閉じる（一番上のシート → ホーム → アプリを閉じる）
useBackClose(() => moreOpen.value, () => { moreOpen.value = false })
const moreActive = computed(() => moreTabs.some(t => t.key === tab.value))
// 上のバーの検索は、スマホ幅では虫めがねを押すと入力欄が上のバー全体に広がる
const mobileSearch = ref(false)

// Web 版（auth/WebRoot.vue）だけが渡す。Electron 版では無く、ログアウトの口は出ない
const webAccount = inject<{ email: string | null; logout: () => Promise<void> } | null>('webAccount', null)

async function logout() {
  moreOpen.value = false
  await webAccount?.logout()
}

// 下のタブバー・縦ナビ・「その他」のシートから。今いるタブをもう一度押したら先頭へ、別のタブなら先頭から開く。
// tab を先に替える：タブの層（戻る）を積むのが、シートの層を外すより先になる
function selectTab(key: Tab) {
  if (key === tab.value) {
    moreOpen.value = false
    scrollMainTop(true)
    return
  }
  tab.value = key
  // タブから開いたときは、前に goto で渡した指定（focusId・段階など）を持ち越さない
  gotoPayload.value = null
  moreOpen.value = false
  scrollMainTop()
}

async function openMobileSearch() {
  mobileSearch.value = true
  await nextTick()
  focusSearch()
}

function closeMobileSearch() {
  mobileSearch.value = false
  searchQuery.value = ''
}

// 上のバーの利益ピルは 1 行に収まらないと省略されるので、全文は title で読ませる（ProfitStripBar の compact と同じ文言）
const profitTitle = computed(() => {
  const s = profitStrip.value
  const lines = [`今月の実績粗利 ${yen(s?.gross_profit ?? 0)} ／ 純利益 ${yen(s?.net_profit ?? 0)}`]
  if (s?.pending_count) lines.push(`取引中 ${s.pending_count} 件 見込み ${yen(s.pending_profit_estimate)}`)
  lines.push('ホームで詳しく見る')
  return lines.join('\n')
})

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
// 通知。action を渡すと通知の中にボタンが出る（押すと run() を呼んで通知を閉じる。「元に戻す」など）
provide('toast', (text: string, kind: 'ok' | 'warn', action?: NoticeAction) => showNotice({ text, kind, action }))
// main.ts の errorHandler から。処理が失敗したのに何も起きない、を防ぐ
function onSorobanError(e: Event) {
  // Electron の IPC が付ける "Error invoking remote method 'x': " は人には要らない
  const raw = (e as CustomEvent<string>).detail.replace(/^Error invoking remote method '[^']+': /, '').replace(/^(Sqlite)?Error: /, '')
  showNotice({ text: `エラー：${raw}`, kind: 'warn' })
}
window.addEventListener('soroban:error', onSorobanError)

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
  // Web 版：走っている・PC が動いていない・クールダウン中のときは、最終取り込みより先にそれを見せる
  const web = webCollect?.statusLine.value
  if (web) return web.text
  const run = stats.value?.lastRun
  if (!run) return '取り込み未実施'
  const label = run.source === 'mellojoy' ? `メロジョイ(${run.shop_account_name ?? '?'}) ` : ''
  return `最終取り込み：${label}${runLabel[run.status] ?? run.status} ${formatRunTime(run.started_at)}`
})

const runIsWarn = computed(() => {
  const web = webCollect?.statusLine.value
  if (web) return web.warn
  const run = stats.value?.lastRun
  return !!run && run.status !== 'ok'
})

// Web 版だけ：狭い幅の上のバーに出す短い文言（「あと 52 秒」「取り込み中」）。無ければ今までどおり全文だけ。
// reserve はカウントダウンの間、欄の幅を動かさないための確保（桁が変わる境目で検索欄・利益ピルがずれない）
const runShort = computed(() => webCollect?.statusLine.value?.short ?? null)
const runReserve = computed(() => webCollect?.statusLine.value?.reserve ?? null)

function runMessage(run: CollectorRun): string {
  const messages: Record<string, string> = {
    ok: `新規 ${run.inserted}件（取得 ${run.fetched}件）`,
    empty: run.message ?? '0件でした',
    auth_required: run.message ?? 'ログインが必要です',
    failed: `失敗：${run.message ?? '不明なエラー'}`,
  }
  return messages[run.status] ?? run.status
}

// 直近に画面へ出した配送状況の確認結果（at の値）。同じ結果を2度出さないための見張り
const lastShownTrackingAt = ref<string | null>(null)

/**
 * 配送状況（17TRACK）の確認結果を1文にする。「17TRACK」「API」は出さない
 * （説明を受けていない家族が読む）。届いた数が分かるのがいちばん嬉しい情報
 */
function trackingMessage(t: TrackingCheckSummary): string {
  if (t.stopped) return `配送状況の確認を中断しました：${t.stopped}`
  if (t.delivered > 0) return `配送状況：${t.delivered}件届いたのを確認しました`
  return '配送状況を確認しました'
}

// メルカリ→仕入先アカウント→Yahoo!フリマの順で1回分がまとめて返る。1つのトーストにまとめる。
// 配送状況の確認は collect() の中で並行して走るが collector_run を作らないため、
// 「走ったのか分からない」と見えないよう、変化があったときだけ同じトーストに添える
async function reportRun(runs: CollectorRun[]) {
  const parts = runs.map(r => `${runSourceLabel(r)}: ${runMessage(r)}`)
  let kind: 'ok' | 'warn' = runs.some(r => r.status !== 'ok') ? 'warn' : 'ok'

  // Web 版の配送状況の確認は定期実行がやる（取り込みと一緒には走らない）ので、ここでは見ない
  const t = webApi ? null : await window.soroban.getLastTrackingSummary()
  if (t && t.at !== lastShownTrackingAt.value) {
    lastShownTrackingAt.value = t.at
    parts.push(trackingMessage(t))
    if (t.stopped) kind = 'warn'
  }

  if (!parts.length) return
  showNotice({ text: parts.join('／'), kind })
  revision.value++
}

// 自動で消えるまでの時間。ボタン付きの ok は押す間を長めに。warn も手で閉じるまで頭を覆い続けないよう消す（閉じるボタンは残す）
const NOTICE_MS = { ok: 5000, okWithAction: 6000, warn: 10000 }

function showNotice(n: Notice | null) {
  clearTimeout(noticeTimer)
  notice.value = n
  if (!n) return
  const ms = n.kind === 'warn' ? NOTICE_MS.warn : n.action ? NOTICE_MS.okWithAction : NOTICE_MS.ok
  noticeTimer = setTimeout(() => { notice.value = null }, ms)
}

// 通知の中のボタン。先に通知を閉じる（run() が新しい通知を出しても、それを消さない）
async function onNoticeAction() {
  const action = notice.value?.action
  showNotice(null)
  await action?.run()
}

async function collect() {
  if (webCollect) {
    // 押すのは 1 回だけ。積まれたあとは数秒ごとに状態を読み、終わったら reportJob が知らせる
    showNotice(null)
    await webCollect.request()
    return
  }
  collecting.value = true
  showNotice(null)
  try {
    await reportRun(await window.soroban.collect())
  } finally {
    collecting.value = false
  }
}

// 取り込むボタンの見え方。Electron 版は今までどおり collecting だけ
const collectBusy = computed(() => (webCollect ? webCollect.active.value : collecting.value))
const collectDisabled = computed(() => collectBusy.value || (webCollect?.cooldown.value ?? 0) > 0)
const collectLabel = computed(() => {
  if (webCollect?.queued.value) return '待っています…'
  return collectBusy.value ? '取り込み中…' : '取り込む'
})
const collectTitle = computed(() => {
  if (!webCollect) return undefined
  if (webCollect.cooldown.value > 0) return `あと ${formatRemaining(webCollect.cooldown.value)} で取り込めます`
  if (webCollect.agentsOffline.value) return '取り込み担当の PC が動いていません。押しても、5 分たつと取り消されます'
  return '取り込み担当の PC に取り込みを頼みます'
})

/** Web 版：頼んだ取り込みが終わった。デスクトップの reportRun と同じ見せ方（トースト＋画面の読み直し） */
function reportJob(job: CollectJob) {
  showNotice(describeJob(job, run => `${runSourceLabel(run)}: ${runMessage(run)}`))
  revision.value++
}

async function cancelCollect() {
  await webCollect?.cancel()
  showNotice({ text: '取り込みを取り消しました', kind: 'ok' })
}

// 通知（service worker の soroban:open）と、通知から立ち上げたときの URL（/?tab=sales&sale=<id> など）。知らない tab は無視
function openFromUrl(raw: unknown): boolean {
  const target = parseOpenTarget(raw, window.location.origin, tabs.map(t => t.key))
  if (!target) return false
  moreOpen.value = false
  goto(target.tab, target.payload ?? undefined)
  return true
}

function onSwMessage(e: MessageEvent) {
  const data = e.data as { type?: unknown; url?: unknown } | null
  if (data && data.type === 'soroban:open') openFromUrl(data.url)
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') webCollect?.onVisible()
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
  loadProfitStrip()
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
  mobileMql = window.matchMedia(MOBILE_QUERY)
  onMobileChange(mobileMql)
  mobileMql.addEventListener('change', onMobileChange)
  if (webApi) {
    // 通知から立ち上げたとき：URL の tab（と sale / purchase）で該当の画面を開く。開いたら URL から外す（再読み込みで戻らない）
    if (openFromUrl(window.location.href)) window.history.replaceState(window.history.state, '', window.location.pathname)
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', onSwMessage)
    document.addEventListener('visibilitychange', onVisibilityChange)
    // 積まれている・走っている取り込みがあれば追い始める（無ければ PC の数・クールダウンを読むだけ）
    void webCollect?.start()
  }
})

onUnmounted(() => {
  // Web 版はログアウト／ログインで App を作り直すので、外しておく（Electron 版は作り直さない）
  window.removeEventListener('soroban:error', onSorobanError)
  window.removeEventListener('keydown', onGlobalKeydown)
  mobileMql?.removeEventListener('change', onMobileChange)
  // タブの層が残っていたら外す（作り直した App が、消えた App の「戻る」を引き継がないように）
  const layer = tabLayer
  tabLayer = null
  layer?.release()
  if (webApi) {
    if ('serviceWorker' in navigator) navigator.serviceWorker.removeEventListener('message', onSwMessage)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    webCollect?.stop()
  }
})

// 子側の revision カウンタが動くたびに要対応件数・取り込み状態・利益ピルも更新する
watch(revision, () => { loadStats(); loadProfitStrip() })
watch(dataRevision, loadProfitStrip)
</script>

<template>
  <div class="shell">
    <aside class="nav">
      <div class="brand-mark">
        <span class="brand-mark-badge">そ</span>
        <span class="brand-mark-text">そろばん</span>
      </div>
      <nav class="nav-list">
        <template v-for="t in tabs" :key="t.key">
          <hr v-if="t.key === 'settings'" class="nav-divider" />
          <button
            class="nav-item"
            :class="{ active: tab === t.key }"
            :aria-current="tab === t.key ? 'page' : undefined"
            :title="t.label"
            @click="selectTab(t.key)"
          >
            <Icon :name="t.icon" :size="20" />
            <span class="nav-label">{{ t.label }}</span>
            <span v-if="t.key === 'sales' && needsTotal > 0" class="nav-badge">{{ needsTotal }}</span>
          </button>
        </template>
      </nav>
      <div class="grow" />
      <!-- Web 版だけ：ここにログアウト（v0.1 の代わり。高さは変えない） -->
      <button
        v-if="webAccount"
        class="ghost sm nav-logout"
        :title="webAccount.email ? `ログアウト（${webAccount.email}）` : 'ログアウト'"
        @click="logout"
      >ログアウト</button>
      <div v-else class="nav-version faint">v0.1</div>
    </aside>

    <div class="main-col">
      <header class="topbar" :class="{ 'm-searching': mobileSearch }">
        <div class="grow topbar-spacer" />
        <div ref="searchWrap" class="global-search">
          <SearchBox v-model="searchQuery" :placeholder="isMobile ? 'すべてから探す' : 'すべてから探す（Ctrl+K）'" />
        </div>
        <button class="ghost topbar-search-cancel" @click="closeMobileSearch">キャンセル</button>
        <button class="topbar-profit-btn" :title="isMobile ? profitTitle : 'ホームで詳しく見る'" @click="goto('dashboard')">
          <ProfitStripBar compact :strip="profitStrip" class="profit-full" />
          <!-- スマホ幅だけ：粗利と純利益の 2 つの数字が読める短い文言（取引中・見込みは title とホームで） -->
          <span class="profit-mini profit-short">
            <span class="ps-item">粗利 {{ yen(profitStrip?.gross_profit ?? 0) }}</span>
            <span class="ps-sep">・</span>
            <span class="ps-item">純利益 {{ yen(profitStrip?.net_profit ?? 0) }}</span>
          </span>
        </button>
        <!-- スマホ幅では、要確認のときだけ警告アイコンを出す。押すと「その他」に全文が出る -->
        <span
          class="run-status"
          :class="{ warn: runIsWarn, 'has-short': !!runShort }"
          :title="runStatusText"
          @click="isMobile && (moreOpen = true)"
        >
          <Icon v-if="runIsWarn" name="alert" :size="14" class="run-status-icon" />
          <span class="run-status-text" :data-reserve="runReserve?.text">{{ runStatusText }}</span>
          <!-- Web 版だけ：狭い幅（〜1199px）では全文の代わりに短い文言。スマホ幅では取り込むボタンの左に出る -->
          <span v-if="runShort" class="run-status-short" :data-reserve="runReserve?.short">{{ runShort }}</span>
        </span>
        <button class="ghost topbar-search-btn" aria-label="すべてから探す" @click="openMobileSearch">
          <Icon name="search" :size="20" />
        </button>
        <button class="primary collect-btn" :class="{ busy: collectBusy }" :disabled="collectDisabled" :title="collectTitle" aria-label="取り込む" @click="collect">
          <Icon name="refresh" :size="16" />
          <span class="collect-label">{{ collectLabel }}</span>
        </button>
      </header>

      <!-- 通知・更新バナーは文書フローの外（fixed）に重ねる。出入りで本文の位置がずれないように -->
      <div class="overlay-notices">
        <Transition name="fade">
          <div v-if="showUpdateBanner" class="update-banner">
            <Icon name="refresh" :size="14" />
            <span>新しいバージョン v{{ updateStatus?.latest }} があります</span>
            <button class="sm" :disabled="updateInstalling" @click="installUpdateFromBanner">
              {{ updateStatus?.canAutoInstall ? '再起動して更新' : 'ダウンロード' }}
            </button>
            <button class="ghost sm" @click="dismissUpdateBanner">あとで</button>
          </div>
        </Transition>

        <!-- Web 版だけ：PC が拾うのを待っている間。取り消せる（始まったあとは取り消せない）。
             スマホ幅では下の上のバーの下（文書フロー）に出す。ここに重ねると本文の見出しにかぶる -->
        <Transition name="fade">
          <div v-if="webCollect && webCollect.queued.value && !isMobile" class="collect-banner">
            <Icon name="clock" :size="14" />
            <span class="collect-banner-text">{{ webCollect.queuedText.value }}</span>
            <button class="ghost sm" @click="cancelCollect">取り消す</button>
          </div>
        </Transition>

        <Transition name="fade">
          <div v-if="notice" class="toast" :class="notice.kind">
            <Icon v-if="notice.kind === 'warn'" class="toast-warn-icon" name="alert" :size="14" />
            <span class="toast-text">{{ notice.text }}</span>
            <button v-if="notice.action" class="sm toast-action" @click="onNoticeAction">{{ notice.action.label }}</button>
            <button class="ghost sm" @click="showNotice(null)">閉じる</button>
          </div>
        </Transition>
      </div>

      <!-- Web 版・スマホ幅だけ：PC が拾うのを待っている間のバナー。上のバーの下に流し込む（取り消しは 1 タップのまま） -->
      <Transition name="fade">
        <div v-if="webCollect && webCollect.queued.value && isMobile" class="collect-banner collect-banner-flow">
          <Icon name="clock" :size="14" />
          <span class="collect-banner-text">{{ webCollect.queuedText.value }}</span>
          <button class="ghost sm" @click="cancelCollect">取り消す</button>
        </div>
      </Transition>

      <main ref="mainEl">
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

      <!-- スマホ幅だけ：下のタブバー（デスクトップ幅では display:none） -->
      <nav class="tabbar" aria-label="メニュー">
        <button
          v-for="t in barTabs"
          :key="t.key"
          class="tabbar-item"
          :class="{ active: tab === t.key && !moreOpen }"
          :aria-current="tab === t.key ? 'page' : undefined"
          @click="selectTab(t.key)"
        >
          <Icon :name="t.icon" :size="22" />
          <span class="tabbar-label">{{ t.label }}</span>
          <span v-if="t.key === 'sales' && needsTotal > 0" class="nav-badge tabbar-badge">{{ needsTotal }}</span>
        </button>
        <button
          class="tabbar-item"
          :class="{ active: moreOpen || moreActive }"
          aria-haspopup="dialog"
          :aria-expanded="moreOpen"
          @click="moreOpen = !moreOpen"
        >
          <svg class="tabbar-more-icon" width="22" height="22" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <circle cx="4" cy="10" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="16" cy="10" r="1.6" />
          </svg>
          <span class="tabbar-label">その他</span>
        </button>
      </nav>
    </div>

    <!-- 「その他」のシート（スマホ幅だけ）。タブバーは見えたまま、その上に出す -->
    <Transition name="sheet">
      <div v-if="moreOpen" class="more-layer" @click.self="moreOpen = false">
        <div class="more-sheet" role="dialog" aria-label="その他のメニュー">
          <div class="more-grid">
            <button
              v-for="t in moreTabs"
              :key="t.key"
              class="more-item"
              :class="{ active: tab === t.key }"
              :aria-current="tab === t.key ? 'page' : undefined"
              @click="selectTab(t.key)"
            >
              <Icon :name="t.icon" :size="22" />
              <span>{{ t.label }}</span>
            </button>
          </div>
          <div class="more-foot">
            <p class="more-status" :class="{ warn: runIsWarn }">
              <Icon v-if="runIsWarn" name="alert" :size="14" />
              {{ runStatusText }}
            </p>
            <template v-if="webAccount">
              <p v-if="webAccount.email" class="more-account">{{ webAccount.email }}</p>
              <button class="more-logout" @click="logout">
                <Icon name="login" :size="20" class="flip-x" />
                ログアウト
              </button>
            </template>
          </div>
        </div>
      </div>
    </Transition>

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
/* hover は、マウスのある端末だけ（タッチで触れたあとに色が残らない） */
@media (hover: hover) and (pointer: fine) {
  .nav-item:hover { background: var(--surface-hi); color: var(--text-dim); }
}
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

/* Web 版だけ。v0.1 の代わりに置くので、高さもほぼ同じ */
.nav-logout {
  width: 100%;
  margin: 4px 0;
  padding: 0;
  font-size: var(--fs-11);
  color: var(--text-faint);
}

.flip-x { transform: scaleX(-1); }

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

@media (max-width: 1099px) {
  .global-search :deep(.search-box) { width: 200px; }
  /* 利益ピルは残り幅に合わせて縮め、収まらない分は省く（768px 前後で上のバーが横にはみ出していた） */
  .topbar .topbar-profit-btn { flex-shrink: 1; min-width: 0; }
  .topbar-profit-btn :deep(.profit-strip-bar) { min-width: 0; max-width: 100%; }
}

.topbar-profit-btn {
  flex-shrink: 0;
  background: transparent;
  border: none;
  padding: 0;
  height: auto;
  cursor: pointer;
}

/* スマホ幅だけで出す短い文言（下の @media で出す）。デスクトップ幅では出さない */
.topbar .profit-short { display: none; }

.run-status {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 1 1 auto;
  font-size: var(--fs-13);
  color: var(--text-dim);
}
.run-status.warn { color: var(--warn); }
.run-status-icon { flex-shrink: 0; }
.run-status-text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* --- Web 版だけ（短い文言＝has-short があるとき。デスクトップ版の「最終取り込み：…」には効かない） --- */
.run-status-short { display: none; }
.run-status.has-short { font-variant-numeric: tabular-nums; }
/* カウントダウン中は、数え下げで桁が変わっても欄の幅が動かないよう、いちばん長い文字列（data-reserve）を
   見えない行として足して幅だけ確保する。動かすと隣の検索欄・利益ピルが数 px ずれる */
.run-status-text[data-reserve]::after,
.run-status-short[data-reserve]::after {
  content: attr(data-reserve);
  display: block;
  height: 0;
  overflow: hidden;
  visibility: hidden;
}
/* 1200px 未満（768〜1199px）の上のバーでは全文が入りきらず「あと 1分2…」と切れるので、短い文言に替える */
@media (max-width: 1199px) {
  .run-status.has-short .run-status-text { display: none; }
  .run-status.has-short .run-status-short {
    display: block;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}
/* 1100px 未満は利益ピルが縮んで空きを作る。短い文言は縮めず、ピルのほうを省く */
@media (max-width: 1099px) {
  .run-status.has-short { flex-shrink: 0; }
}

.topbar button {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

main {
  flex: 1;
  overflow-y: auto;
  background: var(--canvas);
}

/* スマホ幅だけで使う部品。デスクトップ幅（768px 以上）では出さない（下の @media で出す） */
.tabbar,
.more-layer { display: none; }
.topbar .topbar-search-btn,
.topbar .topbar-search-cancel { display: none; }

/* --- 通知・更新バナー（重ねて表示。文書フローに入れず、本文の位置を動かさない） --- */

.overlay-notices {
  position: fixed;
  top: calc(var(--topbar-h) + 12px);
  right: 24px;
  z-index: 110; /* ドロワー・「その他」・検索の幕（100 / 60 / 62）より上。シートを開いたままでも通知が見える（確認ダイアログ 110 とは同じ層で、あとから描かれるダイアログが上） */
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-width: 560px;
  pointer-events: none;
}
.overlay-notices > * { pointer-events: auto; }

.update-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: var(--radius-md);
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-size: var(--fs-13);
  box-shadow: var(--shadow-2);
}
.update-banner button { margin-left: 0; }
.update-banner button:last-child { margin-left: auto; }

/* Web 版だけ：取り込みが PC に拾われるのを待っているとき。更新バナーと同じ面（重ねて出し、本文の位置を動かさない） */
.collect-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: var(--radius-md);
  background: var(--brand-soft);
  color: var(--brand-ink);
  font-size: var(--fs-13);
  box-shadow: var(--shadow-2);
}
.collect-banner svg { flex-shrink: 0; }
.collect-banner-text { min-width: 0; overflow-wrap: anywhere; }
.collect-banner button { margin-left: auto; flex-shrink: 0; }

/* 上書き：style.css の .toast は本文中の sticky 前提。ここでは重ねて出すので fixed 相当に */
.toast {
  position: static;
  margin-left: 0;
  box-shadow: var(--shadow-2);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--dur) var(--ease);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@keyframes topbar-spin {
  to { transform: rotate(360deg); }
}

/* --- スマホ幅（768px 未満）の外枠 ---
   サイドナビをやめて下のタブバー、上のバーは詰める。デスクトップ幅の見た目には一切効かせない。
   各画面の中身（表・カード）は画面ごとに直す。ここは外枠だけ。
   env(safe-area-inset-*) はノッチ・ホームバーに被らないための余白（iPhone） */

@media (max-width: 767px) {
  .shell {
    height: 100%;
    height: 100dvh; /* アドレスバーが出入りしても、下のタブバーが画面の外に出ない */
  }
  .nav { display: none; }

  .topbar {
    height: auto;
    min-height: calc(var(--topbar-h) + env(safe-area-inset-top));
    padding: env(safe-area-inset-top) max(12px, env(safe-area-inset-right)) 0 max(12px, env(safe-area-inset-left));
    gap: 8px;
  }
  .topbar-spacer { display: none; }

  /* 検索：普段は虫めがね。押すと入力欄が上のバー全体に広がる（タップ数は増えない：虫めがね→そのまま入力） */
  .global-search { display: none; flex: 1 1 auto; min-width: 0; }
  .global-search :deep(.search-box) { width: 100%; }
  .global-search :deep(.search-box-input) { height: 44px; }
  .topbar.m-searching .global-search { display: block; }
  .topbar .topbar-search-btn { display: inline-flex; justify-content: center; width: 44px; height: 44px; padding: 0; }
  .topbar.m-searching .topbar-search-cancel { display: inline-flex; min-height: 44px; }

  /* 利益ピル：残り幅いっぱいに広げ、1 行に収まらない分は省く（全文は title） */
  .topbar .topbar-profit-btn { display: flex; flex: 1 1 0; justify-content: flex-start; min-width: 0; min-height: 44px; text-align: left; }
  .topbar-profit-btn :deep(.profit-strip-bar) { min-width: 0; max-width: 100%; }
  /* 全文（今月の実績粗利 … ／ 純利益 … ＋ 取引中・見込み）は 375px で切れて純利益が読めないので、短い文言に差し替える。
     400px 以上は 1 行、それより狭いときは下の @media で 2 段 */
  .topbar-profit-btn .profit-full { display: none; }
  .topbar .profit-short {
    display: flex;
    align-items: center;
    gap: 0 6px;
    min-width: 0;
    max-width: 100%;
  }
  .profit-short .ps-item { white-space: nowrap; }
  /* 桁が増えて入りきらないときは、後ろの数字を … で省く（前の数字は残す） */
  .profit-short .ps-item:last-child { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }

  /* 取り込み状態：要確認のときだけ警告アイコン（押すと「その他」に全文が出る） */
  .run-status { flex: 0 0 auto; }
  .run-status:not(.warn) { display: none; }
  .run-status.warn { justify-content: center; min-width: 44px; min-height: 44px; cursor: pointer; }
  .run-status-text { display: none; }
  /* Web 版：取り込み中・クールダウン中は短い文言（「取り込み中」「あと 52 秒」）を取り込むボタンのすぐ左に出す。
     警告のとき（PC が動いていない）はこれまでどおりアイコンだけ。どちらも押すと「その他」に全文が出る */
  .run-status.has-short:not(.warn) { display: flex; min-height: 44px; cursor: pointer; order: 1; }
  .run-status.has-short:not(.warn) .run-status-short { font-size: var(--fs-12); text-align: right; }
  .run-status.warn .run-status-short { display: none; }

  /* 取り込む：アイコンだけ。取り込み中は回す（order は、短い文言をこのボタンのすぐ左に並べるため） */
  .topbar .collect-btn { justify-content: center; width: 44px; height: 44px; padding: 0; order: 2; }
  .collect-btn :deep(svg) { width: 20px; height: 20px; }
  .collect-label { display: none; }
  .collect-btn.busy :deep(svg) { animation: topbar-spin 1s linear infinite; }

  /* 検索中は他を隠して、入力欄を広く取る */
  .topbar.m-searching .topbar-profit-btn,
  .topbar.m-searching .run-status,
  .topbar.m-searching .topbar-search-btn,
  .topbar.m-searching .collect-btn { display: none; }

  main {
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
  }

  /* 通知は上のバーの下、左右いっぱいに */
  .overlay-notices {
    top: calc(var(--topbar-h) + env(safe-area-inset-top) + 8px);
    left: max(12px, env(safe-area-inset-left));
    right: max(12px, env(safe-area-inset-right));
    align-items: stretch;
    max-width: none;
  }
  .toast { border-radius: var(--radius-md); padding: 6px 8px 6px 16px; }
  .toast button { min-height: 40px; } /* 親指で押せる高さ（通知の中の「元に戻す」「閉じる」） */
  .collect-banner button { min-height: 44px; }
  /* 待ちのバナーは上のバーの下に流し込む（本文を少し押し下げる。取り消しはそのまま 1 タップ） */
  .collect-banner-flow {
    flex-shrink: 0;
    margin: 0 max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left));
    box-shadow: none;
  }

  /* 下のタブバー */
  .tabbar {
    position: relative;
    z-index: 61; /* 「その他」のシートの幕（60）より上。シートが開いても見えたまま */
    display: flex;
    flex-shrink: 0;
    padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    background: var(--surface-nav);
    border-top: 1px solid var(--line-soft);
  }
  .tabbar-item {
    position: relative;
    flex: 1 1 0;
    min-width: 0;
    height: var(--tabbar-h);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 0 2px;
    background: transparent;
    border: none;
    border-radius: 0;
    color: var(--text-faint);
    font-size: var(--fs-11);
    white-space: nowrap;
  }
  @media (hover: hover) and (pointer: fine) {
    .tabbar-item:hover:not(:disabled) { background: transparent; }
  }
  .tabbar-item.active { color: var(--text); font-weight: 700; box-shadow: inset 0 3px 0 var(--brand); }
  .tabbar-badge { position: absolute; top: 4px; left: calc(50% + 6px); }

  /* 「その他」のシート：タブバーの上に出す */
  .more-layer {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(38, 38, 42, .32);
  }
  .more-sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 1px);
    padding: 12px max(12px, env(safe-area-inset-right)) 12px max(12px, env(safe-area-inset-left));
    background: var(--surface);
    border-radius: var(--radius) var(--radius) 0 0;
    box-shadow: var(--shadow-2);
  }
  .more-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
  }
  .more-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-height: 72px;
    padding: 8px 4px;
    background: transparent;
    border-radius: var(--radius-md);
    color: var(--text-dim);
    font-size: var(--fs-12);
  }
  @media (hover: hover) and (pointer: fine) {
    .more-item:hover:not(:disabled) { background: transparent; }
  }
  .more-item.active { background: var(--brand-soft); color: var(--text); font-weight: 700; }
  .more-foot {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--line-soft);
  }
  .more-status {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0 4px 4px;
    font-size: var(--fs-12);
    color: var(--text-dim);
    overflow-wrap: anywhere;
  }
  .more-status.warn { color: var(--warn); }
  .more-account {
    margin: 0 4px 8px;
    font-size: var(--fs-12);
    color: var(--text-faint);
    overflow-wrap: anywhere;
  }
  .more-logout {
    width: 100%;
    min-height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
}

/* 400px 未満（375・390・320）：警告アイコンが出ている間は 1 行に 2 つの数字が入りきらないので、2 段にする（どちらも省かない） */
@media (max-width: 399px) {
  .topbar .profit-short {
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
    padding: 3px 12px;
    border-radius: var(--radius-md);
    line-height: 1.35;
  }
  .profit-short .ps-sep { display: none; }
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity var(--dur) var(--ease);
}
.sheet-enter-active .more-sheet,
.sheet-leave-active .more-sheet {
  transition: transform var(--dur) var(--ease);
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
.sheet-enter-from .more-sheet,
.sheet-leave-to .more-sheet {
  transform: translateY(24px);
}

@media (prefers-reduced-motion: reduce) {
  .fade-enter-active,
  .fade-leave-active,
  .sheet-enter-active,
  .sheet-leave-active,
  .sheet-enter-active .more-sheet,
  .sheet-leave-active .more-sheet {
    transition: none;
  }
}
</style>
