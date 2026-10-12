import { agentMayQueueNotification, handleAgent } from '../../../server/agent/index'
import { createPostgresSql } from '../../../server/db/postgres'
import { INTERNAL_MESSAGE } from '../../../server/errors'
import { closeAfterResponse } from '../../../server/rpc'

// Cloudflare Pages Functions の入口。`POST /api/agent/<method>`（取り込み担当の PC だけが呼ぶ）。
// 中身は server/agent/ にあり、ここは `functions/api/rpc/[method].ts` と同じく薄く保つ。
// 認証：register は人の JWT（Authorization: Bearer）、それ以外は取り込み担当の鍵（Authorization: Agent）。
//
// 設定は rpc と同じ（HYPERDRIVE / DATABASE_URL / DATABASE_PREPARE / SUPABASE_URL / SUPABASE_ANON_KEY / VAPID_* / SECRET_KEYS。
// **秘密の値はこのリポジトリに書かない**。手順は docs/web/01-setup.md の 2-4）。
// 互換性フラグ `nodejs_compat` が要る（postgres.js が Node の API を使う）。

interface Env {
  HYPERDRIVE?: { connectionString: string }
  DATABASE_URL?: string
  DATABASE_PREPARE?: string
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
  SECRET_KEYS?: string
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

  // Workers は接続をリクエストをまたいで使えない。1 リクエスト 1 接続。
  // 応答を返したあとに、（販売・注文の取り込みや終わりの報告が成功したときだけ）積んだ通知を急ぎで送ってみて、
  // **そのあとで**接続を閉じる。送れなくても Cron の Worker が拾う
  const db = createPostgresSql(url, { prepare: env.DATABASE_PREPARE?.trim().toLowerCase() !== 'false' })
  let notify = false
  try {
    const response = await handleAgent(request, method ?? '', { root: db, env })
    notify = agentMayQueueNotification(method ?? '', response)
    return response
  } finally {
    waitUntil(closeAfterResponse(db, env, notify))
  }
}

export const onRequestPost = handle
export const onRequest = handle
