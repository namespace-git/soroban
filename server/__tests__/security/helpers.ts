import type { PGlite, Transaction } from '@electric-sql/pglite'

export { asApi, asApiWithoutHousehold, asRole, HH_A, HH_B, seedHouseholds, sqlstateOf, USER_A, USER_B } from '../schema/helpers'

/**
 * 接続のユーザーを postgres（テストの接続ロール）に戻す。
 * PGlite は、`set local session authorization` をトランザクションの終わり（commit でも rollback でも）で元に戻さず、
 * `reset session authorization` も元の postgres には戻さない（切り替えた先のまま残る）。本物の Postgres では戻るが、
 * 次のテストに持ち越さないよう、postgres を明示して戻す
 */
export async function backToConnectionRole(db: PGlite): Promise<void> {
  await db.exec('set session authorization postgres')
}

/**
 * API の接続（Hyperdrive 経由の soroban_gateway）と同じ入り方。
 *
 * `set session authorization` で、接続のユーザーそのものを soroban_gateway にする。`set role` だけだと、
 * 接続のユーザー（テストでは superuser の postgres）の権限で `set role soroban_api` できてしまい、
 * gateway が soroban_api のメンバーかどうかを確かめられない。session authorization なら、そこから先の
 * `set role` は gateway のメンバーシップで判定される（本番の「gateway でログインして set role する」と同じ）。
 * 終わったら（失敗しても）postgres に戻す
 */
export async function asGateway<T>(db: PGlite, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.query('set local session authorization soroban_gateway')
      return fn(tx)
    })
  } finally {
    await backToConnectionRole(db)
  }
}

/** ゲートウェイでつないで、世帯の文脈（soroban_api ＋ app.household_id ＋ app.user_id）に切り替える。server/context.ts の withHousehold と同じ順 */
export async function asGatewayThenApi<T>(
  db: PGlite,
  householdId: string,
  fn: (tx: Transaction) => Promise<T>,
  opts: { userId?: string } = {},
): Promise<T> {
  return asGateway(db, async (tx) => {
    await tx.query('set local search_path = app, public')
    await tx.query('set local role soroban_api')
    await tx.query("select set_config('app.household_id', $1, true), set_config('app.user_id', $2, true)", [householdId, opts.userId ?? ''])
    return fn(tx)
  })
}
