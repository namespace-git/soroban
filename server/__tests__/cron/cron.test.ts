import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  PUSH_LIMIT, reapStaleCollectJobs, runCron, SUBREQUEST_LIMIT, TRACKING_MAX_REQUESTS, type CronDeps, type CronEnv,
} from '../../../workers/cron/index'
import type { Sql } from '../../db/sql'
import { requestCollect } from '../../domain/collect'
import { savePushSubscription } from '../../domain/push'
import { enqueueNotification } from '../../push/notify'
import { parseSecretKeys, putSecret, SECRET_TRACK17 } from '../../secrets'
import { newMember, openDomainDb, type DomainDb } from '../domain/helpers'
import {
  addPurchases, fakeApiKey, fakeClock, fakeTrack17, keyRing, newKey, registeredQueue, spyConsole,
} from '../integrations/helpers'
import { fakePushService, makeDevice, makeVapid, type TestVapid } from '../push/helpers'

// 定期実行の Worker（workers/cron/index.ts）。Cloudflare にも Supabase にも 17TRACK にも出ない
// （PGlite と、偽の fetch だけ）。

const fakeRoot = {} as Sql
const ENV: CronEnv = { SECRET_KEYS: '1:not-used-by-fakes', VAPID_PRIVATE_KEY: 'private-not-real' }

describe('仕事の順番と、失敗の切り分け（偽の仕事）', () => {
  const ok = () => {
    const calls: string[] = []
    const deps: CronDeps = {
      reap: async () => {
        calls.push('reap')
        return 2
      },
      drain: async (_root, _env, opts) => {
        calls.push(`drain:${opts?.limit}`)
        return { sent: 1, failed: 0, gone: 0, retried: 0 }
      },
      track: async (_root, opts) => {
        calls.push(`track:${opts.maxRequests}`)
        return { households: [], requests: 0 }
      },
    }
    return { calls, deps }
  }

  it('① 片付け → ② 17TRACK → ③ 通知（CPU の重い仕事が最後）の順に、割り振った上限で呼ぶ', async () => {
    const { calls, deps } = ok()
    const result = await runCron(fakeRoot, ENV, deps)
    expect(calls).toEqual(['reap', `track:${TRACKING_MAX_REQUESTS}`, `drain:${PUSH_LIMIT}`])
    expect(result).toEqual({
      reaped: 2,
      push: { sent: 1, failed: 0, gone: 0, retried: 0 },
      tracking: { households: [], requests: 0 },
      failed: [],
    })
  })

  it('どれかが失敗しても、残りは続ける。失敗は console.error に原因だけ（秘密は出ない）', async () => {
    for (const failing of ['reap', 'drain', 'track'] as const) {
      const { calls, deps } = ok()
      deps[failing] = (async () => {
        calls.push(`${failing}:fail`)
        throw new Error('接続できませんでした')
      }) as never
      const spy = spyConsole()
      const result = await runCron(fakeRoot, ENV, deps).finally(() => spy.restore())
      // 3 つとも呼ばれた（失敗した 1 つ + 成功した 2 つ）
      expect(calls, failing).toHaveLength(3)
      const name = { reap: 'reap', drain: 'push', track: 'tracking' }[failing]
      expect(result.failed, failing).toEqual([name])
      expect(spy.text(), failing).toContain(`[cron] ${name} に失敗しました`)
      expect(spy.text(), failing).toContain('接続できませんでした')
      for (const secret of [ENV.SECRET_KEYS!, ENV.VAPID_PRIVATE_KEY!]) expect(spy.text(), failing).not.toContain(secret)
    }
  })

  it('3 つとも失敗しても例外は投げない（失敗した仕事の名前を返す）', async () => {
    const boom = async () => {
      throw new Error('boom')
    }
    const spy = spyConsole()
    try {
      const result = await runCron(fakeRoot, ENV, { reap: boom, drain: boom, track: boom } as CronDeps)
      expect(result).toEqual({ reaped: null, push: null, tracking: null, failed: ['reap', 'tracking', 'push'] })
    } finally {
      spy.restore()
    }
  })

  it('SECRET_KEYS が無ければ 17TRACK は飛ばす（毎回の失敗にしない）。他の仕事は動く', async () => {
    for (const secretKeys of [undefined, '', '  ']) {
      const { calls, deps } = ok()
      const spy = spyConsole()
      const result = await runCron(fakeRoot, { ...ENV, SECRET_KEYS: secretKeys }, deps).finally(() => spy.restore())
      expect(calls).toEqual(['reap', `drain:${PUSH_LIMIT}`])
      expect(result.tracking).toBeNull()
      expect(result.push).not.toBeNull()
      expect(result.failed).toEqual([])
      expect(spy.text()).toContain('SECRET_KEYS が設定されていない')
    }
  })

  it('③ には SECRET_KEYS をそのまま渡す。② には環境変数（VAPID_*）を渡す', async () => {
    let drainEnv: unknown
    let trackKeys: unknown
    await runCron(fakeRoot, ENV, {
      reap: async () => 0,
      drain: async (_root, env) => {
        drainEnv = env
        return { sent: 0, failed: 0, gone: 0, retried: 0 }
      },
      track: async (_root, opts) => {
        trackKeys = opts.secretKeys
        return { households: [], requests: 0 }
      },
    })
    expect(drainEnv).toBe(ENV)
    expect(trackKeys).toBe(ENV.SECRET_KEYS)
  })
})

