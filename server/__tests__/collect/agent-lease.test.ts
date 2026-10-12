import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { reserveInventory } from '../../domain/listing'
import { seedItems } from '../domain/core-helpers'
import type { Member } from '../domain/helpers'
import {
  ask, closeFixture, count, expireLease, leaseOf, openFixture, registerPc, resetWorld, startJob, type Fixture, type Pc,
} from './helpers'

// lease：失効した lease の書き込みは SB003（lease_lost）で何も書かない／同じ段の 2 回目は「済み」で二重に入らない／
// 段の途中で失敗したら段ごと巻き戻る

let f: Fixture
let a: Member
let pc: Pc
let lease: ReturnType<typeof leaseOf>
let jobId: string

beforeAll(async () => {
  f = await openFixture()
})

afterAll(async () => {
  await closeFixture(f)
})

beforeEach(async () => {
  await resetWorld(f)
  a = f.world.a
  pc = await registerPc(f, a)
  const started = await startJob(f, a, pc)
  lease = leaseOf(started)
  jobId = started.job_id
})

const sold = (id: string, over: Record<string, unknown> = {}) => ({
  mercariItemId: id, title: `【A037】商品 ${id}`, price: 3000, fee: 300, shippingFee: 210, otherCost: 0,
  soldAt: '2026-10-05', thumbUrl: `https://static.mercdn.net/thumb/${id}_1.jpg?1700000000`, ...over,
})

const sales = () => count(f, 'select count(*)::int as n from app.sale where household_id = $1', a.householdId)
const stages = () => count(f, 'select count(*)::int as n from app.collect_job_stage where job_id = $1', jobId)

describe('取り込みの権限（claim・heartbeat）', () => {
  it('claim が lease を返し、heartbeat で期限が延びる。lease を取った PC の名前が job に残る', async () => {
    const before = (await f.dom.pg.query<{ t: Date | string }>('select lease_expires_at as t from app.collect_job where id = $1', [jobId])).rows[0].t
    await f.dom.pg.query(`update app.collect_job set lease_expires_at = now() + interval '30 seconds' where id = $1`, [jobId])
    const r = await pc.call('heartbeat', lease)
    expect(r.status).toBe(200)
    expect(new Date(r.body.result.lease_expires_at).getTime()).toBeGreaterThan(Date.now() + 120_000)
    expect(new Date(before).getTime()).toBeGreaterThan(Date.now())

    const row = (await f.dom.pg.query<{ agent_id: string; agent_device_id: string }>(
      'select agent_id, agent_device_id from app.collect_job where id = $1', [jobId])).rows[0]
    expect(row).toEqual({ agent_id: pc.name, agent_device_id: pc.agentId })
  })

  it('失効した lease は延命できない（lease_lost）', async () => {
    await expireLease(f, jobId)
    const r = await pc.call('heartbeat', lease)
    expect(r.status).toBe(409)
    expect(r.body.error?.code).toBe('lease_lost')
    const row = (await f.dom.pg.query<{ lease_expires_at: Date | string }>('select lease_expires_at from app.collect_job where id = $1', [jobId])).rows[0]
    expect(new Date(row.lease_expires_at).getTime()).toBeLessThan(Date.now())
  })

  it('同時に 2 台は取れない：2 台目の claim は null', async () => {
    const other = await registerPc(f, a, '寝室の PC')
    const r = await other.call('claim')
    expect(r.status).toBe(200)
    expect(r.body.result).toBeNull()
  })
})

