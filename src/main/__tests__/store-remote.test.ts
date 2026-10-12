import { describe, expect, it } from 'vitest'
import { AgentHttpError, AgentStoppedError, LeaseLostError } from '../agent/errors'
import { JobGuard } from '../agent/guard'
import { createAgentHttp, type FetchFn } from '../agent/http'
import type { MediaKind, MediaUploader } from '../agent/media'
import { createRemoteStore } from '../store/remote'
import type { CollectorRun } from '../../shared/types'

// リモートの store（CollectorStore を /api/agent で実装）：偽の fetch で、
// Authorization: Agent・lease の差し込み・lease_lost で専用の例外・5xx だけやり直す・
// 画像は Storage に上げてからパスを渡す・上げられなければ飛ばす

const ORIGIN = 'https://soroban.pages.dev'
const KEY = `sbagent_${'A'.repeat(43)}`
const KEY2 = `sbagent_${'B'.repeat(43)}`
const LEASE = { job_id: 'job-1', lease_token: 'lease-secret-1' }

interface Seen { method: string; authorization: string; args: unknown[] }

function setup(handler: (seen: Seen, n: number) => Response, opts: { key?: () => string | null; upload?: MediaUploader['upload'] } = {}) {
  const seen: Seen[] = []
  const uploads: Array<{ kind: MediaKind; file: string }> = []
  const fetch: FetchFn = async (url, init) => {
    const s: Seen = {
      method: url.slice(url.lastIndexOf('/') + 1),
      authorization: (init.headers as Record<string, string>).Authorization,
      args: (JSON.parse(String(init.body)) as { args: unknown[] }).args,
    }
    seen.push(s)
    return handler(s, seen.length)
  }
  const guard = new JobGuard()
  const media: MediaUploader = {
    upload: opts.upload ?? (async (kind, file) => { uploads.push({ kind, file }); return `hh/${kind}/rand-${file}` }),
  }
  const store = createRemoteStore({
    http: createAgentHttp({ origin: ORIGIN, fetch, sleep: async () => {}, retryDelaysMs: [1, 1] }),
    getKey: opts.key ?? (() => KEY),
    lease: LEASE,
    guard,
    media,
  })
  return { store, seen, uploads, guard }
}

const ok = (result: unknown): Response => new Response(JSON.stringify({ result }), { status: 200 })
const fail = (status: number, code: string, message = 'エラー'): Response =>
  new Response(JSON.stringify({ error: { code, message } }), { status })

const run = (over: Partial<CollectorRun> = {}): CollectorRun => ({
  id: 'run-1', started_at: '2026-10-12T00:00:00.000Z', finished_at: '2026-10-12T00:01:00.000Z', source: 'mercari',
  shop_account_id: null, shop_account_name: null, status: 'ok', fetched: 3, inserted: 1, message: null, ...over,
})

