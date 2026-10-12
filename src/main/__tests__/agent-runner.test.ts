import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentClaim, AgentRegistration, AgentRunInput } from '../../shared/agent-types'
import type { CollectorRun, CollectorSource } from '../../shared/types'
import type { CollectStatus } from '../../shared/web-types'
import type { AgentSessionInput } from '../../preload/agent-bridge'
import { AgentHttpError, LeaseLostError } from '../agent/errors'
import type { AgentHttp, CallOptions } from '../agent/http'
import type { MediaCredentials } from '../agent/media'
import { AgentRunner, shouldSkipStartupRequest, type AgentStatus, type RunnerDeps } from '../agent/runner'
import type { CollectorStore } from '../store/types'

// 取り込み担当の動き（偽の時計・偽のサーバー・偽の収集）：
// 20 秒ごとの claim・60 秒ごとの heartbeat・lease_lost で止まる・finish の状態・期限 30 分前の取り直し・
// トークンが消えたら止まる・起動時の requestCollect（エラーは無視）。メルカリなどには通信しない

const HOUSEHOLD = '33333333-3333-4333-8333-333333333333'
const HOUR = 3_600_000
const MIN = 60_000
const T0 = new Date('2026-10-12T00:00:00.000Z')

const nowSec = (): number => Math.floor(Date.now() / 1000)
const session = (over: Partial<AgentSessionInput> = {}): AgentSessionInput => ({
  accessToken: `jwt-${'a'.repeat(40)}`,
  expiresAt: nowSec() + 3600,
  supabaseUrl: 'https://abcd.supabase.co',
  anonKey: `anon-${'k'.repeat(40)}`,
  ...over,
})

interface Call { kind: 'agent' | 'register' | 'rpc'; method: string; args: unknown[]; auth: string; opts?: CallOptions }

type AgentHandler = (args: unknown[], key: string) => unknown | Promise<unknown>

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function harness(over: {
  agent?: Record<string, AgentHandler>
  rpc?: Record<string, (args: unknown[], jwt: string) => unknown | Promise<unknown>>
  register?: (name: string, jwt: string, n: number) => AgentRegistration | Promise<AgentRegistration>
  collectors?: Partial<RunnerDeps['collectors']>
  shopAccounts?: Array<{ id: string; name: string }>
} = {}) {
  const calls: Call[] = []
  const statuses: AgentStatus[] = []
  const logs: Array<{ kind: string; message: string; payload?: Record<string, unknown> }> = []
  const keys: string[] = []
  let registerCount = 0
  let runSeq = 0

  const defaultAgent: Record<string, AgentHandler> = {
    claim: () => null,
    heartbeat: () => ({ lease_expires_at: new Date(Date.now() + 3 * MIN).toISOString() }),
    finish: (args) => ({ status: (args[1] as { status: string }).status, finished_at: new Date().toISOString(), notified: false }),
    getCollectPlan: () => ({ shop_accounts: over.shopAccounts ?? [] }),
    recordRun: (args): CollectorRun => {
      const r = args[1] as AgentRunInput
      return {
        id: `run-${++runSeq}`, started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
        source: r.source, shop_account_id: r.shop_account_id ?? null, shop_account_name: null,
        status: r.status, fetched: r.fetched, inserted: r.inserted, message: r.message ?? null,
      }
    },
  }
  const defaultRpc: Record<string, (args: unknown[], jwt: string) => unknown> = {
    getSettings: () => ({}),
    getCollectStatus: (): CollectStatus => ({ job: null, agents_online: 1, cooldown_seconds: 0 }),
    requestCollect: () => ({ id: 'job-new', status: 'queued' }),
    listShopAccounts: () => [],
  }
  const agentHandlers = { ...defaultAgent, ...over.agent }
  const rpcHandlers = { ...defaultRpc, ...over.rpc }

  const http: AgentHttp = {
    async register(name, jwt) {
      calls.push({ kind: 'register', method: 'register', args: [name], auth: jwt })
      registerCount++
      if (over.register) return await over.register(name, jwt, registerCount)
      const token = `sbagent_${String(registerCount).padStart(2, '0')}${'K'.repeat(41)}`
      keys.push(token)
      return {
        agent_id: 'agent-1', name, household_id: HOUSEHOLD, token,
        expires_at: new Date(Date.now() + 12 * HOUR).toISOString(),
      }
    },
    async agent<T>(method: string, args: unknown[], key: string, opts?: CallOptions) {
      calls.push({ kind: 'agent', method, args, auth: key, opts })
      return await agentHandlers[method]?.(args, key) as T
    },
    async rpc<T>(method: string, args: unknown[], jwt: string) {
      calls.push({ kind: 'rpc', method, args, auth: jwt })
      return await rpcHandlers[method]?.(args, jwt) as T
    },
  }

  const record = (source: CollectorSource, shopAccountId: string | null = null) =>
    (_silent: boolean, store: CollectorStore): Promise<CollectorRun> =>
      store.recordRun({ source, shop_account_id: shopAccountId, status: 'ok', fetched: 1, inserted: 0 })

  const collectorCalls: Array<{ source: string; shopAccountId?: string; silent: boolean }> = []
  const collectors: RunnerDeps['collectors'] = {
    mercari: over.collectors?.mercari ?? ((silent, store) => { collectorCalls.push({ source: 'mercari', silent }); return record('mercari')(silent, store) }),
    yahoo: over.collectors?.yahoo ?? ((silent, store) => { collectorCalls.push({ source: 'yahoo', silent }); return record('yahoo')(silent, store) }),
    mellojoy: over.collectors?.mellojoy ?? ((id, silent, store) => { collectorCalls.push({ source: 'mellojoy', shopAccountId: id, silent }); return record('mellojoy', id)(silent, store) }),
  }

  const creds: Array<MediaCredentials | null> = []
  const runner = new AgentRunner({
    deviceName: 'リビングの PC',
    http,
    createMedia: ({ credentials }) => ({
      upload: async (kind, file) => { creds.push(credentials()); return `${HOUSEHOLD}/${kind}/${file}` },
      remove: async () => {},
    }),
    collectors,
    log: (kind, message, payload) => { logs.push({ kind, message, payload }) },
    onStatus: s => statuses.push(s),
  })

  const count = (method: string): number => calls.filter(c => c.method === method).length
  const of = (method: string): Call[] => calls.filter(c => c.method === method)
  return { runner, calls, count, of, statuses, logs, keys, collectorCalls, creds, registerCount: () => registerCount }
}

