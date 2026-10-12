import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_METHOD_NAMES, agentHandlers } from '../../agent/index'
import {
  callAgent, closeFixture, leaseOf, openFixture, registerPc, resetWorld, startJob, type Fixture, type Pc,
} from './helpers'

// dispatch と同じく、変な引数で 500 にならない（検査に通らないものは 400/404/409。状態が壊れない）

let f: Fixture
let pc: Pc
let lease: ReturnType<typeof leaseOf>

beforeAll(async () => {
  f = await openFixture()
})

afterAll(async () => {
  await closeFixture(f)
})

beforeEach(async () => {
  await resetWorld(f)
  pc = await registerPc(f, f.world.a)
  lease = leaseOf(await startJob(f, f.world.a, pc))
})

const GARBAGE: unknown[][] = [
  [], [null], [undefined], [''], ['x'], [1], [-1], [1.5], [true], [{}], [[]], [{ a: 1 }], [[null]], [[{}]], [{ name: 1 }],
  [1, 2, 3], ['x', 'y'], [null, null], [{ status: 'done' }], [{ source: 'mercari' }], ['00000000-0000-4000-8000-000000000999'],
  [[{ mercariItemId: 1 }]], [[{ mercariItemId: 'm1', title: 't', price: -1, soldAt: 'x' }]], ['x'.repeat(5000)],
]

const LEASES: unknown[] = [
  undefined, null, 'x', 1, {}, [], { job_id: 'x' }, { job_id: 'x', lease_token: 'y' },
  { job_id: '00000000-0000-4000-8000-000000000999', lease_token: '00000000-0000-4000-8000-000000000998' },
]

describe('契約と表', () => {
  it('AgentApi の全メソッドが表にあり、register 以外は実装が登録されている', () => {
    expect(AGENT_METHOD_NAMES.length).toBe(22)
    for (const name of AGENT_METHOD_NAMES) {
      if (name === 'register') continue
      expect(typeof agentHandlers[name], name).toBe('function')
    }
  })
})

// register は人の JWT の経路（変な端末名は agent-auth.test.ts で確認）
describe('変な引数で 500 にならない', () => {
  it('lease が変なら、どのメソッドも 400 か 409（lease_lost）。何も書かない', async () => {
    for (const name of AGENT_METHOD_NAMES) {
      if (name === 'register' || name === 'claim') continue
      for (const bad of LEASES) {
        const r = await pc.call(name, bad)
        expect(r.status, `${name}(${JSON.stringify(bad)})`).toBeLessThan(500)
        expect(r.status, `${name}(${JSON.stringify(bad)})`).toBeGreaterThanOrEqual(400)
      }
    }
  })

  it('lease が正しくても、引数が変なら 4xx（500 にしない）。状態は壊れない', async () => {
    for (const name of AGENT_METHOD_NAMES) {
      if (name === 'register' || name === 'claim' || name === 'finish') continue
      for (const args of GARBAGE) {
        const r = await pc.call(name, lease, ...args)
        expect(r.status, `${name}(lease, ${JSON.stringify(args)}) → ${JSON.stringify(r.body)}`).toBeLessThan(500)
      }
    }
    // 取り込みはまだ走っていて、書き込みは 1 件も起きていない
    const rows = await f.dom.pg.query<{ n: number }>(
      `select (select count(*) from app.sale)::int + (select count(*) from app.listing)::int + (select count(*) from app.purchase)::int as n`)
    expect(rows.rows[0].n).toBe(0)
    expect((await pc.call('heartbeat', lease)).status).toBe(200)
  })

  it('finish も変な引数で 4xx（正しい終わり方だけが通る）', async () => {
    for (const args of GARBAGE) {
      const r = await pc.call('finish', lease, ...args)
      expect(r.status, `finish(lease, ${JSON.stringify(args)})`).toBeGreaterThanOrEqual(400)
      expect(r.status).toBeLessThan(500)
    }
    expect((await pc.call('heartbeat', lease)).status).toBe(200)
  })

  it('claim は引数を見ない（変な引数があっても 500 にならない）', async () => {
    for (const args of GARBAGE) {
      const r = await pc.call('claim', ...args)
      expect(r.status).toBe(200)
    }
  })
})

describe('入口', () => {
  it('args が無い・配列でない・巨大でも 400 か通常の応答（500 にしない）', async () => {
    for (const body of ['{}', '{"args":null}', '{"args":"x"}', '[]', 'null', '123', '"x"', '{"args":[' + '1,'.repeat(10) + '1]}']) {
      const r = await callAgent(f, 'claim', body, `Agent ${pc.token}`)
      expect(r.status, body).toBeLessThan(500)
    }
  })

  it('メソッド名が変でも 404（prototype のキーを拾わない）', async () => {
    for (const name of ['toString', 'hasOwnProperty', 'constructor', '__proto__', 'valueOf', '', 'REGISTER', 'claim ', '../claim']) {
      const r = await pc.call(name)
      expect(r.status, JSON.stringify(name)).toBe(404)
    }
  })
})
