import { createPostgresSql } from '../../../server/db/postgres'
import { INTERNAL_MESSAGE } from '../../../server/errors'
import { handleRpc } from '../../../server/rpc'
// 業務ロジックの登録（registerHandler の副作用）。ドメインを足したら server/domain/index.ts に 1 行足す
import '../../../server/domain/index'

// Cloudflare Pages Functions の入口。`POST /api/rpc/<method>`。中身は server/rpc.ts にあり、ここは薄く保つ。
//
// 設定（Cloudflare の Pages の設定。**秘密の値はこのリポジトリに書かない**）：
//   HYPERDRIVE          … Hyperdrive のバインディング（第一候補。先は Supabase の direct connection か session モード）
//   DATABASE_URL        … HYPERDRIVE が無いときの接続文字列。transaction モードのプーラ（6543）なら DATABASE_PREPARE=false も
//   DATABASE_PREPARE    … "false" で名前付き prepared statement を切る（既定は使う）
//   SUPABASE_URL        … https://xxxx.supabase.co （JWT の iss と JWKS の場所。商品画像の URL（Storage の media）の頭にも使う）
// 互換性フラグ `nodejs_compat` が要る（postgres.js が Node の API を使う）。
//
// @cloudflare/workers-types は入れていない（tsconfig に入れると DOM の型とぶつかる）ので、使う分だけ自前で書く。

interface Env {
  HYPERDRIVE?: { connectionString: string }
  DATABASE_URL?: string
  DATABASE_PREPARE?: string
  SUPABASE_URL?: string
}

interface PagesContext {
  request: Request
  env: Env
  params: Record<string, string | string[] | undefined>
  waitUntil(promise: Promise<unknown>): void
}

type PagesFunction = (context: PagesContext) => Promise<Response>

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function errorJson(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { ...JSON_HEADERS, ...headers } })
}

const handle: PagesFunction = async ({ request, env, params, waitUntil }) => {
  if (request.method !== 'POST') {
    return errorJson(405, 'bad_request', 'POST で呼んでください', { allow: 'POST' })
  }
  const url = env.HYPERDRIVE?.connectionString || env.DATABASE_URL
  if (!url) {
    console.error('[rpc] HYPERDRIVE も DATABASE_URL も設定されていません')
    return errorJson(500, 'internal', INTERNAL_MESSAGE)
  }
  const method = Array.isArray(params.method) ? params.method[0] : params.method

  // Workers は接続をリクエストをまたいで使えない。1 リクエスト 1 接続で、応答を返した後に閉じる
  const db = createPostgresSql(url, { prepare: env.DATABASE_PREPARE?.trim().toLowerCase() !== 'false' })
  try {
    return await handleRpc(request, method ?? '', { root: db, env })
  } finally {
    waitUntil(db.end().catch(() => {}))
  }
}

// onRequestPost が POST、onRequest がそれ以外のすべて（405）。どちらも同じ関数で、POST 以外は handle が断る
export const onRequestPost = handle
export const onRequest = handle
