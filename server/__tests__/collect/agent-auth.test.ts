import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Member } from '../domain/helpers'
import {
  ask, callAgent, callRpc, closeFixture, jwtOf, openFixture, registerPc, resetWorld, sha256hex, type Fixture,
} from './helpers'

// 取り込み担当の鍵：発行（平文は応答だけ・DB にはハッシュ）、照合、期限切れ・取り消し後は 401、
// 人の JWT では register 以外が通らない、鍵では画面の API が通らない

let f: Fixture
let a: Member
let b: Member
const logged: unknown[][] = []
const issued: string[] = []

beforeAll(async () => {
  f = await openFixture()
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args) })
  }
})

afterAll(async () => {
  // 鍵（平文）は、ログ・エラー文のどこにも出ていない
  const text = JSON.stringify(logged)
  for (const token of issued) expect(text).not.toContain(token)
  vi.restoreAllMocks()
  await closeFixture(f)
})

beforeEach(async () => {
  await resetWorld(f)
  a = f.world.a
  b = f.world.b
})

const bearer = async (m: Member): Promise<string> => `Bearer ${await jwtOf(f, m)}`

describe('鍵の発行（register）', () => {
  it('人の JWT で呼ぶと、2 時間の鍵を 1 度だけ返す。DB にはハッシュしかない', async () => {
    const r = await callAgent(f, 'register', ['リビングの PC'], await bearer(a))
    expect(r.status).toBe(200)
    const reg = r.body.result
    issued.push(reg.token)
    expect(reg.name).toBe('リビングの PC')
    // PC が画像を Storage に上げるパス（<世帯の id>/…）の先頭に使う。鍵を出した人の世帯の id
    expect(reg.household_id).toBe(a.householdId)
    expect(reg.token).toMatch(/^sbagent_[A-Za-z0-9_-]{43}$/)
    const hours = (new Date(reg.expires_at).getTime() - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(1.9)
    expect(hours).toBeLessThanOrEqual(2.01)

    const rows = (await f.dom.pg.query<Record<string, unknown>>('select * from app.agent_device where id = $1', [reg.agent_id])).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).toBe(sha256hex(reg.token))
    expect(rows[0].household_id).toBe(a.householdId)
    expect(rows[0].registered_by).toBe(a.userId)
    // どの列にも平文の鍵は無い
    expect(JSON.stringify(rows[0])).not.toContain(reg.token)
    // 他のテーブルにも残らない（app_log など）
    const all = await f.dom.pg.query<{ t: string }>(`select (select coalesce(string_agg(l::text, ''), '') from app.app_log l) as t`)
    expect(all.rows[0].t).not.toContain(reg.token)
  })

  it('発行のたびに別の鍵になる', async () => {
    const one = await registerPc(f, a, 'PC 1')
    const two = await registerPc(f, a, 'PC 2')
    issued.push(one.token, two.token)
    expect(one.token).not.toBe(two.token)
  })

  it('同じ端末名なら取り直し：同じ PC の行を使い回し、古い鍵は 401 になる', async () => {
    const first = await registerPc(f, a, 'リビングの PC')
    const second = await registerPc(f, a, 'リビングの PC')
    issued.push(first.token, second.token)
    expect(second.agentId).toBe(first.agentId)
    expect(second.token).not.toBe(first.token)

    expect((await first.call('claim')).status).toBe(401)
    expect((await second.call('claim')).status).toBe(200)
  })

  it('端末名が空・長すぎる・文字でないなら 400', async () => {
    for (const name of ['', '   ', 'x'.repeat(201), null, 123, {}]) {
      const r = await callAgent(f, 'register', [name], await bearer(a))
      expect(r.status, JSON.stringify(name)).toBe(400)
    }
    expect((await callAgent(f, 'register', [], await bearer(a))).status).toBe(400)
  })

  it('世帯に属さない人の JWT では 403、JWT が無い・壊れていれば 401', async () => {
    const stranger = await import('../rpc/helpers').then(async (h) => h.signToken({ key: f.key, sub: h.USER_NOBODY }))
    expect((await callAgent(f, 'register', ['PC'], `Bearer ${stranger}`)).status).toBe(403)
    expect((await callAgent(f, 'register', ['PC'], null)).status).toBe(401)
    expect((await callAgent(f, 'register', ['PC'], 'Bearer abc.def.ghi')).status).toBe(401)
  })

  it('取り消された PC には鍵を出さない（409・日本語）', async () => {
    const pc = await registerPc(f, a, 'リビングの PC')
    issued.push(pc.token)
    await a.call('revokeAgentDevice', pc.agentId)
    const r = await callAgent(f, 'register', ['リビングの PC'], await bearer(a))
    expect(r.status).toBe(409)
    expect(r.body.error?.message).toContain('取り消されている')
  })

  it('household_id は鍵を出した人の世帯の id（同じ端末名でも世帯ごとに別）。取り直しても変わらない', async () => {
    const ra = await callAgent(f, 'register', ['PC'], await bearer(a))
    const rb = await callAgent(f, 'register', ['PC'], await bearer(b))
    const again = await callAgent(f, 'register', ['PC'], await bearer(a))
    issued.push(ra.body.result.token, rb.body.result.token, again.body.result.token)
    expect(ra.body.result.household_id).toBe(a.householdId)
    expect(rb.body.result.household_id).toBe(b.householdId)
    expect(ra.body.result.household_id).not.toBe(rb.body.result.household_id)
    expect(again.body.result.household_id).toBe(a.householdId)
  })

  it('同じ端末名でも世帯が違えば別の PC', async () => {
    const pa = await registerPc(f, a, 'PC')
    const pb = await registerPc(f, b, 'PC')
    issued.push(pa.token, pb.token)
    expect(pa.agentId).not.toBe(pb.agentId)
    expect((await pa.call('claim')).status).toBe(200)
    expect((await pb.call('claim')).status).toBe(200)
  })
})