const claim = (id = 'job-1'): AgentClaim => ({
  job_id: id, lease_token: `lease-${id}-secret`, lease_expires_at: new Date(Date.now() + 3 * MIN).toISOString(), requested_at: new Date().toISOString(),
})

/** 次の claim で 1 度だけ要求を返す */
function claimOnce(id = 'job-1'): AgentHandler {
  let given = false
  return () => { if (given) return null; given = true; return claim(id) }
}

const tick = async (ms = 0): Promise<void> => { await vi.advanceTimersByTimeAsync(ms) }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ログインが来たら：鍵を取り、起動時に 1 回だけ頼み、20 秒ごとに claim', () => {
  it('register(端末名) は人の JWT で呼ぶ。そのあと 20 秒ごとに claim を鍵で呼ぶ', async () => {
    const h = harness()
    const s = session()
    h.runner.setSession(s)
    await tick(0)

    expect(h.of('register')).toHaveLength(1)
    expect(h.of('register')[0]).toMatchObject({ args: ['リビングの PC'], auth: s.accessToken })
    expect(h.count('claim')).toBe(1)
    expect(h.of('claim')[0].auth).toBe(h.keys[0])
    expect(h.of('claim')[0].auth.startsWith('sbagent_')).toBe(true)

    await tick(19_999)
    expect(h.count('claim')).toBe(1)
    await tick(1)
    expect(h.count('claim')).toBe(2)
    await tick(20_000)
    expect(h.count('claim')).toBe(3)
    await tick(60_000)
    expect(h.count('claim')).toBe(6)
    expect(h.runner.getStatus().state).toBe('idle')
  })

  it('起動時の requestCollect は register のあと・最初の claim の前に 1 回だけ（人の JWT）', async () => {
    const h = harness()
    h.runner.setSession(session())
    await tick(0)

    const order = h.calls.map(c => `${c.kind}:${c.method}`)
    expect(order.slice(0, 5)).toEqual([
      'register:register', 'rpc:getSettings', 'rpc:getCollectStatus', 'rpc:requestCollect', 'agent:claim',
    ])
    expect(h.of('requestCollect')[0].auth).toBe(session().accessToken)

    // トークンの更新で setSession が何度来ても、起動時の依頼はもう出さない
    h.runner.setSession(session({ accessToken: `jwt-${'b'.repeat(40)}` }))
    await tick(60_000)
    expect(h.count('requestCollect')).toBe(1)
    expect(h.count('register')).toBe(1)
  })

  it('requestCollect がクールダウン・取り込み中で断られても黙って無視して、claim は始まる', async () => {
    for (const code of ['conflict', 'bad_request', 'internal'] as const) {
      const h = harness({
        rpc: { requestCollect: () => { throw new AgentHttpError(code, code === 'internal' ? 500 : 409, '前の取り込みから 10 分は頼めません') } },
      })
      h.runner.setSession(session())
      await tick(0)
      expect(h.count('requestCollect'), code).toBe(1)
      expect(h.count('claim'), code).toBe(1)
      expect(h.runner.getStatus().state, code).toBe('idle')
      h.runner.dispose()
    }
  })

  it('getSettings / getCollectStatus が読めなくても、頼んでみる（断られたら無視）', async () => {
    const h = harness({
      rpc: {
        getSettings: () => { throw new AgentHttpError('network', 0, 'つながりません') },
        getCollectStatus: () => { throw new AgentHttpError('network', 0, 'つながりません') },
      },
    })
    h.runner.setSession(session())
    await tick(0)
    expect(h.count('requestCollect')).toBe(1)
    expect(h.count('claim')).toBe(1)
  })

  it('直近に取り込めている（ok の実行記録が間隔の中）なら頼まない。間隔は Web 版の設定 collect_interval_h', async () => {
    const recent = new Date(Date.now() - 30 * MIN).toISOString()
    const status: CollectStatus = {
      agents_online: 1, cooldown_seconds: 0,
      job: {
        id: 'j', status: 'done', requested_at: recent, requested_by_me: true, agent_name: 'PC', claimed_at: recent, heartbeat_at: recent,
        finished_at: recent, message: null,
        runs: [{ id: 'r', started_at: recent, finished_at: recent, source: 'mercari', shop_account_id: null, shop_account_name: null, status: 'ok', fetched: 1, inserted: 0, message: null }],
      },
    }
    const skip = harness({ rpc: { getCollectStatus: () => status } })
    skip.runner.setSession(session())
    await tick(0)
    expect(skip.count('requestCollect')).toBe(0)
    expect(skip.count('claim')).toBe(1) // 頼まなくても claim は始まる

    // 間隔を 0 時間にすれば頼む
    const ask = harness({ rpc: { getCollectStatus: () => status, getSettings: () => ({ collect_interval_h: '0' }) } })
    ask.runner.setSession(session())
    await tick(0)
    expect(ask.count('requestCollect')).toBe(1)
  })

  it('JWT がすでに切れていれば鍵は取らない（画面が更新したトークンを待つ）。新しいトークンが来たら始まる', async () => {
    const h = harness()
    h.runner.setSession(session({ expiresAt: nowSec() - 10 }))
    await tick(0)
    expect(h.count('register')).toBe(0)
    expect(h.runner.getStatus().state).toBe('waiting-login')

    h.runner.setSession(session())
    await tick(0)
    expect(h.count('register')).toBe(1)
    expect(h.count('claim')).toBe(1)
  })

  it('ログインが届くまで何もしない（通信しない）', async () => {
    const h = harness()
    await tick(5 * MIN)
    expect(h.calls).toHaveLength(0)
    expect(h.runner.getStatus()).toEqual({ state: 'waiting-login', message: null })
  })
})

