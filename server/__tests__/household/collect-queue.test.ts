import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createMigratedDb } from '../../test/migrate'
import { asApi, asRole, HH_A, HH_B, seedHouseholds, sqlstateOf, USER_A } from '../schema/helpers'

// 取り込み要求が詰まらないこと：queued のまま誰も取らない要求の時間切れ（reap）、
// enqueue / claim の頭での自動 reap、人による取り消し（cancel_collect_job）。
// すべて soroban_api ＋世帯 A（B は隔離の確認）で呼ぶ

let db: PGlite

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await db.exec('delete from app.collect_job')
})

interface Job {
  id: string
  household_id: string
  requested_by: string | null
  status: string
  agent_id: string | null
  claimed_at: string | null
  finished_at: string | null
  lease_token: string | null
  lease_expires_at: string | null
  result: Record<string, unknown> | null
}

const enqueue = (hh = HH_A, opts: { userId?: string } = {}) =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ job: Job }>('select to_jsonb(app.enqueue_collect_job()) as job')).rows[0].job,
  opts)

const claim = (agent: string, hh = HH_A) =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ job: Job | null }>('select to_jsonb(app.claim_collect_job($1)) as job', [agent])).rows[0].job,
  )

const finish = (id: string, token: string, status: string, hh = HH_A) =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ job: Job }>('select to_jsonb(app.finish_collect_job($1, $2, $3)) as job', [id, token, status])).rows[0].job,
  )

/** 引数なしで呼ぶ（API が呼ぶ形）。timeout を渡すと p_queued_timeout を指定する */
const reap = (hh = HH_A, timeout?: string) =>
  asApi(db, hh, async (tx) => {
    const r = timeout === undefined
      ? await tx.query<{ n: number }>('select app.reap_stale_collect_jobs() as n')
      : await tx.query<{ n: number }>('select app.reap_stale_collect_jobs($1::interval) as n', [timeout])
    return r.rows[0].n
  })

const cancel = (id: string, hh = HH_A, opts: { userId?: string } = {}) =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ job: Job }>('select to_jsonb(app.cancel_collect_job($1)) as job', [id])).rows[0].job,
  opts)

/** 持ち主のロールで時計を巻き戻す（テスト用。RLS を受けない） */
const backdate = (id: string, column: 'requested_at' | 'claimed_at' | 'lease_expires_at', minutesAgo: number) =>
  db.query(`update app.collect_job set ${column} = now() - ($2 || ' minutes')::interval where id = $1`, [id, String(minutesAgo)])

const jobRow = async (id: string): Promise<Job> =>
  (await db.query<Job>('select * from app.collect_job where id = $1', [id])).rows[0]