describe('lease の差し込みと鍵', () => {
  it('どの呼び出しも Authorization: Agent <鍵> で、引数の先頭に lease を差し込む', async () => {
    const { store, seen } = setup(() => ok({ already: false, inserted: 0 }))
    await store.getCollectPlan()
    await store.listSalesNeedingDetail(3)
    await store.ingestSoldPage(1, [])
    await store.ingestListingsPage('yahoo', 2, [])
    await store.excludedOrders('shop-1', ['A', 'B'])
    await store.revisitOrder('shop-1', 'p-1', null)

    expect(seen.map(s => s.method)).toEqual([
      'getCollectPlan', 'listSalesNeedingDetail', 'ingestSoldPage', 'ingestListingsPage', 'excludedOrders', 'revisitOrder',
    ])
    for (const s of seen) {
      expect(s.authorization).toBe(`Agent ${KEY}`)
      expect(s.args[0]).toEqual(LEASE)
    }
    expect(seen[1].args).toEqual([LEASE, 3])
    expect(seen[2].args).toEqual([LEASE, 1, []])
    expect(seen[3].args).toEqual([LEASE, 'yahoo', 2, []])
    expect(seen[4].args).toEqual([LEASE, 'shop-1', ['A', 'B']])
    expect(seen[5].args).toEqual([LEASE, 'shop-1', 'p-1', null])
  })

  it('段の戻り（already: true を含む）はそのまま返す', async () => {
    const { store } = setup(() => ok({ already: true }))
    expect(await store.ingestTrading([])).toEqual({ already: true })
  })

  it('recordRun は戻りの実行記録を集める（finish に渡す id）。同じ記録が戻っても 1 つに数える', async () => {
    const r1 = run({ id: 'run-1' })
    const r2 = run({ id: 'run-2', source: 'yahoo' })
    const { store } = setup((_s, n) => ok(n === 3 ? r1 : n === 2 ? r2 : r1))
    await store.recordRun({ source: 'mercari', status: 'ok', fetched: 3, inserted: 1 })
    await store.recordRun({ source: 'yahoo', status: 'ok', fetched: 3, inserted: 1 })
    await store.recordRun({ source: 'mercari', status: 'failed', fetched: 0, inserted: 0 }) // 送り直し：前の記録が戻る
    expect(store.recordedRuns().map(r => r.id)).toEqual(['run-1', 'run-2'])
  })

  it('鍵が無ければ（ログアウトで捨てた）通信せずに止まる', async () => {
    const { store, seen } = setup(() => ok(null), { key: () => null })
    await expect(store.getCollectPlan()).rejects.toBeInstanceOf(AgentStoppedError)
    expect(seen).toHaveLength(0)
  })

  it('鍵が取り直された直後に古い鍵で 401 になったら、最新の鍵で 1 度だけ送り直す', async () => {
    let current = KEY
    const { store, seen } = setup(
      (s) => (s.authorization === `Agent ${KEY}` ? fail(401, 'unauthorized') : ok({ shop_accounts: [] })),
      { key: () => current },
    )
    // 通信中に鍵が替わる想定：最初の呼び出しは古い鍵、その後 getKey が新しい鍵を返す
    const first = store.getCollectPlan()
    current = KEY2
    await expect(first).resolves.toEqual({ shop_accounts: [] })
    expect(seen.map(s => s.authorization)).toEqual([`Agent ${KEY}`, `Agent ${KEY2}`])
  })

  it('鍵が同じままの 401 は送り直さず、そのまま投げる', async () => {
    const { store, seen } = setup(() => fail(401, 'unauthorized'))
    const err = await store.getCollectPlan().catch(e => e)
    expect(err).toBeInstanceOf(AgentHttpError)
    expect(err.code).toBe('unauthorized')
    expect(seen).toHaveLength(1)
  })
})

describe('lease_lost：専用の例外で投げ、取り込みを止める', () => {
  it('lease_lost（409）は LeaseLostError。guard に印が付き、以後は通信せずに同じ例外', async () => {
    const { store, seen, guard } = setup((_s, n) => (n === 1 ? ok({ already: false }) : fail(409, 'lease_lost', '権限が失効しています')))
    await store.ingestTrading([])
    await expect(store.ingestSoldPage(1, [])).rejects.toBeInstanceOf(LeaseLostError)
    expect(guard.lost).toBe(true)
    expect(seen).toHaveLength(2)

    // 収集のコードが途中の例外を握っても、次の呼び出し（最後の recordRun など）は通信せずに同じ例外で止まる
    await expect(store.listSalesNeedingDetail(1)).rejects.toBeInstanceOf(LeaseLostError)
    await expect(store.recordRun({ source: 'mercari', status: 'failed', fetched: 0, inserted: 0 })).rejects.toBeInstanceOf(LeaseLostError)
    await expect(store.saveThumb({ kind: 'sale', channel_item_id: 'm1', thumb_url: 'u', path: 'm1.jpg' })).rejects.toBeInstanceOf(LeaseLostError)
    expect(seen).toHaveLength(2)
  })

  it('lease_lost はやり直さない（5xx のやり直しと混ぜない）', async () => {
    const { store, seen } = setup(() => fail(409, 'lease_lost'))
    await expect(store.ingestTrading([])).rejects.toBeInstanceOf(LeaseLostError)
    expect(seen).toHaveLength(1)
  })

  it('heartbeat などで guard が先に立てば（lease を失った）、最初の呼び出しから通信しない', async () => {
    const { store, seen, guard } = setup(() => ok(null))
    guard.loseLease()
    await expect(store.getCollectPlan()).rejects.toBeInstanceOf(LeaseLostError)
    expect(seen).toHaveLength(0)
  })

  it('こちらからやめた（stop）ときは AgentStoppedError', async () => {
    const { store, seen, guard } = setup(() => ok(null))
    guard.stop()
    await expect(store.ingestTrading([])).rejects.toBeInstanceOf(AgentStoppedError)
    expect(seen).toHaveLength(0)
  })
})

