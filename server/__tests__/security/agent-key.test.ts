import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMigratedDb } from '../../test/migrate'
import { addSecondMemberToA, sha256hex, USER_A2 } from '../wave3/helpers'
import { asApi, HH_A, HH_B, seedHouseholds, sqlstateOf, USER_A, USER_B } from './helpers'

// 取り込み担当の鍵の締め直し（20261012001900）：
//   * agent_of_token … 鍵を作った人が「いまも」その世帯のメンバーのときだけ引ける。last_seen_at は 1 分に 1 回まで
//   * メンバーから外した人が登録した PC は、トリガーで取り消す
//   * register_agent_device … 生きている同じ名前は同じ人だけが取り直せる（SB008）／取り消されていない PC は 10 台まで（SB009）

let db: PGlite

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec('delete from app.agent_device')
  // 前のテストが足した・外したメンバーを戻す：2 人目（USER_A2）はどの世帯にもいない状態、USER_A は世帯 A のメンバー
  await db.query(`insert into auth.users (id, email) values ($1, 'a2@example.test') on conflict do nothing`, [USER_A2])
  await db.query('delete from app.household_member where user_id = $1', [USER_A2])
  await db.query(
    `insert into app.household_member (household_id, user_id, role) values ($1, $2, 'owner') on conflict do nothing`, [HH_A, USER_A])
  await db.exec('delete from app.agent_device')
})

interface Device {
  id: string
  household_id: string
  name: string
  token_expires_at: string
  last_seen_at: string
  revoked_at: string | null
  registered_by: string | null
}

const register = (hh: string, userId: string, name: string, token: string, expires = '2 hours') =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ d: Device }>(
      `select to_jsonb(app.register_agent_device($1, $2, now() + $3::interval)) as d`,
      [name, sha256hex(token), expires],
    )).rows[0].d, { userId })

/** API が set role の前に呼ぶ形（接続したロールのまま、鍵のハッシュで引く） */
const lookup = async (token: string): Promise<Array<{ agent_id: string; household_id: string }>> =>
  (await db.query<{ agent_id: string; household_id: string }>(
    'select agent_id, household_id from app.agent_of_token($1)', [sha256hex(token)],
  )).rows

const row = async (id: string): Promise<Device> =>
  (await db.query<Device>('select * from app.agent_device where id = $1', [id])).rows[0]

const msOf = (t: string): number => new Date(t).getTime()

describe('agent_of_token：鍵を作った人が、いまもメンバーのときだけ引ける', () => {
  it('メンバーなら引ける。メンバーから外すと引けなくなる（期限内でも）', async () => {
    const d = await register(HH_A, USER_A, 'PC', 'tok')
    expect(await lookup('tok')).toEqual([{ agent_id: d.id, household_id: HH_A }])

    await db.query('delete from app.household_member where household_id = $1 and user_id = $2', [HH_A, USER_A])
    expect(await lookup('tok')).toEqual([])
  })

  it('メンバーの確認はトリガーに頼らない：トリガーを止めてメンバーを外しても、鍵は引けない', async () => {
    const d = await register(HH_A, USER_A, 'PC', 'tok')
    await db.exec('alter table app.household_member disable trigger trg_household_member_revoke_agents')
    try {
      await db.query('delete from app.household_member where household_id = $1 and user_id = $2', [HH_A, USER_A])
      expect((await row(d.id)).revoked_at).toBeNull() // トリガーは働いていない
      expect(await lookup('tok')).toEqual([])
    } finally {
      await db.exec('alter table app.household_member enable trigger trg_household_member_revoke_agents')
    }
  })

  it('registered_by が null の鍵（作った人のアカウントが消えた・古い行）は引けない', async () => {
    const d = await register(HH_A, USER_A, 'PC', 'tok')
    expect(await lookup('tok')).toHaveLength(1)
    await db.query('update app.agent_device set registered_by = null where id = $1', [d.id])
    expect(await lookup('tok')).toEqual([])
  })

  it('別の世帯のメンバーであっても、その世帯の鍵は引けない（世帯とユーザーの組で見る）', async () => {
    const d = await register(HH_A, USER_A, 'PC', 'tok')
    // 鍵を作った人を、世帯 B だけのメンバー（USER_B）にすげ替える
    await db.query('update app.agent_device set registered_by = $2 where id = $1', [d.id, USER_B])
    expect(await lookup('tok')).toEqual([])
  })

  it('2 人目のメンバーが作った鍵は、その人が外れたら引けないが、1 人目の鍵は引けたまま', async () => {
    await addSecondMemberToA(db)
    const first = await register(HH_A, USER_A, 'PC-1', 'tok-1')
    const second = await register(HH_A, USER_A2, 'PC-2', 'tok-2')
    expect(await lookup('tok-1')).toHaveLength(1)
    expect(await lookup('tok-2')).toHaveLength(1)

    await db.query('delete from app.household_member where household_id = $1 and user_id = $2', [HH_A, USER_A2])
    expect(await lookup('tok-1')).toEqual([{ agent_id: first.id, household_id: HH_A }])
    expect(await lookup('tok-2')).toEqual([])
    expect((await row(second.id)).revoked_at).not.toBeNull()
  })

  it('照会に使う内部の設定（app.agent_token_hash・app.user_id・app.household_id）は、終わったら呼ぶ前の値に戻る', async () => {
    await register(HH_A, USER_A, 'PC', 'tok')
    const after = await db.transaction(async (tx) => {
      await tx.query(
        "select set_config('app.agent_token_hash', 'before-hash', true), set_config('app.user_id', 'before-user', true), set_config('app.household_id', 'before-hh', true)")
      await tx.query('select * from app.agent_of_token($1)', [sha256hex('tok')])
      return (await tx.query<{ h: string; u: string; g: string }>(
        `select current_setting('app.agent_token_hash', true) as h, current_setting('app.user_id', true) as u,
                current_setting('app.household_id', true) as g`)).rows[0]
    })
    expect(after).toEqual({ h: 'before-hash', u: 'before-user', g: 'before-hh' })
  })
})

