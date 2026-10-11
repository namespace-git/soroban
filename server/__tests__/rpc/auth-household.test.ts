import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findHousehold } from '../../auth'
import { fromPglite, type PgliteSql } from '../../db/pglite'
import { ApiError } from '../../errors'
import { createMigratedDb } from '../../test/migrate'

// 認証は app.household_of_user（security definer）を通して世帯を引く。
// 本物のマイグレーションの上で確かめる（auth.test.ts の方は、同名のスタブ関数の上）

let pg: PGlite
let root: PgliteSql

beforeAll(async () => {
  pg = await createMigratedDb()
  root = fromPglite(pg)
})

afterAll(async () => {
  await pg.close()
})

const newUser = async (): Promise<string> => {
  const id = randomUUID()
  await pg.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@example.test`])
  return id
}

const createHousehold = async (name: string, owners: string[]): Promise<string> =>
  (await pg.query<{ id: string }>('select app.create_household($1, $2::uuid[]) as id', [name, owners])).rows[0].id

describe('findHousehold（本物のマイグレーション）', () => {
  it('属している世帯を返す。属していなければ 403', async () => {
    const user = await newUser()
    const household = await createHousehold('うち', [user])
    await expect(findHousehold(root, user)).resolves.toBe(household)

    const outsider = await newUser()
    const err = await findHousehold(root, outsider).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('forbidden')
  })

  it('複数の世帯に入っていれば、作成日の古い方（毎回同じ）', async () => {
    const user = await newUser()
    const older = await createHousehold('古い', [user])
    await createHousehold('新しい', [user])
    expect(await findHousehold(root, user)).toBe(older)
    expect(await findHousehold(root, user)).toBe(older)
  })

  it('接続ロールに BYPASSRLS が無く、全テーブルが force row level security でも世帯が引ける（直接 select すると 0 件）', async () => {
    const user = await newUser()
    const household = await createHousehold('RLS', [user])

    // Supabase の postgres は BYPASSRLS を持つが、持たない接続ロールでも通ることを確かめる。
    // 表と関数の持ち主を BYPASSRLS の無いロールに替え、接続ロールも BYPASSRLS の無いロールにして呼ぶ
    // （このトランザクションの中だけ。最後にロールバック）
    const result = await root
      .tx(async (tx) => {
        await tx.run('create role probe_owner nologin nosuperuser nobypassrls')
        await tx.run('create role probe_conn nologin nosuperuser nobypassrls')
        await tx.run('grant usage on schema app to probe_owner, probe_conn')
        await tx.run('alter table app.household owner to probe_owner')
        await tx.run('alter table app.household_member owner to probe_owner')
        await tx.run('alter function app.household_of_user(uuid) owner to probe_owner')
        await tx.run('grant execute on function app.household_of_user(uuid) to probe_conn')
        // 直接 select は許す（それでも force row level security で 0 件になることの対照）
        await tx.run('grant select on app.household_member to probe_conn')
        await tx.run('set local role probe_conn')

        const who = (await tx.get<{ r: string }>('select current_user as r'))!.r
        const direct = await tx.all('select household_id from app.household_member where user_id = ?', user)
        const found = await findHousehold(tx, user)
        const stillNobody = await findHousehold(tx, randomUUID()).then(() => 'found', (e: unknown) => (e as ApiError).code)
        throw Object.assign(new Error('rollback'), { probe: { who, direct, found, stillNobody } })
      })
      .catch((e: { probe?: Record<string, unknown> }) => e.probe)

    expect(result).toEqual({ who: 'probe_conn', direct: [], found: household, stillNobody: 'forbidden' })

    // ロールバックされて、元の持ち主に戻っている
    const owner = await pg.query<{ owner: string }>(
      `select pg_get_userbyid(proowner) as owner from pg_proc where proname = 'household_of_user' and pronamespace = 'app'::regnamespace`,
    )
    expect(owner.rows[0].owner).toBe('postgres')
    await expect(findHousehold(root, user)).resolves.toBe(household)
  })
})