describe('shouldSkipStartupRequest：起動時に頼まない条件', () => {
  const now = T0.getTime()
  const job = (over: Partial<NonNullable<CollectStatus['job']>>): NonNullable<CollectStatus['job']> => ({
    id: 'j', status: 'done', requested_at: '', requested_by_me: true, agent_name: null, claimed_at: null, heartbeat_at: null,
    finished_at: null, runs: null, message: null, ...over,
  })
  const okRun = (finishedAt: string): CollectorRun => ({
    id: 'r', started_at: finishedAt, finished_at: finishedAt, source: 'mercari', shop_account_id: null, shop_account_name: null,
    status: 'ok', fetched: 1, inserted: 0, message: null,
  })

  it('すでに積まれている・走っている／クールダウン中は頼まない', () => {
    expect(shouldSkipStartupRequest({ job: job({ status: 'queued' }), agents_online: 1, cooldown_seconds: 0 }, 1, now)).toBe(true)
    expect(shouldSkipStartupRequest({ job: job({ status: 'running' }), agents_online: 1, cooldown_seconds: 0 }, 1, now)).toBe(true)
    expect(shouldSkipStartupRequest({ job: null, agents_online: 1, cooldown_seconds: 30 }, 1, now)).toBe(true)
  })

  it('一度も取り込んでいない・取り込みはあるが ok が無い（失敗・要ログインだけ）なら頼む', () => {
    expect(shouldSkipStartupRequest({ job: null, agents_online: 1, cooldown_seconds: 0 }, 1, now)).toBe(false)
    const failed: CollectorRun = { ...okRun(new Date(now - MIN).toISOString()), status: 'failed' }
    expect(shouldSkipStartupRequest({ job: job({ status: 'failed', runs: [failed] }), agents_online: 1, cooldown_seconds: 0 }, 1, now)).toBe(false)
  })

  it('ok の実行記録が間隔より古ければ頼み、新しければ頼まない（境界は間隔ちょうど＝頼む）', () => {
    const at = (msAgo: number): CollectorStatusJob => ({ job: job({ runs: [okRun(new Date(now - msAgo).toISOString())] }), agents_online: 1, cooldown_seconds: 0 })
    expect(shouldSkipStartupRequest(at(59 * MIN), 1, now)).toBe(true)
    expect(shouldSkipStartupRequest(at(HOUR), 1, now)).toBe(false)
    expect(shouldSkipStartupRequest(at(61 * MIN), 1, now)).toBe(false)
    expect(shouldSkipStartupRequest(at(5 * HOUR), 6, now)).toBe(true)
  })

  it('empty の実行記録も前回成功に数える（デスクトップの hoursSinceLastOk と同じ）。failed・auth_required は数えない', () => {
    const at = (status: CollectorRun['status'], msAgo: number): CollectorStatusJob => ({
      job: job({ runs: [{ ...okRun(new Date(now - msAgo).toISOString()), status }] }), agents_online: 1, cooldown_seconds: 0,
    })
    expect(shouldSkipStartupRequest(at('empty', 59 * MIN), 1, now)).toBe(true)
    expect(shouldSkipStartupRequest(at('empty', 61 * MIN), 1, now)).toBe(false)
    expect(shouldSkipStartupRequest(at('failed', 5 * MIN), 1, now)).toBe(false)
    expect(shouldSkipStartupRequest(at('auth_required', 5 * MIN), 1, now)).toBe(false)
  })
})
type CollectorStatusJob = CollectStatus

