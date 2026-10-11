import type { PGlite, Transaction } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMigratedDb } from '../../test/migrate'
import { insertChain, type Chain } from '../schema/helpers'
import { asApi, asCron, asRole, HH_A, HH_B, seedHouseholds, sqlstateOf } from './helpers'

// 17TRACK のキュー（20261012001520_cron_role.sql）：
//   * purchase.tracking_queued_at（確認する番が来た）・tracking_register_pending_at（register を送る直前）
//   * 世帯ごとの lease（tracking_lease）。秒間 3 リクエスト（API キーごと）を守るため、
//     同じ世帯を同時に 2 本走らせない

let db: PGlite
let chainA: Chain
let chainB: Chain

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
  chainA = await asApi(db, HH_A, (tx) => insertChain(tx, 'A'))
  chainB = await asApi(db, HH_B, (tx) => insertChain(tx, 'B'))
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec('delete from app.tracking_lease')
  await db.exec(`update app.purchase set tracking_number = null, tracking_queued_at = null, tracking_register_pending_at = null, tracking_registered_at = null`)
})

const acquire = (hh: string, lease?: string, as: 'api' | 'cron' = 'cron') => {
  const run = async (tx: Transaction) =>
    (await tx.query<{ t: string | null }>(
      lease === undefined ? 'select app.acquire_tracking_lease() as t' : 'select app.acquire_tracking_lease($1::interval) as t',
      lease === undefined ? [] : [lease],
    )).rows[0].t
  return as === 'cron' ? asCron(db, hh, run) : asApi(db, hh, run)
}

const release = (hh: string, token: string | null, as: 'api' | 'cron' = 'cron') => {
  const run = async (tx: Transaction) =>
    (await tx.query<{ ok: boolean }>('select app.release_tracking_lease($1) as ok', [token])).rows[0].ok
  return as === 'cron' ? asCron(db, hh, run) : asApi(db, hh, run)
}

const leaseRow = async (hh: string) =>
  (await db.query<{ lease_token: string; lease_expires_at: string }>('select lease_token, lease_expires_at from app.tracking_lease where household_id = $1', [hh])).rows[0]

