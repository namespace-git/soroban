import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createMigratedDb } from '../../test/migrate'
import {
  asApi, asApiWithoutHousehold, asRole, HH_A, HH_B, insertChain, seedHouseholds, sqlstateOf,
  USER_A, USER_B, type Chain,
} from './helpers'

let db: PGlite
let chainA: Chain
let chainB: Chain

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
  // 世帯ごとに、同じ形のデータを 1 セット（household_id は既定値＝API が渡した世帯）
  chainA = await asApi(db, HH_A, (tx) => insertChain(tx, 'A'))
  chainB = await asApi(db, HH_B, (tx) => insertChain(tx, 'B'))
})

afterAll(async () => {
  await db.close()
})

describe('RLS は soroban_api で効いている（接続ロールの特権に頼っていない）', () => {
  it('テストは soroban_api で動いている：スーパーユーザーでも BYPASSRLS でもない', async () => {
    const r = await asApi(db, HH_A, async (tx) => {
      const who = await tx.query<{ current_user: string }>('select current_user')
      const attr = await tx.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
        `select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'soroban_api'`,
      )
      return { user: who.rows[0].current_user, attr: attr.rows[0] }
    })
    expect(r.user).toBe('soroban_api')
    expect(r.attr).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false })
  })

  it('対照：set role をしない接続ロールは RLS を受けず、全世帯が見える。だから API は必ず set role する', async () => {
    // PGlite の接続ロールは postgres（スーパーユーザー）。Supabase の postgres も表の持ち主で
    // RLS を素通りする。ここで 2 世帯とも見えることが、上のテストの意味（soroban_api で
    // 分離されている）を裏付ける
    const { rows } = await db.query<{ household_id: string }>(
      'select household_id from app.sale order by household_id',
    )
    expect(rows.map((r) => r.household_id)).toEqual([HH_A, HH_B])
  })

  it('soroban_api は app にテーブルを作れない', async () => {
    const code = await sqlstateOf(() =>
      asApi(db, HH_A, (tx) => tx.query('create table app.oops (id int)')),
    )
    expect(code).toBe('42501')
  })
})

