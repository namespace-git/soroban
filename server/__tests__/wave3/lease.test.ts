import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createMigratedDb } from '../../test/migrate'
import { asApi, asRole, HH_A, HH_B, seedHouseholds, sha256hex, sqlstateOf, USER_A, USER_B } from './helpers'

// 取り込みの lease の穴ふさぎ（20261012001500_agent_push_cron.sql）：
// assert_lease・失効した lease の heartbeat / finish・partial・段ごとの冪等・取った PC（agent_device_id）。
// すべて soroban_api ＋世帯 A（B は隔離の確認）で呼ぶ。時計は lease_expires_at を過去に書き換えて進める

let db: PGlite

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec('delete from app.collect_job') // collect_job_stage は cascade で消える
})

interface Job {
  id: string
  household_id: string
  status: string
  agent_id: string | null
  agent_device_id: string | null
  lease_token: string | null
  lease_expires_at: string | null
  heartbeat_at: string | null
  finished_at: string | null
  claimed_at: string | null
  result: unknown
}

const enqueue = (hh = HH_A) =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ job: Job }>('select to_jsonb(app.enqueue_collect_job()) as job')).rows[0].job)

const claim = (agent = 'pc-1', hh = HH_A, deviceId: string | null = null) =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ job: Job | null }>(
      'select to_jsonb(app.claim_collect_job($1, $2::interval, $3)) as job',
      [agent, '3 minutes', deviceId],
    )).rows[0].job)

/** 積んで取る。取った job（lease_token つき）を返す */
const start = async (agent = 'pc-1', hh = HH_A, deviceId: string | null = null): Promise<Job> => {
  await enqueue(hh)
  return (await claim(agent, hh, deviceId))!
}

const assertLease = (id: string, token: string, hh = HH_A) =>
  asApi(db, hh, (tx) => tx.query('select app.assert_lease($1, $2)', [id, token]))

const heartbeat = (id: string, token: string, hh = HH_A) =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ e: string }>('select app.heartbeat_collect_job($1, $2) as e', [id, token])).rows[0].e)

const finish = (id: string, token: string, status: string, hh = HH_A) =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ job: Job }>('select to_jsonb(app.finish_collect_job($1, $2, $3)) as job', [id, token, status])).rows[0].job)

const reap = (hh = HH_A) =>
  asApi(db, hh, async (tx) => (await tx.query<{ n: number }>('select app.reap_stale_collect_jobs() as n')).rows[0].n)

const beginStage = (id: string, token: string, key: string, hh = HH_A) =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ ok: boolean }>('select app.begin_stage($1, $2, $3) as ok', [id, token, key])).rows[0].ok)

/** 持ち主のロールで lease を過去にする（テスト用の「時計を進める」。RLS を受けない） */
const expire = (id: string) =>
  db.query(`update app.collect_job set lease_expires_at = now() - interval '1 minute' where id = $1`, [id])

const jobRow = async (id: string): Promise<Job> =>
  (await db.query<Job>('select * from app.collect_job where id = $1', [id])).rows[0]

const stageKeys = async (id: string): Promise<string[]> =>
  (await db.query<{ stage_key: string }>(
    'select stage_key from app.collect_job_stage where job_id = $1 order by stage_key', [id],
  )).rows.map((r) => r.stage_key)

const OTHER_TOKEN = '00000000-0000-4000-8000-0000000000aa'