describe('取れたら：直列に収集し、60 秒ごとに heartbeat、終わったら finish', () => {
  it('メルカリ → Yahoo!フリマ → メロジョイ（計画の仕入先ごと）の順に直列で収集し、done で finish', async () => {
    const order: string[] = []
    const gates = { mercari: deferred(), yahoo: deferred(), s1: deferred(), s2: deferred() }
    const h = harness({
      agent: { claim: claimOnce() },
      shopAccounts: [{ id: 'shop-1', name: 'A' }, { id: 'shop-2', name: 'B' }],
      collectors: {
        mercari: async (_s, store) => { order.push('mercari:start'); await gates.mercari.promise; order.push('mercari:end'); return store.recordRun({ source: 'mercari', status: 'ok', fetched: 5, inserted: 2 }) },
        yahoo: async (_s, store) => { order.push('yahoo:start'); await gates.yahoo.promise; order.push('yahoo:end'); return store.recordRun({ source: 'yahoo', status: 'empty', fetched: 0, inserted: 0, message: '0件でした' }) },
        mellojoy: async (id, _s, store) => {
          order.push(`${id}:start`); await (id === 'shop-1' ? gates.s1 : gates.s2).promise; order.push(`${id}:end`)
          return store.recordRun({ source: 'mellojoy', shop_account_id: id, status: 'ok', fetched: 1, inserted: 1 })
        },
      },
    })
    h.runner.setSession(session())
    await tick(0)
    expect(order).toEqual(['mercari:start'])
    expect(h.runner.getStatus().state).toBe('running')

    gates.mercari.resolve(); await tick(0)
    expect(order).toEqual(['mercari:start', 'mercari:end', 'yahoo:start'])
    gates.yahoo.resolve(); await tick(0)
    expect(order.slice(-2)).toEqual(['yahoo:end', 'shop-1:start'])
    gates.s1.resolve(); await tick(0)
    expect(order.slice(-2)).toEqual(['shop-1:end', 'shop-2:start'])
    expect(order).not.toContain('shop-2:end')
    gates.s2.resolve(); await tick(0)
    expect(order).toEqual([
      'mercari:start', 'mercari:end', 'yahoo:start', 'yahoo:end', 'shop-1:start', 'shop-1:end', 'shop-2:start', 'shop-2:end',
    ])

    // finish：全部 ok / empty なので done。実行記録の id を集めて渡す。17TRACK 等は呼ばない
    expect(h.count('finish')).toBe(1)
    const [lease, input] = h.of('finish')[0].args as [{ job_id: string; lease_token: string }, { status: string; run_ids: string[]; message: string | null }]
    expect(lease).toEqual({ job_id: 'job-1', lease_token: 'lease-job-1-secret' })
    expect(input).toEqual({ status: 'done', run_ids: ['run-1', 'run-2', 'run-3', 'run-4'], message: null })
    expect(h.calls.map(c => c.method)).not.toContain('checkTracking')
    expect(h.runner.getStatus().state).toBe('idle')
  })

  it('書き込み・読み取りは lease を渡す。鍵は Agent の鍵、人の JWT は渡さない', async () => {
    const h = harness({ agent: { claim: claimOnce() } })
    h.runner.setSession(session())
    await tick(0)
    for (const c of h.calls.filter(c => c.kind === 'agent' && c.method !== 'claim')) {
      expect(c.auth, c.method).toBe(h.keys[0])
      expect((c.args[0] as { job_id: string }).job_id, c.method).toBe('job-1')
    }
    expect(h.of('recordRun').length).toBeGreaterThanOrEqual(2)
  })

  it('取り込みの設定 collect_show_window=1 なら、窓を出して収集する（silent=false）。既定は silent=true', async () => {
    const shown = harness({ agent: { claim: claimOnce() }, rpc: { getSettings: () => ({ collect_show_window: '1' }) } })
    shown.runner.setSession(session())
    await tick(0)
    expect(shown.collectorCalls.map(c => c.silent)).toEqual([false, false])

    const quiet = harness({ agent: { claim: claimOnce() } })
    quiet.runner.setSession(session())
    await tick(0)
    expect(quiet.collectorCalls.map(c => c.silent)).toEqual([true, true])
  })

  it('取り込み中は claim しない。heartbeat は 60 秒ごと（lease を渡す）。終わったら止まる', async () => {
    const gate = deferred()
    const h = harness({
      agent: { claim: claimOnce() },
      collectors: { mercari: async (_s, store) => { await gate.promise; return store.recordRun({ source: 'mercari', status: 'ok', fetched: 1, inserted: 0 }) } },
    })
    h.runner.setSession(session())
    await tick(0)
    expect(h.count('claim')).toBe(1)
    expect(h.count('heartbeat')).toBe(0)

    await tick(59_999)
    expect(h.count('heartbeat')).toBe(0)
    await tick(1)
    expect(h.count('heartbeat')).toBe(1)
    expect(h.of('heartbeat')[0].args).toEqual([{ job_id: 'job-1', lease_token: 'lease-job-1-secret' }])
    expect(h.of('heartbeat')[0].auth).toBe(h.keys[0])
    await tick(60_000)
    expect(h.count('heartbeat')).toBe(2)
    expect(h.count('claim')).toBe(1) // 取り込み中は新しい要求を取りに行かない

    gate.resolve()
    await tick(0)
    expect(h.count('finish')).toBe(1)
    await tick(5 * MIN)
    expect(h.count('heartbeat')).toBe(2) // 終わったあとは打たない
    expect(h.count('claim')).toBeGreaterThan(1) // 終わったあとは 20 秒ごとの claim に戻る
  })

  it('heartbeat の通信が失敗しても（lease_lost 以外）取り込みは続け、次の周期でまた打つ', async () => {
    const gate = deferred()
    let n = 0
    const h = harness({
      agent: {
        claim: claimOnce(),
        heartbeat: () => { n++; if (n === 1) throw new AgentHttpError('network', 0, 'つながりません'); return { lease_expires_at: 'x' } },
      },
      collectors: { mercari: async (_s, store) => { await gate.promise; return store.recordRun({ source: 'mercari', status: 'ok', fetched: 1, inserted: 0 }) } },
    })
    h.runner.setSession(session())
    await tick(0)
    await tick(2 * MIN)
    expect(h.count('heartbeat')).toBe(2)
    gate.resolve()
    await tick(0)
    expect(h.count('finish')).toBe(1)
    expect(h.logs.some(l => l.kind === 'heartbeat_failed')).toBe(true)
  })
})