describe('外部通信の割り振り', () => {
  it('通知 + 17TRACK の上限の合計は、無料枠の 50 本を超えない（予備を残す）', () => {
    expect(PUSH_LIMIT + TRACKING_MAX_REQUESTS).toBeLessThanOrEqual(SUBREQUEST_LIMIT - 5)
    expect(SUBREQUEST_LIMIT).toBe(50)
  })

  it('通知の上限は控えめ（1 件ごとの暗号で無料枠の CPU 10ms を超えうる）。5 分ごとなので 1 時間で 120 件送れる', () => {
    expect(PUSH_LIMIT).toBeLessThanOrEqual(10)
    expect(PUSH_LIMIT * (60 / 5)).toBeGreaterThanOrEqual(120)
  })
})

describe('本物の DB・偽の fetch', () => {
  let dom: DomainDb
  let vapid: TestVapid

  beforeAll(async () => {
    dom = await openDomainDb()
    vapid = await makeVapid()
  })
  afterAll(async () => {
    await dom.close()
  })
  beforeEach(async () => {
    // 巡回は全世帯が対象なので、前のテストが積んだ分を持ち越さない
    await dom.pg.exec('delete from app.notification_event')
    await dom.pg.exec('update app.purchase set tracking_queued_at = null')
  })

  it('① 期限切れの取り込み要求を片付ける（soroban_cron）', async () => {
    const m = await newMember(dom, 'reap')
    const job = await m.run((ctx) => requestCollect(ctx))
    await dom.pg.query(`update app.collect_job set requested_at = now() - interval '6 minutes' where id = $1`, [job.id])

    expect(await reapStaleCollectJobs(dom.root)).toBeGreaterThanOrEqual(1)
    const after = await dom.pg.query<{ status: string }>('select status from app.collect_job where id = $1', [job.id])
    expect(after.rows[0].status).toBe('cancelled')
    // 片付けるものが無ければ 0
    expect(await reapStaleCollectJobs(dom.root)).toBe(0)
  })

  it('通知も 17TRACK も仕事が溜まっていても、外部通信は 17TRACK 15 + 通知 10 = 25 本まで（50 本を超えない）', async () => {
    const m = await newMember(dom, 'budget')
    const ring = keyRing([1, newKey()])

    // 通知：端末 1 台に 40 件の出来事（＝40 件の配送）
    const device = await makeDevice()
    await m.run((ctx) => savePushSubscription(ctx, device.input))
    for (let i = 0; i < 40; i++) {
      await m.run((ctx) => enqueueNotification(ctx.sql, { kind: 'sale', title: `売れました ${i}`, body: '', url: '/', dedupeKey: `cron-${i}` }))
    }
    // 17TRACK：登録済み・確認待ちの仕入 800 件（40 件ずつで 20 本ぶん）
    await m.run((ctx) => putSecret(ctx, parseSecretKeys(ring), SECRET_TRACK17, fakeApiKey()))
    await addPurchases(m, registeredQueue(40 * 20))

    const clock = fakeClock()
    const push = fakePushService(201)
    const t17 = fakeTrack17(clock)
    let total = 0
    const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      total++
      return String(input).includes('17track') ? t17.fetch(input, init) : push.fetch(input, init)
    }) as typeof fetch

    const env: CronEnv = { ...vapid.env, SECRET_KEYS: ring }
    const result = await runCron(dom.root, env, { fetch: fetchFn, sleep: clock.sleep, now: clock.now })

    expect(result.failed).toEqual([])
    expect(push.calls).toHaveLength(PUSH_LIMIT)
    expect(result.push?.sent).toBe(PUSH_LIMIT)
    expect(t17.calls).toHaveLength(TRACKING_MAX_REQUESTS)
    expect(result.tracking?.requests).toBe(TRACKING_MAX_REQUESTS)
    expect(total).toBe(PUSH_LIMIT + TRACKING_MAX_REQUESTS)
    expect(total).toBeLessThan(SUBREQUEST_LIMIT)

    // 取りきれなかった分は残っていて、次の実行で続く（通知 40 - PUSH_LIMIT 件・仕入 800 - 40 × 15 件）
    const pending = await dom.pg.query<{ n: number }>(
      `select count(*)::int as n from app.notification_delivery where household_id = $1 and status = 'pending'`, [m.householdId])
    expect(pending.rows[0].n).toBe(40 - PUSH_LIMIT)
    const queued = await dom.pg.query<{ n: number }>(
      `select count(*)::int as n from app.purchase where household_id = $1 and tracking_queued_at is not null`, [m.householdId])
    expect(queued.rows[0].n).toBe(40 * 20 - 40 * TRACKING_MAX_REQUESTS)
  })

  it('鍵が無い環境でも壊れない：通知は送らず、17TRACK は飛ばし、片付けは動く', async () => {
    const spy = spyConsole()
    try {
      const result = await runCron(dom.root, {})
      expect(result.failed).toEqual([])
      expect(result.push).toEqual({ sent: 0, failed: 0, gone: 0, retried: 0 })
      expect(result.tracking).toBeNull()
      expect(result.reaped).not.toBeNull()
    } finally {
      spy.restore()
    }
  })
})

