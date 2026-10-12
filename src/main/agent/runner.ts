import type { AgentClaim, AgentLease } from '../../shared/agent-types'
import type { CollectStatus } from '../../shared/web-types'
import type { AgentSessionInput } from '../../preload/agent-bridge'
import { createRemoteStore } from '../store/remote'
import { runCollectJob, type CollectJobResult, type JobCollectors } from './collect-job'
import { AgentHttpError, LeaseLostError, errorText } from './errors'
import { JobGuard } from './guard'
import type { AgentHttp } from './http'
import type { MediaCredentials, MediaUploader } from './media'

// ============================================================
// 取り込み担当の動き（Web 版の取り込みを、この PC が受け持つ）
//
//   ログイン（トークン）が来る ── register(端末名)＝人の JWT ──▶ 取り込み担当の鍵（12 時間・**メモリだけ**）
//        └ 起動後の最初の 1 回だけ requestCollect（間隔が空いていれば。エラーは黙って無視）
//   20 秒ごとに claim ──▶ 取れたら：60 秒ごとに heartbeat ／ リモートの store で
//        メルカリ → Yahoo!フリマ → メロジョイ（計画の仕入先ごと）を直列に収集 ／ 終わったら finish
//   鍵の期限の 30 分前に、そのときのトークンで register し直す（取り込み中は終わるまで待つ。残り 5 分を切ったら待たない）
//   トークンが消える（ログアウト）＝鍵を捨てて止まる。lease_lost＝直ちに止まる（finish も呼ばない）
//
// 持つもの（すべてメモリ）：トークン・鍵・lease_token。ファイル・DB・ログに書かない（ログに出すのは job の id と状態だけ）。
// claim のポーリングは収集ではない（メルカリなどへのアクセスは増えない）。収集の頻度・待ち時間・CAPTCHA は収集のコードのまま。
// ============================================================

export type AgentState = 'waiting-login' | 'registering' | 'idle' | 'running' | 'revoked' | 'error'

export interface AgentStatus {
  state: AgentState
  /** 人に見せてよい日本語の補足 */
  message: string | null
}

export interface RunnerDeps {
  deviceName: string
  http: AgentHttp
  /** 画像を Storage に上げる道具。世帯の id と、今の資格（人の JWT・anon キー）を使う */
  createMedia(opts: { householdId: string; credentials: () => MediaCredentials | null }): MediaUploader
  collectors: JobCollectors
  /** 操作ログ（applog）。鍵・トークン・lease_token は渡さない */
  log(kind: string, message: string, payload?: Record<string, unknown>): void
  onStatus?(status: AgentStatus): void
  /** 鍵を出してもらえたとき（仕入先の一覧をメニューに出すなど） */
  onRegistered?(): void
  onJobFinished?(): void
  pollIntervalMs?: number
  heartbeatIntervalMs?: number
  /** 鍵の期限のこれだけ前に取り直す（既定 30 分） */
  keyRefreshMarginMs?: number
}

const POLL_MS = 20_000
const HEARTBEAT_MS = 60_000
const KEY_REFRESH_MARGIN_MS = 30 * 60_000
/** 取り込み中は鍵の取り直しを待つ。ただし期限までこれを切ったら待たない */
const REFRESH_DEFER_UNTIL_MS = 5 * 60_000
const REGISTER_RETRY_MS = 60_000
const MAX_TIMER_MS = 2 ** 31 - 1

interface Registration {
  key: string
  agentId: string
  householdId: string
  expiresAtMs: number
}

interface ActiveJob {
  guard: JobGuard
  lease: AgentLease
  heartbeat: ReturnType<typeof setInterval>
  beating: boolean
}

type Timer = ReturnType<typeof setTimeout>

/**
 * 起動時の「取り込みを頼むか」。すでに積まれている・走っている／クールダウン中／直近に取り込めている（ok の実行記録が
 * 間隔の中にある）なら頼まない。デスクトップの「起動時に、前回から間隔が空いていれば取り込む」と同じ約束（収集頻度を上げない）
 */
export function shouldSkipStartupRequest(status: CollectStatus, intervalH: number, nowMs: number): boolean {
  const job = status.job
  if (job && (job.status === 'queued' || job.status === 'running')) return true
  if (status.cooldown_seconds > 0) return true
  const okTimes = (job?.runs ?? [])
    .filter(r => r.status === 'ok')
    .map(r => Date.parse(r.finished_at ?? ''))
    .filter(t => Number.isFinite(t))
  if (okTimes.length === 0) return false
  return nowMs - Math.max(...okTimes) < intervalH * 3_600_000
}

