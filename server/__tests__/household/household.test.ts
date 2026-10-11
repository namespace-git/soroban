import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createMigratedDb } from '../../test/migrate'
import { asApi, asApiWithoutHousehold, asRole, sqlstateOf } from '../schema/helpers'

// 世帯を作る関数（app.create_household）と、ユーザー → 世帯の照会（app.household_of_user）

let db: PGlite

const U1 = '00000000-0000-4000-8000-0000000000c1'
const U2 = '00000000-0000-4000-8000-0000000000c2'
const U3 = '00000000-0000-4000-8000-0000000000c3'
const U4 = '00000000-0000-4000-8000-0000000000c4'
const U5 = '00000000-0000-4000-8000-0000000000c5'
const U6 = '00000000-0000-4000-8000-0000000000c6'
const U_NOBODY = '00000000-0000-4000-8000-0000000000ff'

beforeAll(async () => {
  db = await createMigratedDb()
  await db.exec(`
    insert into auth.users (id, email) values
      ('${U1}', 'u1@example.test'), ('${U2}', 'u2@example.test'), ('${U3}', 'u3@example.test'),
      ('${U4}', 'u4@example.test'), ('${U5}', 'u5@example.test'), ('${U6}', 'u6@example.test');
  `)
})

afterAll(async () => {
  await db.close()
})

