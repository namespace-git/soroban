import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { withHousehold } from '../../context'
import { fromPgClient, type PgClientLike, type PgQueryConfig } from '../../db/postgres'
import { DRIVER_NAMES, HOUSEHOLD_A, HOUSEHOLD_B, USER_A, USER_B, openTestDb, type TestDb } from './helpers'

// withHousehold が入ってすぐに流す設定（search_path・role・app.household_id・app.user_id）は、1 本の select にまとめてある
// （server/context.ts の ENTER_HOUSEHOLD_SQL）。まとめたあとも安全であることの確認：
//   (a) トランザクションの中では current_user が soroban_api
//   (b) RLS が効いて、別の世帯の行は見えない
//   (c) commit のあとも rollback のあとも、同じ接続で role・search_path・app.* が元に戻る（次の人に残らない）
// context.test.ts が基本の動きを見ているので、ここは「元に戻ること」を厳しく（接続の状態を丸ごと比べて）見る。
//
// テストの DB は 1 本の PGlite（node-postgres 経由でも、ブリッジで同じ 1 本につながる）。
// つまり withHousehold のあとに流す最初のクエリは、必ず直前の接続の状態をそのまま受ける＝漏れていれば見える。

let db: TestDb
let baseline: Probe

/** 接続の状態を丸ごと 1 行で読む。role は `set role` の状態（切り替えていなければ 'none'） */
const PROBE = `select current_user as who, session_user as sess, current_setting('role') as role,
  current_setting('search_path') as sp,
  nullif(current_setting('app.household_id', true), '') as hh,
  nullif(current_setting('app.user_id', true), '') as uu`

interface Probe {
  who: string
  sess: string
  role: string
  sp: string
  hh: string | null
  uu: string | null
}

beforeAll(async () => {
  db = await openTestDb()
  baseline = (await db.pg.query<Probe>(PROBE)).rows[0]
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.pg.exec('truncate app.note')
  await db.pg.query(`insert into app.note (household_id, body) values ($1, 'A-1'), ($1, 'A-2'), ($2, 'B-1')`, [HOUSEHOLD_A, HOUSEHOLD_B])
})

describe('入る前の接続の状態', () => {
  it('基準：soroban_api ではなく、role は切り替わっておらず、世帯の設定は無い', () => {
    expect(baseline.who).not.toBe('soroban_api')
    expect(baseline.role).toBe('none')
    expect(baseline.hh).toBeNull()
    expect(baseline.uu).toBeNull()
    expect(baseline.sp).not.toBe('app, public')
  })
})

describe('トランザクションの頭は 1 本の select（往復を減らす）', () => {
  // pg の Client の偽物。1 本の接続に、どの SQL がどんな引数で流れたかを順に記録する
  function recordingClient() {
    const log: Array<{ text: string; params?: unknown[] }> = []
    const client: PgClientLike = {
      connect: async () => {},
      query: async (config: PgQueryConfig) => {
        log.push({ text: config.text, params: config.values })
        return { rows: [{}], rowCount: 1 }
      },
      end: async () => {},
      on: () => client,
    }
    return { client, log }
  }

  it('begin のあと、世帯の設定は select 1 本だけ。そのあとに fn の SQL が続き、最後に commit', async () => {
    const { client, log } = recordingClient()
    await withHousehold(fromPgClient(client), { householdId: HOUSEHOLD_A, userId: USER_A }, async (ctx) => {
      await ctx.sql.get('select 1 as marker')
    })
    expect(log.map((l) => l.text.slice(0, 20))).toEqual(['begin', "select set_config('s", 'select 1 as marker', 'commit'])
  })

  it('その 1 本は、search_path・role・app.household_id・app.user_id を、すべて local（第 3 引数 true）で設定する', async () => {
    const { client, log } = recordingClient()
    await withHousehold(fromPgClient(client), { householdId: HOUSEHOLD_B, userId: USER_B }, async () => {})
    const enter = log[1]
    // 引数は世帯と人の 2 つだけ（search_path と role は固定の文字列）。uuid は小文字にそろえて渡る
    expect(enter.params).toEqual([HOUSEHOLD_B, USER_B])
    expect(enter.text).toContain("set_config('search_path', 'app, public', true)")
    expect(enter.text).toContain("set_config('role', 'soroban_api', true)")
    expect(enter.text).toContain("set_config('app.household_id', $1, true)")
    expect(enter.text).toContain("set_config('app.user_id', $2, true)")
    // どの set_config も true（local）。false（セッション全体）は 1 つも無い
    expect(enter.text.match(/set_config\(/g)).toHaveLength(4)
    expect(enter.text.match(/, true\)/g)).toHaveLength(4)
    expect(enter.text).not.toMatch(/\bfalse\b/i)
    // 別の文で流す set（local あり・なし）は残っていない
    expect(log.some((l) => /^\s*set\b/i.test(l.text))).toBe(false)
  })

  it('uuid でない id は、begin する前に断る（DB に何も流さない）', async () => {
    const { client, log } = recordingClient()
    await expect(withHousehold(fromPgClient(client), { householdId: "x'); select 1; --", userId: USER_A }, async () => 1)).rejects.toThrow(
      'uuid ではありません',
    )
    expect(log).toEqual([])
  })
})