describe('last_seen_at は 1 分に 1 回まで', () => {
  it('1 分以内なら書かない。1 分より古ければ書く。引けない鍵では書かない', async () => {
    const d = await register(HH_A, USER_A, 'PC', 'tok')

    // 30 秒前：書かない（形だけ正しい鍵を続けて送られても UPDATE が走らない）
    await db.query(`update app.agent_device set last_seen_at = now() - interval '30 seconds' where id = $1`, [d.id])
    const recent = msOf((await row(d.id)).last_seen_at)
    expect(await lookup('tok')).toHaveLength(1)
    expect(msOf((await row(d.id)).last_seen_at)).toBe(recent)

    // 2 分前：書く
    await db.query(`update app.agent_device set last_seen_at = now() - interval '2 minutes' where id = $1`, [d.id])
    const old = msOf((await row(d.id)).last_seen_at)
    expect(await lookup('tok')).toHaveLength(1)
    expect(msOf((await row(d.id)).last_seen_at)).toBeGreaterThan(old + 100_000)

    // 引けない鍵（期限切れ・メンバーでなくなった・知らない鍵）では書かない
    await db.query(`update app.agent_device set last_seen_at = now() - interval '2 hours', token_expires_at = now() - interval '1 second' where id = $1`, [d.id])
    const stale = msOf((await row(d.id)).last_seen_at)
    expect(await lookup('tok')).toEqual([])
    expect(await lookup('tok-unknown')).toEqual([])
    expect(msOf((await row(d.id)).last_seen_at)).toBe(stale)

    await db.query(`update app.agent_device set last_seen_at = now() - interval '2 hours', token_expires_at = now() + interval '1 hour' where id = $1`, [d.id])
    await db.query('delete from app.household_member where household_id = $1 and user_id = $2', [HH_A, USER_A])
    const gone = msOf((await row(d.id)).last_seen_at)
    expect(await lookup('tok')).toEqual([])
    expect(msOf((await row(d.id)).last_seen_at)).toBe(gone)
  })
})

