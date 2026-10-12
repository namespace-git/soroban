import type { PGlite, Transaction } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMigratedDb, listMigrations } from '../../test/migrate'
import { asApi, HH_A, HH_B, insertSub, seedHouseholds, sqlstateOf, USER_A, USER_B } from './helpers'

// Wave 3a で増えた表・列の形（20261012001500〜001530）。個々の振る舞いは同じ wave3/ の他のテストにある

let db: PGlite

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
})

afterAll(async () => {
  await db.close()
})

describe('マイグレーションの置き場所', () => {
  it('Wave 3a のファイルは 001500〜001599 の番号に収まる', () => {
    const mine = listMigrations().filter((m) => /^202610120015\d\d_/.test(m.name)).map((m) => m.name)
    expect(mine).toEqual([
      '20261012001500_agent_push_cron.sql',
      '20261012001510_notification.sql',
      '20261012001520_cron_role.sql',
      '20261012001530_storage.sql',
    ])
  })
})

describe('setting_secret（版と方式）', () => {
  it('key_version は not null で既定値なし（書くたびに版を明示する）。alg の既定は aes-256-gcm', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'app' and table_name = 'setting_secret' and column_name in ('key_version', 'alg') order by column_name`,
    )
    expect(rows).toEqual([
      { column_name: 'alg', data_type: 'text', is_nullable: 'NO', column_default: "'aes-256-gcm'::text" },
      { column_name: 'key_version', data_type: 'integer', is_nullable: 'NO', column_default: null },
    ])
  })

  it('版を渡さなければ入らない（not null）。版は 1 以上。方式は aes-256-gcm だけ', async () => {
    const put = (version: string, alg?: string) => (tx: Transaction) =>
      tx.query(
        `insert into app.setting_secret (key, ciphertext, iv${version === 'omit' ? '' : ', key_version'}${alg ? ', alg' : ''})
         values ('k-' || gen_random_uuid(), '\\x01'::bytea, '\\x02'::bytea${version === 'omit' ? '' : `, ${version}`}${alg ? `, '${alg}'` : ''})`)
    expect(await sqlstateOf(() => asApi(db, HH_A, put('omit')))).toBe('23502')
    expect(await sqlstateOf(() => asApi(db, HH_A, put('0')))).toBe('23514')
    expect(await sqlstateOf(() => asApi(db, HH_A, put('-1')))).toBe('23514')
    expect(await sqlstateOf(() => asApi(db, HH_A, put('1', 'aes-128-cbc')))).toBe('23514')
    await expect(asApi(db, HH_A, put('1'))).resolves.toBeDefined()
    await expect(asApi(db, HH_A, put('3', 'aes-256-gcm'))).resolves.toBeDefined()
  })

  it('平文の列は無い（暗号文・iv・版・方式だけ）', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'app' and table_name = 'setting_secret' order by ordinal_position`,
    )
    expect(rows.map((r) => r.column_name)).toEqual(['household_id', 'key', 'ciphertext', 'iv', 'updated_at', 'key_version', 'alg'])
  })
})

