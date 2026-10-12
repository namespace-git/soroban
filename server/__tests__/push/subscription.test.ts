import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PushKinds } from '../../../src/shared/web-types'
import { EMPTY_SERVER_ENV, type Ctx } from '../../context'
import { handlers } from '../../rpc'
import * as push from '../../domain/push'
import { b64urlEncode } from '../../push/base64url'
import { enqueueNotification } from '../../push/notify'
import { memberOf, newWorld, openDomainDb, type DomainDb, type Member, type World } from '../domain/helpers'
import { ALL_KINDS, fakePushService, makeDevice, makeVapid, type TestVapid } from './helpers'

// 画面の口（WebApi の 6 本）：購読の保存・削除・一覧・種類の変更・試しの通知

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
  // 別のテストが積んだ配送を持ち越さない（sendTestPush は自分の出来事しか取らないが、念のため）
  await dom.pg.exec('delete from app.notification_event')
})

const OFF: PushKinds = { sale: false, shipping: false, collect: false, arrival: false }

/** 同じ世帯 A のもう 1 人（配偶者） */
async function spouseOfA(): Promise<Member> {
  const userId = randomUUID()
  await dom.pg.query('insert into auth.users (id, email) values ($1, $2)', [userId, `${userId}@example.test`])
  await dom.pg.query('insert into app.household_member (household_id, user_id) values ($1, $2)', [w.a.householdId, userId])
  return memberOf(dom, w.a.householdId, userId)
}

const withEnv = (c: Ctx): Ctx => ({ ...c, env: { ...EMPTY_SERVER_ENV, ...vapid.env } })
const countSubs = async (hh: string) =>
  (await dom.pg.query<{ n: number }>('select count(*)::int as n from app.push_subscription where household_id = $1', [hh])).rows[0].n

