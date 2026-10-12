import { handleAgentEntry, type EntryEnv } from '../../../server/entry'

// Cloudflare Pages Functions の入口。`POST /api/agent/<method>`（取り込み担当の PC だけが呼ぶ）。
// 中身は server/entry.ts（Workers の worker/index.ts と共通）→ server/agent/ にあり、ここは `functions/api/rpc/[method].ts` と同じく薄く保つ。
// 認証：register は人の JWT（Authorization: Bearer）、それ以外は取り込み担当の鍵（Authorization: Agent）。
// 設定は rpc と同じ（server/entry.ts の冒頭のとおり。**秘密の値はこのリポジトリに書かない**。手順は docs/web/01-setup.md）。
// 互換性フラグ `nodejs_compat` が要る（postgres.js が Node の API を使う）。

interface PagesContext {
  request: Request
  env: EntryEnv
  params: Record<string, string | string[] | undefined>
  waitUntil(promise: Promise<unknown>): void
}

type PagesFunction = (context: PagesContext) => Promise<Response>

const handle: PagesFunction = ({ request, env, params, waitUntil }) => {
  const method = Array.isArray(params.method) ? params.method[0] : params.method
  return handleAgentEntry(request, env, method ?? '', waitUntil)
}

export const onRequestPost = handle
export const onRequest = handle