describe('assert_lease（書き込みのトランザクションの先頭で呼ぶ）', () => {
  it('生きている lease（running・token が合う・期限内）は通る', async () => {
    const job = await start()
    await expect(assertLease(job.id, job.lease_token!)).resolves.toBeDefined()
  })

  it('token が違う・null・job が無い・queued のまま は SB003', async () => {
    const queued = await enqueue()
    expect(await sqlstateOf(() => assertLease(queued.id, OTHER_TOKEN))).toBe('SB003')
    const job = (await claim())!
    expect(await sqlstateOf(() => assertLease(job.id, OTHER_TOKEN))).toBe('SB003')
    expect(await sqlstateOf(() => asApi(db, HH_A, (tx) => tx.query('select app.assert_lease($1, null)', [job.id])))).toBe('SB003')
    expect(await sqlstateOf(() => assertLease('00000000-0000-4000-8000-000000000999', job.lease_token!))).toBe('SB003')
  })

  it('期限が切れた lease は、reap がまだ来ていなくて status が running のままでも SB003（失効した lease を通さない）', async () => {
    const job = await start()
    await expire(job.id)
    expect((await jobRow(job.id)).status).toBe('running')

    const err = await assertLease(job.id, job.lease_token!).catch((e) => e)
    expect(err).toMatchObject({ code: 'SB003' })
    expect(err.message).toBe('取り込みの権限が失効しています（時間切れか、別の端末が引き継ぎました）')
  })

  it('終わった job（done / failed）・reap された job は SB003', async () => {
    const done = await start()
    await finish(done.id, done.lease_token!, 'done')
    expect(await sqlstateOf(() => assertLease(done.id, done.lease_token!))).toBe('SB003')

    await db.exec(`update app.collect_job set claimed_at = now() - interval '20 minutes'`)
    const reaped = await start()
    await expire(reaped.id)
    expect(await reap()).toBe(1)
    expect(await sqlstateOf(() => assertLease(reaped.id, reaped.lease_token!))).toBe('SB003')
  })

  it('他の世帯の job は、token が合っていても通らない', async () => {
    const jobB = await start('pc-b', HH_B)
    expect(await sqlstateOf(() => assertLease(jobB.id, jobB.lease_token!, HH_A))).toBe('SB003')
    await expect(assertLease(jobB.id, jobB.lease_token!, HH_B)).resolves.toBeDefined()
  })

  it('job の行を for update でロックする（行のロックを取引の終わりまで持つので、reap とは直列になる）', async () => {
    const job = await start()
    const r = await asApi(db, HH_A, async (tx) => {
      const x = async () =>
        (await tx.query<{ x: string }>('select xmax::text as x from app.collect_job where id = $1', [job.id])).rows[0].x
      const before = await x()
      await tx.query('select app.assert_lease($1, $2)', [job.id, job.lease_token])
      const after = await x()
      const me = (await tx.query<{ me: string }>('select txid_current()::text as me')).rows[0].me
      return { before, after, me }
    })
    // 行にロックの印が付く：行の xmax が、このトランザクションの id になる
    expect(r.before).not.toBe(r.me)
    expect(r.after).toBe(r.me)

    const def = await db.query<{ def: string }>(
      `select pg_get_functiondef('app.assert_lease(uuid, uuid)'::regprocedure) as def`,
    )
    expect(def.rows[0].def).toMatch(/for update/i)
  })
})

describe('heartbeat：失効した lease は延命できない', () => {
  it('生きている lease は延びる', async () => {
    const job = await start()
    const before = new Date((await jobRow(job.id)).lease_expires_at!).getTime()
    await db.query(`update app.collect_job set lease_expires_at = now() + interval '10 seconds' where id = $1`, [job.id])
    const expires = await heartbeat(job.id, job.lease_token!)
    expect(new Date(expires).getTime()).toBeGreaterThan(before - 5_000)
    expect(new Date(expires).getTime()).toBeGreaterThan(Date.now() + 120_000)
  })

  it('期限が切れていたら SB003 で、期限も heartbeat_at も動かない（reap の前でも延命させない）', async () => {
    const job = await start()
    await expire(job.id)
    const before = await jobRow(job.id)

    expect(await sqlstateOf(() => heartbeat(job.id, job.lease_token!))).toBe('SB003')

    const after = await jobRow(job.id)
    expect(after.status).toBe('running')
    expect(new Date(after.lease_expires_at!).getTime()).toBe(new Date(before.lease_expires_at!).getTime())
    expect(new Date(after.heartbeat_at!).getTime()).toBe(new Date(before.heartbeat_at!).getTime())
    // 延命されないので、reap で片付く
    expect(await reap()).toBe(1)
    expect((await jobRow(job.id)).status).toBe('failed')
  })
})

