import type { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMigratedDb } from '../../test/migrate'
import { insertChain, type Chain } from '../schema/helpers'
import {
  asApi, asGateway, asGatewayThenApi, backToConnectionRole, HH_A, HH_B, seedHouseholds, sqlstateOf, USER_A, USER_B,
} from './helpers'

// API と定期実行がつなぐロール soroban_gateway（20261012001900）。
// 全テーブルの持ち主（postgres）でつなぐと、`set role soroban_api` を忘れたコードが全世帯の行を読めた。
// ゲートウェイは「世帯を引く」ための関数しか持たず、忘れたコードは権限エラーで止まる。
// テストでは `set local session authorization soroban_gateway` で、接続のユーザーそのものをゲートウェイにして確かめる
// （server/__tests__/security/helpers.ts の asGateway）

let db: PGlite
let chainA: Chain
let chainB: Chain

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
  chainA = await asApi(db, HH_A, (tx) => insertChain(tx, 'A'))
  chainB = await asApi(db, HH_B, (tx) => insertChain(tx, 'B'))
})

afterAll(async () => {
  await db.close()
})

describe('ロールの形', () => {
  it('ログインできず（利用者がパスワードと LOGIN を付けるまで）、NOINHERIT・NOBYPASSRLS・スーパーユーザーでない', async () => {
    const attr = await db.query(
      `select rolsuper, rolbypassrls, rolcanlogin, rolinherit, rolcreaterole, rolcreatedb, rolreplication
         from pg_roles where rolname = 'soroban_gateway'`,
    )
    expect(attr.rows).toEqual([{
      rolsuper: false, rolbypassrls: false, rolcanlogin: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false,
      rolreplication: false,
    }])
    // パスワードはマイグレーションに書いていない（pg_authid は superuser のテストでだけ見える）
    const pw = await db.query<{ rolpassword: string | null }>(`select rolpassword from pg_authid where rolname = 'soroban_gateway'`)
    expect(pw.rows).toEqual([{ rolpassword: null }])
  })

  it('soroban_api・soroban_cron のメンバー（set role できる）。権限は引き継がない', async () => {
    const { rows } = await db.query<{ role: string; inherit_option: boolean; set_option: boolean }>(
      `select r.rolname as role, m.inherit_option, m.set_option
         from pg_auth_members m
         join pg_roles r on r.oid = m.roleid
         join pg_roles u on u.oid = m.member
        where u.rolname = 'soroban_gateway' order by r.rolname`,
    )
    expect(rows).toEqual([
      { role: 'soroban_api', inherit_option: false, set_option: true },
      { role: 'soroban_cron', inherit_option: false, set_option: true },
    ])
  })

  it('何も所有していない。メンバーを追加できる側（ADMIN）でもない', async () => {
    const owned = await db.query<{ what: string }>(
      `select 'table ' || c.relname as what
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and pg_get_userbyid(c.relowner) = 'soroban_gateway'
       union all
       select 'function ' || p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and pg_get_userbyid(p.proowner) = 'soroban_gateway'
       union all
       select 'schema ' || n.nspname from pg_namespace n where pg_get_userbyid(n.nspowner) = 'soroban_gateway'`,
    )
    expect(owned.rows).toEqual([])
    const admin = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_auth_members m join pg_roles u on u.oid = m.member
        where u.rolname = 'soroban_gateway' and m.admin_option`)
    expect(admin.rows[0].n).toBe(0)
  })

  it('直接の権限は、app の USAGE と、set role の前に呼ぶ 2 つの関数の EXECUTE だけ（表も列もシーケンスも無い）', async () => {
    const usage = await db.query<{ ok: boolean }>(`select has_schema_privilege('soroban_gateway', 'app', 'usage') as ok`)
    expect(usage.rows[0].ok).toBe(true)
    const create = await db.query<{ ok: boolean }>(`select has_schema_privilege('soroban_gateway', 'app', 'create') as ok`)
    expect(create.rows[0].ok).toBe(false)

    const tables = await db.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants where grantee = 'soroban_gateway'`)
    expect(tables.rows).toEqual([])
    const cols = await db.query<{ table_name: string }>(
      `select table_name from information_schema.column_privileges where grantee = 'soroban_gateway' and table_schema = 'app'`)
    expect(cols.rows).toEqual([])

    // has_*_privilege は、NOINHERIT なので、メンバーになっている soroban_api などの権限を含めない（直接の権限だけ）
    const anyRel = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind in ('r', 'v', 'm', 'S', 'p')
          and (has_table_privilege('soroban_gateway', c.oid, 'select, insert, update, delete, truncate, references, trigger')
               or (c.relkind = 'S' and has_sequence_privilege('soroban_gateway', c.oid, 'usage, select, update')))
        order by c.relname`)
    expect(anyRel.rows).toEqual([])

    const fns = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p
        where p.pronamespace = 'app'::regnamespace and has_function_privilege('soroban_gateway', p.oid, 'execute')
        order by p.proname`)
    expect(fns.rows.map((r) => r.proname)).toEqual(['agent_of_token', 'household_of_user'])
  })

  it('soroban_api・soroban_cron・anon・authenticated は、世帯の照会（household_of_user）も鍵の照会（agent_of_token）も呼べない', async () => {
    for (const role of ['soroban_api', 'soroban_cron', 'anon', 'authenticated']) {
      const { rows } = await db.query<{ proname: string; ok: boolean }>(
        `select p.proname, has_function_privilege($1, p.oid, 'execute') as ok from pg_proc p
          where p.pronamespace = 'app'::regnamespace and p.proname in ('household_of_user', 'agent_of_token') order by p.proname`, [role])
      expect(rows, role).toEqual([{ proname: 'agent_of_token', ok: false }, { proname: 'household_of_user', ok: false }])
    }
  })
})