describe('getPushConfig', () => {
  it('公開鍵があれば返す。無ければ null（画面は通知の設定を出さない）', async () => {
    expect(await w.a.run((c) => push.getPushConfig(c))).toEqual({ vapid_public_key: null })
    expect(await w.a.run((c) => push.getPushConfig({ ...c, env: EMPTY_SERVER_ENV }))).toEqual({ vapid_public_key: null })
    expect(await w.a.run((c) => push.getPushConfig({ ...c, env: { ...EMPTY_SERVER_ENV, VAPID_PUBLIC_KEY: '  ' } }))).toEqual({ vapid_public_key: null })
    expect(await w.a.run((c) => push.getPushConfig(withEnv(c)))).toEqual({ vapid_public_key: vapid.env.VAPID_PUBLIC_KEY })
    // 秘密鍵は返さない
    expect(JSON.stringify(await w.a.run((c) => push.getPushConfig(withEnv(c))))).not.toContain(vapid.env.VAPID_PRIVATE_KEY)
  })

  it('形が正しくない公開鍵は返さない（ブラウザの購読が落ちる前に画面で隠す）。ログに鍵は出さない', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const bad of ['AAAA', b64urlEncode(new Uint8Array(65)), 'あいう']) {
        expect(await w.a.run((c) => push.getPushConfig({ ...c, env: { ...EMPTY_SERVER_ENV, VAPID_PUBLIC_KEY: bad } }))).toEqual({ vapid_public_key: null })
      }
      expect(JSON.stringify(spy.mock.calls)).not.toContain('AAAA')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('savePushSubscription / listPushDevices', () => {
  it('保存して一覧に出る。この端末（currentEndpoint と同じ）が分かる。endpoint は一覧に出さない', async () => {
    const phone = await makeDevice({ label: 'iPhone', kinds: { collect: false } })
    const pc = await makeDevice({ label: 'リビングの PC' })
    await w.a.run((c) => push.savePushSubscription(c, phone.input))
    await w.a.run((c) => push.savePushSubscription(c, pc.input))

    const list = await w.a.run((c) => push.listPushDevices(c, phone.input.endpoint))
    expect(list.map((d) => d.label)).toEqual(['iPhone', 'リビングの PC'])
    expect(list.map((d) => d.is_this_device)).toEqual([true, false])
    expect(list[0].kinds).toEqual({ sale: true, shipping: true, collect: false, arrival: true })
    expect(list[0].created_at).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(JSON.stringify(list)).not.toContain(phone.input.endpoint)
    expect(JSON.stringify(list)).not.toContain(phone.input.auth)

    // currentEndpoint が無ければ、どれも「この端末」ではない
    expect((await w.a.run((c) => push.listPushDevices(c, null))).map((d) => d.is_this_device)).toEqual([false, false])
  })

  it('同じ endpoint は上書き（1 行のまま、名前・種類・鍵が替わる。作った日は変わらない）', async () => {
    const d = await makeDevice({ label: '前の名前', kinds: { sale: false } })
    await w.a.run((c) => push.savePushSubscription(c, d.input))
    const before = (await w.a.run((c) => push.listPushDevices(c, null)))[0]

    const other = await makeDevice()
    await w.a.run((c) => push.savePushSubscription(c, {
      ...d.input, label: '新しい名前', kinds: { ...ALL_KINDS, shipping: false }, p256dh: other.input.p256dh, auth: other.input.auth,
    }))
    const list = await w.a.run((c) => push.listPushDevices(c, null))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: before.id, label: '新しい名前', created_at: before.created_at })
    expect(list[0].kinds).toEqual({ sale: true, shipping: false, collect: true, arrival: true })
    const stored = await dom.pg.query<{ p256dh: string; auth: string }>('select p256dh, auth from app.push_subscription where id = $1', [before.id])
    expect(stored.rows[0]).toEqual({ p256dh: other.input.p256dh, auth: other.input.auth })
  })

  it('鍵は詰め物（=）つきでも受け、詰め物なしの形で保存する。名前の余分な空白は整える', async () => {
    const d = await makeDevice()
    await w.a.run((c) => push.savePushSubscription(c, { ...d.input, p256dh: `${d.input.p256dh}=`, auth: `${d.input.auth}==`, label: '  my\n phone  ' }))
    const r = await dom.pg.query<{ p256dh: string; auth: string; label: string }>(
      'select p256dh, auth, label from app.push_subscription where household_id = $1', [w.a.householdId])
    expect(r.rows).toEqual([{ p256dh: d.input.p256dh, auth: d.input.auth, label: 'my phone' }])
  })

  it('名前が空なら一覧では「端末」。名前の最大は 200 文字', async () => {
    const d = await makeDevice({ label: '' })
    await w.a.run((c) => push.savePushSubscription(c, d.input))
    expect((await w.a.run((c) => push.listPushDevices(c, null)))[0].label).toBe('端末')
    await expect(w.a.run((c) => push.savePushSubscription(c, { ...d.input, label: 'あ'.repeat(201) }))).rejects.toThrow('200文字')
    await w.a.run((c) => push.savePushSubscription(c, { ...d.input, label: 'あ'.repeat(200) }))
  })

  it('変な値は 400（500 にならない）：endpoint・鍵・名前・種類', async () => {
    const d = await makeDevice()
    const ok = d.input
    const good = Uint8Array.from([0x04, ...new Uint8Array(64).fill(7)])
    const bad: Array<[string, unknown]> = [
      ['入力が null', null],
      ['入力が配列', []],
      ['endpoint が http', { ...ok, endpoint: 'http://push.example.test/x' }],
      ['endpoint が javascript:', { ...ok, endpoint: 'javascript:alert(1)' }],
      ['endpoint が相対', { ...ok, endpoint: '/x' }],
      ['endpoint が数', { ...ok, endpoint: 5 }],
      ['endpoint が無い', { ...ok, endpoint: undefined }],
      ['endpoint が空白入り', { ...ok, endpoint: 'https://fcm.googleapis.com/fcm/send/a b' }],
      ['endpoint が 2001 文字', { ...ok, endpoint: `https://fcm.googleapis.com/${'a'.repeat(2001 - 27)}` }],
      ['endpoint が localhost', { ...ok, endpoint: 'https://localhost/x' }],
      ['endpoint が IP 直指定', { ...ok, endpoint: 'https://10.0.0.1/x' }],
      ['endpoint が IPv6 直指定', { ...ok, endpoint: 'https://[::1]/x' }],
      ['endpoint が資格情報つき', { ...ok, endpoint: 'https://user:pw@fcm.googleapis.com/x' }],
      ['p256dh が base64url でない', { ...ok, p256dh: 'abc+/=' }],
      ['p256dh が 64 バイト', { ...ok, p256dh: b64urlEncode(good.slice(0, 64)) }],
      ['p256dh の先頭が 0x04 でない', { ...ok, p256dh: b64urlEncode(Uint8Array.from([0x02, ...good.slice(1)])) }],
      ['p256dh が数', { ...ok, p256dh: 1 }],
      ['auth が 15 バイト', { ...ok, auth: b64urlEncode(new Uint8Array(15)) }],
      ['auth が 17 バイト', { ...ok, auth: b64urlEncode(new Uint8Array(17)) }],
      ['auth が無い', { ...ok, auth: null }],
      ['名前が数', { ...ok, label: 3 }],
      ['種類が無い', { ...ok, kinds: undefined }],
      ['種類が配列', { ...ok, kinds: [] }],
      ['種類の値が真偽値でない', { ...ok, kinds: { ...ALL_KINDS, sale: 'yes' } }],
      ['種類が足りない', { ...ok, kinds: { sale: true } }],
    ]
    for (const [name, input] of bad) {
      const res = await w.a.call('savePushSubscription', input)
      expect(res.status, name).toBe(400)
      expect(res.body.error?.message, name).not.toContain('サーバーでエラー')
    }
    expect(await countSubs(w.a.householdId)).toBe(0)
    // 正しい入力は通る（API 経由）
    expect((await w.a.call('savePushSubscription', ok)).status).toBe(200)
  })

  it('同じ世帯の別の人の端末も一覧に出る。そのブラウザで入り直した人が持ち主になる', async () => {
    const spouse = await spouseOfA()
    const mine = await makeDevice({ label: '私の端末' })
    const theirs = await makeDevice({ label: '配偶者の端末' })
    await w.a.run((c) => push.savePushSubscription(c, mine.input))
    await spouse.run((c) => push.savePushSubscription(c, theirs.input))

    expect((await w.a.run((c) => push.listPushDevices(c, null))).map((d) => d.label)).toEqual(['私の端末', '配偶者の端末'])
    expect((await spouse.run((c) => push.listPushDevices(c, null))).map((d) => d.label)).toEqual(['私の端末', '配偶者の端末'])

    // 配偶者が自分の端末のブラウザで私のアカウントに入り直した → 持ち主は私
    await w.a.run((c) => push.savePushSubscription(c, theirs.input))
    const owner = await dom.pg.query<{ user_id: string }>('select user_id from app.push_subscription where endpoint = $1', [theirs.input.endpoint])
    expect(owner.rows[0].user_id).toBe(w.a.userId)
    expect(await countSubs(w.a.householdId)).toBe(2)
  })

  it('別の世帯からは見えない。別の世帯が同じ endpoint を登録しようとしても 500 ではなく 409', async () => {
    const d = await makeDevice({ label: 'A の端末' })
    await w.a.run((c) => push.savePushSubscription(c, d.input))
    expect(await w.b.run((c) => push.listPushDevices(c, d.input.endpoint))).toEqual([])

    const res = await w.b.call('savePushSubscription', d.input)
    expect(res.status).toBe(409)
    expect(res.body.error?.message).toContain('ほかの世帯')
    // A の行は変わっていない
    const list = await w.a.run((c) => push.listPushDevices(c, d.input.endpoint))
    expect(list).toHaveLength(1)
    expect(list[0].label).toBe('A の端末')
    expect(await countSubs(w.b.householdId)).toBe(0)
  })
})

