import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Member } from '../domain/helpers'
import { memberOf } from '../domain/helpers'
import {
  ask, callAgent, closeFixture, jwtOf, leaseOf, openFixture, registerPc, resetWorld, startJob, type Fixture,
} from '../collect/helpers'

// 取り込み担当の鍵を捨てる（POST /api/agent/unregister）と、鍵まわりの締め直しを API の入口から確かめる
// （20261012001900：2 時間の鍵・ログアウトで鍵を捨てる・生きている同じ名前は同じ人だけ・10 台まで・メンバーを外したら鍵が止まる）

let f: Fixture
let a: Member

beforeAll(async () => {
  f = await openFixture()
})

afterAll(async () => {
  vi.restoreAllMocks()
  await closeFixture(f)
})

beforeEach(async () => {
  await resetWorld(f)
  a = f.world.a
})

const bearer = async (m: Member): Promise<string> => `Bearer ${await jwtOf(f, m)}`

/** 世帯 A の 2 人目のメンバー（配偶者） */
async function spouse(): Promise<Member> {
  const userId = randomUUID()
  await f.dom.pg.query('insert into auth.users (id, email) values ($1, $2)', [userId, `${userId}@example.test`])
  await f.dom.pg.query('insert into app.household_member (household_id, user_id) values ($1, $2)', [a.householdId, userId])
  return memberOf(f.dom, a.householdId, userId)
}

const deviceRow = async (id: string) =>
  (await f.dom.pg.query<{ token_expires_at: Date | string; revoked_at: Date | string | null }>(
    'select token_expires_at, revoked_at from app.agent_device where id = $1', [id])).rows[0]

describe('unregister（鍵を捨てる）', () => {
  it('鍵の期限がいまになり、以後その鍵では何も通らない（claim・heartbeat・unregister のやり直しも 401）。PC の行は残る', async () => {
    const pc = await registerPc(f, a)
    const lease = await startJob(f, a, pc)
    expect((await pc.call('heartbeat', leaseOf(lease))).status).toBe(200)

    const r = await pc.call('unregister')
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.result).toBeNull()

    expect(new Date((await deviceRow(pc.agentId)).token_expires_at).getTime()).toBeLessThanOrEqual(Date.now())
    for (const [method, args] of [['claim', []], ['heartbeat', [leaseOf(lease)]], ['unregister', []]] as const) {
      const again = await pc.call(method, ...args)
      expect(again.status, method).toBe(401)
      expect(again.body.error?.code, method).toBe('unauthorized')
      expect(JSON.stringify(again.body), method).not.toContain(pc.token)
    }
    // 設定の一覧には残る（取り消しとは別。revoked にはならない）
    const devices = (await ask(a, 'listAgentDevices')).body.result as Array<{ id: string; revoked: boolean }>
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ id: pc.agentId, revoked: false })
    expect((await deviceRow(pc.agentId)).revoked_at).toBeNull()
  })

  it('捨てられるのは呼んだ PC の鍵だけ。同じ世帯のほかの PC・ほかの世帯の PC は影響を受けない', async () => {
    const one = await registerPc(f, a, 'PC 1')
    const two = await registerPc(f, a, 'PC 2')
    const other = await registerPc(f, f.world.b, 'PC 1')

    expect((await one.call('unregister', two.agentId)).status).toBe(200) // 引数は見ない（他の PC の id を渡しても自分の鍵が捨てられるだけ）
    expect((await one.call('claim')).status).toBe(401)
    expect((await two.call('claim')).status).toBe(200)
    expect((await other.call('claim')).status).toBe(200)
  })

  it('人の JWT・鍵なし・形の合わない鍵では呼べない（401）。呼んでも何も捨てられない', async () => {
    const pc = await registerPc(f, a)
    for (const auth of [await bearer(a), null, 'Agent abc', `Agent sbagent_${'A'.repeat(43)}`]) {
      const r = await callAgent(f, 'unregister', [], auth)
      expect(r.status, String(auth).slice(0, 20)).toBe(401)
    }
    expect((await pc.call('claim')).status).toBe(200)
  })

  it('捨てたあと、同じ名前で取り直せる（自分でも、配偶者でも）。古い鍵は戻らない', async () => {
    const other = await spouse()
    const first = await registerPc(f, a, 'リビングの PC')
    expect((await first.call('unregister')).status).toBe(200)

    // 配偶者が同じ PC でログインして、同じ名前を取れる（鍵が死んでいるので SB008 にならない）
    const second = await registerPc(f, other, 'リビングの PC')
    expect(second.agentId).toBe(first.agentId)
    expect((await first.call('claim')).status).toBe(401)
    expect((await second.call('claim')).status).toBe(200)
  })

  it('通知を積まない（鍵を捨てるだけ）', async () => {
    const pc = await registerPc(f, a)
    await pc.call('unregister')
    const n = await f.dom.pg.query<{ n: number }>('select count(*)::int as n from app.notification_event where household_id = $1', [a.householdId])
    expect(n.rows[0].n).toBe(0)
  })
})

