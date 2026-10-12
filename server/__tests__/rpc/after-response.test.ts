import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentHandlers, agentMayQueueNotification } from '../../agent/index'
import { mayQueueNotification } from '../../rpc'
import { SUPABASE_URL, newMember, openDomainDb, type DomainDb, type Member } from '../domain/helpers'
import { makeVapid, type TestVapid } from '../push/helpers'
import { makeKey, signToken, stubJwks, type KeyPair } from './helpers'
// 入口そのもの（Pages Functions のファイル）を読む。DB の接続と、通知の送信（drainDeliveries）だけ差し替える
import { onRequestPost as agentPost } from '../../../functions/api/agent/[method]'
import { onRequestPost as rpcPost } from '../../../functions/api/rpc/[method]'

// 応答を返したあとの後始末（waitUntil）：書き込みが成功したときだけ通知を急ぎで送ってみて、そのあとで接続を閉じる。
// 偽の waitUntil に渡った Promise の順番（drain → 接続を閉じる）を、出来事の記録で確かめる

const holder = vi.hoisted(() => ({
  sql: undefined as unknown as object,
  /** 起きたことを順に。'drain:start' / 'drain:end' / 'end'（接続を閉じた） */
  events: [] as string[],
  drains: [] as Array<{ env: unknown; opts: unknown }>,
  /** 設定すると、drain はこれが解けるまで終わらない（応答が先に返ることの確認） */
  gate: null as Promise<void> | null,
  drainError: null as Error | null,
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
      if (holder.drainError) throw holder.drainError
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
  key = await makeKey('after-response-key')
  stubJwks([key])
  member = await newMember(dom, 'after-response')
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
  holder.drainError = null
})

afterEach(() => {
  vi.restoreAllMocks()
})

interface Call {
  args?: unknown[]
  /** Authorization ヘッダの中身。省略は member の JWT、null は付けない */
  auth?: string | null
  env?: Record<string, unknown>
}

async function invoke(fn: typeof rpcPost, method: string, c: Call = {}) {
  const auth = c.auth === undefined ? `Bearer ${await signToken({ key, sub: member.userId })}` : c.auth
  const request = new Request(`https://soroban.example/api/rpc/${method}`, {
    method: 'POST',
    headers: auth === null ? {} : { authorization: auth },
    body: JSON.stringify({ args: c.args ?? [] }),
  })
  const waited: Promise<unknown>[] = []
  const response = await fn({
    request,
    env: { DATABASE_URL: 'postgres://u:p@db.example:5432/postgres', SUPABASE_URL, ...vapid.env, ...c.env },
    params: { method },
    waitUntil: (p) => void waited.push(p),
  })
  // 応答は返っている。waitUntil に渡った後始末が終わるのを待つのは、呼んだ側が done() で行う
  return { response, done: () => Promise.all(waited) }
}

const newTagName = () => `タグ-${randomUUID().slice(0, 8)}`

describe('画面の API（/api/rpc）', () => {
  it('書き込みが成功したら、応答を返したあとに通知を急ぎで送り、そのあとで接続を閉じる', async () => {
    let release!: () => void
    holder.gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const r = await invoke(rpcPost, 'createTag', { args: [newTagName()] })
    expect(r.response.status).toBe(200)
    // 応答は返った。送信は始まっているが終わっていない。接続はまだ閉じていない（先に閉じると送れない）
    expect(holder.events).toEqual(['drain:start'])

    release()
    await r.done()
    expect(holder.events).toEqual(['drain:start', 'drain:end', 'end'])
    expect(holder.drains).toHaveLength(1)
    expect(holder.drains[0].opts).toEqual({ limit: 5 })
    // 鍵は入口の環境変数をそのまま渡す（無ければ drainDeliveries が何もしない）
    expect(holder.drains[0].env).toMatchObject({ VAPID_PUBLIC_KEY: vapid.env.VAPID_PUBLIC_KEY })
  })

  it('読み取りだけのメソッドでは送らない（接続を閉じるだけ）', async () => {
    const r = await invoke(rpcPost, 'getSettings')
    await r.done()
    expect(r.response.status).toBe(200)
    expect(holder.events).toEqual(['end'])
    expect(holder.drains).toHaveLength(0)
  })

  it('失敗した要求（未認証・知らないメソッド・業務のエラー）では送らない。接続は閉じる', async () => {
    for (const [method, c] of [
      ['createTag', { auth: null }],
      ['noSuchMethod', {}],
      ['createTag', { args: [] }], // 名前が無い → 業務のエラー
    ] as Array<[string, Call]>) {
      holder.events.length = 0
      const r = await invoke(rpcPost, method, c)
      await r.done()
      expect(r.response.ok, method).toBe(false)
      expect(holder.events, method).toEqual(['end'])
    }
    expect(holder.drains).toHaveLength(0)
  })

  it('送信が失敗しても応答は変わらず、接続は閉じる。ログに秘密は出ない', async () => {
    holder.drainError = new Error('配送を取れませんでした')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    const r = await invoke(rpcPost, 'createTag', { args: [newTagName()] })
    await r.done()
    expect(r.response.status).toBe(200)
    expect(holder.events).toEqual(['drain:start', 'end'])
    expect(log).toHaveBeenCalled()
    const logged = JSON.stringify(log.mock.calls)
    expect(logged).toContain('配送を取れませんでした')
    expect(logged).not.toContain(vapid.env.VAPID_PRIVATE_KEY)
  })

  it('メソッドの判定：成功して、読み取りだけではない書き込みだけが true', () => {
    const ok = new Response('{}', { status: 200 })
    const bad = new Response('{}', { status: 400 })
    expect(mayQueueNotification('updateSale', ok)).toBe(true)
    expect(mayQueueNotification('updateSale', bad)).toBe(false)
    for (const read of ['getInbox', 'listSales', 'getSettings', 'getPushConfig', 'getCollectStatus']) {
      expect(mayQueueNotification(read, ok), read).toBe(false)
    }
  })
})

describe('取り込み担当の PC の API（/api/agent）', () => {
  it('鍵を出す register・権限を取る claim では送らない。販売などの取り込みが成功したら送る', async () => {
    const reg = await invoke(agentPost, 'register', { args: ['テストの PC'] })
    await reg.done()
    expect(reg.response.status).toBe(200)
    expect(holder.events).toEqual(['end'])
    const token = (JSON.parse(await reg.response.text()) as { result: { token: string } }).result.token

    const original = agentHandlers.ingestYahooSales
    agentHandlers.ingestYahooSales = async () => ({ ok: true })
    try {
      holder.events.length = 0
      const claim = await invoke(agentPost, 'claim', { auth: `Agent ${token}` })
      await claim.done()
      expect(holder.events).toEqual(['end'])

      holder.events.length = 0
      const ingest = await invoke(agentPost, 'ingestYahooSales', { auth: `Agent ${token}` })
      expect(ingest.response.status).toBe(200)
      await ingest.done()
      expect(holder.events).toEqual(['drain:start', 'drain:end', 'end'])
      expect(holder.drains[0].opts).toEqual({ limit: 5 })
    } finally {
      if (original) agentHandlers.ingestYahooSales = original
      else delete agentHandlers.ingestYahooSales
    }
  })

  it('メソッドの判定：失敗したもの・通知を積まないメソッドは false', () => {
    const ok = new Response('{}', { status: 200 })
    const bad = new Response('{}', { status: 409 })
    expect(agentMayQueueNotification('ingestSoldPage', ok)).toBe(true)
    expect(agentMayQueueNotification('finish', ok)).toBe(true)
    expect(agentMayQueueNotification('finish', bad)).toBe(false)
    for (const quiet of ['register', 'claim', 'heartbeat', 'getCollectPlan', 'existingImportKeys']) {
      expect(agentMayQueueNotification(quiet, ok), quiet).toBe(false)
    }
  })
})
