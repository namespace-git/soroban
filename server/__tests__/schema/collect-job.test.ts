import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createMigratedDb } from '../../test/migrate'
import { asApi, HH_A, HH_B, seedHouseholds, USER_A } from './helpers'

// 取り込みの排他（collect_job と app.*_collect_job 関数）。すべて soroban_api ＋世帯 A で呼ぶ

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
  heartbeat_at: string | null
  finished_at: string | null
  lease_token: string | null
  lease_expires_at: string | null
  result: unknown
}

const enqueue = (hh = HH_A, cooldown?: string) =>
  asApi(db, hh, async (tx) => {
    const r = cooldown === undefined
      ? await tx.query<{ job: Job }>('select to_jsonb(app.enqueue_collect_job()) as job')
      : await tx.query<{ job: Job }>('select to_jsonb(app.enqueue_collect_job($1::interval)) as job', [cooldown])
    return r.rows[0].job
  })

/** 取れなければ null */
const claim = (agent: string, hh = HH_A, lease?: string) =>
  asApi(db, hh, async (tx) => {
    const r = lease === undefined
      ? await tx.query<{ job: Job | null }>('select to_jsonb(app.claim_collect_job($1)) as job', [agent])
      : await tx.query<{ job: Job | null }>('select to_jsonb(app.claim_collect_job($1, $2::interval)) as job', [agent, lease])
    return r.rows[0].job
  })

const heartbeat = (id: string, token: string, hh = HH_A) =>
  asApi(db, hh, async (tx) => {
    const r = await tx.query<{ expires: string }>('select app.heartbeat_collect_job($1, $2) as expires', [id, token])
    return r.rows[0].expires
  })

const finish = (id: string, token: string, status: string, result: unknown = null, hh = HH_A) =>
  asApi(db, hh, async (tx) => {
    const r = await tx.query<{ job: Job }>(
      'select to_jsonb(app.finish_collect_job($1, $2, $3, $4::jsonb)) as job',
      [id, token, status, result === null ? null : JSON.stringify(result)],
    )
    return r.rows[0].job
  })

const reap = (hh = HH_A) =>
  asApi(db, hh, async (tx) => (await tx.query<{ n: number }>('select app.reap_stale_collect_jobs() as n')).rows[0].n)

/** 持ち主のロールで時計を巻き戻す（テスト用。RLS を受けない） */
const backdate = (id: string, column: 'claimed_at' | 'heartbeat_at' | 'lease_expires_at', minutesAgo: number) =>
  db.query(`update app.collect_job set ${column} = now() - ($2 || ' minutes')::interval where id = $1`, [id, String(minutesAgo)])

const jobRow = async (id: string): Promise<Job> =>
  (await db.query<Job>('select * from app.collect_job where id = $1', [id])).rows[0]

