import { describe, expect, it } from 'vitest'
import { b64urlDecode, b64urlEncode } from '../../push/base64url'
import { MAX_PLAINTEXT_BYTES } from '../../push/encrypt'
import { payloadBytes, sendWebPush } from '../../push/send'
import {
  audienceOf, isValidVapidPublicKey, loadVapidKeys, signVapidJwt, vapidAuthorization, VapidConfigError, VAPID_JWT_TTL_SECONDS,
} from '../../push/vapid'
import { fakePushService, makeDevice, makeVapid } from './helpers'

const NOW = Date.UTC(2026, 9, 12, 3, 0, 0)
const PAYLOAD = { title: '売れました：【A040】もこ山 スクイーズ ¥5,750', body: '', url: '/?tab=sales&sale=x', tag: 'event-1' }

const json = (b64: string) => JSON.parse(new TextDecoder().decode(b64urlDecode(b64)!))

describe('VAPID（RFC 8292）', () => {
  it('JWT は ES256。header・aud・exp（12 時間）・sub が入り、公開鍵で署名を検証できる', async () => {
    const v = await makeVapid('mailto:owner@example.test')
    const keys = (await loadVapidKeys(v.env))!
    const jwt = await signVapidJwt(keys, 'https://push.example.test', 1_760_000_000)
    const [h, c, s] = jwt.split('.')
    expect(json(h)).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(json(c)).toEqual({ aud: 'https://push.example.test', exp: 1_760_000_000 + 12 * 3600, sub: 'mailto:owner@example.test' })
    expect(VAPID_JWT_TTL_SECONDS).toBeLessThanOrEqual(24 * 3600)
    const sig = b64urlDecode(s)!
    expect(sig.length).toBe(64) // r ‖ s（JWS の ES256 の形）
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, v.verifyKey, sig, new TextEncoder().encode(`${h}.${c}`))
    expect(ok).toBe(true)
    // 別の内容に対する署名としては通らない
    const bad = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, v.verifyKey, sig, new TextEncoder().encode(`${h}.${c}x`))
    expect(bad).toBe(false)
  })

  it('Authorization は `vapid t=<JWT>, k=<公開鍵>`。aud は送り先の origin（パス・クエリを含めない）', async () => {
    const v = await makeVapid()
    const keys = (await loadVapidKeys(v.env))!
    const header = await vapidAuthorization(keys, 'https://fcm.example.test:8443/fcm/send/abc?x=1', 1_760_000_000)
    const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header)!
    expect(m).not.toBeNull()
    expect(m[2]).toBe(v.env.VAPID_PUBLIC_KEY)
    expect(json(m[1].split('.')[1]).aud).toBe('https://fcm.example.test:8443')
    expect(audienceOf('https://web.push.apple.com/abc')).toBe('https://web.push.apple.com')
    expect(() => audienceOf('http://push.example.test/x')).toThrow('https')
  })

  it('鍵：無ければ null（通知を使わない）。形が違えば VapidConfigError（値をメッセージに入れない）', async () => {
    const v = await makeVapid()
    expect(await loadVapidKeys({})).toBeNull()
    expect(await loadVapidKeys({ VAPID_PUBLIC_KEY: v.env.VAPID_PUBLIC_KEY })).toBeNull()
    expect(await loadVapidKeys({ VAPID_PRIVATE_KEY: v.env.VAPID_PRIVATE_KEY, VAPID_SUBJECT: v.env.VAPID_SUBJECT })).toBeNull()
    expect(await loadVapidKeys({ ...v.env, VAPID_PRIVATE_KEY: '  ' })).toBeNull()

    const cases: Array<[Record<string, string>, string]> = [
      [{ VAPID_PUBLIC_KEY: 'AAAA' }, 'VAPID_PUBLIC_KEY'],
      [{ VAPID_PUBLIC_KEY: b64urlEncode(new Uint8Array(65)) }, 'VAPID_PUBLIC_KEY'], // 先頭が 0x04 でない
      [{ VAPID_PRIVATE_KEY: b64urlEncode(new Uint8Array(31)) }, 'VAPID_PRIVATE_KEY'],
      [{ VAPID_PRIVATE_KEY: '!!!' }, 'VAPID_PRIVATE_KEY'],
      [{ VAPID_SUBJECT: '' }, 'VAPID_SUBJECT'],
      [{ VAPID_SUBJECT: 'owner@example.test' }, 'VAPID_SUBJECT'],
      [{ VAPID_SUBJECT: 'http://example.test' }, 'VAPID_SUBJECT'],
    ]
    for (const [patch, name] of cases) {
      const env = { ...v.env, ...patch }
      const err = await loadVapidKeys(env).catch((e) => e)
      expect(err, name).toBeInstanceOf(VapidConfigError)
      expect(err.message).toContain(name)
      expect(err.message).not.toContain(v.env.VAPID_PRIVATE_KEY)
    }
    // https:// の連絡先もよい
    expect(await loadVapidKeys({ ...v.env, VAPID_SUBJECT: 'https://example.test/contact' })).not.toBeNull()
  })

  it('isValidVapidPublicKey：65 バイトの非圧縮点だけ', async () => {
    const v = await makeVapid()
    expect(isValidVapidPublicKey(v.env.VAPID_PUBLIC_KEY)).toBe(true)
    expect(isValidVapidPublicKey(` ${v.env.VAPID_PUBLIC_KEY} `)).toBe(true)
    for (const bad of [undefined, '', 'AAAA', b64urlEncode(new Uint8Array(65)), b64urlEncode(new Uint8Array(64))]) {
      expect(isValidVapidPublicKey(bad)).toBe(false)
    }
  })
})

