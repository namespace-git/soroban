import { createPostgresSql } from '../server/db/postgres'
import { errorJson, handleAgentEntry, handleRpcEntry, type EntryEnv } from '../server/entry'
import { runCron, type CronEnv } from '../workers/cron/index'

// Cloudflare Workers の入口。**1 本の Worker で「画面（静的アセット）＋ API ＋ 定期実行」をやる**。設定は repo 直下の wrangler.jsonc。
// 手順：docs/web/01-setup.md の 2 節。
//
//   fetch      … /api/rpc/<method>   → 画面の API（server/entry.ts の handleRpcEntry。functions/api/rpc と同じ処理）
//                /api/agent/<method> → 取り込み担当の PC の API（handleAgentEntry。functions/api/agent と同じ処理）
//                それ以外の /api/*   → 404（JSON）
//                それ以外のパス       → 画面（env.ASSETS。wrangler.jsonc の assets。存在しないパスは index.html に落とす）
//                wrangler.jsonc の run_worker_first で /api/* だけがここに来る。画面のファイルは Worker を通らず直接返る
//   scheduled  … 5 分ごと（wrangler.jsonc の triggers.crons）。workers/cron/index.ts の runCron を呼ぶ
//                （期限切れの取り込み要求の片付け・通知の送信・17TRACK の確認）
//
// 設定（Cloudflare の Worker の設定。**秘密の値はこのリポジトリに書かない**）：
//   HYPERDRIVE          … Hyperdrive のバインディング（wrangler.jsonc の hyperdrive に id を書く）。無ければ API は「設定が無い」で
//                         500 を返し、定期実行は何もしない（画面は出る）
//   SUPABASE_URL / SUPABASE_ANON_KEY … 公開してよい値（wrangler.jsonc の vars）
//   VAPID_* / SECRET_KEYS            … 秘密（Cloudflare の画面で Secret 型として入れる）
// 互換性フラグ `nodejs_compat` が要る（postgres.js が Node の API を使う）。
//
// @cloudflare/workers-types は入れていない（入口と同じく、使う分だけ自前で書く）。

/** wrangler.jsonc の assets.binding。静的アセットを返す */
interface AssetsFetcher {
  fetch(request: Request): Promise<Response>
}

export interface WorkerEnv extends EntryEnv, CronEnv {
  ASSETS: AssetsFetcher
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}

interface ScheduledControllerLike {
  cron: string
  scheduledTime: number
}

/** `/api/rpc/<method>`・`/api/agent/<method>`（method は 1 区間だけ。Pages Functions の `[method]` と同じ） */
const API_ROUTE = /^\/api\/(rpc|agent)\/([^/]+)$/

function notFound(): Response {
  return errorJson(404, 'not_found', 'そのAPIはありません')
}

async function handleApi(request: Request, env: WorkerEnv, ctx: ExecutionContextLike, pathname: string): Promise<Response> {
  const route = API_ROUTE.exec(pathname)
  if (!route) return notFound()
  let method: string
  try {
    method = decodeURIComponent(route[2])
  } catch {
    return notFound()
  }
  // waitUntil は ctx から外して呼ぶと Workers が「Illegal invocation」で断る。ctx に結び付けて渡す
  const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise)
  return route[1] === 'rpc'
    ? handleRpcEntry(request, env, method, waitUntil)
    : handleAgentEntry(request, env, method, waitUntil)
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
    const { pathname } = new URL(request.url)
    // wrangler.jsonc の run_worker_first（/api/*）と同じ範囲
    if (pathname.startsWith('/api/')) return handleApi(request, env, ctx, pathname)
    return env.ASSETS.fetch(request)
  },

  async scheduled(_controller: ScheduledControllerLike, env: WorkerEnv): Promise<void> {
    const url = env.HYPERDRIVE?.connectionString
    if (!url) {
      console.error('[cron] HYPERDRIVE が設定されていません（wrangler.jsonc の hyperdrive の id を確認してください）')
      return
    }
    // Workers は接続を呼び出しをまたいで使えない。1 回の実行で 1 接続（Hyperdrive 前提なので prepare ありのまま）
    const db = createPostgresSql(url, { prepare: true })
    try {
      await runCron(db, env)
    } finally {
      await db.end().catch(() => {})
    }
  },
}
