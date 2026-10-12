import { randomUUID } from 'node:crypto'
import type { PushKinds, PushSubscriptionInput } from '../../../src/shared/web-types'
import { b64urlEncode } from '../../push/base64url'
import type { VapidEnv } from '../../push/vapid'

// Push のテスト用の道具。鍵はテストの中で毎回作る（VAPID の秘密鍵をファイルに書かない）

export const ALL_KINDS: PushKinds = { sale: true, shipping: true, collect: true, arrival: true }

export interface TestVapid {
  env: Required<VapidEnv>
  /** JWT の署名を確かめる側の鍵（公開鍵） */
  verifyKey: CryptoKey
}

export async function makeVapid(subject = 'mailto:owner@example.test'): Promise<TestVapid> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  return {
    env: {
      VAPID_PUBLIC_KEY: b64urlEncode(publicRaw),
      VAPID_PRIVATE_KEY: jwk.d!,
      VAPID_SUBJECT: subject,
    },
    verifyKey: pair.publicKey,
  }
}

export interface TestDevice {
  input: PushSubscriptionInput
  /** 受け取る側（ブラウザ）として、本文を復号して JSON を返す */
  decrypt(body: Uint8Array): Promise<{ title: string; body: string; url: string; tag: string }>
}

/** 購読を 1 つ作る。ブラウザと同じ鍵（ECDH の公開鍵 65 バイト・auth 16 バイト） */
export async function makeDevice(
  opts: { endpoint?: string; label?: string; kinds?: Partial<PushKinds> } = {},
): Promise<TestDevice> {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  return {
    input: {
      // 登録できるのは許可した Push サービスのホストだけ（server/domain/push.ts の isPushServiceHost）。FCM（Chrome・Android）の形
      endpoint: opts.endpoint ?? `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: b64urlEncode(uaPublic),
      auth: b64urlEncode(auth),
      label: opts.label ?? 'テストの端末',
      kinds: { ...ALL_KINDS, ...opts.kinds },
    },
    async decrypt(body) {
      const salt = body.slice(0, 16)
      const asPublic = body.slice(21, 86)
      const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256))
      const te = new TextEncoder()
      const derive = async (s: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, n: number) =>
        new Uint8Array(await crypto.subtle.deriveBits(
          { name: 'HKDF', hash: 'SHA-256', salt: s, info },
          await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8,
        ))
      const keyInfo = Uint8Array.from([...te.encode('WebPush: info\0'), ...uaPublic, ...asPublic])
      const ikm = await derive(auth, shared, keyInfo, 32)
      const cek = await derive(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16)
      const nonce = await derive(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12)
      const plain = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce },
        await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']),
        body.slice(86),
      ))
      if (plain[plain.length - 1] !== 0x02) throw new Error('最後のレコードの区切り（0x02）がありません')
      return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)))
    },
  }
}

export interface PushCall {
  endpoint: string
  headers: Record<string, string>
  body: Uint8Array
  init: RequestInit
}

/** 返し方：数字 = その HTTP ステータス、Error = 通信失敗（reject） */
export type Reply = number | Error | ((call: PushCall) => number | Error | Promise<number | Error>)

/** 偽の Push サービス。呼ばれた内容を calls に残す。endpoint ごとに返し方を変えられる */
export function fakePushService(reply: Reply = 201, byEndpoint: Record<string, Reply> = {}) {
  const calls: PushCall[] = []
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const endpoint = String(input)
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => { headers[k] = v })
    const call: PushCall = { endpoint, headers, body: init.body as Uint8Array, init }
    calls.push(call)
    const r = byEndpoint[endpoint] ?? reply
    const result = typeof r === 'function' ? await r(call) : r
    if (result instanceof Error) throw result
    return new Response(result === 410 ? 'gone' : null, { status: result })
  }) as typeof fetch
  return { fetch: fetchFn, calls }
}
