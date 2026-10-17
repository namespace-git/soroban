// HTTP クライアント（api/http.ts）の「飛んでいる最中の重複まとめ」を固定する。
//   - 対象は READ_ONLY_METHODS の読み取りだけ。同時に出た同じメソッド・同じ引数は HTTP 1 本
//   - 結果は使い回さない（終わったら忘れる）。キャッシュではない
//   - 相乗りした呼び出しには別々のコピーを返す（画面が戻り値を書き換えても他に影響しない）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHttpApi, ApiError } from '../http'
import { READ_ONLY_METHODS } from '../../../shared/read-only-methods'

type FetchCall = { url: string; body: unknown }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 手で返事のタイミングを決められる fetch の 1 本 */
type Pending = { call: FetchCall; resolve(res: Response): void; reject(err: unknown): void }

describe('createHttpApi の重複まとめ（飛んでいる最中の同じ読み取り）', () => {
  let calls: FetchCall[]
  let pending: Pending[]
  let onUnauthorized: ReturnType<typeof vi.fn>

  function make() {
    return createHttpApi({ base: '/api', getToken: async () => 'jwt-abc', onUnauthorized })
  }

  /** fetch が実際に呼ばれるところまで（トークン待ちの数 tick）進める */
  async function flush() {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  beforeEach(() => {
    calls = []
    pending = []
    onUnauthorized = vi.fn()
    vi.stubGlobal(
      'fetch',
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const call = { url, body: JSON.parse(init.body as string) }
          calls.push(call)
          pending.push({ call, resolve, reject })
        }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('同時の同じ読み取り 3 本は fetch 1 回。3 つとも同じ値で、別のオブジェクト', async () => {
    const api = make()
    const p1 = api.getDashboard()
    const p2 = api.getDashboard()
    const p3 = api.getDashboard()
    await flush()
    expect(calls).toHaveLength(1)
    pending[0].resolve(json(200, { result: { month: '2026-10', rows: [{ id: 'a', profit: 100 }, { id: 'b', profit: 200 }] } }))
    const [r1, r2, r3] = (await Promise.all([p1, p2, p3])) as unknown as { month: string; rows: { id: string; profit: number }[] }[]
    expect(calls).toHaveLength(1)
    expect(r1).toEqual(r2)
    expect(r2).toEqual(r3)
    expect(r1).not.toBe(r2)
    expect(r2).not.toBe(r3)
    expect(r1.rows).not.toBe(r2.rows)
    // 片方を書き換えても、他方は変わらない
    r1.rows.reverse()
    r1.rows[0].profit = -1
    r1.month = 'changed'
    expect(r2.rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(r2.rows[0].profit).toBe(100)
    expect(r3.month).toBe('2026-10')
  })

  it('飛んでいる最中なら、あとから呼んだものも相乗りする', async () => {
    const api = make()
    const p1 = api.getInbox()
    await flush()
    const p2 = api.getInbox()
    await flush()
    expect(calls).toHaveLength(1)
    pending[0].resolve(json(200, { result: [{ id: 'x' }] }))
    expect(await p1).toEqual([{ id: 'x' }])
    expect(await p2).toEqual([{ id: 'x' }])
  })

  it('末尾の undefined の有無だけが違う呼び出しは、同じ本文なので 1 本にまとまる', async () => {
    const api = make()
    const p1 = api.listSales()
    const p2 = api.listSales(undefined)
    await flush()
    expect(calls).toHaveLength(1)
    pending[0].resolve(json(200, { result: [] }))
    await Promise.all([p1, p2])
  })

  it('引数が違えば別々に送る（メソッドが違っても別々）', async () => {
    const api = make()
    const p1 = api.listSales({ onlyPending: true })
    const p2 = api.listSales({ onlyPending: false })
    const p3 = api.listSales()
    const p4 = api.getDashboard()
    await flush()
    expect(calls).toHaveLength(4)
    expect(calls.map((c) => c.url)).toEqual(['/api/rpc/listSales', '/api/rpc/listSales', '/api/rpc/listSales', '/api/rpc/getDashboard'])
    pending.forEach((p, i) => p.resolve(json(200, { result: i })))
    expect(await Promise.all([p1, p2, p3, p4])).toEqual([0, 1, 2, 3])
  })

  it('書き込みメソッドは、同時に同じ引数でも 1 本にまとめず、すべて送る', async () => {
    expect(READ_ONLY_METHODS.has('updateSale')).toBe(false)
    expect(READ_ONLY_METHODS.has('createSale')).toBe(false)
    const api = make()
    const patch = { shippingCost: 700 } as never
    const p1 = api.updateSale('s1', patch)
    const p2 = api.updateSale('s1', patch)
    const p3 = api.updateSale('s1', patch)
    await flush()
    expect(calls).toHaveLength(3)
    pending.forEach((p) => p.resolve(json(200, { result: null })))
    await Promise.all([p1, p2, p3])
  })

  it('終わったあとの同じ呼び出しは新しく送る（結果を使い回さない＝キャッシュしない）', async () => {
    const api = make()
    const p1 = api.getDashboard()
    await flush()
    pending[0].resolve(json(200, { result: { profit: 100 } }))
    expect(await p1).toEqual({ profit: 100 })

    const p2 = api.getDashboard()
    await flush()
    expect(calls).toHaveLength(2)
    pending[1].resolve(json(200, { result: { profit: 250 } }))
    expect(await p2).toEqual({ profit: 250 })
  })

  it('1 人しか待っていなければ、コピーせずそのまま渡す（通常の読み取りの手間を増やさない）', async () => {
    const api = make()
    const p = api.getDashboard()
    await flush()
    pending[0].resolve(json(200, { result: { rows: [1, 2, 3] } }))
    expect(await p).toEqual({ rows: [1, 2, 3] })
  })

  it('失敗は相乗りした全員に届く。次の呼び出しは送り直す', async () => {
    const api = make()
    const p1 = api.getDashboard().catch((e: unknown) => e)
    const p2 = api.getDashboard().catch((e: unknown) => e)
    await flush()
    expect(calls).toHaveLength(1)
    pending[0].resolve(json(500, { error: { code: 'server_error', message: 'サーバーでエラーが起きました' } }))
    const [e1, e2] = await Promise.all([p1, p2])
    expect(e1).toBeInstanceOf(ApiError)
    expect(e2).toBeInstanceOf(ApiError)
    expect((e1 as ApiError).message).toBe('サーバーでエラーが起きました')
    expect((e2 as ApiError).message).toBe('サーバーでエラーが起きました')
    expect((e2 as ApiError).code).toBe('server_error')

    // 失敗を覚えていない：次は送り直す
    const p3 = api.getDashboard()
    await flush()
    expect(calls).toHaveLength(2)
    pending[1].resolve(json(200, { result: { ok: true } }))
    expect(await p3).toEqual({ ok: true })
  })

  it('通信そのものの失敗も全員に届き、次は送り直す。ログアウトはさせない', async () => {
    const api = make()
    const p1 = api.getInbox().catch((e: unknown) => e)
    const p2 = api.getInbox().catch((e: unknown) => e)
    await flush()
    pending[0].reject(new TypeError('Failed to fetch'))
    const [e1, e2] = await Promise.all([p1, p2])
    expect((e1 as ApiError).code).toBe('network')
    expect((e2 as ApiError).code).toBe('network')
    expect(onUnauthorized).not.toHaveBeenCalled()

    const p3 = api.getInbox()
    await flush()
    expect(calls).toHaveLength(2)
    pending[1].resolve(json(200, { result: [] }))
    expect(await p3).toEqual([])
  })

  it('unauthorized は 1 本の通信につき 1 回だけログインへ戻す（相乗りでも増やさない）', async () => {
    const api = make()
    const p1 = api.getDashboard().catch((e: unknown) => e)
    const p2 = api.getDashboard().catch((e: unknown) => e)
    await flush()
    pending[0].resolve(json(401, { error: { code: 'unauthorized', message: 'ログインの期限が切れました' } }))
    const [e1, e2] = await Promise.all([p1, p2])
    expect((e1 as ApiError).code).toBe('unauthorized')
    expect((e2 as ApiError).code).toBe('unauthorized')
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('読み取りの一覧に listSaleLinesBulk が入っている', () => {
    expect(READ_ONLY_METHODS.has('listSaleLinesBulk')).toBe(true)
    expect(READ_ONLY_METHODS.has('getDashboard')).toBe(true)
  })
})
