import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { type WorkerEnv } from '../../../worker/index'
import { SUPABASE_URL, newMember, openDomainDb, type DomainDb, type Member } from '../domain/helpers'
import { makeVapid, type TestVapid } from '../push/helpers'
import { makeKey, signToken, stubJwks, type KeyPair } from '../rpc/helpers'
import { fakeCtx } from './helpers'

// Workers の入口（worker/index.ts）から、本物の認証・業務ロジック・DB（PGlite）まで通す。
// 応答を返したあとの後始末（ctx.waitUntil）：書き込みが成功したときだけ通知を急ぎで送ってみて、**そのあとで**接続を閉じる。
// DB の接続（postgres.js）と、通知の送信（drainDeliveries）だけ差し替える。
// Pages Functions の同じ確認は rpc/after-response.test.ts

const holder = vi.hoisted(() => ({
  sql: undefined as unknown as object,
  /** 起きたことを順に。'drain:start' / 'drain:end' / 'end'（接続を閉じた） */
  events: [] as string[],
  drains: [] as Array<{ env: unknown; opts: unknown }>,
  /** 設定すると、drain はこれが解けるまで終わらない（応答が先に返ることの確認） */
  gate: null as Promise<void> | null,
}))

vi.mock('../../db/postgres', () => ({
  createPostgresSql: () => ({
    ...holder.sql,
    end: async () => {
      holder.events.push('end')
    },
  }),
}))

vi.mock('../../push/deliver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../push/deliver')>()
  return {
    ...actual,
    drainDeliveries: async (_root: unknown, env: unknown, opts: unknown) => {
      holder.events.push('drain:start')
      holder.drains.push({ env, opts })
      if (holder.gate) await holder.gate
      holder.events.push('drain:end')
      return { sent: 0, failed: 0, gone: 0, retried: 0 }
    },
  }
})

let dom: DomainDb
let key: KeyPair
let member: Member
let vapid: TestVapid

beforeAll(async () => {
  dom = await openDomainDb()
  holder.sql = dom.root
  key = await makeKey('worker-after-response-key')
  stubJwks([key])
  member = await newMember(dom, 'worker-after-response')
  vapid = await makeVapid()
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await dom.close()
})

beforeEach(() => {
  holder.events.length = 0
  holder.drains.length = 0
  holder.gate = null
})

afterEach(() => {
  vi.restoreAllMocks()
})

function makeEnv(): WorkerEnv {
  return {
    DATABASE_URL: 'postgres://u:p@db.example:5432/postgres',
    SUPABASE_URL,
    ...vapid.env,
    ASSETS: { fetch: async () => new Response('<html>') },
  }
}

async function invoke(path: string, args: unknown[] = []) {
  const token = await signToken({ key, sub: member.userId })
  const request = new Request(`https://soroban.example${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ args }),
  })
  const { ctx, done } = fakeCtx()
  const response = await worker.fetch(request, makeEnv(), ctx)
  // 応答は返っている。ctx.waitUntil に渡った後始末が終わるのを待つのは、呼んだ側が done() で行う
  return { response, done }
}

describe('Worker の /api/rpc', () => {
  it('書き込みが成功したら、応答を返したあとに通知を急ぎで送り、そのあとで接続を閉じる', async () => {
    let release!: () => void
    holder.gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const r = await invoke('/api/rpc/createTag', [`タグ-${randomUUID().slice(0, 8)}`])
    expect(r.response.status).toBe(200)
    // 応答は返った。送信は始まっているが終わっていない。接続はまだ閉じていない（先に閉じると送れない）
    expect(holder.events).toEqual(['drain:start'])

    release()
    await r.done()
    expect(holder.events).toEqual(['drain:start', 'drain:end', 'end'])
    expect(holder.drains[0].opts).toEqual({ limit: 5 })
    // 鍵は Worker の環境変数をそのまま渡す（無ければ drainDeliveries が何もしない）
    expect(holder.drains[0].env).toMatchObject({ VAPID_PUBLIC_KEY: vapid.env.VAPID_PUBLIC_KEY })
  })

  it('読み取りだけのメソッドでは送らない（接続を閉じるだけ）', async () => {
    const r = await invoke('/api/rpc/getSettings')
    await r.done()
    expect(r.response.status).toBe(200)
    expect(holder.events).toEqual(['end'])
    expect(holder.drains).toHaveLength(0)
  })

  it('失敗した要求（知らないメソッド）では送らない。接続は閉じる', async () => {
    const r = await invoke('/api/rpc/noSuchMethod')
    await r.done()
    expect(r.response.status).toBe(404)
    expect(holder.events).toEqual(['end'])
    expect(holder.drains).toHaveLength(0)
  })
})

describe('Worker の /api/agent', () => {
  it('register（鍵を出す）は人の JWT で通り、通知は送らない。取り込み担当の鍵は /api/agent でだけ通る', async () => {
    const r = await invoke('/api/agent/register', ['Worker テストの PC'])
    await r.done()
    expect(r.response.status).toBe(200)
    expect(holder.events).toEqual(['end'])
    const token = (JSON.parse(await r.response.text()) as { result: { token: string } }).result.token
    expect(token).toBeTruthy()

    // 同じ鍵を /api/rpc に持っていっても通らない（Agent の鍵は人の API では使えない）
    holder.events.length = 0
    const request = new Request('https://soroban.example/api/rpc/getSettings', {
      method: 'POST',
      headers: { authorization: `Agent ${token}` },
      body: '{"args":[]}',
    })
    const { ctx, done } = fakeCtx()
    const rejected = await worker.fetch(request, makeEnv(), ctx)
    await done()
    expect(rejected.status).toBe(401)
    expect(holder.events).toEqual(['end'])
  })
})