describe('enqueue（要求を積む）', () => {
  it('queued の job が世帯 A で積まれる。押した人は app.user_id から入る', async () => {
    const job = await asApi(db, HH_A, async (tx) => {
      const r = await tx.query<{ job: Job }>('select to_jsonb(app.enqueue_collect_job()) as job')
      return r.rows[0].job
    }, { userId: USER_A })
    expect(job.status).toBe('queued')
    expect(job.household_id).toBe(HH_A)
    expect(job.requested_by).toBe(USER_A)
    expect(job.lease_token).toBeNull()

    expect((await enqueue(HH_B)).requested_by).toBeNull()
  })

  it('動いている（queued）のがあれば、2 本目は「取り込み中です」で断る（SQLSTATE SB001）', async () => {
    await enqueue()
    await expect(enqueue()).rejects.toMatchObject({ code: 'SB001', message: '取り込み中です' })
  })

  it('動いている（running）のがあっても断る', async () => {
    await enqueue()
    await claim('pc-1')
    // cooldown を 0 にしても、動いている間は断る
    await expect(enqueue(HH_A, '0 seconds')).rejects.toMatchObject({ code: 'SB001', message: '取り込み中です' })
  })

  it('世帯ごとに 1 本：A が動いていても B は積める', async () => {
    await enqueue(HH_A)
    await expect(enqueue(HH_B)).resolves.toMatchObject({ status: 'queued', household_id: HH_B })
  })

  it('部分ユニーク索引が最後の砦：queued / running を直接 2 本積むと一意制約違反', async () => {
    await enqueue()
    await expect(
      asApi(db, HH_A, (tx) => tx.query('insert into app.collect_job default values')),
    ).rejects.toMatchObject({ code: '23505', constraint: 'collect_job_one_active' })
  })

  it('直近に始めた取り込みから cooldown（既定 10 分）以内は断る：done の直後', async () => {
    const job = await enqueue()
    const claimed = (await claim('pc-1'))!
    await finish(job.id, claimed.lease_token!, 'done')
    const err = await enqueue().catch((e) => e)
    expect(err).toMatchObject({ code: 'SB002' })
    expect(err.message).toBe('前回の取り込みから 10 分たっていません')
    expect(err.detail).toMatch(/^あと \d+ 秒$/)
  })

  it('failed の直後にも効く（失敗したからといって連打できない）', async () => {
    const job = await enqueue()
    const claimed = (await claim('pc-1'))!
    await finish(job.id, claimed.lease_token!, 'failed', { error: 'メルカリにログインが必要です' })
    await expect(enqueue()).rejects.toMatchObject({ code: 'SB002' })
  })

  it('始めた時刻（claimed_at）が cooldown より前なら通る', async () => {
    const job = await enqueue()
    const claimed = (await claim('pc-1'))!
    await finish(job.id, claimed.lease_token!, 'done')

    await backdate(job.id, 'claimed_at', 9)
    await expect(enqueue()).rejects.toMatchObject({ code: 'SB002' })

    await backdate(job.id, 'claimed_at', 11)
    await expect(enqueue()).resolves.toMatchObject({ status: 'queued' })
  })

  it('cooldown は引数で変えられる（0 にすれば直後でも通る。長くすれば断る）', async () => {
    const job = await enqueue()
    const claimed = (await claim('pc-1'))!
    await finish(job.id, claimed.lease_token!, 'done')
    await backdate(job.id, 'claimed_at', 11)

    await expect(enqueue(HH_A, '30 minutes')).rejects.toMatchObject({ code: 'SB002', message: '前回の取り込みから 30 分たっていません' })
    await expect(enqueue(HH_A, '0 seconds')).resolves.toMatchObject({ status: 'queued' })
  })

  it('一度も取られなかった job（cancelled）は始まっていないので cooldown に数えない', async () => {
    const job = await enqueue()
    await asApi(db, HH_A, (tx) => tx.query(`update app.collect_job set status = 'cancelled', finished_at = now() where id = $1`, [job.id]))
    await expect(enqueue()).resolves.toMatchObject({ status: 'queued' })
  })

  it('cooldown は世帯ごと：A の直近の取り込みで B は断られない', async () => {
    const job = await enqueue(HH_A)
    const claimed = (await claim('pc-1', HH_A))!
    await finish(job.id, claimed.lease_token!, 'done')
    await expect(enqueue(HH_B)).resolves.toMatchObject({ household_id: HH_B })
  })
})

describe('claim（1 台だけが取る）', () => {
  it('queued を 1 本だけ running にして、lease_token と期限を返す', async () => {
    const queued = await enqueue()
    const job = (await claim('pc-1'))!
    expect(job).toMatchObject({ id: queued.id, status: 'running', agent_id: 'pc-1' })
    expect(job.claimed_at).not.toBeNull()
    expect(job.heartbeat_at).not.toBeNull()
    expect(job.lease_token).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Date(job.lease_expires_at!).getTime()).toBeGreaterThan(Date.now())
  })

  it('2 回目は null（running が残っているので、他の agent も取れない）', async () => {
    await enqueue()
    expect(await claim('pc-1')).not.toBeNull()
    expect(await claim('pc-1')).toBeNull()
    expect(await claim('pc-2')).toBeNull()
  })

  it('queued が無ければ null。SQL の NULL としても返る', async () => {
    expect(await claim('pc-1')).toBeNull()
    const r = await asApi(db, HH_A, (tx) => tx.query<{ none: boolean }>(`select app.claim_collect_job('pc-1') is null as none`))
    expect(r.rows[0].none).toBe(true)
  })

  it('他の世帯の queued は取れない（世帯 A の agent は B の job を見ない）', async () => {
    await enqueue(HH_B)
    expect(await claim('pc-1', HH_A)).toBeNull()
    expect(await claim('pc-1', HH_B)).not.toBeNull()
  })

  it('claim のたびに別の token が発行される', async () => {
    const first = await enqueue()
    const a = (await claim('pc-1'))!
    await finish(first.id, a.lease_token!, 'done')
    await backdate(first.id, 'claimed_at', 20)
    await enqueue()
    const b = (await claim('pc-2'))!
    expect(b.lease_token).not.toBe(a.lease_token)
  })

  it('agent_id が空なら断る', async () => {
    await enqueue()
    await expect(claim('  ')).rejects.toMatchObject({ code: '22023' })
  })
})

