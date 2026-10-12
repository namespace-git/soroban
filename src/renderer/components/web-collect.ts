// Web 版の「取り込む」ボタンの状態（App.vue が使う）。
//
// デスクトップ版は押すとその場で取り込む（collect()）。Web 版は取り込み担当の PC に頼む：
//   押す → requestCollect（積む） → PC が拾う（running） → 終わる（done / partial / failed）
// 積まれた・走っている間（queued・running）だけ、数秒ごとに getCollectStatus を読む。終わったら止める。
// 画面が裏に回っている間は読まない（戻ってきたとき 1 回読み直す）。
import { computed, ref } from 'vue'
import type { CollectorRun } from '../../shared/types'
import type { CollectJob, CollectStatus, WebApi } from '../../shared/web-types'

/** 走っている間に状態を読み直す間隔 */
export const COLLECT_POLL_MS = 4000

export function isActiveJob(job: CollectJob | null | undefined): boolean {
  return !!job && (job.status === 'queued' || job.status === 'running')
}

/** 「45秒」「2分」「1分30秒」 */
export function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r === 0 ? `${m}分` : `${m}分${r}秒`
}

export interface JobNotice {
  text: string
  kind: 'ok' | 'warn'
}

/**
 * 終わった要求を、デスクトップの collect() の結果（CollectorRun[]）と同じ見せ方の 1 文にする。
 * `runLine` は 1 件ぶんの文（App.vue の「対象: 新規 3件（取得 20件）」）。
 * 途中で止まったとき（partial）は、終わった段の分は入っていて、次の取り込みで続きを取ることを言う
 */
export function describeJob(job: CollectJob, runLine: (run: CollectorRun) => string): JobNotice {
  const runs = job.runs ?? []
  const lines = runs.map(runLine)
  if (job.status === 'cancelled') {
    return { text: job.message ?? '取り込みは取り消されました', kind: 'warn' }
  }
  if (job.status === 'failed') {
    return { text: [job.message ?? '取り込みに失敗しました', ...lines].join('／'), kind: 'warn' }
  }
  if (job.status === 'partial') {
    const head = `途中で止まりました。次の取り込みで続きを取ります${job.message ? `（${job.message}）` : ''}`
    return { text: [head, ...lines].join('／'), kind: 'warn' }
  }
  if (lines.length === 0) return { text: job.message ?? '取り込みが終わりました', kind: 'ok' }
  return { text: lines.join('／'), kind: runs.every(r => r.status === 'ok') ? 'ok' : 'warn' }
}

export interface WebCollectDeps {
  api: Pick<WebApi, 'requestCollect' | 'getCollectStatus' | 'cancelCollectJob'>
  /** 走っていた要求が終わったのを見たとき（積まれた・走っていた要求を見ていたときだけ） */
  onFinished(job: CollectJob): void
  /** 画面が見えているか。裏に回っている間は読まない */
  isVisible?: () => boolean
  pollMs?: number
}

