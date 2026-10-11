import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMigratedDb } from '../../test/migrate'
import {
  addSecondMemberToA, asApi, asRole, enqueue, HH_A, HH_B, insertSub, seedHouseholds, sqlstateOf, USER_A, USER_A2, USER_B,
  type Sub,
} from './helpers'

// 通知（20261012001510_notification.sql）：出来事（notification_event）と端末ごとの配送（notification_delivery）。
// enqueue_notification・claim_deliveries・complete_delivery。soroban_api ＋世帯 A（B は隔離の確認）で呼ぶ。
// 時計は next_attempt_at・claimed_at を過去に書き換えて進める。
// PGlite は接続が 1 本なので、2 本の送信役が本当に同時に走る形は作れない。skip locked は
// 「続けて 2 回取っても同じ配送を取らない」ことと、関数の定義に skip locked があることで確かめる

let db: PGlite
let phoneA: Sub // 世帯 A・USER_A の端末（全部受け取る）
let pcA: Sub    // 世帯 A・USER_A の端末（売れた通知は切ってある）
let phoneA2: Sub // 世帯 A・USER_A2 の端末
let phoneB: Sub // 世帯 B

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
  await addSecondMemberToA(db)
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec('delete from app.notification_event') // delivery は cascade
  await db.exec('delete from app.push_subscription')
  phoneA = await asApi(db, HH_A, (tx) => insertSub(tx, USER_A, { label: 'iPhone' }))
  pcA = await asApi(db, HH_A, (tx) => insertSub(tx, USER_A, { label: 'リビングの PC', kinds: { sale: false } }))
  phoneA2 = await asApi(db, HH_A, (tx) => insertSub(tx, USER_A2, { label: '妻の iPhone' }))
  phoneB = await asApi(db, HH_B, (tx) => insertSub(tx, USER_B, { label: 'B の iPhone' }))
})

interface Delivery {
  id: string
  household_id: string
  event_id: string
  subscription_id: string
  status: string
  attempts: number
  next_attempt_at: string
  claimed_at: string | null
  last_error: string | null
  sent_at: string | null
}

const deliveries = async (eventId?: string): Promise<Delivery[]> =>
  (await db.query<Delivery>(
    `select * from app.notification_delivery ${eventId ? 'where event_id = $1' : ''} order by subscription_id`,
    eventId ? [eventId] : [],
  )).rows

const subsOf = async (eventId: string): Promise<string[]> =>
  (await deliveries(eventId)).map((d) => d.subscription_id).sort()

interface Claimed {
  delivery_id: string
  household_id: string
  event_id: string
  subscription_id: string
  kind: string
  title: string
  body: string
  url: string | null
  endpoint: string
  p256dh: string
  auth: string
  attempts: number
}

const claim = (hh = HH_A, limit = 20, lease = '2 minutes') =>
  asApi(db, hh, async (tx) =>
    (await tx.query<Claimed>('select * from app.claim_deliveries($1, $2::interval)', [limit, lease])).rows)

const complete = (id: string, ok: boolean, error: string | null = null, gone = false, hh = HH_A) =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ s: string | null }>('select app.complete_delivery($1, $2, $3, $4) as s', [id, ok, error, gone])).rows[0].s)

/** 送る番を今にする（再送待ちの時計を進める） */
const dueNow = (id: string) =>
  db.query(`update app.notification_delivery set next_attempt_at = now() - interval '1 second' where id = $1`, [id])