/** 他のテストの世帯に属していない、新しいユーザー（世帯の照会は「どの世帯か」を見るので、使い回さない） */
const newUser = async (): Promise<string> => {
  const id = randomUUID()
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@example.test`])
  return id
}

const createHousehold = async (name: string, owners: string[]): Promise<string> =>
  (await db.query<{ id: string }>('select app.create_household($1, $2::uuid[]) as id', [name, owners])).rows[0].id

const householdOf = async (userId: string | null): Promise<string | null> =>
  (await db.query<{ id: string | null }>('select app.household_of_user($1) as id', [userId])).rows[0].id

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ============================================================
// SQLite で新しい DB を作ったときに入る初期データ（期待値）
//   発送方法：src/main/db.ts の seedDefaults()
//   設定    ：src/main/schema.sql の INSERT OR IGNORE INTO setting
// 新しい DB に initDb(':memory:') をかけて、この 2 つ以外の表には何も入らないことを確かめて写した
// （schema_version は SQLite の migrate() の印なので Postgres には持ち込まない）
// ============================================================
const EXPECTED_SHIPPING_METHODS = [
  { name: 'ゆうパケットポストmini', carrier: 'ゆうゆうメルカリ便', fee: 180, sort_order: 1, is_active: 1 },
  { name: 'ネコポス', carrier: 'らくらくメルカリ便', fee: 210, sort_order: 2, is_active: 1 },
  { name: 'ゆうパケットポスト', carrier: 'ゆうゆうメルカリ便', fee: 215, sort_order: 3, is_active: 1 },
  { name: 'ゆうパケット', carrier: 'ゆうゆうメルカリ便', fee: 230, sort_order: 4, is_active: 1 },
  { name: '宅急便コンパクト', carrier: 'らくらくメルカリ便', fee: 520, sort_order: 5, is_active: 1 },
  { name: 'ゆうパケットプラス', carrier: 'ゆうゆうメルカリ便', fee: 520, sort_order: 6, is_active: 1 },
  { name: '宅急便 60サイズ', carrier: 'らくらくメルカリ便', fee: 750, sort_order: 7, is_active: 1 },
  { name: '送料なし・着払い', carrier: null, fee: 0, sort_order: 99, is_active: 1 },
]

const EXPECTED_SETTINGS: Array<[string, string]> = [
  ['fee_rate_bp', '1000'],
  ['fee_rate_bp_yahoo', '500'],
  ['transfer_fee', '200'],
  ['aging_warn_days', '90'],
  ['collect_interval_h', '1'],
  ['mercari_keyword', ''],
  ['yahoo_keyword', ''],
  ['auto_release_suspended', '1'],
  ['item_code_seq', '0'],
]

const byKey = (rows: Array<[string, string]>) => [...rows].sort((a, b) => a[0].localeCompare(b[0]))

const shippingMethodsOf = (hh: string) =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ name: string; carrier: string | null; fee: number; sort_order: number; is_active: number }>(
      'select name, carrier, fee, sort_order, is_active from app.shipping_method order by sort_order',
    )).rows,
  )

const settingsOf = (hh: string) =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ key: string; value: string }>('select key, value from app.setting order by key')).rows.map(
      (r): [string, string] => [r.key, r.value],
    ),
  )

describe('create_household（世帯と初期データ）', () => {
  it('世帯・持ち主（owner）・発送方法 8 行・設定 9 行が入る。数と中身は SQLite の初期データと同じ', async () => {
    const id = await createHousehold('うち', [U1, U2])
    expect(id).toMatch(UUID)

    const hh = (await db.query<{ name: string }>('select name from app.household where id = $1', [id])).rows
    expect(hh).toEqual([{ name: 'うち' }])

    const members = (await db.query<{ user_id: string; role: string }>(
      'select user_id, role from app.household_member where household_id = $1 order by user_id', [id],
    )).rows
    expect(members).toEqual([{ user_id: U1, role: 'owner' }, { user_id: U2, role: 'owner' }])

    // API と同じ入り方（soroban_api ＋世帯）で読めて、数も中身も SQLite と一致する
    const ships = await shippingMethodsOf(id)
    expect(ships).toHaveLength(8)
    expect(ships).toEqual(EXPECTED_SHIPPING_METHODS)

    const settings = await settingsOf(id)
    expect(settings).toHaveLength(9)
    expect(settings).toEqual(byKey(EXPECTED_SETTINGS))
  })

  it('初期データを入れるのは発送方法と設定だけ（SQLite の新しい DB と同じ。他の表は空）', async () => {
    const id = await createHousehold('空の世帯', [U3])
    const tables = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind = 'r' and c.relname not in ('household', 'household_member')
        order by c.relname`,
    )
    const filled: string[] = []
    for (const t of tables.rows) {
      const n = (await db.query<{ n: number }>(
        `select count(*)::int as n from app.${t.relname} where household_id = $1`, [id],
      )).rows[0].n
      if (n > 0) filled.push(t.relname)
    }
    expect(filled).toEqual(['setting', 'shipping_method'])
  })

  it('SQLite 側の初期データ（schema.sql / db.ts）と、期待値が食い違っていない', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url))

    const schemaSql = readFileSync(join(root, 'src/main/schema.sql'), 'utf8')
    const block = schemaSql.match(/INSERT OR IGNORE INTO setting \(key, value\) VALUES([^;]*);/)
    expect(block, 'schema.sql の INSERT OR IGNORE INTO setting が読めません（書き方が変わった？）').not.toBeNull()
    const sqliteSettings = [...block![1].matchAll(/\('([^']*)',\s*'([^']*)'\)/g)].map(
      (m): [string, string] => [m[1], m[2]],
    )
    expect(byKey(sqliteSettings)).toEqual(byKey(EXPECTED_SETTINGS))

    const dbTs = readFileSync(join(root, 'src/main/db.ts'), 'utf8')
    const seed = dbTs.slice(dbTs.indexOf('function seedDefaults'))
    const rowsBlock = seed.match(/const rows: Array<[^\n]*= \[([\s\S]*?)\n {2}\]/)
    expect(rowsBlock, 'db.ts の seedDefaults の rows が読めません（書き方が変わった？）').not.toBeNull()
    const sqliteShips = [...rowsBlock![1].matchAll(/\[\s*'([^']*)'\s*,\s*(null|'[^']*')\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/g)].map(
      (m) => ({
        name: m[1],
        carrier: m[2] === 'null' ? null : m[2].slice(1, -1),
        fee: Number(m[3]),
        sort_order: Number(m[4]),
        is_active: 1,
      }),
    )
    expect(sqliteShips).toEqual(EXPECTED_SHIPPING_METHODS)
  })

  it('2 つの世帯を作っても、それぞれの初期データが世帯をまたがない', async () => {
    const a = await createHousehold('世帯1', [U4])
    const b = await createHousehold('世帯2', [U5])
    expect(a).not.toBe(b)

    for (const hh of [a, b]) {
      expect(await shippingMethodsOf(hh)).toEqual(EXPECTED_SHIPPING_METHODS)
      expect(await settingsOf(hh)).toEqual(byKey(EXPECTED_SETTINGS))
    }

    // 持ち主の表の側から数えても、世帯ごとにちょうど 8 行・9 行（重なって増えていない）
    for (const hh of [a, b]) {
      const n = (await db.query<{ ships: number; settings: number; members: number }>(
        `select (select count(*) from app.shipping_method where household_id = $1)::int as ships,
                (select count(*) from app.setting where household_id = $1)::int as settings,
                (select count(*) from app.household_member where household_id = $1)::int as members`,
        [hh],
      )).rows[0]
      expect(n).toEqual({ ships: 8, settings: 9, members: 1 })
    }

    // 発送方法の id は世帯ごとに別（同じ行を共有していない）
    const ids = (await db.query<{ id: string }>(
      'select id from app.shipping_method where household_id in ($1, $2)', [a, b],
    )).rows.map((r) => r.id)
    expect(new Set(ids).size).toBe(16)

    // 片方の世帯の設定を変えても、もう片方は動かない
    await asApi(db, a, (tx) => tx.query("update app.setting set value = '800' where key = 'fee_rate_bp'"))
    const feeOfB = (await settingsOf(b)).find(([k]) => k === 'fee_rate_bp')
    expect(feeOfB).toEqual(['fee_rate_bp', '1000'])
  })

  it('同じ持ち主の id が重なっていても 1 行にまとめる', async () => {
    const id = await createHousehold('重複', [U6, U6])
    const n = (await db.query<{ n: number }>(
      'select count(*)::int as n from app.household_member where household_id = $1', [id],
    )).rows[0].n
    expect(n).toBe(1)
  })

  it('名前の前後の空白は取る', async () => {
    const id = await createHousehold('  うち  ', [U1])
    const name = (await db.query<{ name: string }>('select name from app.household where id = $1', [id])).rows[0].name
    expect(name).toBe('うち')
  })

  it('入力が不正なら何も作らない：名前が空・持ち主がいない・null が混ざる・存在しないユーザー', async () => {
    const countOf = async () =>
      (await db.query<{ h: number; s: number }>(
        `select (select count(*) from app.household)::int as h, (select count(*) from app.setting)::int as s`,
      )).rows[0]
    const before = await countOf()

    const call = (name: string | null, owners: Array<string | null> | null) =>
      db.query('select app.create_household($1, $2::uuid[])', [name, owners])

    await expect(call('  ', [U1])).rejects.toMatchObject({ code: '22023' })
    await expect(call(null, [U1])).rejects.toMatchObject({ code: '22023' })
    await expect(call('うち', [])).rejects.toMatchObject({ code: '22023' })
    await expect(call('うち', null)).rejects.toMatchObject({ code: '22023' })
    await expect(call('うち', [U1, null])).rejects.toMatchObject({ code: '22023' })
    const unknown = await call('うち', [U1, U_NOBODY]).catch((e) => e)
    expect(unknown).toMatchObject({ code: '22023' })
    expect(unknown.message).toContain(U_NOBODY)

    expect(await countOf()).toEqual(before)
  })

  it('呼んだ側のトランザクションの app.household_id を書き換えない（元の世帯のまま戻る）', async () => {
    const mine = await createHousehold('呼ぶ側', [U1])
    const seen = await db.transaction(async (tx) => {
      await tx.query("select set_config('app.household_id', $1, true)", [mine])
      await tx.query('select app.create_household($1, $2::uuid[])', ['作られる側', [U2]])
      return (await tx.query<{ hh: string }>("select current_setting('app.household_id') as hh")).rows[0].hh
    })
    expect(seen).toBe(mine)

    // 世帯をまだ決めていない接続なら、空に戻る（NULL 扱いで、どの行にも一致しない）
    const unset = await db.transaction(async (tx) => {
      await tx.query('select app.create_household($1, $2::uuid[])', ['もう 1 つ', [U2]])
      return (await tx.query<{ hh: string | null }>("select current_setting('app.household_id', true) as hh")).rows[0].hh
    })
    expect(unset === null || unset === '').toBe(true)
  })
})

