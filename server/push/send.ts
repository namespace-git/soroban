import { b64urlDecode } from './base64url'
import { encryptPayload, MAX_PLAINTEXT_BYTES } from './encrypt'
import { isAllowedPushEndpoint } from './hosts'
import { vapidAuthorization, type VapidKeys } from './vapid'

// 1 件の通知を 1 つの端末（Push サービスの endpoint）へ送る。WebCrypto と fetch だけ（Workers で動く）。
// 例外は投げず、結果（PushOutcome）で返す：1 件の失敗で他の送信を止めない。

/** 送り先。PushSubscription の中身（購読の表 push_subscription の列） */
export interface PushTarget {
  endpoint: string
  /** base64url の 65 バイト */
  p256dh: string
  /** base64url の 16 バイト */
  auth: string
}

/** service worker（web/sw.ts）が受け取る本文。`tag` は event id で、同じ通知は置き換わる */
export interface PushPayload {
  title: string
  body: string
  url: string | null
  tag: string
}

export type PushOutcome =
  /** 201 / 202（2xx）。Push サービスが受け付けた */
  | { kind: 'sent'; status: number }
  /**
   * 404 / 410。この購読はもう無効（端末が通知を断った・購読の期限切れ）。
   * `reason: 'endpoint_not_allowed'` は、宛先が許可した Push サービスの外だったので**通信せずに**無効とした場合（status は 0）
   */
  | { kind: 'gone'; status: number; reason?: 'endpoint_not_allowed' }
  /** 429・5xx・通信失敗・それ以外の 4xx。あとで送り直す（回数は complete_delivery が数えて、規定で諦める） */
  | { kind: 'retry'; status: number | null; error: string }

export interface SendDeps {
  /** 既定は globalThis.fetch。テストが差し替える */
  fetch?: typeof fetch
  /** 既定は Date.now */
  now?: () => number
  /** 1 件の通信を待つ上限。既定 10 秒 */
  timeoutMs?: number
}

/** Push サービスが通知を預かる期間（秒）。1 日で十分（売れた・届いたは翌日には古い） */
const TTL_SECONDS = 24 * 60 * 60
const DEFAULT_TIMEOUT_MS = 10_000
/** last_error に残す応答の長さ */
const ERROR_BODY_CHARS = 200

const te = new TextEncoder()

/** payload を JSON にして、暗号化できる大きさ（MAX_PLAINTEXT_BYTES）に収める。本文 → 行き先の順に削る */
export function payloadBytes(p: PushPayload): Uint8Array<ArrayBuffer> {
  const make = (body: string, url: string | null) => te.encode(JSON.stringify({ title: p.title, body, url: url ?? '/', tag: p.tag }))
  let chars = Array.from(p.body)
  let bytes = make(p.body, p.url)
  while (bytes.length > MAX_PLAINTEXT_BYTES && chars.length > 0) {
    chars = chars.slice(0, Math.max(0, chars.length - 100))
    bytes = make(chars.join(''), p.url)
  }
  // 題名と行き先だけでも入らないときは、行き先を諦める（通知そのものは出す）
  if (bytes.length > MAX_PLAINTEXT_BYTES) bytes = make('', null)
  return bytes
}

export async function sendWebPush(
  target: PushTarget, payload: PushPayload, keys: VapidKeys, deps: SendDeps = {},
): Promise<PushOutcome> {
  const doFetch = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? Date.now
  // 登録のときにも検査しているが、許可リストを足す前に入った購読があるので、送る直前にも確かめる。
  // 許可の外なら通信せず、無効な購読として消させる（再送しても同じなので retry にしない）
  if (!isAllowedPushEndpoint(target.endpoint)) return { kind: 'gone', status: 0, reason: 'endpoint_not_allowed' }
  try {
    const uaPublic = b64urlDecode(target.p256dh)
    const authSecret = b64urlDecode(target.auth)
    if (!uaPublic || !authSecret) return { kind: 'retry', status: null, error: '購読の鍵が base64url ではありません' }
    let body: Uint8Array<ArrayBuffer>
    try {
      body = await encryptPayload(payloadBytes(payload), uaPublic, authSecret)
    } catch (e) {
      return { kind: 'retry', status: null, error: `暗号化できません：${message(e, target.endpoint)}` }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const res = await doFetch(target.endpoint, {
        method: 'POST',
        headers: {
          Authorization: await vapidAuthorization(keys, target.endpoint, Math.floor(now() / 1000)),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(TTL_SECONDS),
          Urgency: 'normal',
        },
        body,
        // 転送先へは行かない（endpoint を信用して 1 回だけ送る）
        redirect: 'manual',
        signal: controller.signal,
      })
      const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_CHARS)
      if (res.status >= 200 && res.status < 300) return { kind: 'sent', status: res.status }
      if (res.status === 404 || res.status === 410) return { kind: 'gone', status: res.status }
      return { kind: 'retry', status: res.status, error: `HTTP ${res.status}${text ? ` ${redact(text, target.endpoint)}` : ''}` }
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    return { kind: 'retry', status: null, error: `通信できません：${message(e, target.endpoint)}` }
  }
}

function message(e: unknown, endpoint: string): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  return redact(text, endpoint).slice(0, ERROR_BODY_CHARS)
}

/** endpoint の URL は通知を受ける端末の宛先そのものなので、ログ・last_error に残さない */
function redact(text: string, endpoint: string): string {
  return text.split(endpoint).join('[endpoint]')
}
