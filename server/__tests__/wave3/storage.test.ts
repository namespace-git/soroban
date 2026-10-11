import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMigratedDb, listMigrations } from '../../test/migrate'
import { asApi, asAuthenticated, HH_A, HH_B, seedHouseholds, sqlstateOf, USER_A, USER_B } from './helpers'

// 画像の置き場（20261012001530_storage.sql）。バケット media（公開）・receipts（非公開）と、
// storage.objects の方針：authenticated が、パスの先頭のフォルダが自分の世帯の id のときだけ
// 上げる・読む・消せる。PGlite には storage スキーマが無いので、server/test/migrate.ts のスタブの上で確かめる
// （スタブの storage.foldername() と auth.uid() は本物の定義と同じ）

let db: PGlite

// どの世帯にも属さない人
const USER_NOBODY = '00000000-0000-4000-8000-0000000000f1'

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
  await db.query(`insert into auth.users (id, email) values ($1, 'nobody@example.test')`, [USER_NOBODY])
  await db.exec(`insert into storage.buckets (id, name, public) values ('other', 'other', false)`)
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec('delete from storage.objects')
})

const put = (userId: string | null, bucket: string, name: string, role: 'authenticated' | 'anon' = 'authenticated') =>
  asAuthenticated(db, userId, (tx) => tx.query('insert into storage.objects (bucket_id, name) values ($1, $2)', [bucket, name]), role)

const names = (userId: string | null, bucket: string, role: 'authenticated' | 'anon' = 'authenticated') =>
  asAuthenticated(db, userId, async (tx) =>
    (await tx.query<{ name: string }>('select name from storage.objects where bucket_id = $1 order by name', [bucket])).rows.map((r) => r.name), role)

const remove = (userId: string | null, bucket: string, name: string) =>
  asAuthenticated(db, userId, async (tx) =>
    (await tx.query('delete from storage.objects where bucket_id = $1 and name = $2', [bucket, name])).affectedRows)

/** 持ち主のロールで置く（方針を受けない。他の世帯のファイルを用意する用） */
const seed = (bucket: string, name: string) =>
  db.query('insert into storage.objects (bucket_id, name) values ($1, $2)', [bucket, name])

describe('バケット', () => {
  it('media は公開、receipts は非公開', async () => {
    const { rows } = await db.query<{ id: string; name: string; public: boolean }>(
      `select id, name, public from storage.buckets where id in ('media', 'receipts') order by id`,
    )
    expect(rows).toEqual([
      { id: 'media', name: 'media', public: true },
      { id: 'receipts', name: 'receipts', public: false },
    ])
  })

  it('マイグレーションを流し直しても（on conflict do nothing）バケットは増えず、設定も変わらない', async () => {
    await db.exec(`update storage.buckets set file_size_limit = 1000 where id = 'media'`)
    const migration = listMigrations().find((m) => m.name.endsWith('_storage.sql'))!
    const insert = migration.sql.match(/insert into storage\.buckets[\s\S]*?on conflict do nothing;/)
    expect(insert).not.toBeNull()
    await db.exec(insert![0])
    const { rows } = await db.query<{ id: string; file_size_limit: string | number | null }>(
      `select id, file_size_limit from storage.buckets where id in ('media', 'receipts') order by id`)
    expect(rows).toHaveLength(2)
    expect(Number(rows[0].file_size_limit)).toBe(1000)
  })
})

