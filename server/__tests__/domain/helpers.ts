import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { withHousehold, type Ctx } from '../../context'
import { fromPglite, type PgliteSql } from '../../db/pglite'
import type { Sql } from '../../db/sql'
import { dispatch } from '../../rpc'
import { createMigratedDb } from '../../test/migrate'

// ドメイン（server/domain/*）のテスト用の道具。
// 本物のマイグレーションを流した PGlite に、世帯 A と B を app.create_household で作る。
// 各テストは新しい世帯の組を作る（世帯ごとに行が分かれるので、DB を作り直さずに、まっさらな状態で始められる）

export const SUPABASE_URL = 'https://abcdefgh.supabase.test'
export const MEDIA_BASE = `${SUPABASE_URL}/storage/v1/object/public/media`

export interface DomainDb {
  pg: PGlite
  root: PgliteSql
  close(): Promise<void>
}

export async function openDomainDb(): Promise<DomainDb> {
  const pg = await createMigratedDb()
  const root = fromPglite(pg)
  return { pg, root, close: () => pg.close() }
}

export interface Member {
  householdId: string
  userId: string
  /** この世帯として 1 リクエスト（1 トランザクション）ぶんを実行する */
  run<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T>
  /** API の入口（dispatch）経由で呼ぶ。応答の本文は JSON として読んで返す */
  call(method: string, ...args: unknown[]): Promise<{ status: number; body: { result?: unknown; error?: { code: string; message: string } } }>
}

export interface World {
  a: Member
  b: Member
}

/** 世帯 A と B を新しく作る（それぞれ別のユーザーが 1 人） */
export async function newWorld(db: DomainDb): Promise<World> {
  return { a: await newMember(db, 'A'), b: await newMember(db, 'B') }
}

export async function newMember(db: DomainDb, name: string): Promise<Member> {
  const userId = randomUUID()
  await db.pg.query('insert into auth.users (id, email) values ($1, $2)', [userId, `${userId}@example.test`])
  const created = await db.pg.query<{ id: string }>('select app.create_household($1, $2::uuid[]) as id', [name, [userId]])
  return memberOf(db, created.rows[0].id, userId)
}

/** root は接続ロールの Sql（PGlite のアダプタでも、postgres.js でもよい） */
export function memberOf(db: { root: Sql }, householdId: string, userId: string): Member {
  return {
    householdId,
    userId,
    run: (fn) => withHousehold(db.root, { householdId, userId, mediaBase: MEDIA_BASE }, fn),
    async call(method, ...args) {
      const response = await dispatch(method, args, { root: db.root, identity: { householdId, userId }, env: { SUPABASE_URL } })
      return { status: response.status, body: JSON.parse(await response.text()) }
    },
  }
}
