import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchAgent, type AgentHandlers } from '../../agent/index'
import { handleRpc } from '../../rpc'
import { spyConsole } from '../integrations/helpers'
import { openDomainDb, type DomainDb } from '../domain/helpers'
import { makeKey, signToken, stubJwks, type KeyPair } from '../rpc/helpers'
import { ANON_KEY, geminiOk, newUploadWorld, readyDraft, type UploadWorld } from './helpers'

// 入口（handleRpc）から Ctx までの道：検証済みの Authorization のトークンが Ctx.userJwt になり、Storage をその人の権限で呼ぶ。
// agent（取り込み担当の PC）の Ctx では null。トークン・anon キー・Gemini の鍵は応答にもログにも出ない。
// 入口の検証は本物（ES256 の鍵を作り、JWKS の取得だけグローバルの fetch に差す）。Storage・Gemini は偽の fetch（deps.fetch）。

let db: DomainDb
let world: UploadWorld
let key: KeyPair

beforeAll(async () => {
  db = await openDomainDb()
  key = await makeKey('upload-entry-key')
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  world = await newUploadWorld(db)
  stubJwks([key])
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function viaEntry(token: string, method: string, ...args: unknown[]) {
  const request = new Request(`https://soroban.example/api/rpc/${method}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ args }),
  })
  const response = await handleRpc(request, method, { root: db.root, env: world.env, fetch: world.backend.fetch, sleep: world.backend.sleep })
  const text = await response.text()
  return { status: response.status, text, body: JSON.parse(text) as { result?: any; error?: { code: string; message: string } } }
}

describe('入口 → Ctx.userJwt', () => {
  it('検証を通ったトークンで Storage を呼ぶ：置き場所 → 上げる → 経費に付ける → 一覧 → AI で読む → 外す。トークン・鍵はどこにも出ない', async () => {
    const token = await signToken({ key, sub: world.a.userId })
    world.backend.jwtHousehold.set(token, world.a.householdId) // 偽の Storage が、このトークンを A の世帯の人として扱う
    const geminiKey = 'gemini-key-for-entry-test-1234567890'
    world.backend.gemini = () => geminiOk(readyDraft())

    const spy = spyConsole()
    const texts: string[] = []
    try {
      const run = async (method: string, ...args: unknown[]) => {
        const r = await viaEntry(token, method, ...args)
        texts.push(r.text)
        return r
      }
      expect((await run('setGeminiApiKey', geminiKey)).status).toBe(200)
      const prepared = await run('prepareUpload', 'receipt', 'jpg')
      const { bucket, path } = prepared.body.result as { bucket: string; path: string }
      expect(bucket).toBe('receipts')
      world.backend.put(bucket, path)

      const expense = (await run('createExpense', { occurred_at: '2026-09-10', category: 'packaging', amount: 880 })).body.result as string
      expect((await run('attachReceiptPath', expense, path)).body.result).toContain('/object/sign/receipts/')
      const list = await run('listExpenses')
      expect(list.body.result[0].receipt_url).toContain(path)
      const read = await run('readReceiptAt', path)
      expect(read.status).toBe(200)
      expect(read.body.result.draft.shop).toBe('ダイソー 川崎駅前店')
      expect(read.body.result.temp_file).toBe(path)
      expect((await run('removeReceipt', expense)).status).toBe(200)
      expect(world.backend.has('receipts', path)).toBe(false)
    } finally {
      spy.restore()
    }

    // Storage への呼び出しは、すべて入口で検証したそのトークンと anon キーで行われている
    const storageCalls = world.backend.calls.filter(c => c.kind !== 'gemini')
    expect(storageCalls.length).toBeGreaterThan(0)
    for (const c of storageCalls) {
      expect(c.authorization).toBe(`Bearer ${token}`)
      expect(c.apikey).toBe(ANON_KEY)
    }
    // Gemini には Storage のトークンも anon キーも送らない
    for (const c of world.backend.of('gemini')) {
      expect(JSON.stringify(c.body)).not.toContain(token)
      expect(c.geminiKey).toBe(geminiKey)
    }
    for (const text of [...texts, spy.text()]) {
      expect(text).not.toContain(token)
      expect(text).not.toContain(ANON_KEY)
      expect(text).not.toContain(geminiKey)
    }
  })

  it('他の人のトークンでは、その人の世帯のフォルダしか触れない（偽の Storage の方針の真似）。トークンが無い・壊れていれば入口で 401', async () => {
    const tokenA = await signToken({ key, sub: world.a.userId })
    const tokenB = await signToken({ key, sub: world.b.userId })
    world.backend.jwtHousehold.set(tokenA, world.a.householdId)
    world.backend.jwtHousehold.set(tokenB, world.b.householdId)
    const pa = (await viaEntry(tokenA, 'prepareUpload', 'receipt', 'jpg')).body.result.path as string
    world.backend.put('receipts', pa)
    const expenseA = (await viaEntry(tokenA, 'createExpense', { occurred_at: '2026-09-10', category: 'other', amount: 1 })).body.result as string
    expect((await viaEntry(tokenA, 'attachReceiptPath', expenseA, pa)).status).toBe(200)

    // B のトークンでは A の経費に触れない・A のパスは結べない
    world.backend.calls.length = 0
    expect((await viaEntry(tokenB, 'attachReceiptPath', expenseA, pa)).status).toBe(400)
    expect((await viaEntry(tokenB, 'removeReceipt', expenseA)).status).toBe(404)
    expect(world.backend.calls).toEqual([])
    expect(world.backend.has('receipts', pa)).toBe(true)

    // トークンが偽・形が違う → 入口で 401（Storage にも触れない）
    const bad = await viaEntry('not-a-jwt', 'prepareUpload', 'receipt', 'jpg')
    expect(bad.status).toBe(401)
    expect(world.backend.calls).toEqual([])
  })
})

describe('agent（取り込み担当の PC）の Ctx', () => {
  it('userJwt は null。afterCommit はあり、コミットの後に走る（ロールバックなら走らない）', async () => {
    const agentId = randomUUID()
    const ran: string[] = []
    let seen: { jwt: unknown; after: string } | undefined
    const handlers: AgentHandlers = {
      heartbeat: async (ctx) => {
        seen = { jwt: ctx.userJwt, after: typeof ctx.afterCommit }
        ctx.afterCommit(async () => { ran.push('committed') })
        return { ok: true } as never
      },
      finish: async (ctx) => {
        ctx.afterCommit(async () => { ran.push('rolled-back') })
        throw new Error('失敗')
      },
    }
    const base = { root: db.root, agent: { agentId, householdId: world.a.householdId }, env: world.env, handlers }
    const spy = spyConsole()
    try {
      expect((await dispatchAgent('heartbeat', [], base)).status).toBe(200)
      expect((await dispatchAgent('finish', [], base)).status).toBe(500)
    } finally {
      spy.restore()
    }
    expect(seen).toEqual({ jwt: null, after: 'function' })
    expect(ran).toEqual(['committed'])
  })
})