describe('deletePushSubscription', () => {
  it('自分の端末を消す。その端末への配送も消える', async () => {
    const d = await makeDevice()
    await w.a.run(async (c) => {
      await push.savePushSubscription(c, d.input)
      await enqueueNotification(c.sql, { kind: 'sale', title: 't', body: '', url: null, dedupeKey: 'k1' })
    })
    const del = () => dom.pg.query<{ n: number }>('select count(*)::int as n from app.notification_delivery where household_id = $1', [w.a.householdId])
    expect((await del()).rows[0].n).toBe(1)

    await w.a.run((c) => push.deletePushSubscription(c, d.input.endpoint))
    expect(await countSubs(w.a.householdId)).toBe(0)
    expect((await del()).rows[0].n).toBe(0)
  })

  it('ほかの人の端末（同じ世帯の配偶者）は消せない。何も起きず、エラーにもならない', async () => {
    const spouse = await spouseOfA()
    const theirs = await makeDevice()
    await spouse.run((c) => push.savePushSubscription(c, theirs.input))
    await w.a.run((c) => push.deletePushSubscription(c, theirs.input.endpoint))
    expect(await countSubs(w.a.householdId)).toBe(1)
    await spouse.run((c) => push.deletePushSubscription(c, theirs.input.endpoint))
    expect(await countSubs(w.a.householdId)).toBe(0)
  })

  it('別の世帯の端末も消せない。無い endpoint は何もしない。変な endpoint は 400', async () => {
    const d = await makeDevice()
    await w.a.run((c) => push.savePushSubscription(c, d.input))
    await w.b.run((c) => push.deletePushSubscription(c, d.input.endpoint))
    expect(await countSubs(w.a.householdId)).toBe(1)
    await w.a.run((c) => push.deletePushSubscription(c, 'https://push.example.test/none'))
    expect(await countSubs(w.a.householdId)).toBe(1)
    expect((await w.a.call('deletePushSubscription', 'http://x')).status).toBe(400)
    expect((await w.a.call('deletePushSubscription', null)).status).toBe(400)
  })
})

