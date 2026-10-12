import { agentMayQueueNotification, handleAgent } from './agent/index'
import type { RawServerEnv } from './context'
import { createPostgresSql } from './db/postgres'
import type { Sql } from './db/sql'
import { INTERNAL_MESSAGE } from './errors'
import { closeAfterResponse, handleRpc, mayQueueNotification } from './rpc'
// 業務ロジックの登録（registerHandler の副作用）。ドメインを足したら server/domain/index.ts に 1 行足す
import './domain/index'

// `/api/rpc/<method>`・`/api/agent/<method>` の入口の処理。**Cloudflare Pages Functions（functions/api/…）と
// Workers（worker/index.ts）の両方がこれを呼ぶ**（入口の処理を 2 か所に書かない）。呼ぶ側は、URL から method を取り出して
// ここに渡すだけ。ここは Cloudflare の型に依存しない（waitUntil は関数として受け取る）。
//
// 設定（Cloudflare の設定。**秘密の値はこのリポジトリに書かない**。手順は docs/web/01-setup.md の 2 節）：
//   HYPERDRIVE          … Hyperdrive のバインディング（第一候補。先は Supabase の direct connection か session モード）
//   DATABASE_URL        … HYPERDRIVE が無いときの接続文字列。transaction モードのプーラ（6543）なら DATABASE_PREPARE=false も
//   DATABASE_PREPARE    … "false" で名前付き prepared statement を切る（既定は使う）
//   SUPABASE_URL ほか   … RawServerEnv のとおり（JWT の検証・画像の URL・Web Push の鍵・API キーの暗号化の鍵）
// 互換性フラグ `nodejs_compat` が要る（postgres.js が Node の API を使う）。

export interface EntryEnv extends RawServerEnv {
  HYPERDRIVE?: { connectionString: string }
  DATABASE_URL?: string
  DATABASE_PREPARE?: string
}

/** 応答を返したあとの仕事を登録する（Pages の context.waitUntil・Workers の ctx.waitUntil） */
export type WaitUntil = (promise: Promise<unknown>) => void

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/** 入口の失敗の応答（`{"error": {"code", "message"}}`）。`/api/*` の応答はコードが付けるので、ヘッダーもここで付ける */
export function errorJson(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { ...JSON_HEADERS, ...headers } })
}

/**
 * 1 リクエスト 1 接続。POST 以外は 405、接続先が無ければ 500。
 * Workers は接続をリクエストをまたいで使えない。応答を返したあとに、（書き込みが成功したときだけ）積んだ通知を急ぎで送ってみて、
 * **そのあとで**接続を閉じる。送れなくても定期実行（Cron）が拾う
 */
async function serve(
  label: 'rpc' | 'agent',
  request: Request,
  env: EntryEnv,
  waitUntil: WaitUntil,
  run: (db: Sql) => Promise<Response>,
  mayNotify: (response: Response) => boolean,
): Promise<Response> {
  if (request.method !== 'POST') {
    return errorJson(405, 'bad_request', 'POST で呼んでください', { allow: 'POST' })
  }
  const url = env.HYPERDRIVE?.connectionString || env.DATABASE_URL
  if (!url) {
    console.error(`[${label}] HYPERDRIVE も DATABASE_URL も設定されていません`)
    return errorJson(500, 'internal', INTERNAL_MESSAGE)
  }
  const db = createPostgresSql(url, { prepare: env.DATABASE_PREPARE?.trim().toLowerCase() !== 'false' })
  let notify = false
  try {
    const response = await run(db)
    notify = mayNotify(response)
    return response
  } finally {
    waitUntil(closeAfterResponse(db, env, notify))
  }
}

/** `POST /api/rpc/<method>`（画面の API。認証は人の JWT） */
export function handleRpcEntry(request: Request, env: EntryEnv, method: string, waitUntil: WaitUntil): Promise<Response> {
  return serve(
    'rpc', request, env, waitUntil,
    (db) => handleRpc(request, method, { root: db, env }),
    (response) => mayQueueNotification(method, response),
  )
}

/** `POST /api/agent/<method>`（取り込み担当の PC だけが呼ぶ。register は人の JWT、それ以外は取り込み担当の鍵） */
export function handleAgentEntry(request: Request, env: EntryEnv, method: string, waitUntil: WaitUntil): Promise<Response> {
  return serve(
    'agent', request, env, waitUntil,
    (db) => handleAgent(request, method, { root: db, env }),
    (response) => agentMayQueueNotification(method, response),
  )
}
