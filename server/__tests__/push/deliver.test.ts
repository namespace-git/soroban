import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import * as sale from '../../domain/sale'
import { savePushSubscription } from '../../domain/push'
import { todayJst } from '../../domain/_shared'
import type { Sql } from '../../db/sql'
import { DEFAULT_DRAIN_LIMIT, drainDeliveries, MAX_DRAIN_LIMIT } from '../../push/deliver'
import { enqueueNotification } from '../../push/notify'
import { newWorld, openDomainDb, type DomainDb, type Member, type World } from '../domain/helpers'
import { fakePushService, makeDevice, makeVapid, type TestDevice, type TestVapid } from './helpers'

// 配送の送り方（Cron の Worker が呼ぶ drainDeliveries）。
// claim_deliveries → 送信 → complete_delivery を、soroban_cron のロールで、偽の Push サービスに対して行う

let dom: DomainDb
let w: World
let vapid: TestVapid

beforeAll(async () => {
  dom = await openDomainDb()
  vapid = await makeVapid()
})

afterAll(async () => {
  await dom.close()
})

beforeEach(async () => {
  w = await newWorld(dom)
  // drainDeliveries は世帯をまたいで巡回する。別のテストの配送が残っていると数が合わなくなるので、毎回空にする
  await dom.pg.exec('delete from app.notification_event')
})

let seq = 0
const eventOn = (m: Member, kind: 'sale' | 'shipping' | 'collect' | 'arrival' | 'test' = 'sale', title = '売れました') =>
  m.run((c: Ctx) => enqueueNotification(c.sql, { kind, title, body: '', url: '/?tab=sales', dedupeKey: `k${++seq}` }))

async function subscribe(m: Member, opts: Parameters<typeof makeDevice>[0] = {}): Promise<TestDevice> {
  const d = await makeDevice(opts)
  await m.run((c) => savePushSubscription(c, d.input))
  return d
}

interface DeliveryRow { status: string; attempts: number; last_error: string | null; sent_at: string | null; next_attempt_at: string }
const deliveries = async (hh?: string): Promise<DeliveryRow[]> =>
  (await dom.pg.query<DeliveryRow>(
    `select status, attempts, last_error, sent_at, next_attempt_at from app.notification_delivery
      ${hh ? 'where household_id = $1' : ''} order by id`, hh ? [hh] : [])).rows
const subCount = async () => (await dom.pg.query<{ n: number }>('select count(*)::int as n from app.push_subscription')).rows[0].n