describe('17TRACK の lease（同じ世帯＝同じ API キーを同時に 2 本走らせない）', () => {
  it('取れたら lease_token が返り、期限（既定 2 分）が入る', async () => {
    const token = await acquire(HH_A)
    expect(token).toMatch(/^[0-9a-f-]{36}$/)
    const row = await leaseRow(HH_A)
    expect(row.lease_token).toBe(token)
    const left = new Date(row.lease_expires_at).getTime() - Date.now()
    expect(left).toBeGreaterThan(100_000)
    expect(left).toBeLessThan(125_000)
  })

  it('同じ世帯で 2 本目は取れない（null）。何度やっても取れず、1 本目の lease は変わらない', async () => {
    const first = await acquire(HH_A)
    expect(first).not.toBeNull()
    const before = await leaseRow(HH_A)
    expect(await acquire(HH_A)).toBeNull()
    expect(await acquire(HH_A)).toBeNull()
    expect(await acquire(HH_A, '10 minutes')).toBeNull()
    expect(await leaseRow(HH_A)).toEqual(before)
  })

  it('同じトランザクションの中で 2 回呼んでも、2 回目は取れない', async () => {
    const r = await asCron(db, HH_A, async (tx) => {
      const call = async () => (await tx.query<{ t: string | null }>('select app.acquire_tracking_lease() as t')).rows[0].t
      return [await call(), await call()]
    })
    expect(r[0]).not.toBeNull()
    expect(r[1]).toBeNull()
  })

  it('世帯が違えば独立（世帯 A が持っていても世帯 B は取れる＝API キーが別）', async () => {
    const a = await acquire(HH_A)
    const b = await acquire(HH_B)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).not.toBe(b)
  })

  it('期限が切れた lease は取り直せる（前の持ち主が落ちた）。新しい token になり、古い token では返せない', async () => {
    const stale = await acquire(HH_A)
    await db.query(`update app.tracking_lease set lease_expires_at = now() - interval '1 second' where household_id = $1`, [HH_A])

    const fresh = await acquire(HH_A)
    expect(fresh).not.toBeNull()
    expect(fresh).not.toBe(stale)
    expect(await acquire(HH_A)).toBeNull() // 取り直したので、また塞がっている

    // 古い持ち主が遅れて返しにきても、新しい持ち主の lease を壊さない
    expect(await release(HH_A, stale)).toBe(false)
    expect((await leaseRow(HH_A)).lease_token).toBe(fresh)
  })

  it('返せば（持ち主の token）true になり、すぐ取り直せる。token が違う・null・もう返した は false', async () => {
    const token = (await acquire(HH_A))!
    expect(await release(HH_A, '00000000-0000-4000-8000-0000000000aa')).toBe(false)
    expect(await release(HH_A, null)).toBe(false)
    expect(await acquire(HH_A)).toBeNull()

    expect(await release(HH_A, token)).toBe(true)
    expect(await release(HH_A, token)).toBe(false)
    expect(await acquire(HH_A)).not.toBeNull()
  })

  it('他の世帯の lease は返せない（文脈の世帯のものだけ）', async () => {
    const tokenB = (await acquire(HH_B))!
    expect(await release(HH_A, tokenB)).toBe(false)
    expect((await leaseRow(HH_B)).lease_token).toBe(tokenB)
  })

  it('lease の長さは引数で変えられる。0 以下・null は 22023', async () => {
    const token = await acquire(HH_A, '30 seconds')
    expect(token).not.toBeNull()
    const left = new Date((await leaseRow(HH_A)).lease_expires_at).getTime() - Date.now()
    expect(left).toBeLessThan(35_000)
    await release(HH_A, token)

    for (const bad of ['0 seconds', '-1 minute']) {
      expect(await sqlstateOf(() => acquire(HH_A, bad)), bad).toBe('22023')
    }
    expect(await sqlstateOf(() => asCron(db, HH_A, (tx) => tx.query('select app.acquire_tracking_lease(null)')))).toBe('22023')
  })

  it('世帯の文脈が無いと取れない（どの世帯の lease か決まらない）', async () => {
    const code = await sqlstateOf(() => asCron(db, null, (tx) => tx.query('select app.acquire_tracking_lease()')))
    expect(code).not.toBeNull()
    expect((await db.query('select 1 from app.tracking_lease')).rows).toEqual([])
  })

  it('soroban_api からも取れる（画面の API が「いま確認中か」を見るのにも使える）。soroban_api の側でも世帯ごとに隔離される', async () => {
    expect(await acquire(HH_A, undefined, 'api')).not.toBeNull()
    expect(await acquire(HH_A, undefined, 'cron')).toBeNull() // cron でも api の持っている分は取れない
    const seen = await asApi(db, HH_B, async (tx) => (await tx.query('select * from app.tracking_lease')).rows)
    expect(seen).toEqual([])
  })

  it('anon / authenticated は呼べない・読めない', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect(await sqlstateOf(() => asRole(db, role, (tx) => tx.query('select app.acquire_tracking_lease()'))), role).toBe('42501')
      expect(await sqlstateOf(() => asRole(db, role, (tx) => tx.query('select * from app.tracking_lease'))), role).toBe('42501')
    }
  })

  it('世帯を消すと lease も消える（household_id が主キーで cascade）', async () => {
    const hhC = '00000000-0000-4000-8000-00000000000c'
    await db.query(`insert into app.household (id, name) values ($1, '消す世帯')`, [hhC])
    expect(await acquire(hhC)).not.toBeNull()
    await db.query('delete from app.household where id = $1', [hhC])
    expect((await db.query('select 1 from app.tracking_lease where household_id = $1', [hhC])).rows).toEqual([])
  })
})

