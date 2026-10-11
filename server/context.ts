import type { Sql } from './db/sql'

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
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 環境変数 SUPABASE_URL から、公開バケット media の URL の頭を作る。無ければ null */
export function mediaBaseFromEnv(env: { SUPABASE_URL?: string }): string | null {
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
  ids: { householdId: string; userId: string; mediaBase?: string | null },
  fn: (ctx: Ctx) => Promise<T>,
): Promise<T> {
  // set_config に渡る値。uuid 以外は入れない（RLS の policy が ::uuid で読むので、変な値は別のエラーになる前にここで断る）
  const householdId = asUuid(ids.householdId, 'householdId')
  const userId = asUuid(ids.userId, 'userId')
  const mediaBase = ids.mediaBase ?? null
  return root.tx(async (sql) => {
    await sql.run('set local search_path = app, public')
    await sql.run('set local role soroban_api')
    await sql.get("select set_config('app.household_id', ?, true), set_config('app.user_id', ?, true)", householdId, userId)
    return fn({ sql, householdId, userId, mediaBase })
  })
}

function asUuid(value: string, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`withHousehold: ${name} が uuid ではありません`)
  return value.toLowerCase()
}