describe('drainDeliveries：結果ごとの complete_delivery', () => {
  it('201 / 202 は sent。配送は sent・sent_at が入り、購読の last_used_at が進む。本文は復号できて tag は event id', async () => {
    const d1 = await subscribe(w.a)
    const d2 = await subscribe(w.a)
    const ev = await eventOn(w.a, 'sale', '売れました：商品 ¥1,000')
    const svc = fakePushService(201, { [d2.input.endpoint]: 202 })

    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toEqual({ sent: 2, failed: 0, gone: 0, retried: 0 })
    const rows = await deliveries()
    expect(rows.map((r) => [r.status, r.attempts])).toEqual([['sent', 1], ['sent', 1]])
    expect(rows.every((r) => r.sent_at !== null && r.last_error === null)).toBe(true)
    const used = await dom.pg.query<{ last_used_at: string | null }>('select last_used_at from app.push_subscription')
    expect(used.rows.every((r) => r.last_used_at !== null)).toBe(true)

    const call = svc.calls.find((c) => c.endpoint === d1.input.endpoint)!
    expect(await d1.decrypt(call.body)).toEqual({ title: '売れました：商品 ¥1,000', body: '', url: '/?tab=sales', tag: ev })
    // 送ったものは二度と取らない
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toEqual({ sent: 0, failed: 0, gone: 0, retried: 0 })
    expect(svc.calls).toHaveLength(2)
  })

  it('404・410 は gone：購読ごと消える（その端末の配送も消える）', async () => {
    for (const status of [404, 410]) {
      await dom.pg.exec('delete from app.push_subscription')
      await subscribe(w.a)
      await eventOn(w.a)
      const svc = fakePushService(status)
      expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toEqual({ sent: 0, failed: 0, gone: 1, retried: 0 })
      expect(await subCount()).toBe(0)
      expect(await deliveries()).toEqual([])
    }
  })

  it('宛先が許可した Push サービスの外（許可リストより前に登録された購読）は、通信せずに gone：購読ごと消える。ほかの購読は送る', async () => {
    await dom.pg.exec('delete from app.push_subscription')
    const good = await subscribe(w.a)
    // 許可の外の宛先を持つ行を DB に直接入れる（登録の検査を通らなかった昔の行を想定）
    await dom.pg.query(
      `insert into app.push_subscription (household_id, user_id, endpoint, p256dh, auth) values ($1, $2, 'https://push.example.test/old', 'p', 'a')`,
      [w.a.householdId, w.a.userId])
    expect(await subCount()).toBe(2)
    await eventOn(w.a)
    const svc = fakePushService(201)

    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toEqual({ sent: 1, failed: 0, gone: 1, retried: 0 })
    expect(svc.calls.map((c) => c.endpoint)).toEqual([good.input.endpoint]) // 許可の外の宛先には 1 度も通信していない
    expect(await subCount()).toBe(1)
    expect((await deliveries()).map((r) => r.status)).toEqual(['sent'])
    await dom.pg.exec('delete from app.push_subscription') // 次のテストに残さない
  })

  it('同じ死んだ購読への配送が 2 つあっても、gone は 2 と数える（1 つ目が購読ごと消すので 2 つ目の行は無い）', async () => {
    await subscribe(w.a)
    await eventOn(w.a)
    await eventOn(w.a)
    const svc = fakePushService(410)
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toEqual({ sent: 0, failed: 0, gone: 2, retried: 0 })
    expect(await subCount()).toBe(0)
  })

  it('429・5xx・通信失敗・それ以外の 4xx は retried：pending に戻し、1 回目は 1 分後に再送', async () => {
    const cases: Array<[string, number | Error]> = [
      ['429', 429], ['500', 500], ['503', 503], ['400', 400], ['403', 403], ['通信失敗', new Error('network down')],
    ]
    for (const [name, reply] of cases) {
      await dom.pg.exec('delete from app.notification_event')
      await dom.pg.exec('delete from app.push_subscription')
      await subscribe(w.a)
      await eventOn(w.a)
      const before = Date.now()
      const svc = fakePushService(reply)
      expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch }), name).toEqual({ sent: 0, failed: 0, gone: 0, retried: 1 })
      const [row] = await deliveries()
      expect(row.status, name).toBe('pending')
      expect(row.attempts, name).toBe(1)
      expect(row.last_error, name).toBeTruthy()
      const wait = new Date(row.next_attempt_at).getTime() - before
      expect(wait, name).toBeGreaterThan(50_000)
      expect(wait, name).toBeLessThan(70_000)
      // すぐにはもう一度送らない
      expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch }), name).toEqual({ sent: 0, failed: 0, gone: 0, retried: 0 })
      expect(svc.calls, name).toHaveLength(1)
    }
  })

  it('失敗を重ねると 1 分・5 分・30 分・2 時間後に再送し、5 回目で諦める（failed）', async () => {
    await subscribe(w.a)
    await eventOn(w.a)
    const svc = fakePushService(500)
    const waits: number[] = []
    for (let attempt = 1; attempt <= 4; attempt++) {
      const before = Date.now()
      expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toMatchObject({ retried: 1 })
      const [row] = await deliveries()
      expect(row.attempts).toBe(attempt)
      waits.push(Math.round((new Date(row.next_attempt_at).getTime() - before) / 60_000))
      await dom.pg.exec(`update app.notification_delivery set next_attempt_at = now() - interval '1 second'`)
    }
    expect(waits).toEqual([1, 5, 30, 120])
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toEqual({ sent: 0, failed: 1, gone: 0, retried: 0 })
    const [last] = await deliveries()
    expect(last).toMatchObject({ status: 'failed', attempts: 5 })
    expect(last.last_error).toContain('HTTP 500')
    // 諦めたものは二度と送らない
    await dom.pg.exec(`update app.notification_delivery set next_attempt_at = now() - interval '1 second'`)
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toEqual({ sent: 0, failed: 0, gone: 0, retried: 0 })
    expect(svc.calls).toHaveLength(5)
  })

  it('last_error に宛先の URL を残さない', async () => {
    const d = await subscribe(w.a)
    await eventOn(w.a)
    const svc = fakePushService(new Error(`ECONNRESET ${d.input.endpoint}`))
    await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })
    const [row] = await deliveries()
    expect(row.last_error).not.toContain(d.input.endpoint)
    expect(row.last_error).toContain('[endpoint]')
  })

  it('1 件の失敗で他を止めない：届く・5xx・通信失敗・410 が混ざっても、それぞれの結果になる', async () => {
    const ok = await subscribe(w.a)
    const ng = await subscribe(w.a)
    const down = await subscribe(w.a)
    const gone = await subscribe(w.a)
    await eventOn(w.a)
    const svc = fakePushService(201, {
      [ng.input.endpoint]: 500, [down.input.endpoint]: new Error('network down'), [gone.input.endpoint]: 410,
    })
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toEqual({ sent: 1, failed: 0, gone: 1, retried: 2 })
    expect(svc.calls).toHaveLength(4)
    expect(ok.input.endpoint).toBeTruthy()
    expect((await deliveries()).map((r) => r.status).sort()).toEqual(['pending', 'pending', 'sent'])
  })
})

