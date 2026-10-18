// HTTP クライアント（api/http.ts）の「読み取りのまとめ送り」を固定する。
//   要求  POST <base>/rpc/_batch  本文 {"calls": [{"method", "args"}, …]}（1 束 MAX_CALLS_PER_BATCH 本まで。READ_ONLY_METHODS だけ）
//   成功  200 {"results": [{"result"} | {"error": {"code", "message"}}, …]}（同じ順・同じ数）
//   - 同じタイミング（setTimeout(0) の 1 回の区切り）で出た読み取りが 1 つの束になる。1 本だけなら今までどおり /rpc/<method>
//   - 束は MAX_CALLS_PER_BATCH（8）本ずつ。同時に飛ぶ束は MAX_CONCURRENT_BATCHES（5）つまで
//     （数字はテストに直書きせず、http.ts の定数から読む。サーバーの上限 25 より小さく送る）
//   - 書き込みはまとめず即送る。飛んでいる最中の同じ読み取りは束の中でも 1 本
//   - 1 本の error はその呼び出しだけ失敗、要求ごとの失敗は全員が同じ失敗
//   - サーバーが _batch を知らない（404／501）ときは 1 本ずつに戻し、以後まとめない
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { reactive } from 'vue'
import { createHttpApi, ApiError, MAX_CALLS_PER_BATCH, MAX_CONCURRENT_BATCHES } from '../http'
import { READ_ONLY_METHODS } from '../../../shared/read-only-methods'

/** サーバーが 1 回で受ける上限（server/rpc.ts の BATCH_MAX_CALLS）。画面の束はこれ以下でなければならない */
const SERVER_MAX_CALLS = 25

type Body = { args?: unknown[]; calls?: { method: string; args: unknown[] }[] }
type FetchCall = { url: string; init: RequestInit; body: Body }
type Rpc = Record<string, (...a: unknown[]) => Promise<unknown>>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 受け取った呼び出しをそのまま値にして返す（どの呼び出しの結果かを見分けるため） */
function echo(call: FetchCall): Response {
  if (call.url.endsWith('/rpc/_batch')) {
    return json(200, { results: call.body.calls!.map((c) => ({ result: { method: c.method, args: c.args } })) })
  }
  const method = decodeURIComponent(call.url.split('/rpc/')[1])
  return json(200, { result: { method, args: call.body.args } })
}