describe('finish の状態の決め方', () => {
  const finishInput = (h: ReturnType<typeof harness>) =>
    h.of('finish')[0].args[1] as { status: string; run_ids: string[]; message: string | null }

  async function runWith(statuses: Record<string, 'ok' | 'empty' | 'failed' | 'auth_required'>, shopAccounts: Array<{ id: string; name: string }> = []) {
    const h = harness({
      agent: { claim: claimOnce() },
      shopAccounts,
      collectors: {
        mercari: (_s, store) => store.recordRun({ source: 'mercari', status: statuses.mercari ?? 'ok', fetched: 1, inserted: 0 }),
        yahoo: (_s, store) => store.recordRun({ source: 'yahoo', status: statuses.yahoo ?? 'ok', fetched: 1, inserted: 0 }),
        mellojoy: (id, _s, store) => store.recordRun({ source: 'mellojoy', shop_account_id: id, status: statuses[id] ?? 'ok', fetched: 1, inserted: 0 }),
      },
    })
    h.runner.setSession(session())
    await tick(0)
    return h
  }

  it('全部 ok / empty → done（0 件の empty も done。通知はサーバーが積む）', async () => {
    expect(finishInput(await runWith({ mercari: 'ok', yahoo: 'empty' })).status).toBe('done')
  })

  it('failed / 要ログインが混ざり、終わった分もある → partial', async () => {
    expect(finishInput(await runWith({ mercari: 'ok', yahoo: 'auth_required' })).status).toBe('partial')
    expect(finishInput(await runWith({ mercari: 'failed', yahoo: 'empty' })).status).toBe('partial')
  })

  it('全部 failed / 要ログイン → failed', async () => {
    expect(finishInput(await runWith({ mercari: 'auth_required', yahoo: 'failed' })).status).toBe('failed')
    expect(finishInput(await runWith({ mercari: 'failed', yahoo: 'failed', s1: 'auth_required' }, [{ id: 's1', name: 'A' }])).status).toBe('failed')
  })

  it('収集が実行記録を残せず例外で止まった → 終わった分があれば partial（残りは次の取り込み）、無ければ failed。理由を補足に', async () => {
    const h = harness({
      agent: { claim: claimOnce() },
      collectors: {
        mercari: (_s, store) => store.recordRun({ source: 'mercari', status: 'ok', fetched: 1, inserted: 0 }),
        yahoo: async () => { throw new Error('想定外のエラー') },
      },
    })
    h.runner.setSession(session())
    await tick(0)
    const input = finishInput(h)
    expect(input.status).toBe('partial')
    expect(input.run_ids).toEqual(['run-1'])
    expect(input.message).toContain('Yahoo!フリマ')
    expect(input.message).toContain('想定外のエラー')

    const none = harness({
      agent: { claim: claimOnce() },
      collectors: { mercari: async () => { throw new Error('boom') }, yahoo: async () => { throw new Error('boom') } },
    })
    none.runner.setSession(session())
    await tick(0)
    expect(finishInput(none)).toMatchObject({ status: 'failed', run_ids: [] })
  })

  it('サーバーに届かなくなったら残りの取り込み元は諦める（メルカリなどへのアクセスを無駄に増やさない）', async () => {
    const h = harness({
      agent: { claim: claimOnce() },
      collectors: {
        mercari: async () => { throw new AgentHttpError('network', 0, 'サーバーにつながりません。通信の状態を確かめてください') },
      },
    })
    h.runner.setSession(session())
    await tick(0)
    expect(h.collectorCalls.map(c => c.source)).toEqual([]) // yahoo は呼ばれない
    expect(finishInput(h).status).toBe('failed')
  })
})