describe('仕入のキューの列', () => {
  it('tracking_queued_at・tracking_register_pending_at は timestamptz で、既定は null', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'app' and table_name = 'purchase'
          and column_name in ('tracking_queued_at', 'tracking_register_pending_at') order by column_name`,
    )
    expect(rows).toEqual([
      { column_name: 'tracking_queued_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'tracking_register_pending_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
    ])
  })

  it('register_pending と registered は同時に持てない（送る前に pending、成功したら registered に書き換える）', async () => {
    const id = chainA.purchaseId
    await db.query(`update app.purchase set tracking_number = 'JP1', tracking_register_pending_at = now() where id = $1`, [id])
    expect(await sqlstateOf(() => db.query(`update app.purchase set tracking_registered_at = now() where id = $1`, [id]))).toBe('23514')
    // 1 回の更新で registered にして pending を外せば通る
    await db.query(`update app.purchase set tracking_registered_at = now(), tracking_register_pending_at = null where id = $1`, [id])
    const row = await db.query<{ p: string | null; r: string | null }>(
      'select tracking_register_pending_at as p, tracking_registered_at as r from app.purchase where id = $1', [id])
    expect(row.rows[0].p).toBeNull()
    expect(row.rows[0].r).not.toBeNull()
    // registered のあとに pending は付けられない
    expect(await sqlstateOf(() => db.query(`update app.purchase set tracking_register_pending_at = now() where id = $1`, [id]))).toBe('23514')
  })

  it('Cron の流れ：世帯をまたいで「確認する番が来た」を引く → 世帯の文脈で register_pending → registered → 結果を書いてキューから外す', async () => {
    await db.query(`update app.purchase set tracking_number = 'JP-A', tracking_queued_at = now() - interval '1 minute' where id = $1`, [chainA.purchaseId])
    await db.query(`update app.purchase set tracking_number = 'JP-B', tracking_queued_at = now() where id = $1`, [chainB.purchaseId])

    // 世帯をまたいで、古い順に（未登録＝register が要る、登録済み＝gettrackinfo だけ）
    const queue = await asCron(db, null, async (tx) =>
      (await tx.query<{ id: string; household_id: string; tracking_number: string; registered: boolean }>(
        `select id, household_id, tracking_number, tracking_registered_at is not null as registered
           from app.purchase
          where tracking_queued_at is not null and fulfillment is distinct from 'delivered'
          order by tracking_queued_at limit 40`)).rows)
    expect(queue.map((q) => [q.household_id, q.tracking_number, q.registered])).toEqual([
      [HH_A, 'JP-A', false], [HH_B, 'JP-B', false],
    ])

    // 世帯 A：register を送る前に pending → 成功したら registered ＋ pending を外す → 結果を書いてキューから外す
    await asCron(db, HH_A, (tx) => tx.query(`update app.purchase set tracking_register_pending_at = now() where id = $1`, [chainA.purchaseId]))
    await asCron(db, HH_A, (tx) => tx.query(
      `update app.purchase set tracking_registered_at = now(), tracking_register_pending_at = null where id = $1`, [chainA.purchaseId]))
    await asCron(db, HH_A, (tx) => tx.query(
      `update app.purchase set tracking_status = '配達中', tracking_checked_at = now(), tracking_queued_at = null where id = $1`, [chainA.purchaseId]))

    const after = await db.query<{ household_id: string; registered: boolean; pending: boolean; queued: boolean; tracking_status: string | null }>(
      `select household_id, tracking_registered_at is not null as registered, tracking_register_pending_at is not null as pending,
              tracking_queued_at is not null as queued, tracking_status from app.purchase order by household_id`)
    expect(after.rows).toEqual([
      { household_id: HH_A, registered: true, pending: false, queued: false, tracking_status: '配達中' },
      { household_id: HH_B, registered: false, pending: false, queued: true, tracking_status: null }, // B は手つかず
    ])
  })

  it('途中で切れて pending のまま残った仕入は、世帯をまたいで見つかる（まず gettrackinfo で照会してから送り直すため）', async () => {
    await db.query(
      `update app.purchase set tracking_number = 'JP-B', tracking_queued_at = now(), tracking_register_pending_at = now() - interval '10 minutes' where id = $1`,
      [chainB.purchaseId])
    const stuck = await asCron(db, null, async (tx) =>
      (await tx.query<{ id: string }>(
        `select id from app.purchase where tracking_register_pending_at is not null and tracking_registered_at is null`)).rows)
    expect(stuck).toEqual([{ id: chainB.purchaseId }])
  })

  it('キューを引く部分索引がある（tracking_queued_at is not null）', async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'app' and indexname = 'purchase_tracking_queue'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toMatch(/\(tracking_queued_at\)\s+WHERE\s+\(tracking_queued_at IS NOT NULL\)/i)
  })

  it('画面の API（soroban_api）は、世帯の中の仕入を普通に書ける（キューに積むだけ）', async () => {
    const n = await asApi(db, HH_A, async (tx) =>
      (await tx.query(`update app.purchase set tracking_number = 'JP-A', tracking_queued_at = now() where id = $1`, [chainA.purchaseId])).affectedRows)
    expect(n).toBe(1)
    const none = await asApi(db, HH_A, async (tx) =>
      (await tx.query(`update app.purchase set tracking_queued_at = now() where id = $1`, [chainB.purchaseId])).affectedRows)
    expect(none).toBe(0)
  })
})
