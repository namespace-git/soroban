import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createMigratedDb } from '../../test/migrate'
import {
  asApi, asApiWithoutHousehold, asRole, HH_A, HH_B, insertChain, seedHouseholds, sqlstateOf, type Chain,
} from '../schema/helpers'
import { VIEW_NAMES } from './helpers'

// ビューは security_invoker：読む人（soroban_api）の権限で元の表の RLS が効く。
// 世帯 A の文脈では、世帯 B の販売・在庫・集計がビューに 1 行も出ない（逆も）

let db: PGlite
let chainA: Chain
let chainB: Chain

/** 世帯の中の最小の鎖（販売 1 件・在庫 1 点・紐付け・型番名）を、完了済みにして作る。B は金額を変える */
async function build(householdId: string, suffix: string, price: number): Promise<Chain> {
  return asApi(db, householdId, async (tx) => {
    const chain = await insertChain(tx, suffix)
    await tx.query(`update app.sale set price = $1, status = 'completed' where id = $2`, [price, chain.saleId])
    await tx.query('insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2)', [
      chain.saleId, chain.inventoryItemId,
    ])
    await tx.query(`insert into app.product_name (model_code, name, updated_at) values ('A037', $1, now())`, [`表示名${suffix}`])
    return chain
  })
}

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
  chainA = await build(HH_A, 'A', 3000)
  chainB = await build(HH_B, 'B', 99999)
})

afterAll(async () => {
  await db.close()
})

describe('ビュー越しに他の世帯が見えない', () => {
  it('世帯 A の文脈：5 本とも A の行だけ。B の販売・在庫・金額が混ざらない', async () => {
    const r = await asApi(db, HH_A, async (tx) => {
      const one = async (sql: string) => (await tx.query<Record<string, unknown>>(sql)).rows
      return {
        sale_profit: await one('select id, price, household_id from app.sale_profit'),
        monthly_summary: await one('select month, kind, sales_count, revenue, household_id from app.monthly_summary'),
        inventory_view: await one('select id, household_id from app.inventory_view'),
        sale_line_share: await one('select sale_id, price_share, household_id from app.sale_line_share'),
        variant_summary: await one('select model_code, name, sold, total_profit, household_id from app.variant_summary'),
      }
    })
    expect(r.sale_profit).toEqual([{ id: chainA.saleId, price: 3000, household_id: HH_A }])
    // B の 99,999 円が足されていない（RLS が効いていなければ 102,999 円・2 件になる）
    expect(r.monthly_summary).toEqual([{ month: '2026-10', kind: 'resale', sales_count: 1, revenue: 3000, household_id: HH_A }])
    expect(r.inventory_view).toEqual([{ id: chainA.inventoryItemId, household_id: HH_A }])
    expect(r.sale_line_share).toEqual([{ sale_id: chainA.saleId, price_share: 3000, household_id: HH_A }])
    // 型番 A037 は両方の世帯にあるが、A には A の表示名・A の 1 点だけ
    // 粗利 = 3,000 − 手数料 300 − 原価 1,500 = 1,200
    expect(r.variant_summary).toEqual([
      { model_code: 'A037', name: '表示名A', sold: 1, total_profit: 1200, household_id: HH_A },
    ])
  })

  it('世帯 B の文脈：B の行だけ', async () => {
    const r = await asApi(db, HH_B, async (tx) => ({
      sales: (await tx.query<{ id: string; price: number }>('select id, price from app.sale_profit')).rows,
      monthly: (await tx.query<{ revenue: number; sales_count: number }>('select revenue, sales_count from app.monthly_summary')).rows,
      variants: (await tx.query<{ name: string }>('select name from app.variant_summary')).rows,
    }))
    expect(r.sales).toEqual([{ id: chainB.saleId, price: 99999 }])
    expect(r.monthly).toEqual([{ revenue: 99999, sales_count: 1 }])
    expect(r.variants).toEqual([{ name: '表示名B' }])
  })

  for (const view of VIEW_NAMES) {
    it(`${view}：A の文脈で household_id が A 以外の行は 0 行、B の文脈でも同じ`, async () => {
      for (const [mine, other] of [[HH_A, HH_B], [HH_B, HH_A]]) {
        const n = await asApi(db, mine, async (tx) => ({
          all: (await tx.query<{ n: number }>(`select count(*)::int as n from app.${view}`)).rows[0].n,
          other: (await tx.query<{ n: number }>(`select count(*)::int as n from app.${view} where household_id = $1`, [other])).rows[0].n,
        }))
        expect(n.other).toBe(0)
        expect(n.all).toBeGreaterThan(0)
      }
    })
  }

  it('世帯を渡し忘れたら、ビューは 1 行も返さない（開けっ放しにならない）', async () => {
    for (const view of VIEW_NAMES) {
      const rows = await asApiWithoutHousehold(db, (tx) => tx.query(`select * from app.${view}`)).then(
        (r) => r.rows,
        () => [] as unknown[],
      )
      expect(rows, view).toEqual([])
    }
  })

  it('対照：security_invoker を外すと、ビューの持ち主の権限で読まれて他の世帯が見える（だからこの設定が要る）', async () => {
    const probe = await db
      .transaction(async (tx) => {
        await tx.query('alter view app.monthly_summary set (security_invoker = false)')
        await tx.query('alter view app.sale_profit set (security_invoker = false)')
        await tx.query('set local role soroban_api')
        await tx.query("select set_config('app.household_id', $1, true)", [HH_A])
        const monthly = (await tx.query<{ revenue: number }>('select revenue from app.monthly_summary')).rows
        const sales = (await tx.query<{ n: number }>('select count(*)::int as n from app.sale_profit')).rows[0].n
        throw Object.assign(new Error('rollback'), { probe: { monthly, sales } })
      })
      .catch((e: { probe?: { monthly: Array<{ revenue: number }>; sales: number } }) => e.probe)
    expect(probe).toBeDefined()
    expect(probe!.sales).toBe(2) // A の文脈なのに B の販売まで見える
    // 世帯ごとに集計しているので合算はされない（A の行と B の行が別々に出る）が、B の 99,999 円が見えてしまう
    expect(probe!.monthly.map((m) => m.revenue).sort((a, b) => a - b)).toEqual([3000, 99999])

    // ロールバックされて、元に戻っている
    const reloptions = await db.query<{ relname: string; reloptions: string[] | null }>(
      `select relname, reloptions from pg_class where relnamespace = 'app'::regnamespace
        and relname in ('monthly_summary', 'sale_profit') order by relname`)
    for (const r of reloptions.rows) expect(r.reloptions, r.relname).toContain('security_invoker=true')
  })
})