describe('lease_lost：直ちに止まる（finish も呼ばない）', () => {
  it('heartbeat が lease_lost なら、収集は次の store 呼び出しで止まり、finish を呼ばない', async () => {
    const gate = deferred()
    const seenErrors: unknown[] = []
    const h = harness({
      agent: { claim: claimOnce(), heartbeat: () => { throw new LeaseLostError() } },
      collectors: {
        mercari: async (_s, store) => {
          await gate.promise
          // 収集のコードは途中の例外を握ることがあるが、最後の recordRun で外に出る
          try { await store.ingestTrading([]) } catch (e) { seenErrors.push(e) }
          return store.recordRun({ source: 'mercari', status: 'failed', fetched: 0, inserted: 0 })
        },
      },
    })
    h.runner.setSession(session())
    await tick(0)
    await tick(60_000)
    expect(h.count('heartbeat')).toBe(1)
    const writesBefore = h.calls.filter(c => c.kind === 'agent').length

    gate.resolve()
    await tick(0)
    expect(seenErrors[0]).toBeInstanceOf(LeaseLostError)
    // 失効した lease で、もうサーバーを叩かない
    expect(h.calls.filter(c => c.kind === 'agent')).toHaveLength(writesBefore)
    expect(h.count('finish')).toBe(0)
    expect(h.collectorCalls.map(c => c.source)).toEqual([]) // 続きの yahoo も始めない
    expect(h.logs.some(l => l.kind === 'heartbeat_lease_lost')).toBe(true)
    expect(h.runner.getStatus().state).toBe('idle')

    // そのあとは普通に claim に戻る
    const claims = h.count('claim')
    await tick(20_000)
    expect(h.count('claim')).toBe(claims + 1)
  })

  it('書き込みが lease_lost を返しても同じ：以後の呼び出しは通信せず、finish を呼ばず、ほかの取り込み元も始めない', async () => {
    const h = harness({
      agent: {
        claim: claimOnce(),
        recordRun: () => { throw new LeaseLostError() },
      },
    })
    h.runner.setSession(session())
    await tick(0)
    expect(h.count('recordRun')).toBe(1) // 1 回だけ（以後は通信しない）
    expect(h.count('finish')).toBe(0)
    expect(h.collectorCalls.map(c => c.source)).toEqual(['mercari'])
  })

  it('finish が lease_lost（すでに終わった取り込みの送り直しなど）でも落ちない', async () => {
    const h = harness({ agent: { claim: claimOnce(), finish: () => { throw new LeaseLostError() } } })
    h.runner.setSession(session())
    await tick(0)
    expect(h.count('finish')).toBe(1)
    expect(h.runner.getStatus().state).toBe('idle')
  })
})

