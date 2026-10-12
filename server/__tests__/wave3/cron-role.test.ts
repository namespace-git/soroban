import type { PGlite, Transaction } from '@electric-sql/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMigratedDb } from '../../test/migrate'
import { insertChain, type Chain } from '../schema/helpers'
import {
  asApi, asCron, asRole, enqueue, HH_A, HH_B, insertSub, seedHouseholds, sqlstateOf, USER_A, USER_B, type Sub,
} from './helpers'

// 定期実行（Cron の Worker）の役割 soroban_cron（20261012001520_cron_role.sql）。
// 世帯をまたいで読む必要がある表にだけ、列まで絞った最小の権限と to soroban_cron の方針を付ける。
// 販売・在庫・仕入の金額の列には何も出さない

let db: PGlite
let chainA: Chain
let chainB: Chain
let subA: Sub
let subB: Sub

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
  chainA = await asApi(db, HH_A, (tx) => insertChain(tx, 'A'))
  chainB = await asApi(db, HH_B, (tx) => insertChain(tx, 'B'))
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec('delete from app.notification_event')
  await db.exec('delete from app.push_subscription')
  await db.exec('delete from app.collect_job')
  await db.exec('delete from app.setting_secret')
  subA = await asApi(db, HH_A, (tx) => insertSub(tx, USER_A, { label: 'iPhone' }))
  subB = await asApi(db, HH_B, (tx) => insertSub(tx, USER_B, { label: 'B の iPhone' }))
})

const denied = (run: () => Promise<unknown>) => sqlstateOf(run)

