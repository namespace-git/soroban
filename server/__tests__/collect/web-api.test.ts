import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handlers } from '../../rpc'
import { memberOf, type Member } from '../domain/helpers'
import {
  ask, callRpc, closeFixture, expireLease, jwtOf, leaseOf, openFixture, passCooldown, registerPc, resetWorld, startJob,
  type Fixture,
} from './helpers'

// 画面から呼ぶ取り込み（WebApi の 6 本）：要求 → 状態 → 取り消し、クールダウン、世帯の隔離、lease_token を返さない

let f: Fixture
let a: Member
let b: Member

beforeAll(async () => {
  f = await openFixture()
})

afterAll(async () => {
  await closeFixture(f)
})

beforeEach(async () => {
  await resetWorld(f)
  a = f.world.a
  b = f.world.b
})

describe('登録', () => {
  it('WebApi の 6 本が rpc の表に登録されている（registerWebHandler）', () => {
    for (const name of [
      'requestCollect', 'getCollectStatus', 'cancelCollectJob', 'listAgentDevices', 'revokeAgentDevice', 'getTrackingNumber',
    ] as const) {
      expect(typeof handlers[name], name).toBe('function')
    }
  })

  it('JWT つきの /api/rpc/getCollectStatus が通る（rpc.ts が WebApi の名前を受け付ける）', async () => {
    const r = await callRpc(f, 'getCollectStatus', [], `Bearer ${await jwtOf(f, a)}`)
    expect(r.status).toBe(200)
    expect(r.body.result).toEqual({ job: null, agents_online: 0, cooldown_seconds: 0 })
  })
})

describe('要求 → 状態 → 取り消し', () => {
  it('要求すると queued の要求が積まれ、状態に出る。押したのが自分なら requested_by_me', async () => {
    const job = (await ask(a,'requestCollect')).body.result as Record<string, unknown>
    expect(job).toMatchObject({
      status: 'queued', requested_by_me: true, agent_name: null, claimed_at: null, heartbeat_at: null,
      finished_at: null, runs: null, message: null,
    })
    expect(typeof job.id).toBe('string')

    const status = (await ask(a,'getCollectStatus')).body.result
    expect(status.job).toEqual(job)
    expect(status.cooldown_seconds).toBe(0)
  })

  it('同じ世帯の別の人が見ると requested_by_me は false', async () => {
    await ask(a,'requestCollect')
    const other = '00000000-0000-4000-8000-0000000000c1'
    await f.dom.pg.query(`insert into auth.users (id, email) values ($1, 'c1@example.test') on conflict do nothing`, [other])
    await f.dom.pg.query(`insert into app.household_member (household_id, user_id) values ($1, $2)`, [a.householdId, other])
    const second = memberOf(f.dom, a.householdId, other)
    const status = (await ask(second, 'getCollectStatus')).body.result
    expect(status.job).toMatchObject({ status: 'queued', requested_by_me: false })
  })

  it('積まれている間に続けて要求すると「取り込み中です」（409）', async () => {
    await ask(a,'requestCollect')
    const second = await ask(a,'requestCollect')
    expect(second.status).toBe(409)
    expect(second.body.error).toEqual({ code: 'conflict', message: '取り込み中です' })
  })

  it('取り消すと cancelled。始まっていないのでクールダウンにならず、すぐ要求し直せる', async () => {
    const job = (await ask(a,'requestCollect')).body.result
    expect((await ask(a,'cancelCollectJob', job.id)).status).toBe(200)

    const status = (await ask(a,'getCollectStatus')).body.result
    expect(status.job).toMatchObject({ id: job.id, status: 'cancelled', message: '取り消しました' })
    expect(status.job.finished_at).not.toBeNull()
    expect(status.cooldown_seconds).toBe(0)

    const again = await ask(a,'requestCollect')
    expect(again.status).toBe(200)
    expect(again.body.result.id).not.toBe(job.id)
  })

  it('取り込みが始まった（running）後は取り消せない（409・日本語）', async () => {
    const pc = await registerPc(f, a)
    const lease = await startJob(f, a, pc)
    const r = await ask(a,'cancelCollectJob', lease.job_id)
    expect(r.status).toBe(409)
    expect(r.body.error?.message).toContain('もう始まっているので取り消せません')
  })

  it('走っているとき、拾った PC の名前・heartbeat が出る', async () => {
    const pc = await registerPc(f, a, 'リビングの PC')
    const lease = await startJob(f, a, pc)
    const status = (await ask(a,'getCollectStatus')).body.result
    expect(status.job).toMatchObject({ id: lease.job_id, status: 'running', agent_name: 'リビングの PC' })
    expect(status.job.claimed_at).not.toBeNull()
    expect(status.job.heartbeat_at).not.toBeNull()
  })

  it('変な id は 400/404（500 にしない）', async () => {
    for (const id of ['x', '', null, 123, {}, '00000000-0000-4000-8000-000000000999']) {
      const r = await ask(a,'cancelCollectJob', id)
      expect([400, 404], JSON.stringify(id)).toContain(r.status)
    }
  })
})

