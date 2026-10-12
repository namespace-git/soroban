import type { AgentErrorCode, AgentRegistration } from '../../shared/agent-types'
import { AgentHttpError, LeaseLostError } from './errors'

// ============================================================
// 取り込み担当の PC → Web 版のサーバーへの通信（electron に依存しない。fetch は差し込む）
//
//   POST {origin}/api/agent/<method>   Authorization: Agent <鍵>    … register だけ Bearer <人の JWT>
//   POST {origin}/api/rpc/<method>     Authorization: Bearer <人の JWT>   … 画面の API（requestCollect など）
//   本文 {"args":[…]}  成功 {"result":…}  失敗 {"error":{"code","message"}}
//
// 契約は src/shared/agent-types.ts の冒頭。やり直しは「5xx と通信切れ」だけ（4xx・lease_lost はやり直さない）。
// 段は冪等キーを持つので、通信が切れて送り直しても二重に入らない（2 回目は {already:true}）。
// 鍵・トークンはエラー文・ログに出さない。リダイレクトは追わない（認証ヘッダを別の先へ送らない）。
// ============================================================

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export interface AgentHttpOptions {
  /** Web 版の origin（https://…）。末尾の / は付けない */
  origin: string
  fetch: FetchFn
  /** やり直しの待ち。既定は setTimeout（テストは差し替える） */
  sleep?: (ms: number) => Promise<void>
  /** やり直しの間隔（ms）。この本数だけやり直す（既定 1 秒・3 秒＝最大 3 回送る） */
  retryDelaysMs?: readonly number[]
  /** 1 回の通信の上限（ms）。超えたら通信切れとして扱う */
  timeoutMs?: number
}

export interface CallOptions {
  /** 5xx・通信切れをやり直すか（既定 true）。claim・heartbeat は次の周期があるので false */
  retry?: boolean
  /** この 1 回の通信の上限（ms）。省略すると createAgentHttp の timeoutMs。ログアウトの unregister のように、待ちたくない呼び出し用 */
  timeoutMs?: number
}

export interface AgentHttp {
  /** `/api/agent/<method>`（取り込み担当の鍵）。lease を渡す呼び出しは args の先頭に lease を入れる */
  agent<T>(method: string, args: unknown[], key: string, opts?: CallOptions): Promise<T>
  /** 鍵を出してもらう（人の JWT）。戻りの形を確かめる */
  register(deviceName: string, jwt: string): Promise<AgentRegistration>
  /** `/api/rpc/<method>`（人の JWT）。requestCollect・getCollectStatus・getSettings・listShopAccounts */
  rpc<T>(method: string, args: unknown[], jwt: string, opts?: CallOptions): Promise<T>
}

const DEFAULT_RETRY_DELAYS_MS = [1000, 3000] as const
const DEFAULT_TIMEOUT_MS = 60_000

const KNOWN_CODES: ReadonlySet<string> = new Set<AgentErrorCode>([
  'unauthorized', 'forbidden', 'not_found', 'not_implemented', 'bad_request', 'conflict', 'lease_lost', 'internal',
])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function statusMessage(status: number): string {
  if (status === 401) return '取り込み担当の鍵かログインが正しくありません。ログインし直してください'
  if (status === 403) return 'この操作は許可されていません'
  if (status === 404) return 'サーバーに該当の処理が見つかりません'
  if (status === 429) return 'リクエストが多すぎます。しばらくしてからもう一度お試しください'
  if (status >= 500) return `サーバーでエラーが起きました（${status}）`
  return `サーバーから想定外の応答がありました（${status}）`
}

export function createAgentHttp(options: AgentHttpOptions): AgentHttp {
  const origin = options.origin.replace(/\/+$/, '')
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function attempt(url: string, authorization: string, body: string, limitMs: number): Promise<unknown> {
    let status: number
    let ok: boolean
    let text: string
    try {
      const res = await options.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body,
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(limitMs),
      })
      status = res.status
      ok = res.ok
      text = await res.text()
    } catch {
      // 圏外・サーバー停止・時間切れ・リダイレクト。英語の生のエラーは出さない
      throw new AgentHttpError('network', 0, 'サーバーにつながりません。通信の状態を確かめてください')
    }

    type Body = { result?: unknown; error?: { code?: unknown; message?: unknown } }
    let parsed: Body | null = null
    try {
      const value: unknown = JSON.parse(text)
      if (typeof value === 'object' && value !== null) parsed = value as Body
    } catch {
      // JSON でない（ゲートウェイのエラー・index.html など）。下で状態コードから文言を作る
    }

    if (ok && parsed && 'result' in parsed) return parsed.result

    const code = typeof parsed?.error?.code === 'string' ? parsed.error.code : undefined
    const message = typeof parsed?.error?.message === 'string' && parsed.error.message
      ? parsed.error.message
      : statusMessage(status)
    if (code === 'lease_lost') throw new LeaseLostError(message)
    throw new AgentHttpError(
      code && KNOWN_CODES.has(code) ? (code as AgentErrorCode) : (status >= 500 ? 'internal' : 'server_error'),
      status,
      message,
    )
  }

  async function send(path: string, args: unknown[], authorization: string, retry: boolean, limitMs: number = timeoutMs): Promise<unknown> {
    const url = `${origin}${path}`
    const body = JSON.stringify({ args })
    const waits = retry ? delays : []
    for (let i = 0; ; i++) {
      try {
        return await attempt(url, authorization, body, limitMs)
      } catch (e) {
        if (e instanceof AgentHttpError && e.retryable && i < waits.length) {
          await sleep(waits[i])
          continue
        }
        throw e
      }
    }
  }

  return {
    async agent<T>(method: string, args: unknown[], key: string, opts?: CallOptions): Promise<T> {
      return await send(`/api/agent/${encodeURIComponent(method)}`, args, `Agent ${key}`, opts?.retry !== false, opts?.timeoutMs) as T
    },

    async register(deviceName: string, jwt: string): Promise<AgentRegistration> {
      const r = await send('/api/agent/register', [deviceName], `Bearer ${jwt}`, true) as Partial<AgentRegistration> | null
      if (
        !r || typeof r.token !== 'string' || typeof r.agent_id !== 'string' || typeof r.expires_at !== 'string'
        || typeof r.household_id !== 'string' || !UUID.test(r.household_id) || !Number.isFinite(Date.parse(r.expires_at))
      ) {
        // 世帯の id が無い＝Web 版のサーバーが古い。画像のパスが作れないので、取り込み担当にはならない
        throw new AgentHttpError('server_error', 200, 'Web 版のサーバーの応答が想定と違います。Web 版を最新にしてください')
      }
      return r as AgentRegistration
    },

    async rpc<T>(method: string, args: unknown[], jwt: string, opts?: CallOptions): Promise<T> {
      return await send(`/api/rpc/${encodeURIComponent(method)}`, args, `Bearer ${jwt}`, opts?.retry !== false, opts?.timeoutMs) as T
    },
  }
}