describe('世帯の分離', () => {
  it('世帯 A からは B の行が 1 行も見えない（販売・在庫・仕入・仕入先）', async () => {
    const counts = await asApi(db, HH_A, async (tx) => {
      const q = async (t: string) =>
        (await tx.query<{ n: number }>(`select count(*)::int as n from app.${t} where household_id <> $1`, [HH_A]))
          .rows[0].n
      const mine = (await tx.query<{ n: number }>('select count(*)::int as n from app.sale')).rows[0].n
      return {
        mine,
        sale: await q('sale'),
        inventory_item: await q('inventory_item'),
        purchase: await q('purchase'),
        purchase_line: await q('purchase_line'),
        shop_account: await q('shop_account'),
      }
    })
    expect(counts).toEqual({
      mine: 1, sale: 0, inventory_item: 0, purchase: 0, purchase_line: 0, shop_account: 0,
    })
  })

  it('B の行を id で直接指しても見えない', async () => {
    const { rows } = await asApi(db, HH_A, (tx) =>
      tx.query('select id from app.sale where id = $1', [chainB.saleId]),
    )
    expect(rows).toEqual([])
  })

  it('B の行を更新できない（0 行）', async () => {
    const changed = await asApi(db, HH_A, async (tx) => {
      const r = await tx.query('update app.sale set price = 1 where id = $1', [chainB.saleId])
      // where を書き忘れた更新でも、触れるのは自分の世帯の行だけ
      const all = await tx.query('update app.inventory_item set note = $1', ['書き換え'])
      return { named: r.affectedRows, all: all.affectedRows }
    })
    expect(changed).toEqual({ named: 0, all: 1 })

    const { rows } = await db.query<{ price: number }>('select price from app.sale where id = $1', [chainB.saleId])
    expect(rows[0].price).toBe(3000)
    const notes = await db.query<{ household_id: string; note: string | null }>(
      'select household_id, note from app.inventory_item order by household_id',
    )
    expect(notes.rows).toEqual([
      { household_id: HH_A, note: '書き換え' },
      { household_id: HH_B, note: null },
    ])
  })

  it('B の行を削除できない（0 行）。where の無い delete でも自分の世帯の分だけ', async () => {
    const deleted = await asApi(db, HH_A, async (tx) => {
      const r = await tx.query('delete from app.setting')
      const named = await tx.query('delete from app.sale where id = $1', [chainB.saleId])
      return { setting: r.affectedRows, named: named.affectedRows }
    })
    expect(deleted).toEqual({ setting: 0, named: 0 })
    const { rows } = await db.query('select id from app.sale where id = $1', [chainB.saleId])
    expect(rows).toHaveLength(1)
  })

  it('B の世帯に更新・削除の「通ったように見える」副作用が残らない（A の削除は A の行だけ）', async () => {
    // 世帯 A の中でだけ作って消す
    await asApi(db, HH_A, async (tx) => {
      await tx.query("insert into app.setting (key, value) values ('fee_rate_bp', '1000')")
    })
    await asApi(db, HH_B, async (tx) => {
      await tx.query("insert into app.setting (key, value) values ('fee_rate_bp', '900')")
    })
    const deleted = await asApi(db, HH_A, async (tx) => (await tx.query('delete from app.setting')).affectedRows)
    expect(deleted).toBe(1)
    const { rows } = await db.query<{ household_id: string; value: string }>(
      'select household_id, value from app.setting',
    )
    expect(rows).toEqual([{ household_id: HH_B, value: '900' }])
  })

  it('household_id を指定せずに insert すると、API が渡した世帯になる', async () => {
    const hh = await asApi(db, HH_A, async (tx) => {
      const r = await tx.query<{ household_id: string }>(
        `insert into app.tag (name) values ('既定値の確認') returning household_id`,
      )
      return r.rows[0].household_id
    })
    expect(hh).toBe(HH_A)
  })

  it('別の世帯の household_id を指定した insert は RLS（with check）で拒否される', async () => {
    const code = await sqlstateOf(() =>
      asApi(db, HH_A, (tx) =>
        tx.query(`insert into app.tag (household_id, name) values ($1, 'なりすまし')`, [HH_B]),
      ),
    )
    expect(code).toBe('42501')
  })

  it('自分の行の household_id を別の世帯に書き換えられない', async () => {
    const code = await sqlstateOf(() =>
      asApi(db, HH_A, (tx) =>
        tx.query('update app.sale set household_id = $1 where id = $2', [HH_B, chainA.saleId]),
      ),
    )
    expect(code).toBe('42501')
  })

  it('世帯を渡し忘れたら、行は見えず、書き込みもできない（開けっ放しにならない）', async () => {
    // 渡していないと current_setting が null か空文字。読みは 0 行か uuid の構文エラーで、どちらでも 1 行も返らない
    const read = await asApiWithoutHousehold(db, (tx) => tx.query('select id from app.sale')).then(
      (r) => r.rows,
      () => [] as unknown[],
    )
    expect(read).toEqual([])

    const write = await sqlstateOf(() =>
      asApiWithoutHousehold(db, (tx) => tx.query(`insert into app.tag (name) values ('渡し忘れ')`)),
    )
    expect(write).not.toBeNull()
  })

  it('世帯のメンバー表も、自分の世帯の分しか見えない', async () => {
    const rows = await asApi(db, HH_A, async (tx) =>
      (await tx.query<{ user_id: string }>('select user_id from app.household_member')).rows,
    )
    expect(rows).toEqual([{ user_id: USER_A }])
    const hh = await asApi(db, HH_B, async (tx) =>
      (await tx.query<{ id: string }>('select id from app.household')).rows,
    )
    expect(hh).toEqual([{ id: HH_B }])
  })

  it('JWT のユーザーから世帯を引く照会は、set role の前（接続したロール）で行える', async () => {
    const { rows } = await db.query<{ household_id: string }>(
      'select household_id from app.household_member where user_id = $1',
      [USER_B],
    )
    expect(rows).toEqual([{ household_id: HH_B }])
  })
})