describe('enqueue_notification', () => {
  it('event を 1 行と、受け取る端末ぶんの delivery を作る。event の id を返す', async () => {
    const id = await enqueue(db, HH_A, 'shipping', 'shipping:2026-10-12')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    const ev = await db.query('select household_id, kind, title, body, url, dedupe_key from app.notification_event where id = $1', [id])
    expect(ev.rows).toEqual([{
      household_id: HH_A, kind: 'shipping', title: '題名 shipping:2026-10-12', body: '本文', url: '/sales', dedupe_key: 'shipping:2026-10-12',
    }])
    // 世帯 A の 3 台。世帯 B の端末には作らない
    expect(await subsOf(id!)).toEqual([phoneA.id, pcA.id, phoneA2.id].sort())
    for (const d of await deliveries(id!)) {
      expect(d).toMatchObject({ status: 'pending', attempts: 0, claimed_at: null, last_error: null, sent_at: null, household_id: HH_A })
    }
  })

  it('その種類を切った端末には delivery を作らない（種類ごとに別の列）', async () => {
    const sale = await enqueue(db, HH_A, 'sale', 'sale:1')
    expect(await subsOf(sale!)).toEqual([phoneA.id, phoneA2.id].sort()) // pcA は売れた通知を切ってある

    await db.query('update app.push_subscription set kind_shipping = false, kind_collect = false, kind_arrival = false where id = $1', [phoneA2.id])
    expect(await subsOf((await enqueue(db, HH_A, 'shipping', 'ship:1'))!)).toEqual([phoneA.id, pcA.id].sort())
    expect(await subsOf((await enqueue(db, HH_A, 'collect', 'collect:1'))!)).toEqual([phoneA.id, pcA.id].sort())
    expect(await subsOf((await enqueue(db, HH_A, 'arrival', 'arrival:1'))!)).toEqual([phoneA.id, pcA.id].sort())
  })

  it('全部の種類を切った端末には、test 以外は何も作らない。test は種類の設定に縛られない', async () => {
    await db.query('update app.push_subscription set kind_sale = false, kind_shipping = false, kind_collect = false, kind_arrival = false')
    for (const kind of ['sale', 'shipping', 'collect', 'arrival']) {
      const id = await enqueue(db, HH_A, kind, `${kind}:1`)
      expect(id, kind).not.toBeNull() // event は残る
      expect(await deliveries(id!), kind).toEqual([])
    }
    const test = await enqueue(db, HH_A, 'test', 'test:1')
    expect(await subsOf(test!)).toEqual([phoneA.id, pcA.id, phoneA2.id].sort())
  })

  it('p_user_id を渡すと、その人の端末だけ（試しの通知は自分の端末だけ）', async () => {
    const id = await enqueue(db, HH_A, 'test', 'test:me', { userId: USER_A2 })
    expect(await subsOf(id!)).toEqual([phoneA2.id])
  })

  it('同じ dedupe_key で 2 回呼んでも、event も delivery も 1 つ（2 回目は null）', async () => {
    const first = await enqueue(db, HH_A, 'sale', 'sale:dup')
    const second = await enqueue(db, HH_A, 'sale', 'sale:dup', { title: '別の題名でも' })
    expect(first).not.toBeNull()
    expect(second).toBeNull()

    const events = await db.query<{ n: number }>(`select count(*)::int as n from app.notification_event where dedupe_key = 'sale:dup'`)
    expect(events.rows[0].n).toBe(1)
    expect((await deliveries()).length).toBe(2)
    // 先に積んだ方の題名のまま
    const ev = await db.query<{ title: string }>('select title from app.notification_event where id = $1', [first])
    expect(ev.rows[0].title).toBe('題名 sale:dup')
  })

  it('同じトランザクションの中で 2 回呼んでも 1 つ', async () => {
    const r = await asApi(db, HH_A, async (tx) => {
      const call = async () => (await tx.query<{ id: string | null }>(
        `select app.enqueue_notification('sale', 't', '', null, 'sale:same-tx') as id`)).rows[0].id
      return [await call(), await call()]
    })
    expect(r[0]).not.toBeNull()
    expect(r[1]).toBeNull()
  })

  it('同じ dedupe_key でも世帯が違えば別の出来事（dedupe_key は世帯の中で一意）', async () => {
    const a = await enqueue(db, HH_A, 'sale', 'sale:1')
    const b = await enqueue(db, HH_B, 'sale', 'sale:1')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(await subsOf(b!)).toEqual([phoneB.id])
  })

  it('業務と同じトランザクション：業務が巻き戻れば、通知も消える', async () => {
    const code = await sqlstateOf(() =>
      asApi(db, HH_A, async (tx) => {
        await tx.query(`select app.enqueue_notification('sale', 't', '', null, 'sale:rollback')`)
        await tx.query(`insert into app.tag (name) values ('a')`)
        await tx.query(`insert into app.tag (name) values ('a')`) // 一意違反で巻き戻る
      }),
    )
    expect(code).toBe('23505')
    expect((await db.query(`select 1 from app.notification_event where dedupe_key = 'sale:rollback'`)).rows).toEqual([])
    expect(await deliveries()).toEqual([])
  })

  it('購読が 1 つも無い世帯でも event は残る（delivery は 0 件）', async () => {
    await db.exec('delete from app.push_subscription')
    const id = await enqueue(db, HH_A, 'sale', 'sale:nobody')
    expect(id).not.toBeNull()
    expect(await deliveries(id!)).toEqual([])
  })

  it('引数の検査：種類・題名・本文・行き先・dedupe_key が不正なら 22023', async () => {
    const call = (kind: string | null, title: string | null, body: string | null, url: string | null, key: string | null) =>
      sqlstateOf(() => asApi(db, HH_A, (tx) => tx.query('select app.enqueue_notification($1, $2, $3, $4, $5)', [kind, title, body, url, key])))
    expect(await call('mail', 't', '', null, 'k')).toBe('22023')
    expect(await call(null, 't', '', null, 'k')).toBe('22023')
    expect(await call('sale', '', '', null, 'k')).toBe('22023')
    expect(await call('sale', '   ', '', null, 'k')).toBe('22023')
    expect(await call('sale', null, '', null, 'k')).toBe('22023')
    expect(await call('sale', 'x'.repeat(201), '', null, 'k')).toBe('22023')
    expect(await call('sale', 't', 'x'.repeat(1001), null, 'k')).toBe('22023')
    expect(await call('sale', 't', '', 'x'.repeat(2001), 'k')).toBe('22023')
    expect(await call('sale', 't', '', null, null)).toBe('22023')
    expect(await call('sale', 't', '', null, '  ')).toBe('22023')
    expect(await call('sale', 't', '', null, 'x'.repeat(301))).toBe('22023')
    // 本文と行き先は無くてよい（null → 本文は空文字）
    expect(await call('sale', 't', null, null, 'ok-1')).toBeNull()
    expect((await db.query<{ body: string }>(`select body from app.notification_event where dedupe_key = 'ok-1'`)).rows[0].body).toBe('')
    expect(await call('sale', 'x'.repeat(200), 'y'.repeat(1000), 'z'.repeat(2000), 'ok-2')).toBeNull()
  })

  it('event.kind は sale / shipping / collect / arrival / test だけ（表の check）。dedupe_key は not null', async () => {
    expect(await sqlstateOf(() => asApi(db, HH_A, (tx) =>
      tx.query(`insert into app.notification_event (kind, title, dedupe_key) values ('mail', 't', 'k')`)))).toBe('23514')
    expect(await sqlstateOf(() => asApi(db, HH_A, (tx) =>
      tx.query(`insert into app.notification_event (kind, title) values ('sale', 't')`)))).toBe('23502')
  })

  it('他の世帯の購読には、配送を作れない（複合外部キー）', async () => {
    const id = await enqueue(db, HH_A, 'sale', 'sale:fk')
    const code = await sqlstateOf(() =>
      db.query(
        `insert into app.notification_delivery (household_id, event_id, subscription_id) values ($1, $2, $3)`,
        [HH_A, id, phoneB.id],
      ),
    )
    expect(code).toBe('23503')
  })

  it('同じ出来事 × 同じ端末の配送は 1 つだけ（unique (event_id, subscription_id)）', async () => {
    const id = await enqueue(db, HH_A, 'sale', 'sale:uniq')
    const code = await sqlstateOf(() =>
      asApi(db, HH_A, (tx) => tx.query('insert into app.notification_delivery (event_id, subscription_id) values ($1, $2)', [id, phoneA.id])),
    )
    expect(code).toBe('23505')
  })

  it('購読を消すと配送も消える。出来事を消しても配送が消える', async () => {
    const id = await enqueue(db, HH_A, 'shipping', 'ship:cascade')
    expect((await deliveries(id!)).length).toBe(3)
    await asApi(db, HH_A, (tx) => tx.query('delete from app.push_subscription where id = $1', [pcA.id]))
    expect(await subsOf(id!)).toEqual([phoneA.id, phoneA2.id].sort())
    await db.query('delete from app.notification_event where id = $1', [id])
    expect(await deliveries()).toEqual([])
  })
})

