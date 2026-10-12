import type { Sql } from '../db/sql'
import { ApiError } from '../errors'

/**
 * 取り込み担当の鍵。32 バイトの乱数を base64url にして、接頭辞 `sbagent_` を付けたもの（43 文字 + 接頭辞）。
 * 平文の鍵は register の応答で 1 度だけ返す。DB には SHA-256 の 16 進（小文字 64 文字）だけを置く
 * （`agent_device.token_hash`）。ログ・エラー文には出さない。
 *
 * WebCrypto だけで書く（Workers でも Node でも動く。`node:crypto` に頼らない）。
 */
export const AGENT_KEY_PREFIX = 'sbagent_'
const KEY_BYTES = 32

/** 形が合うものだけ DB に問い合わせる（変な文字列で DB を叩かない） */
export const AGENT_KEY_RE = /^sbagent_[A-Za-z0-9_-]{43}$/

/**
 * 鍵の期限。DB の register_agent_device は 3 時間までしか受けない（20261012001900）。
 * 短くしてあるのは、盗まれた・忘れた鍵が効く時間を縮めるため。PC は期限の前に、ログイン中のトークンで取り直す
 * （src/main/agent/runner.ts）。ログアウトのときは `unregister` で鍵をすぐ捨てる
 */
export const AGENT_KEY_TTL_HOURS = 2

export function generateAgentKey(): string {
  const bytes = new Uint8Array(KEY_BYTES)
  crypto.getRandomValues(bytes)
  return AGENT_KEY_PREFIX + toBase64Url(bytes)
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function toHex(buffer: ArrayBuffer): string {
  let hex = ''
  for (const b of new Uint8Array(buffer)) hex += b.toString(16).padStart(2, '0')
  return hex
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

export async function sha1Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)))
}

export async function hashAgentKey(key: string): Promise<string> {
  return sha256Hex(key)
}

export interface AgentIdentity {
  /** `agent_device.id` */
  agentId: string
  householdId: string
}

const UNAUTHORIZED_MESSAGE = '取り込み担当の鍵が正しくないか、期限切れ・取り消し済みです。ログインし直して鍵を取り直してください'

/** `Authorization: Agent <鍵>` から鍵を取り出す。人の JWT（Bearer）は通さない */
function agentKeyFromRequest(request: Request): string | null {
  const header = request.headers.get('authorization')
  const m = header ? /^Agent\s+(\S+)\s*$/i.exec(header) : null
  return m && AGENT_KEY_RE.test(m[1]) ? m[1] : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 鍵 → SHA-256 → `app.agent_of_token`（security definer）。**`set role` の前の接続ロール（soroban_gateway）で**呼ぶ
 * （`root` はトランザクションの外の Sql）。引けたら last_seen_at が進む（1 分に 1 回まで。画面の「取り込み担当 n 台」の根拠）。
 * 知らない鍵・期限切れ・取り消し済み・鍵を作った人が世帯のメンバーでなくなった、は 401（理由は区別しない）。
 */
export async function authenticateAgent(request: Request, root: Sql): Promise<AgentIdentity> {
  const key = agentKeyFromRequest(request)
  if (!key) throw new ApiError('unauthorized', UNAUTHORIZED_MESSAGE)
  const row = await root.get<{ agent_id: string | null; household_id: string | null }>(
    'select agent_id, household_id from app.agent_of_token(?)',
    await hashAgentKey(key),
  )
  if (!row || typeof row.agent_id !== 'string' || typeof row.household_id !== 'string' || !UUID.test(row.agent_id) || !UUID.test(row.household_id)) {
    throw new ApiError('unauthorized', UNAUTHORIZED_MESSAGE)
  }
  return { agentId: row.agent_id.toLowerCase(), householdId: row.household_id.toLowerCase() }
}
