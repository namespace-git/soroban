import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMigratedDb } from '../../test/migrate'
import { asApi, asRole, HH_A, HH_B, seedHouseholds, sha256hex, sqlstateOf, USER_A, USER_B } from './helpers'

// 取り込み担当の PC（agent_device）と、鍵のハッシュから PC と世帯を引く app.agent_of_token
// （20261012001500_agent_push_cron.sql）。平文の鍵はどこにも持たない（ハッシュだけ）

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
})

interface Device {
  id: string
  household_id: string
  name: string
  token_hash: string
  token_expires_at: string
  first_seen_at: string
  last_seen_at: string
  revoked_at: string | null
  registered_by: string | null
}

const register = (hh: string, name: string, token: string, expires = '12 hours', userId?: string) =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ d: Device }>(
      `select to_jsonb(app.register_agent_device($1, $2, now() + $3::interval)) as d`,
      [name, sha256hex(token), expires],
    )).rows[0].d, userId ? { userId } : {})

const revoke = (hh: string, id: string) =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ d: Device }>('select to_jsonb(app.revoke_agent_device($1)) as d', [id])).rows[0].d)

/** API が set role の前に呼ぶ形：接続したロールのまま、鍵のハッシュで引く */
const lookup = async (token: string): Promise<Array<{ agent_id: string; household_id: string }>> =>
  (await db.query<{ agent_id: string; household_id: string }>(
    'select agent_id, household_id from app.agent_of_token($1)', [sha256hex(token)],
  )).rows

const row = async (id: string): Promise<Device> =>
  (await db.query<Device>('select * from app.agent_device where id = $1', [id])).rows[0]