describe('finish：失効した lease では終えられない。partial を受ける', () => {
  it('期限が切れていたら SB003。job は running のまま結果も入らない（reap が failed にする）', async () => {
    const job = await start()
    await expire(job.id)

    expect(await sqlstateOf(() => finish(job.id, job.lease_token!, 'done'))).toBe('SB003')

    const row = await jobRow(job.id)
    expect(row).toMatchObject({ status: 'running', finished_at: null, result: null })
    expect(await reap()).toBe(1)
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed', result: { reaped: true, reason: 'lease_expired' } })
  })

  it('partial（段が全部終わらずに止まった）で終えられる。結果も残る', async () => {
    const job = await start()
    const done = await asApi(db, HH_A, async (tx) =>
      (await tx.query<{ job: Job }>(
        'select to_jsonb(app.finish_collect_job($1, $2, $3, $4::jsonb)) as job',
        [job.id, job.lease_token, 'partial', JSON.stringify({ stopped_at: 'listings:2' })],
      )).rows[0].job)
    expect(done).toMatchObject({ status: 'partial', result: { stopped_at: 'listings:2' } })
    expect(done.finished_at).not.toBeNull()
    // 終わったので、同じ token では何もできない
    expect(await sqlstateOf(() => heartbeat(job.id, job.lease_token!))).toBe('SB003')
    expect(await sqlstateOf(() => finish(job.id, job.lease_token!, 'done'))).toBe('SB003')
  })

  it('終了の状態は done / partial / failed / cancelled だけ（running・queued は 22023）', async () => {
    const job = await start()
    for (const s of ['running', 'queued', 'paused']) {
      expect(await sqlstateOf(() => finish(job.id, job.lease_token!, s)), s).toBe('22023')
    }
    for (const s of ['done', 'failed', 'cancelled']) {
      await db.exec(`update app.collect_job set status = 'running', finished_at = null`)
      expect((await finish(job.id, job.lease_token!, s)).status).toBe(s)
    }
  })

  it('partial の job も cooldown に数える（始めた時刻から 10 分は新しい要求を断る）。過ぎれば通る', async () => {
    const job = await start()
    await finish(job.id, job.lease_token!, 'partial')
    expect(await sqlstateOf(() => enqueue())).toBe('SB002')

    await db.query(`update app.collect_job set claimed_at = now() - interval '11 minutes' where id = $1`, [job.id])
    await expect(enqueue()).resolves.toMatchObject({ status: 'queued' })
  })

  it('status の check：partial は入り、それ以外の見知らぬ値は入らない', async () => {
    const code = await sqlstateOf(() =>
      asApi(db, HH_A, (tx) => tx.query(`insert into app.collect_job (status) values ('paused')`)),
    )
    expect(code).toBe('23514')
    await expect(
      asApi(db, HH_A, (tx) => tx.query(`insert into app.collect_job (status, finished_at) values ('partial', now())`)),
    ).resolves.toBeDefined()
  })
})

describe('reap と書き込みが競うとき、どちらか一方だけが通る', () => {
  it('書き込みが先：段は残り、そのあと reap で failed になり、同じ token の次の書き込みは SB003', async () => {
    const job = await start()
    expect(await beginStage(job.id, job.lease_token!, 'sales:1')).toBe(true)

    await expire(job.id)
    expect(await reap()).toBe(1)

    expect(await sqlstateOf(() => beginStage(job.id, job.lease_token!, 'sales:2'))).toBe('SB003')
    // 確定した段は戻さない
    expect(await stageKeys(job.id)).toEqual(['sales:1'])
    expect((await jobRow(job.id)).status).toBe('failed')
  })

  it('reap が先：スリープから戻った古い PC は、最初の書き込みで断られる。引き継いだ PC は書ける', async () => {
    const stale = await start('pc-old')
    await expire(stale.id)
    await db.query(`update app.collect_job set claimed_at = now() - interval '20 minutes' where id = $1`, [stale.id])
    expect(await reap()).toBe(1)

    const fresh = await start('pc-new')
    expect(fresh.lease_token).not.toBe(stale.lease_token)

    // 古い token：古い job にも新しい job にも書けない
    expect(await sqlstateOf(() => beginStage(stale.id, stale.lease_token!, 'sales:1'))).toBe('SB003')
    expect(await sqlstateOf(() => beginStage(fresh.id, stale.lease_token!, 'sales:1'))).toBe('SB003')
    expect(await stageKeys(stale.id)).toEqual([])
    expect(await stageKeys(fresh.id)).toEqual([])

    expect(await beginStage(fresh.id, fresh.lease_token!, 'sales:1')).toBe(true)
  })

  it('期限が切れた時点で（reap の前でも）書き込みは通らない', async () => {
    const job = await start()
    await expire(job.id)
    expect(await sqlstateOf(() => beginStage(job.id, job.lease_token!, 'sales:1'))).toBe('SB003')
    expect(await stageKeys(job.id)).toEqual([])
  })
})

