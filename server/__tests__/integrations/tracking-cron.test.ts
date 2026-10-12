import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  findHouseholdsWithTrackingQueue, runTrackingBatch, runTrackingForHousehold, RATE_PER_SECOND,
  type TrackingHouseholdResult, type TrackingRunOptions,
} from '../../cron/tracking'
import { enqueueAllTracking } from '../../cron/tracking-queue'
import { getLastTrackingSummary } from '../../domain/integrations'
import { setSetting } from '../../domain/master'
import { parseSecretKeys, putSecret, SecretKeysError, SECRET_TRACK17 } from '../../secrets'
import { newMember, newWorld, openDomainDb, type DomainDb, type Member, type World } from '../domain/helpers'
import {
  addPurchase, addPurchases, apiOk, fakeApiKey, fakeClock, fakeTrack17, info, jsonResponse, keyRing, newKey,
  registeredQueue, spyConsole, stateOf, type Fake17, type FakeClock,
} from './helpers'

// 17TRACK の定期実行の 1 回分（server/cron/tracking.ts）。偽の fetch・偽の時計だけを使い、本物の 17TRACK には出ない。
// 世帯の文脈の中の仕事は soroban_api、世帯をまたぐ「積まれた仕入のある世帯を探す」だけ soroban_cron

let db: DomainDb
let world: World
let clock: FakeClock
let api: Fake17
let apiKey: string

beforeAll(async () => {
  db = await openDomainDb()
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  world = await newWorld(db)
  clock = fakeClock()
  apiKey = fakeApiKey()
})
const run = (member: Member, opts: Partial<TrackingRunOptions> = {}, fake: Fake17 = api): Promise<TrackingHouseholdResult> =>
  runTrackingForHousehold(db.root, member.householdId, { apiKey, fetch: fake.fetch, now: clock.now, sleep: clock.sleep, ...opts })

const counts = (r: TrackingHouseholdResult) => ({ registered: r.registered, checked: r.checked, delivered: r.delivered, failed: r.failed })

const queuedCount = (m: Member): Promise<number> =>
  m.run(async ctx => (await ctx.sql.get<{ n: number }>('select count(*) as n from purchase where tracking_queued_at is not null'))!.n)

describe('流れ：register → 次の実行で gettrackinfo', () => {
  it('未登録の追跡番号は register（1 本）。登録した番号の状況は次の実行で読む。登録は一度きり', async () => {
    api = fakeTrack17(clock)
    const id = await addPurchase(world.a, { number: 'JP111' })

    const first = await run(world.a)
    expect(first.outcome).toBe('ran')
    expect(api.calls.map(c => [c.path, c.numbers])).toEqual([['register', ['JP111']]])
    expect(counts(first)).toEqual({ registered: 1, checked: 0, delivered: 0, failed: 0 })
    expect(first.requests).toBe(1)
    expect(first.remaining).toBe(1) // 状況は次の実行で読む
    expect(await stateOf(world.a, id)).toMatchObject({ registered: true, pending: false, queued: true, checked: false })

    const second = await run(world.a)
    expect(api.calls.map(c => c.path)).toEqual(['register', 'gettrackinfo']) // register は二度と送らない
    expect(counts(second)).toEqual({ registered: 0, checked: 1, delivered: 0, failed: 0 })
    expect(await stateOf(world.a, id)).toMatchObject({ queued: false, checked: true, tracking_status: '輸送中', fulfillment: 'shipped' })

    const third = await run(world.a)
    expect(third.requests).toBe(0)
    expect(api.calls).toHaveLength(2)
  })

  it('-18019901（登録済み）は成功として扱う', async () => {
    api = fakeTrack17(clock, {
      register: (numbers) => apiOk({ accepted: [], rejected: numbers.map(number => ({ number, error: { code: -18019901, message: 'registered' } })) }),
    })
    const id = await addPurchase(world.a, { number: 'JP222' })
    const r = await run(world.a)
    expect(r.registered).toBe(1)
    expect(r.failed).toBe(0)
    expect(await stateOf(world.a, id)).toMatchObject({ registered: true, pending: false })
  })

  it('登録できなかった（番号が不正など）は理由を残してキューから外す。印は付けない', async () => {
    api = fakeTrack17(clock, {
      register: (numbers) => apiOk({ accepted: [], rejected: numbers.map(number => ({ number, error: { code: -18019903, message: 'Carrier not found' } })) }),
    })
    const id = await addPurchase(world.a, { number: 'BAD' })
    const r = await run(world.a)
    expect(counts(r)).toEqual({ registered: 0, checked: 0, delivered: 0, failed: 1 })
    expect(await stateOf(world.a, id)).toMatchObject({ registered: false, pending: false, queued: false, tracking_status: 'Carrier not found' })
  })

  it('新しい注文が先に登録される。同じ追跡番号の仕入は 1 つの番号として送り、どちらにも印を付ける', async () => {
    api = fakeTrack17(clock)
    const [old, recent, dup] = await addPurchases(world.a, [
      { number: 'OLD', orderedAt: '2026-09-01' }, { number: 'NEW', orderedAt: '2026-10-05' }, { number: 'NEW', orderedAt: '2026-10-04' },
    ])
    await run(world.a)
    expect(api.calls).toHaveLength(1)
    expect(api.calls[0].numbers).toEqual(['NEW', 'OLD'])
    for (const id of [old, recent, dup]) expect(await stateOf(world.a, id)).toMatchObject({ registered: true })
  })

  it('積まれていない仕入・到着済み・追跡番号の無い仕入には何も送らない（積まれていても到着済み・番号なしは下ろす）', async () => {
    api = fakeTrack17(clock)
    const [notQueued, delivered, blank, none] = await addPurchases(world.a, [
      { number: 'Q0', queued: false }, { number: 'D1', fulfillment: 'delivered', registered: true },
      { number: '   ', registered: true }, { number: null },
    ])
    const r = await run(world.a)
    expect(r.requests).toBe(0)
    expect(api.calls).toHaveLength(0)
    for (const id of [delivered, blank, none, notQueued]) expect((await stateOf(world.a, id)).queued).toBe(false)
  })
})