describe('失効した lease の書き込み', () => {
  it('lease が切れていたら何も書かずに lease_lost（409）。段の記録も残らない', async () => {
    await expireLease(f, jobId)
    const r = await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001')])
    expect(r.status).toBe(409)
    expect(r.body.error?.code).toBe('lease_lost')
    expect(await sales()).toBe(0)
    expect(await stages()).toBe(0)
  })

  it('reap された（failed）後の書き込みも lease_lost', async () => {
    await expireLease(f, jobId)
    expect((await ask(a, 'getCollectStatus')).body.result.job.status).toBe('failed')
    const r = await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001')])
    expect(r.body.error?.code).toBe('lease_lost')
    expect(await sales()).toBe(0)
  })

  it('別の lease_token・知らない job は lease_lost（書かない）', async () => {
    for (const bad of [
      { job_id: jobId, lease_token: '00000000-0000-4000-8000-0000000000aa' },
      { job_id: '00000000-0000-4000-8000-0000000000bb', lease_token: lease.lease_token },
    ]) {
      const r = await pc.call('ingestSoldPage', bad, 1, [sold('m10000000001')])
      expect(r.status).toBe(409)
      expect(r.body.error?.code).toBe('lease_lost')
    }
    expect(await sales()).toBe(0)
  })

  it('lease_token が別の PC に渡っても書けない（取った PC だけが書ける）', async () => {
    const other = await registerPc(f, a, '寝室の PC')
    const r = await other.call('ingestSoldPage', lease, 1, [sold('m10000000001')])
    expect(r.status).toBe(409)
    expect(r.body.error?.code).toBe('lease_lost')
    expect(await sales()).toBe(0)
    // 本来の PC は書ける
    expect((await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001')])).status).toBe(200)
  })

  it('他の世帯の job は、自分の鍵・正しい lease_token でも書けない', async () => {
    const pcB = await registerPc(f, f.world.b, 'B の PC')
    const r = await pcB.call('ingestSoldPage', lease, 1, [sold('m10000000001')])
    expect(r.body.error?.code).toBe('lease_lost')
    expect(await sales()).toBe(0)
  })

  it('finish の後の書き込みは lease_lost', async () => {
    expect((await pc.call('finish', lease, { status: 'failed', run_ids: [] })).status).toBe(200)
    const r = await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001')])
    expect(r.body.error?.code).toBe('lease_lost')
    expect(await sales()).toBe(0)
    // finish をもう一度送っても終わらない（lease_lost）
    expect((await pc.call('finish', lease, { status: 'failed', run_ids: [] })).body.error?.code).toBe('lease_lost')
  })

  it('読み取りも lease を確かめる', async () => {
    await expireLease(f, jobId)
    for (const [method, args] of [
      ['getCollectPlan', []], ['listSalesNeedingDetail', [3]], ['listSalesNeedingPurchasedAt', [3]],
      ['existingImportKeys', [['mellojoy:1']]],
    ] as const) {
      const r = await pc.call(method, lease, ...args)
      expect(r.body.error?.code, method).toBe('lease_lost')
    }
  })

  it('古い PC の観測で、出品停止の引き当てが静かに外れない（lease が生きているときだけ外れる）', async () => {
    const { itemId, itemCode } = await seedReservedListing('m20000000001')
    expect(itemCode).toBeTruthy()
    // 1 回目の観測（active）→ そのまま
    const first = await pc.call('ingestListingsPage', lease, 'mercari', 1, [listing('m20000000001', false)])
    expect(first.body.result).toMatchObject({ already: false, inserted: 0, updated: 1, released_listings: 0 })
    expect(await reservations()).toBe(1)

    // スリープから戻った古い PC：lease が切れている → 断られ、引き当ては残る
    await expireLease(f, jobId)
    const stale = await pc.call('ingestListingsPage', lease, 'mercari', 2, [listing('m20000000001', true)])
    expect(stale.body.error?.code).toBe('lease_lost')
    expect(await reservations()).toBe(1)
    expect(await listingStatus('m20000000001')).toBe('active')
    expect(itemId).toBeTruthy()
  })

  it('lease が生きていれば、active → suspended に変わった取り込みで引き当てを外す（件数も返る）', async () => {
    await seedReservedListing('m20000000001')
    const r = await pc.call('ingestListingsPage', lease, 'mercari', 1, [listing('m20000000001', true)])
    expect(r.body.result).toMatchObject({ already: false, updated: 1, released_listings: 1, released_items: 1 })
    expect(await reservations()).toBe(0)
    expect(await listingStatus('m20000000001')).toBe('suspended')
  })
})

describe('段ごとの冪等', () => {
  it('同じ段を 2 回送ると 2 回目は already: true で、二重に入らない', async () => {
    const rows = [sold('m10000000001'), sold('m10000000002')]
    const one = await pc.call('ingestSoldPage', lease, 1, rows)
    expect(one.body.result).toMatchObject({ already: false, inserted: 2, updated: 0 })
    expect(await sales()).toBe(2)

    const two = await pc.call('ingestSoldPage', lease, 1, rows)
    expect(two.status).toBe(200)
    expect(two.body.result).toEqual({ already: true })
    expect(await sales()).toBe(2)
    expect(await stages()).toBe(1)
  })

  it('済みの段には、中身が違っても何も書かない（キーだけで判断する）', async () => {
    await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001')])
    const again = await pc.call('ingestSoldPage', lease, 1, [sold('m10000000009')])
    expect(again.body.result).toEqual({ already: true })
    expect(await sales()).toBe(1)
  })

  it('ページが違えば別の段', async () => {
    await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001')])
    const second = await pc.call('ingestSoldPage', lease, 2, [sold('m10000000002')])
    expect(second.body.result).toMatchObject({ already: false, inserted: 1 })
    expect(await sales()).toBe(2)
    expect(await stages()).toBe(2)
  })

  it('取引中のスナップショット・出品も、2 回目は済み', async () => {
    const trading = [{ mercariItemId: 'm10000000010', title: '【A037】取引中', price: 2000, status: 'waiting_shipment', thumbUrl: null }]
    expect((await pc.call('ingestTrading', lease, trading)).body.result).toMatchObject({ already: false, inserted: 1 })
    expect((await pc.call('ingestTrading', lease, trading)).body.result).toEqual({ already: true })
    expect(await sales()).toBe(1)

    const l = [listing('m20000000002', false)]
    expect((await pc.call('ingestListingsPage', lease, 'mercari', 1, l)).body.result).toMatchObject({ already: false, inserted: 1 })
    expect((await pc.call('ingestListingsPage', lease, 'mercari', 1, l)).body.result).toEqual({ already: true })
    expect(await count(f, 'select count(*)::int as n from app.listing where household_id = $1', a.householdId)).toBe(1)
  })

  it('段の途中で失敗したら段ごと巻き戻る（半端に入らない・段の記録も残らない）。直して送り直せる', async () => {
    // 同じ商品 ID が 1 ページに 2 回：1 件目を入れた後の 2 件目で一意制約に当たる
    const dup = [sold('m10000000001'), sold('m10000000001')]
    const failed = await pc.call('ingestSoldPage', lease, 1, dup)
    expect(failed.status, JSON.stringify(failed.body)).toBeGreaterThanOrEqual(400)
    expect(failed.status, JSON.stringify(failed.body)).toBeLessThan(500)
    expect(failed.body.error?.code).not.toBe('lease_lost')
    expect(await sales()).toBe(0)
    expect(await stages()).toBe(0)

    const fixed = await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001')])
    expect(fixed.body.result).toMatchObject({ already: false, inserted: 1 })
    expect(await sales()).toBe(1)
    expect(await stages()).toBe(1)
  })

  it('検査に通らない行が 1 つでもあれば、そのページは 1 件も入れない（400）', async () => {
    const r = await pc.call('ingestSoldPage', lease, 1, [sold('m10000000001'), sold('m10000000002', { soldAt: '2026-13-40' })])
    expect(r.status).toBe(400)
    expect(await sales()).toBe(0)
    expect(await stages()).toBe(0)
  })
})

// ---- 出品＋引き当ての用意 ----

const listing = (id: string, suspended: boolean) => ({
  mercariItemId: id, title: '【A037】出品', price: 3000, suspended, thumbUrl: null, updatedText: '3日前に更新', likes: 2,
})

async function seedReservedListing(itemId: string): Promise<{ itemId: string; itemCode: string }> {
  const [inventoryId] = await a.run(async (ctx) => {
    const shop = await ctx.sql.get<{ id: string }>(`insert into shop_account (name, kind) values ('メロジョイ', 'mellojoy') returning id`)
    const ids = await seedItems(ctx, {
      shopId: shop!.id, ordered_at: '2026-10-01', lines: [{ name: '【A037】商品', unit_price: 1000, quantity: 1 }],
    })
    await ctx.sql.run(
      `insert into listing (channel, channel_item_id, title, price, status, first_seen_at, last_seen_at, listed_at)
       values ('mercari', ?, '【A037】出品', 3000, 'active', '2026-10-02', now(), '2026-10-02')`, itemId)
    await reserveInventory(ctx, itemId, ids)
    return ids
  })
  const code = await f.dom.pg.query<{ item_code: string }>('select item_code from app.inventory_item where id = $1', [inventoryId])
  return { itemId: inventoryId, itemCode: code.rows[0].item_code }
}

const reservations = () => count(f, 'select count(*)::int as n from app.listing_line where household_id = $1', a.householdId)

async function listingStatus(itemId: string): Promise<string> {
  const r = await f.dom.pg.query<{ status: string }>(
    'select status from app.listing where household_id = $1 and channel_item_id = $2', [a.householdId, itemId])
  return r.rows[0].status
}