describe('set role を忘れたコードは、権限エラーで止まる（他の世帯の行を読めない）', () => {
  it('ゲートウェイのまま app の表・ビュー・関数を使うと 42501。set role soroban_api の後は、自分の世帯の行だけ', async () => {
    // 対照：接続したロール（postgres）のままなら、全世帯が見える。これまではこの接続で API が動いていた
    const all = await db.query<{ household_id: string }>('select household_id from app.sale order by household_id')
    expect(all.rows.map((r) => r.household_id)).toEqual([HH_A, HH_B])

    for (const sql of [
      'select * from app.sale',
      'select count(*) from app.sale',
      'select * from app.household_member',
      'select * from app.setting_secret',
      'select * from app.sale_profit',
      'select * from app.agent_device',
      'select app.enqueue_collect_job()',
      'select app.create_household(\'x\', array[]::uuid[])',
      'insert into app.tag (household_id, name) values (\'' + HH_A + '\', \'x\')',
      'delete from app.sale',
    ]) {
      expect(await sqlstateOf(() => asGateway(db, (tx) => tx.query(sql))), sql).toBe('42501')
    }

    // 世帯の文脈（server/context.ts の withHousehold と同じ順）に入ると、自分の世帯の行だけ
    const a = await asGatewayThenApi(db, HH_A, async (tx) =>
      (await tx.query<{ household_id: string; id: string }>('select household_id, id from app.sale')).rows, { userId: USER_A })
    expect(a).toEqual([{ household_id: HH_A, id: chainA.saleId }])
    const b = await asGatewayThenApi(db, HH_B, async (tx) =>
      (await tx.query<{ household_id: string; id: string }>('select household_id, id from app.sale')).rows, { userId: USER_B })
    expect(b).toEqual([{ household_id: HH_B, id: chainB.saleId }])

    // 世帯を渡し忘れても（set role だけして）、1 行も見えない
    const none = await asGateway(db, async (tx) => {
      await tx.query('set local role soroban_api')
      return (await tx.query('select * from app.sale')).rows
    })
    expect(none).toEqual([])
  })

  it('メンバーシップで `set role` できるのは soroban_api・soroban_cron だけ。postgres・anon・authenticated にはなれない', async () => {
    const who = async (role: string) =>
      asGateway(db, async (tx) => {
        await tx.query(`set local role ${role}`)
        return (await tx.query<{ u: string; s: string }>('select current_user as u, session_user as s')).rows[0]
      })
    expect(await who('soroban_api')).toEqual({ u: 'soroban_api', s: 'soroban_gateway' })
    expect(await who('soroban_cron')).toEqual({ u: 'soroban_cron', s: 'soroban_gateway' })
    for (const role of ['postgres', 'anon', 'authenticated']) {
      expect(await sqlstateOf(() => who(role)), role).toBe('42501')
    }
    // 対照：メンバーでないロール（authenticated）で入ったときは、soroban_api に切り替えられない
    // （asGateway が本当にメンバーシップで判定されていることの裏付け）
    const code = await sqlstateOf(() => db.transaction(async (tx) => {
      await tx.query('set local session authorization authenticated')
      await tx.query('set local role soroban_api')
    })).finally(() => backToConnectionRole(db))
    expect(code).toBe('42501')
  })

  it('ゲートウェイは、世帯の照会の関数を set role の前に呼べる（household_of_user・agent_of_token）', async () => {
    const hh = await asGateway(db, async (tx) =>
      (await tx.query<{ id: string }>('select app.household_of_user($1) as id', [USER_A])).rows[0].id)
    expect(hh).toBe(HH_A)
    const agent = await asGateway(db, async (tx) =>
      (await tx.query('select * from app.agent_of_token($1)', ['0'.repeat(64)])).rows)
    expect(agent).toEqual([])
  })

  it('定期実行（soroban_cron）にも、ゲートウェイから切り替えられる。通知・取り込み要求の片付けの関数が呼べる', async () => {
    const n = await asGateway(db, async (tx) => {
      await tx.query('set local role soroban_cron')
      return (await tx.query<{ n: number }>('select app.reap_stale_collect_jobs() as n')).rows[0].n
    })
    expect(n).toBe(0)
  })
})