describe('drainDeliveries：1 回に送る数・鍵・競合', () => {
  async function many(n: number): Promise<void> {
    await subscribe(w.a)
    for (let i = 0; i < n; i++) await eventOn(w.a)
  }

  it('既定は 20 件まで。残りは次の呼び出しで送る', async () => {
    expect(DEFAULT_DRAIN_LIMIT).toBe(20)
    await many(25)
    const svc = fakePushService(201)
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toMatchObject({ sent: 20 })
    expect(svc.calls).toHaveLength(20)
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toMatchObject({ sent: 5 })
    expect(svc.calls).toHaveLength(25)
  })

  it('limit を渡せる。0 以下・小数・NaN は丸め、50 を超えては取らない（Workers の外部通信の上限）', async () => {
    expect(MAX_DRAIN_LIMIT).toBe(50)
    await many(60)
    const svc = fakePushService(201)
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch, limit: 3 })).toMatchObject({ sent: 3 })
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch, limit: 0 })).toMatchObject({ sent: 1 })
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch, limit: 2.9 })).toMatchObject({ sent: 2 })
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch, limit: Number.NaN })).toMatchObject({ sent: 20 })
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch, limit: 1000 })).toMatchObject({ sent: 34 })
    expect(svc.calls).toHaveLength(60)
    await many(55)
    const svc2 = fakePushService(201)
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc2.fetch, limit: 1000 })).toMatchObject({ sent: 50 })
    expect(svc2.calls).toHaveLength(50)
  })

  it('同時に送る数を絞る（既定 5 本）', async () => {
    await many(12)
    let running = 0
    let peak = 0
    const slow = fakePushService(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 15))
      running--
      return 201
    })
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: slow.fetch })).toMatchObject({ sent: 12 })
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(5)
    await many(6)
    peak = 0
    await drainDeliveries(dom.root, vapid.env, { fetch: slow.fetch, concurrency: 2 })
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('鍵が無ければ何もしない（取らない・送らない・例外を投げない）。取らないので attempts は 0 のまま', async () => {
    await subscribe(w.a)
    await eventOn(w.a)
    const svc = fakePushService(201)
    for (const env of [{}, { VAPID_PUBLIC_KEY: vapid.env.VAPID_PUBLIC_KEY }, { VAPID_PRIVATE_KEY: vapid.env.VAPID_PRIVATE_KEY }]) {
      expect(await drainDeliveries(dom.root, env, { fetch: svc.fetch })).toEqual({ sent: 0, failed: 0, gone: 0, retried: 0 })
    }
    expect(svc.calls).toHaveLength(0)
    expect(await deliveries()).toMatchObject([{ status: 'pending', attempts: 0 }])
  })

  it('鍵の形が違うときも何もしない。ログには理由だけ出し、鍵の値は出さない', async () => {
    await subscribe(w.a)
    await eventOn(w.a)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const svc = fakePushService(201)
      const env = { ...vapid.env, VAPID_PRIVATE_KEY: 'AAAA' }
      expect(await drainDeliveries(dom.root, env, { fetch: svc.fetch })).toEqual({ sent: 0, failed: 0, gone: 0, retried: 0 })
      expect(svc.calls).toHaveLength(0)
      expect(await deliveries()).toMatchObject([{ status: 'pending', attempts: 0 }])
      const logged = JSON.stringify(spy.mock.calls)
      expect(logged).toContain('VAPID_PRIVATE_KEY')
      expect(logged).not.toContain(vapid.env.VAPID_PRIVATE_KEY)
    } finally {
      spy.mockRestore()
    }
  })

  it('2 本が同時に走っても同じ配送を 2 回送らない（取った時点で sending）', async () => {
    await many(8)
    const slow = fakePushService(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return 201
    })
    const [a, b] = await Promise.all([
      drainDeliveries(dom.root, vapid.env, { fetch: slow.fetch }),
      drainDeliveries(dom.root, vapid.env, { fetch: slow.fetch }),
    ])
    expect(a.sent + b.sent).toBe(8)
    expect(slow.calls).toHaveLength(8)
  })

  it('取ったまま止まった（lease を過ぎた sending）配送は取り直して送る', async () => {
    await subscribe(w.a)
    await eventOn(w.a)
    await dom.pg.exec(`update app.notification_delivery set status = 'sending', claimed_at = now() - interval '10 minutes', attempts = 1`)
    const svc = fakePushService(201)
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toMatchObject({ sent: 1 })
    expect(await deliveries()).toMatchObject([{ status: 'sent', attempts: 2 }])
    // lease の中の sending は触らない
    await eventOn(w.a)
    await dom.pg.exec(`update app.notification_delivery set status = 'sending', claimed_at = now() where status = 'pending'`)
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toMatchObject({ sent: 0 })
  })
})