describe('通信の失敗：5xx・通信切れだけやり直す', () => {
  it('5xx は同じ段をそのまま送り直す（冪等キーがあるので二重に入らない）。成功すればその結果', async () => {
    const { store, seen } = setup((_s, n) => (n < 3 ? fail(503, 'internal') : ok({ already: true })))
    expect(await store.ingestOrder('shop-1', {
      order_no: 'N1', purchase: { kind: 'cancelled' }, fulfillment: null, image_urls: [],
    })).toEqual({ already: true })
    expect(seen).toHaveLength(3)
    expect(seen[0]).toEqual(seen[1])
  })

  it('4xx はやり直さない', async () => {
    for (const code of ['bad_request', 'forbidden', 'not_found', 'conflict'] as const) {
      const { store, seen } = setup(() => fail(code === 'not_found' ? 404 : code === 'conflict' ? 409 : code === 'forbidden' ? 403 : 400, code))
      await expect(store.ingestTrading([])).rejects.toBeInstanceOf(AgentHttpError)
      expect(seen, code).toHaveLength(1)
    }
  })

  it('5xx が続けば最後は投げる（3 回まで）', async () => {
    const { store, seen } = setup(() => fail(500, 'internal'))
    await expect(store.ingestTrading([])).rejects.toMatchObject({ code: 'internal', status: 500 })
    expect(seen).toHaveLength(3)
  })
})

describe('画像：Storage に上げてからパスを API に渡す', () => {
  it('saveThumb：ローカルのファイルを media に上げ、上げたパスに差し替えて渡す（販売は sale、出品は listing）', async () => {
    const { store, seen, uploads } = setup(() => ok({ already: false }))
    await store.saveThumb({ kind: 'sale', channel_item_id: 'm123', thumb_url: 'https://img/1.jpg?t=1', path: 'm123-ab12cd34.jpg' })
    await store.saveThumb({ kind: 'listing', channel_item_id: 'm456', thumb_url: 'https://img/2.jpg?t=2', path: 'm456-ee00ff11.jpg' })

    expect(uploads).toEqual([{ kind: 'sale', file: 'm123-ab12cd34.jpg' }, { kind: 'listing', file: 'm456-ee00ff11.jpg' }])
    expect(seen.map(s => s.method)).toEqual(['saveThumb', 'saveThumb'])
    expect(seen[0].args).toEqual([LEASE, {
      kind: 'sale', channel_item_id: 'm123', thumb_url: 'https://img/1.jpg?t=1', path: 'hh/sale/rand-m123-ab12cd34.jpg',
    }])
    expect(seen[1].args[1]).toMatchObject({ kind: 'listing', path: 'hh/listing/rand-m456-ee00ff11.jpg' })
  })

  it('saveLineImage：purchase-line に上げ、上げたパスを渡す', async () => {
    const { store, seen, uploads } = setup(() => ok({ already: false }))
    await store.saveLineImage('line-1', 'purchase-line-line-1-ab12cd34.jpg')
    expect(uploads).toEqual([{ kind: 'purchase-line', file: 'purchase-line-line-1-ab12cd34.jpg' }])
    expect(seen[0].method).toBe('saveLineImage')
    expect(seen[0].args).toEqual([LEASE, 'line-1', 'hh/purchase-line/rand-purchase-line-line-1-ab12cd34.jpg'])
  })

  it('上げられなければ例外（収集のコードがその画像を飛ばす）。API は呼ばない。guard は触らない（収集は続く）', async () => {
    const { store, seen, guard } = setup(() => ok({ already: false }), {
      upload: async () => { throw new Error('画像を上げられませんでした（503）') },
    })
    await expect(store.saveThumb({ kind: 'sale', channel_item_id: 'm1', thumb_url: 'u', path: 'm1.jpg' })).rejects.toThrow('画像を上げられません')
    await expect(store.saveLineImage('line-1', 'x.jpg')).rejects.toThrow('画像を上げられません')
    expect(seen).toHaveLength(0)
    expect(guard.tripped).toBe(false)

    // そのあとの段は普通に書ける
    await expect(store.ingestTrading([])).resolves.toBeDefined()
    expect(seen).toHaveLength(1)
  })

  it('lease を失ったあとは、画像も上げに行かない', async () => {
    const { store, uploads, guard } = setup(() => ok(null))
    guard.loseLease()
    await expect(store.saveThumb({ kind: 'sale', channel_item_id: 'm1', thumb_url: 'u', path: 'm1.jpg' })).rejects.toBeInstanceOf(LeaseLostError)
    await expect(store.saveLineImage('l', 'x.jpg')).rejects.toBeInstanceOf(LeaseLostError)
    expect(uploads).toHaveLength(0)
  })
})

describe('秘密の値を持ち歩かない', () => {
  it('エラー文に lease_token・鍵を含めない', async () => {
    const { store } = setup(() => fail(500, 'internal', 'サーバーでエラーが起きました'))
    const err = await store.ingestTrading([]).catch(e => e)
    expect(String(err.message)).not.toContain(LEASE.lease_token)
    expect(String(err.message)).not.toContain(KEY)
  })
})