describe('claim_deliveries', () => {
  it('送る番が来た pending を sending にして、送るのに要るものを返す。attempts が 1 になる', async () => {
    const id = (await enqueue(db, HH_A, 'sale', 'sale:1'))!
    const got = await claim()
    expect(got).toHaveLength(2)
    const phone = got.find((c) => c.subscription_id === phoneA.id)!
    expect(phone).toMatchObject({
      household_id: HH_A, event_id: id, kind: 'sale', title: '題名 sale:1', body: '本文', url: '/sales',
      endpoint: phoneA.endpoint, p256dh: 'p', auth: 'a', attempts: 1,
    })
    for (const d of await deliveries(id)) {
      expect(d.status).toBe('sending')
      expect(d.claimed_at).not.toBeNull()
      expect(d.attempts).toBe(1)
    }
  })

  it('続けて 2 回取っても、同じ配送を 2 回取らない（2 本の送信役を並べたときと同じ）', async () => {
    await enqueue(db, HH_A, 'shipping', 'ship:1')
    const first = await claim()
    const second = await claim()
    expect(first).toHaveLength(3)
    expect(second).toEqual([])
    // 同じトランザクションの中でも
    await enqueue(db, HH_A, 'shipping', 'ship:2')
    const both = await asApi(db, HH_A, async (tx) => {
      const a = (await tx.query<Claimed>('select * from app.claim_deliveries(2)')).rows
      const b = (await tx.query<Claimed>('select * from app.claim_deliveries(20)')).rows
      return { a, b }
    })
    const ids = [...both.a, ...both.b].map((c) => c.delivery_id)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
  })

  it('for update skip locked で取っている（ロックされている配送は待たずに飛ばす）', async () => {
    const def = await db.query<{ def: string }>(
      `select pg_get_functiondef('app.claim_deliveries(integer, interval)'::regprocedure) as def`,
    )
    expect(def.rows[0].def).toMatch(/for update\s+skip locked/i)
  })

  it('p_limit までしか取らない。送る番の古い順', async () => {
    await enqueue(db, HH_A, 'shipping', 'ship:1')
    const all = await deliveries()
    // 古い順を決める：phoneA2 を一番古く
    await db.query(`update app.notification_delivery set next_attempt_at = now() - interval '10 minutes' where subscription_id = $1`, [phoneA2.id])
    const got = await claim(HH_A, 1)
    expect(got.map((c) => c.subscription_id)).toEqual([phoneA2.id])
    expect(all).toHaveLength(3)
    expect((await claim(HH_A, 5)).length).toBe(2)
  })

  it('送る番が来ていない pending（再送待ち）は取らない。来たら取る', async () => {
    const id = (await enqueue(db, HH_A, 'sale', 'sale:1'))!
    await db.query(`update app.notification_delivery set next_attempt_at = now() + interval '5 minutes' where event_id = $1`, [id])
    expect(await claim()).toEqual([])
    await db.query(`update app.notification_delivery set next_attempt_at = now() - interval '1 second' where event_id = $1`, [id])
    expect(await claim()).toHaveLength(2)
  })

  it('sent・failed は取らない', async () => {
    const id = (await enqueue(db, HH_A, 'shipping', 'ship:1'))!
    const [a, b] = await deliveries(id)
    await db.query(`update app.notification_delivery set status = 'sent' where id = $1`, [a.id])
    await db.query(`update app.notification_delivery set status = 'failed' where id = $1`, [b.id])
    expect(await claim()).toHaveLength(1)
  })

  it('sending のまま p_lease を超えて止まったもの（送信役が落ちた）は取り直す。lease 内のものは取らない', async () => {
    const id = (await enqueue(db, HH_A, 'sale', 'sale:1'))!
    const first = await claim()
    expect(first).toHaveLength(2)
    expect(await claim()).toEqual([])

    await db.query(`update app.notification_delivery set claimed_at = now() - interval '3 minutes' where event_id = $1`, [id])
    const again = await claim()
    expect(again).toHaveLength(2)
    expect(again.every((c) => c.attempts === 2)).toBe(true)
    // lease を短くすれば、より新しい止まりも取り直せる
    await db.query(`update app.notification_delivery set claimed_at = now() - interval '20 seconds' where event_id = $1`, [id])
    expect(await claim(HH_A, 20, '2 minutes')).toEqual([])
    expect(await claim(HH_A, 20, '10 seconds')).toHaveLength(2)
  })

  it('止まったまま規定の回数（5）に達したものは、取り直さずに failed にする', async () => {
    const id = (await enqueue(db, HH_A, 'sale', 'sale:1'))!
    await db.query(
      `update app.notification_delivery set status = 'sending', attempts = 5, claimed_at = now() - interval '1 hour' where event_id = $1`, [id],
    )
    expect(await claim()).toEqual([])
    for (const d of await deliveries(id)) {
      expect(d).toMatchObject({ status: 'failed', claimed_at: null })
      expect(d.last_error).toContain('規定の回数')
    }
  })

  it('他の世帯の配送は取らない（soroban_api は自分の世帯の分だけ）', async () => {
    await enqueue(db, HH_B, 'sale', 'sale:b')
    expect(await claim(HH_A)).toEqual([])
    const got = await claim(HH_B)
    expect(got.map((c) => c.subscription_id)).toEqual([phoneB.id])
  })

  it('引数の検査：件数が 1 未満・null、lease が 0 以下は 22023', async () => {
    for (const [limit, lease] of [[0, '1 minute'], [-1, '1 minute'], [5, '0 seconds'], [5, '-1 minute']] as const) {
      expect(await sqlstateOf(() => claim(HH_A, limit, lease)), `${limit} ${lease}`).toBe('22023')
    }
    expect(await sqlstateOf(() => asApi(db, HH_A, (tx) => tx.query('select * from app.claim_deliveries(null)')))).toBe('22023')
  })
})