export function useWebCollect(deps: WebCollectDeps) {
  const pollMs = deps.pollMs ?? COLLECT_POLL_MS
  const visible = deps.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden')

  const status = ref<CollectStatus | null>(null)
  const requesting = ref(false)
  // クールダウンの残りは、読んだ時刻から数える（1 秒ごとの再読み込みはしない）
  const now = ref(Date.now())
  const cooldownUntil = ref(0)

  let started = false
  // 積まれた・走っていると見ていた要求の id。終わったのを見たら onFinished を呼ぶ
  let watching: string | null = null
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let tickTimer: ReturnType<typeof setTimeout> | undefined

  const job = computed(() => status.value?.job ?? null)
  const active = computed(() => requesting.value || isActiveJob(job.value))
  const queued = computed(() => job.value?.status === 'queued')
  const running = computed(() => job.value?.status === 'running')
  const agentsOffline = computed(() => status.value !== null && status.value.agents_online === 0)
  const cooldown = computed(() => Math.max(0, Math.ceil((cooldownUntil.value - now.value) / 1000)))

  /** 積まれたあいだ、ボタンの下に出す文 */
  const queuedText = computed(() =>
    agentsOffline.value
      ? 'PC が拾うのを待っています（取り込み担当の PC が動いていません）'
      : 'PC が拾うのを待っています',
  )

  /**
   * 上のバーの取り込み状態の欄に出す文（無ければ null = 今までの「最終取り込み：…」）。
   * 走っている間 → 押す前から分かるべき「PC が動いていない」→ クールダウンの順
   */
  const statusLine = computed<{ text: string; warn: boolean } | null>(() => {
    if (running.value) return { text: `取り込み中（${job.value?.agent_name ?? 'PC'}）`, warn: false }
    if (queued.value || requesting.value) return null
    if (agentsOffline.value) return { text: '取り込み担当の PC が動いていません', warn: true }
    if (cooldown.value > 0) return { text: `あと ${formatRemaining(cooldown.value)} で取り込めます`, warn: false }
    return null
  })

  function tick() {
    clearTimeout(tickTimer)
    tickTimer = undefined
    now.value = Date.now()
    if (started && visible() && cooldownUntil.value > now.value) tickTimer = setTimeout(tick, 1000)
  }

  function schedule() {
    clearTimeout(pollTimer)
    pollTimer = undefined
    if (!started || !visible() || !isActiveJob(job.value)) return
    pollTimer = setTimeout(() => {
      pollTimer = undefined
      if (started && visible()) void refresh()
    }, pollMs)
  }

  function apply(s: CollectStatus) {
    status.value = s
    cooldownUntil.value = s.cooldown_seconds > 0 ? Date.now() + s.cooldown_seconds * 1000 : 0
    tick()
    const j = s.job
    if (j && isActiveJob(j)) {
      watching = j.id
    } else if (watching !== null) {
      watching = null
      if (j) deps.onFinished(j)
    }
    schedule()
  }

  async function refresh(): Promise<void> {
    try {
      apply(await deps.api.getCollectStatus())
    } catch {
      // 通信が一瞬切れても、走っている間は次の周期でまた読む（ここで画面を止めない）
      schedule()
    }
  }

  /** 画面を開いたとき。いま積まれている・走っている要求があれば、それを追い始める */
  async function start(): Promise<void> {
    started = true
    await refresh()
  }

  function stop() {
    started = false
    clearTimeout(pollTimer)
    clearTimeout(tickTimer)
    pollTimer = undefined
    tickTimer = undefined
  }

  /** 画面が見える状態に戻った。裏にいた間に進んだ分を 1 回読み直す */
  function onVisible() {
    if (started) void refresh()
  }

  /** 「取り込む」を押した。走っている・クールダウン中ならサーバーが日本語のエラーを返すので、そのまま投げる */
  async function request(): Promise<void> {
    if (requesting.value) return
    requesting.value = true
    try {
      const j = await deps.api.requestCollect()
      watching = j.id
      // まだ読んでいない PC の数は「動いていない」と決めつけない
      status.value = { job: j, agents_online: status.value?.agents_online ?? 1, cooldown_seconds: 0 }
      cooldownUntil.value = 0
      tick()
      schedule()
    } catch (e) {
      // 既に走っている・クールダウン中など。その状態を画面に出してから、エラーを投げる
      await refresh()
      throw e
    } finally {
      requesting.value = false
    }
  }

  /** 始まる前（queued）の要求を取り消す。始まっていたらサーバーが日本語のエラーを返す */
  async function cancel(): Promise<void> {
    const j = job.value
    if (!j || j.status !== 'queued') return
    try {
      await deps.api.cancelCollectJob(j.id)
      watching = null
    } finally {
      await refresh()
    }
  }

  return { status, job, active, queued, running, agentsOffline, cooldown, queuedText, statusLine, start, stop, onVisible, refresh, request, cancel }
}