describe('create_household の権限', () => {
  it('soroban_api からは呼べない（API から世帯を勝手に作れない）', async () => {
    const hh = await createHousehold('API 用', [U1])
    const code = await sqlstateOf(() =>
      asApi(db, hh, (tx) => tx.query('select app.create_household($1, $2::uuid[])', ['勝手な世帯', [U1]])),
    )
    expect(code).toBe('42501')
    // 世帯を渡さずに入っても同じ
    const code2 = await sqlstateOf(() =>
      asApiWithoutHousehold(db, (tx) => tx.query('select app.create_household($1, $2::uuid[])', ['勝手な世帯', [U1]])),
    )
    expect(code2).toBe('42501')
    expect((await db.query('select 1 from app.household where name = $1', ['勝手な世帯'])).rows).toEqual([])
  })

  it('anon / authenticated からも呼べない', async () => {
    for (const role of ['anon', 'authenticated']) {
      const code = await sqlstateOf(() =>
        asRole(db, role, (tx) => tx.query('select app.create_household($1, $2::uuid[])', ['勝手な世帯', [U1]])),
      )
      expect(code, role).toBe('42501')
    }
  })

  it('security definer で search_path が固定されている。PUBLIC に EXECUTE が残っていない', async () => {
    const { rows } = await db.query<{
      proname: string; prosecdef: boolean; proconfig: string[] | null
      api: boolean; anon: boolean; auth: boolean; public_exec: boolean
    }>(
      `select p.proname, p.prosecdef, p.proconfig,
              has_function_privilege('soroban_api', p.oid, 'execute') as api,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0) as public_exec
         from pg_proc p
        where p.pronamespace = 'app'::regnamespace and p.proname in ('create_household', 'household_of_user')
        order by p.proname`,
    )
    expect(rows.map((r) => r.proname)).toEqual(['create_household', 'household_of_user'])
    const [create, lookup] = rows
    for (const r of rows) {
      expect(r.prosecdef, r.proname).toBe(true)
      expect(r.proconfig, r.proname).toContain('search_path=app, pg_temp')
      expect(r.public_exec, r.proname).toBe(false)
      expect(r.anon, r.proname).toBe(false)
      expect(r.auth, r.proname).toBe(false)
    }
    expect(create.api).toBe(false)
    expect(lookup.api).toBe(true)
  })
})