describe('createHttpApi の読み取りのまとめ送り（_batch）', () => {
  let calls: FetchCall[]
  let handler: (call: FetchCall) => Response | Promise<Response>
  let onUnauthorized: ReturnType<typeof vi.fn>
  let getToken: ReturnType<typeof vi.fn>
  let token: string | null

  function make() {
    return createHttpApi({ base: '/api', getToken, onUnauthorized })
  }
  function rpc() {
    return make() as unknown as Rpc
  }

  /** 区切りのタイマーを 1 回またぎ、そのあとのトークン待ちの数 tick を進める（fetch が呼ばれるところまで） */
  async function settle() {
    await new Promise<void>((r) => setTimeout(r, 0))
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  beforeEach(() => {
    calls = []
    token = 'jwt-abc'
    onUnauthorized = vi.fn()
    getToken = vi.fn(async () => token)
    handler = echo
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const call = { url, init, body: JSON.parse(init.body as string) as Body }
      calls.push(call)
      return handler(call)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('前提：テストで使うメソッドは読み取り、updateSale は書き込み', () => {
    for (const m of ['getDashboard', 'getInbox', 'listTags', 'listProducts', 'listSales', 'suggestInventory']) {
      expect(READ_ONLY_METHODS.has(m), m).toBe(true)
    }
    expect(READ_ONLY_METHODS.has('updateSale')).toBe(false)
  })

  it('Promise.all で並べた読み取り 5 本は fetch 1 回（_batch・順番どおり）。それぞれに正しい結果', async () => {
    const api = rpc()
    const results = await Promise.all([
      api.listTags(),
      api.listProducts({ q: 'a' }),
      api.getInbox(),
      api.suggestInventory('s1', 3),
      api.getDashboard(),
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/rpc/_batch')
    expect(calls[0].init.method).toBe('POST')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer jwt-abc')
    expect(headers['Content-Type']).toBe('application/json')
    expect(calls[0].body).toEqual({
      calls: [
        { method: 'listTags', args: [] },
        { method: 'listProducts', args: [{ q: 'a' }] },
        { method: 'getInbox', args: [] },
        { method: 'suggestInventory', args: ['s1', 3] },
        { method: 'getDashboard', args: [] },
      ],
    })
    expect(results).toEqual([
      { method: 'listTags', args: [] },
      { method: 'listProducts', args: [{ q: 'a' }] },
      { method: 'getInbox', args: [] },
      { method: 'suggestInventory', args: ['s1', 3] },
      { method: 'getDashboard', args: [] },
    ])
    expect(getToken).toHaveBeenCalledTimes(1)
  })

  it('読み取り 1 本だけなら、今までと同じ /rpc/<method>（まとめの包みを付けない）', async () => {
    const api = rpc()
    const r = await api.listSales({ onlyPending: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/rpc/listSales')
    expect(calls[0].body).toEqual({ args: [{ onlyPending: true }] })
    expect(r).toEqual({ method: 'listSales', args: [{ onlyPending: true }] })
  })

  it('await を挟んだ直後に出た読み取りも同じ束に入る（Promise.all で並べなくてもよい）', async () => {
    const api = rpc()
    const p1 = api.listTags()
    await Promise.resolve()
    await Promise.resolve()
    const p2 = api.listProducts()
    await Promise.resolve()
    const p3 = (async () => {
      await Promise.resolve()
      return api.getInbox()
    })()
    await Promise.all([p1, p2, p3])
    expect(calls).toHaveLength(1)
    expect(calls[0].body.calls!.map((c) => c.method)).toEqual(['listTags', 'listProducts', 'getInbox'])
  })

  it('区切り（タイマー）をまたいだ読み取りは別の束。1 本だけならまた /rpc/<method>', async () => {
    const api = rpc()
    const p1 = api.listTags()
    const p2 = api.listProducts()
    await settle()
    const p3 = api.getInbox()
    await Promise.all([p1, p2, p3])
    expect(calls.map((c) => c.url)).toEqual(['/api/rpc/_batch', '/api/rpc/getInbox'])
  })

  it('束の大きさは、サーバーの上限より小さく、同時の束は Hyperdrive の接続（10 本）に余裕を残す', () => {
    expect(MAX_CALLS_PER_BATCH).toBeGreaterThanOrEqual(1)
    expect(MAX_CALLS_PER_BATCH).toBeLessThanOrEqual(SERVER_MAX_CALLS)
    expect(MAX_CONCURRENT_BATCHES).toBeGreaterThanOrEqual(1)
    // まとめ以外の 1 本ずつの呼び出し（書き込みなど）の分の接続を残す
    expect(MAX_CONCURRENT_BATCHES).toBeLessThan(10)
  })

  it('束の上限を超えると複数の束に分かれる。順番どおりで、それぞれに正しい結果（トークンは束ごとに 1 回）', async () => {
    const api = rpc()
    // 満杯の束 2 つ + 5 本 ＝ 3 束（同時に飛べる束の数に収まる大きさ）
    const total = MAX_CALLS_PER_BATCH * 2 + 5
    expect(Math.ceil(total / MAX_CALLS_PER_BATCH)).toBeLessThanOrEqual(MAX_CONCURRENT_BATCHES)
    const results = await Promise.all(Array.from({ length: total }, (_, i) => api.listSales({ page: i })))
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.url)).toEqual(['/api/rpc/_batch', '/api/rpc/_batch', '/api/rpc/_batch'])
    expect(calls.map((c) => c.body.calls!.length)).toEqual([MAX_CALLS_PER_BATCH, MAX_CALLS_PER_BATCH, 5])
    expect(calls[0].body.calls![0].args).toEqual([{ page: 0 }])
    expect(calls[0].body.calls![MAX_CALLS_PER_BATCH - 1].args).toEqual([{ page: MAX_CALLS_PER_BATCH - 1 }])
    expect(calls[1].body.calls![0].args).toEqual([{ page: MAX_CALLS_PER_BATCH }])
    expect(calls[2].body.calls![0].args).toEqual([{ page: MAX_CALLS_PER_BATCH * 2 }])
    expect(results).toEqual(Array.from({ length: total }, (_, i) => ({ method: 'listSales', args: [{ page: i }] })))
    expect(getToken).toHaveBeenCalledTimes(3)
  })

  it('上限ちょうどは 1 束。1 本多いと満杯の束と 1 本の束（1 本のほうも _batch）', async () => {
    const api = rpc()
    await Promise.all(Array.from({ length: MAX_CALLS_PER_BATCH }, (_, i) => api.listSales({ page: i })))
    expect(calls.map((c) => c.body.calls!.length)).toEqual([MAX_CALLS_PER_BATCH])
    calls.length = 0
    await Promise.all(Array.from({ length: MAX_CALLS_PER_BATCH + 1 }, (_, i) => api.listSales({ page: i })))
    expect(calls.map((c) => [c.url, c.body.calls!.length])).toEqual([['/api/rpc/_batch', MAX_CALLS_PER_BATCH], ['/api/rpc/_batch', 1]])
  })

  it('束はサーバーの上限（25 本）を超えない。大きな塊でも、どの束も MAX_CALLS_PER_BATCH 以下', async () => {
    const api = rpc()
    const total = SERVER_MAX_CALLS * 4 + 3
    const results = await Promise.all(Array.from({ length: total }, (_, i) => api.listSales({ page: i })))
    expect(results).toHaveLength(total)
    for (const c of calls) expect(c.body.calls!.length).toBeLessThanOrEqual(MAX_CALLS_PER_BATCH)
    expect(calls.reduce((n, c) => n + c.body.calls!.length, 0)).toBe(total)
  })

  it('同時に飛ぶ束は MAX_CONCURRENT_BATCHES まで。前の束が終わると次が飛ぶ', async () => {
    const waiting: { call: FetchCall; resolve(res: Response): void }[] = []
    handler = (call) => new Promise<Response>((resolve) => waiting.push({ call, resolve }))
    const api = rpc()
    // 満杯の束 (MAX_CONCURRENT_BATCHES + 1) 個 + 3 本
    const fullBundles = MAX_CONCURRENT_BATCHES + 1
    const total = MAX_CALLS_PER_BATCH * fullBundles + 3
    const ps = Array.from({ length: total }, (_, i) => api.listSales({ page: i }))
    await settle()
    expect(calls).toHaveLength(MAX_CONCURRENT_BATCHES)
    expect(calls.map((c) => c.body.calls!.length)).toEqual(Array(MAX_CONCURRENT_BATCHES).fill(MAX_CALLS_PER_BATCH))

    // 先頭の束が終わると、次の満杯の束が飛ぶ
    waiting[0].resolve(echo(waiting[0].call))
    await settle()
    expect(calls).toHaveLength(MAX_CONCURRENT_BATCHES + 1)
    expect(calls[MAX_CONCURRENT_BATCHES].body.calls![0].args).toEqual([{ page: MAX_CALLS_PER_BATCH * MAX_CONCURRENT_BATCHES }])
    expect(calls[MAX_CONCURRENT_BATCHES].body.calls!.length).toBe(MAX_CALLS_PER_BATCH)

    // もう 1 つ終わると、最後の 3 本の束が飛ぶ
    waiting[1].resolve(echo(waiting[1].call))
    await settle()
    expect(calls).toHaveLength(MAX_CONCURRENT_BATCHES + 2)
    expect(calls[MAX_CONCURRENT_BATCHES + 1].body.calls!.length).toBe(3)

    // 同時に飛んでいるのは常に MAX_CONCURRENT_BATCHES 以内（残りを全部返して、全員に正しい結果が届く）
    for (let i = 2; i < waiting.length; i++) waiting[i].resolve(echo(waiting[i].call))
    await settle()
    const results = await Promise.all(ps)
    expect(results).toEqual(Array.from({ length: total }, (_, i) => ({ method: 'listSales', args: [{ page: i }] })))
    expect(calls).toHaveLength(MAX_CONCURRENT_BATCHES + 2)
  })

  it('束の中の 1 本が error なら、その呼び出しだけ ApiError（code・message）。他は成功', async () => {
    handler = () =>
      json(200, {
        results: [
          { result: 'a' },
          { error: { code: 'not_found', message: '仕入が見つかりません' } },
          { result: null },
        ],
      })
    const api = rpc()
    const r = await Promise.all([
      api.listTags().catch((e: unknown) => e),
      api.getPurchase('x').catch((e: unknown) => e),
      api.getInbox().catch((e: unknown) => e),
    ])
    expect(r[0]).toBe('a')
    expect(r[1]).toBeInstanceOf(ApiError)
    expect((r[1] as ApiError).code).toBe('not_found')
    expect((r[1] as ApiError).message).toBe('仕入が見つかりません')
    expect(r[2]).toBeNull()
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('result も error も無い 1 件は成功にしない（その呼び出しだけ失敗）', async () => {
    handler = () => json(200, { results: [{ result: 1 }, {}] })
    const api = rpc()
    const r = await Promise.all([api.listTags(), api.getInbox().catch((e: unknown) => e)])
    expect(r[0]).toBe(1)
    expect((r[1] as ApiError).code).toBe('server_error')
    expect((r[1] as ApiError).message).toBe('サーバーから想定外の応答がありました（200）')
  })

  it('要求全体が 500 なら、まとめた全員が同じ ApiError（本文のあるとき・無いとき）', async () => {
    handler = () => json(500, { error: { code: 'server_error', message: 'データベースにつながりません' } })
    const api = rpc()
    const r1 = await Promise.all([api.listTags(), api.getInbox(), api.listProducts()].map((p) => p.catch((e: unknown) => e)))
    for (const e of r1) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).code).toBe('server_error')
      expect((e as ApiError).message).toBe('データベースにつながりません')
    }
    expect(calls).toHaveLength(1)

    handler = () => new Response('Bad Gateway', { status: 502 })
    const r2 = await Promise.all([api.listTags(), api.getInbox()].map((p) => p.catch((e: unknown) => e)))
    for (const e of r2) {
      expect((e as ApiError).code).toBe('server_error')
      expect((e as ApiError).message).toBe('サーバーでエラーが起きました（502）')
    }
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('JSON でない 200・results の数が合わない応答も、全員が失敗（成功にしない）', async () => {
    handler = () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    const api = rpc()
    const r1 = await Promise.all([api.listTags(), api.getInbox()].map((p) => p.catch((e: unknown) => e)))
    for (const e of r1) expect((e as ApiError).message).toBe('サーバーから想定外の応答がありました（200）')

    handler = () => json(200, { results: [{ result: 1 }] })
    const r2 = await Promise.all([api.listTags(), api.getInbox()].map((p) => p.catch((e: unknown) => e)))
    for (const e of r2) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).message).toBe('サーバーから想定外の応答がありました（200）')
    }
  })

  it('通信そのものの失敗は、全員が同じ日本語の ApiError。ログアウトはさせない', async () => {
    handler = () => {
      throw new TypeError('Failed to fetch')
    }
    const api = rpc()
    const r = await Promise.all([api.listTags(), api.getInbox(), api.listProducts()].map((p) => p.catch((e: unknown) => e)))
    for (const e of r) {
      expect((e as ApiError).code).toBe('network')
      expect((e as ApiError).message).toBe('サーバーにつながりません。通信の状態を確かめてください')
    }
    expect(calls).toHaveLength(1)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('書き込みは束に入らず即送る（読み取りと同時に出しても）。読み取りは区切りのあとに束で', async () => {
    const api = make()
    const rd = api as unknown as Rpc
    const p1 = rd.listTags()
    const w = api.updateSale('s1', { shippingCost: 700 } as never)
    const p2 = rd.getInbox()
    // 区切り（タイマー）を待たずに、書き込みだけが出ている
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(calls.map((c) => c.url)).toEqual(['/api/rpc/updateSale'])
    expect(calls[0].body).toEqual({ args: ['s1', { shippingCost: 700 }] })
    await Promise.all([p1, w, p2])
    expect(calls.map((c) => c.url)).toEqual(['/api/rpc/updateSale', '/api/rpc/_batch'])
    expect(calls[1].body.calls!.map((c) => c.method)).toEqual(['listTags', 'getInbox'])
  })

  it('書き込みどうしは、同じ引数でも 1 本にまとめず、すべて別々に送る', async () => {
    const api = make()
    const patch = { shippingCost: 700 } as never
    await Promise.all([api.updateSale('s1', patch), api.updateSale('s1', patch), api.updateSale('s1', patch)])
    expect(calls.map((c) => c.url)).toEqual(['/api/rpc/updateSale', '/api/rpc/updateSale', '/api/rpc/updateSale'])
  })

  it('同じ読み取りの相乗り（同じ method・同じ引数を同時に 3 本）は、束の中でも 1 本。3 人に別々のコピー', async () => {
    const api = rpc()
    const [a, b, c, other] = (await Promise.all([
      api.getDashboard(),
      api.getDashboard(),
      api.getDashboard(),
      api.listTags(),
    ])) as { method: string; args: unknown[] }[]
    expect(calls).toHaveLength(1)
    expect(calls[0].body.calls).toEqual([
      { method: 'getDashboard', args: [] },
      { method: 'listTags', args: [] },
    ])
    expect(a).toEqual({ method: 'getDashboard', args: [] })
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
    expect(other.method).toBe('listTags')
  })

  it('引数は 1 本ずつ送るときと同じ規則（末尾の undefined は落とす・リアクティブは素の値）', async () => {
    const api = rpc()
    const input = reactive({ stage: 'listed', nested: { a: [1, 2, 3] } })
    await Promise.all([api.listSales(undefined), api.listProducts(input), api.suggestInventory('s1', undefined, undefined)])
    expect(calls[0].body.calls).toEqual([
      { method: 'listSales', args: [] },
      { method: 'listProducts', args: [{ stage: 'listed', nested: { a: [1, 2, 3] } }] },
      { method: 'suggestInventory', args: ['s1'] },
    ])
  })

  it('呼び出した時点の引数で固める（送る前に画面が引数を書き換えても、送る中身は変わらない）', async () => {
    const api = rpc()
    const arg = { q: 'before' }
    const p1 = api.listProducts(arg)
    const p2 = api.listTags()
    arg.q = 'after'
    await Promise.all([p1, p2])
    expect(calls[0].body.calls![0].args).toEqual([{ q: 'before' }])
  })

  describe('古いサーバー（_batch を知らない）への保険', () => {
    const notFound = () => json(404, { error: { code: 'not_found', message: 'そのメソッドはありません：_batch' } })

    it('404（not_found）なら、その束の呼び出しを 1 本ずつ送り直し、次からはまとめない', async () => {
      handler = (call) => (call.url.endsWith('/rpc/_batch') ? notFound() : echo(call))
      const api = rpc()
      const r1 = await Promise.all([api.listTags(), api.getInbox(), api.listProducts({ q: 'a' })])
      // まず _batch を試し、404 を受けて 3 本を 1 本ずつ送り直した
      expect(calls.map((c) => c.url)).toEqual(['/api/rpc/_batch', '/api/rpc/listTags', '/api/rpc/getInbox', '/api/rpc/listProducts'])
      expect(calls[3].body).toEqual({ args: [{ q: 'a' }] })
      expect(r1).toEqual([
        { method: 'listTags', args: [] },
        { method: 'getInbox', args: [] },
        { method: 'listProducts', args: [{ q: 'a' }] },
      ])
      expect(onUnauthorized).not.toHaveBeenCalled()

      // 次からは _batch を試さない（区切りも待たずに 1 本ずつ即送る）
      calls.length = 0
      const p = [api.listTags(), api.getInbox()]
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(calls.map((c) => c.url)).toEqual(['/api/rpc/listTags', '/api/rpc/getInbox'])
      expect(await Promise.all(p)).toEqual([
        { method: 'listTags', args: [] },
        { method: 'getInbox', args: [] },
      ])
    })

    it('501 でも同じ。送り直した 1 本の失敗は、その呼び出しだけ（他は成功）', async () => {
      handler = (call) => {
        if (call.url.endsWith('/rpc/_batch')) return json(501, { error: { code: 'not_implemented', message: 'まだ使えません' } })
        if (call.url.endsWith('/rpc/getInbox')) return json(400, { error: { code: 'bad_request', message: '入力が違います' } })
        return echo(call)
      }
      const api = rpc()
      const r = await Promise.all([api.listTags(), api.getInbox().catch((e: unknown) => e)])
      expect(r[0]).toEqual({ method: 'listTags', args: [] })
      expect((r[1] as ApiError).code).toBe('bad_request')
      expect((r[1] as ApiError).message).toBe('入力が違います')
    })

    it('同時に飛ばせず待っていた束も、まとめをやめたあとは _batch を試さず 1 本ずつ送る', async () => {
      handler = (call) => (call.url.endsWith('/rpc/_batch') ? notFound() : echo(call))
      const api = rpc()
      // 満杯の束 (MAX_CONCURRENT_BATCHES + 1) 個（MAX_CONCURRENT_BATCHES 束が同時に飛び、最後の 1 束は待つ）。
      // 先に飛んだ束は全部 404 で、待っていた最後の束は _batch を試されない
      const total = MAX_CALLS_PER_BATCH * (MAX_CONCURRENT_BATCHES + 1)
      const results = await Promise.all(Array.from({ length: total }, (_, i) => api.listSales({ page: i })))
      expect(results).toEqual(Array.from({ length: total }, (_, i) => ({ method: 'listSales', args: [{ page: i }] })))
      expect(calls.filter((c) => c.url.endsWith('/rpc/_batch'))).toHaveLength(MAX_CONCURRENT_BATCHES)
      expect(calls.filter((c) => c.url.endsWith('/rpc/listSales'))).toHaveLength(total)
    })
  })

  describe('認証', () => {
    it("束の中の 1 本が 'unauthorized' なら onUnauthorized を呼ぶ（束につき 1 回）。その呼び出しは code 'unauthorized'", async () => {
      handler = () =>
        json(200, {
          results: [
            { result: 1 },
            { error: { code: 'unauthorized', message: 'ログインの期限が切れました' } },
            { error: { code: 'unauthorized', message: 'ログインの期限が切れました' } },
          ],
        })
      const api = rpc()
      const r = await Promise.all([
        api.listTags().catch((e: unknown) => e),
        api.getInbox().catch((e: unknown) => e),
        api.listProducts().catch((e: unknown) => e),
      ])
      expect(r[0]).toBe(1)
      expect((r[1] as ApiError).code).toBe('unauthorized')
      expect((r[1] as ApiError).message).toBe('ログインの期限が切れました')
      expect((r[2] as ApiError).code).toBe('unauthorized')
      expect(onUnauthorized).toHaveBeenCalledTimes(1)
    })

    it('要求全体が 401 なら、全員が unauthorized で、ログインへは 1 回だけ戻す', async () => {
      handler = () => json(401, { error: { code: 'unauthorized', message: 'ログインの期限が切れました' } })
      const api = rpc()
      const r = await Promise.all([api.listTags(), api.getInbox(), api.listProducts()].map((p) => p.catch((e: unknown) => e)))
      for (const e of r) {
        expect((e as ApiError).code).toBe('unauthorized')
        expect((e as ApiError).message).toBe('ログインの期限が切れました')
      }
      expect(onUnauthorized).toHaveBeenCalledTimes(1)
    })

    it('本文の無い 401（ゲートウェイの形）も unauthorized', async () => {
      handler = () => new Response('', { status: 401 })
      const api = rpc()
      const r = await Promise.all([api.listTags(), api.getInbox()].map((p) => p.catch((e: unknown) => e)))
      for (const e of r) {
        expect((e as ApiError).code).toBe('unauthorized')
        expect((e as ApiError).message).toBe('ログインが必要です。もう一度ログインしてください')
      }
      expect(onUnauthorized).toHaveBeenCalledTimes(1)
    })

    it('トークンが無ければ通信せず、全員 unauthorized でログインへ戻す（束につき 1 回）', async () => {
      token = null
      const api = rpc()
      const r = await Promise.all([api.listTags(), api.getInbox()].map((p) => p.catch((e: unknown) => e)))
      for (const e of r) {
        expect((e as ApiError).code).toBe('unauthorized')
        expect((e as ApiError).message).toBe('ログインが必要です。もう一度ログインしてください')
      }
      expect(calls).toHaveLength(0)
      expect(onUnauthorized).toHaveBeenCalledTimes(1)
    })
  })
})