describe('生きている同じ名前の PC は、鍵を作った人だけが取り直せる', () => {
  it('配偶者は、鍵が生きている間は同じ名前で鍵を出せない（409・日本語）。元の鍵は無事', async () => {
    const other = await spouse()
    const pc = await registerPc(f, a, 'リビングの PC')

    const r = await callAgent(f, 'register', ['リビングの PC'], await bearer(other))
    expect(r.status).toBe(409)
    expect(r.body.error?.code).toBe('conflict')
    expect(r.body.error?.message).toContain('ほかの人のログインで使われています')
    expect((await pc.call('claim')).status).toBe(200)

    // 同じ人の取り直しは通る
    const again = await callAgent(f, 'register', ['リビングの PC'], await bearer(a))
    expect(again.status).toBe(200)
    expect((await pc.call('claim')).status).toBe(401) // 古い鍵は使えなくなる
  })
})

describe('取り消されていない PC は 10 台まで', () => {
  it('11 台目は 409（日本語）。取り直しは台数を増やさない。外せば足せる', async () => {
    const pcs = []
    for (let i = 1; i <= 10; i++) pcs.push(await registerPc(f, a, `PC ${i}`))

    const r = await callAgent(f, 'register', ['PC 11'], await bearer(a))
    expect(r.status).toBe(409)
    expect(r.body.error?.message).toContain('10 台まで')
    expect((await callAgent(f, 'register', ['PC 10'], await bearer(a))).status).toBe(200)

    expect((await ask(a, 'revokeAgentDevice', pcs[0].agentId)).status).toBe(200)
    expect((await callAgent(f, 'register', ['PC 11'], await bearer(a))).status).toBe(200)
    // 別の世帯は別に数える
    expect((await callAgent(f, 'register', ['PC 1'], await bearer(f.world.b))).status).toBe(200)
  })
})

describe('鍵を作った人が世帯から外れたら、鍵が止まる', () => {
  it('メンバーを外すと、その人が出した鍵は 401 になり、設定の一覧では取り消し済みになる。残った人の PC は動く', async () => {
    const other = await spouse()
    const mine = await registerPc(f, a, 'PC-A')
    const theirs = await registerPc(f, other, 'PC-B')
    expect((await theirs.call('claim')).status).toBe(200)

    await f.dom.pg.query('delete from app.household_member where household_id = $1 and user_id = $2', [a.householdId, other.userId])

    expect((await theirs.call('claim')).status).toBe(401)
    expect((await mine.call('claim')).status).toBe(200)
    const devices = (await ask(a, 'listAgentDevices')).body.result as Array<{ name: string; revoked: boolean }>
    expect(devices.map((d) => [d.name, d.revoked])).toEqual([['PC-A', false], ['PC-B', true]])
  })
})