describe('household_of_user（ユーザー → 世帯）', () => {
  it('属している世帯を返す。属していなければ null（null を渡しても null）', async () => {
    const user = await newUser()
    const id = await createHousehold('照会', [user])
    expect(await householdOf(user)).toBe(id)
    expect(await householdOf(U_NOBODY)).toBeNull()
    expect(await householdOf(null)).toBeNull()
  })

  it('soroban_api が、世帯も app.user_id も渡さずに呼べる（メンバーの表は直接読めないまま）', async () => {
    const user = await newUser()
    const id = await createHousehold('API から照会', [user])
    const got = await asApiWithoutHousehold(db, async (tx) =>
      (await tx.query<{ id: string | null }>('select app.household_of_user($1) as id', [user])).rows[0].id,
    )
    expect(got).toBe(id)

    const none = await asApiWithoutHousehold(db, async (tx) =>
      (await tx.query<{ id: string | null }>('select app.household_of_user($1) as id', [U_NOBODY])).rows[0].id,
    )
    expect(none).toBeNull()

    // 関数を通さずにメンバーの表を読んでも、ユーザーを名乗っていなければ 1 行も見えない
    const direct = await asApiWithoutHousehold(db, async (tx) =>
      (await tx.query('select * from app.household_member')).rows,
    )
    expect(direct).toEqual([])
  })

  it('呼んだ側の app.user_id / app.household_id を書き換えない', async () => {
    const caller = await newUser()
    const target = await newUser()
    const mine = await createHousehold('呼ぶ側', [caller])
    const other = await createHousehold('引かれる側', [target])
    const seen = await asApi(db, mine, async (tx) => {
      const got = (await tx.query<{ id: string }>('select app.household_of_user($1) as id', [target])).rows[0].id
      const cfg = (await tx.query<{ hh: string; u: string }>(
        "select current_setting('app.household_id') as hh, current_setting('app.user_id') as u",
      )).rows[0]
      return { got, ...cfg }
    }, { userId: caller })
    expect(seen).toEqual({ got: other, hh: mine, u: caller })
  })

  it('2 つの世帯に属していたら、作成日の古い方を返す', async () => {
    const user = await newUser()
    const older = await createHousehold('古い方', [user])
    const newer = await createHousehold('新しい方', [user])
    expect(await householdOf(user)).toBe(older)

    // 作成日を入れ替えると、答えも入れ替わる（挿入順や id の大小で決めていない）
    await db.query(`update app.household set created_at = now() - interval '2 days' where id = $1`, [newer])
    await db.query(`update app.household set created_at = now() - interval '1 day' where id = $1`, [older])
    expect(await householdOf(user)).toBe(newer)
  })

  it('anon / authenticated は呼べない', async () => {
    const code = await sqlstateOf(() => asRole(db, 'anon', (tx) => tx.query('select app.household_of_user($1)', [U1])))
    expect(code).toBe('42501')
    const code2 = await sqlstateOf(() => asRole(db, 'authenticated', (tx) => tx.query('select app.household_of_user($1)', [U1])))
    expect(code2).toBe('42501')
  })
})