describe('メンバーから外した人の PC を取り消す（トリガー）', () => {
  it('その人が登録した PC だけ、revoked_at が入る。ほかの人の PC・他の世帯の PC はそのまま', async () => {
    await addSecondMemberToA(db)
    const mine = await register(HH_A, USER_A, 'PC-A', 'tok-a')
    const theirs = await register(HH_A, USER_A2, 'PC-A2', 'tok-a2')
    const other = await register(HH_B, USER_B, 'PC-B', 'tok-b')

    await db.query('delete from app.household_member where household_id = $1 and user_id = $2', [HH_A, USER_A2])
    expect((await row(theirs.id)).revoked_at).not.toBeNull()
    expect((await row(mine.id)).revoked_at).toBeNull()
    expect((await row(other.id)).revoked_at).toBeNull()
  })

  it('同じ人が 2 つの世帯にいるとき、外れた世帯の PC だけ取り消す', async () => {
    await addSecondMemberToA(db)
    await db.query(`insert into app.household_member (household_id, user_id) values ($1, $2)`, [HH_B, USER_A2])
    const inA = await register(HH_A, USER_A2, 'PC', 'tok-a2')
    const inB = await register(HH_B, USER_A2, 'PC', 'tok-b2')

    await db.query('delete from app.household_member where household_id = $1 and user_id = $2', [HH_A, USER_A2])
    expect((await row(inA.id)).revoked_at).not.toBeNull()
    expect((await row(inB.id)).revoked_at).toBeNull()
    expect(await lookup('tok-b2')).toEqual([{ agent_id: inB.id, household_id: HH_B }])
    await db.query('delete from app.household_member where user_id = $1', [USER_A2])
  })

  it('取り消し済みの時刻は上書きしない。取り消された PC には、同じ名前で鍵を出せない（SB006）', async () => {
    await addSecondMemberToA(db)
    const d = await register(HH_A, USER_A2, 'PC', 'tok')
    await db.query(`update app.agent_device set revoked_at = now() - interval '1 day' where id = $1`, [d.id])
    const before = msOf((await row(d.id)).revoked_at!)
    await db.query('delete from app.household_member where household_id = $1 and user_id = $2', [HH_A, USER_A2])
    expect(msOf((await row(d.id)).revoked_at!)).toBe(before)

    // その人が世帯に戻っても、取り消された PC は戻らない（別の名前で取り直す）
    await addSecondMemberToA(db)
    await expect(register(HH_A, USER_A2, 'PC', 'tok-2')).rejects.toMatchObject({ code: 'SB006' })
    await expect(register(HH_A, USER_A2, 'PC その 2', 'tok-3')).resolves.toMatchObject({ revoked_at: null })
  })

  it('メンバーを外した人のアカウントを消しても（auth.users の cascade）、PC は鍵を引けない', async () => {
    const userC = '00000000-0000-4000-8000-0000000000c9'
    await db.query(`insert into auth.users (id, email) values ($1, 'c9@example.test')`, [userC])
    await db.query(`insert into app.household_member (household_id, user_id) values ($1, $2)`, [HH_A, userC])
    await register(HH_A, userC, 'PC', 'tok')
    expect(await lookup('tok')).toHaveLength(1)
    await db.query('delete from auth.users where id = $1', [userC])
    expect(await lookup('tok')).toEqual([])
  })

  it('トリガーは呼んだ側の app.household_id を書き換えない', async () => {
    await addSecondMemberToA(db)
    const seen = await db.transaction(async (tx) => {
      await tx.query("select set_config('app.household_id', 'caller-hh', true)")
      await tx.query('delete from app.household_member where household_id = $1 and user_id = $2', [HH_A, USER_A2])
      return (await tx.query<{ g: string }>("select current_setting('app.household_id', true) as g")).rows[0].g
    })
    expect(seen).toBe('caller-hh')
  })

  it('トリガー関数は soroban_api から呼べない（トリガーとしてだけ働く）', async () => {
    const { rows } = await db.query<{ prosecdef: boolean; api: boolean; gateway: boolean; cron: boolean; anon: boolean; auth: boolean; public_exec: boolean }>(
      `select p.prosecdef,
              has_function_privilege('soroban_api', p.oid, 'execute') as api,
              has_function_privilege('soroban_gateway', p.oid, 'execute') as gateway,
              has_function_privilege('soroban_cron', p.oid, 'execute') as cron,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0) as public_exec
         from pg_proc p where p.pronamespace = 'app'::regnamespace and p.proname = 'revoke_agents_of_removed_member'`)
    expect(rows).toEqual([{ prosecdef: true, api: false, gateway: false, cron: false, anon: false, auth: false, public_exec: false }])
  })
})

