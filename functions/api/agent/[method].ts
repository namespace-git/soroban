import { handleAgent } from '../../../server/agent/index'
import { createPostgresSql } from '../../../server/db/postgres'
import { INTERNAL_MESSAGE } from '../../../server/errors'

// Cloudflare Pages Functions の入口。`POST /api/agent/<method>`（取り込み担当の PC だけが呼ぶ）。
// 中身は server/agent/ にあり、ここは `functions/api/rpc/[method].ts` と同じく薄く保つ。
// 認証：register は人の JWT（Authorization: Bearer）、それ以外は取り込み担当の鍵（Authorization: Agent）。
//
// 設定は rpc と同じ（HYPERDRIVE / DATABASE_URL / DATABASE_PREPARE / SUPABASE_URL。**秘密の値はこのリポジトリに書かない**）。
// 互換性フラグ `nodejs_compat` が要る（postgres.js が Node の API を使う）。

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
    console.error('[agent] HYPERDRIVE も DATABASE_URL も設定されていません')
    return errorJson(500, 'internal', INTERNAL_MESSAGE)
  }
  const method = Array.isArray(params.method) ? params.method[0] : params.method

  // Workers は接続をリクエストをまたいで使えない。1 リクエスト 1 接続で、応答を返した後に閉じる
  const db = createPostgresSql(url, { prepare: env.DATABASE_PREPARE?.trim().toLowerCase() !== 'false' })
  try {
    return await handleAgent(request, method ?? '', { root: db, env })
  } finally {
    waitUntil(db.end().catch(() => {}))
  }
}

export const onRequestPost = handle
export const onRequest = handle