describe('collect_job', () => {
  it('status に partial が増え、queued / running / done / failed / cancelled は変わらない', async () => {
    const { rows } = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'app.collect_job'::regclass and conname = 'collect_job_status_check'`,
    )
    expect(rows).toHaveLength(1)
    for (const s of ['queued', 'running', 'done', 'partial', 'failed', 'cancelled']) expect(rows[0].def).toContain(`'${s}'`)
  })

  it('agent_device_id は agent_device への複合外部キー（household_id を含む）', async () => {
    const { rows } = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'app.collect_job'::regclass and conname = 'collect_job_agent_device_fk'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].def).toContain('FOREIGN KEY (household_id, agent_device_id) REFERENCES app.agent_device(household_id, id)')
  })
})

describe('世帯を消すと、Wave 3a の表の行も全部消える', () => {
  it('agent_device・collect_job_stage・notification_event / delivery・tracking_lease・取った PC つきの job', async () => {
    const hhC = '00000000-0000-4000-8000-00000000000c'
    const userC = '00000000-0000-4000-8000-0000000000c1'
    await db.query(`insert into auth.users (id, email) values ($1, 'c@example.test')`, [userC])
    await db.query(`insert into app.household (id, name) values ($1, '消す世帯')`, [hhC])
    await db.query(`insert into app.household_member (household_id, user_id, role) values ($1, $2, 'owner')`, [hhC, userC])

    await asApi(db, hhC, async (tx) => {
      const dev = (await tx.query<{ id: string }>(
        `select (app.register_agent_device('PC', repeat('c', 64), now() + interval '1 hour')).id as id`)).rows[0].id
      await tx.query('select app.enqueue_collect_job()')
      const job = (await tx.query<{ id: string; t: string }>(
        `select (j).id as id, (j).lease_token as t from (select app.claim_collect_job('PC', '3 minutes', $1) as j) q`, [dev])).rows[0]
      await tx.query('select app.begin_stage($1, $2, $3)', [job.id, job.t, 'sales:1'])
      await insertSub(tx, userC)
      await tx.query(`select app.enqueue_notification('sale', 't', '', null, 'sale:c')`)
      await tx.query('select app.acquire_tracking_lease()')
      await tx.query(`insert into app.setting_secret (key, ciphertext, iv, key_version) values ('k', '\\x01'::bytea, '\\x02'::bytea, 1)`)
    }, { userId: userC }) // 鍵を出す人（app.user_id）が要る

    const tables = ['agent_device', 'collect_job', 'collect_job_stage', 'notification_event', 'notification_delivery', 'push_subscription', 'tracking_lease', 'setting_secret']
    for (const t of tables) {
      const n = (await db.query<{ n: number }>(`select count(*)::int as n from app.${t} where household_id = $1`, [hhC])).rows[0].n
      expect(n, `${t}（消す前）`).toBeGreaterThan(0)
    }
    await db.query('delete from app.household where id = $1', [hhC])
    for (const t of tables) {
      const n = (await db.query<{ n: number }>(`select count(*)::int as n from app.${t} where household_id = $1`, [hhC])).rows[0].n
      expect(n, `${t}（消した後）`).toBe(0)
    }
    // 他の世帯は無事
    expect((await db.query('select id from app.household where id in ($1, $2)', [HH_A, HH_B])).rows).toHaveLength(2)
  })
})

describe('他の世帯の行を指す外部キーが作れない（Wave 3a の表）', () => {
  it('配送：他の世帯の出来事・購読を指せない。stage：他の世帯の job を指せない。job：他の世帯の PC を指せない', async () => {
    const subB = await asApi(db, HH_B, (tx) => insertSub(tx, USER_B))
    const subA = await asApi(db, HH_A, (tx) => insertSub(tx, USER_A))
    const eventA = await asApi(db, HH_A, async (tx) =>
      (await tx.query<{ id: string }>(`select app.enqueue_notification('test', 't', '', null, 'fk:a', $1) as id`, [USER_B])).rows[0].id)
    const eventB = await asApi(db, HH_B, async (tx) =>
      (await tx.query<{ id: string }>(`select app.enqueue_notification('test', 't', '', null, 'fk:b', $1) as id`, [USER_B])).rows[0].id)
    const devB = await asApi(db, HH_B, async (tx) =>
      (await tx.query<{ id: string }>(`select (app.register_agent_device('PC-B', repeat('d', 64), now() + interval '1 hour')).id as id`)).rows[0].id,
    { userId: USER_B })
    const jobB = await asApi(db, HH_B, async (tx) =>
      (await tx.query<{ id: string }>('select (app.enqueue_collect_job()).id as id')).rows[0].id)

    // 持ち主のロールで household_id をずらして書く（RLS を受けないロールでも外部キーが止める）
    const attempts: Array<[string, string, unknown[]]> = [
      ['delivery → 他の世帯の購読', 'insert into app.notification_delivery (household_id, event_id, subscription_id) values ($1, $2, $3)', [HH_A, eventA, subB.id]],
      ['delivery → 他の世帯の出来事', 'insert into app.notification_delivery (household_id, event_id, subscription_id) values ($1, $2, $3)', [HH_A, eventB, subA.id]],
      ['stage → 他の世帯の job', `insert into app.collect_job_stage (household_id, job_id, stage_key) values ($1, $2, 'x')`, [HH_A, jobB]],
      ['job → 他の世帯の PC', `insert into app.collect_job (household_id, agent_device_id) values ($1, $2)`, [HH_A, devB]],
    ]
    for (const [label, sql, params] of attempts) {
      expect(await sqlstateOf(() => db.query(sql, params)), label).toBe('23503')
    }
  })
})
