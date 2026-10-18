// SorobanApi の HTTP 実装（Web 版の window.soroban）。
//
// 通信の契約（サーバー側 functions/api/rpc/[method].ts・server/ と合わせてある。変えないこと）
//   要求  POST ${base}/rpc/<method>   Authorization: Bearer <JWT>   本文 {"args": [...]}
//   成功  200 {"result": <値>}
//   失敗  {"error": {"code": "…", "message": "<日本語>"}}
//
//   まとめ  POST ${base}/rpc/_batch   Authorization: Bearer <JWT>   本文 {"calls": [{"method": "listTags", "args": []}, …]}
//     読み取り（READ_ONLY_METHODS）だけを、同じタイミングで出たぶん 1 本の HTTP にまとめて送る（1 束 MAX_CALLS_PER_BATCH 本まで、
//     あふれたぶんは別の束にして MAX_CONCURRENT_BATCHES 束まで並行。サーバーが受けられるのは 1〜25 本）。
//     成功  200 {"results": [{"result": <値>} | {"error": {"code", "message"}}, …]}（同じ順・同じ数）
//     1 本の error はその呼び出しだけを失敗させる。要求ごと失敗（401・500・通信失敗・JSON でない）はまとめた全員が同じ失敗になる。
//     サーバーがまだ _batch を知らない（404／501）ときは 1 本ずつに戻し、以後このクライアントではまとめない。
//
// 失敗は throw new Error(message)（ApiError）にする。画面は e.message をそのままトーストに出している
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

/** まとめの応答 1 本の中の 1 件（成功か失敗のどちらか） */
type BatchEntry = RpcBody

/**
 * 1 つの _batch に入れる呼び出しの数。サーバーの受け入れ上限（25 本）よりずっと小さく送る。
 * 束の中は 1 つの接続で順に処理されるので（SQL 1 本あたり約 17ms、ほぼ DB との往復）、大きい束ほど遅い。
 * 小さい束を並行で飛ばしたほうが、全体は速い（本番の実測：61 本の束で 1.2 秒）
 */
export const MAX_CALLS_PER_BATCH = 8
/**
 * 同時に飛ばす _batch の数。これより多いぶんは、先の束が終わるのを待つ。
 * Hyperdrive の接続の上限が 10 本なので、まとめ以外の 1 本ずつの呼び出し（書き込みなど）の分を残して 5
 */
export const MAX_CONCURRENT_BATCHES = 5

/**
 * 引数を JSON の素の値にした文字列にする（`[...]`）。
 * Vue のリアクティブ（Proxy）を IPC に渡すと失敗する問題（main.ts の Electron の包み）と同じ理由で、
 * 必ず JSON.stringify を通す（Proxy でも中身が読まれ、素の値になる）。
 * JSON は undefined を持てず、配列の中では null になってしまうので、
 * 末尾の undefined（`listSales(undefined)` のような省略）は先に落としておく。
 */
function argsOf(args: unknown[]): string {
  const trimmed = [...args]
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) trimmed.pop()
  return JSON.stringify(trimmed)
}