describe('register_agent_device（鍵を出す）', () => {
  it('新しい PC の行ができる。ハッシュと期限・押した人が入り、first_seen_at = last_seen_at', async () => {
    const d = await register(HH_A, 'リビングの PC', 'tok-1', '12 hours', USER_A)
    expect(d).toMatchObject({
      household_id: HH_A, name: 'リビングの PC', token_hash: sha256hex('tok-1'), revoked_at: null, registered_by: USER_A,
    })
    expect(new Date(d.token_expires_at).getTime()).toBeGreaterThan(Date.now() + 11 * 3600_000)
    expect(new Date(d.token_expires_at).getTime()).toBeLessThan(Date.now() + 13 * 3600_000)
    expect(d.first_seen_at).toBe(d.last_seen_at)
  })

  it('押した人が分からなくても作れる（registered_by は NULL）', async () => {
    expect((await register(HH_A, 'PC', 'tok-1')).registered_by).toBeNull()
  })

  it('同じ端末名なら行を使い回して、鍵と期限を差し替える（取り直し）。first_seen_at は残り、古い鍵は引けなくなる', async () => {
    const first = await register(HH_A, 'リビングの PC', 'tok-old', '1 hour', USER_A)
    expect(await lookup('tok-old')).toHaveLength(1)

    const second = await register(HH_A, 'リビングの PC', 'tok-new', '12 hours', USER_A)
    expect(second.id).toBe(first.id)
    expect(second.first_seen_at).toBe(first.first_seen_at)
    expect(second.token_hash).toBe(sha256hex('tok-new'))
    expect(new Date(second.token_expires_at).getTime()).toBeGreaterThan(new Date(first.token_expires_at).getTime())

    expect(await lookup('tok-old')).toEqual([])
    expect(await lookup('tok-new')).toEqual([{ agent_id: first.id, household_id: HH_A }])
    const count = await db.query<{ n: number }>('select count(*)::int as n from app.agent_device')
    expect(count.rows[0].n).toBe(1)
  })

  it('端末名の前後の空白は取る（空白違いで別の PC にならない）', async () => {
    const a = await register(HH_A, 'PC', 'tok-1')
    const b = await register(HH_A, '  PC  ', 'tok-2')
    expect(b.id).toBe(a.id)
    expect(b.name).toBe('PC')
  })

  it('同じ端末名でも世帯が違えば別の行', async () => {
    const a = await register(HH_A, 'PC', 'tok-a')
    const b = await register(HH_B, 'PC', 'tok-b')
    expect(b.id).not.toBe(a.id)
    expect(b.household_id).toBe(HH_B)
  })

  it('取り消し済みの PC には、鍵を出さない（SB006）。鍵も差し替わらない', async () => {
    const d = await register(HH_A, 'PC', 'tok-1')
    await revoke(HH_A, d.id)
    const err = await register(HH_A, 'PC', 'tok-2').catch((e) => e)
    expect(err).toMatchObject({ code: 'SB006' })
    expect(err.message).toBe('この PC は取り消されているので、取り込み担当の鍵を出せません')
    expect((await row(d.id)).token_hash).toBe(sha256hex('tok-1'))
    // 別の名前の PC なら出せる
    await expect(register(HH_A, 'PC その 2', 'tok-3')).resolves.toMatchObject({ revoked_at: null })
  })

  it('端末名が空・空白だけ・200 文字超は 22023。200 文字ちょうどは通る', async () => {
    for (const name of ['', '   ', 'x'.repeat(201)]) {
      expect(await sqlstateOf(() => register(HH_A, name, 'tok')), JSON.stringify(name.slice(0, 5))).toBe('22023')
    }
    expect(await sqlstateOf(() =>
      asApi(db, HH_A, (tx) => tx.query(`select app.register_agent_device(null, $1, now() + interval '1 hour')`, [sha256hex('t')])),
    )).toBe('22023')
    await expect(register(HH_A, 'x'.repeat(200), 'tok')).resolves.toBeDefined()
  })

  it('鍵のハッシュは SHA-256 の 16 進（小文字 64 文字）だけ。平文の鍵・大文字・短いものは 22023', async () => {
    for (const bad of ['plain-token', sha256hex('x').toUpperCase(), sha256hex('x').slice(0, 63), '', sha256hex('x') + '0']) {
      expect(await sqlstateOf(() =>
        asApi(db, HH_A, (tx) => tx.query(`select app.register_agent_device('PC', $1, now() + interval '1 hour')`, [bad])),
      ), bad.slice(0, 12)).toBe('22023')
    }
    expect(await sqlstateOf(() =>
      asApi(db, HH_A, (tx) => tx.query(`select app.register_agent_device('PC', null, now() + interval '1 hour')`)),
    )).toBe('22023')
  })

  it('表にも、平文の鍵を入れられない（check）', async () => {
    const code = await sqlstateOf(() =>
      asApi(db, HH_A, (tx) => tx.query(
        `insert into app.agent_device (name, token_hash, token_expires_at) values ('PC', 'plain-token', now() + interval '1 hour')`,
      )),
    )
    expect(code).toBe('23514')
  })

  it('期限は「いまから 24 時間以内」。過去・いま・null・24 時間超は 22023', async () => {
    for (const expires of ['-1 minute', '0 seconds', '25 hours', '30 days']) {
      expect(await sqlstateOf(() => register(HH_A, 'PC', 'tok', expires)), expires).toBe('22023')
    }
    expect(await sqlstateOf(() =>
      asApi(db, HH_A, (tx) => tx.query(`select app.register_agent_device('PC', $1, null)`, [sha256hex('t')])),
    )).toBe('22023')
    await expect(register(HH_A, 'PC', 'tok', '23 hours')).resolves.toBeDefined()
  })

  it('同じ鍵のハッシュを別の PC には使えない（一意）', async () => {
    await register(HH_A, 'PC 1', 'same')
    expect(await sqlstateOf(() => register(HH_A, 'PC 2', 'same'))).toBe('23505')
  })
})

