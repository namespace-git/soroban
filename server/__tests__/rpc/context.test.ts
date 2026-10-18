import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { withHousehold } from '../../context'
import { DRIVER_NAMES, HOUSEHOLD_A, HOUSEHOLD_B, USER_A, USER_B, openTestDb, type TestDb } from './helpers'

let db: TestDb
// withHousehold を一度も通る前の search_path（これと比べる。途中で漏れた後の値と比べると見逃す）
let baselineSearchPath: string

beforeAll(async () => {
  db = await openTestDb()
  baselineSearchPath = (await db.pg.query<{ sp: string }>(`select current_setting('search_path') as sp`)).rows[0].sp
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.pg.exec('truncate app.note')
  // RLS を飛び越える接続ロール（superuser）で、両方の世帯の行を直接入れる
  await db.pg.query(`insert into app.note (household_id, body) values ($1, 'A-1'), ($1, 'A-2'), ($2, 'B-1')`, [HOUSEHOLD_A, HOUSEHOLD_B])
})

describe.each(DRIVER_NAMES)('withHousehold: %s', (name) => {
  const root = () => db.drivers.find((d) => d.name === name)!.sql
  const a = { householdId: HOUSEHOLD_A, userId: USER_A }
  const b = { householdId: HOUSEHOLD_B, userId: USER_B }

  it('中では current_user が soroban_api で、app.household_id・app.user_id・search_path が設定済み', async () => {
    const r = await withHousehold(root(), a, async (ctx) => {
      expect(ctx.householdId).toBe(HOUSEHOLD_A)
      expect(ctx.userId).toBe(USER_A)
      return ctx.sql.get<{ who: string; hh: string; uu: string; sp: string }>(
        `select current_user as who, current_setting('app.household_id') as hh, current_setting('app.user_id') as uu, current_setting('search_path') as sp`,
      )
    })
    expect(r).toEqual({ who: 'soroban_api', hh: HOUSEHOLD_A, uu: USER_A, sp: 'app, public' })
  })

  it('抜けた後は元に戻っている（set local が漏れない）', async () => {
    await withHousehold(root(), a, async () => 'done')
    const after = await root().get<{ who: string; hh: string | null; uu: string | null; sp: string }>(
      `select current_user as who, current_setting('app.household_id', true) as hh, current_setting('app.user_id', true) as uu, current_setting('search_path') as sp`,
    )
    expect(after?.who).not.toBe('soroban_api')
    expect(after?.sp).toBe(baselineSearchPath)
    // 未設定（null）か空文字。世帯の値は残らない
    expect(after?.hh ?? '').toBe('')
    expect(after?.uu ?? '').toBe('')
  })

  it('例外でロールバックされ、そのまま再スローされる。そのあとも漏れない', async () => {
    await expect(
      withHousehold(root(), a, async (ctx) => {
        await ctx.sql.run(`insert into note (body) values ('rolled back')`)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await root().get('select 1 from app.note where body = ?', 'rolled back')).toBeUndefined()
    const after = await root().get<{ who: string; hh: string | null }>(`select current_user as who, current_setting('app.household_id', true) as hh`)
    expect(after?.who).not.toBe('soroban_api')
    expect(after?.hh ?? '').toBe('')
  })

  it('RLS：世帯 A の文脈では、SQL が絞り込みを書いていなくても世帯 B の行は見えない', async () => {
    const seenByA = await withHousehold(root(), a, (ctx) => ctx.sql.all<{ body: string }>('select body from note order by body'))
    expect(seenByA.map((r) => r.body)).toEqual(['A-1', 'A-2'])
    const seenByB = await withHousehold(root(), b, (ctx) => ctx.sql.all<{ body: string }>('select body from note order by body'))
    expect(seenByB.map((r) => r.body)).toEqual(['B-1'])
  })

  it('RLS：他の世帯の行は更新も削除もできない（0 件）', async () => {
    const r = await withHousehold(root(), a, async (ctx) => ({
      updated: await ctx.sql.run(`update note set body = 'hacked' where body = 'B-1'`),
      deleted: await ctx.sql.run(`delete from note where body = 'B-1'`),
    }))
    expect(r.updated.changes).toBe(0)
    expect(r.deleted.changes).toBe(0)
    expect(await db.pg.query(`select body from app.note where body = 'B-1'`).then((x) => x.rows.length)).toBe(1)
  })

  it('RLS：他の世帯の household_id を指定した挿入は拒否される。省略すれば自分の世帯が入る', async () => {
    await withHousehold(root(), a, async (ctx) => {
      await expect(ctx.sql.tx((tx) => tx.run('insert into note (household_id, body) values (?, ?)', HOUSEHOLD_B, 'intruder'))).rejects.toThrow(
        /row-level security/,
      )
      await ctx.sql.run(`insert into note (body) values ('mine')`)
    })
    const row = await db.pg.query<{ household_id: string }>(`select household_id from app.note where body = 'mine'`)
    expect(row.rows[0].household_id).toBe(HOUSEHOLD_A)
  })

  it('soroban_api は household_member を読めない（世帯の解決は set role の前に行う）', async () => {
    await withHousehold(root(), a, async (ctx) => {
      await expect(ctx.sql.tx((tx) => tx.get('select * from household_member'))).rejects.toThrow(/permission denied/)
    })
  })

  it('世帯 A の後に世帯 B で入っても、A の文脈は持ち越さない', async () => {
    await withHousehold(root(), a, async (ctx) => {
      expect((await ctx.sql.all('select 1 from note')).length).toBe(2)
    })
    await withHousehold(root(), b, async (ctx) => {
      expect((await ctx.sql.all('select 1 from note')).length).toBe(1)
    })
  })

  it('uuid でない id は、DB に触る前に断る', async () => {
    await expect(withHousehold(root(), { householdId: "x'; drop table note; --", userId: USER_A }, async () => 1)).rejects.toThrow('uuid ではありません')
    await expect(withHousehold(root(), { householdId: HOUSEHOLD_A, userId: '' }, async () => 1)).rejects.toThrow('uuid ではありません')
  })

  it('中で入れ子の tx は savepoint になり、内側の失敗は外側を壊さない', async () => {
    await withHousehold(root(), a, async (ctx) => {
      await expect(
        ctx.sql.tx(async (tx) => {
          await tx.run(`insert into note (body) values ('inner')`)
          throw new Error('inner failed')
        }),
      ).rejects.toThrow('inner failed')
      await ctx.sql.run(`insert into note (body) values ('after')`)
    })
    const rows = await db.pg.query<{ body: string }>(`select body from app.note where body in ('inner', 'after')`)
    expect(rows.rows.map((r) => r.body)).toEqual(['after'])
  })
})