describe('begin_stage（段ごとの冪等）', () => {
  it('初めては true、同じ段の 2 回目は false（済み）。別の段は true', async () => {
    const job = await start()
    expect(await beginStage(job.id, job.lease_token!, 'sales:1')).toBe(true)
    expect(await beginStage(job.id, job.lease_token!, 'sales:1')).toBe(false)
    expect(await beginStage(job.id, job.lease_token!, 'sales:1')).toBe(false)
    expect(await beginStage(job.id, job.lease_token!, 'sales:2')).toBe(true)
    expect(await beginStage(job.id, job.lease_token!, 'trading')).toBe(true)
    expect(await stageKeys(job.id)).toEqual(['sales:1', 'sales:2', 'trading'])
  })

  it('同じ鍵でも job が違えば別の段（job ごとに独立）', async () => {
    const first = await start()
    await beginStage(first.id, first.lease_token!, 'sales:1')
    await finish(first.id, first.lease_token!, 'partial')
    await db.query(`update app.collect_job set claimed_at = now() - interval '20 minutes' where id = $1`, [first.id])

    const second = await start('pc-2')
    expect(await beginStage(second.id, second.lease_token!, 'sales:1')).toBe(true)
  })

  it('記録は書き込みと同じトランザクション：失敗して巻き戻れば記録も消え、送り直せる', async () => {
    const job = await start()
    const code = await sqlstateOf(() =>
      asApi(db, HH_A, async (tx) => {
        await tx.query('select app.begin_stage($1, $2, $3)', [job.id, job.lease_token, 'sales:1'])
        await tx.query('insert into app.collect_job (status) values ($1)', ['paused']) // 書き込みの失敗
      }),
    )
    expect(code).toBe('23514')
    expect(await stageKeys(job.id)).toEqual([])
    expect(await beginStage(job.id, job.lease_token!, 'sales:1')).toBe(true)
  })

  it('同じトランザクションの中で 2 回呼んでも、2 回目は false', async () => {
    const job = await start()
    const r = await asApi(db, HH_A, async (tx) => {
      const a = (await tx.query<{ ok: boolean }>('select app.begin_stage($1, $2, $3) as ok', [job.id, job.lease_token, 'k'])).rows[0].ok
      const b = (await tx.query<{ ok: boolean }>('select app.begin_stage($1, $2, $3) as ok', [job.id, job.lease_token, 'k'])).rows[0].ok
      return [a, b]
    })
    expect(r).toEqual([true, false])
  })

  it('lease が無い・失効している・他の世帯なら SB003（段も記録されない）', async () => {
    const job = await start()
    expect(await sqlstateOf(() => beginStage(job.id, OTHER_TOKEN, 'k'))).toBe('SB003')
    expect(await sqlstateOf(() => beginStage(job.id, job.lease_token!, 'k', HH_B))).toBe('SB003')
    expect(await stageKeys(job.id)).toEqual([])
  })

  it('段の鍵が空・空白・null・2000 文字超は 22023', async () => {
    const job = await start()
    for (const key of ['', '   ', 'x'.repeat(2001)]) {
      expect(await sqlstateOf(() => beginStage(job.id, job.lease_token!, key)), key.slice(0, 10)).toBe('22023')
    }
    expect(await sqlstateOf(() =>
      asApi(db, HH_A, (tx) => tx.query('select app.begin_stage($1, $2, null)', [job.id, job.lease_token])),
    )).toBe('22023')
    // 長い鍵（画像の元 URL）も 2000 文字までは入る
    expect(await beginStage(job.id, job.lease_token!, `https://img.example.test/${'a'.repeat(1900)}`)).toBe(true)
  })

  it('collect_job_stage は (household_id, job_id, stage_key) が一意。job を消すと段も消える。他の世帯からは見えない', async () => {
    const job = await start()
    await beginStage(job.id, job.lease_token!, 'sales:1')

    // 直接 2 行目を入れても一意制約で止まる
    expect(await sqlstateOf(() =>
      asApi(db, HH_A, (tx) => tx.query('insert into app.collect_job_stage (job_id, stage_key) values ($1, $2)', [job.id, 'sales:1'])),
    )).toBe('23505')

    const seenByB = await asApi(db, HH_B, async (tx) => (await tx.query('select * from app.collect_job_stage')).rows)
    expect(seenByB).toEqual([])
    // B の世帯として A の job に段を付けることもできない（複合外部キー）
    expect(await sqlstateOf(() =>
      asApi(db, HH_B, (tx) => tx.query('insert into app.collect_job_stage (job_id, stage_key) values ($1, $2)', [job.id, 'x'])),
    )).toBe('23503')

    await db.query('delete from app.collect_job where id = $1', [job.id])
    expect(await stageKeys(job.id)).toEqual([])
  })
})

