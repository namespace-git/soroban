import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { createMigratedDb, createSupabaseStubs, listMigrations, migrate } from '../../test/migrate'

describe('マイグレーション', () => {
  it('Supabase CLI の命名で、名前順に並ぶ', () => {
    const names = listMigrations().map((m) => m.name)
    expect(names.length).toBeGreaterThan(0)
    expect(names).toEqual([...names].sort())
  })

  it('エラー無く最後まで流れる', async () => {
    const db = new PGlite()
    await createSupabaseStubs(db)
    const applied = await migrate(db)
    expect(applied).toEqual(listMigrations().map((m) => m.name))
    await db.close()
  })
})

describe('流した後の形', () => {
  let db: PGlite
  beforeAll(async () => {
    db = await createMigratedDb()
  })
  afterAll(async () => {
    await db.close()
  })

  it('スキーマ app に、SQLite から移した 30 テーブル＋ Web 用の 8 テーブル＋世帯の 2 テーブルがある', async () => {
    const { rows } = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind = 'r' order by c.relname`,
    )
    expect(rows.map((r) => r.relname)).toEqual(
      [
        // SQLite から移したもの（app_log 含む 30）
        'app_log', 'cash_account', 'cash_entry', 'collector_run', 'expense', 'expense_line',
        'inventory_item', 'inventory_tag', 'liability', 'liability_settlement', 'listing',
        'listing_line', 'mellojoy_excluded_order', 'month_book', 'product_image', 'product_name',
        'product_tag', 'purchase', 'purchase_line', 'purchase_tag', 'sale', 'sale_exclusion',
        'sale_line', 'sale_tag', 'setting', 'shipping_method', 'shop_account', 'shop_account_tag',
        'shop_alias', 'tag',
        // Web 化で新しく要るもの
        'collect_job', 'push_subscription', 'setting_secret',
        // 取り込み担当・通知・17TRACK のキュー（Wave 3a）
        'agent_device', 'collect_job_stage', 'notification_delivery', 'notification_event', 'tracking_lease',
        // 世帯
        'household', 'household_member',
      ].sort(),
    )
  })

  it('soroban_api は BYPASSRLS なしのログインできないロール。接続ロール（postgres）がそこへ set role できる', async () => {
    const attr = await db.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
      `select rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb from pg_roles where rolname = 'soroban_api'`,
    )
    expect(attr.rows).toEqual([
      { rolsuper: false, rolbypassrls: false, rolcanlogin: false, rolcreaterole: false, rolcreatedb: false },
    ])
    const member = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_auth_members m
         join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
        where r.rolname = 'soroban_api' and u.rolname = 'postgres'`,
    )
    expect(member.rows[0].n).toBe(1)
  })

  it('土台のロール・権限の部分は何度流しても失敗しない（冪等）', async () => {
    const foundation = listMigrations().find((m) => m.name.includes('app_foundation'))!
    const head = foundation.sql.slice(0, foundation.sql.indexOf('-- 権限'))
    expect(head).toContain('grant soroban_api to postgres')
    await db.exec(head)
    await db.exec(head)
    const member = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_auth_members m
         join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
        where r.rolname = 'soroban_api' and u.rolname = 'postgres'`,
    )
    expect(member.rows[0].n).toBe(1)
  })

  it('app 以外（public）にテーブルを作っていない', async () => {
    const { rows } = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')`,
    )
    expect(rows).toEqual([])
  })
})
