import type { Sql } from './db/sql'

/**
 * 業務ロジックが読む環境変数（Cloudflare の環境変数。入口が `serverEnvFrom` で整えて `Ctx.env` に載せる）。
 * 無い・空のものは null。
 *
 * **VAPID_PRIVATE_KEY と SECRET_KEYS は秘密。** ログ・エラー文・応答に出さない（読むのは `server/push`・`server/secrets` だけ）。
 * `Ctx` を丸ごと JSON にしたり console に出したりしないこと
 */
export interface ServerEnv {
  /** 例 https://xxxx.supabase.co 。公開してよい値 */
  SUPABASE_URL: string | null
  /** Web Push の公開鍵（base64url の 65 バイト）。公開してよい値（画面の購読に渡す） */
  VAPID_PUBLIC_KEY: string | null
  /** 秘密。Web Push の署名鍵（base64url の 32 バイト） */
  VAPID_PRIVATE_KEY: string | null
  /** Web Push の連絡先（`mailto:` か `https://`） */
  VAPID_SUBJECT: string | null
  /** 秘密。API キーを暗号化する鍵の束（`版:鍵` のカンマ区切り） */
  SECRET_KEYS: string | null
}

/** 入口が受け取る生の環境変数（Cloudflare の `env` のうち、ここで読むもの）。値が無ければ undefined */
export type RawServerEnv = { [K in keyof ServerEnv]?: string }

/** 何も設定されていない環境。テストと、環境を渡していない呼び出しの既定 */
export const EMPTY_SERVER_ENV: ServerEnv = Object.freeze({
  SUPABASE_URL: null,
  VAPID_PUBLIC_KEY: null,
  VAPID_PRIVATE_KEY: null,
  VAPID_SUBJECT: null,
  SECRET_KEYS: null,
})

/** 生の環境変数を `ServerEnv` にする。前後の空白を落とし、空・文字でないものは null */
export function serverEnvFrom(raw: RawServerEnv | null | undefined): ServerEnv {
  const pick = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
  return {
    SUPABASE_URL: pick(raw?.SUPABASE_URL),
    VAPID_PUBLIC_KEY: pick(raw?.VAPID_PUBLIC_KEY),
    VAPID_PRIVATE_KEY: pick(raw?.VAPID_PRIVATE_KEY),
    VAPID_SUBJECT: pick(raw?.VAPID_SUBJECT),
    SECRET_KEYS: pick(raw?.SECRET_KEYS),
  }
}

/** 業務ロジックが受け取る文脈。`sql` は世帯のトランザクションの中（RLS が効くロール）の Sql */
export interface Ctx {
  sql: Sql
  householdId: string
  userId: string
  /**
   * 商品の写真（公開バケット media）の URL の頭。`${SUPABASE_URL}/storage/v1/object/public/media`。
   * SUPABASE_URL が無ければ null（画像の URL は返さない）。URL は `_shared.ts` の `mediaUrl` で作る
   */
  mediaBase: string | null
  /** 環境変数（VAPID_*・SECRET_KEYS など）。入口が渡す。渡していなければ全部 null（鍵なし＝通知も API キーの保存も使えない） */
  env: ServerEnv
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 環境変数 SUPABASE_URL から、公開バケット media の URL の頭を作る。無ければ null */
export function mediaBaseFromEnv(env: { SUPABASE_URL?: string | null }): string | null {
  const base = env.SUPABASE_URL?.trim().replace(/\/+$/, '')
  return base ? `${base}/storage/v1/object/public/media` : null
}

/**
 * **1 リクエスト＝1 トランザクション**で、その世帯として動く。
 *
 * 中で必ずこの順に行う：
 *   1. `set local search_path = app, public`
 *   2. `set local role soroban_api`   … BYPASSRLS を持たないロールに切り替える（ここから RLS が効く）
 *   3. `set_config('app.household_id' / 'app.user_id', …, true)`   … true＝local
 *
 * **`set local` はトランザクションが終われば（commit でも rollback でも）消える。`set`（local なし）は使わない。**
 * プーラ越しで次の人の接続に世帯が残らないための約束。
 *
 * `root` は接続ロールの Sql で、**トランザクションの外**のもの（入れ子で呼ばない。
 * 呼ぶと `set local role` が外側のトランザクションの終わりまで残る）。
 * fn が例外を投げればロールバックされ、そのまま再スローされる。
 */
export async function withHousehold<T>(
  root: Sql,
  ids: { householdId: string; userId: string; mediaBase?: string | null; env?: ServerEnv },
  fn: (ctx: Ctx) => Promise<T>,
): Promise<T> {
  // set_config に渡る値。uuid 以外は入れない（RLS の policy が ::uuid で読むので、変な値は別のエラーになる前にここで断る）
  const householdId = asUuid(ids.householdId, 'householdId')
  const userId = asUuid(ids.userId, 'userId')
  const env = ids.env ?? EMPTY_SERVER_ENV
  // mediaBase を直接渡したときはそちらが先（テスト用）。渡さなければ env の SUPABASE_URL から作る
  const mediaBase = ids.mediaBase !== undefined ? ids.mediaBase : mediaBaseFromEnv(env)
  return root.tx(async (sql) => {
    await sql.run('set local search_path = app, public')
    await sql.run('set local role soroban_api')
    await sql.get("select set_config('app.household_id', ?, true), set_config('app.user_id', ?, true)", householdId, userId)
    return fn({ sql, householdId, userId, mediaBase, env })
  })
}

function asUuid(value: string, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`withHousehold: ${name} が uuid ではありません`)
  return value.toLowerCase()
}
