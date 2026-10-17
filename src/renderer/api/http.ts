// SorobanApi の HTTP 実装（Web 版の window.soroban）。
//
// 通信の契約（サーバー側 functions/api/rpc/[method].ts と合わせてある。変えないこと）
//   要求  POST ${base}/rpc/<method>   Authorization: Bearer <JWT>   本文 {"args": [...]}
//   成功  200 {"result": <値>}
//   失敗  {"error": {"code": "…", "message": "<日本語>"}}
//
// 失敗は throw new Error(message) にする。画面は e.message をそのままトーストに出している
// （Electron の IPC でも同じ）。code === 'unauthorized' ならログインに戻す。
import { READ_ONLY_METHODS } from '../../shared/read-only-methods'
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

/** 飛んでいる最中の読み取り 1 本。waiters はこの結果を待っている呼び出しの数（終わる前にしか増えない） */
type Inflight = { promise: Promise<unknown>; waiters: number }

export function createHttpApi(options: HttpApiOptions): SorobanApi {
  const base = options.base.replace(/\/+$/, '')

  // 同時に出た「同じメソッド・同じ引数」の読み取りを 1 本にまとめる（ホームを開くと getDashboard が 3 本飛ぶ、など）。
  // まとめるのは**飛んでいる最中だけ**。終わったら（成功も失敗も）すぐ忘れる＝結果は使い回さない
  // （帳簿の数字が古く出るのがいちばん怖いので、キャッシュにはしない）。書き込みは READ_ONLY_METHODS に無いので絶対にまとめない
  const inflight = new Map<string, Inflight>()

  async function call(method: string, args: unknown[]): Promise<unknown> {
    // 本文は呼び出した時点の値で固める（トークン待ちのあいだに、画面が引数を書き換えても送る中身が変わらないように）
    const payload = bodyOf(args)
    if (!READ_ONLY_METHODS.has(method)) return send(method, payload)

    const key = `${method}\n${payload}`
    const shared = inflight.get(key) ?? start(key, method, payload)
    shared.waiters += 1
    const result = await shared.promise
    // 1 人しか待っていなければそのまま渡す。2 人以上が同じ結果を待っていたら、全員に別々のコピーを渡す
    // （画面が戻り値をその場で並べ替えたり書き換えたりしても、相乗りした別の呼び出しに影響しないように）。
    // waiters は結果が決まる前にしか増えない（決まる前に inflight から消える）ので、ここで読めば確定している
    return shared.waiters > 1 ? structuredClone(result) : result
  }

  /** 読み取りを 1 本送り出し、飛んでいる最中の表に載せる */
  function start(key: string, method: string, payload: string): Inflight {
    // finally は結果が呼び出し側に見える前に走る（finally が返す Promise は、コールバックのあとに決まる）。
    // だから「終わったあと」の同じ呼び出しは、必ず新しく送られる
    const promise = send(method, payload).finally(() => {
      if (inflight.get(key) === entry) inflight.delete(key)
    })
    const entry: Inflight = { promise, waiters: 0 }
    inflight.set(key, entry)
    return entry
  }

  async function send(method: string, payload: string): Promise<unknown> {
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
        body: payload,
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