describe('クールダウン', () => {
  it('取り込みを始めた直後は断られ、残りを「あと n 分 m 秒」で返す。cooldown_seconds も同じ規則', async () => {
    const pc = await registerPc(f, a)
    const lease = await startJob(f, a, pc)
    const run = (await pc.call('recordRun', leaseOf(lease), { source: 'mercari', status: 'ok', fetched: 1, inserted: 1 })).body.result
    expect((await pc.call('finish', leaseOf(lease), { status: 'done', run_ids: [run.id] })).status).toBe(200)

    const status = (await ask(a,'getCollectStatus')).body.result
    expect(status.job.status).toBe('done')
    // 10 分 = 600 秒から、いま経った分を引いたもの（数秒以内）
    expect(status.cooldown_seconds).toBeGreaterThan(590)
    expect(status.cooldown_seconds).toBeLessThanOrEqual(600)

    const r = await ask(a,'requestCollect')
    expect(r.status).toBe(409)
    expect(r.body.error?.message).toMatch(/^前回の取り込みから 10 分たっていません。あと (?:9 分(?: \d+ 秒)?|10 分)で押せます$/)
  })

  it('9 分前に始めたなら cooldown_seconds は約 60 秒で、要求のエラーの「あと」と食い違わない', async () => {
    const pc = await registerPc(f, a)
    const lease = await startJob(f, a, pc)
    await f.dom.pg.query(`update app.collect_job set claimed_at = now() - interval '9 minutes' where id = $1`, [lease.job_id])
    expect((await pc.call('finish', leaseOf(lease), { status: 'failed', run_ids: [] })).status).toBe(200)

    const status = (await ask(a,'getCollectStatus')).body.result
    expect(status.cooldown_seconds).toBeGreaterThan(50)
    expect(status.cooldown_seconds).toBeLessThanOrEqual(60)

    const r = await ask(a,'requestCollect')
    expect(r.status).toBe(409)
    const m = /あと (?:(\d+) 分 ?)?(?:(\d+) 秒)?で押せます/.exec(r.body.error?.message ?? '')
    expect(m, r.body.error?.message).not.toBeNull()
    const waited = Number(m![1] ?? 0) * 60 + Number(m![2] ?? 0)
    expect(Math.abs(waited - status.cooldown_seconds)).toBeLessThanOrEqual(2)
  })

  it('クールダウンが明ければ要求できる（0 秒）。失敗の後にも効く', async () => {
    const pc = await registerPc(f, a)
    const lease = await startJob(f, a, pc)
    await pc.call('finish', leaseOf(lease), { status: 'failed', run_ids: [] })
    expect((await ask(a,'requestCollect')).status).toBe(409)

    await passCooldown(f, a)
    expect((await ask(a,'getCollectStatus')).body.result.cooldown_seconds).toBe(0)
    expect((await ask(a,'requestCollect')).status).toBe(200)
  })
})

