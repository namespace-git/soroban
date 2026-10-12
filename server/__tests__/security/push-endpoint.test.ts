import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as push from '../../domain/push'
import { newWorld, openDomainDb, type DomainDb, type World } from '../domain/helpers'
import { makeDevice } from '../push/helpers'

// Push の宛先（endpoint）は、ブラウザの Push サービスのホストに限る（20261012001900）。
// サーバーは endpoint にそのまま POST するので、許可しないと「世帯の人が好きな URL を登録 → サーバーがそこへ送る」経路になる

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

beforeEach(async () => {
  w = await newWorld(dom)
})

const countSubs = async (): Promise<number> =>
  (await dom.pg.query<{ n: number }>('select count(*)::int as n from app.push_subscription where household_id = $1', [w.a.householdId])).rows[0].n

describe('isPushServiceHost', () => {
  it('許可するのは fcm.googleapis.com と、*.push.services.mozilla.com・*.push.apple.com・*.notify.windows.com', () => {
    for (const host of [
      'fcm.googleapis.com',
      'updates.push.services.mozilla.com',
      'web.push.apple.com',
      'wns2-par02p.notify.windows.com',
      'db5p.notify.windows.com',
    ]) {
      expect(push.isPushServiceHost(host), host).toBe(true)
    }
  })

  it('ドメインそのもの・似た名前・別のドメインの下は許可しない', () => {
    for (const host of [
      '', 'localhost', 'example.com', 'push.example.test',
      'googleapis.com', 'android.googleapis.com', 'evil.googleapis.com', 'fcm.googleapis.com.evil.example', 'xfcm.googleapis.com', 'fcm-googleapis.com',
      'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com', 'windows.com', 'apple.com', 'mozilla.com',
      'web.push.apple.com.evil.example', 'webpush.apple.com', 'evilpush.apple.com', 'x.notify.windows.com.evil.example',
      'fcm.googleapis.com.', 'web.push.apple.com.',
    ]) {
      expect(push.isPushServiceHost(host), host).toBe(false)
    }
  })
})

describe('savePushSubscription：宛先のホスト', () => {
  const OK_ENDPOINTS = [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com/wp/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QGxyz',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://FCM.GoogleAPIs.com/fcm/send/upper', // ホスト名は大文字小文字を区別しない
    'https://fcm.googleapis.com:443/fcm/send/explicit-port',
  ]

  it('許可した Push サービスの宛先は登録できる', async () => {
    for (const endpoint of OK_ENDPOINTS) {
      const d = await makeDevice({ endpoint })
      await w.a.run((c) => push.savePushSubscription(c, d.input))
    }
    expect(await countSubs()).toBe(OK_ENDPOINTS.length)
  })

  it('許可していないホスト・ポート・URL の書き方のごまかしは 400 で断る。何も保存しない', async () => {
    const bad = [
      'https://push.example.test/send/abc',
      'https://example.com/fcm.googleapis.com',
      'https://evil.example/?x=fcm.googleapis.com',
      'https://evil.example#.push.apple.com/x',
      'https://evil.example\\.push.apple.com/x',
      'https://fcm.googleapis.com@evil.example/x', // @ の前はユーザー名。ホストは evil.example
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com/x',
      'https://push.apple.com/x',
      'https://notify.windows.com/x',
      'https://fcm.googleapis.com:8443/fcm/send/abc', // ポートは既定（443）だけ
      'https://web.push.apple.com:444/x',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
      'https://[::1]/x',
      'http://fcm.googleapis.com/fcm/send/abc',
    ]
    for (const endpoint of bad) {
      const d = await makeDevice({ endpoint })
      const res = await w.a.call('savePushSubscription', d.input)
      expect(res.status, endpoint).toBe(400)
      expect(res.body.error?.code, endpoint).toBe('bad_request')
      expect(res.body.error?.message, endpoint).not.toContain('サーバーでエラー')
    }
    expect(await countSubs()).toBe(0)
  })

  it('許可していないホストへ上書きもできない（同じ endpoint の更新でも検査する）', async () => {
    const d = await makeDevice()
    await w.a.run((c) => push.savePushSubscription(c, d.input))
    await expect(w.a.run((c) => push.savePushSubscription(c, { ...d.input, endpoint: 'https://evil.example/x' }))).rejects.toThrow('通知の宛先')
    expect(await countSubs()).toBe(1)
  })

  it('消す側は形（https・資格情報なし・localhost や IP でない）だけを見る：許可の外の宛先が昔入っていても消せる', async () => {
    const d = await makeDevice()
    await w.a.run((c) => push.savePushSubscription(c, d.input))
    // 許可の外の宛先を持つ行（許可を足す前に入っていたもの、を DB に直接）
    await dom.pg.query(
      `insert into app.push_subscription (household_id, user_id, endpoint, p256dh, auth) values ($1, $2, 'https://push.example.test/old', 'p', 'a')`,
      [w.a.householdId, w.a.userId])
    expect(await countSubs()).toBe(2)

    await w.a.run((c) => push.deletePushSubscription(c, 'https://push.example.test/old'))
    expect(await countSubs()).toBe(1)
    // 形が悪いものは今までどおり 400
    expect((await w.a.call('deletePushSubscription', 'http://x')).status).toBe(400)
    expect((await w.a.call('deletePushSubscription', 'https://localhost/x')).status).toBe(400)
  })
})