describe('agent_of_token（鍵 → PC と世帯。API が set role の前に呼ぶ）', () => {
  it('有効な鍵なら (PC の id, 世帯の id) を返す。世帯 B の鍵は B を返す', async () => {
    const a = await register(HH_A, 'PC-A', 'tok-a')
    const b = await register(HH_B, 'PC-B', 'tok-b')
    expect(await lookup('tok-a')).toEqual([{ agent_id: a.id, household_id: HH_A }])
    expect(await lookup('tok-b')).toEqual([{ agent_id: b.id, household_id: HH_B }])
  })

  it('知らない鍵・null・空文字は 0 行', async () => {
    await register(HH_A, 'PC', 'tok-a')
    expect(await lookup('tok-unknown')).toEqual([])
    expect((await db.query('select * from app.agent_of_token(null)')).rows).toEqual([])
    expect((await db.query(`select * from app.agent_of_token('')`)).rows).toEqual([])
    // ハッシュ前の平文を渡しても引けない（ハッシュの値そのものでしか引けない）
    expect((await db.query('select * from app.agent_of_token($1)', ['tok-a'])).rows).toEqual([])
  })

  it('期限切れの鍵は引けない。期限が来る直前までは引ける', async () => {
    const d = await register(HH_A, 'PC', 'tok')
    expect(await lookup('tok')).toHaveLength(1)
    await db.query(`update app.agent_device set token_expires_at = now() + interval '30 seconds' where id = $1`, [d.id])
    expect(await lookup('tok')).toHaveLength(1)
    await db.query(`update app.agent_device set token_expires_at = now() - interval '1 second' where id = $1`, [d.id])
    expect(await lookup('tok')).toEqual([])
  })

  it('取り消した PC の鍵は引けない（期限内でも）。取り消し前に出した鍵も', async () => {
    const d = await register(HH_A, 'PC', 'tok')
    expect(await lookup('tok')).toHaveLength(1)
    const done = await revoke(HH_A, d.id)
    expect(done.revoked_at).not.toBeNull()
    expect(await lookup('tok')).toEqual([])
  })

  it('引けたら last_seen_at が進む。引けなかったら進まない', async () => {
    const d = await register(HH_A, 'PC', 'tok')
    await db.query(`update app.agent_device set last_seen_at = now() - interval '1 hour' where id = $1`, [d.id])
    const old = new Date((await row(d.id)).last_seen_at).getTime()

    await lookup('tok-unknown')
    expect(new Date((await row(d.id)).last_seen_at).getTime()).toBe(old)

    await lookup('tok')
    expect(new Date((await row(d.id)).last_seen_at).getTime()).toBeGreaterThan(old + 3500_000)

    // 期限切れでは進まない
    await db.query(`update app.agent_device set last_seen_at = now() - interval '1 hour', token_expires_at = now() - interval '1 second' where id = $1`, [d.id])
    const old2 = new Date((await row(d.id)).last_seen_at).getTime()
    await lookup('tok')
    expect(new Date((await row(d.id)).last_seen_at).getTime()).toBe(old2)
  })

  it('照会に使う内部の設定（app.agent_token_hash）は、終わったら呼ぶ前の値に戻る', async () => {
    await register(HH_A, 'PC', 'tok')
    const r = await db.transaction(async (tx) => {
      await tx.query("select set_config('app.agent_token_hash', 'before', true)")
      await tx.query('select * from app.agent_of_token($1)', [sha256hex('tok')])
      const after = (await tx.query<{ v: string }>("select current_setting('app.agent_token_hash', true) as v")).rows[0].v
      return after
    })
    expect(r).toBe('before')
  })

  it('security definer で search_path が固定され、soroban_api だけが実行できる（PUBLIC・anon・authenticated・soroban_cron は不可）', async () => {
    const { rows } = await db.query<{
      prosecdef: boolean; proconfig: string[] | null; api: boolean; anon: boolean; auth: boolean; cron: boolean; public_exec: boolean
    }>(
      `select p.prosecdef, p.proconfig,
              has_function_privilege('soroban_api', p.oid, 'execute') as api,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('soroban_cron', p.oid, 'execute') as cron,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0) as public_exec
         from pg_proc p where p.pronamespace = 'app'::regnamespace and p.proname = 'agent_of_token'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].prosecdef).toBe(true)
    expect(rows[0].proconfig).toContain('search_path=app, pg_temp')
    expect(rows[0]).toMatchObject({ api: true, anon: false, auth: false, cron: false, public_exec: false })
  })

  it('soroban_api から（set role の後）呼んでも引ける。ただし他の世帯の PC を、ハッシュを知らずに探ることはできない', async () => {
    const b = await register(HH_B, 'PC-B', 'tok-b')
    // 世帯 A の文脈で、B の鍵のハッシュを渡せば引ける（鍵を持っている＝B の PC なので、B の世帯と分かるだけ）
    const viaApi = await asApi(db, HH_A, async (tx) =>
      (await tx.query<{ household_id: string }>('select household_id from app.agent_of_token($1)', [sha256hex('tok-b')])).rows)
    expect(viaApi).toEqual([{ household_id: HH_B }])
    // ハッシュを知らなければ、A の文脈で B の PC の行は 1 行も見えない
    const seen = await asApi(db, HH_A, async (tx) => (await tx.query('select * from app.agent_device where id = $1', [b.id])).rows)
    expect(seen).toEqual([])
  })

  it('接続ロールが BYPASSRLS を持たず、表と関数の持ち主でも force row level security で読めない環境でも引ける', async () => {
    const d = await register(HH_A, 'PC', 'tok')
    await db.query(`update app.agent_device set last_seen_at = now() - interval '1 hour' where id = $1`, [d.id])

    // 表と関数の持ち主を BYPASSRLS の無いロールに替え、接続ロールも BYPASSRLS の無いロールにして呼ぶ
    // （このトランザクションの中だけ。最後にロールバック。auth-household.test.ts と同じ作り）
    const probe = await db
      .transaction(async (tx) => {
        await tx.query('create role probe_owner nologin nosuperuser nobypassrls')
        await tx.query('create role probe_conn nologin nosuperuser nobypassrls')
        await tx.query('grant usage on schema app to probe_owner, probe_conn')
        await tx.query('alter table app.agent_device owner to probe_owner')
        await tx.query('alter function app.agent_of_token(text) owner to probe_owner')
        await tx.query('grant execute on function app.agent_of_token(text) to probe_conn')
        // 直接 select は許す（それでも force row level security で 0 件になることの対照）
        await tx.query('grant select on app.agent_device to probe_conn')
        await tx.query('set local role probe_conn')

        const who = (await tx.query<{ r: string }>('select current_user as r')).rows[0].r
        const direct = (await tx.query('select id from app.agent_device')).rows
        const found = (await tx.query<{ agent_id: string; household_id: string }>(
          'select agent_id, household_id from app.agent_of_token($1)', [sha256hex('tok')],
        )).rows
        const unknown = (await tx.query('select * from app.agent_of_token($1)', [sha256hex('nope')])).rows
        await tx.query('reset role')
        const seen = (await tx.query<{ last_seen_at: string }>('select last_seen_at from app.agent_device where id = $1', [d.id])).rows[0].last_seen_at
        throw Object.assign(new Error('rollback'), { probe: { who, direct, found, unknown, seen } })
      })
      .catch((e: { probe?: { who: string; direct: unknown[]; found: unknown[]; unknown: unknown[]; seen: string } }) => e.probe)

    expect(probe).toBeDefined()
    expect(probe!.who).toBe('probe_conn')
    expect(probe!.direct).toEqual([])
    expect(probe!.found).toEqual([{ agent_id: d.id, household_id: HH_A }])
    expect(probe!.unknown).toEqual([])
    expect(new Date(probe!.seen).getTime()).toBeGreaterThan(Date.now() - 60_000) // last_seen_at も進んだ

    // ロールバックされて、元の持ち主に戻っている
    const owner = await db.query<{ owner: string }>(
      `select pg_get_userbyid(proowner) as owner from pg_proc where proname = 'agent_of_token' and pronamespace = 'app'::regnamespace`,
    )
    expect(owner.rows[0].owner).toBe('postgres')
  })
})

describe('revoke_agent_device', () => {
  it('取り消すと revoked_at が入る。重ねて取り消しても最初の時刻のまま', async () => {
    const d = await register(HH_A, 'PC', 'tok')
    const first = await revoke(HH_A, d.id)
    expect(first.revoked_at).not.toBeNull()
    await db.query(`update app.agent_device set revoked_at = now() - interval '1 hour' where id = $1`, [d.id])
    const old = (await row(d.id)).revoked_at
    const again = await revoke(HH_A, d.id)
    expect(new Date(again.revoked_at!).getTime()).toBe(new Date(old!).getTime())
  })

  it('見つからない id は SB007。他の世帯の PC は取り消せない（RLS で見えない）', async () => {
    const b = await register(HH_B, 'PC-B', 'tok-b')
    await expect(revoke(HH_A, randomUUID())).rejects.toMatchObject({ code: 'SB007', message: '取り込み担当の PC が見つかりません' })
    await expect(revoke(HH_A, b.id)).rejects.toMatchObject({ code: 'SB007' })
    expect((await row(b.id)).revoked_at).toBeNull()
    expect(await lookup('tok-b')).toHaveLength(1)
  })
})

describe('世帯の分離と権限', () => {
  it('自分の世帯の PC だけ見える。名前の一意は世帯ごと', async () => {
    await register(HH_A, 'PC', 'tok-a')
    await register(HH_B, 'PC', 'tok-b')
    const seenByA = await asApi(db, HH_A, async (tx) => (await tx.query<{ household_id: string }>('select household_id from app.agent_device')).rows)
    expect(seenByA).toEqual([{ household_id: HH_A }])
  })

  it('別の世帯の household_id を指定した insert は RLS で拒否される', async () => {
    const code = await sqlstateOf(() =>
      asApi(db, HH_A, (tx) => tx.query(
        `insert into app.agent_device (household_id, name, token_hash, token_expires_at)
         values ($1, 'なりすまし', $2, now() + interval '1 hour')`, [HH_B, sha256hex('x')],
      )),
    )
    expect(code).toBe('42501')
  })

  it('anon / authenticated は表も関数も使えない', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect(await sqlstateOf(() => asRole(db, role, (tx) => tx.query('select * from app.agent_device'))), role).toBe('42501')
      expect(await sqlstateOf(() => asRole(db, role, (tx) => tx.query('select * from app.agent_of_token($1)', [sha256hex('x')]))), role).toBe('42501')
      expect(await sqlstateOf(() => asRole(db, role, (tx) => tx.query(`select app.register_agent_device('PC', $1, now() + interval '1 hour')`, [sha256hex('x')]))), role).toBe('42501')
    }
  })

  it('鍵を作らせた人のアカウントを消しても PC は残り（registered_by だけ null）、世帯を消すと PC も消える', async () => {
    const d = await register(HH_B, 'PC', 'tok', '12 hours', USER_B)
    await db.query('delete from auth.users where id = $1', [USER_B])
    expect(await row(d.id)).toMatchObject({ household_id: HH_B, registered_by: null })
    await db.query('delete from app.household where id = $1', [HH_B])
    expect((await db.query('select id from app.agent_device where id = $1', [d.id])).rows).toEqual([])
    // 後続のテストのために世帯 B を戻す
    await db.query(`insert into auth.users (id, email) values ($1, 'b@example.test')`, [USER_B])
    await db.query(`insert into app.household (id, name) values ($1, '世帯B')`, [HH_B])
    await db.query(`insert into app.household_member (household_id, user_id, role) values ($1, $2, 'owner')`, [HH_B, USER_B])
  })

  it('平文の鍵を持つ列が無い（token_hash だけ）', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'app' and table_name = 'agent_device' order by ordinal_position`,
    )
    expect(rows.map((r) => r.column_name)).toEqual([
      'id', 'household_id', 'name', 'token_hash', 'token_expires_at', 'first_seen_at', 'last_seen_at', 'revoked_at', 'registered_by',
    ])
  })
})