describe('app.my_household()', () => {
  it('引数を取らない・security definer・search_path が固定。authenticated だけが実行できる（anon・PUBLIC・soroban_cron は不可）', async () => {
    const { rows } = await db.query<{
      pronargs: number; prosecdef: boolean; proconfig: string[] | null; auth: boolean; anon: boolean; api: boolean; cron: boolean; public_exec: boolean
    }>(
      `select p.pronargs, p.prosecdef, p.proconfig,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('soroban_api', p.oid, 'execute') as api,
              has_function_privilege('soroban_cron', p.oid, 'execute') as cron,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0) as public_exec
         from pg_proc p where p.pronamespace = 'app'::regnamespace and p.proname = 'my_household'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].pronargs).toBe(0)
    expect(rows[0].prosecdef).toBe(true)
    expect(rows[0].proconfig).toContain('search_path=app, pg_temp')
    expect(rows[0]).toMatchObject({ auth: true, anon: false, cron: false, public_exec: false })
  })

  // 接続したロール（postgres）のまま、JWT の sub だけを渡して呼ぶ（関数の中身の確認）
  const whoAmI = (userId: string | null) =>
    db.transaction(async (tx) => {
      if (userId) await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId])
      return (await tx.query<{ h: string | null }>('select app.my_household() as h')).rows[0].h
    })

  it('JWT の人の世帯を返す。世帯に属さない人・JWT なしは null', async () => {
    expect(await whoAmI(USER_A)).toBe(HH_A)
    expect(await whoAmI(USER_B)).toBe(HH_B)
    expect(await whoAmI(USER_NOBODY)).toBeNull()
    expect(await whoAmI(null)).toBeNull()
  })

  it('引数が無いので、他人の世帯は調べられない。呼んだ後も app.household_id・app.user_id は呼ぶ前のまま', async () => {
    const r = await db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [USER_A])
      await tx.query("select set_config('app.household_id', 'sentinel', true)")
      await tx.query("select set_config('app.user_id', 'sentinel-user', true)")
      await tx.query('select app.my_household()')
      return (await tx.query<{ h: string; u: string }>(
        "select current_setting('app.household_id', true) as h, current_setting('app.user_id', true) as u")).rows[0]
    })
    expect(r).toEqual({ h: 'sentinel', u: 'sentinel-user' })
  })

  it('authenticated には app スキーマの USAGE が無いので、直接は呼べない。方針の式の中からだけ使われる（上のアップロードが通る）', async () => {
    const usage = await db.query<{ auth: boolean; anon: boolean }>(
      `select has_schema_privilege('authenticated', 'app', 'usage') as auth, has_schema_privilege('anon', 'app', 'usage') as anon`)
    expect(usage.rows[0]).toEqual({ auth: false, anon: false })
    expect(await sqlstateOf(() => asAuthenticated(db, USER_A, (tx) => tx.query('select app.my_household()')))).toBe('42501')
    expect(await sqlstateOf(() => asAuthenticated(db, USER_A, (tx) => tx.query('select app.my_household()'), 'anon'))).toBe('42501')
    await expect(put(USER_A, 'media', `${HH_A}/via-policy.jpg`)).resolves.toBeDefined()
  })
})

describe('storage.objects の方針', () => {
  for (const bucket of ['media', 'receipts']) {
    describe(`バケット ${bucket}`, () => {
      it('自分の世帯のフォルダには上げられる（種類のフォルダの下も）', async () => {
        await put(USER_A, bucket, `${HH_A}/sales/abc.jpg`)
        await put(USER_A, bucket, `${HH_A}/purchases/lines/def.png`)
        await put(USER_B, bucket, `${HH_B}/sales/abc.jpg`)
        const all = await db.query<{ name: string }>('select name from storage.objects where bucket_id = $1 order by name', [bucket])
        expect(all.rows.map((r) => r.name)).toEqual(
          [`${HH_A}/purchases/lines/def.png`, `${HH_A}/sales/abc.jpg`, `${HH_B}/sales/abc.jpg`].sort(),
        )
      })

      it('他の世帯のフォルダには上げられない（42501）', async () => {
        expect(await sqlstateOf(() => put(USER_A, bucket, `${HH_B}/sales/abc.jpg`))).toBe('42501')
        expect(await sqlstateOf(() => put(USER_B, bucket, `${HH_A}/sales/abc.jpg`))).toBe('42501')
        expect((await db.query('select 1 from storage.objects')).rows).toEqual([])
      })

      it('フォルダの外（ルート直下・世帯の id でないフォルダ・世帯の id の名前のファイル）には上げられない', async () => {
        for (const name of [
          'abc.jpg', 'sales/abc.jpg', `${HH_A}`, `${HH_A}.jpg`, `x${HH_A}/abc.jpg`, `${HH_A.toUpperCase()}/abc.jpg`, `/${HH_A}/abc.jpg`,
        ]) {
          expect(await sqlstateOf(() => put(USER_A, bucket, name)), name).toBe('42501')
        }
      })

      it('世帯に属さない人・JWT なし・anon は上げられない', async () => {
        expect(await sqlstateOf(() => put(USER_NOBODY, bucket, `${HH_A}/sales/abc.jpg`))).toBe('42501')
        expect(await sqlstateOf(() => put(USER_NOBODY, bucket, 'abc.jpg'))).toBe('42501')
        expect(await sqlstateOf(() => put(null, bucket, `${HH_A}/sales/abc.jpg`))).toBe('42501')
        expect(await sqlstateOf(() => put(USER_A, bucket, `${HH_A}/sales/abc.jpg`, 'anon'))).toBe('42501')
        expect(await sqlstateOf(() => put(null, bucket, `${HH_A}/sales/abc.jpg`, 'anon'))).toBe('42501')
      })

      it('読めるのは自分の世帯のフォルダだけ。anon・世帯に属さない人は 1 件も読めない', async () => {
        await seed(bucket, `${HH_A}/sales/a1.jpg`)
        await seed(bucket, `${HH_A}/sales/a2.jpg`)
        await seed(bucket, `${HH_B}/sales/b1.jpg`)
        await seed(bucket, 'root.jpg')
        expect(await names(USER_A, bucket)).toEqual([`${HH_A}/sales/a1.jpg`, `${HH_A}/sales/a2.jpg`])
        expect(await names(USER_B, bucket)).toEqual([`${HH_B}/sales/b1.jpg`])
        expect(await names(USER_NOBODY, bucket)).toEqual([])
        expect(await names(null, bucket)).toEqual([])
        expect(await sqlstateOf(() => names(USER_A, bucket, 'anon'))).toBeNull() // 表の権限はあるが、方針が無いので 0 件
        expect(await names(USER_A, bucket, 'anon')).toEqual([])
      })

      it('消せるのは自分の世帯のフォルダのファイルだけ（他の世帯のは 0 件）', async () => {
        await seed(bucket, `${HH_A}/sales/a1.jpg`)
        await seed(bucket, `${HH_B}/sales/b1.jpg`)
        expect(await remove(USER_A, bucket, `${HH_B}/sales/b1.jpg`)).toBe(0)
        expect(await remove(USER_NOBODY, bucket, `${HH_A}/sales/a1.jpg`)).toBe(0)
        expect(await remove(USER_A, bucket, `${HH_A}/sales/a1.jpg`)).toBe(1)
        const left = await db.query<{ name: string }>('select name from storage.objects where bucket_id = $1', [bucket])
        expect(left.rows.map((r) => r.name)).toEqual([`${HH_B}/sales/b1.jpg`])
      })

      it('書き換え（update）はできない：方針が無いので 0 件（上書きしたいときは消して上げ直す）', async () => {
        await seed(bucket, `${HH_A}/sales/a1.jpg`)
        const n = await asAuthenticated(db, USER_A, async (tx) =>
          (await tx.query(`update storage.objects set name = $1 where bucket_id = $2`, [`${HH_B}/sales/stolen.jpg`, bucket])).affectedRows)
        expect(n).toBe(0)
        const n2 = await asAuthenticated(db, USER_A, async (tx) =>
          (await tx.query(`update storage.objects set metadata = '{}'::jsonb where bucket_id = $1`, [bucket])).affectedRows)
        expect(n2).toBe(0)
      })
    })
  }

  it('media と receipts 以外のバケットには上げられない・読めない（自分の世帯のフォルダでも）', async () => {
    expect(await sqlstateOf(() => put(USER_A, 'other', `${HH_A}/sales/abc.jpg`))).toBe('42501')
    await seed('other', `${HH_A}/sales/abc.jpg`)
    expect(await names(USER_A, 'other')).toEqual([])
    expect(await remove(USER_A, 'other', `${HH_A}/sales/abc.jpg`)).toBe(0)
  })

  it('media の方針は media のバケットだけ、receipts の方針は receipts のバケットだけ（バケットをまたがない）', async () => {
    await seed('media', `${HH_A}/m.jpg`)
    await seed('receipts', `${HH_A}/r.jpg`)
    expect(await names(USER_A, 'media')).toEqual([`${HH_A}/m.jpg`])
    expect(await names(USER_A, 'receipts')).toEqual([`${HH_A}/r.jpg`])
    const { rows } = await db.query<{ polname: string; cmd: string; roles: string[] }>(
      `select p.polname, p.polcmd::text as cmd, array(select r.rolname::text from pg_roles r where r.oid = any(p.polroles)) as roles
         from pg_policy p where p.polrelid = 'storage.objects'::regclass and p.polname like 'soroban_%' order by p.polname`)
    expect(rows).toEqual([
      { polname: 'soroban_media_delete', cmd: 'd', roles: ['authenticated'] },
      { polname: 'soroban_media_insert', cmd: 'a', roles: ['authenticated'] },
      { polname: 'soroban_media_select', cmd: 'r', roles: ['authenticated'] },
      { polname: 'soroban_receipts_delete', cmd: 'd', roles: ['authenticated'] },
      { polname: 'soroban_receipts_insert', cmd: 'a', roles: ['authenticated'] },
      { polname: 'soroban_receipts_select', cmd: 'r', roles: ['authenticated'] },
    ])
  })

  it('soroban_api（API の接続）は storage.objects に触れない（Storage は authenticated の JWT で使う）', async () => {
    expect(await sqlstateOf(() => asApi(db, HH_A, (tx) => tx.query('select * from storage.objects')))).toBe('42501')
  })
})

describe('スタブが本物の定義に沿っていること', () => {
  it('storage.foldername：最後（ファイル名）を除いたフォルダの配列', async () => {
    const r = await db.query<{ a: string[]; b: string[]; c: string[] }>(
      `select storage.foldername('h/sales/x.jpg') as a, storage.foldername('x.jpg') as b, storage.foldername('h/x.jpg') as c`)
    expect(r.rows[0]).toEqual({ a: ['h', 'sales'], b: [], c: ['h'] })
  })

  it('auth.uid()：request.jwt.claim.sub と request.jwt.claims の sub のどちらからも引ける。無ければ null', async () => {
    const r = await db.transaction(async (tx) => {
      const none = (await tx.query<{ u: string | null }>('select auth.uid() as u')).rows[0].u
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: USER_B })])
      const viaClaims = (await tx.query<{ u: string }>('select auth.uid() as u')).rows[0].u
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [USER_A])
      const viaSub = (await tx.query<{ u: string }>('select auth.uid() as u')).rows[0].u
      return { none, viaClaims, viaSub }
    })
    expect(r).toEqual({ none: null, viaClaims: USER_B, viaSub: USER_A })
  })
})
