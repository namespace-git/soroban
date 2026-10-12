import { b64urlEncode, concatBytes } from './base64url'

// Web Push の本文の暗号化（RFC 8291・aes128gcm = RFC 8188）。WebCrypto だけで書く（Workers で動く。
// `web-push` パッケージや Node の crypto は使わない）。
//
//   ecdh_secret = ECDH(as_private, ua_public)
//   IKM         = HKDF(salt = auth_secret, ikm = ecdh_secret, info = "WebPush: info" 0x00 ua_public as_public, 32 バイト)
//   CEK         = HKDF(salt = salt, ikm = IKM, info = "Content-Encoding: aes128gcm" 0x00, 16 バイト)
//   NONCE       = HKDF(salt = salt, ikm = IKM, info = "Content-Encoding: nonce" 0x00, 12 バイト)
//   本文        = salt(16) ‖ rs(4・big endian) ‖ idlen(1) ‖ as_public(65) ‖ AES-128-GCM(CEK, NONCE, 平文 ‖ 0x02)
//
// レコードは 1 つだけ（通知の本文は小さい）。最後のレコードの区切りは 0x02。
// WebCrypto の HKDF は extract と expand を続けて行うので、RFC の 2 段（PRK_key → IKM、PRK → CEK / NONCE）は
// それぞれ deriveBits 1 回で済む

const te = new TextEncoder()

const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' } as const

/** レコードの大きさ（RFC 8291 の例と同じ 4096） */
const RECORD_SIZE = 4096
/** 見出し（salt 16 ＋ rs 4 ＋ idlen 1 ＋ 公開鍵 65）の大きさ */
const HEADER_SIZE = 16 + 4 + 1 + 65
const TAG_SIZE = 16
/**
 * 平文の上限。Push サービスが受ける本文は 4096 バイトまで（RFC 8030）。
 * 本文 ＝ 見出し 86 ＋ 平文 ＋ 区切り 1 ＋ 認証タグ 16
 */
export const MAX_PLAINTEXT_BYTES = 4096 - HEADER_SIZE - 1 - TAG_SIZE

export interface ServerKeyPair {
  /** 非圧縮の公開鍵（65 バイト） */
  publicRaw: Uint8Array<ArrayBuffer>
  privateKey: CryptoKey
}

export interface EncryptOptions {
  /** 試験ベクトル用：固定の鍵ペア。省略（本番）すると毎回作る */
  serverKeys?: ServerKeyPair
  /** 試験ベクトル用：固定の salt（16 バイト）。省略（本番）すると毎回乱数 */
  salt?: Uint8Array
}

/** 非圧縮点（0x04 ‖ X ‖ Y）の公開鍵と、32 バイトの秘密の値（d）から、ECDH の鍵ペアを作る */
export async function importEcdhKeyPair(publicRaw: Uint8Array, privateD: Uint8Array): Promise<ServerKeyPair> {
  const jwk = {
    ...pointToJwk(publicRaw),
    d: b64urlEncode(privateD),
  }
  const privateKey = await crypto.subtle.importKey('jwk', jwk, ECDH_P256, false, ['deriveBits'])
  return { publicRaw: copyOf(publicRaw), privateKey }
}

/** 非圧縮点 → JWK の x / y（base64url）。形が違えば Error */
export function pointToJwk(point: Uint8Array): { kty: 'EC'; crv: 'P-256'; x: string; y: string } {
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('公開鍵は 65 バイトの非圧縮点（0x04 から始まる）にしてください')
  return { kty: 'EC', crv: 'P-256', x: b64urlEncode(point.slice(1, 33)), y: b64urlEncode(point.slice(33, 65)) }
}

/**
 * 通知の本文（平文）を、受け取る側（ブラウザ）の公開鍵と認証の秘密で暗号化して、そのまま POST できる本文にする。
 * - uaPublic … PushSubscription の p256dh（65 バイト）
 * - authSecret … PushSubscription の auth（16 バイト）
 * 平文が MAX_PLAINTEXT_BYTES を超えたら Error（呼ぶ側が切り詰める）
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  opts: EncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('通知の本文が大きすぎます')
  if (authSecret.length !== 16) throw new Error('auth は 16 バイトにしてください')
  const salt = opts.salt ? copyOf(opts.salt) : crypto.getRandomValues(new Uint8Array(16))
  if (salt.length !== 16) throw new Error('salt は 16 バイトにしてください')

  const server = opts.serverKeys ?? (await generateServerKeys())
  const uaKey = await crypto.subtle.importKey('jwk', pointToJwk(uaPublic), ECDH_P256, false, [])
  const ecdhSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, server.privateKey, 256)

  const keyInfo = concatBytes(te.encode('WebPush: info\0'), uaPublic, server.publicRaw)
  const ikm = await hkdf(authSecret, new Uint8Array(ecdhSecret), keyInfo, 32)
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12)

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const padded = concatBytes(plaintext, new Uint8Array([0x02]))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded))

  const header = new Uint8Array(21)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false)
  header[20] = server.publicRaw.length
  return concatBytes(header, server.publicRaw, encrypted)
}

async function generateServerKeys(): Promise<ServerKeyPair> {
  const pair = await crypto.subtle.generateKey(ECDH_P256, true, ['deriveBits'])
  return { publicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)), privateKey: pair.privateKey }
}

async function hkdf(
  salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', copyOf(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: copyOf(salt), info: copyOf(info) }, key, length * 8)
  return new Uint8Array(bits)
}

function copyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length)
  out.set(bytes)
  return out
}