describe('期限切れの要求は状態を読むときに片付く', () => {
  it('PC が取らないまま 5 分たった要求は cancelled（誰も取らなかった）と日本語の理由が出て、すぐ要求し直せる', async () => {
    const job = (await ask(a,'requestCollect')).body.result
    await f.dom.pg.query(`update app.collect_job set requested_at = now() - interval '6 minutes' where id = $1`, [job.id])
    const status = (await ask(a,'getCollectStatus')).body.result
    expect(status.job.status).toBe('cancelled')
    expect(status.job.message).toContain('取り込み担当の PC が見つからなかった')
    expect((await ask(a,'requestCollect')).status).toBe(200)
  })

  it('lease が切れた running は failed（PC からの応答が途絶えた）', async () => {
    const pc = await registerPc(f, a)
    const lease = await startJob(f, a, pc)
    await expireLease(f, lease.job_id)
    const status = (await ask(a,'getCollectStatus')).body.result
    expect(status.job).toMatchObject({ id: lease.job_id, status: 'failed' })
    expect(status.job.message).toContain('応答が途絶えた')
  })
})

describe('世帯の隔離', () => {
  it('他の世帯の要求は見えない・取り消せない', async () => {
    const job = (await ask(a,'requestCollect')).body.result
    expect((await ask(b,'getCollectStatus')).body.result.job).toBeNull()

    const r = await ask(b,'cancelCollectJob', job.id)
    expect(r.status).toBe(404)
    // A の要求は無事
    expect((await ask(a,'getCollectStatus')).body.result.job.status).toBe('queued')
    // B は自分の要求を積める（A の要求に邪魔されない）
    expect((await ask(b,'requestCollect')).status).toBe(200)
  })

  it('他の世帯の PC は一覧に出ず、取り消せない（404）', async () => {
    const pcA = await registerPc(f, a, 'A の PC')
    await registerPc(f, b, 'B の PC')
    expect((await ask(a,'listAgentDevices')).body.result.map((d: { name: string }) => d.name)).toEqual(['A の PC'])
    expect((await ask(b,'listAgentDevices')).body.result.map((d: { name: string }) => d.name)).toEqual(['B の PC'])

    const r = await ask(b,'revokeAgentDevice', pcA.agentId)
    expect(r.status).toBe(404)
    expect((await ask(a,'listAgentDevices')).body.result[0].revoked).toBe(false)
  })
})

describe('lease_token を画面に返さない', () => {
  it('走っている取り込みの状態・一覧・エラーのどこにも lease_token（値も名前も）が無い', async () => {
    const pc = await registerPc(f, a)
    const lease = await startJob(f, a, pc)

    const texts = [
      JSON.stringify((await ask(a,'getCollectStatus')).body),
      JSON.stringify((await ask(a,'listAgentDevices')).body),
      JSON.stringify((await ask(a,'cancelCollectJob', lease.job_id)).body), // 409 のエラー
      JSON.stringify((await ask(a,'requestCollect')).body), // 409 のエラー
    ]
    for (const t of texts) {
      expect(t).not.toContain(lease.lease_token)
      expect(t).not.toContain('lease')
      expect(t).not.toContain(pc.token)
      expect(t).not.toContain('token_hash')
    }
  })

  it('要求の応答（requestCollect）にも無い', async () => {
    const text = JSON.stringify((await ask(a,'requestCollect')).body)
    expect(text).not.toContain('lease')
  })
})