describe('drainDeliveries：世帯・ロール', () => {
  it('世帯をまたいで巡回する：A と B の通知を 1 回で送り、それぞれ自分の世帯の端末へ', async () => {
    const da = await subscribe(w.a)
    const db = await subscribe(w.b)
    await eventOn(w.a, 'sale', 'A の通知')
    await eventOn(w.b, 'sale', 'B の通知')
    const svc = fakePushService(201)
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toMatchObject({ sent: 2 })
    const toA = svc.calls.find((c) => c.endpoint === da.input.endpoint)!
    const toB = svc.calls.find((c) => c.endpoint === db.input.endpoint)!
    expect((await da.decrypt(toA.body)).title).toBe('A の通知')
    expect((await db.decrypt(toB.body)).title).toBe('B の通知')
  })

  it('soroban_cron は金額を読めないまま送れる：販売の通知（¥ 入り）を送れて、同じロールで sale の金額は読めない', async () => {
    const d = await subscribe(w.a)
    await w.a.run((c) => sale.insertCollected(c, [{
      mercariItemId: 'mc1', title: '【A040】もこ山', price: 5750, soldAt: todayJst(), status: 'waiting_shipment',
    }]))
    const svc = fakePushService(201)
    expect(await drainDeliveries(dom.root, vapid.env, { fetch: svc.fetch })).toEqual({ sent: 1, failed: 0, gone: 0, retried: 0 })
    expect((await d.decrypt(svc.calls[0].body)).title).toBe('売れました：【A040】もこ山 ¥5,750')

    // 送るのに使ったロールそのものでは、販売・在庫・金額の列は読めない
    for (const query of ['select price from app.sale', 'select title from app.sale', 'select landed_cost from app.inventory_item', 'select shipping_fee from app.purchase']) {
      await expect(dom.pg.transaction(async (tx) => {
        await tx.query('set local role soroban_cron')
        await tx.query(query)
      }), query).rejects.toThrow(/permission denied/)
    }
  })

  it('取る・結果を書く、のどちらのトランザクションも soroban_cron に切り替えてから始める。通信は DB のトランザクションの外', async () => {
    await subscribe(w.a)
    await eventOn(w.a)
    const log: string[] = []
    const record = (s: Sql): Sql => ({
      get: (q, ...p) => (log.push(q), s.get(q, ...p)),
      all: (q, ...p) => (log.push(q), s.all(q, ...p)),
      run: (q, ...p) => (log.push(q), s.run(q, ...p)),
      tx: (fn) => (log.push('BEGIN'), s.tx((inner) => fn(record(inner))).finally(() => log.push('COMMIT'))),
    })
    const svc = fakePushService(async () => {
      log.push('FETCH')
      return 201
    })
    await drainDeliveries(record(dom.root), vapid.env, { fetch: svc.fetch })
    const flat = log.map((q) => q.replace(/\s+/g, ' ').trim())
    expect(flat).toEqual([
      'BEGIN', 'set local role soroban_cron', expect.stringContaining('from app.claim_deliveries'), 'COMMIT',
      'FETCH',
      'BEGIN', 'set local role soroban_cron', 'BEGIN', expect.stringContaining('app.complete_delivery'), 'COMMIT', 'COMMIT',
    ])
  })

  it('送り終えたあと、接続のロールは元に戻る（set local。次の呼び出しにロールが残らない）', async () => {
    await subscribe(w.a)
    await eventOn(w.a)
    await drainDeliveries(dom.root, vapid.env, { fetch: fakePushService(201).fetch })
    const r = await dom.pg.query<{ user: string }>('select current_user as user')
    expect(r.rows[0].user).not.toBe('soroban_cron')
  })
})