describe('バンドルに electron・better-sqlite3 が入らない（import の鎖を辿る）', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

  /** 相対 import を辿って、届くファイルと、出てくる外部モジュール（bare specifier）を集める */
  function walk(entry: string): { files: Set<string>; bare: Set<string> } {
    const files = new Set<string>()
    const bare = new Set<string>()
    const queue = [entry]
    const FROM = /^\s*(?:import|export)\b[^'"\n;]*?\bfrom\s*['"]([^'"]+)['"]|^\s*\}\s*from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm
    while (queue.length > 0) {
      const file = queue.pop() as string
      if (files.has(file)) continue
      files.add(file)
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(FROM)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4]
        if (spec.startsWith('.')) {
          const base = resolve(dirname(file), spec)
          const found = [`${base}.ts`, join(base, 'index.ts')].find((p) => existsSync(p))
          if (!found) throw new Error(`${file} の import ${spec} を解決できません`)
          queue.push(found)
        } else {
          bare.add(spec)
        }
      }
    }
    return { files, bare }
  }

  it('workers/cron/index.ts から届くファイルに、デスクトップ専用のものが無い', () => {
    const { files, bare } = walk(join(root, 'workers', 'cron', 'index.ts'))
    const rel = [...files].map((f) => f.slice(root.length + 1).replaceAll('\\', '/'))
    // 辿れていること（数え間違いで空振りしていない）
    expect(rel).toContain('server/cron/tracking.ts')
    expect(rel).toContain('server/push/deliver.ts')
    expect(rel).toContain('src/main/track17.ts')

    for (const forbidden of ['electron', 'better-sqlite3', '@electric-sql/pglite', 'vue', 'vite']) {
      expect([...bare].filter((b) => b === forbidden || b.startsWith(`${forbidden}/`)), forbidden).toEqual([])
    }
    expect(rel.filter((f) => f.startsWith('src/renderer/') || f.startsWith('src/preload/'))).toEqual([])
    // デスクトップのメインプロセスから届くのは、Electron を読まない純粋なものだけ
    const fromMain = rel.filter((f) => f.startsWith('src/main/'))
    for (const f of fromMain) {
      expect(readFileSync(join(root, f), 'utf8'), f).not.toMatch(/from\s*['"](electron|better-sqlite3)['"]/)
    }
    expect(rel.filter((f) => f.includes('__tests__') || f.includes('server/db/pglite') || f.includes('server/test/'))).toEqual([])
  })
})