describe('取り込み担当の PC の一覧', () => {
  it('直近 5 分以内に使われた PC がオンライン。agents_online と一覧の online が一致する', async () => {
    await registerPc(f, a, 'リビングの PC')
    await registerPc(f, a, '寝室の PC')
    // 寝室の PC は 6 分前が最後
    await f.dom.pg.query(`update app.agent_device set last_seen_at = now() - interval '6 minutes' where name = '寝室の PC'`)

    const devices = (await ask(a,'listAgentDevices')).body.result
    expect(devices.map((d: { name: string; online: boolean; revoked: boolean }) => [d.name, d.online, d.revoked])).toEqual([
      ['リビングの PC', true, false],
      ['寝室の PC', false, false],
    ])
    expect(Object.keys(devices[0]).sort()).toEqual(['first_seen_at', 'id', 'last_seen_at', 'name', 'online', 'revoked'])
    expect((await ask(a,'getCollectStatus')).body.result.agents_online).toBe(1)
  })

  it('last_seen_at は鍵で呼ぶたびに進み、取り消すとオンラインに数えない', async () => {
    const pc = await registerPc(f, a, 'リビングの PC')
    await f.dom.pg.query(`update app.agent_device set last_seen_at = now() - interval '10 minutes' where id = $1`, [pc.agentId])
    expect((await ask(a,'getCollectStatus')).body.result.agents_online).toBe(0)

    expect((await pc.call('claim')).status).toBe(200)
    expect((await ask(a,'getCollectStatus')).body.result.agents_online).toBe(1)

    expect((await ask(a,'revokeAgentDevice', pc.agentId)).status).toBe(200)
    const devices = (await ask(a,'listAgentDevices')).body.result
    expect(devices[0]).toMatchObject({ revoked: true, online: false })
    expect((await ask(a,'getCollectStatus')).body.result.agents_online).toBe(0)
    // 重ねて取り消しても同じ
    expect((await ask(a,'revokeAgentDevice', pc.agentId)).status).toBe(200)
  })

  it('PC が無い世帯は空の一覧・オンライン 0', async () => {
    expect((await ask(a,'listAgentDevices')).body.result).toEqual([])
    expect((await ask(a,'getCollectStatus')).body.result.agents_online).toBe(0)
  })
})

describe('追跡番号', () => {
  it('仕入の追跡番号を返す。無ければ null、他の世帯の仕入は null、変な id でも 500 にしない', async () => {
    const shop = await a.run((ctx) => ctx.sql.get<{ id: string }>(
      `insert into shop_account (name, kind) values ('メロジョイ', 'mellojoy') returning id`))
    const p = await a.run((ctx) => ctx.sql.get<{ id: string }>(
      `insert into purchase (shop_account_id, ordered_at, status, tracking_number) values (?, '2026-10-01', 'draft', 'SF123') returning id`,
      shop!.id))
    const none = await a.run((ctx) => ctx.sql.get<{ id: string }>(
      `insert into purchase (shop_account_id, ordered_at, status) values (?, '2026-10-02', 'draft') returning id`, shop!.id))

    expect((await ask(a,'getTrackingNumber', p!.id)).body.result).toBe('SF123')
    expect((await ask(a,'getTrackingNumber', none!.id)).body.result).toBeNull()
    expect((await ask(b,'getTrackingNumber', p!.id)).body.result).toBeNull()
    for (const id of ['x', null, 1, {}]) expect((await ask(a,'getTrackingNumber', id)).status).toBeLessThan(500)
  })
})

describe('変な引数で 500 にならない', () => {
  const variants: unknown[][] = [[], [null], [''], ['x'], [1], [{}], [[]], [true], [{ id: 1 }], ['a', 'b', 'c']]
  for (const method of ['requestCollect', 'getCollectStatus', 'cancelCollectJob', 'listAgentDevices', 'revokeAgentDevice', 'getTrackingNumber']) {
    it(method, async () => {
      for (const args of variants) {
        await resetWorld(f)
        const r = await ask(f.world.a, method, ...args)
        expect(r.status, `${method}(${JSON.stringify(args)})`).toBeLessThan(500)
      }
    })
  }
})
