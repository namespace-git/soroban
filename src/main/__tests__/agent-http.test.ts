import { describe, expect, it } from 'vitest'
import { AgentHttpError, LeaseLostError } from '../agent/errors'
import { createAgentHttp, type FetchFn } from '../agent/http'

// 取り込み担当の PC → Web 版のサーバーへの通信：Authorization の形、本文、失敗の写し方、やり直しの規則。
// 偽の fetch だけを使う（本物のサーバー・メルカリには通信しない）

const ORIGIN = 'https://soroban.pages.dev'
const KEY = `sbagent_${'K'.repeat(43)}`
const JWT = `eyJ.${'j'.repeat(60)}.sig`
const HOUSEHOLD = '11111111-1111-4111-8111-111111111111'

interface Seen { url: string; method: string; headers: Record<string, string>; body: { args: unknown[] }; init: RequestInit }

function server(handler: (seen: Seen, n: number) => Response | Promise<Response>): { fetch: FetchFn; seen: Seen[]; sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const seen: Seen[] = []
  const sleeps: number[] = []
  return {
    seen,
    sleeps,
    sleep: async (ms) => { sleeps.push(ms) },
    fetch: async (url, init) => {
      const record: Seen = {
        url,
        method: String(init.method),
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
        init,
      }
      seen.push(record)
      return handler(record, seen.length)
    },
  }
}

const ok = (result: unknown): Response => new Response(JSON.stringify({ result }), { status: 200 })
const fail = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ error: { code, message } }), { status })

/** 失敗するはずの呼び出しの例外を取り出す */
async function caught(p: Promise<unknown>): Promise<AgentHttpError> {
  try {
    await p
  } catch (e) {
    return e as AgentHttpError
  }
  throw new Error('失敗するはずの呼び出しが成功しました')
}

function client(s: ReturnType<typeof server>, delays: readonly number[] = [1000, 3000]) {
  return createAgentHttp({ origin: ORIGIN, fetch: s.fetch, sleep: s.sleep, retryDelaysMs: delays })
}

describe('agent：Authorization: Agent <鍵> と本文', () => {
  it('POST /api/agent/<method>、Authorization は Agent <鍵>、本文は {"args":[…]}、結果は result', async () => {
    const s = server(() => ok({ job_id: 'j' }))
    const r = await client(s).agent('claim', [], KEY)
    expect(r).toEqual({ job_id: 'j' })
    expect(s.seen).toHaveLength(1)
    expect(s.seen[0].url).toBe(`${ORIGIN}/api/agent/claim`)
    expect(s.seen[0].method).toBe('POST')
    expect(s.seen[0].headers.Authorization).toBe(`Agent ${KEY}`)
    expect(s.seen[0].headers['Content-Type']).toBe('application/json')
    expect(s.seen[0].body).toEqual({ args: [] })
  })

  it('result が null でも成功（claim で取れる要求が無いとき）', async () => {
    const s = server(() => ok(null))
    expect(await client(s).agent('claim', [], KEY)).toBeNull()
  })

  it('リダイレクトは追わない・cookie は送らない（認証ヘッダを別の先へ出さない）', async () => {
    const s = server(() => ok(null))
    await client(s).agent('claim', [], KEY)
    expect(s.seen[0].init.redirect).toBe('error')
    expect(s.seen[0].init.credentials).toBe('omit')
  })

  it('末尾の / のある origin でも URL が二重にならない', async () => {
    const s = server(() => ok(null))
    await createAgentHttp({ origin: `${ORIGIN}/`, fetch: s.fetch, sleep: s.sleep }).agent('claim', [], KEY)
    expect(s.seen[0].url).toBe(`${ORIGIN}/api/agent/claim`)
  })
})

describe('register と rpc は人の JWT（Bearer）', () => {
  it('register は Bearer <JWT>。世帯の id つきの戻りだけ受ける', async () => {
    const reg = { agent_id: 'a', name: 'PC', household_id: HOUSEHOLD, token: KEY, expires_at: '2030-01-01T00:00:00.000Z' }
    const s = server(() => ok(reg))
    expect(await client(s).register('PC', JWT)).toEqual(reg)
    expect(s.seen[0].url).toBe(`${ORIGIN}/api/agent/register`)
    expect(s.seen[0].headers.Authorization).toBe(`Bearer ${JWT}`)
    expect(s.seen[0].body).toEqual({ args: ['PC'] })
  })

  it('世帯の id が無い（古いサーバー）・形が違う戻りは断る（取り込み担当にならない）', async () => {
    for (const reg of [
      { agent_id: 'a', name: 'PC', token: KEY, expires_at: '2030-01-01T00:00:00.000Z' },
      { agent_id: 'a', name: 'PC', household_id: 'not-a-uuid', token: KEY, expires_at: '2030-01-01T00:00:00.000Z' },
      { agent_id: 'a', name: 'PC', household_id: HOUSEHOLD, expires_at: '2030-01-01T00:00:00.000Z' },
      { agent_id: 'a', name: 'PC', household_id: HOUSEHOLD, token: KEY, expires_at: 'いつか' },
      null,
    ]) {
      const s = server(() => ok(reg))
      await expect(client(s).register('PC', JWT)).rejects.toThrow('Web 版を最新にしてください')
    }
  })

  it('rpc は /api/rpc/<method> を Bearer <JWT> で呼ぶ', async () => {
    const s = server(() => ok({ job: null }))
    await client(s).rpc('getCollectStatus', [], JWT)
    expect(s.seen[0].url).toBe(`${ORIGIN}/api/rpc/getCollectStatus`)
    expect(s.seen[0].headers.Authorization).toBe(`Bearer ${JWT}`)
  })
})