describe('heartbeat / finish（lease_token でのフェンシング）', () => {
  it('正しい token なら heartbeat で期限が延びる', async () => {
    await enqueue()
    // 取ったときの lease は 1 分。heartbeat の既定は 3 分なので、期限は先へ延びる
    const job = (await claim('pc-1', HH_A, '1 minute'))!
    const before = new Date(job.lease_expires_at!).getTime()
    const expires = await heartbeat(job.id, job.lease_token!)
    expect(new Date(expires).getTime()).toBeGreaterThan(before + 60_000)
    expect(new Date((await jobRow(job.id)).lease_expires_at!).getTime()).toBe(new Date(expires).getTime())
  })

  it('他の agent（token を知らない）は heartbeat も finish もできない（SB003）', async () => {
    await enqueue()
    const job = (await claim('pc-1'))!
    const other = '00000000-0000-4000-8000-0000000000aa'
    await expect(heartbeat(job.id, other)).rejects.toMatchObject({ code: 'SB003' })
    await expect(finish(job.id, other, 'done')).rejects.toMatchObject({ code: 'SB003' })
    expect((await jobRow(job.id)).status).toBe('running')
  })

  it('他の世帯の job には、token が合っていても触れない', async () => {
    await enqueue(HH_B)
    const jobB = (await claim('pc-b', HH_B))!
    await expect(heartbeat(jobB.id, jobB.lease_token!, HH_A)).rejects.toMatchObject({ code: 'SB003' })
    await expect(finish(jobB.id, jobB.lease_token!, 'done', null, HH_A)).rejects.toMatchObject({ code: 'SB003' })
    expect((await jobRow(jobB.id)).status).toBe('running')
  })

  it('finish で結果が入り、終えた job を返す。同じ token で二度目は拒否される', async () => {
    await enqueue()
    const job = (await claim('pc-1'))!
    const done = await finish(job.id, job.lease_token!, 'done', { runs: [{ source: 'mercari', fetched: 12 }] })
    expect(done).toMatchObject({ status: 'done', result: { runs: [{ source: 'mercari', fetched: 12 }] } })
    expect(done.finished_at).not.toBeNull()

    await expect(finish(job.id, job.lease_token!, 'failed')).rejects.toMatchObject({ code: 'SB003' })
    await expect(heartbeat(job.id, job.lease_token!)).rejects.toMatchObject({ code: 'SB003' })
    expect((await jobRow(job.id)).status).toBe('done')
  })

  it('終了の状態は done / failed / cancelled だけ', async () => {
    await enqueue()
    const job = (await claim('pc-1'))!
    await expect(finish(job.id, job.lease_token!, 'running')).rejects.toMatchObject({ code: '22023' })
    await expect(finish(job.id, job.lease_token!, 'queued')).rejects.toMatchObject({ code: '22023' })
    expect((await jobRow(job.id)).status).toBe('running')
  })

  it('期限切れで reap された job に、古い token で finish すると拒否される（結果を上書きできない）', async () => {
    const queued = await enqueue()
    const stale = (await claim('pc-1'))!
    await backdate(queued.id, 'lease_expires_at', 5)
    await backdate(queued.id, 'claimed_at', 20)

    expect(await reap()).toBe(1)
    const reaped = await jobRow(queued.id)
    expect(reaped.status).toBe('failed')
    expect(reaped.result).toMatchObject({ reaped: true, reason: 'lease_expired' })

    // 古い agent が遅れて戻ってきた
    await expect(finish(queued.id, stale.lease_token!, 'done', { fetched: 99 })).rejects.toMatchObject({ code: 'SB003' })
    await expect(heartbeat(queued.id, stale.lease_token!)).rejects.toMatchObject({ code: 'SB003' })
    const after = await jobRow(queued.id)
    expect(after.status).toBe('failed')
    expect(after.result).toMatchObject({ reaped: true })
  })

  it('別の端末が引き継いだ（新しい claim）あとに、古い token で書けない。新しい token は書ける', async () => {
    const first = await enqueue()
    const stale = (await claim('pc-1'))!
    await backdate(first.id, 'lease_expires_at', 5)
    await backdate(first.id, 'claimed_at', 20)
    expect(await reap()).toBe(1)

    // 次の要求を別の PC が取る
    const second = await enqueue()
    const fresh = (await claim('pc-2'))!
    expect(fresh.id).toBe(second.id)
    expect(fresh.lease_token).not.toBe(stale.lease_token)

    // 古い token は、古い job にも新しい job にも使えない
    await expect(finish(first.id, stale.lease_token!, 'done')).rejects.toMatchObject({ code: 'SB003' })
    await expect(finish(second.id, stale.lease_token!, 'done')).rejects.toMatchObject({ code: 'SB003' })
    await expect(heartbeat(second.id, stale.lease_token!)).rejects.toMatchObject({ code: 'SB003' })

    await expect(heartbeat(second.id, fresh.lease_token!)).resolves.toBeTruthy()
    await expect(finish(second.id, fresh.lease_token!, 'done')).resolves.toMatchObject({ status: 'done', agent_id: 'pc-2' })
  })
})