describe('sendWebPush（1 件を 1 つの端末へ）', () => {
  async function setup(reply: Parameters<typeof fakePushService>[0] = 201) {
    const v = await makeVapid()
    const keys = (await loadVapidKeys(v.env))!
    const device = await makeDevice()
    const svc = fakePushService(reply)
    const target = { endpoint: device.input.endpoint, p256dh: device.input.p256dh, auth: device.input.auth }
    return { v, keys, device, svc, target, send: () => sendWebPush(target, PAYLOAD, keys, { fetch: svc.fetch, now: () => NOW }) }
  }

  it('201・202（2xx）は送れた。本文はブラウザの鍵で復号でき、{title, body, url, tag} になっている', async () => {
    for (const status of [201, 202]) {
      const s = await setup(status)
      expect(await s.send()).toEqual({ kind: 'sent', status })
      expect(s.svc.calls).toHaveLength(1)
      const call = s.svc.calls[0]
      expect(call.endpoint).toBe(s.target.endpoint)
      expect(call.init.method).toBe('POST')
      expect(call.headers['content-encoding']).toBe('aes128gcm')
      expect(call.headers['content-type']).toBe('application/octet-stream')
      expect(Number(call.headers.ttl)).toBeGreaterThan(0)
      expect(call.init.redirect).toBe('manual')
      expect(call.headers.authorization).toMatch(/^vapid t=.+, k=.+$/)
      expect(await s.device.decrypt(call.body)).toEqual(PAYLOAD)
    }
  })

  it('JWT の exp は now から 12 時間。署名は VAPID の公開鍵で検証できる', async () => {
    const s = await setup()
    await s.send()
    const m = /^vapid t=(.+)\.(.+)\.(.+), k=(.+)$/.exec(s.svc.calls[0].headers.authorization)!
    expect(json(m[2]).exp).toBe(Math.floor(NOW / 1000) + 12 * 3600)
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, s.v.verifyKey, b64urlDecode(m[3])!, new TextEncoder().encode(`${m[1]}.${m[2]}`),
    )
    expect(ok).toBe(true)
  })

  it('404・410 は gone（購読が無効）', async () => {
    for (const status of [404, 410]) {
      expect(await (await setup(status)).send()).toEqual({ kind: 'gone', status })
    }
  })

  it('429・5xx・それ以外の 4xx は retry（あとで送り直す。諦めるのは complete_delivery の回数）', async () => {
    for (const status of [429, 500, 502, 503, 400, 401, 403, 413]) {
      const r = await (await setup(status)).send()
      expect(r).toMatchObject({ kind: 'retry', status })
      expect((r as { error: string }).error).toContain(`HTTP ${status}`)
    }
  })

  it('転送（3xx）は追わない。retry', async () => {
    const r = await (await setup(302)).send()
    expect(r).toMatchObject({ kind: 'retry', status: 302 })
  })

  it('通信失敗は retry。例外を投げない。エラーに宛先の URL を残さない', async () => {
    const s = await setup()
    const failing = fakePushService(new Error(`connect failed ${s.target.endpoint}`))
    const r = await sendWebPush(s.target, PAYLOAD, s.keys, { fetch: failing.fetch, now: () => NOW })
    expect(r.kind).toBe('retry')
    expect((r as { status: number | null }).status).toBeNull()
    expect((r as { error: string }).error).toContain('通信できません')
    expect((r as { error: string }).error).not.toContain(s.target.endpoint)
    expect((r as { error: string }).error).toContain('[endpoint]')
  })

  it('応答が遅すぎたら（timeout）retry', async () => {
    const s = await setup()
    const slow = (async (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch
    const r = await sendWebPush(s.target, PAYLOAD, s.keys, { fetch: slow, now: () => NOW, timeoutMs: 20 })
    expect(r).toMatchObject({ kind: 'retry', status: null })
    expect((r as { error: string }).error).toContain('AbortError')
  })

  it('購読の鍵が壊れていても例外を投げず retry（通信もしない）', async () => {
    const s = await setup()
    for (const patch of [{ p256dh: '!!!' }, { auth: '!!!' }, { p256dh: b64urlEncode(new Uint8Array(10)) }, { auth: b64urlEncode(new Uint8Array(3)) }]) {
      const before = s.svc.calls.length
      const r = await sendWebPush({ ...s.target, ...patch }, PAYLOAD, s.keys, { fetch: s.svc.fetch, now: () => NOW })
      expect(r.kind).toBe('retry')
      expect(s.svc.calls.length).toBe(before)
    }
  })

  it('endpoint が https でなければ通信しない（許可の外＝gone。再送しても同じなので retry にしない）', async () => {
    const s = await setup()
    const r = await sendWebPush({ ...s.target, endpoint: 'http://push.example.test/x' }, PAYLOAD, s.keys, { fetch: s.svc.fetch, now: () => NOW })
    expect(r).toEqual({ kind: 'gone', status: 0, reason: 'endpoint_not_allowed' })
    expect(s.svc.calls).toHaveLength(0)
  })

  it('許可した Push サービスのホストでなければ、通信せずに gone（許可リストより前に登録された購読を止める）', async () => {
    const s = await setup()
    const notAllowed = [
      'https://push.example.test/send/abc',
      'https://evil.example/fcm.googleapis.com',
      'https://fcm.googleapis.com@evil.example/x', // @ の前はユーザー名。ホストは evil.example
      'https://fcm.googleapis.com.evil.example/x',
      'https://evil.googleapis.com/x',
      'https://push.apple.com/x', // ドメインそのものは含まない
      'https://fcm.googleapis.com:8443/fcm/send/abc', // ポートは既定（443）だけ
      'https://user:pw@fcm.googleapis.com/x', // 資格情報つき
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
      'http://fcm.googleapis.com/fcm/send/abc',
      'ftp://fcm.googleapis.com/x',
      'javascript:alert(1)',
      '/relative',
      '',
    ]
    for (const endpoint of notAllowed) {
      const r = await sendWebPush({ ...s.target, endpoint }, PAYLOAD, s.keys, { fetch: s.svc.fetch, now: () => NOW })
      expect(r, endpoint).toEqual({ kind: 'gone', status: 0, reason: 'endpoint_not_allowed' })
    }
    expect(s.svc.calls).toHaveLength(0)
  })

  it('許可した Push サービスのホストなら送る（FCM・Firefox・Safari・Windows。ホスト名の大文字小文字・443 の明示は問わない）', async () => {
    const s = await setup()
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://web.push.apple.com/QGxyz',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://FCM.GoogleAPIs.com/fcm/send/upper',
      'https://fcm.googleapis.com:443/fcm/send/explicit-port',
    ]) {
      const r = await sendWebPush({ ...s.target, endpoint }, PAYLOAD, s.keys, { fetch: s.svc.fetch, now: () => NOW })
      expect(r, endpoint).toEqual({ kind: 'sent', status: 201 })
    }
    expect(s.svc.calls).toHaveLength(6)
  })
})