describe('setPushKinds', () => {
  it('自分の端末の受け取る種類を変える', async () => {
    const d = await makeDevice()
    await w.a.run((c) => push.savePushSubscription(c, d.input))
    const [dev] = await w.a.run((c) => push.listPushDevices(c, null))
    await w.a.run((c) => push.setPushKinds(c, dev.id, { sale: false, shipping: true, collect: false, arrival: true }))
    expect((await w.a.run((c) => push.listPushDevices(c, null)))[0].kinds).toEqual({ sale: false, shipping: true, collect: false, arrival: true })
    // 全部切るのもよい（端末は残る）
    await w.a.run((c) => push.setPushKinds(c, dev.id, OFF))
    expect((await w.a.run((c) => push.listPushDevices(c, null)))[0].kinds).toEqual(OFF)
  })

  it('配偶者の端末・別の世帯の端末・無い端末は「見つかりません」（404）。変な値は 400', async () => {
    const spouse = await spouseOfA()
    const theirs = await makeDevice()
    await spouse.run((c) => push.savePushSubscription(c, theirs.input))
    const [dev] = await w.a.run((c) => push.listPushDevices(c, null))

    expect((await w.a.call('setPushKinds', dev.id, OFF)).status).toBe(404)
    expect((await w.b.call('setPushKinds', dev.id, OFF)).status).toBe(404)
    expect((await w.a.call('setPushKinds', randomUUID(), OFF)).status).toBe(404)
    expect((await w.a.call('setPushKinds', 'not-a-uuid', OFF)).status).toBe(400)
    expect((await w.a.call('setPushKinds', dev.id, { sale: 1 })).status).toBe(400)
    expect((await w.a.call('setPushKinds', dev.id, null)).status).toBe(400)
    // 持ち主本人は変えられる
    expect((await spouse.call('setPushKinds', dev.id, OFF)).status).toBe(200)
    expect((await w.a.run((c) => push.listPushDevices(c, null)))[0].kinds).toEqual(OFF)
  })
})