/** 1 本ずつ送るときの本文 `{"args": [...]}` */
function payloadOf(argsJson: string): string {
  return `{"args":${argsJson}}`
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

/** 待ち行列に入れた読み取り 1 本（まだ送っていない）。argsJson は呼び出した時点の値で固めたもの */
type Queued = { method: string; argsJson: string; resolve(value: unknown): void; reject(reason: unknown): void }

/** HTTP 応答（本文は JSON として読めたときだけ。読めなければ null） */
type Reply = { res: Response; body: unknown }

export function createHttpApi(options: HttpApiOptions): SorobanApi {
  const base = options.base.replace(/\/+$/, '')

  // 同時に出た「同じメソッド・同じ引数」の読み取りを 1 本にまとめる（ホームを開くと getDashboard が 3 本飛ぶ、など）。
  // まとめるのは**飛んでいる最中だけ**。終わったら（成功も失敗も）すぐ忘れる＝結果は使い回さない
  // （帳簿の数字が古く出るのがいちばん怖いので、キャッシュにはしない）。書き込みは READ_ONLY_METHODS に無いので絶対にまとめない
  const inflight = new Map<string, Inflight>()

  // 同じタイミングで出た読み取りを 1 本の HTTP（_batch）にまとめる仕組み。上の相乗りの外側（実際に送るところ）にある。
  // 画面を開くと十数本、売上・仕入の画面は件数ぶん出るので、HTTP 1 本ごとの Worker の起動・認証・DB 接続を減らす。
  // 書き込みは待ち行列を通らず、今までどおり 1 本ずつ即送る（順番も、失敗の扱いも変えない）
  let queue: Queued[] = []
  let flushArmed = false
  /** false＝サーバーが _batch を知らなかったので、以後このクライアントではまとめない */
  let batching = true
  let activeBundles = 0
  const waitingBundles: Queued[][] = []

  async function call(method: string, args: unknown[]): Promise<unknown> {
    // 本文は呼び出した時点の値で固める（トークン待ちのあいだに、画面が引数を書き換えても送る中身が変わらないように）
    const argsJson = argsOf(args)
    if (!READ_ONLY_METHODS.has(method)) return send(method, payloadOf(argsJson))

    const key = `${method}\n${argsJson}`
    const shared = inflight.get(key) ?? start(key, method, argsJson)
    shared.waiters += 1
    const result = await shared.promise
    // 1 人しか待っていなければそのまま渡す。2 人以上が同じ結果を待っていたら、全員に別々のコピーを渡す
    // （画面が戻り値をその場で並べ替えたり書き換えたりしても、相乗りした別の呼び出しに影響しないように）。
    // waiters は結果が決まる前にしか増えない（決まる前に inflight から消える）ので、ここで読めば確定している
    return shared.waiters > 1 ? structuredClone(result) : result
  }

  /** 読み取りを 1 本送り出し、飛んでいる最中の表に載せる */
  function start(key: string, method: string, argsJson: string): Inflight {
    // finally は結果が呼び出し側に見える前に走る（finally が返す Promise は、コールバックのあとに決まる）。
    // だから「終わったあと」の同じ呼び出しは、必ず新しく送られる
    const promise = sendRead(method, argsJson).finally(() => {
      if (inflight.get(key) === entry) inflight.delete(key)
    })
    const entry: Inflight = { promise, waiters: 0 }
    inflight.set(key, entry)
    return entry
  }

  // ---- 1 本ずつ送る（書き込み・待ち行列に 1 本だけのとき・古いサーバーへの保険） ----

  async function requireToken(): Promise<string> {
    const token = await options.getToken()
    if (!token) {
      options.onUnauthorized()
      throw new ApiError('unauthorized', 'ログインが必要です。もう一度ログインしてください')
    }
    return token
  }

  /** 1 本の HTTP を送り、応答を読む。通信そのものの失敗は ApiError('network') */
  async function post(path: string, payload: string, token: string): Promise<Reply> {
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: payload,
      })
    } catch {
      // 圏外・機内モード・サーバー停止など。英語の生のエラー（Failed to fetch）は出さない
      throw new ApiError('network', 'サーバーにつながりません。通信の状態を確かめてください')
    }

    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // JSON でない（開発サーバーが index.html を返した、ゲートウェイのエラーなど）。状態コードから文言を作る
    }
    return { res, body }
  }

  /** 要求ごと失敗した応答から ApiError を作る。unauthorized ならログインに戻す（1 本の HTTP につき 1 回） */
  function failureOf(res: Response, body: unknown): ApiError {
    const error = (body as RpcBody | null | undefined)?.error
    const code = error?.code ?? (res.status === 401 ? 'unauthorized' : 'server_error')
    const message = error?.message || statusMessage(res.status)
    if (code === 'unauthorized') options.onUnauthorized()
    return new ApiError(code, message)
  }

  async function send(method: string, payload: string): Promise<unknown> {
    const token = await requireToken()
    const { res, body } = await post(`/rpc/${encodeURIComponent(method)}`, payload, token)
    const parsed = body as RpcBody | null
    if (res.ok && parsed && typeof parsed === 'object' && 'result' in parsed) return parsed.result
    throw failureOf(res, parsed)
  }

  /** 束（または待ち行列）の呼び出しを、それぞれ 1 本ずつの送り方で送る。終わりは待たない（結果は各呼び出しに返る） */
  function sendEach(items: Queued[]): void {
    for (const q of items) send(q.method, payloadOf(q.argsJson)).then(q.resolve, q.reject)
  }

  // ---- 読み取りをまとめて送る ----

  /**
   * 読み取りを送る。まとめられるときは待ち行列に入れ、1 回の区切り（setTimeout(0)）でまとめて吐き出す。
   * queueMicrotask ではなく setTimeout(0) にしたのは、Promise.all で並べた呼び出しだけでなく、
   * await を挟んだ直後に出る呼び出し（部品ごとの load()、nextTick のあと、など）も同じ束に拾うため。
   * マイクロタスクの連鎖は、次のマクロタスク（この区切り）の前にすべて終わる
   */
  function sendRead(method: string, argsJson: string): Promise<unknown> {
    if (!batching) return send(method, payloadOf(argsJson))
    return new Promise<unknown>((resolve, reject) => {
      queue.push({ method, argsJson, resolve, reject })
      if (!flushArmed) {
        flushArmed = true
        setTimeout(flush, 0)
      }
    })
  }

  /** 待ち行列を吐き出す。1 本だけ（またはまとめをやめたあと）は今までどおり、2 本以上は MAX_CALLS_PER_BATCH 本ずつの束にして _batch で */
  function flush(): void {
    flushArmed = false
    const items = queue
    queue = []
    if (items.length === 0) return
    if (items.length === 1 || !batching) {
      sendEach(items)
      return
    }
    for (let i = 0; i < items.length; i += MAX_CALLS_PER_BATCH) schedule(items.slice(i, i + MAX_CALLS_PER_BATCH))
  }

  /** 同時に飛ばす束は MAX_CONCURRENT_BATCHES まで（クライアント全体で数える）。あふれたぶんは前の束が終わるのを待つ */
  function schedule(bundle: Queued[]): void {
    if (activeBundles >= MAX_CONCURRENT_BATCHES) {
      waitingBundles.push(bundle)
      return
    }
    runBundle(bundle)
  }

  function runBundle(bundle: Queued[]): void {
    activeBundles += 1
    void sendBundle(bundle)
      .catch((e: unknown) => rejectAll(bundle, e)) // sendBundle は投げない作りだが、万一でも呼び出しを宙に浮かせない
      .finally(() => {
        activeBundles -= 1
        const next = waitingBundles.shift()
        if (next) runBundle(next)
      })
  }

  function rejectAll(bundle: Queued[], reason: unknown): void {
    for (const q of bundle) q.reject(reason)
  }

  /** 束 1 つを _batch で送り、結果を呼び出しごとに返す。例外は投げない（失敗は各呼び出しの reject で伝える） */
  async function sendBundle(bundle: Queued[]): Promise<void> {
    // 待っているあいだに、別の束が「サーバーは _batch を知らない」と分かったときは、試さずに 1 本ずつ送る
    if (!batching) {
      sendEach(bundle)
      return
    }

    // トークンは束ごとに 1 回
    let token: string
    try {
      token = await requireToken()
    } catch (e) {
      rejectAll(bundle, e)
      return
    }

    const payload = `{"calls":[${bundle.map((q) => `{"method":${JSON.stringify(q.method)},"args":${q.argsJson}}`).join(',')}]}`
    let reply: Reply
    try {
      reply = await post('/rpc/_batch', payload, token)
    } catch (e) {
      rejectAll(bundle, e)
      return
    }

    const { res, body } = reply
    // サーバーがまだ _batch を知らない（サーバーとの出し直しの順番がずれたとき）。1 本ずつ送り直し、以後まとめない
    if (res.status === 404 || res.status === 501) {
      batching = false
      sendEach(bundle)
      return
    }

    const results = res.ok ? (body as { results?: unknown } | null)?.results : undefined
    if (!Array.isArray(results) || results.length !== bundle.length) {
      // 要求ごとの失敗（401・400・500・JSON でない・形が違う）。まとめた全員が同じ失敗になる
      rejectAll(bundle, failureOf(res, body))
      return
    }

    let signedOut = false
    bundle.forEach((q, i) => {
      const entry = results[i] as BatchEntry | null
      if (entry && typeof entry === 'object' && 'result' in entry) {
        q.resolve(entry.result)
        return
      }
      const code = entry?.error?.code ?? 'server_error'
      const message = entry?.error?.message || statusMessage(res.status)
      // unauthorized は束につき 1 回だけログインへ戻す（1 本ずつ送るときと同じ「1 本の通信につき 1 回」）
      if (code === 'unauthorized' && !signedOut) {
        signedOut = true
        options.onUnauthorized()
      }
      q.reject(new ApiError(code, message))
    })
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
