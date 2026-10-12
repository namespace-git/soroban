import { b64urlDecode, b64urlEncode } from './base64url'
import { pointToJwk } from './encrypt'

// VAPID（RFC 8292）。Push サービスに「このサーバーが送っている」と示す署名つきの JWT（ES256）。
// 鍵は利用者が作って Cloudflare の環境変数に置く（秘密鍵はリポジトリに書かない）：
//   VAPID_PUBLIC_KEY   … base64url の 65 バイト（非圧縮の点）。ブラウザの applicationServerKey にも使う
//   VAPID_PRIVATE_KEY  … base64url の 32 バイト
//   VAPID_SUBJECT      … 連絡先。`mailto:` か `https://`（Apple は不正な sub を断る）

export interface VapidEnv {
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
}

export interface VapidKeys {
  /** 公開鍵（base64url。Authorization の k= に入れる） */
  publicB64: string
  privateKey: CryptoKey
  subject: string
}

/** 鍵が設定されているのに形が正しくない。メッセージに鍵の値を入れない */
export class VapidConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VapidConfigError'
  }
}

/** JWT の有効期間。RFC 8292 は 24 時間まで。余裕を見て 12 時間 */
export const VAPID_JWT_TTL_SECONDS = 12 * 60 * 60

const te = new TextEncoder()

const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== ''

/** 公開鍵（base64url）が 65 バイトの非圧縮点か */
export function isValidVapidPublicKey(text: string | undefined): boolean {
  if (!present(text)) return false
  const raw = b64urlDecode(text.trim())
  return raw !== null && raw.length === 65 && raw[0] === 0x04
}

/**
 * 環境変数から鍵を読む。公開鍵・秘密鍵のどちらかが無ければ null（通知を使わない設定。何もしない）。
 * 設定されているのに形が正しくなければ VapidConfigError
 */
export async function loadVapidKeys(env: VapidEnv): Promise<VapidKeys | null> {
  if (!present(env.VAPID_PUBLIC_KEY) || !present(env.VAPID_PRIVATE_KEY)) return null
  const publicRaw = b64urlDecode(env.VAPID_PUBLIC_KEY.trim())
  if (!publicRaw || publicRaw.length !== 65 || publicRaw[0] !== 0x04) {
    throw new VapidConfigError('VAPID_PUBLIC_KEY は base64url の 65 バイト（非圧縮の点）にしてください')
  }
  const d = b64urlDecode(env.VAPID_PRIVATE_KEY.trim())
  if (!d || d.length !== 32) throw new VapidConfigError('VAPID_PRIVATE_KEY は base64url の 32 バイトにしてください')
  const subject = (env.VAPID_SUBJECT ?? '').trim()
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s/]+\S*)$/.test(subject)) {
    throw new VapidConfigError('VAPID_SUBJECT は mailto:（メールアドレス）か https://（URL）にしてください')
  }
  let privateKey: CryptoKey
  try {
    privateKey = await crypto.subtle.importKey(
      'jwk',
      { ...pointToJwk(publicRaw), d: b64urlEncode(d) },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
  } catch {
    throw new VapidConfigError('VAPID の鍵を読めません（公開鍵と秘密鍵の組が合っているか確認してください）')
  }
  return { publicB64: b64urlEncode(publicRaw), privateKey, subject }
}

/** 送り先の origin（`aud`）。endpoint が https の URL でなければ Error */
export function audienceOf(endpoint: string): string {
  const u = new URL(endpoint)
  if (u.protocol !== 'https:') throw new Error('endpoint は https にしてください')
  return u.origin
}

/** ES256 の JWT。署名は WebCrypto の ECDSA（r ‖ s の 64 バイト）で、JWS の ES256 の形そのまま */
export async function signVapidJwt(keys: VapidKeys, audience: string, nowSeconds: number): Promise<string> {
  const header = b64urlEncode(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64urlEncode(te.encode(JSON.stringify({
    aud: audience,
    exp: nowSeconds + VAPID_JWT_TTL_SECONDS,
    sub: keys.subject,
  })))
  const signingInput = `${header}.${claims}`
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, te.encode(signingInput)),
  )
  return `${signingInput}.${b64urlEncode(signature)}`
}

/** `Authorization` ヘッダーの値（RFC 8292 の 3 節）：`vapid t=<JWT>, k=<公開鍵>` */
export async function vapidAuthorization(keys: VapidKeys, endpoint: string, nowSeconds: number): Promise<string> {
  const jwt = await signVapidJwt(keys, audienceOf(endpoint), nowSeconds)
  return `vapid t=${jwt}, k=${keys.publicB64}`
}
