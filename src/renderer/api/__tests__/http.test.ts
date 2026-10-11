// Web 版の HTTP クライアント（api/http.ts）の通信の契約を固定する。
//   要求  POST <base>/rpc/<method>  Authorization: Bearer <JWT>  本文 {"args": [...]}
//   成功  200 {"result": ...}
//   失敗  {"error": {"code", "message"}}  → throw new Error(message)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { reactive } from 'vue'
import { createHttpApi, ApiError } from '../http'

type FetchCall = { url: string; init: RequestInit }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('createHttpApi（HTTP 版の window.soroban）', () => {
  let calls: FetchCall[]
  let respond: () => Response | Promise<Response>
  let onUnauthorized: ReturnType<typeof vi.fn>
  let token: string | null

  function make(base = '/api') {
    return createHttpApi({ base, getToken: async () => token, onUnauthorized })
  }

  beforeEach(() => {
    calls = []
    token = 'jwt-abc'
    onUnauthorized = vi.fn()
    respond = () => json(200, { result: null })
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return respond()
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('契約どおりに POST し、result を返す', async () => {
    respond = () => json(200, { result: [{ id: 's1' }] })
    const api = make('/api')
    const r = await api.listSales({ onlyPending: true })
    expect(r).toEqual([{ id: 's1' }])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/rpc/listSales')
    expect(calls[0].init.method).toBe('POST')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer jwt-abc')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ args: [{ onlyPending: true }] })
  })

  it('base の末尾の / は取り、メソッド名は URL エンコードする', async () => {
    const api = make('https://example.test/api/')
    await api.getDashboard()
    expect(calls[0].url).toBe('https://example.test/api/rpc/getDashboard')
    await (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)['a/b']()
    expect(calls[1].url).toBe('https://example.test/api/rpc/a%2Fb')
  })

  it('末尾の undefined は落とす（JSON は配列の中の undefined を null にしてしまうため）', async () => {
    const api = make()
    await api.listSales(undefined)
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ args: [] })
    await api.logClient('error', 'x', undefined)
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ args: ['error', 'x'] })
  })

  it('Vue のリアクティブ（Proxy）を渡しても素の JSON になる（Electron の包みと同じ扱い）', async () => {
    const api = make()
    const input = reactive({ stage: 'listed', nested: { a: [1, 2, 3] } })
    await api.listSales(input as never)
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ args: [{ stage: 'listed', nested: { a: [1, 2, 3] } }] })
  })

  it('サーバーの失敗は Error(message)。画面は e.message をそのままトーストに出す', async () => {
    respond = () => json(400, { error: { code: 'bad_request', message: '送料を選んでください' } })
    const api = make()
    const err = await api.getDashboard().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('送料を選んでください')
    expect((err as ApiError).code).toBe('bad_request')
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it("code が 'unauthorized' ならログインに戻す", async () => {
    respond = () => json(401, { error: { code: 'unauthorized', message: 'ログインの期限が切れました' } })
    const api = make()
    await expect(api.getDashboard()).rejects.toThrow('ログインの期限が切れました')
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('トークンが無ければ通信せずにログインへ戻す', async () => {
    token = null
    const api = make()
    await expect(api.getDashboard()).rejects.toThrow('ログインが必要です')
    expect(calls).toHaveLength(0)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('本文の無い 401 も unauthorized として扱う（ゲートウェイが返す形）', async () => {
    respond = () => new Response('', { status: 401 })
    const api = make()
    await expect(api.getDashboard()).rejects.toThrow('ログインが必要です')
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('通信そのものの失敗は日本語にする（英語の生のエラーを出さない）。ログアウトはさせない', async () => {
    respond = () => { throw new TypeError('Failed to fetch') }
    const api = make()
    const err = await api.getDashboard().catch((e: unknown) => e)
    expect((err as Error).message).toBe('サーバーにつながりません。通信の状態を確かめてください')
    expect((err as ApiError).code).toBe('network')
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('JSON でない応答（API が無く index.html が返る等）は、読み取れなかったことを日本語で伝える', async () => {
    respond = () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    const api = make()
    await expect(api.getDashboard()).rejects.toThrow('サーバーから想定外の応答がありました（200）')
  })

  it('error も result も無い JSON は成功にしない', async () => {
    respond = () => json(200, { ok: true })
    const api = make()
    await expect(api.getDashboard()).rejects.toThrow('サーバーから想定外の応答がありました（200）')
  })

  it('5xx は状態コードつきの日本語', async () => {
    respond = () => new Response('Bad Gateway', { status: 502 })
    const api = make()
    await expect(api.getDashboard()).rejects.toThrow('サーバーでエラーが起きました（502）')
  })

  it('await や JSON 化で触られる then / toJSON / Symbol は関数にしない', () => {
    const api = make() as unknown as Record<string | symbol, unknown>
    expect(api.then).toBeUndefined()
    expect(api.toJSON).toBeUndefined()
    expect(api[Symbol.toPrimitive]).toBeUndefined()
    expect(typeof api.getDashboard).toBe('function')
  })
})