describe('関数の持ち主が RLS を素通りできない環境でも動く', () => {
  it('持ち主（表も関数も）が BYPASSRLS を持たなくても、create_household と household_of_user が通る', async () => {
    // Supabase の postgres は BYPASSRLS を持つが、持たない環境でも手順書の 1 行が通ることを確かめる。
    // 表と関数の持ち主を BYPASSRLS の無いロールに替えて（このトランザクションの中だけ。最後にロールバック）呼ぶ
    const probeUser = '00000000-0000-4000-8000-0000000000d1'
    const result = await db
      .transaction(async (tx) => {
        await tx.query('create role definer_probe nologin nosuperuser nobypassrls')
        await tx.query('grant usage on schema app to definer_probe')
        await tx.query('grant usage on schema auth to definer_probe')
        await tx.query('grant select on auth.users to definer_probe')
        for (const t of ['household', 'household_member', 'shipping_method', 'setting']) {
          await tx.query(`alter table app.${t} owner to definer_probe`)
        }
        await tx.query('alter function app.create_household(text, uuid[]) owner to definer_probe')
        await tx.query('alter function app.household_of_user(uuid) owner to definer_probe')
        await tx.query(`insert into auth.users (id, email) values ($1, 'probe@example.test')`, [probeUser])

        // 対照：持ち主のロールで直接 insert すると、force row level security で拒否される
        await tx.query('savepoint control')
        let control: string | null = null
        try {
          await tx.query('set local role definer_probe')
          await tx.query(`insert into app.household (name) values ('直接')`)
        } catch (e) {
          control = (e as { code?: string }).code ?? 'unknown'
        }
        await tx.query('rollback to savepoint control')

        const id = (await tx.query<{ id: string }>(
          `select app.create_household('probe', array[$1]::uuid[]) as id`, [probeUser],
        )).rows[0].id
        const counts = (await tx.query<{ ships: number; settings: number; members: number }>(
          `select (select count(*) from app.shipping_method where household_id = $1)::int as ships,
                  (select count(*) from app.setting where household_id = $1)::int as settings,
                  (select count(*) from app.household_member where household_id = $1)::int as members`,
          [id],
        )).rows[0]
        const looked = (await tx.query<{ id: string | null }>('select app.household_of_user($1) as id', [probeUser])).rows[0].id

        throw Object.assign(new Error('rollback'), { probe: { control, id, counts, looked } })
      })
      .catch((e: { probe?: { control: string | null; id: string; counts: unknown; looked: string | null } }) => e.probe)

    expect(result).toBeDefined()
    expect(result!.control).toBe('42501')
    expect(result!.counts).toEqual({ ships: 8, settings: 9, members: 1 })
    expect(result!.looked).toBe(result!.id)

    // ロールバックされて、元の持ち主に戻っている
    const owner = await db.query<{ owner: string }>(
      `select pg_get_userbyid(proowner) as owner from pg_proc where proname = 'create_household' and pronamespace = 'app'::regnamespace`,
    )
    expect(owner.rows[0].owner).toBe('postgres')
  })
})