export class AgentRunner {
  private readonly pollMs: number
  private readonly heartbeatMs: number
  private readonly refreshMarginMs: number

  private session: AgentSessionInput | null = null
  private reg: Registration | null = null
  private disposed = false
  private registering: Promise<void> | null = null
  private pollTimer: Timer | null = null
  private refreshTimer: Timer | null = null
  private retryTimer: Timer | null = null
  private job: ActiveJob | null = null
  private polling = false
  private startupDone = false
  private lastPollError: string | null = null
  private status: AgentStatus = { state: 'waiting-login', message: null }

  constructor(private readonly deps: RunnerDeps) {
    this.pollMs = deps.pollIntervalMs ?? POLL_MS
    this.heartbeatMs = deps.heartbeatIntervalMs ?? HEARTBEAT_MS
    this.refreshMarginMs = deps.keyRefreshMarginMs ?? KEY_REFRESH_MARGIN_MS
  }

  // ---- 外から ----

  /** Web 版のログインが来た（トークンが更新されるたびに来る）。メモリに置き換えるだけ */
  setSession(next: AgentSessionInput): void {
    if (this.disposed) return
    this.session = next
    if (!this.reg) {
      void this.register()
    } else if (this.reg.expiresAtMs - Date.now() <= this.refreshMarginMs) {
      void this.refreshKey()
    }
  }

  /** ログアウト。鍵を捨てて止まる（走っている取り込みは lease を手放す＝サーバーが時間切れで片付ける） */
  clearSession(): void {
    if (this.disposed) return
    this.session = null
    this.dropRegistration()
    this.job?.guard.stop()
    this.setStatus('waiting-login', null)
  }

  /** この PC のモードを抜ける・アプリを閉じる。二度と動かない */
  dispose(): void {
    if (this.disposed) return
    this.session = null
    this.dropRegistration()
    this.job?.guard.stop()
    this.disposed = true
  }

  getStatus(): AgentStatus {
    return this.status
  }

  /** 画面の API（人の JWT）を 1 回呼ぶ（仕入先の一覧をメニューに出すなど）。ログインが届いていなければ null */
  async callRpc<T>(method: string, args: unknown[] = []): Promise<T | null> {
    const jwt = this.session?.accessToken
    if (!jwt || this.disposed) return null
    return await this.deps.http.rpc<T>(method, args, jwt, { retry: false })
  }

  // ---- 状態 ----

  private setStatus(state: AgentState, message: string | null = null): void {
    if (this.status.state === state && this.status.message === message) return
    this.status = { state, message }
    this.deps.onStatus?.(this.status)
  }

  private log(kind: string, message: string, payload?: Record<string, unknown>): void {
    this.deps.log(kind, message, payload)
  }

  private clearTimers(): void {
    for (const t of [this.pollTimer, this.refreshTimer, this.retryTimer]) if (t) clearTimeout(t)
    this.pollTimer = null
    this.refreshTimer = null
    this.retryTimer = null
  }

  /** 鍵を捨てる（メモリから消す）。ポーリング・取り直しも止める */
  private dropRegistration(): void {
    this.reg = null
    this.clearTimers()
  }

  private credentials(): MediaCredentials | null {
    const s = this.session
    return s ? { accessToken: s.accessToken, supabaseUrl: s.supabaseUrl, anonKey: s.anonKey } : null
  }

  // ---- 鍵（register） ----

  private register(): Promise<void> {
    if (!this.registering) {
      this.registering = this.doRegister().finally(() => { this.registering = null })
    }
    return this.registering
  }

