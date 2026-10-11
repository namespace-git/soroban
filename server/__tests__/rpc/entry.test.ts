import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openPglite, type PgliteSql } from '../../db/pglite'
import { UserError } from '../../errors'
import { handlers, registerHandler } from '../../rpc'
import { SUPABASE_URL, USER_A, USER_NOBODY, makeKey, setupSchema, signToken, stubJwks, type KeyPair } from './helpers'
// 入口そのもの（Pages Functions のファイル）を読む。DB の接続だけ PGlite に差し替える
import { onRequest, onRequestPost } from '../../../functions/api/rpc/[method]'

const holder = vi.hoisted(() => ({
  sql: undefined as unknown as object,
  created: [] as Array<{ url: string; options: unknown }>,
  ended: 0,
}))

vi.mock('../../db/postgres', () => ({
  createPostgresSql: (url: string, options: unknown) => {
    holder.created.push({ url, options })
    return { ...holder.sql, end: async () => void holder.ended++ }
  },
}))

let db: PgliteSql
let key: KeyPair

beforeAll(async () => {
  db = await openPglite()
  await setupSchema(db.pg)
  holder.sql = db
  key = await makeKey('entry-key')
  stubJwks([key])
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await db.close()
})

beforeEach(() => {
  holder.created.length = 0
  holder.ended = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const name of Object.keys(handlers)) delete handlers[name as keyof typeof handlers]
})

interface Call {
  method?: string
  httpMethod?: string
  token?: string | null
  body?: string
  env?: Record<string, unknown>
}

async function invoke(fn: typeof onRequestPost, c: Call = {}) {
  const token = c.token === undefined ? await signToken({ key }) : c.token
  const request = new Request(`https://soroban.example/api/rpc/${c.method ?? 'getSettings'}`, {
    method: c.httpMethod ?? 'POST',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body: c.httpMethod === 'GET' ? undefined : (c.body ?? '{"args":[]}'),
  })
  const waited: Promise<unknown>[] = []
  const response = await fn({
    request,
    env: { DATABASE_URL: 'postgres://u:p@db.example:5432/postgres', SUPABASE_URL, ...c.env },
    params: { method: c.method ?? 'getSettings' },
    waitUntil: (p) => void waited.push(p),
  })
  await Promise.all(waited)
  return { response, status: response.status, json: JSON.parse(await response.text()) as { result?: unknown; error?: { code: string; message: string } } }
}

describe('Pages Functions の入口', () => {
  it('POST 以外は 405（Allow: POST）。DB には触らない', async () => {
    for (const fn of [onRequest, onRequestPost]) {
      for (const httpMethod of ['GET', 'PUT', 'DELETE', 'PATCH']) {
        const r = await invoke(fn, { httpMethod })
        expect(r.status, httpMethod).toBe(405)
        expect(r.response.headers.get('allow')).toBe('POST')
      }
    }
    expect(holder.created).toHaveLength(0)
  })

  it('トークンが無ければ 401', async () => {
    const r = await invoke(onRequestPost, { token: null })
    expect(r.status).toBe(401)
    expect(r.json.error?.code).toBe('unauthorized')
  })

  it('世帯に属さないユーザーは 403', async () => {
    const r = await invoke(onRequestPost, { token: await signToken({ key, sub: USER_NOBODY }) })
    expect(r.status).toBe(403)
    expect(r.json.error?.code).toBe('forbidden')
  })

  it('知らないメソッドは 404、契約にあるが未実装は 501', async () => {
    expect((await invoke(onRequestPost, { method: 'noSuchMethod' })).status).toBe(404)
    const r = await invoke(onRequestPost, { method: 'listSales' })
    expect(r.status).toBe(501)
    expect(r.json.error?.message).toBe('Web 版ではまだ使えません：listSales')
  })

  it('本文が壊れていれば 400', async () => {
    const r = await invoke(onRequestPost, { body: '{broken' })
    expect(r.status).toBe(400)
    expect(r.json.error?.code).toBe('bad_request')
  })

  it('登録したハンドラで 200。onRequest（POST）も同じ', async () => {
    registerHandler('getSettings', async (ctx) => ({ household: ctx.householdId, user: ctx.userId }))
    for (const fn of [onRequestPost, onRequest]) {
      const r = await invoke(fn)
      expect(r.status).toBe(200)
      expect(r.json.result).toEqual({ household: '00000000-0000-4000-8000-00000000000a', user: USER_A })
    }
  })

  it('UserError の日本語はそのまま、それ以外の例外は internal で漏らさない', async () => {
    registerHandler('deleteSale', async () => {
      throw new UserError('販売が見つかりません', 'not_found')
    })
    registerHandler('deleteTag', async (ctx) => {
      await ctx.sql.get('select * from secret_table')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = await invoke(onRequestPost, { method: 'deleteSale' })
    expect(user.status).toBe(404)
    expect(user.json.error).toEqual({ code: 'not_found', message: '販売が見つかりません' })
    const internal = await invoke(onRequestPost, { method: 'deleteTag' })
    expect(internal.status).toBe(500)
    expect(internal.json.error?.code).toBe('internal')
    expect(JSON.stringify(internal.json)).not.toContain('secret_table')
  })

  it('1 リクエストにつき接続を 1 つ作り、応答の後で閉じる（waitUntil）', async () => {
    registerHandler('getSettings', async () => ({}))
    await invoke(onRequestPost)
    await invoke(onRequestPost, { token: null })
    expect(holder.created).toHaveLength(2)
    expect(holder.ended).toBe(2)
  })

  describe('接続の設定', () => {
    it('既定は DATABASE_URL・prepare あり（Hyperdrive 前提）', async () => {
      await invoke(onRequestPost)
      expect(holder.created[0]).toEqual({ url: 'postgres://u:p@db.example:5432/postgres', options: { prepare: true } })
    })

    it('HYPERDRIVE のバインディングがあれば、DATABASE_URL より先に使う', async () => {
      await invoke(onRequestPost, { env: { HYPERDRIVE: { connectionString: 'postgres://hd@abc.hyperdrive.local:5432/postgres' } } })
      expect(holder.created[0].url).toBe('postgres://hd@abc.hyperdrive.local:5432/postgres')
    })

    it('DATABASE_PREPARE=false で prepare を切る（transaction モードのプーラ直つなぎ）', async () => {
      await invoke(onRequestPost, { env: { DATABASE_PREPARE: 'false' } })
      expect(holder.created[0].options).toEqual({ prepare: false })
    })

    it('接続先が無ければ 500 internal（設定の名前や値は出さない）', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const r = await invoke(onRequestPost, { env: { DATABASE_URL: undefined, HYPERDRIVE: undefined } })
      expect(r.status).toBe(500)
      expect(r.json.error?.code).toBe('internal')
      expect(JSON.stringify(r.json)).not.toContain('DATABASE_URL')
      expect(log).toHaveBeenCalled()
      expect(holder.created).toHaveLength(0)
    })
  })
})