describe('バッチと速度', () => {
  it('40 件で区切る（85 件＝40・40・5）。全部書けて、キューが空になる', async () => {
    api = fakeTrack17(clock)
    await addPurchases(world.a, registeredQueue(85))
    const r = await run(world.a)
    expect(api.calls.map(c => [c.path, c.numbers.length])).toEqual([['gettrackinfo', 40], ['gettrackinfo', 40], ['gettrackinfo', 5]])
    expect(r.checked).toBe(85)
    expect(await queuedCount(world.a)).toBe(0)
    expect(r.remaining).toBe(0)
  })

  it('未登録は register も 40 件ずつ（41 件＝40・1）', async () => {
    api = fakeTrack17(clock)
    await addPurchases(world.a, Array.from({ length: 41 }, (_, i) => ({ number: `R${String(i).padStart(2, '0')}` })))
    const r = await run(world.a)
    expect(api.calls.map(c => [c.path, c.numbers.length])).toEqual([['register', 40], ['register', 1]])
    expect(r.registered).toBe(41)
  })

  it('秒間 3 リクエストを超えない（どの 3 本の次の 1 本も、1 秒以上あとに送る）', async () => {
    api = fakeTrack17(clock)
    await addPurchases(world.a, registeredQueue(40 * 7)) // 7 本ぶん
    const r = await run(world.a, { maxRequests: 10 })
    expect(api.calls).toHaveLength(7)
    expect(r.checked).toBe(280)
    const times = api.calls.map(c => c.at)
    for (let i = 0; i + RATE_PER_SECOND < times.length; i++) {
      expect(times[i + RATE_PER_SECOND] - times[i], `${i} 本目と ${i + RATE_PER_SECOND} 本目`).toBeGreaterThanOrEqual(1000)
    }
    // 窓で数えても同じ：どの 1 秒（1000ms）にも 3 本まで
    for (const t of times) expect(times.filter(x => x >= t && x < t + 1000).length).toBeLessThanOrEqual(RATE_PER_SECOND)
    expect(clock.sleeps.length).toBeGreaterThan(0)
  })

  it('1 回の呼び出しの通信は maxRequests 本まで。残りは積んだまま（失敗ではない）', async () => {
    api = fakeTrack17(clock)
    await addPurchases(world.a, registeredQueue(200))
    const r = await run(world.a, { maxRequests: 2 })
    expect(api.calls).toHaveLength(2)
    expect(r.requests).toBe(2)
    expect(r.checked).toBe(80)
    expect(r.stopped).toBeNull()
    expect(r.remaining).toBe(120)
    expect(await queuedCount(world.a)).toBe(120)
    // 次の呼び出しで続きから
    const next = await run(world.a, { maxRequests: 10 })
    expect(next.checked).toBe(120)
    expect(await queuedCount(world.a)).toBe(0)
  })

  it('時間切れ（deadline）を過ぎたら新しい通信を始めない。失敗ではない', async () => {
    api = fakeTrack17(clock, {
      gettrackinfo: async (numbers) => {
        await clock.sleep(1000) // 1 本に 1 秒かかった
        return apiOk({ accepted: numbers.map(n => info(n, 'InTransit')), rejected: [] })
      },
    })
    await addPurchases(world.a, registeredQueue(85))
    const r = await run(world.a, { deadlineMs: 500 })
    expect(api.calls).toHaveLength(1)
    expect(r.checked).toBe(40)
    expect(r.stopped).toBeNull()
    expect(r.remaining).toBe(45)
  })
})