  private async doRegister(): Promise<void> {
    const session = this.session
    if (!session || this.disposed) return
    const first = !this.reg
    // 人の JWT が切れていれば、画面が更新して新しいトークンを渡してくるのを待つ（そのとき setSession から呼び直される）
    if (session.expiresAt * 1000 <= Date.now() + 5_000) {
      if (first) this.setStatus('waiting-login', 'Web 版のログインの更新を待っています')
      return
    }
    if (first) this.setStatus('registering', null)

    try {
      const r = await this.deps.http.register(this.deps.deviceName, session.accessToken)
      if (this.disposed || !this.session) return // 待っている間にログアウトした：鍵は持たない
      this.reg = {
        key: r.token,
        agentId: r.agent_id,
        householdId: r.household_id.toLowerCase(),
        expiresAtMs: Date.parse(r.expires_at),
      }
      this.lastPollError = null
      this.log('agent_registered', `取り込み担当の鍵を受け取りました（${r.name}）`, { agent_id: r.agent_id, expires_at: r.expires_at })
      this.scheduleRefresh()
      if (!this.job) this.setStatus('idle', null)
      this.deps.onRegistered?.()
      if (first) {
        await this.requestCollectAtStartup()
        if (this.disposed || !this.reg) return
        this.schedulePoll(0)
      }
    } catch (e) {
      this.onRegisterFailed(e, first)
    }
  }