describe('claim：取った PC（agent_device_id）', () => {
  const makeDevice = async (hh: string, name: string): Promise<string> =>
    asApi(db, hh, async (tx) =>
      (await tx.query<{ id: string }>(
        `select (app.register_agent_device($1, $2, now() + interval '2 hours')).id as id`,
        [name, sha256hex(`${hh}:${name}:${Math.random()}`)],
      )).rows[0].id, { userId: hh === HH_A ? USER_A : USER_B }) // 鍵を出す人（app.user_id）が要る

  it('PC の id を渡すと job に残る。渡さなければ null（これまでの呼び方がそのまま通る）', async () => {
    const dev = await makeDevice(HH_A, 'リビングの PC')
    const job = await start('リビングの PC', HH_A, dev)
    expect(job).toMatchObject({ status: 'running', agent_id: 'リビングの PC', agent_device_id: dev })

    await finish(job.id, job.lease_token!, 'done')
    await db.query(`update app.collect_job set claimed_at = now() - interval '20 minutes'`)
    const plain = await asApi(db, HH_A, async (tx) => {
      await tx.query('select app.enqueue_collect_job()')
      return (await tx.query<{ job: Job }>(`select to_jsonb(app.claim_collect_job('pc-x')) as job`)).rows[0].job
    })
    expect(plain.agent_device_id).toBeNull()
  })

  it('他の世帯の PC の id は渡せない（複合外部キー）', async () => {
    const devB = await makeDevice(HH_B, '世帯 B の PC')
    await enqueue(HH_A)
    expect(await sqlstateOf(() => claim('pc-1', HH_A, devB))).toBe('23503')
    // 失敗したので job は queued のまま
    const rows = await db.query<{ status: string }>('select status from app.collect_job')
    expect(rows.rows).toEqual([{ status: 'queued' }])
  })

  it('PC の行を消しても job は残る（agent_device_id だけ null になり、世帯は残る）', async () => {
    const dev = await makeDevice(HH_A, '消す PC')
    const job = await start('消す PC', HH_A, dev)
    await db.query('delete from app.agent_device where id = $1', [dev])
    expect(await jobRow(job.id)).toMatchObject({ agent_device_id: null, household_id: HH_A, status: 'running' })
  })
})

describe('関数の権限', () => {
  it('assert_lease・begin_stage は security invoker で、soroban_api だけが実行できる', async () => {
    const { rows } = await db.query<{ proname: string; prosecdef: boolean; api: boolean; anon: boolean; auth: boolean; cron: boolean; public_exec: boolean }>(
      `select p.proname, p.prosecdef,
              has_function_privilege('soroban_api', p.oid, 'execute') as api,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('soroban_cron', p.oid, 'execute') as cron,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0) as public_exec
         from pg_proc p
        where p.pronamespace = 'app'::regnamespace and p.proname in ('assert_lease', 'begin_stage')
        order by p.proname`,
    )
    expect(rows.map((r) => r.proname)).toEqual(['assert_lease', 'begin_stage'])
    for (const r of rows) {
      expect(r, r.proname).toMatchObject({ prosecdef: false, api: true, anon: false, auth: false, cron: false, public_exec: false })
    }
  })

  it('claim_collect_job は 1 つだけ（引数が増えても、呼び出しが曖昧にならない）', async () => {
    const { rows } = await db.query<{ args: string }>(
      `select pg_get_function_arguments(p.oid) as args from pg_proc p
        where p.pronamespace = 'app'::regnamespace and p.proname = 'claim_collect_job'`,
    )
    expect(rows).toEqual([
      { args: "p_agent_id text, p_lease interval DEFAULT '00:03:00'::interval, p_agent_device_id uuid DEFAULT NULL::uuid" },
    ])
  })

  it('anon / authenticated は lease の関数を呼べない', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect(await sqlstateOf(() => asRole(db, role, (tx) => tx.query('select app.assert_lease(gen_random_uuid(), gen_random_uuid())'))), role).toBe('42501')
      expect(await sqlstateOf(() => asRole(db, role, (tx) => tx.query(`select app.begin_stage(gen_random_uuid(), gen_random_uuid(), 'k')`))), role).toBe('42501')
    }
  })
})
