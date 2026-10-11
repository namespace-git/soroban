import { PGlite } from '@electric-sql/pglite'
import type { PGliteOptions, Transaction } from '@electric-sql/pglite'
import { createSql, savepointViaSql, type Driver, type Sql } from './sql'
import { PARSERS } from './types'

/**
 * PGlite（WASM の Postgres）の `Sql`。**テスト用**。本番（Pages Functions）は `postgres.ts`。
 * このファイルを `functions/` から import しないこと（devDependencies で、バンドルに入れない）。
 */
export interface PgliteSql extends Sql {
  /** マイグレーションの流し込みなど、`Sql` を通さずに直接触りたいとき用 */
  readonly pg: PGlite
  close(): Promise<void>
}

export async function openPglite(options?: PGliteOptions): Promise<PgliteSql> {
  const pg = new PGlite(options)
  await pg.waitReady
  return fromPglite(pg)
}

export function fromPglite(pg: PGlite): PgliteSql {
  const root = createSql({
    ...driverOf(pg),
    // pg.transaction は他のクエリを待たせる排他（接続が 1 本のため）。fn が投げればロールバックされる
    // 入れ子は SQL の savepoint（PGlite の Transaction は入れ子を持たない）
    begin: (fn) => pg.transaction((tx) => fn(savepointViaSql(driverOf(tx)))),
  })
  return Object.assign(root, { pg, close: () => pg.close() })
}

function driverOf(target: Pick<PGlite | Transaction, 'query'>): Driver {
  return {
    async query(text, params) {
      // 型の読み出しは postgres.js と揃える（types.ts）。parsers は既定に重ねて効く
      const r = await target.query<Record<string, unknown>>(text, params as unknown[], { parsers: PARSERS })
      return { rows: r.rows, changes: r.affectedRows ?? 0 }
    },
  }
}