  private onRegisterFailed(e: unknown, first: boolean): void {
    const message = errorText(e)
    this.log('agent_register_failed', message)
    if (e instanceof AgentHttpError && !e.retryable) {
      // 直さないかぎり同じ結果：新しいログインが来るまで待つ
      if (!first) return
      if (e.code === 'conflict') this.setStatus('revoked', message)
      else if (e.code === 'unauthorized' || e.code === 'forbidden') this.setStatus('waiting-login', 'Web 版にログインしてください')
      else this.setStatus('error', message)
      return
    }
    // 通信切れ・5xx：少し待ってもう一度（鍵が切れるまでは古い鍵で続ける）
    if (first) this.setStatus('error', message)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.register() }, REGISTER_RETRY_MS)
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    if (!this.reg) return
    const delay = Math.max(0, this.reg.expiresAtMs - this.refreshMarginMs - Date.now())
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; void this.refreshKey() }, Math.min(delay, MAX_TIMER_MS))
  }

  /** 期限の前に、そのときのトークンで鍵を取り直す（古い鍵はその場で使えなくなる） */
  private async refreshKey(): Promise<void> {
    const reg = this.reg
    if (!reg || !this.session || this.disposed) return
    if (this.job && reg.expiresAtMs - Date.now() > REFRESH_DEFER_UNTIL_MS) {
      // 取り込み中に鍵を替えると、通信中の呼び出しが 401 になる。終わるまで待つ（待ちの予約は 1 本だけ）
      if (this.refreshTimer) clearTimeout(this.refreshTimer)
      this.refreshTimer = setTimeout(() => { this.refreshTimer = null; void this.refreshKey() }, REGISTER_RETRY_MS)
      return
    }
    await this.register()
  }

  // ---- 起動時の取り込み ----

  /**
   * 起動後の最初の 1 回だけ、取り込みを頼んでみる。クールダウン・取り込み中などのエラーは黙って無視する
   * （claim が拾うので、頼めなくても困らない）。間隔の判定は shouldSkipStartupRequest
   */
  private async requestCollectAtStartup(): Promise<void> {
    if (this.startupDone) return
    this.startupDone = true
    const jwt = this.session?.accessToken
    if (!jwt) return
    try {
      let intervalH = 1
      try {
        const settings = await this.deps.http.rpc<Record<string, string> | null>('getSettings', [], jwt, { retry: false })
        const n = Number(settings?.collect_interval_h ?? 1)
        if (Number.isFinite(n) && n >= 0) intervalH = n
      } catch {
        // 読めなければ既定の 1 時間
      }
      try {
        const status = await this.deps.http.rpc<CollectStatus>('getCollectStatus', [], jwt, { retry: false })
        if (shouldSkipStartupRequest(status, intervalH, Date.now())) return
      } catch {
        // 読めなければ、頼んでみる（断られたら黙って無視）
      }
      await this.deps.http.rpc('requestCollect', [], jwt, { retry: false })
      this.log('startup_request', '起動時の取り込みを頼みました')
    } catch (e) {
      this.log('startup_request_skipped', `起動時の取り込みは頼めませんでした：${errorText(e)}`)
    }
  }

  // ---- claim ----

  private schedulePoll(delayMs: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    if (this.disposed || !this.reg || this.job) return
    this.pollTimer = setTimeout(() => { this.pollTimer = null; void this.poll() }, delayMs)
  }

  private async poll(): Promise<void> {
    const reg = this.reg
    if (!reg || this.job || this.polling || this.disposed) return
    this.polling = true
    try {
      const claim = await this.deps.http.agent<AgentClaim | null>('claim', [], reg.key, { retry: false })
      this.lastPollError = null
      if (claim && this.reg && !this.disposed) {
        await this.runJob(claim)
      }
    } catch (e) {
      if (e instanceof AgentHttpError && e.code === 'unauthorized') {
        // 鍵が使えない（期限切れ・別の鍵に替わった・取り消された）。捨てて、いまのトークンで取り直す
        this.log('agent_key_rejected', '取り込み担当の鍵が使えなくなりました。取り直します')
        this.dropRegistration()
        void this.register()
        return
      }
      const message = errorText(e)
      if (message !== this.lastPollError) {
        this.lastPollError = message
        this.log('claim_failed', message)
      }
    } finally {
      this.polling = false
    }
    this.schedulePoll(this.pollMs)
  }

  // ---- 取り込み 1 回 ----

  private async readSilent(): Promise<boolean> {
    const jwt = this.session?.accessToken
    if (!jwt) return true
    try {
      const settings = await this.deps.http.rpc<Record<string, string> | null>('getSettings', [], jwt, { retry: false })
      return settings?.collect_show_window !== '1'
    } catch {
      return true
    }
  }

  private async runJob(claim: AgentClaim): Promise<void> {
    const reg = this.reg
    if (!reg) return
    const guard = new JobGuard()
    const lease: AgentLease = { job_id: claim.job_id, lease_token: claim.lease_token }
    const active: ActiveJob = {
      guard, lease, beating: false,
      heartbeat: setInterval(() => { void this.beat(active) }, this.heartbeatMs),
    }
    this.job = active
    this.setStatus('running', null)
    this.log('job_start', '取り込みを始めます', { job_id: lease.job_id })

    try {
      const silent = await this.readSilent()
      const store = createRemoteStore({
        http: this.deps.http,
        getKey: () => this.reg?.key ?? null,
        lease,
        guard,
        media: this.deps.createMedia({ householdId: reg.householdId, credentials: () => this.credentials() }),
      })
      const outcome = await runCollectJob({ store, guard, silent, collectors: this.deps.collectors, log: this.deps.log })
      clearInterval(active.heartbeat)
      if (guard.lost) {
        this.log('job_lease_lost', '取り込みの権限を失ったので止めました', { job_id: lease.job_id })
      } else if (guard.stopped) {
        this.log('job_stopped', 'ログアウトなどで取り込みを止めました', { job_id: lease.job_id })
      } else {
        await this.finish(active, outcome)
      }
    } catch (e) {
      this.log('job_error', `取り込みが想定外の理由で止まりました：${errorText(e)}`, { job_id: lease.job_id })
    } finally {
      clearInterval(active.heartbeat)
      this.job = null
      this.setStatus(this.reg ? 'idle' : 'waiting-login', null)
      this.deps.onJobFinished?.()
    }
  }

  private async finish(active: ActiveJob, outcome: CollectJobResult): Promise<void> {
    const key = this.reg?.key
    if (!key) return
    try {
      await this.deps.http.agent('finish', [active.lease, {
        status: outcome.status, run_ids: outcome.runIds, message: outcome.message,
      }], key)
      this.log('job_finish', `取り込みを終えました（${outcome.status}）`, { job_id: active.lease.job_id, runs: outcome.runIds.length })
    } catch (e) {
      if (e instanceof LeaseLostError) active.guard.loseLease()
      this.log('job_finish_failed', errorText(e), { job_id: active.lease.job_id })
    }
  }

  /** 60 秒ごと。lease を延ばす。lease_lost なら直ちに止める */
  private async beat(active: ActiveJob): Promise<void> {
    const key = this.reg?.key
    if (active.beating || active.guard.tripped || !key) return
    active.beating = true
    try {
      await this.deps.http.agent('heartbeat', [active.lease], key, { retry: false })
    } catch (e) {
      if (e instanceof LeaseLostError) {
        active.guard.loseLease()
        clearInterval(active.heartbeat)
        this.log('heartbeat_lease_lost', '取り込みの権限が失効しました。取り込みを止めます', { job_id: active.lease.job_id })
      } else {
        this.log('heartbeat_failed', errorText(e), { job_id: active.lease.job_id })
      }
    } finally {
      active.beating = false
    }
  }
}