describe('reap（PC が落ちたとき）', () => {
  it('lease の期限が切れた running だけ failed になる。件数を返す', async () => {
    const job = await enqueue()
    await claim('pc-1')
    expect(await reap()).toBe(0)

    await backdate(job.id, 'lease_expires_at', 1)
    expect(await reap()).toBe(1)
    expect((await jobRow(job.id)).status).toBe('failed')
    expect(await reap()).toBe(0)
  })

  it('heartbeat で延ばした lease は reap されない', async () => {
    const job = await enqueue()
    const claimed = (await claim('pc-1'))!
    await backdate(job.id, 'lease_expires_at', 1)
    await heartbeat(job.id, claimed.lease_token!)
    expect(await reap()).toBe(0)
    expect((await jobRow(job.id)).status).toBe('running')
  })

  it('queued は触らない。他の世帯の running も触らない', async () => {
    await enqueue(HH_A)
    const b = await enqueue(HH_B)
    await claim('pc-b', HH_B)
    await backdate(b.id, 'lease_expires_at', 10)

    expect(await reap(HH_A)).toBe(0)
    expect((await jobRow(b.id)).status).toBe('running')
    expect(await reap(HH_B)).toBe(1)
  })

  it('reap された直後は、始めた時刻が cooldown 内なら次の要求は断られる。過ぎていれば通る', async () => {
    const job = await enqueue()
    await claim('pc-1')
    await backdate(job.id, 'lease_expires_at', 1)
    await reap()
    await expect(enqueue()).rejects.toMatchObject({ code: 'SB002' })

    await backdate(job.id, 'claimed_at', 20)
    await expect(enqueue()).resolves.toMatchObject({ status: 'queued' })
  })
})

describe('関数の権限', () => {
  it('取り込みの関数はどれも security invoker（RLS を受ける）で、soroban_api だけが実行できる', async () => {
    const { rows } = await db.query<{ proname: string; prosecdef: boolean; api: boolean; anon: boolean; auth: boolean }>(
      `select p.proname, p.prosecdef,
              has_function_privilege('soroban_api', p.oid, 'execute') as api,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p
        where p.pronamespace = 'app'::regnamespace and p.proname like '%collect_job%'
        order by p.proname`,
    )
    expect(rows.map((r) => r.proname)).toEqual([
      'claim_collect_job', 'enqueue_collect_job', 'finish_collect_job', 'heartbeat_collect_job', 'reap_stale_collect_jobs',
    ])
    for (const r of rows) {
      expect(r, r.proname).toMatchObject({ prosecdef: false, api: true, anon: false, auth: false })
    }
  })

  it('collect_job は世帯ごとに隔離されている（A からは B の要求が見えない）', async () => {
    await enqueue(HH_A)
    await enqueue(HH_B)
    const seen = await asApi(db, HH_A, async (tx) => (await tx.query<{ household_id: string }>('select household_id from app.collect_job')).rows)
    expect(seen).toEqual([{ household_id: HH_A }])
  })
})