describe('register_agent_device：同じ名前を取り直せるのは同じ人（SB008）', () => {
  it('鍵が生きている間は、別の人は同じ名前の PC に鍵を出せない。鍵も差し替わらない', async () => {
    await addSecondMemberToA(db)
    const d = await register(HH_A, USER_A, 'リビングの PC', 'tok-a')
    const err = await register(HH_A, USER_A2, 'リビングの PC', 'tok-a2').catch((e) => e)
    expect(err).toMatchObject({ code: 'SB008' })
    expect(err.message).toContain('ほかの人のログインで使われています')
    expect((await row(d.id)).registered_by).toBe(USER_A)
    expect(await lookup('tok-a')).toHaveLength(1)
    expect(await lookup('tok-a2')).toEqual([])
    // 別の名前なら出せる
    await expect(register(HH_A, USER_A2, '寝室の PC', 'tok-a2')).resolves.toMatchObject({ registered_by: USER_A2 })
  })

  it('同じ人は取り直せる（生きている鍵でも）', async () => {
    const first = await register(HH_A, USER_A, 'PC', 'tok-1')
    const second = await register(HH_A, USER_A, 'PC', 'tok-2')
    expect(second.id).toBe(first.id)
    expect(await lookup('tok-1')).toEqual([])
    expect(await lookup('tok-2')).toHaveLength(1)
  })

  it('鍵の期限が切れていれば（ログアウトで期限を今にした場合も）、別の人が取り直せて、持ち主はその人に替わる', async () => {
    await addSecondMemberToA(db)
    const d = await register(HH_A, USER_A, 'PC', 'tok-a')
    await db.query(`update app.agent_device set token_expires_at = now() - interval '1 second' where id = $1`, [d.id])
    const taken = await register(HH_A, USER_A2, 'PC', 'tok-a2')
    expect(taken.id).toBe(d.id)
    expect(taken.registered_by).toBe(USER_A2)
    expect(await lookup('tok-a')).toEqual([])
    expect(await lookup('tok-a2')).toHaveLength(1)
  })

  it('作った人が分からない（registered_by が null の）行は、鍵が生きていても誰でも取り直せる（その鍵はもう引けないため）', async () => {
    const d = await register(HH_A, USER_A, 'PC', 'tok-a')
    await db.query('update app.agent_device set registered_by = null where id = $1', [d.id])
    await expect(register(HH_A, USER_A, 'PC', 'tok-b')).resolves.toMatchObject({ id: d.id, registered_by: USER_A })
  })

  it('取り消された PC には、期限が切れていても鍵を出さない（SB006）。SB008 より先に判定する', async () => {
    await addSecondMemberToA(db)
    const d = await register(HH_A, USER_A, 'PC', 'tok')
    await db.query(`update app.agent_device set revoked_at = now() where id = $1`, [d.id])
    await expect(register(HH_A, USER_A2, 'PC', 'tok-2')).rejects.toMatchObject({ code: 'SB006' })
  })
})

describe('register_agent_device：取り消されていない PC は世帯ごとに 10 台まで（SB009）', () => {
  const fill = async (hh: string, userId: string, n: number): Promise<Device[]> => {
    const out: Device[] = []
    for (let i = 1; i <= n; i++) out.push(await register(hh, userId, `PC ${i}`, `${hh}-tok-${i}`))
    return out
  }

  it('10 台までは作れて、11 台目は SB009。同じ名前の取り直しは台数を増やさないので通る', async () => {
    const all = await fill(HH_A, USER_A, 10)
    const err = await register(HH_A, USER_A, 'PC 11', 'tok-11').catch((e) => e)
    expect(err).toMatchObject({ code: 'SB009' })
    expect(err.message).toContain('10 台まで')
    expect((await db.query<{ n: number }>('select count(*)::int as n from app.agent_device where household_id = $1', [HH_A])).rows[0].n).toBe(10)

    // 10 台目の取り直し
    const again = await register(HH_A, USER_A, 'PC 10', 'tok-10-again')
    expect(again.id).toBe(all[9].id)
  })

  it('取り消した PC は数えない（外せば、新しい PC を足せる）。他の世帯の台数には影響しない', async () => {
    const all = await fill(HH_A, USER_A, 10)
    await db.query(`update app.agent_device set revoked_at = now() where id = $1`, [all[0].id])
    await expect(register(HH_A, USER_A, 'PC 11', 'tok-11')).resolves.toBeDefined()
    expect(await sqlstateOf(() => register(HH_A, USER_A, 'PC 12', 'tok-12'))).toBe('SB009')

    // 世帯 B は別に数える
    await expect(register(HH_B, USER_B, 'PC 1', 'tok-b-1')).resolves.toBeDefined()
  })
})
