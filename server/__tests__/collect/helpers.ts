import { createHash } from 'node:crypto'
import { expect, vi } from 'vitest'
import type { AgentLease, AgentRegistration } from '../../../src/shared/agent-types'
import { handleAgent } from '../../agent/index'
// WebApi の 6 本の登録（registerWebHandler の副作用）。ドメインの index は親が足すので、ここでは直接読む
import '../../domain/collect'
import { requestCollect } from '../../domain/collect'
import { handleRpc } from '../../rpc'
import { makeKey, signToken, stubJwks, type KeyPair } from '../rpc/helpers'
import { SUPABASE_URL, newWorld, openDomainDb, type DomainDb, type Member, type World } from '../domain/helpers'

export { SUPABASE_URL }

// 取り込みの要求と取り込み担当の PC（server/domain/collect.ts・server/agent/）のテスト用の道具。
// 本物のマイグレーションを流した PGlite に世帯 A・B を作り、JWT（ES256・JWKS は fetch を差し替え）から
// handleAgent / handleRpc まで本物の入口を通す

export interface Fixture {
  dom: DomainDb
  key: KeyPair
  /** テストごとに作り直す世帯（A・B）。DB は使い回す */
  world: World
}

export async function openFixture(): Promise<Fixture> {
  const dom = await openDomainDb()
  const key = await makeKey('collect-key')
  stubJwks([key])
  return { dom, key, world: await newWorld(dom) }
}

export async function closeFixture(f: Fixture): Promise<void> {
  vi.unstubAllGlobals()
  await f.dom.close()
}

/** 世帯 A・B を作り直す（取り込みの要求・クールダウンを持ち越さない） */
export async function resetWorld(f: Fixture): Promise<void> {
  f.world = await newWorld(f.dom)
}

export interface Resp {
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: { result?: any; error?: { code: string; message: string } }
}

async function send(handle: (req: Request) => Promise<Response>, url: string, auth: string | null, body: unknown): Promise<Resp> {
  const headers: Record<string, string> = {}
  if (auth !== null) headers.authorization = auth
  const request = new Request(url, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const response = await handle(request)
  return { status: response.status, body: JSON.parse(await response.text()) }
}

/**
 * 画面の API を世帯の一員として呼ぶ。`Member.call` は result を unknown で返すので、
 * テストで中身を読めるよう result が any の `Resp` にして返す
 */
export const ask = (member: Member, method: string, ...args: unknown[]): Promise<Resp> =>
  member.call(method, ...args) as Promise<Resp>

export const jwtOf = async (f: Fixture, member: Member): Promise<string> => signToken({ key: f.key, sub: member.userId })

/** `/api/agent/<method>` を呼ぶ。auth は Authorization ヘッダの中身そのまま（無しは null） */
export function callAgent(f: Fixture, method: string, args: unknown, auth: string | null): Promise<Resp> {
  const body = typeof args === 'string' ? args : { args }
  return send(
    (req) => handleAgent(req, method, { root: f.dom.root, env: { SUPABASE_URL } }),
    `http://localhost/api/agent/${method}`, auth, body,
  )
}

/** `/api/rpc/<method>` を呼ぶ（画面の API。JWT か、鍵の取り違えの確認用に任意の Authorization） */
export function callRpc(f: Fixture, method: string, args: unknown[], auth: string | null): Promise<Resp> {
  return send(
    (req) => handleRpc(req, method, { root: f.dom.root, env: { SUPABASE_URL } }),
    `http://localhost/api/rpc/${method}`, auth, { args },
  )
}

/** 取り込み担当の PC。鍵を持ち、`call` で agent の API を呼ぶ */
export interface Pc {
  token: string
  agentId: string
  name: string
  expiresAt: string
  call(method: string, ...args: unknown[]): Promise<Resp>
}

function pcOf(f: Fixture, reg: AgentRegistration): Pc {
  return {
    token: reg.token,
    agentId: reg.agent_id,
    name: reg.name,
    expiresAt: reg.expires_at,
    call: (method, ...args) => callAgent(f, method, args, `Agent ${reg.token}`),
  }
}

/** 人の JWT で鍵を出して、PC として動く（register は人の JWT を使う唯一のメソッド） */
export async function registerPc(f: Fixture, member: Member, name = 'リビングの PC'): Promise<Pc> {
  const r = await callAgent(f, 'register', [name], `Bearer ${await jwtOf(f, member)}`)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return pcOf(f, r.body.result as AgentRegistration)
}

/** 取り込みを頼み（画面）、PC が取る。lease（job_id・lease_token）を返す */
export async function startJob(f: Fixture, member: Member, pc: Pc): Promise<AgentLease & { lease_expires_at: string }> {
  await member.run((ctx) => requestCollect(ctx))
  const claimed = await pc.call('claim')
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(200)
  expect(claimed.body.result, '取り込みが取れませんでした').not.toBeNull()
  const r = claimed.body.result as AgentLease & { lease_expires_at: string }
  return { job_id: r.job_id, lease_token: r.lease_token, lease_expires_at: r.lease_expires_at }
}

export const leaseOf = (j: AgentLease): AgentLease => ({ job_id: j.job_id, lease_token: j.lease_token })

/** 次の取り込みを頼めるよう、最後に始めた時刻を古くする（持ち主のロールで時計を巻き戻す） */
export async function passCooldown(f: Fixture, member: Member): Promise<void> {
  await f.dom.pg.query(`update app.collect_job set claimed_at = now() - interval '1 hour' where household_id = $1`, [member.householdId])
}

/** 持ち主のロールで job の時計を過去にする（失効させる） */
export async function expireLease(f: Fixture, jobId: string): Promise<void> {
  await f.dom.pg.query(`update app.collect_job set lease_expires_at = now() - interval '1 minute' where id = $1`, [jobId])
}

export const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex')

export async function count(f: Fixture, sql: string, ...params: unknown[]): Promise<number> {
  const r = await f.dom.pg.query<{ n: number | string }>(sql, params)
  return Number(r.rows[0].n)
}