describe('他の世帯の行を指す外部キーが作れない', () => {
  it('A の販売に、B の在庫を紐付けられない（B の id を知っていても）', async () => {
    const code = await sqlstateOf(() =>
      asApi(db, HH_A, (tx) =>
        tx.query('insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2)', [
          chainA.saleId, chainB.inventoryItemId,
        ]),
      ),
    )
    expect(code).toBe('23503')
  })

  it('持ち主のロールで household_id をずらして書いても、親子の世帯が違えば外部キーで止まる', async () => {
    // 世帯 A の行として、世帯 B の販売への紐付けを作ろうとする（RLS を受けないロールでも拒否される）
    const code = await sqlstateOf(() =>
      db.query(
        'insert into app.sale_line (household_id, sale_id, inventory_item_id) values ($1, $2, $3)',
        [HH_A, chainB.saleId, chainA.inventoryItemId],
      ),
    )
    expect(code).toBe('23503')
  })

  it('他の世帯の仕入先を、自分の仕入に指定できない', async () => {
    const code = await sqlstateOf(() =>
      asApi(db, HH_A, (tx) =>
        tx.query(`insert into app.purchase (shop_account_id, ordered_at) values ($1, '2026-10-01')`, [
          chainB.shopAccountId,
        ]),
      ),
    )
    expect(code).toBe('23503')
  })

  it('子の行から他の世帯の親を指す insert は、どのテーブルでも外部キー違反（持ち主のロールでも）', async () => {
    const listingB = await asApi(db, HH_B, async (tx) =>
      (await tx.query<{ id: string }>(
        `insert into app.listing (channel_item_id, title, price, first_seen_at, last_seen_at, listed_at)
         values ('mFK', '出品', 2000, '2026-10-01', now(), '2026-10-01') returning id`,
      )).rows[0].id,
    )
    const tagB = await asApi(db, HH_B, async (tx) =>
      (await tx.query<{ id: string }>(`insert into app.tag (name) values ('B のタグ') returning id`)).rows[0].id,
    )
    const expenseB = await asApi(db, HH_B, async (tx) =>
      (await tx.query<{ id: string }>(
        `insert into app.expense (occurred_at, month, category, amount) values ('2026-10-01', '2026-10', 'other', 100) returning id`,
      )).rows[0].id,
    )

    const shippingB = await asApi(db, HH_B, async (tx) =>
      (await tx.query<{ id: string }>(
        `insert into app.shipping_method (name, fee) values ('B の発送方法', 200) returning id`,
      )).rows[0].id,
    )

    // 世帯 A の子行（household_id = A）から、世帯 B の親 id を指す
    const attempts: Array<[string, string, unknown[]]> = [
      ['listing_line → listing', 'insert into app.listing_line (household_id, listing_id, inventory_item_id) values ($1, $2, $3)',
        [HH_A, listingB, chainA.inventoryItemId]],
      ['purchase_line → purchase', `insert into app.purchase_line (household_id, purchase_id, name, unit_price, quantity) values ($1, $2, 'x', 1, 1)`,
        [HH_A, chainB.purchaseId]],
      ['inventory_item → purchase_line', `insert into app.inventory_item (household_id, item_code, purchase_line_id, name, landed_cost, acquired_at) values ($1, 'S-X', $2, 'x', 1, '2026-10-01')`,
        [HH_A, chainB.purchaseLineId]],
      ['sale_tag → tag', 'insert into app.sale_tag (household_id, sale_id, tag_id) values ($1, $2, $3)',
        [HH_A, chainA.saleId, tagB]],
      ['expense_line → expense', `insert into app.expense_line (household_id, expense_id, name, amount, category) values ($1, $2, 'x', 1, 'other')`,
        [HH_A, expenseB]],
      ['sale → shipping_method', `insert into app.sale (household_id, title, sold_at, price, shipping_method_id) values ($1, 'x', '2026-10-01', 1, $2)`,
        [HH_A, shippingB]],
    ]
    for (const [label, sql, params] of attempts) {
      expect(await sqlstateOf(() => db.query(sql, params)), label).toBe('23503')
    }
  })

  it('app のテーブル同士の外部キーは、すべて (household_id, …) の複合で張られている', async () => {
    const { rows } = await db.query<{ conname: string; child: string; parent: string; child_cols: string[]; parent_cols: string[] }>(
      `select k.conname, k.conrelid::regclass::text as child, k.confrelid::regclass::text as parent,
              array(select a.attname::text
                      from unnest(k.conkey) with ordinality u(attnum, ord)
                      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
                     order by u.ord) as child_cols,
              array(select a.attname::text
                      from unnest(k.confkey) with ordinality u(attnum, ord)
                      join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.attnum
                     order by u.ord) as parent_cols
         from pg_constraint k
         join pg_class p on p.oid = k.confrelid
        where k.contype = 'f'
          and k.connamespace = 'app'::regnamespace
          and p.relnamespace = 'app'::regnamespace
          and k.confrelid <> 'app.household'::regclass
        order by k.conname`,
    )
    expect(rows.length).toBeGreaterThanOrEqual(26)
    for (const r of rows) {
      const label = `${r.child} → ${r.parent} (${r.conname})`
      expect(r.child_cols[0], label).toBe('household_id')
      expect(r.parent_cols[0], label).toBe('household_id')
      expect(r.child_cols.length, label).toBeGreaterThanOrEqual(2)
      expect(r.child_cols.length, label).toBe(r.parent_cols.length)
    }
  })

  it('外部キーの参照先（親）には、(household_id, …) の一意制約がある', async () => {
    const { rows } = await db.query<{ conname: string; parent: string }>(
      `select k.conname, k.confrelid::regclass::text as parent
         from pg_constraint k
         join pg_class p on p.oid = k.confrelid
        where k.contype = 'f' and k.connamespace = 'app'::regnamespace
          and p.relnamespace = 'app'::regnamespace and k.confrelid <> 'app.household'::regclass
          and not exists (
            select 1 from pg_constraint u
             where u.conrelid = k.confrelid and u.contype in ('u', 'p') and u.conkey = k.confkey)`,
    )
    expect(rows).toEqual([])
  })
})