describe('ロール soroban_cron', () => {
  it('ログインできず、スーパーユーザーでも BYPASSRLS でもない。接続ロール（postgres）がそこへ set role できる', async () => {
    const attr = await db.query(
      `select rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb from pg_roles where rolname = 'soroban_cron'`,
    )
    expect(attr.rows).toEqual([
      { rolsuper: false, rolbypassrls: false, rolcanlogin: false, rolcreaterole: false, rolcreatedb: false },
    ])
    const member = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_auth_members m
         join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
        where r.rolname = 'soroban_cron' and u.rolname = 'postgres'`,
    )
    expect(member.rows[0].n).toBe(1)
    const who = await asCron(db, null, async (tx) => (await tx.query<{ u: string }>('select current_user as u')).rows[0].u)
    expect(who).toBe('soroban_cron')
  })

  it('何も所有していない（表・関数・スキーマ）', async () => {
    const owned = await db.query<{ what: string }>(
      `select 'table ' || c.relname as what
         from pg_class c join pg_namespace n on n.oid = c.relnamespace, pg_roles r
        where n.nspname = 'app' and r.rolname = 'soroban_cron'
          and c.relkind in ('r', 'p', 'v', 'm', 'S') and pg_has_role(r.oid, c.relowner, 'usage')
       union all
       select 'function ' || p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace, pg_roles r
        where n.nspname = 'app' and r.rolname = 'soroban_cron' and pg_has_role(r.oid, p.proowner, 'usage')
       union all
       select 'schema app'
         from pg_namespace n, pg_roles r
        where n.nspname = 'app' and r.rolname = 'soroban_cron' and pg_has_role(r.oid, n.nspowner, 'usage')`,
    )
    expect(owned.rows).toEqual([])
  })

  it('読める表は、通知・取り込み要求・仕入（追跡の列）・仕入の明細（点数）・17TRACK の lease だけ。秘密（暗号文）もビューも読めない', async () => {
    const { rows } = await db.query<{ relname: string; relkind: string; any_col: boolean; insert: boolean; update: boolean; delete: boolean }>(
      `select c.relname, c.relkind::text,
              has_any_column_privilege('soroban_cron', c.oid, 'select') as any_col,
              has_table_privilege('soroban_cron', c.oid, 'insert') as insert,
              has_table_privilege('soroban_cron', c.oid, 'update') as update,
              has_table_privilege('soroban_cron', c.oid, 'delete') as delete
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind in ('r', 'v')
        order by c.relname`,
    )
    expect(rows.length).toBeGreaterThanOrEqual(40)
    const readable = rows.filter((r) => r.any_col).map((r) => r.relname)
    // setting_secret は外した（20261012001900）。17TRACK のキーは withHousehold（soroban_api）の中で読むので、定期実行は暗号文に触れない
    expect(readable).toEqual([
      'collect_job', 'notification_delivery', 'notification_event', 'purchase', 'purchase_line',
      'push_subscription', 'tracking_lease',
    ])
    // 表全体への insert / delete は、必要な表だけ
    expect(rows.filter((r) => r.insert).map((r) => r.relname)).toEqual(['notification_delivery', 'notification_event', 'tracking_lease'])
    expect(rows.filter((r) => r.delete).map((r) => r.relname)).toEqual(['push_subscription', 'tracking_lease'])
  })

  it('販売・在庫・経費・口座・設定・世帯・PC の表には触れない（42501）', async () => {
    for (const t of [
      'sale', 'sale_line', 'inventory_item', 'listing', 'listing_line', 'expense', 'expense_line', 'month_book',
      'cash_account', 'cash_entry', 'liability', 'setting', 'tag', 'shop_account', 'product_name', 'app_log',
      'collector_run', 'household', 'household_member', 'agent_device', 'collect_job_stage', 'setting_secret',
      'sale_profit', 'monthly_summary', 'inventory_view',
    ]) {
      expect(await denied(() => asCron(db, null, (tx) => tx.query(`select 1 from app.${t} limit 1`))), t).toBe('42501')
      expect(await denied(() => asCron(db, HH_A, (tx) => tx.query(`select 1 from app.${t} limit 1`))), `${t}（世帯の文脈つき）`).toBe('42501')
    }
    // 書けない
    expect(await denied(() => asCron(db, HH_A, (tx) => tx.query(`update app.sale set price = 1`)))).toBe('42501')
    expect(await denied(() => asCron(db, HH_A, (tx) => tx.query(`update app.inventory_item set landed_cost = 1`)))).toBe('42501')
    expect(await denied(() => asCron(db, HH_A, (tx) => tx.query(`delete from app.sale`)))).toBe('42501')
  })

  it('仕入の金額（送料・割引・その他費用）と、仕入の明細の単価・按分後の原価は読めない。select * も通らない', async () => {
    for (const sql of [
      'select shipping_fee from app.purchase',
      'select discount from app.purchase',
      'select other_cost from app.purchase',
      'select alloc_method from app.purchase',
      'select ordered_at from app.purchase',
      'select order_no from app.purchase',
      'select import_key from app.purchase',
      'select shop_account_id from app.purchase',
      'select * from app.purchase',
      'select unit_price from app.purchase_line',
      'select allocated_cost from app.purchase_line',
      'select landed_unit_cost from app.purchase_line',
      'select name from app.purchase_line',
      'select * from app.purchase_line',
    ]) {
      expect(await denied(() => asCron(db, HH_A, (tx) => tx.query(sql))), sql).toBe('42501')
    }
  })

  it('列ごとの権限：追跡の列・点数は読め、lease_token・user_agent・金額の列は読めない', async () => {
    const can = async (table: string, column: string): Promise<boolean> =>
      (await db.query<{ ok: boolean }>(
        `select has_column_privilege('soroban_cron', $1::regclass, $2, 'select') as ok`, [`app.${table}`, column],
      )).rows[0].ok
    for (const [t, c] of [
      ['purchase', 'tracking_number'], ['purchase', 'tracking_queued_at'], ['purchase', 'tracking_register_pending_at'],
      ['purchase', 'tracking_registered_at'], ['purchase', 'fulfillment'], ['purchase_line', 'quantity'],
      ['collect_job', 'lease_expires_at'], ['push_subscription', 'endpoint'],
    ]) {
      expect(await can(t, c), `${t}.${c}`).toBe(true)
    }
    for (const [t, c] of [
      ['collect_job', 'lease_token'], ['push_subscription', 'user_agent'], ['purchase', 'shipping_fee'],
      ['purchase', 'discount'], ['purchase_line', 'unit_price'], ['purchase_line', 'landed_unit_cost'],
      ['inventory_item', 'landed_cost'], ['sale', 'price'], ['sale', 'fee'],
      ['setting_secret', 'ciphertext'], ['setting_secret', 'iv'], ['setting_secret', 'key_version'],
    ]) {
      expect(await can(t, c), `${t}.${c}`).toBe(false)
    }
  })
})

describe('世帯をまたいで読める（通知）', () => {
  it('配送・出来事・購読が、世帯を渡さなくても両方の世帯ぶん見える。soroban_api は自分の世帯だけ', async () => {
    await enqueue(db, HH_A, 'sale', 'sale:a')
    await enqueue(db, HH_B, 'sale', 'sale:b')

    const cron = await asCron(db, null, async (tx) => ({
      deliveries: (await tx.query<{ household_id: string }>('select household_id from app.notification_delivery order by household_id')).rows.map((r) => r.household_id),
      events: (await tx.query<{ household_id: string }>('select household_id from app.notification_event order by household_id')).rows.map((r) => r.household_id),
      subs: (await tx.query<{ id: string }>('select id from app.push_subscription')).rows.map((r) => r.id).sort(),
    }))
    expect(cron).toEqual({
      deliveries: [HH_A, HH_B], events: [HH_A, HH_B], subs: [subA.id, subB.id].sort(),
    })

    const api = await asApi(db, HH_A, async (tx) =>
      (await tx.query<{ household_id: string }>('select household_id from app.notification_delivery')).rows)
    expect(api).toEqual([{ household_id: HH_A }])
  })

  it('claim_deliveries を世帯を渡さずに呼ぶと、両方の世帯の配送を 1 回で取れる。complete も世帯をまたいで書ける', async () => {
    await enqueue(db, HH_A, 'sale', 'sale:a')
    await enqueue(db, HH_B, 'sale', 'sale:b')

    const claimed = await asCron(db, null, async (tx) =>
      (await tx.query<{ delivery_id: string; household_id: string; endpoint: string }>('select delivery_id, household_id, endpoint from app.claim_deliveries(10)')).rows)
    expect(claimed.map((c) => c.household_id).sort()).toEqual([HH_A, HH_B])
    expect(claimed.map((c) => c.endpoint).sort()).toEqual([subA.endpoint, subB.endpoint].sort())

    // 1 本の接続で、世帯 A は送れた・世帯 B は 410
    const a = claimed.find((c) => c.household_id === HH_A)!
    const b = claimed.find((c) => c.household_id === HH_B)!
    const results = await asCron(db, null, async (tx) => ({
      a: (await tx.query<{ s: string }>('select app.complete_delivery($1, true, null, false) as s', [a.delivery_id])).rows[0].s,
      b: (await tx.query<{ s: string }>(`select app.complete_delivery($1, false, 'HTTP 410', true) as s`, [b.delivery_id])).rows[0].s,
    }))
    expect(results).toEqual({ a: 'sent', b: 'gone' })

    const subs = await db.query<{ id: string; last_used_at: string | null }>('select id, last_used_at from app.push_subscription')
    expect(subs.rows.map((r) => r.id)).toEqual([subA.id]) // B の購読は 410 で消えた
    expect(subs.rows[0].last_used_at).not.toBeNull()
    const dels = await db.query<{ status: string; household_id: string }>('select status, household_id from app.notification_delivery')
    expect(dels.rows).toEqual([{ status: 'sent', household_id: HH_A }])
  })

  it('配送の状態（status など）は更新できるが、household_id・event_id・subscription_id は書き換えられない。配送・出来事は消せない', async () => {
    const id = (await enqueue(db, HH_A, 'sale', 'sale:a'))!
    expect(await denied(() => asCron(db, null, (tx) => tx.query(`update app.notification_delivery set household_id = '${HH_B}'`)))).toBe('42501')
    expect(await denied(() => asCron(db, null, (tx) => tx.query(`update app.notification_delivery set event_id = gen_random_uuid()`)))).toBe('42501')
    expect(await denied(() => asCron(db, null, (tx) => tx.query(`update app.notification_delivery set subscription_id = gen_random_uuid()`)))).toBe('42501')
    expect(await denied(() => asCron(db, null, (tx) => tx.query('delete from app.notification_delivery')))).toBe('42501')
    expect(await denied(() => asCron(db, null, (tx) => tx.query('delete from app.notification_event')))).toBe('42501')
    expect(await denied(() => asCron(db, null, (tx) => tx.query(`update app.notification_event set title = 'x'`)))).toBe('42501')
    // 状態は更新できる
    const n = await asCron(db, null, async (tx) =>
      (await tx.query(`update app.notification_delivery set status = 'sending', claimed_at = now(), attempts = 1 where event_id = $1`, [id])).affectedRows)
    expect(n).toBe(1)
  })

  it('購読は読み・last_used_at の更新・削除だけ。endpoint や鍵は書き換えられず、新しく作れない。user_agent は読めない', async () => {
    expect(await denied(() => asCron(db, null, (tx) => tx.query(`update app.push_subscription set endpoint = 'https://evil.example.test'`)))).toBe('42501')
    expect(await denied(() => asCron(db, null, (tx) => tx.query(`update app.push_subscription set kind_sale = false`)))).toBe('42501')
    expect(await denied(() => asCron(db, null, (tx) => tx.query(`update app.push_subscription set household_id = '${HH_B}'`)))).toBe('42501')
    expect(await denied(() => asCron(db, HH_A, (tx) => tx.query(
      `insert into app.push_subscription (user_id, endpoint, p256dh, auth) values ('${USER_A}', 'https://push.example.test/x', 'p', 'a')`)))).toBe('42501')
    expect(await denied(() => asCron(db, null, (tx) => tx.query('select user_agent from app.push_subscription')))).toBe('42501')
    expect(await denied(() => asCron(db, null, (tx) => tx.query('select * from app.push_subscription')))).toBe('42501')
    const touched = await asCron(db, null, async (tx) =>
      (await tx.query('update app.push_subscription set last_used_at = now()')).affectedRows)
    expect(touched).toBe(2)
  })

  it('enqueue_notification を世帯 A の文脈で呼ぶと、世帯 A の購読にだけ配送を作る（世帯をまたいで読めても、B の端末には作らない）', async () => {
    const id = await asCron(db, HH_A, async (tx) =>
      (await tx.query<{ id: string }>(`select app.enqueue_notification('arrival', 'メロジョイの荷物が届きました（3 点）', '', '/purchases', 'arrival:p1') as id`)).rows[0].id)
    expect(id).not.toBeNull()
    const dels = await db.query<{ household_id: string; subscription_id: string }>(
      'select household_id, subscription_id from app.notification_delivery where event_id = $1', [id],
    )
    expect(dels.rows).toEqual([{ household_id: HH_A, subscription_id: subA.id }])
    const ev = await db.query<{ household_id: string }>('select household_id from app.notification_event where id = $1', [id])
    expect(ev.rows).toEqual([{ household_id: HH_A }])
  })

  it('世帯の文脈なしでは出来事を積めない（どの世帯のものか決まらない）', async () => {
    const code = await denied(() => asCron(db, null, (tx) =>
      tx.query(`select app.enqueue_notification('sale', 't', '', null, 'sale:nohh')`)))
    expect(code).not.toBeNull()
    expect((await db.query('select 1 from app.notification_event')).rows).toEqual([])
  })
})

describe('世帯をまたいで読める（取り込み要求の片付け・秘密・仕入の追跡）', () => {
  it('reap：世帯を渡さずに呼ぶと、両方の世帯の期限切れ（running の lease 切れ・queued の時間切れ）を 1 回で片付ける', async () => {
    const a = await asApi(db, HH_A, async (tx) => {
      await tx.query('select app.enqueue_collect_job()')
      return (await tx.query<{ id: string }>(`select (app.claim_collect_job('pc-a')).id as id`)).rows[0].id
    })
    const b = await asApi(db, HH_B, async (tx) =>
      (await tx.query<{ id: string }>('select (app.enqueue_collect_job()).id as id')).rows[0].id)
    await db.query(`update app.collect_job set lease_expires_at = now() - interval '1 minute' where id = $1`, [a])
    await db.query(`update app.collect_job set requested_at = now() - interval '6 minutes' where id = $1`, [b])

    const n = await asCron(db, null, async (tx) => (await tx.query<{ n: number }>('select app.reap_stale_collect_jobs() as n')).rows[0].n)
    expect(n).toBe(2)
    const rows = await db.query<{ id: string; status: string; result: Record<string, unknown> }>('select id, status, result from app.collect_job order by status')
    expect(rows.rows.find((r) => r.id === a)).toMatchObject({ status: 'failed', result: { reaped: true, reason: 'lease_expired' } })
    expect(rows.rows.find((r) => r.id === b)).toMatchObject({ status: 'cancelled', result: { reaped: true, reason: 'queued_timeout' } })
  })

  it('取り込み要求は読めるが lease_token は読めない。片付け以外（status / finished_at / result 以外）は書けず、取る・延ばす・終える関数も呼べない', async () => {
    await asApi(db, HH_A, (tx) => tx.query('select app.enqueue_collect_job()'))
    const seen = await asCron(db, null, async (tx) =>
      (await tx.query<{ status: string; household_id: string }>('select status, household_id from app.collect_job')).rows)
    expect(seen).toEqual([{ status: 'queued', household_id: HH_A }])

    expect(await denied(() => asCron(db, null, (tx) => tx.query('select lease_token from app.collect_job')))).toBe('42501')
    expect(await denied(() => asCron(db, null, (tx) => tx.query('select * from app.collect_job')))).toBe('42501')
    expect(await denied(() => asCron(db, null, (tx) => tx.query(`update app.collect_job set agent_id = 'x'`)))).toBe('42501')
    expect(await denied(() => asCron(db, null, (tx) => tx.query(`update app.collect_job set lease_expires_at = now() + interval '1 day'`)))).toBe('42501')
    expect(await denied(() => asCron(db, null, (tx) => tx.query('insert into app.collect_job default values')))).toBe('42501')
    expect(await denied(() => asCron(db, null, (tx) => tx.query('delete from app.collect_job')))).toBe('42501')

    for (const sql of [
      `select app.claim_collect_job('x')`,
      'select app.heartbeat_collect_job(gen_random_uuid(), gen_random_uuid())',
      `select app.finish_collect_job(gen_random_uuid(), gen_random_uuid(), 'done')`,
      'select app.assert_lease(gen_random_uuid(), gen_random_uuid())',
      `select app.begin_stage(gen_random_uuid(), gen_random_uuid(), 'k')`,
      'select app.enqueue_collect_job()',
      'select app.cancel_collect_job(gen_random_uuid())',
      'select * from app.agent_of_token(null)',
      `select app.register_agent_device('PC', repeat('a', 64), now() + interval '1 hour')`,
      'select app.household_of_user(null)',
      'select app.my_household()',
    ]) {
      expect(await denied(() => asCron(db, HH_A, (tx) => tx.query(sql))), sql).toBe('42501')
    }
  })

  it('setting_secret：定期実行は暗号文に触れない（世帯の文脈つきでも）。soroban_api は自分の世帯の分だけ', async () => {
    // 以前は世帯をまたいで暗号文・版・方式を読めた。コード（server/cron/tracking.ts）は使っていなかったので外した（20261012001900）。
    // 17TRACK のキーは withHousehold（soroban_api）の中で読む
    const put = (v: number) => (tx: Transaction) =>
      tx.query(`insert into app.setting_secret (key, ciphertext, iv, key_version) values ('track17_api_key', '\\x0102'::bytea, '\\x0a0b'::bytea, $1)`, [v])
    await asApi(db, HH_A, put(1))
    await asApi(db, HH_B, put(2))

    for (const sql of [
      'select household_id, key, key_version, alg from app.setting_secret',
      'select ciphertext from app.setting_secret',
      'select iv from app.setting_secret',
      'select * from app.setting_secret',
      'select count(*) from app.setting_secret',
    ]) {
      expect(await denied(() => asCron(db, null, (tx) => tx.query(sql))), sql).toBe('42501')
      expect(await denied(() => asCron(db, HH_A, (tx) => tx.query(sql))), `${sql}（世帯の文脈つき）`).toBe('42501')
    }
    // 書けない
    expect(await denied(() => asCron(db, HH_A, put(1)))).toBe('42501')
    expect(await denied(() => asCron(db, HH_A, (tx) => tx.query(`update app.setting_secret set key_version = 9`)))).toBe('42501')
    expect(await denied(() => asCron(db, HH_A, (tx) => tx.query(`delete from app.setting_secret`)))).toBe('42501')
    // 方針も外してある（cron_read が残っていない）
    const policies = await db.query<{ polname: string }>(
      `select polname from pg_policy where polrelid = 'app.setting_secret'::regclass order by polname`)
    expect(policies.rows).toEqual([{ polname: 'household_isolation' }])
    // 暗号文は soroban_api の側でも他の世帯からは見えない
    const seenByApi = await asApi(db, HH_A, async (tx) => (await tx.query('select household_id from app.setting_secret')).rows)
    expect(seenByApi).toEqual([{ household_id: HH_A }])
  })

  it('仕入：追跡の列だけ、世帯をまたいで読める。書くのは世帯の文脈の中だけ（世帯を渡さない更新は 0 行）', async () => {
    await db.query(`update app.purchase set tracking_number = 'JP1234', tracking_queued_at = now() where id in ($1, $2)`, [chainA.purchaseId, chainB.purchaseId])

    const queue = await asCron(db, null, async (tx) =>
      (await tx.query<{ id: string; household_id: string; tracking_number: string }>(
        'select id, household_id, tracking_number from app.purchase where tracking_queued_at is not null order by household_id')).rows)
    expect(queue).toEqual([
      { id: chainA.purchaseId, household_id: HH_A, tracking_number: 'JP1234' },
      { id: chainB.purchaseId, household_id: HH_B, tracking_number: 'JP1234' },
    ])

    // 世帯を渡さない更新：読めても書けない（0 行）
    const none = await asCron(db, null, async (tx) =>
      (await tx.query(`update app.purchase set tracking_status = '配達中' where tracking_queued_at is not null`)).affectedRows)
    expect(none).toBe(0)

    // 世帯 A の文脈：A の行だけ書ける。B の id を指しても 0 行
    const mine = await asCron(db, HH_A, async (tx) => {
      const a = (await tx.query(`update app.purchase set tracking_status = '配達中', tracking_checked_at = now(), tracking_queued_at = null where id = $1`, [chainA.purchaseId])).affectedRows
      const b = (await tx.query(`update app.purchase set tracking_status = '配達中' where id = $1`, [chainB.purchaseId])).affectedRows
      return { a, b }
    })
    expect(mine).toEqual({ a: 1, b: 0 })
    const after = await db.query<{ household_id: string; tracking_status: string | null; tracking_queued_at: string | null }>(
      'select household_id, tracking_status, tracking_queued_at from app.purchase order by household_id')
    expect(after.rows[0]).toMatchObject({ household_id: HH_A, tracking_status: '配達中', tracking_queued_at: null })
    expect(after.rows[1]).toMatchObject({ household_id: HH_B, tracking_status: null })
    expect(after.rows[1].tracking_queued_at).not.toBeNull()
  })

  it('仕入：到着の状態（fulfillment・delivered_at）も世帯の文脈の中で書ける。金額・日付・仕入先など追跡以外の列は書けず、作れず、消せない', async () => {
    await asCron(db, HH_A, (tx) => tx.query(
      `update app.purchase set fulfillment = 'delivered', fulfillment_updated_at = now(), delivered_at = '2026-10-10', updated_at = now() where id = $1`, [chainA.purchaseId]))
    const p = await db.query<{ fulfillment: string; delivered_at: string }>('select fulfillment, delivered_at::text as delivered_at from app.purchase where id = $1', [chainA.purchaseId])
    expect(p.rows[0]).toEqual({ fulfillment: 'delivered', delivered_at: '2026-10-10' })

    for (const sql of [
      'update app.purchase set shipping_fee = 0',
      'update app.purchase set discount = 0',
      'update app.purchase set ordered_at = now()',
      'update app.purchase set tracking_number = $$X$$',
      'update app.purchase set tracking_carrier = $$X$$',
      'update app.purchase set note = $$X$$',
      'update app.purchase set status = $$draft$$',
      'update app.purchase set household_id = gen_random_uuid()',
      'delete from app.purchase',
      `insert into app.purchase (shop_account_id, ordered_at) values ('${chainA.shopAccountId}', '2026-10-01')`,
      'update app.purchase_line set quantity = 9',
    ]) {
      expect(await denied(() => asCron(db, HH_A, (tx) => tx.query(sql))), sql).toBe('42501')
    }
  })

  it('仕入の明細は点数（quantity）だけ読める。世帯の文脈の中の分だけ（世帯を渡さなければ 0 行）', async () => {
    const without = await asCron(db, null, async (tx) => (await tx.query('select quantity from app.purchase_line')).rows)
    expect(without).toEqual([])
    const withA = await asCron(db, HH_A, async (tx) =>
      (await tx.query<{ household_id: string; purchase_id: string; quantity: number }>('select household_id, purchase_id, quantity from app.purchase_line')).rows)
    expect(withA).toEqual([{ household_id: HH_A, purchase_id: chainA.purchaseId, quantity: 1 }])
  })
})

describe('anon / authenticated と、定期実行の関数', () => {
  it('anon / authenticated は、Wave 3a で増えた表を何も読めない・書けない', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const t of ['agent_device', 'collect_job_stage', 'notification_event', 'notification_delivery', 'tracking_lease', 'push_subscription', 'setting_secret', 'collect_job']) {
        expect(await denied(() => asRole(db, role, (tx) => tx.query(`select 1 from app.${t}`))), `${role} ${t}`).toBe('42501')
        expect(await denied(() => asRole(db, role, (tx) => tx.query(`delete from app.${t}`))), `${role} ${t}`).toBe('42501')
      }
    }
  })

  it('soroban_cron が呼べる関数は、決めた 6 つだけ（引き当て・要求の取得・PC の鍵・世帯の照会は呼べない）', async () => {
    const { rows } = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p
        where p.pronamespace = 'app'::regnamespace and has_function_privilege('soroban_cron', p.oid, 'execute')
        order by p.proname`,
    )
    expect(rows.map((r) => r.proname)).toEqual([
      'acquire_tracking_lease', 'claim_deliveries', 'complete_delivery', 'enqueue_notification',
      'reap_stale_collect_jobs', 'release_tracking_lease',
    ])
  })

  it('soroban_api の方は、世帯をまたぐ方針の影響を受けない（世帯 A の文脈からは B の追跡の列も見えない）', async () => {
    await db.query(`update app.purchase set tracking_number = 'JP1234', tracking_queued_at = now()`)
    const seen = await asApi(db, HH_A, async (tx) =>
      (await tx.query<{ household_id: string }>('select household_id from app.purchase where tracking_queued_at is not null')).rows)
    expect(seen).toEqual([{ household_id: HH_A }])
  })
})
