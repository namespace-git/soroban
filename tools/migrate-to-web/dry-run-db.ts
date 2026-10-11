import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { fromPglite, type PgliteSql } from '../../server/db/pglite'
import { createSupabaseStubs, migrate } from '../../server/test/migrate'

// --dry-run の行き先。PGlite（WASM の Postgres）に supabase/migrations を全部流して、世帯を 1 つ作る。
// 本番とは何もつながらない（通信しない）。終わったら捨てる

export interface DryRunTarget {
  sql: PgliteSql
  householdId: string
  close(): Promise<void>
}

export async function openDryRunTarget(migrationsDir: string): Promise<DryRunTarget> {
  if (!existsSync(migrationsDir)) {
    throw new Error(`マイグレーションのフォルダが見つかりません: ${migrationsDir}（--migrations で指定できます）`)
  }
  const pg = new PGlite()
  await pg.waitReady
  await createSupabaseStubs(pg)
  await migrate(pg, migrationsDir)
  // Supabase の既定と同じ UTC のセッション
  await pg.exec("set time zone 'UTC'")
  const userId = randomUUID()
  await pg.query('insert into auth.users (id, email) values ($1, $2)', [userId, 'dry-run@example.test'])
  const created = await pg.query<{ id: string }>('select app.create_household($1, $2::uuid[]) as id', ['dry-run', [userId]])
  return { sql: fromPglite(pg), householdId: created.rows[0].id, close: () => pg.close() }
}