describe('queued のまま誰も取らない要求（PC のエージェントが動いていない）', () => {
  it('5 分以上たった queued は cancelled になる。始まっていないので claimed_at は NULL のまま、結果に印が残る', async () => {
    const job = await enqueue()
    await backdate(job.id, 'requested_at', 6)

    expect(await reap()).toBe(1)
    const row = await jobRow(job.id)
    expect(row).toMatchObject({ status: 'cancelled', claimed_at: null, lease_token: null, agent_id: null })
    expect(row.finished_at).not.toBeNull()
    expect(row.result).toMatchObject({ reaped: true, reason: 'queued_timeout' })
    expect(await reap()).toBe(0)
  })

  it('5 分に満たない queued は触らない（まだ取り込み中。次の要求は断られる）', async () => {
    const job = await enqueue()
    await backdate(job.id, 'requested_at', 4)

    expect(await reap()).toBe(0)
    expect((await jobRow(job.id)).status).toBe('queued')
    await expect(enqueue()).rejects.toMatchObject({ code: 'SB001', message: '取り込み中です' })
  })

  it('enqueue の頭で片付く：reap を呼ばなくても、古い queued があるせいで「取り込み中です」にならない', async () => {
    const stale = await enqueue()
    await backdate(stale.id, 'requested_at', 6)

    const fresh = await enqueue()
    expect(fresh).toMatchObject({ status: 'queued', household_id: HH_A })
    expect(fresh.id).not.toBe(stale.id)
    expect((await jobRow(stale.id)).status).toBe('cancelled')
    // 新しい要求が積まれたので、続けての要求はまた断られる
    await expect(enqueue()).rejects.toMatchObject({ code: 'SB001' })
  })

  it('claim の頭で片付く：古い queued は取らずに cancelled にして、null を返す', async () => {
    const stale = await enqueue()
    await backdate(stale.id, 'requested_at', 6)

    expect(await claim('pc-1')).toBeNull()
    expect((await jobRow(stale.id)).status).toBe('cancelled')
    expect((await jobRow(stale.id)).claimed_at).toBeNull()
  })

  it('claim の頭で、lease の切れた running も failed になる（次の要求を受けられる）', async () => {
    const job = await enqueue()
    expect(await claim('pc-1')).not.toBeNull()
    await backdate(job.id, 'lease_expires_at', 1)

    expect(await claim('pc-2')).toBeNull()
    expect(await jobRow(job.id)).toMatchObject({ status: 'failed', result: { reaped: true, reason: 'lease_expired' } })
  })

  it('古くなっていない queued は、これまでどおり取れる', async () => {
    const job = await enqueue()
    await backdate(job.id, 'requested_at', 4)
    expect(await claim('pc-1')).toMatchObject({ id: job.id, status: 'running' })
  })

  it('reap の待ち時間は引数で変えられる（0 秒なら直後でも対象。負・null は断る）', async () => {
    const job = await enqueue()
    expect(await reap(HH_A, '10 minutes')).toBe(0)
    expect((await jobRow(job.id)).status).toBe('queued')

    expect(await reap(HH_A, '0 seconds')).toBe(1)
    expect((await jobRow(job.id)).status).toBe('cancelled')

    await expect(reap(HH_A, '-1 minute')).rejects.toMatchObject({ code: '22023' })
    await expect(
      asApi(db, HH_A, (tx) => tx.query('select app.reap_stale_collect_jobs(null)')),
    ).rejects.toMatchObject({ code: '22023' })
  })

  it('running は、要求してから長くたっていても時間切れにしない（queued だけが対象）', async () => {
    const job = await enqueue()
    await claim('pc-1')
    await backdate(job.id, 'requested_at', 30)

    expect(await reap()).toBe(0)
    expect((await jobRow(job.id)).status).toBe('running')
  })

  it('他の世帯の queued には触らない。世帯 A の古い queued が B の要求を妨げない', async () => {
    const a = await enqueue(HH_A)
    const b = await enqueue(HH_B)
    await backdate(a.id, 'requested_at', 6)
    await backdate(b.id, 'requested_at', 6)

    expect(await reap(HH_A)).toBe(1)
    expect((await jobRow(a.id)).status).toBe('cancelled')
    expect((await jobRow(b.id)).status).toBe('queued')
  })

  it('古い queued（世帯 A）と lease 切れの running（世帯 B）は、それぞれの世帯の呼び出しで 1 件ずつ片付く', async () => {
    // 世帯ごとに active は 1 本なので、別の世帯に置く
    const a = await enqueue(HH_A)
    const b = await enqueue(HH_B)
    await claim('pc-b', HH_B)
    await backdate(a.id, 'requested_at', 6)
    await backdate(b.id, 'lease_expires_at', 1)

    expect(await reap(HH_A)).toBe(1)
    expect(await reap(HH_B)).toBe(1)
    expect((await jobRow(a.id)).status).toBe('cancelled')
    expect((await jobRow(b.id)).status).toBe('failed')
  })

  it('reap_stale_collect_jobs は 1 つだけ（引数なしと引数ありが並ばず、呼び出しが曖昧にならない）', async () => {
    const { rows } = await db.query<{ args: string }>(
      `select pg_get_function_arguments(p.oid) as args from pg_proc p
        where p.pronamespace = 'app'::regnamespace and p.proname = 'reap_stale_collect_jobs'`,
    )
    expect(rows).toEqual([{ args: "p_queued_timeout interval DEFAULT '00:05:00'::interval" }])
  })
})

describe('cancelled はクールダウンに数えない', () => {
  it('時間切れで cancelled になった直後でも、新しい要求を積める', async () => {
    const stale = await enqueue()
    await backdate(stale.id, 'requested_at', 6)
    await reap()

    await expect(enqueue()).resolves.toMatchObject({ status: 'queued' })
  })

  it('人が取り消した直後でも、新しい要求を積める', async () => {
    const job = await enqueue()
    await cancel(job.id)

    await expect(enqueue()).resolves.toMatchObject({ status: 'queued' })
  })

  it('対照：始まった取り込み（done）の直後は、これまでどおり断られる', async () => {
    const job = await enqueue()
    const claimed = (await claim('pc-1'))!
    await finish(job.id, claimed.lease_token!, 'done')
    await expect(enqueue()).rejects.toMatchObject({ code: 'SB002' })
  })

  it('対照：始まったあとに agent が cancelled で終えたものは、始まっているので数える', async () => {
    const job = await enqueue()
    const claimed = (await claim('pc-1'))!
    await finish(job.id, claimed.lease_token!, 'cancelled')
    await expect(enqueue()).rejects.toMatchObject({ code: 'SB002' })
  })

  it('取り消し済みの job が後ろにあっても、直前に始めた取り込みの cooldown は消えない', async () => {
    const first = await enqueue()
    const claimed = (await claim('pc-1'))!
    await finish(first.id, claimed.lease_token!, 'done')
    // first より新しい cancelled（始まっていない）を置く。cooldown の基準は first のまま
    await db.query(
      `insert into app.collect_job (household_id, status, finished_at) values ($1, 'cancelled', now())`, [HH_A],
    )
    await expect(enqueue()).rejects.toMatchObject({ code: 'SB002' })
  })
})

