import { handleRpcEntry, type EntryEnv } from '../../../server/entry'

// Cloudflare Pages Functions の入口。`POST /api/rpc/<method>`。
// 中身は server/entry.ts（Workers の worker/index.ts と共通）→ server/rpc.ts にあり、ここは薄く保つ。
// 設定（HYPERDRIVE / DATABASE_URL / SUPABASE_URL / VAPID_* / SECRET_KEYS …）は server/entry.ts の冒頭のとおり。
// **秘密の値はこのリポジトリに書かない**。手順は docs/web/01-setup.md。
// 互換性フラグ `nodejs_compat` が要る（postgres.js が Node の API を使う）。
//
// @cloudflare/workers-types は入れていない（tsconfig に入れると DOM の型とぶつかる）ので、使う分だけ自前で書く。

interface PagesContext {
  request: Request
  env: EntryEnv
  params: Record<string, string | string[] | undefined>
  waitUntil(promise: Promise<unknown>): void
}

type PagesFunction = (context: PagesContext) => Promise<Response>

const handle: PagesFunction = ({ request, env, params, waitUntil }) => {
  const method = Array.isArray(params.method) ? params.method[0] : params.method
  return handleRpcEntry(request, env, method ?? '', waitUntil)
}

// onRequestPost が POST、onRequest がそれ以外のすべて（405）。どちらも同じ関数で、POST 以外は入口が断る
export const onRequestPost = handle
export const onRequest = handle