describe('payloadBytes（暗号化できる大きさに収める）', () => {
  it('小さければそのまま。url が無ければ /。tag は event id', () => {
    const bytes = payloadBytes({ title: 't', body: 'b', url: null, tag: 'e' })
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ title: 't', body: 'b', url: '/', tag: 'e' })
  })

  it('大きすぎる本文は削る（題名・行き先・tag は残す）。上限を超えない', () => {
    const bytes = payloadBytes({ title: '題名', body: 'あ'.repeat(5000), url: '/x', tag: 'e' })
    expect(bytes.length).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES)
    const p = JSON.parse(new TextDecoder().decode(bytes))
    expect(p.title).toBe('題名')
    expect(p.url).toBe('/x')
    expect(p.tag).toBe('e')
    expect(p.body.length).toBeGreaterThan(0)
  })

  it('題名と行き先だけで上限を超えるときは、本文と行き先を捨てても通知は出せる形にする', () => {
    const bytes = payloadBytes({ title: 'あ'.repeat(200), body: 'x', url: `/${'a'.repeat(3500)}`, tag: 'e' })
    expect(bytes.length).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES)
    const p = JSON.parse(new TextDecoder().decode(bytes))
    expect(p.title).toHaveLength(200)
    expect(p.url).toBe('/')
  })
})