describe('cancel_collect_job（人が取り消す）', () => {
  it('queued は取り消せる：cancelled・finished_at・結果の印。claimed_at は NULL のまま', async () => {
    const job = await enqueue(HH_A, { userId: USER_A })
    const done = await cancel(job.id, HH_A, { userId: USER_A })

    expect(done).toMatchObject({ id: job.id, status: 'cancelled', claimed_at: null, lease_token: null })
    expect(done.finished_at).not.toBeNull()
    expect(done.result).toEqual({ cancelled: true, reason: 'user_cancelled', cancelled_by: USER_A })
    expect((await jobRow(job.id)).status).toBe('cancelled')
  })

  it('押した人が分からなくても取り消せる（cancelled_by は入れない）', async () => {
    const job = await enqueue()
    const done = await cancel(job.id)
    expect(done.result).toEqual({ cancelled: true, reason: 'user_cancelled' })
  })

  it('取り消すと、claim は null を返し、新しい要求を積める', async () => {
    const job = await enqueue()
    await cancel(job.id)
    expect(await claim('pc-1')).toBeNull()
    await expect(enqueue()).resolves.toMatchObject({ status: 'queued' })
  })

  it('running は取り消せない（SB004）。job は running のまま、lease も動かない', async () => {
    await enqueue()
    const running = (await claim('pc-1'))!
    const err = await cancel(running.id).catch((e) => e)
    expect(err).toMatchObject({ code: 'SB004', message: '取り込みはもう始まっているので取り消せません' })

    const row = await jobRow(running.id)
    expect(row.status).toBe('running')
    expect(row.lease_token).toBe(running.lease_token)
    expect(new Date(row.lease_expires_at!).getTime()).toBe(new Date(running.lease_expires_at!).getTime())
    expect(row.finished_at).toBeNull()
  })

  it('終わったもの（done / failed / cancelled）も取り消せない（SB004）', async () => {
    const first = await enqueue()
    const claimed = (await claim('pc-1'))!
    const done = await finish(first.id, claimed.lease_token!, 'done')
    await expect(cancel(done.id)).rejects.toMatchObject({ code: 'SB004', message: '取り込みはもう終わっています' })

    await backdate(first.id, 'claimed_at', 20)
    const second = await enqueue()
    await cancel(second.id)
    // 二度押しは、取り消し済みなので断る（状態は変わらない）
    const again = await cancel(second.id).catch((e) => e)
    expect(again).toMatchObject({ code: 'SB004', detail: '状態：cancelled' })
    expect((await jobRow(second.id)).status).toBe('cancelled')

    await db.query(`update app.collect_job set status = 'failed' where id = $1`, [first.id])
    await expect(cancel(first.id)).rejects.toMatchObject({ code: 'SB004', detail: '状態：failed' })
  })

  it('存在しない id は SB005', async () => {
    await expect(cancel('00000000-0000-4000-8000-000000000999')).rejects.toMatchObject({
      code: 'SB005', message: '取り込みの要求が見つかりません',
    })
  })

  it('他の世帯の job は見えない：A から B の queued を取り消せない（SB005）。B の job は queued のまま', async () => {
    const b = await enqueue(HH_B)
    await expect(cancel(b.id, HH_A)).rejects.toMatchObject({ code: 'SB005' })
    expect((await jobRow(b.id)).status).toBe('queued')
    // 持ち主の世帯からは取り消せる
    await expect(cancel(b.id, HH_B)).resolves.toMatchObject({ status: 'cancelled' })
  })
})

describe('関数の権限', () => {
  it('reap / cancel は security invoker で soroban_api だけが実行できる。PUBLIC には残っていない', async () => {
    const { rows } = await db.query<{ proname: string; prosecdef: boolean; api: boolean; anon: boolean; auth: boolean; public_exec: boolean }>(
      `select p.proname, p.prosecdef,
              has_function_privilege('soroban_api', p.oid, 'execute') as api,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0) as public_exec
         from pg_proc p
        where p.pronamespace = 'app'::regnamespace
          and p.proname in ('cancel_collect_job', 'reap_stale_collect_jobs', 'enqueue_collect_job', 'claim_collect_job')
        order by p.proname`,
    )
    expect(rows.map((r) => r.proname)).toEqual([
      'cancel_collect_job', 'claim_collect_job', 'enqueue_collect_job', 'reap_stale_collect_jobs',
    ])
    for (const r of rows) {
      expect(r, r.proname).toMatchObject({ prosecdef: false, api: true, anon: false, auth: false, public_exec: false })
    }
  })

  it('anon / authenticated は取り消しも reap も呼べない', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect(
        await sqlstateOf(() => asRole(db, role, (tx) => tx.query('select app.cancel_collect_job(gen_random_uuid())'))),
        role,
      ).toBe('42501')
      expect(
        await sqlstateOf(() => asRole(db, role, (tx) => tx.query('select app.reap_stale_collect_jobs()'))),
        role,
      ).toBe('42501')
    }
  })
})