describe('表の持ち主・force・権限', () => {
  it('soroban_api は、app のどの表・関数・スキーマも所有していない（持ち主になる経路が無い）', async () => {
    const owned = await db.query<{ what: string }>(
      `select 'table ' || c.relname as what
         from pg_class c join pg_namespace n on n.oid = c.relnamespace, pg_roles r
        where n.nspname = 'app' and r.rolname = 'soroban_api'
          and c.relkind in ('r', 'p', 'v', 'm', 'S') and pg_has_role(r.oid, c.relowner, 'usage')
       union all
       select 'function ' || p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace, pg_roles r
        where n.nspname = 'app' and r.rolname = 'soroban_api' and pg_has_role(r.oid, p.proowner, 'usage')
       union all
       select 'schema app'
         from pg_namespace n, pg_roles r
        where n.nspname = 'app' and r.rolname = 'soroban_api' and pg_has_role(r.oid, n.nspowner, 'usage')`,
    )
    expect(owned.rows).toEqual([])
  })

  it('force が効いている：所有者でない soroban_api からは他世帯が見えず、所有者のロールにも RLS が効く', async () => {
    // 持ち主を BYPASSRLS の無い別のロールに替えて（このトランザクションの中だけ。最後にロールバック）、
    // 持ち主として読む。force が無ければ全世帯が見える
    const result = await db
      .transaction(async (tx) => {
        await tx.query('create role owner_probe nologin')
        await tx.query('grant usage on schema app to owner_probe')
        await tx.query('alter table app.sale owner to owner_probe')

        await tx.query('set local role owner_probe')
        await tx.query("select set_config('app.household_id', $1, true)", [HH_A])
        const forced = (await tx.query<{ household_id: string }>('select household_id from app.sale')).rows

        await tx.query('reset role')
        await tx.query('alter table app.sale no force row level security')
        await tx.query('set local role owner_probe')
        const notForced = (await tx.query<{ household_id: string }>('select household_id from app.sale')).rows

        throw Object.assign(new Error('rollback'), { probe: { forced, notForced } })
      })
      .catch((e: { probe?: { forced: Array<{ household_id: string }>; notForced: Array<{ household_id: string }> } }) => e.probe)

    expect(result).toBeDefined()
    // force あり：所有者でも世帯 A の行だけ
    expect(result!.forced.map((r) => r.household_id)).toEqual([HH_A])
    // 対照（force を外すと所有者は RLS を素通りして全世帯が見える）。force が効いていることの裏付け
    expect(result!.notForced.map((r) => r.household_id).sort()).toEqual([HH_A, HH_B])

    // ロールバックされて、元の持ち主・force に戻っている
    const after = await db.query<{ owner: string; force: boolean }>(
      `select pg_get_userbyid(c.relowner) as owner, c.relforcerowsecurity as force
         from pg_class c where c.oid = 'app.sale'::regclass`,
    )
    expect(after.rows[0]).toEqual({ owner: 'postgres', force: true })
  })

  it('soroban_api に渡している権限は DML（select / insert / update / delete）だけ。DDL・truncate・references・trigger は無い', async () => {
    const { rows } = await db.query<{ privilege_type: string }>(
      `select distinct privilege_type from information_schema.role_table_grants
        where table_schema = 'app' and grantee = 'soroban_api' order by privilege_type`,
    )
    expect(rows.map((r) => r.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
  })

  it('PUBLIC・anon・authenticated に、app のスキーマ・テーブル・シーケンス・関数の権限が何も残っていない', async () => {
    // PUBLIC は has_*_privilege に渡せないので、acl を展開して見る（grantee = 0 が PUBLIC）。
    // acl が NULL のものは既定の権限（関数は PUBLIC に EXECUTE が付く）として acldefault で補う
    const acls = await db.query<{ what: string; grantee: string; privilege: string }>(
      `with acls as (
         select 'schema ' || n.nspname as what, coalesce(n.nspacl, acldefault('n'::"char", n.nspowner)) as acl
           from pg_namespace n where n.nspname = 'app'
         union all
         select 'relation ' || c.relname,
                coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app' and c.relkind in ('r', 'p', 'S')
         union all
         select 'function ' || p.proname, coalesce(p.proacl, acldefault('f'::"char", p.proowner))
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app'
       )
       select what, case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end as grantee, x.privilege_type as privilege
         from acls, aclexplode(acls.acl) x
        where x.grantee = 0 or pg_get_userbyid(x.grantee) in ('anon', 'authenticated')`,
    )
    // 例外は 1 つだけ：storage.objects の方針が呼ぶ app.my_household()（20261012001530_storage.sql）。
    // 引数を取らず、auth.uid() の世帯しか返せない
    expect(acls.rows).toEqual([{ what: 'function my_household', grantee: 'authenticated', privilege: 'EXECUTE' }])
  })

  it('household_member の「自分自身の行」の方針は、関数の持ち主だけに効く。app.user_id を渡した soroban_api にも読めず、書けない', async () => {
    // 20261012001900 で member_self_lookup に TO（持ち主）を付けた。以前は soroban_api も、app.user_id を名乗れば自分の行を読めた
    const own = await asApiWithoutHousehold(db, async (tx) => {
      await tx.query("select set_config('app.user_id', $1, true)", [USER_B])
      return (await tx.query<{ household_id: string; user_id: string }>(
        'select household_id, user_id from app.household_member',
      )).rows
    })
    expect(own).toEqual([])
    // 世帯の文脈の中では、自分の世帯の行だけ（household_isolation）
    const mine = await asApi(db, HH_B, async (tx) => (await tx.query<{ user_id: string }>('select user_id from app.household_member')).rows)
    expect(mine).toEqual([{ user_id: USER_B }])

    // メンバーの追加・変更・削除は、soroban_api からはできない（権限が無い。世帯を作る・メンバーを入れるのは管理画面だけ）
    for (const sql of [
      `insert into app.household_member (household_id, user_id) values ('${HH_B}', '${USER_A}')`,
      `update app.household_member set role = 'member'`,
      'delete from app.household_member',
      `insert into app.household (name) values ('勝手な世帯')`,
      `update app.household set name = 'x'`,
      'delete from app.household',
    ]) {
      expect(await sqlstateOf(() => asApi(db, HH_B, (tx) => tx.query(sql))), sql).toBe('42501')
    }
  })
})

describe('anon / authenticated には何も許可しない', () => {
  for (const role of ['anon', 'authenticated']) {
    it(`${role} は app のテーブルを読めない・書けない`, async () => {
      expect(await sqlstateOf(() => asRole(db, role, (tx) => tx.query('select * from app.sale')))).toBe('42501')
      expect(
        await sqlstateOf(() =>
          asRole(db, role, (tx) => tx.query(`insert into app.tag (household_id, name) values ('${HH_A}', 'x')`)),
        ),
      ).toBe('42501')
      expect(
        await sqlstateOf(() => asRole(db, role, (tx) => tx.query('select * from app.household_member'))),
      ).toBe('42501')
    })

    it(`${role} は app の関数を呼べない`, async () => {
      expect(
        await sqlstateOf(() => asRole(db, role, (tx) => tx.query('select app.enqueue_collect_job()'))),
      ).toBe('42501')
    })
  }

  it('anon / authenticated / PUBLIC に、app のテーブルの権限が 1 つも付いていない', async () => {
    const { rows } = await db.query<{ grantee: string; table_name: string; privilege_type: string }>(
      `select grantee, table_name, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'app' and grantee in ('anon', 'authenticated', 'PUBLIC')`,
    )
    expect(rows).toEqual([])
  })
})

describe('全テーブルに RLS がある', () => {
  it('app の全テーブルで RLS が有効、かつ force（表の持ち主にも効く）', async () => {
    const { rows } = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind = 'r'
          and not (c.relrowsecurity and c.relforcerowsecurity)`,
    )
    expect(rows).toEqual([])
  })

  it('household_id を持つ全テーブルに、世帯を見る using と with check の方針がある', async () => {
    const { rows } = await db.query<{
      tablename: string; polname: string | null; roles: string[] | null
      qual: string | null; with_check: string | null
    }>(
      `select c.relname as tablename, p.polname,
              array(select r.rolname::text from pg_roles r where r.oid = any(p.polroles)) as roles,
              pg_get_expr(p.polqual, p.polrelid) as qual, pg_get_expr(p.polwithcheck, p.polrelid) as with_check
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_policy p on p.polrelid = c.oid
        where n.nspname = 'app' and c.relkind = 'r'
        order by c.relname`,
    )
    const byTable = new Map<string, Array<{ polname: string | null; roles: string[] | null; qual: string | null; with_check: string | null }>>()
    for (const r of rows) {
      const list = byTable.get(r.tablename) ?? []
      list.push(r)
      byTable.set(r.tablename, list)
    }
    expect(byTable.size).toBeGreaterThanOrEqual(36)
    const guard = "current_setting('app.household_id'::text, true)"
    for (const [table, policies] of byTable) {
      // 世帯で絞る方針（using と with check の両方）が 1 つはある。
      // 例外は 2 種類（どちらも名前と対象のロールまで決めてある）：
      //   * 鍵や自分の行から引くための方針（household_member の自分自身の行、agent_device の鍵のハッシュ）
      //   * 世帯をまたいで動く Cron の Worker（soroban_cron）だけの方針。soroban_api には効かない
      const isolating = policies.filter((p) => p.qual?.includes(guard) && p.with_check?.includes(guard))
      expect(isolating.length, `${table} に世帯で絞る方針が無い`).toBe(1)
      const others = policies.filter((p) => !isolating.includes(p) && !(p.roles?.length === 1 && p.roles[0] === 'soroban_cron'))
      const lookups = table === 'household_member' ? ['member_self_lookup']
        : table === 'agent_device' ? ['agent_token_lookup_select', 'agent_token_lookup_update']
        : []
      expect(others.map((p) => p.polname).sort(), `${table} の想定外の方針`).toEqual(lookups)
    }
  })

  it('household_id を持つ全テーブルが、既定値で app.household_id を読み、世帯への外部キー（cascade）を持つ', async () => {
    const { rows } = await db.query<{ table_name: string; column_default: string | null; is_nullable: string }>(
      `select c.table_name, c.column_default, c.is_nullable
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = 'app' and c.column_name = 'household_id' and c.table_name not in ('household_member')
        order by c.table_name`,
    )
    expect(rows.length).toBeGreaterThanOrEqual(34)
    for (const r of rows) {
      expect(r.is_nullable, `${r.table_name}.household_id`).toBe('NO')
      expect(r.column_default, `${r.table_name}.household_id`).toContain("current_setting('app.household_id'")
    }

    const fk = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind = 'r' and c.relname <> 'household'
          and not exists (
            select 1 from pg_constraint k
             where k.conrelid = c.oid and k.contype = 'f'
               and k.confrelid = 'app.household'::regclass and k.confdeltype = 'c')`,
    )
    expect(fk.rows).toEqual([])
  })
})

describe('世帯を消すと、その世帯の全データが消える', () => {
  it('他の世帯には触れずに cascade で全テーブルから消える（NO ACTION の外部キーに阻まれない）', async () => {
    const hhC = '00000000-0000-4000-8000-00000000000c'
    await db.query(`insert into app.household (id, name) values ($1, '消す世帯')`, [hhC])
    const chainC = await asApi(db, hhC, (tx) => insertChain(tx, 'C'))
    await asApi(db, hhC, async (tx) => {
      // 販売に紐付いた在庫（sale_line → inventory_item は NO ACTION の外部キー）
      await tx.query('insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2)', [
        chainC.saleId, chainC.inventoryItemId,
      ])
      // 出品と引き当て
      const listing = await tx.query<{ id: string }>(
        `insert into app.listing (channel_item_id, title, price, first_seen_at, last_seen_at, listed_at)
         values ('mC2', '出品', 2000, '2026-10-01', now(), '2026-10-01') returning id`,
      )
      const spare = await tx.query<{ id: string }>(
        `insert into app.inventory_item (item_code, name, landed_cost, acquired_at)
         values ('S-C2', '予備', 100, '2026-10-01') returning id`,
      )
      await tx.query('insert into app.listing_line (listing_id, inventory_item_id) values ($1, $2)', [
        listing.rows[0].id, spare.rows[0].id,
      ])
      await tx.query('insert into app.collect_job default values')
      await tx.query(`insert into app.setting (key, value) values ('k', 'v')`)
    })

    await db.query('delete from app.household where id = $1', [hhC])

    const { rows: tables } = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind = 'r' and c.relname <> 'household'
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'household_id')`,
    )
    for (const t of tables) {
      const left = await db.query<{ n: number }>(
        `select count(*)::int as n from app.${t.relname} where household_id = $1`,
        [hhC],
      )
      expect(left.rows[0].n, `${t.relname} に消した世帯の行が残っている`).toBe(0)
    }

    // 他の世帯は無事
    const sale = await db.query('select id from app.sale where id in ($1, $2)', [chainA.saleId, chainB.saleId])
    expect(sale.rows).toHaveLength(2)
  })
})