describe('soroban_api の権限（最小に）', () => {
  it('世帯とメンバーの表は読むだけ。作る・変える・消すのは管理画面（postgres）だけ', async () => {
    const can = async (table: string, priv: string): Promise<boolean> =>
      (await db.query<{ ok: boolean }>(`select has_table_privilege('soroban_api', $1::regclass, $2) as ok`, [`app.${table}`, priv])).rows[0].ok
    for (const t of ['household', 'household_member']) {
      expect(await can(t, 'select'), `${t} select`).toBe(true)
      for (const p of ['insert', 'update', 'delete', 'truncate', 'references', 'trigger']) expect(await can(t, p), `${t} ${p}`).toBe(false)
    }
    // ほかの表は、これまでどおり DML ができる
    expect(await can('sale', 'insert')).toBe(true)
    expect(await can('agent_device', 'update')).toBe(true)
  })

  it('メンバーの行の方針と鍵の方針は、使うロール（関数の持ち主）だけに効く', async () => {
    const { rows } = await db.query<{ polname: string; roles: string[] }>(
      `select p.polname, array(select r.rolname::text from pg_roles r where r.oid = any(p.polroles) order by 1) as roles
         from pg_policy p
        where p.polname in ('member_self_lookup', 'agent_token_lookup_select', 'agent_token_lookup_update')
        order by p.polname`)
    const owner = (await db.query<{ owner: string }>(
      `select pg_get_userbyid(proowner) as owner from pg_proc where proname = 'household_of_user' and pronamespace = 'app'::regnamespace`)).rows[0].owner
    expect(rows).toEqual([
      { polname: 'agent_token_lookup_select', roles: [owner] },
      { polname: 'agent_token_lookup_update', roles: [owner] },
      { polname: 'member_self_lookup', roles: [owner] },
    ])
    // 持ち主は、household_of_user・agent_of_token・トリガー関数の持ち主と同じ
    const owners = await db.query<{ owner: string }>(
      `select distinct pg_get_userbyid(proowner) as owner from pg_proc
        where pronamespace = 'app'::regnamespace and proname in ('household_of_user', 'agent_of_token', 'revoke_agents_of_removed_member')`)
    expect(owners.rows).toEqual([{ owner }])
  })

  it('定期実行は暗号文（setting_secret）に触れない', async () => {
    const { rows } = await db.query<{ ok: boolean }>(`select has_any_column_privilege('soroban_cron', 'app.setting_secret', 'select, insert, update, references') as ok`)
    expect(rows[0].ok).toBe(false)
  })
})