describe.each(DRIVER_NAMES)('まとめたあとの安全性: %s', (name) => {
  const root = () => db.drivers.find((d) => d.name === name)!.sql
  const a = { householdId: HOUSEHOLD_A, userId: USER_A }
  const b = { householdId: HOUSEHOLD_B, userId: USER_B }
  const probe = () => root().get<Probe>(PROBE)

  it('(a) 中では current_user・role・search_path・app.household_id・app.user_id が、その世帯のもの。session_user は変わらない', async () => {
    const inside = await withHousehold(root(), a, (ctx) => ctx.sql.get<Probe>(PROBE))
    expect(inside).toEqual({ who: 'soroban_api', sess: baseline.sess, role: 'soroban_api', sp: 'app, public', hh: HOUSEHOLD_A, uu: USER_A })
  })

  it('(b) RLS：SQL に絞り込みが無くても自分の世帯の行だけ。他の世帯には更新も挿入もできない', async () => {
    const seen = await withHousehold(root(), a, (ctx) => ctx.sql.all<{ body: string }>('select body from note order by body'))
    expect(seen.map((r) => r.body)).toEqual(['A-1', 'A-2'])
    await withHousehold(root(), b, async (ctx) => {
      expect((await ctx.sql.all<{ body: string }>('select body from note')).map((r) => r.body)).toEqual(['B-1'])
      expect((await ctx.sql.run(`update note set body = 'x' where body like 'A-%'`)).changes).toBe(0)
      await expect(ctx.sql.tx((tx) => tx.run('insert into note (household_id, body) values (?, ?)', HOUSEHOLD_A, 'intruder'))).rejects.toThrow(
        /row-level security/,
      )
    })
    expect((await db.pg.query(`select 1 from app.note where body in ('x', 'intruder')`)).rows).toHaveLength(0)
  })

  it('(c) commit のあと、同じ接続の状態が入る前と全く同じに戻る', async () => {
    await withHousehold(root(), a, async (ctx) => {
      await ctx.sql.run(`insert into note (body) values ('committed')`)
    })
    expect(await probe()).toEqual(baseline)
    // role が戻っている証拠：接続ロール（RLS を飛び越える側）に戻っているので、全世帯の行が見える
    expect((await root().all<{ body: string }>('select body from app.note order by body')).map((r) => r.body)).toEqual([
      'A-1', 'A-2', 'B-1', 'committed',
    ])
  })

  it('(c) 例外でロールバックされたあとも、元に戻る', async () => {
    await expect(
      withHousehold(root(), a, async (ctx) => {
        await ctx.sql.run(`insert into note (body) values ('rolled back')`)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await probe()).toEqual(baseline)
    expect(await root().get('select 1 from app.note where body = ?', 'rolled back')).toBeUndefined()
  })

  it('(c) SQL のエラー（トランザクションが中断した状態）でロールバックされたあとも、元に戻る', async () => {
    await expect(withHousehold(root(), a, (ctx) => ctx.sql.get('select 1 / 0'))).rejects.toThrow(/division by zero/)
    expect(await probe()).toEqual(baseline)
  })

  it('(c) 入れ子（savepoint）の失敗を握って続け、commit したあとも、元に戻る', async () => {
    await withHousehold(root(), a, async (ctx) => {
      await expect(
        ctx.sql.tx(async (tx) => {
          await tx.run(`insert into note (body) values ('inner')`)
          throw new Error('inner failed')
        }),
      ).rejects.toThrow('inner failed')
      // savepoint を巻き戻しても、世帯の文脈は外側の設定のまま
      expect(await ctx.sql.get<Probe>(PROBE)).toMatchObject({ who: 'soroban_api', hh: HOUSEHOLD_A, uu: USER_A })
    })
    expect(await probe()).toEqual(baseline)
  })

  it('(c) 世帯 A（commit）→ A（rollback）→ B（commit）と続けても、前の文脈を持ち越さず、毎回元に戻る', async () => {
    const seen: Array<Pick<Probe, 'who' | 'hh' | 'uu'>> = []
    const enter = async (ids: typeof a, fail: boolean) => {
      const run = withHousehold(root(), ids, async (ctx) => {
        const p = (await ctx.sql.get<Probe>(PROBE))!
        seen.push({ who: p.who, hh: p.hh, uu: p.uu })
        if (fail) throw new Error('fail')
      })
      await (fail ? expect(run).rejects.toThrow('fail') : run)
      expect(await probe()).toEqual(baseline)
    }
    await enter(a, false)
    await enter(a, true)
    await enter(b, false)
    await enter(b, true)
    await enter(a, false)
    expect(seen).toEqual([
      { who: 'soroban_api', hh: HOUSEHOLD_A, uu: USER_A },
      { who: 'soroban_api', hh: HOUSEHOLD_A, uu: USER_A },
      { who: 'soroban_api', hh: HOUSEHOLD_B, uu: USER_B },
      { who: 'soroban_api', hh: HOUSEHOLD_B, uu: USER_B },
      { who: 'soroban_api', hh: HOUSEHOLD_A, uu: USER_A },
    ])
  })

  it('(c) コミット後の後始末（afterCommit）が走る時点で、すでに接続の状態は元に戻っている', async () => {
    let afterCommit: Probe | undefined
    await withHousehold(root(), a, async (ctx) => {
      ctx.afterCommit(async () => {
        afterCommit = await probe()
      })
    })
    expect(afterCommit).toEqual(baseline)
  })
})