describe('sendTestPush（すぐ送る）', () => {
  const saveAll = async (m: Member, ...labels: string[]) => {
    const out = []
    for (const label of labels) {
      const d = await makeDevice({ label })
      await m.run((c) => push.savePushSubscription(c, d.input))
      out.push(d)
    }
    return out
  }

  const deliveryStates = async (hh: string) =>
    (await dom.pg.query<{ status: string; attempts: number; label: string }>(
      `select d.status, d.attempts, s.label
         from app.notification_delivery d join app.push_subscription s on s.household_id = d.household_id and s.id = d.subscription_id
        where d.household_id = $1 order by s.label`, [hh])).rows

  it('自分の端末すべてに送り、届いた数を返す。本文は端末の鍵で復号できて、tag は event id', async () => {
    const [phone, pc] = await saveAll(w.a, 'iPhone', 'PC')
    const svc = fakePushService(201)
    const r = await w.a.run((c) => push.sendTestPush(withEnv(c), { fetch: svc.fetch }))
    expect(r).toEqual({ sent: 2, failed: 0 })
    expect(svc.calls.map((c) => c.endpoint).sort()).toEqual([phone.input.endpoint, pc.input.endpoint].sort())

    const ev = await dom.pg.query<{ id: string; kind: string; dedupe_key: string }>(
      'select id, kind, dedupe_key from app.notification_event where household_id = $1', [w.a.householdId])
    expect(ev.rows).toHaveLength(1)
    expect(ev.rows[0].kind).toBe('test')
    expect(ev.rows[0].dedupe_key).toMatch(/^test:/)
    const call = svc.calls.find((c) => c.endpoint === phone.input.endpoint)!
    expect(await phone.decrypt(call.body)).toEqual({
      title: '試しの通知です', body: expect.stringContaining('届いていれば'), url: '/', tag: ev.rows[0].id,
    })
    expect(await deliveryStates(w.a.householdId)).toEqual([
      { status: 'sent', attempts: 1, label: 'PC' }, { status: 'sent', attempts: 1, label: 'iPhone' },
    ].sort((a, b) => (a.label < b.label ? -1 : 1)))
  })

  it('種類をすべて切った端末にも届く（test は種類の設定に縛られない）', async () => {
    const d = await makeDevice({ kinds: OFF })
    await w.a.run((c) => push.savePushSubscription(c, d.input))
    const svc = fakePushService(201)
    expect(await w.a.run((c) => push.sendTestPush(withEnv(c), { fetch: svc.fetch }))).toEqual({ sent: 1, failed: 0 })
  })

  it('配偶者の端末・別の世帯の端末には送らない（自分の端末だけ）', async () => {
    const spouse = await spouseOfA()
    const [mine] = await saveAll(w.a, '私')
    await saveAll(spouse, '配偶者')
    await saveAll(w.b, 'B の端末')
    const svc = fakePushService(201)
    expect(await w.a.run((c) => push.sendTestPush(withEnv(c), { fetch: svc.fetch }))).toEqual({ sent: 1, failed: 0 })
    expect(svc.calls.map((c) => c.endpoint)).toEqual([mine.input.endpoint])
  })

  it('端末が 1 つも無ければ 0 件（エラーにしない）', async () => {
    const svc = fakePushService(201)
    expect(await w.a.run((c) => push.sendTestPush(withEnv(c), { fetch: svc.fetch }))).toEqual({ sent: 0, failed: 0 })
    expect(svc.calls).toHaveLength(0)
  })

  it('届かなかった端末は failed に数える。再送待ちには残さない（画面に「届かなかった」と返したあとで届かない）', async () => {
    const [ok, ng, down] = await saveAll(w.a, 'a-届く', 'b-500', 'c-通信失敗')
    const svc = fakePushService(201, {
      [ng.input.endpoint]: 500,
      [down.input.endpoint]: new Error('network down'),
    })
    const r = await w.a.run((c) => push.sendTestPush(withEnv(c), { fetch: svc.fetch }))
    expect(r).toEqual({ sent: 1, failed: 2 })
    expect(ok.input.endpoint).toBeTruthy()
    expect(await deliveryStates(w.a.householdId)).toEqual([
      { status: 'sent', attempts: 1, label: 'a-届く' },
      { status: 'failed', attempts: 1, label: 'b-500' },
      { status: 'failed', attempts: 1, label: 'c-通信失敗' },
    ])
    const err = await dom.pg.query<{ last_error: string }>(
      `select last_error from app.notification_delivery where household_id = $1 and status = 'failed' order by last_error`, [w.a.householdId])
    expect(err.rows[0].last_error).toContain('HTTP 500')
  })

  it('404 / 410 は failed に数え、その購読は消える', async () => {
    const [gone] = await saveAll(w.a, 'gone')
    const svc = fakePushService(410)
    expect(await w.a.run((c) => push.sendTestPush(withEnv(c), { fetch: svc.fetch }))).toEqual({ sent: 0, failed: 1 })
    expect(await countSubs(w.a.householdId)).toBe(0)
    expect(gone.input.endpoint).toBeTruthy()
  })

  it('押すたびに別の出来事になる（dedupe_key が毎回違う）', async () => {
    await saveAll(w.a, 'iPhone')
    const svc = fakePushService(201)
    await w.a.run((c) => push.sendTestPush(withEnv(c), { fetch: svc.fetch }))
    await w.a.run((c) => push.sendTestPush(withEnv(c), { fetch: svc.fetch }))
    expect(svc.calls).toHaveLength(2)
    const ev = await dom.pg.query('select id from app.notification_event where household_id = $1', [w.a.householdId])
    expect(ev.rows).toHaveLength(2)
  })

  it('鍵が無い・形が違うときは、日本語で理由を返す（出来事も積まない）', async () => {
    await saveAll(w.a, 'iPhone')
    const svc = fakePushService(201)
    await expect(w.a.run((c) => push.sendTestPush({ ...c, env: EMPTY_SERVER_ENV }, { fetch: svc.fetch }))).rejects.toThrow('鍵がサーバーに設定されていません')
    await expect(w.a.run((c) => push.sendTestPush({ ...c, env: { ...EMPTY_SERVER_ENV, ...vapid.env, VAPID_SUBJECT: 'x' } }, { fetch: svc.fetch })))
      .rejects.toThrow('VAPID_SUBJECT')
    expect(svc.calls).toHaveLength(0)
    expect((await dom.pg.query('select id from app.notification_event where household_id = $1', [w.a.householdId])).rows).toHaveLength(0)
    // API 経由（Ctx に鍵を渡していない入口）でも 500 にならず 400
    const res = await w.a.call('sendTestPush')
    expect(res.status).toBe(400)
    expect(res.body.error?.message).toContain('鍵がサーバーに設定されていません')
  })

  it('取り込みや販売の通知（test 以外）の配送は取らない。コミットの後に Cron が送る', async () => {
    await saveAll(w.a, 'iPhone')
    await w.a.run((c) => enqueueNotification(c.sql, { kind: 'sale', title: '売れました', body: '', url: null, dedupeKey: 'sale:x' }))
    const svc = fakePushService(201)
    expect(await w.a.run((c) => push.sendTestPush(withEnv(c), { fetch: svc.fetch }))).toEqual({ sent: 1, failed: 0 })
    expect(svc.calls).toHaveLength(1)
    const states = await dom.pg.query<{ kind: string; status: string }>(
      `select e.kind, d.status from app.notification_delivery d join app.notification_event e on e.household_id = d.household_id and e.id = d.event_id
        where d.household_id = $1 order by e.kind`, [w.a.householdId])
    expect(states.rows).toEqual([{ kind: 'sale', status: 'pending' }, { kind: 'test', status: 'sent' }])
  })
})