describe('complete_delivery', () => {
  const claimOne = async (): Promise<Claimed> => {
    const id = (await enqueue(db, HH_A, 'shipping', `ship:${Math.random()}`, { userId: USER_A2 }))!
    expect(id).not.toBeNull()
    const got = await claim()
    expect(got).toHaveLength(1)
    return got[0]
  }
  const one = async (id: string): Promise<Delivery> =>
    (await db.query<Delivery>('select * from app.notification_delivery where id = $1', [id])).rows[0]

  it('送れた：sent・sent_at が入り、購読の last_used_at が進む', async () => {
    const c = await claimOne()
    expect(await complete(c.delivery_id, true)).toBe('sent')
    expect(await one(c.delivery_id)).toMatchObject({ status: 'sent', last_error: null, claimed_at: null })
    expect((await one(c.delivery_id)).sent_at).not.toBeNull()
    const sub = await db.query<{ last_used_at: string | null }>('select last_used_at from app.push_subscription where id = $1', [c.subscription_id])
    expect(sub.rows[0].last_used_at).not.toBeNull()
  })

  it('失敗は pending に戻り、回数に応じて next_attempt_at が延びる（+1 分・+5 分・+30 分・+2 時間）。5 回目で failed', async () => {
    const first = await claimOne()
    const expectedMinutes = [1, 5, 30, 120]
    for (let n = 1; n <= 4; n++) {
      const before = Date.now()
      expect(await complete(first.delivery_id, false, `HTTP 503 (${n})`), `${n} 回目`).toBe('pending')
      const d = await one(first.delivery_id)
      expect(d).toMatchObject({ status: 'pending', attempts: n, claimed_at: null, last_error: `HTTP 503 (${n})` })
      const waitMin = (new Date(d.next_attempt_at).getTime() - before) / 60_000
      expect(waitMin, `${n} 回目の待ち`).toBeGreaterThan(expectedMinutes[n - 1] - 0.5)
      expect(waitMin, `${n} 回目の待ち`).toBeLessThan(expectedMinutes[n - 1] + 0.5)

      // 待ち時間のあいだは取らない。来たら取る（attempts が 1 つ増える）
      expect(await claim()).toEqual([])
      await dueNow(first.delivery_id)
      const again = await claim()
      expect(again).toHaveLength(1)
      expect(again[0].attempts).toBe(n + 1)
    }
    // 5 回目の失敗で諦める
    expect(await complete(first.delivery_id, false, 'HTTP 503 (5)')).toBe('failed')
    expect(await one(first.delivery_id)).toMatchObject({ status: 'failed', attempts: 5, last_error: 'HTTP 503 (5)', claimed_at: null })
    await dueNow(first.delivery_id)
    expect(await claim()).toEqual([])
  })

  it('途中で送れたら、そこで sent（以後は取らない）', async () => {
    const c = await claimOne()
    await complete(c.delivery_id, false, 'HTTP 429')
    await dueNow(c.delivery_id)
    const again = await claim()
    expect(await complete(again[0].delivery_id, true)).toBe('sent')
    expect(await one(c.delivery_id)).toMatchObject({ status: 'sent', attempts: 2 })
  })

  it('404 / 410（gone）は購読ごと消す。その端末の配送も一緒に消え、ほかの端末は残る', async () => {
    const id = (await enqueue(db, HH_A, 'shipping', 'ship:gone'))!
    const got = await claim()
    expect(got).toHaveLength(3)
    const target = got.find((c) => c.subscription_id === phoneA.id)!
    // 同じ購読の、別の出来事の配送も消える
    await enqueue(db, HH_A, 'collect', 'collect:gone')

    expect(await complete(target.delivery_id, false, 'HTTP 410', true)).toBe('gone')

    const subs = await db.query<{ id: string }>('select id from app.push_subscription where household_id = $1', [HH_A])
    expect(subs.rows.map((r) => r.id).sort()).toEqual([pcA.id, phoneA2.id].sort())
    expect((await deliveries()).filter((d) => d.subscription_id === phoneA.id)).toEqual([])
    expect((await deliveries(id)).length).toBe(2)
    // 世帯 B の購読は無事
    const b = await db.query('select id from app.push_subscription where id = $1', [phoneB.id])
    expect(b.rows).toHaveLength(1)
  })

  it('gone は ok より優先する。sending でない配送でも購読は消す', async () => {
    const id = (await enqueue(db, HH_A, 'shipping', 'ship:gone2', { userId: USER_A2 }))!
    const [d] = await deliveries(id) // まだ pending（取っていない）
    expect(await complete(d.id, true, null, true)).toBe('gone')
    const sub = await db.query('select id from app.push_subscription where id = $1', [phoneA2.id])
    expect(sub.rows).toEqual([])
  })

  it('配送が無い・sending でない（別の送信役が取り直した・もう済んだ）ときは null で何もしない', async () => {
    const c = await claimOne()
    expect(await complete('00000000-0000-4000-8000-000000000999', true)).toBeNull()

    await complete(c.delivery_id, true)
    expect(await complete(c.delivery_id, false, 'late')).toBeNull() // 済んだ後に遅れて失敗が来ても書き換えない
    expect(await one(c.delivery_id)).toMatchObject({ status: 'sent', last_error: null })

    // まだ pending のもの
    const id = (await enqueue(db, HH_A, 'collect', 'collect:1', { userId: USER_A2 }))!
    const [p] = await deliveries(id)
    expect(await complete(p.id, true)).toBeNull()
    expect((await one(p.id)).status).toBe('pending')
  })

  it('他の世帯の配送は書き換えられない（null。購読も消えない）', async () => {
    await enqueue(db, HH_B, 'sale', 'sale:b')
    const got = await claim(HH_B)
    expect(await complete(got[0].delivery_id, true, null, false, HH_A)).toBeNull()
    expect(await complete(got[0].delivery_id, false, null, true, HH_A)).toBeNull()
    expect((await one(got[0].delivery_id)).status).toBe('sending')
    expect((await db.query('select id from app.push_subscription where id = $1', [phoneB.id])).rows).toHaveLength(1)
  })

  it('エラー文は 500 文字まで', async () => {
    const c = await claimOne()
    await complete(c.delivery_id, false, 'x'.repeat(2000))
    expect((await one(c.delivery_id)).last_error).toHaveLength(500)
  })
})