describe('鍵の取り直しとログアウト', () => {
  it('期限の 30 分前に、そのときのトークンで取り直す。以後の通信は新しい鍵', async () => {
    const h = harness()
    h.runner.setSession(session({ accessToken: `jwt-${'1'.repeat(40)}` }))
    await tick(0)
    expect(h.count('register')).toBe(1)

    // 途中でトークンが更新される（Web 版が渡し直す）
    await tick(11 * HOUR)
    const fresh = session({ accessToken: `jwt-${'2'.repeat(40)}` })
    h.runner.setSession(fresh)
    expect(h.count('register')).toBe(1) // まだ期限の 30 分前ではない
    await tick(29 * MIN)
    expect(h.count('register')).toBe(1)
    await tick(1 * MIN)
    // 12 時間 − 30 分 ＝ 11 時間 30 分
    expect(h.count('register')).toBe(2)
    expect(h.of('register')[1].auth).toBe(fresh.accessToken)
    expect(h.keys).toHaveLength(2)

    await tick(20_000)
    expect(h.of('claim').at(-1)?.auth).toBe(h.keys[1])
  })

  it('期限の 30 分前をすぎてからトークンが届いたら、すぐ取り直す', async () => {
    const h = harness()
    h.runner.setSession(session())
    await tick(0)
    vi.setSystemTime(new Date(T0.getTime() + 11.7 * HOUR))
    h.runner.setSession(session({ accessToken: `jwt-${'3'.repeat(40)}` }))
    await tick(0)
    expect(h.count('register')).toBe(2)
  })

  it('取り込み中は鍵の取り直しを待つ（古い鍵が通信中に使えなくなるのを避ける）。終わったら取り直す', async () => {
    const gate = deferred()
    const h = harness({
      agent: { claim: claimOnce() },
      collectors: { mercari: async (_s, store) => { await gate.promise; return store.recordRun({ source: 'mercari', status: 'ok', fetched: 1, inserted: 0 }) } },
    })
    h.runner.setSession(session())
    await tick(0)
    // 期限の 30 分前をすぎても、取り込み中は取り直さない
    await tick(11.6 * HOUR)
    h.runner.setSession(session({ accessToken: `jwt-${'4'.repeat(40)}` }))
    await tick(MIN)
    expect(h.count('register')).toBe(1)

    gate.resolve()
    await tick(MIN)
    expect(h.count('register')).toBe(2)
  })

  it('ただし期限まで 5 分を切ったら、取り込み中でも取り直す', async () => {
    const gate = deferred()
    const h = harness({
      agent: { claim: claimOnce() },
      collectors: { mercari: async (_s, store) => { await gate.promise; return store.recordRun({ source: 'mercari', status: 'ok', fetched: 1, inserted: 0 }) } },
    })
    h.runner.setSession(session())
    await tick(0)
    await tick(11.6 * HOUR)
    h.runner.setSession(session({ accessToken: `jwt-${'5'.repeat(40)}` }))
    await tick(MIN)
    expect(h.count('register')).toBe(1)
    await tick(25 * MIN) // 期限まで 5 分を切る
    expect(h.count('register')).toBe(2)
    gate.resolve()
    await tick(0)
  })

  it('トークンが消える（ログアウト）と、サーバーの鍵を 1 回だけ捨ててから止まる：unregister のほかは claim も取り直しも通信しない', async () => {
    const h = harness()
    h.runner.setSession(session())
    await tick(0)
    const key = h.keys[0]
    const before = h.calls.length
    h.runner.clearSession()
    expect(h.runner.getStatus().state).toBe('waiting-login')

    await tick(12 * HOUR)
    // 捨てる前の鍵で、unregister だけを 1 回。やり直さず、待ちすぎない（5 秒）
    const after = h.calls.slice(before)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ kind: 'agent', method: 'unregister', args: [], auth: key })
    expect(after[0].opts).toEqual({ retry: false, timeoutMs: 5_000 })
    expect(h.logs.map(l => l.kind)).toContain('agent_unregistered')
    // 鍵はログに出さない
    expect(JSON.stringify(h.logs)).not.toContain(key)

    // もう一度ログアウトが来ても（鍵はもう無い）、何も送らない
    h.runner.clearSession()
    await tick(MIN)
    expect(h.calls).toHaveLength(before + 1)
  })

  it('ログインしていない（鍵を持っていない）ときのログアウトは、サーバーに何も送らない', async () => {
    const h = harness()
    h.runner.clearSession()
    await tick(MIN)
    expect(h.calls).toHaveLength(0)
    expect(h.runner.getStatus().state).toBe('waiting-login')
  })

  it('サーバーの鍵を捨てるのに失敗しても（通信切れ・401・応答が来ない）止まる：やり直さず、ログに理由だけ残す', async () => {
    const failures: Array<[string, () => unknown]> = [
      ['通信切れ', () => { throw new AgentHttpError('network', 0, 'サーバーにつながりません') }],
      ['401', () => { throw new AgentHttpError('unauthorized', 401, '鍵が正しくありません') }],
      ['応答が来ない', () => new Promise(() => {})],
    ]
    for (const [label, unregister] of failures) {
      const h = harness({ agent: { unregister } })
      h.runner.setSession(session())
      await tick(0)
      const key = h.keys[0]
      const before = h.calls.length

      h.runner.clearSession()
      // 返事を待たずに止まる
      expect(h.runner.getStatus().state, label).toBe('waiting-login')
      await tick(12 * HOUR)
      expect(h.calls.slice(before).map(c => c.method), label).toEqual(['unregister'])
      expect(h.count('claim'), label).toBe(1)

      if (label !== '応答が来ない') {
        const failed = h.logs.find(l => l.kind === 'agent_unregister_failed')
        expect(failed?.message, label).toContain('期限で切れます')
      }
      expect(JSON.stringify(h.logs), label).not.toContain(key)

      // またログインすれば、鍵を取り直して再開できる
      h.runner.setSession(session({ accessToken: `jwt-${'u'.repeat(40)}` }))
      await tick(0)
      expect(h.count('register'), label).toBe(2)
      h.runner.dispose()
    }
  })

  it('ログアウトしたあとにまたログインしたら、鍵を取り直して再開する（起動時の依頼は出さない）', async () => {
    const h = harness()
    h.runner.setSession(session())
    await tick(0)
    h.runner.clearSession()
    await tick(5 * MIN)
    h.runner.setSession(session({ accessToken: `jwt-${'6'.repeat(40)}` }))
    await tick(0)
    expect(h.count('register')).toBe(2)
    expect(h.count('requestCollect')).toBe(1)
    const claims = h.count('claim')
    await tick(20_000)
    expect(h.count('claim')).toBe(claims + 1)
  })

  it('取り込み中にログアウトしたら、次の store 呼び出しで止まる（通信しない）。finish は呼ばない', async () => {
    const gate = deferred()
    const errors: unknown[] = []
    const h = harness({
      agent: { claim: claimOnce() },
      collectors: {
        mercari: async (_s, store) => {
          await gate.promise
          try { await store.ingestTrading([]) } catch (e) { errors.push(e) }
          return store.recordRun({ source: 'mercari', status: 'ok', fetched: 1, inserted: 0 })
        },
      },
    })
    h.runner.setSession(session())
    await tick(0)
    // unregister（ログアウトで鍵を捨てる 1 回）は別に数える：それ以外は一切通信しない
    const agentCallsExceptUnregister = (): number =>
      h.calls.filter(c => c.kind === 'agent' && c.method !== 'unregister').length
    const agentCalls = agentCallsExceptUnregister()

    h.runner.clearSession()
    gate.resolve()
    await tick(0)
    expect(errors[0]).toMatchObject({ name: 'AgentStoppedError' })
    expect(agentCallsExceptUnregister()).toBe(agentCalls)
    expect(h.count('unregister')).toBe(1)
    expect(h.count('finish')).toBe(0)
    await tick(5 * MIN)
    expect(agentCallsExceptUnregister()).toBe(agentCalls) // もう claim もしない
    expect(h.count('unregister')).toBe(1)
  })

  it('dispose（モードを抜ける）すると以後は何をしても動かない', async () => {
    const h = harness()
    h.runner.setSession(session())
    await tick(0)
    const key = h.keys[0]
    h.runner.dispose()
    // 抜けるときも、サーバーの鍵を 1 回だけ捨てに行く（届かなくても鍵は期限で切れる）
    expect(h.of('unregister')).toHaveLength(1)
    expect(h.of('unregister')[0].auth).toBe(key)
    const before = h.calls.length
    h.runner.setSession(session())
    await tick(10 * MIN)
    expect(h.calls).toHaveLength(before)
  })

  it('claim が 401（鍵が使えなくなった）なら、いまのトークンで取り直す', async () => {
    let n = 0
    const h = harness({
      agent: {
        claim: () => { n++; if (n === 2) throw new AgentHttpError('unauthorized', 401, '鍵が正しくありません'); return null },
      },
    })
    h.runner.setSession(session())
    await tick(0)
    await tick(20_000) // 2 回目の claim が 401
    await tick(0)
    expect(h.count('register')).toBe(2)
    await tick(20_000)
    expect(h.of('claim').at(-1)?.auth).toBe(h.keys[1])
  })
})