describe('止まる条件：429・4xx は再試行しない／5xx だけ短く数回', () => {
  it('429：1 本で打ち切り、理由を日本語で残す。キューは下ろす（次の取り込みでまた試す）。待たない・再試行しない', async () => {
    api = fakeTrack17(clock, { gettrackinfo: () => jsonResponse({}, 429) })
    await addPurchases(world.a, registeredQueue(85))
    const r = await run(world.a)
    expect(api.calls).toHaveLength(1)
    expect(clock.sleeps).toEqual([])
    expect(r.stopped).toMatch(/混み合って/)
    expect(r.checked).toBe(0)
    expect(await queuedCount(world.a)).toBe(0)
    const summary = await world.a.run(ctx => getLastTrackingSummary(ctx))
    expect(summary).toMatchObject({ checked: 0, stopped: expect.stringMatching(/混み合って/) })
  })

  it('401・403 などの 4xx も再試行せずに打ち切る。API キーが違う旨を伝える', async () => {
    for (const status of [400, 401, 403, 404]) {
      const m = await newMember(db, `H${status}`)
      const fake = fakeTrack17(clock, { gettrackinfo: () => jsonResponse({ code: -1 }, status) })
      await addPurchases(m, registeredQueue(3))
      const r = await run(m, {}, fake)
      expect(fake.calls, String(status)).toHaveLength(1)
      expect(r.stopped, String(status)).toBeTruthy()
      expect(await queuedCount(m)).toBe(0)
    }
    expect(clock.sleeps).toEqual([])
  })

  it('HTTP 200 でも API のエラーコード（-18010002＝キーが違う）なら再試行せず打ち切る', async () => {
    api = fakeTrack17(clock, { gettrackinfo: () => jsonResponse({ code: -18010002, data: { errors: [{ message: 'Invalid Sign' }] } }) })
    await addPurchases(world.a, registeredQueue(3))
    const r = await run(world.a)
    expect(api.calls).toHaveLength(1)
    expect(r.stopped).toMatch(/API キーが正しくありません/)
  })

  it('5xx は 2 秒・5 秒待って 3 本まで試し、それでも通らなければ打ち切る', async () => {
    api = fakeTrack17(clock, { gettrackinfo: () => jsonResponse({}, 503) })
    await addPurchases(world.a, registeredQueue(3))
    const r = await run(world.a)
    expect(api.calls).toHaveLength(3)
    expect(r.requests).toBe(3)
    expect(clock.sleeps).toEqual([2000, 5000])
    expect(r.stopped).toMatch(/一時的な障害/)
    expect(r.checked).toBe(0)
  })

  it('5xx のあとで通れば続ける', async () => {
    api = fakeTrack17(clock, {
      gettrackinfo: (numbers, _c, index) =>
        index === 0 ? jsonResponse({}, 502) : apiOk({ accepted: numbers.map(n => info(n, 'OutForDelivery')), rejected: [] }),
    })
    const id = await addPurchase(world.a, { number: 'Z1', registered: true })
    const r = await run(world.a)
    expect(api.calls).toHaveLength(2)
    expect(r.stopped).toBeNull()
    expect(await stateOf(world.a, id)).toMatchObject({ tracking_status: '配達中', queued: false })
  })

  it('通信が切れた（fetch が例外）も 5xx と同じく数回だけ試す', async () => {
    let n = 0
    const fake: Fake17 = {
      calls: [],
      fetch: (async () => {
        n++
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    }
    await addPurchases(world.a, registeredQueue(2))
    const r = await run(world.a, {}, fake)
    expect(n).toBe(3)
    expect(r.stopped).toMatch(/接続できませんでした/)
  })

  it('再試行も通信の本数に数える（上限に達したら送らず、失敗にもしない）', async () => {
    api = fakeTrack17(clock, { gettrackinfo: () => jsonResponse({}, 500) })
    await addPurchases(world.a, registeredQueue(2))
    const r = await run(world.a, { maxRequests: 2 })
    expect(api.calls).toHaveLength(2)
    expect(r.requests).toBe(2)
    expect(r.stopped).toBeNull()
    expect(await queuedCount(world.a)).toBe(2)
  })
})

describe('register の途中で切れたとき（pending）', () => {
  it('送る前に pending を書く：応答が 5xx（送ったか分からない）なら pending を残し、印は付けない', async () => {
    let pendingDuringCall: boolean | null = null
    api = fakeTrack17(clock, {
      register: async () => {
        pendingDuringCall = (await stateOf(world.a, idA)).pending
        return jsonResponse({}, 500)
      },
    })
    const idA = await addPurchase(world.a, { number: 'P1' })
    const r = await run(world.a)
    expect(pendingDuringCall).toBe(true) // 送る前に書いてある
    expect(r.stopped).toBeTruthy()
    expect(await stateOf(world.a, idA)).toMatchObject({ pending: true, registered: false })
  })

  it('確実に送っていない（4xx・API のエラー）なら pending を外す', async () => {
    api = fakeTrack17(clock, { register: () => jsonResponse({}, 400) })
    const id = await addPurchase(world.a, { number: 'P2' })
    await run(world.a)
    expect(await stateOf(world.a, id)).toMatchObject({ pending: false, registered: false })

    const m = await newMember(db, 'apierr')
    const fake = fakeTrack17(clock, { register: () => jsonResponse({ code: -18010002, data: { errors: [{ message: 'x' }] } }) })
    const id2 = await addPurchase(m, { number: 'P3' })
    await run(m, {}, fake)
    expect(await stateOf(m, id2)).toMatchObject({ pending: false, registered: false })
  })

  it('5xx のあとの再試行が上限に当たったときは、最初の 1 本が届いたかもしれないので pending を残す', async () => {
    api = fakeTrack17(clock, { register: () => jsonResponse({}, 500) })
    const id = await addPurchase(world.a, { number: 'P6' })
    const r = await run(world.a, { maxRequests: 1 })
    expect(api.calls).toHaveLength(1)
    expect(r.stopped).toBeNull() // 上限は失敗ではない
    expect(await stateOf(world.a, id)).toMatchObject({ pending: true, registered: false, queued: true })
  })

  it('上限が 0 なら何も書かず何も送らない', async () => {
    api = fakeTrack17(clock)
    const id = await addPurchase(world.a, { number: 'P7' })
    const r = await run(world.a, { maxRequests: 0 })
    expect(api.calls).toHaveLength(0)
    expect(r.requests).toBe(0)
    expect(await stateOf(world.a, id)).toMatchObject({ pending: false, registered: false, queued: true })
  })

  it('pending のまま残っているものは、まず gettrackinfo で照会する。未登録なら register を送り直す', async () => {
    api = fakeTrack17(clock, {
      gettrackinfo: (numbers) => apiOk({ accepted: [], rejected: numbers.map(number => ({ number, error: { code: -18019902, message: 'not registered' } })) }),
    })
    const id = await addPurchase(world.a, { number: 'P4', pending: true })
    const r = await run(world.a)
    expect(api.calls.map(c => c.path)).toEqual(['gettrackinfo', 'register'])
    expect(r.registered).toBe(1)
    expect(await stateOf(world.a, id)).toMatchObject({ pending: false, registered: true })
  })

  it('照会して登録済みだったら register は送らない（無料枠を二重に使わない）。印を付けて読めた結果を書く', async () => {
    api = fakeTrack17(clock)
    const id = await addPurchase(world.a, { number: 'P5', pending: true })
    const r = await run(world.a)
    expect(api.calls.map(c => c.path)).toEqual(['gettrackinfo'])
    expect(counts(r)).toEqual({ registered: 1, checked: 1, delivered: 0, failed: 0 })
    expect(await stateOf(world.a, id)).toMatchObject({ pending: false, registered: true, queued: false, tracking_status: '輸送中' })
  })

  it('pending の仕入が混ざっていても、他の未登録は同じ回で register する', async () => {
    api = fakeTrack17(clock, {
      gettrackinfo: (numbers) => apiOk({ accepted: [], rejected: numbers.map(number => ({ number, error: { code: -18019902, message: 'x' } })) }),
    })
    const [stuck, fresh] = await addPurchases(world.a, [{ number: 'S1', pending: true }, { number: 'F1' }])
    await run(world.a)
    expect(api.calls.map(c => c.path)).toEqual(['gettrackinfo', 'register'])
    expect(api.calls[0].numbers).toEqual(['S1'])
    expect([...api.calls[1].numbers].sort()).toEqual(['F1', 'S1'])
    for (const id of [stuck, fresh]) expect(await stateOf(world.a, id)).toMatchObject({ registered: true, pending: false })
  })
})

describe('応答の突き合わせ・到着は前にだけ進む', () => {
  it('問い合わせていない番号の結果・知らない status は捨てる。応答に無かった番号には触らない', async () => {
    api = fakeTrack17(clock, {
      gettrackinfo: () => apiOk({
        accepted: [info('N1', 'InTransit'), info('NOT-ASKED', 'Delivered'), info('N2', 'SomethingNew')],
        rejected: [],
      }),
    })
    const [n1, n2, n3] = await addPurchases(world.a, [
      { number: 'N1', registered: true }, { number: 'N2', registered: true }, { number: 'N3', registered: true },
    ])
    // 別の世帯に、同じ番号の仕入がある（この世帯の応答では絶対に変わらない）
    const other = await addPurchase(world.b, { number: 'NOT-ASKED', registered: true })

    const r = await run(world.a)
    expect(counts(r)).toEqual({ registered: 0, checked: 2, delivered: 0, failed: 0 })
    expect(await stateOf(world.a, n1)).toMatchObject({ tracking_status: '輸送中', queued: false })
    // 知らない status は「不明」。到着状態は変えない
    expect(await stateOf(world.a, n2)).toMatchObject({ tracking_status: '不明', fulfillment: 'shipped', queued: false })
    // 応答に無かった N3 は手つかず（積んだまま）
    expect(await stateOf(world.a, n3)).toMatchObject({ tracking_status: null, queued: true, checked: false })
    expect(await stateOf(world.b, other)).toMatchObject({ tracking_status: null, queued: true, fulfillment: 'shipped' })
  })

  it('大文字小文字の違いだけは同じ番号とみなす', async () => {
    api = fakeTrack17(clock, { gettrackinfo: () => apiOk({ accepted: [info('jp9', 'OutForDelivery')], rejected: [] }) })
    const id = await addPurchase(world.a, { number: 'JP9', registered: true })
    await run(world.a)
    expect(await stateOf(world.a, id)).toMatchObject({ tracking_status: '配達中', queued: false })
  })

  it('配達完了は到着済みにして到着日を入れる（日本時間の日付。UTC の深夜でも 1 日ずれない）', async () => {
    api = fakeTrack17(clock, {
      gettrackinfo: () => apiOk({
        accepted: [
          info('D1', 'Delivered', { tracking: { providers: [{ events: [{ sub_status: 'Delivered_Other', time_raw: { date: '2026-10-09', time: '10:00:00', timezone: '+09:00' } }] }] } }),
          info('D2', 'Delivered', { latest_event: { time_iso: '2024-05-02T15:30:00Z' } }), // UTC では 5/2、日本では 5/3
          info('D3', 'Delivered'),
        ],
        rejected: [],
      }),
    })
    const [d1, d2, d3] = await addPurchases(world.a, [
      { number: 'D1', registered: true, fulfillment: 'pending' }, { number: 'D2', registered: true }, { number: 'D3', registered: true },
    ])
    const r = await run(world.a)
    expect(counts(r)).toEqual({ registered: 0, checked: 3, delivered: 3, failed: 0 })
    expect(await stateOf(world.a, d1)).toMatchObject({ fulfillment: 'delivered', delivered_at: '2026-10-09', tracking_status: '配達完了' })
    expect(await stateOf(world.a, d2)).toMatchObject({ fulfillment: 'delivered', delivered_at: '2024-05-03' })
    expect((await stateOf(world.a, d3)).fulfillment).toBe('delivered') // 日付の手がかりが無ければ、気づいた日が入る
  })

  it('到着状態は前に進む方向だけ（配送中の仕入が「受付済み」に戻らない）。読めなかった番号は言葉だけ残す', async () => {
    api = fakeTrack17(clock, {
      gettrackinfo: () => apiOk({
        accepted: [info('B1', 'InfoReceived')],
        rejected: [{ number: 'B2', error: { code: -18019909, message: '追跡情報がありません' } }],
      }),
    })
    const [b1, b2] = await addPurchases(world.a, [
      { number: 'B1', registered: true, fulfillment: 'shipped' }, { number: 'B2', registered: true, fulfillment: 'shipped' },
    ])
    const r = await run(world.a)
    expect(counts(r)).toEqual({ registered: 0, checked: 1, delivered: 0, failed: 1 })
    expect(await stateOf(world.a, b1)).toMatchObject({ fulfillment: 'shipped', tracking_status: '受付済み' })
    expect(await stateOf(world.a, b2)).toMatchObject({ fulfillment: 'shipped', tracking_status: '追跡情報がありません', queued: false })
  })

  it('人が到着済みにした仕入は戻さない（積まれていても下ろすだけ）', async () => {
    api = fakeTrack17(clock)
    const id = await addPurchase(world.a, { number: 'H1', registered: true, fulfillment: 'delivered' })
    await run(world.a)
    expect(api.calls).toHaveLength(0)
    expect(await stateOf(world.a, id)).toMatchObject({ fulfillment: 'delivered', queued: false })
  })
})

describe('同じ世帯を同時に 2 本走らせない（lease）', () => {
  const leaseOf = (m: Member) => m.run(ctx => ctx.sql.get<{ t: string | null }>('select app.acquire_tracking_lease() as t'))

  it('別の実行が lease を持っていれば何もしない。持ち主が返せば動く。終わると lease を返している', async () => {
    api = fakeTrack17(clock)
    await addPurchases(world.a, registeredQueue(3))
    const held = (await leaseOf(world.a))!.t!
    expect(held).toBeTruthy()

    const busy = await run(world.a)
    expect(busy.outcome).toBe('busy')
    expect(api.calls).toHaveLength(0)
    expect(await queuedCount(world.a)).toBe(3)

    await world.a.run(ctx => ctx.sql.get('select app.release_tracking_lease(?::uuid)', held))
    const ran = await run(world.a)
    expect(ran.outcome).toBe('ran')
    expect(ran.checked).toBe(3)
    expect((await leaseOf(world.a))!.t).toBeTruthy() // 返してあるので、また取れる
  })

  it('止まって終わったときも lease は返す', async () => {
    api = fakeTrack17(clock, { gettrackinfo: () => jsonResponse({}, 429) })
    await addPurchases(world.a, registeredQueue(3))
    await run(world.a)
    expect((await leaseOf(world.a))!.t).toBeTruthy()
  })

  it('同時に 2 本呼んでも、動くのは 1 本だけ', async () => {
    api = fakeTrack17(clock)
    await addPurchases(world.a, registeredQueue(3))
    const [x, y] = await Promise.all([run(world.a), run(world.a)])
    expect([x.outcome, y.outcome].sort()).toEqual(['busy', 'ran'])
    expect(api.calls).toHaveLength(1)
  })

  it('世帯が違えば独立（A が持っていても B は動く）', async () => {
    api = fakeTrack17(clock)
    await addPurchases(world.a, registeredQueue(1))
    await addPurchases(world.b, registeredQueue(1, 'B'))
    await leaseOf(world.a)
    expect((await run(world.a)).outcome).toBe('busy')
    expect((await run(world.b)).outcome).toBe('ran')
  })

  it('期限が切れた lease は取り直せる（前の持ち主が落ちた）', async () => {
    api = fakeTrack17(clock)
    await addPurchases(world.a, registeredQueue(1))
    await leaseOf(world.a)
    await db.pg.query(`update app.tracking_lease set lease_expires_at = now() - interval '1 second' where household_id = $1`, [world.a.householdId])
    expect((await run(world.a)).outcome).toBe('ran')
  })
})

describe('Cron の入口 runTrackingBatch（世帯を巡回して、世帯ごとのキーで確認する）', () => {
  let k1: string
  let ring: string

  beforeEach(async () => {
    k1 = newKey()
    ring = keyRing([1, k1])
    // 巡回は全世帯が対象なので、これまでのテストが積んだままにした分を下ろしておく
    await db.pg.exec('update app.purchase set tracking_queued_at = null')
  })

  const save = (m: Member, key: string, r = ring) => m.run(ctx => putSecret(ctx, parseSecretKeys(r), SECRET_TRACK17, key))
  const batch = (opts: Partial<TrackingRunOptions> = {}, secretKeys: string | null = ring, fake: Fake17 = api) =>
    runTrackingBatch(db.root, { secretKeys, fetch: fake.fetch, now: clock.now, sleep: clock.sleep, ...opts })

  it('積まれた仕入のある世帯だけを、古い順に見つける。世帯をまたいで読めるのは追跡の列だけ', async () => {
    const m1 = await newMember(db, 'one')
    const m2 = await newMember(db, 'two')
    const quiet = await newMember(db, 'quiet')
    await addPurchase(quiet, { number: 'Q', queued: false })
    await addPurchase(m1, { number: 'A1', registered: true })
    await addPurchase(m2, { number: 'A2', registered: true })
    await db.pg.query(`update app.purchase set tracking_queued_at = now() - interval '1 hour' where household_id = $1`, [m2.householdId])

    const found = await findHouseholdsWithTrackingQueue(db.root, 100)
    const mine = found.filter(h => [m1.householdId, m2.householdId, quiet.householdId].includes(h))
    expect(mine).toEqual([m2.householdId, m1.householdId]) // 古い順
    expect(found).not.toContain(quiet.householdId)
    expect(await findHouseholdsWithTrackingQueue(db.root, 1)).toHaveLength(1)
  })

  it('世帯ごとの API キーで確認する（A のキーで B の仕入を聞かない）。通信の本数は世帯をまたいで数える', async () => {
    const a = await newMember(db, 'A2')
    const b = await newMember(db, 'B2')
    const ka = fakeApiKey()
    const kb = fakeApiKey()
    await save(a, ka)
    await save(b, kb)
    await addPurchases(a, registeredQueue(2, 'A'))
    await addPurchases(b, registeredQueue(2, 'B'))
    api = fakeTrack17(clock)

    const result = await batch()
    const mine = result.households.filter(h => [a.householdId, b.householdId].includes(h.householdId))
    expect(mine.map(h => [h.outcome, h.checked])).toEqual([['ran', 2], ['ran', 2]])
    const byToken = (t: string) => api.calls.filter(c => c.token === t).flatMap(c => c.numbers).sort()
    expect(byToken(ka)).toEqual(['A000', 'A001'])
    expect(byToken(kb)).toEqual(['B000', 'B001'])
    expect(result.requests).toBe(api.calls.length)
  })

  it('maxRequests は世帯をまたいだ合計。使い切ったら次の世帯は見ない（積んだまま）', async () => {
    const a = await newMember(db, 'A3')
    const b = await newMember(db, 'B3')
    await save(a, fakeApiKey())
    await save(b, fakeApiKey())
    await addPurchases(a, registeredQueue(1, 'A'))
    await addPurchases(b, registeredQueue(1, 'B'))
    api = fakeTrack17(clock)
    // 先に動く世帯で 1 本使い切る（他の世帯が積んでいても、この呼び出しでは 1 本まで）
    const result = await batch({ maxRequests: 1, maxHouseholds: 100 })
    expect(api.calls).toHaveLength(1)
    expect(result.requests).toBe(1)
    const ran = result.households.filter(h => [a.householdId, b.householdId].includes(h.householdId))
    expect(ran).toHaveLength(1)
    expect(await queuedCount(a) + await queuedCount(b)).toBe(1)
  })

  it('API キーが無い世帯は何も聞かず、積まれた分を下ろす。読み出せない（鍵が合わない）世帯は理由を残す', async () => {
    const noKey = await newMember(db, 'nokey')
    const broken = await newMember(db, 'broken')
    await addPurchases(noKey, registeredQueue(2))
    await addPurchases(broken, registeredQueue(2))
    await save(broken, fakeApiKey(), keyRing([9, newKey()])) // 今の SECRET_KEYS には無い鍵で書かれている
    api = fakeTrack17(clock)

    const result = await batch({ maxHouseholds: 100 })
    const outcome = (m: Member) => result.households.find(h => h.householdId === m.householdId)!.outcome
    expect(outcome(noKey)).toBe('no_key')
    expect(outcome(broken)).toBe('unreadable_key')
    expect(api.calls).toHaveLength(0)
    expect(await queuedCount(noKey)).toBe(0)
    expect(await queuedCount(broken)).toBe(0)
    expect(await broken.run(ctx => getLastTrackingSummary(ctx))).toMatchObject({ stopped: expect.stringMatching(/入れ直してください/) })
    expect(await noKey.run(ctx => getLastTrackingSummary(ctx))).toBeNull()
  })

  it('SECRET_KEYS の形が違えば、何もする前に SecretKeysError（通信も DB の変更も無い）', async () => {
    const m = await newMember(db, 'badenv')
    await addPurchases(m, registeredQueue(1))
    api = fakeTrack17(clock)
    await expect(batch({}, 'broken')).rejects.toBeInstanceOf(SecretKeysError)
    await expect(batch({}, null)).rejects.toBeInstanceOf(SecretKeysError)
    expect(api.calls).toHaveLength(0)
    expect(await queuedCount(m)).toBe(1)
  })

  it('古い版の鍵で書かれたキーを読めて、読んだついでに今の鍵で書き直す', async () => {
    const m = await newMember(db, 'rotate')
    const key = fakeApiKey()
    await save(m, key) // 版 1
    const k2 = newKey()
    const rotated = keyRing([2, k2], [1, k1])
    await addPurchases(m, registeredQueue(1))
    api = fakeTrack17(clock)
    await batch({ maxHouseholds: 100 }, rotated)
    expect(api.calls.find(c => c.token === key)).toBeTruthy()
    const row = await m.run(ctx => ctx.sql.get<{ key_version: number }>(`select key_version from setting_secret where key = 'track17_api_key'`))
    expect(row?.key_version).toBe(2)
  })
})

describe('track_shipping・キーの有無（積む側）', () => {
  it('設定 track_shipping がオフなら、まとめて積まない（何も聞かない）。オンに戻せば積む', async () => {
    await world.a.run(ctx => putSecret(ctx, parseSecretKeys(keyRing([1, newKey()])), SECRET_TRACK17, fakeApiKey()))
    await addPurchases(world.a, [
      { number: 'T1', queued: false, registered: true }, { number: 'T2', queued: false },
      { number: 'T3', queued: false, fulfillment: 'delivered' }, { number: null, queued: false },
    ])
    await world.a.run(ctx => setSetting(ctx, 'track_shipping', '0'))
    expect(await world.a.run(ctx => enqueueAllTracking(ctx))).toEqual({ queued: 0, skipped: 'off' })
    expect(await queuedCount(world.a)).toBe(0)

    api = fakeTrack17(clock)
    const r = await run(world.a)
    expect(r.requests).toBe(0)
    expect(api.calls).toHaveLength(0)

    await world.a.run(ctx => setSetting(ctx, 'track_shipping', '1'))
    expect(await world.a.run(ctx => enqueueAllTracking(ctx))).toEqual({ queued: 2, skipped: null }) // 到着済み・番号なしは積まない
    expect(await world.a.run(ctx => enqueueAllTracking(ctx))).toEqual({ queued: 0, skipped: null }) // 二度積まない
  })

  it('設定が無ければオン（既定）。API キーが無ければ積まない', async () => {
    await addPurchases(world.a, [{ number: 'K1', queued: false }])
    expect(await world.a.run(ctx => enqueueAllTracking(ctx))).toEqual({ queued: 0, skipped: 'no_key' })
    await world.a.run(ctx => putSecret(ctx, parseSecretKeys(keyRing([1, newKey()])), SECRET_TRACK17, fakeApiKey()))
    expect(await world.a.run(ctx => enqueueAllTracking(ctx))).toEqual({ queued: 1, skipped: null })
  })
})

describe('API キーが出ない', () => {
  it('ログ・結果・直近の確認結果（app_log）のどこにも API キーが出ない（失敗の経路でも）', async () => {
    const secret = fakeApiKey()
    apiKey = secret
    const spy = spyConsole()
    try {
      api = fakeTrack17(clock, { gettrackinfo: () => jsonResponse({ code: -18010002, data: { errors: [{ message: secret }] } }) })
      await addPurchases(world.a, registeredQueue(2))
      const r = await run(world.a)
      const summary = await world.a.run(ctx => getLastTrackingSummary(ctx))
      const logs = await db.pg.query<{ t: string }>(`select row_to_json(l)::text as t from app.app_log l where household_id = $1`, [world.a.householdId])
      expect(JSON.stringify(r)).not.toContain(secret)
      expect(JSON.stringify(summary)).not.toContain(secret)
      expect(logs.rows.map(x => x.t).join('\n')).not.toContain(secret)
      expect(spy.text()).not.toContain(secret)
      expect(r.stopped).toMatch(/キー/)
    } finally {
      spy.restore()
    }
  })
})

describe('直近の確認結果（getLastTrackingSummary）', () => {
  it('何も確認していなければ null。確認したら件数・理由・時刻が残る。何も起きなかった回は残さない', async () => {
    expect(await world.a.run(ctx => getLastTrackingSummary(ctx))).toBeNull()
    api = fakeTrack17(clock)
    await run(world.a) // 積まれていない
    expect(await world.a.run(ctx => getLastTrackingSummary(ctx))).toBeNull()

    await addPurchases(world.a, [{ number: 'S1', registered: true, fulfillment: 'pending' }, ...registeredQueue(1, 'S2')])
    api = fakeTrack17(clock, {
      gettrackinfo: (numbers) => apiOk({ accepted: numbers.map(n => info(n, n === 'S1' ? 'Delivered' : 'InTransit')), rejected: [] }),
    })
    await run(world.a)
    const summary = await world.a.run(ctx => getLastTrackingSummary(ctx))
    expect(summary).toMatchObject({ registered: 0, checked: 2, delivered: 1, failed: 0, stopped: null })
    expect(new Date(summary!.at).toString()).not.toBe('Invalid Date')
    // 世帯 B からは見えない
    expect(await world.b.run(ctx => getLastTrackingSummary(ctx))).toBeNull()
  })

  it('壊れた記録は null（推測で埋めない）', async () => {
    await world.a.run(ctx => ctx.sql.run(
      `insert into app_log (source, kind, message, payload) values ('collector', 'tracking', 'x', '{"registered":"many"}')`))
    expect(await world.a.run(ctx => getLastTrackingSummary(ctx))).toBeNull()
    await world.a.run(ctx => ctx.sql.run(
      `insert into app_log (source, kind, message, payload) values ('collector', 'tracking', 'x', 'not json')`))
    expect(await world.a.run(ctx => getLastTrackingSummary(ctx))).toBeNull()
  })
})
