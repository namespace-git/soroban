// SorobanApi の HTTP 実装（Web 版の window.soroban）。
//
// 通信の契約（サーバー側 functions/api/rpc/[method].ts と合わせてある。変えないこと）
//   要求  POST ${base}/rpc/<method>   Authorization: Bearer <JWT>   本文 {"args": [...]}
//   成功  200 {"result": <値>}
//   失敗  {"error": {"code": "…", "message": "<日本語>"}}
//
// 失敗は throw new Error(message) にする。画面は e.message をそのままトーストに出している
// （Electron の IPC でも同じ）。code === 'unauthorized' ならログインに戻す。
import type { SorobanApi } from '../../shared/types'

/** サーバー（または通信）の失敗。message は人に見せてよい日本語 */
export class ApiError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

export interface HttpApiOptions {
  /** API の入口（例 /api）。末尾の / は取る */
  base: string
  /** 今のアクセストークン（JWT）。ログインしていなければ null。期限切れの更新は呼び出し側（supabase-js）に任せる */
  getToken(): Promise<string | null>
  /** サーバーが 'unauthorized' を返した／トークンが無いとき。ログイン画面に戻す */
  onUnauthorized(): void
}

type RpcBody = {
  result?: unknown
  error?: { code?: string; message?: string }
}

/**
 * 引数を JSON の素の値にして本文にする。
 * Vue のリアクティブ（Proxy）を IPC に渡すと失敗する問題（main.ts の Electron の包み）と同じ理由で、
 * 必ず JSON.stringify を通す（Proxy でも中身が読まれ、素の値になる）。
 * JSON は undefined を持てず、配列の中では null になってしまうので、
 * 末尾の undefined（`listSales(undefined)` のような省略）は先に落としておく。
 */
function bodyOf(args: unknown[]): string {
  const trimmed = [...args]
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) trimmed.pop()
  return JSON.stringify({ args: trimmed })
}

function statusMessage(status: number): string {
  if (status === 401) return 'ログインが必要です。もう一度ログインしてください'
  if (status === 403) return 'この操作は許可されていません'
  if (status === 404) return 'サーバーに該当の処理が見つかりません'
  if (status === 429) return 'リクエストが多すぎます。しばらくしてからもう一度お試しください'
  if (status >= 500) return `サーバーでエラーが起きました（${status}）`
  return `サーバーから想定外の応答がありました（${status}）`
}

export function createHttpApi(options: HttpApiOptions): SorobanApi {
  const base = options.base.replace(/\/+$/, '')

  async function call(method: string, args: unknown[]): Promise<unknown> {
    const token = await options.getToken()
    if (!token) {
      options.onUnauthorized()
      throw new ApiError('unauthorized', 'ログインが必要です。もう一度ログインしてください')
    }

    let res: Response
    try {
      res = await fetch(`${base}/rpc/${encodeURIComponent(method)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: bodyOf(args),
      })
    } catch {
      // 圏外・機内モード・サーバー停止など。英語の生のエラー（Failed to fetch）は出さない
      throw new ApiError('network', 'サーバーにつながりません。通信の状態を確かめてください')
    }

    let body: RpcBody | null = null
    try {
      body = (await res.json()) as RpcBody
    } catch {
      // JSON でない（開発サーバーが index.html を返した、ゲートウェイのエラーなど）。下で状態コードから文言を作る
    }

    if (res.ok && body && typeof body === 'object' && 'result' in body) return body.result

    const code = body?.error?.code ?? (res.status === 401 ? 'unauthorized' : 'server_error')
    const message = body?.error?.message || statusMessage(res.status)
    if (code === 'unauthorized') options.onUnauthorized()
    throw new ApiError(code, message)
  }

  // 全メソッドを「名前で RPC を呼ぶ関数」として返す。メソッドの一覧は shared/types.ts の SorobanApi が持つので、
  // ここには書かない（足したときに 2 か所を直さずに済む）。then / toJSON は await や JSON 化で触られるので無視する
  return new Proxy({} as SorobanApi, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON') return undefined
      return (...args: unknown[]) => call(prop, args)
    },
  })
}