describe('API として登録されている', () => {
  it('WebApi の 6 本が handlers に入っている。契約の名前と一致', () => {
    const names = ['getPushConfig', 'savePushSubscription', 'deletePushSubscription', 'listPushDevices', 'setPushKinds', 'sendTestPush']
    expect(Object.keys(push.pushHandlers).sort()).toEqual([...names].sort())
    for (const n of names) expect(handlers[n as keyof typeof handlers], n).toBeTypeOf('function')
  })

  it('dispatch 経由で呼べる（getPushConfig は env が無ければ null、listPushDevices は引数を渡せる）', async () => {
    expect((await w.a.call('getPushConfig')).body.result).toEqual({ vapid_public_key: null })
    const d = await makeDevice({ label: 'iPhone' })
    expect((await w.a.call('savePushSubscription', d.input)).status).toBe(200)
    const list = (await w.a.call('listPushDevices', d.input.endpoint)).body.result as Array<{ label: string; is_this_device: boolean }>
    expect(list).toMatchObject([{ label: 'iPhone', is_this_device: true }])
    // HTTP は途中の undefined を null で送る
    expect((await w.a.call('listPushDevices', null)).status).toBe(200)
    expect((await w.a.call('deletePushSubscription', d.input.endpoint)).status).toBe(200)
  })
})
