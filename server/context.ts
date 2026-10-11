import type { Sql } from './db/sql'

/** 業務ロジックが受け取る文脈。`sql` は世帯のトランザクションの中（RLS が効くロール）の Sql */
export interface Ctx {
  sql: Sql
  householdId: string
  userId: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  ids: { householdId: string; userId: string },
  fn: (ctx: Ctx) => Promise<T>,
): Promise<T> {
  // set_config に渡る値。uuid 以外は入れない（RLS の policy が ::uuid で読むので、変な値は別のエラーになる前にここで断る）
  const householdId = asUuid(ids.householdId, 'householdId')
  const userId = asUuid(ids.userId, 'userId')
  return root.tx(async (sql) => {
    await sql.run('set local search_path = app, public')
    await sql.run('set local role soroban_api')
    await sql.get("select set_config('app.household_id', ?, true), set_config('app.user_id', ?, true)", householdId, userId)
    return fn({ sql, householdId, userId })
  })
}

function asUuid(value: string, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`withHousehold: ${name} が uuid ではありません`)
  return value.toLowerCase()
}