describe('失敗の写し方', () => {
  it('lease_lost（409）は専用の例外。やり直さない', async () => {
    const s = server(() => fail(409, 'lease_lost', '取り込みの権限が失効しています'))
    await expect(client(s).agent('heartbeat', [{}], KEY)).rejects.toBeInstanceOf(LeaseLostError)
    expect(s.seen).toHaveLength(1)
    expect(s.sleeps).toEqual([])
  })

  it('4xx はやり直さない。サーバーの日本語の文言とコードをそのまま写す', async () => {
    for (const [status, code] of [[400, 'bad_request'], [401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'], [409, 'conflict'], [429, 'conflict']] as const) {
      const s = server(() => fail(status, code, `エラー ${status}`))
      const err = await caught(client(s).agent('recordRun', [{}, {}], KEY))
      expect(err).toBeInstanceOf(AgentHttpError)
      expect(err).toMatchObject({ code, status, message: `エラー ${status}` })
      expect(s.seen, `${status}`).toHaveLength(1)
      expect(s.sleeps).toEqual([])
    }
  })

  it('5xx は 1 秒・3 秒の間隔で 3 回まで送り、最後まで失敗なら投げる', async () => {
    const s = server(() => fail(503, 'internal', '混み合っています'))
    const err = await caught(client(s).agent('ingestTrading', [{}, []], KEY))
    expect(err).toMatchObject({ code: 'internal', status: 503 })
    expect(s.seen).toHaveLength(3)
    expect(s.sleeps).toEqual([1000, 3000])
  })

  it('5xx のあと成功すればその結果を返す（段は冪等キーを持つので二重に入らない）', async () => {
    const s = server((_seen, n) => (n < 3 ? fail(502, 'internal', 'bad gateway') : ok({ already: true })))
    expect(await client(s).agent('ingestTrading', [{}, []], KEY)).toEqual({ already: true })
    expect(s.seen).toHaveLength(3)
  })

  it('通信切れ（fetch が投げる）もやり直す。英語の生のエラーは出さず日本語にする', async () => {
    let n = 0
    const s = server(() => ok(null))
    const flaky: FetchFn = async (url, init) => {
      n++
      if (n < 3) throw new TypeError('fetch failed')
      return s.fetch(url, init)
    }
    const http = createAgentHttp({ origin: ORIGIN, fetch: flaky, sleep: s.sleep })
    await http.agent('claim', [], KEY)
    expect(n).toBe(3)

    const down = createAgentHttp({
      origin: ORIGIN, sleep: s.sleep,
      fetch: async () => { throw new TypeError('fetch failed') },
    })
    const err = await caught(down.agent('claim', [], KEY))
    expect(err).toBeInstanceOf(AgentHttpError)
    expect(err).toMatchObject({ code: 'network', status: 0, message: 'サーバーにつながりません。通信の状態を確かめてください' })
    expect(err.message).not.toContain('fetch failed')
  })

  it('retry: false なら 5xx・通信切れでもやり直さない（claim・heartbeat は次の周期がある）', async () => {
    const s = server(() => fail(500, 'internal', 'ng'))
    await expect(client(s).agent('claim', [], KEY, { retry: false })).rejects.toBeInstanceOf(AgentHttpError)
    expect(s.seen).toHaveLength(1)
  })

  it('JSON でない応答（index.html など）は状態コードから日本語の文言を作る。200 でも result が無ければ失敗', async () => {
    const html = server(() => new Response('<html>', { status: 200 }))
    const e1 = await caught(client(html).agent('claim', [], KEY))
    expect(e1).toBeInstanceOf(AgentHttpError)
    expect(e1.message).toContain('想定外の応答')
    expect(html.seen).toHaveLength(1) // 200 はやり直さない

    const gw = server(() => new Response('Bad Gateway', { status: 502 }))
    const e2 = await caught(client(gw).agent('claim', [], KEY))
    expect(e2.message).toContain('502')
    expect(gw.seen).toHaveLength(3)
  })

  it('エラー文に鍵・JWT・lease_token を含めない', async () => {
    const lease = { job_id: 'j', lease_token: 'LEASE-SECRET-TOKEN' }
    const cases = [
      server(() => fail(500, 'internal', 'サーバーでエラーが起きました')),
      server(() => new Response('x', { status: 401 })),
      server(() => { throw new TypeError('fetch failed') }),
    ]
    for (const s of cases) {
      const err = await caught(client(s).agent('recordRun', [lease, {}], KEY))
      for (const secret of [KEY, JWT, 'LEASE-SECRET-TOKEN']) expect(String(err.message), secret).not.toContain(secret)
    }
  })
})