describe('鍵を出してもらえないとき', () => {
  it('取り消された PC（409）は revoked にして、勝手にやり直さない', async () => {
    const h = harness({ register: () => { throw new AgentHttpError('conflict', 409, 'この PC は取り込み担当を取り消されています') } })
    h.runner.setSession(session())
    await tick(0)
    expect(h.runner.getStatus()).toEqual({ state: 'revoked', message: 'この PC は取り込み担当を取り消されています' })
    await tick(10 * MIN)
    expect(h.count('register')).toBe(1)
    expect(h.count('claim')).toBe(0)
    expect(h.count('requestCollect')).toBe(0)
  })

  it('401（人の JWT が通らない）は新しいログインを待つ。新しいトークンが来たらやり直す', async () => {
    let first = true
    const h = harness({
      register: (name, _jwt, n) => {
        if (first) { first = false; throw new AgentHttpError('unauthorized', 401, 'ログインが必要です') }
        return { agent_id: 'a', name, household_id: HOUSEHOLD, token: `sbagent_${n}${'K'.repeat(42)}`, expires_at: new Date(Date.now() + 12 * HOUR).toISOString() }
      },
    })
    h.runner.setSession(session())
    await tick(10 * MIN)
    expect(h.count('register')).toBe(1)
    expect(h.runner.getStatus().state).toBe('waiting-login')

    h.runner.setSession(session({ accessToken: `jwt-${'7'.repeat(40)}` }))
    await tick(0)
    expect(h.count('register')).toBe(2)
    expect(h.count('claim')).toBe(1)
  })

  it('通信切れ・5xx は 60 秒ごとにやり直す', async () => {
    let n = 0
    const h = harness({
      register: (name) => {
        n++
        if (n < 3) throw new AgentHttpError('network', 0, 'サーバーにつながりません')
        return { agent_id: 'a', name, household_id: HOUSEHOLD, token: `sbagent_${'K'.repeat(43)}`, expires_at: new Date(Date.now() + 12 * HOUR).toISOString() }
      },
    })
    h.runner.setSession(session())
    await tick(0)
    expect(h.runner.getStatus().state).toBe('error')
    await tick(59_999)
    expect(h.count('register')).toBe(1)
    await tick(1)
    expect(h.count('register')).toBe(2)
    await tick(60_000)
    expect(h.count('register')).toBe(3)
    expect(h.runner.getStatus().state).toBe('idle')
    await tick(1) // 鍵が取れた直後の最初の claim（タイマーの中で積まれた 0ms は 1ms 後になる）
    expect(h.count('claim')).toBe(1)
  })

  it('待っている間にログアウトしたら、受け取った鍵は持たない', async () => {
    const gate = deferred<AgentRegistration>()
    const h = harness({ register: () => gate.promise })
    h.runner.setSession(session())
    await tick(0)
    h.runner.clearSession()
    gate.resolve({ agent_id: 'a', name: 'PC', household_id: HOUSEHOLD, token: `sbagent_${'K'.repeat(43)}`, expires_at: new Date(Date.now() + 12 * HOUR).toISOString() })
    await tick(5 * MIN)
    expect(h.count('claim')).toBe(0)
    expect(h.runner.getStatus().state).toBe('waiting-login')
  })
})

describe('画像の資格・秘密の値', () => {
  it('画像を上げる資格は、その時点の Web 版のトークン（更新されたものを使う）', async () => {
    const gate = deferred()
    const h = harness({
      agent: { claim: claimOnce() },
      collectors: {
        mercari: async (_s, store) => {
          await gate.promise
          await store.saveLineImage('line-1', 'x.jpg')
          return store.recordRun({ source: 'mercari', status: 'ok', fetched: 1, inserted: 0 })
        },
      },
    })
    h.runner.setSession(session({ accessToken: `jwt-${'8'.repeat(40)}` }))
    await tick(0)
    h.runner.setSession(session({ accessToken: `jwt-${'9'.repeat(40)}` }))
    gate.resolve()
    await tick(0)
    expect(h.creds).toHaveLength(1)
    expect(h.creds[0]).toMatchObject({ accessToken: `jwt-${'9'.repeat(40)}`, supabaseUrl: 'https://abcd.supabase.co' })
  })

  it('ログに鍵・トークン・lease_token を出さない', async () => {
    const h = harness({
      agent: { claim: claimOnce(), heartbeat: () => { throw new AgentHttpError('network', 0, 'つながりません') } },
      collectors: {
        mercari: async (_s, store) => {
          await tick(2 * MIN)
          return store.recordRun({ source: 'mercari', status: 'failed', fetched: 0, inserted: 0, message: 'x' })
        },
      },
    })
    const s = session()
    h.runner.setSession(s)
    await tick(0)
    await tick(3 * MIN)
    const text = JSON.stringify(h.logs)
    expect(text).not.toContain(s.accessToken)
    expect(text).not.toContain('lease-job-1-secret')
    for (const key of h.keys) expect(text).not.toContain(key)
    expect(h.logs.length).toBeGreaterThan(0)
  })
})