describe('鍵の照合', () => {
  it('正しい鍵は通り、last_seen_at が進む', async () => {
    const pc = await registerPc(f, a)
    issued.push(pc.token)
    await f.dom.pg.query(`update app.agent_device set last_seen_at = now() - interval '1 hour' where id = $1`, [pc.agentId])
    const before = (await f.dom.pg.query<{ t: Date | string }>('select last_seen_at as t from app.agent_device where id = $1', [pc.agentId])).rows[0].t
    const r = await pc.call('claim')
    expect(r.status).toBe(200)
    expect(r.body.result).toBeNull() // 積まれた要求が無い
    const after = (await f.dom.pg.query<{ t: Date | string }>('select last_seen_at as t from app.agent_device where id = $1', [pc.agentId])).rows[0].t
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime() + 3_000_000)
  })

  it('期限切れの鍵は 401', async () => {
    const pc = await registerPc(f, a)
    issued.push(pc.token)
    await f.dom.pg.query(`update app.agent_device set token_expires_at = now() - interval '1 minute' where id = $1`, [pc.agentId])
    const r = await pc.call('claim')
    expect(r.status).toBe(401)
    expect(r.body.error?.code).toBe('unauthorized')
    expect(JSON.stringify(r.body)).not.toContain(pc.token)
  })

  it('取り消した PC の鍵は 401', async () => {
    const pc = await registerPc(f, a)
    issued.push(pc.token)
    expect((await pc.call('claim')).status).toBe(200)
    await a.call('revokeAgentDevice', pc.agentId)
    expect((await pc.call('claim')).status).toBe(401)
  })

  it('知らない鍵・形の合わない鍵・ヘッダ無しは 401（DB には問い合わせない形のものも）', async () => {
    const fake = `sbagent_${'A'.repeat(43)}`
    for (const auth of [`Agent ${fake}`, 'Agent abc', 'Agent', 'Agent ', `agent ${fake}`.slice(0, 5), `Basic ${fake}`, null]) {
      const r = await callAgent(f, 'claim', [], auth)
      expect(r.status, String(auth)).toBe(401)
      expect(r.body.error?.code).toBe('unauthorized')
    }
  })

  it('メソッドの有無は鍵が通ってから：鍵なしの未知のメソッドは 401、鍵ありは 404', async () => {
    const pc = await registerPc(f, a)
    issued.push(pc.token)
    expect((await callAgent(f, 'noSuchMethod', [], null)).status).toBe(401)
    expect((await pc.call('noSuchMethod')).status).toBe(404)
    expect((await pc.call('constructor')).status).toBe(404)
    expect((await pc.call('__proto__')).status).toBe(404)
  })

  it('他の世帯の要求は取れない（世帯は鍵で決まる）', async () => {
    const pcA = await registerPc(f, a)
    issued.push(pcA.token)
    await b.call('requestCollect')
    const r = await pcA.call('claim')
    expect(r.status).toBe(200)
    expect(r.body.result).toBeNull()
  })

  it('本文が JSON でない・args が配列でない は 400', async () => {
    const pc = await registerPc(f, a)
    issued.push(pc.token)
    expect((await callAgent(f, 'claim', '{not json', `Agent ${pc.token}`)).status).toBe(400)
    expect((await callAgent(f, 'claim', '{"args": 1}', `Agent ${pc.token}`)).status).toBe(400)
    expect((await callAgent(f, 'claim', '', `Agent ${pc.token}`)).status).toBe(400)
  })
})

describe('人の JWT と鍵の取り違え', () => {
  it('人の JWT では register 以外の agent のメソッドが通らない', async () => {
    const pc = await registerPc(f, a)
    issued.push(pc.token)
    await a.call('requestCollect')
    for (const method of ['claim', 'heartbeat', 'finish', 'getCollectPlan', 'recordRun', 'ingestSoldPage', 'saveThumb']) {
      const r = await callAgent(f, method, [], await bearer(a))
      expect(r.status, method).toBe(401)
    }
    // 要求は誰にも取られていない
    expect((await ask(a, 'getCollectStatus')).body.result.job.status).toBe('queued')
  })

  it('取り込み担当の鍵では register が通らない（鍵から鍵は作れない）', async () => {
    const pc = await registerPc(f, a)
    issued.push(pc.token)
    const r = await callAgent(f, 'register', ['別の PC'], `Agent ${pc.token}`)
    expect(r.status).toBe(401)
    expect((await ask(a, 'listAgentDevices')).body.result).toHaveLength(1)
  })

  it('取り込み担当の鍵では画面の API（/api/rpc）が通らない', async () => {
    const pc = await registerPc(f, a)
    issued.push(pc.token)
    for (const auth of [`Agent ${pc.token}`, `Bearer ${pc.token}`]) {
      for (const method of ['getCollectStatus', 'requestCollect', 'listAgentDevices', 'listSales', 'getSettings']) {
        const r = await callRpc(f, method, [], auth)
        expect(r.status, `${auth.slice(0, 12)} ${method}`).toBe(401)
      }
    }
    // 鍵の取り違えで要求が積まれてもいない
    expect((await ask(a, 'getCollectStatus')).body.result.job).toBeNull()
  })
})