describe('権限', () => {
  it('5 本とも security_invoker=true で作られている', async () => {
    const { rows } = await db.query<{ relname: string; reloptions: string[] | null }>(
      `select relname, reloptions from pg_class
        where relnamespace = 'app'::regnamespace and relkind = 'v' order by relname`)
    expect(rows.map((r) => r.relname)).toEqual([...VIEW_NAMES].sort())
    for (const r of rows) expect(r.reloptions, r.relname).toContain('security_invoker=true')
  })

  it('soroban_api に渡しているのは select だけ。PUBLIC・anon・authenticated には何も出ていない', async () => {
    const { rows } = await db.query<{ grantee: string; table_name: string; privilege_type: string }>(
      `select grantee, table_name, privilege_type from information_schema.role_table_grants
        where table_schema = 'app' and table_name = any($1) order by table_name, grantee, privilege_type`,
      [[...VIEW_NAMES]],
    )
    // information_schema には持ち主（postgres）の分も出るので、持ち主以外を見る
    const others = rows.filter((r) => r.grantee !== 'postgres')
    expect(others).toEqual(
      [...VIEW_NAMES].sort().map((t) => ({ grantee: 'soroban_api', table_name: t, privilege_type: 'SELECT' })),
    )
  })

  it('anon / authenticated はビューを読めない', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const view of VIEW_NAMES) {
        expect(await sqlstateOf(() => asRole(db, role, (tx) => tx.query(`select * from app.${view}`))), `${role} ${view}`)
          .toBe('42501')
      }
    }
  })

  it('soroban_api でもビューには書けない', async () => {
    // 42501 = 権限なし、55000 = 集計や結合を含むので更新できないビュー。どちらでも書けない
    const refused = ['42501', '55000']
    expect(refused).toContain(await sqlstateOf(() => asApi(db, HH_A, (tx) => tx.query('delete from app.sale_profit'))))
    expect(refused).toContain(await sqlstateOf(() => asApi(db, HH_A, (tx) => tx.query(`update app.inventory_view set name = 'x'`))))
    expect(refused).toContain(await sqlstateOf(() => asApi(db, HH_A, (tx) => tx.query(`insert into app.monthly_summary (month) values ('2026-01')`))))
    // 権限としても、insert / update / delete は付いていない
    const { rows } = await db.query<{ ok: boolean }>(
      `select bool_or(has_table_privilege('soroban_api', 'app.' || v, p)) as ok
         from unnest($1::text[]) v, unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p`,
      [[...VIEW_NAMES]],
    )
    expect(rows[0].ok).toBe(false)
  })

  it('ビューの持ち主は soroban_api ではない（持ち主なら RLS をすり抜ける）', async () => {
    const { rows } = await db.query<{ relname: string; owner: string }>(
      `select relname, pg_get_userbyid(relowner) as owner from pg_class
        where relnamespace = 'app'::regnamespace and relkind = 'v'`)
    expect(rows.length).toBe(VIEW_NAMES.length)
    for (const r of rows) expect(r.owner, r.relname).not.toBe('soroban_api')
  })
})