describe('権限と隔離', () => {
  it('世帯 A からは世帯 B の出来事・配送・購読が見えない', async () => {
    await enqueue(db, HH_B, 'sale', 'sale:b')
    const seen = await asApi(db, HH_A, async (tx) => ({
      events: (await tx.query('select id from app.notification_event')).rows.length,
      deliveries: (await tx.query('select id from app.notification_delivery')).rows.length,
      subs: (await tx.query<{ id: string }>('select id from app.push_subscription')).rows.map((r) => r.id).sort(),
    }))
    expect(seen).toEqual({ events: 0, deliveries: 0, subs: [phoneA.id, pcA.id, phoneA2.id].sort() })
  })

  it('通知の関数は security invoker で、soroban_api と soroban_cron が実行できる。anon / authenticated / PUBLIC は不可', async () => {
    const { rows } = await db.query<{ proname: string; prosecdef: boolean; api: boolean; cron: boolean; anon: boolean; auth: boolean; public_exec: boolean }>(
      `select p.proname, p.prosecdef,
              has_function_privilege('soroban_api', p.oid, 'execute') as api,
              has_function_privilege('soroban_cron', p.oid, 'execute') as cron,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0) as public_exec
         from pg_proc p
        where p.pronamespace = 'app'::regnamespace
          and p.proname in ('enqueue_notification', 'claim_deliveries', 'complete_delivery')
        order by p.proname`,
    )
    expect(rows.map((r) => r.proname)).toEqual(['claim_deliveries', 'complete_delivery', 'enqueue_notification'])
    for (const r of rows) {
      expect(r, r.proname).toMatchObject({ prosecdef: false, api: true, cron: true, anon: false, auth: false, public_exec: false })
    }
    for (const role of ['anon', 'authenticated']) {
      expect(await sqlstateOf(() => asRole(db, role, (tx) => tx.query('select * from app.claim_deliveries()'))), role).toBe('42501')
      expect(await sqlstateOf(() => asRole(db, role, (tx) => tx.query('select * from app.notification_delivery'))), role).toBe('42501')
    }
  })

  it('旧 notification_outbox は無い', async () => {
    const { rows } = await db.query(`select 1 from pg_class where relnamespace = 'app'::regnamespace and relname = 'notification_outbox'`)
    expect(rows).toEqual([])
  })

  it('購読の列：端末名（label）と、種類ごとの受け取り（既定はすべて true）', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'app' and table_name = 'push_subscription'
          and column_name in ('label', 'kind_sale', 'kind_shipping', 'kind_collect', 'kind_arrival') order by column_name`,
    )
    expect(rows).toEqual([
      { column_name: 'kind_arrival', data_type: 'boolean', is_nullable: 'NO', column_default: 'true' },
      { column_name: 'kind_collect', data_type: 'boolean', is_nullable: 'NO', column_default: 'true' },
      { column_name: 'kind_sale', data_type: 'boolean', is_nullable: 'NO', column_default: 'true' },
      { column_name: 'kind_shipping', data_type: 'boolean', is_nullable: 'NO', column_default: 'true' },
      { column_name: 'label', data_type: 'text', is_nullable: 'NO', column_default: "''::text" },
    ])
    // 何も指定せずに作った購読は、全部の種類を受け取る
    const sub = await asApi(db, HH_A, async (tx) =>
      (await tx.query<Record<string, unknown>>(
        `insert into app.push_subscription (user_id, endpoint, p256dh, auth) values ($1, 'https://push.example.test/default', 'p', 'a')
         returning label, kind_sale, kind_shipping, kind_collect, kind_arrival`, [USER_A],
      )).rows[0])
    expect(sub).toEqual({ label: '', kind_sale: true, kind_shipping: true, kind_collect: true, kind_arrival: true })
    expect(await sqlstateOf(() => asApi(db, HH_A, (tx) =>
      tx.query(`insert into app.push_subscription (user_id, endpoint, p256dh, auth, label) values ($1, 'https://push.example.test/long', 'p', 'a', $2)`, [USER_A, 'x'.repeat(201)]),
    ))).toBe('23514')
  })

  it('delivery.status は pending / sending / sent / failed だけ。attempts は負にできない', async () => {
    const id = (await enqueue(db, HH_A, 'sale', 'sale:chk'))!
    const [d] = await deliveries(id)
    expect(await sqlstateOf(() => db.query(`update app.notification_delivery set status = 'done' where id = $1`, [d.id]))).toBe('23514')
    expect(await sqlstateOf(() => db.query(`update app.notification_delivery set attempts = -1 where id = $1`, [d.id]))).toBe('23514')
  })
})
