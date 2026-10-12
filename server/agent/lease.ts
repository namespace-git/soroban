import type { AgentLease, AgentStage } from '../../src/shared/agent-types'
import type { Ctx } from '../context'
import { argId, argObject } from '../domain/_shared'

/** agent 用の文脈。`userId` は人ではなく PC の id（`app.user_id` は空にしてある） */
export interface AgentCtx extends Ctx {
  /** `agent_device.id` */
  agentId: string
}

/** 取り込みの権限が失効している／この PC の取り込みではない。応答のコードは `lease_lost`（409） */
export class LeaseLostError extends Error {
  constructor(message = '取り込みの権限が失効しています（時間切れか、別の端末が引き継ぎました）') {
    super(message)
    this.name = 'LeaseLostError'
  }
}

export function parseLease(v: unknown): AgentLease {
  const o = argObject('取り込みの権限', v)
  return { job_id: argId('取り込み', o.job_id), lease_token: argId('取り込みの権限', o.lease_token) }
}

/** この取り込みを取ったのが、いま呼んでいる PC か（lease_token が別の PC に渡っても書けないようにする） */
export async function assertOwner(ctx: AgentCtx, lease: AgentLease): Promise<void> {
  const own = await ctx.sql.get<{ ok: number }>(
    'select 1 as ok from collect_job where id = ? and agent_device_id = ?', lease.job_id, ctx.agentId,
  )
  if (!own) throw new LeaseLostError()
}

/**
 * **読み取り・書き込みのトランザクションの先頭で呼ぶ。**
 * `app.assert_lease`（job の行を for update で取る）→ 失効していれば SB003 で何も書かずに止まる。
 */
export async function assertLease(ctx: AgentCtx, lease: AgentLease): Promise<void> {
  await ctx.sql.get('select app.assert_lease(?, ?)', lease.job_id, lease.lease_token)
  await assertOwner(ctx, lease)
}

/**
 * 書き込みの段の先頭で呼ぶ。`app.begin_stage`（中で assert_lease）。
 * true＝初めて（続けて書く）／ false＝済み（何も書かずに「済み」を返す）。
 * 記録は書き込みと同じトランザクションなので、段の途中で失敗して巻き戻れば記録も消え、送り直せる
 */
export async function beginStage(ctx: AgentCtx, lease: AgentLease, stageKey: string): Promise<boolean> {
  const r = await ctx.sql.get<{ ok: boolean }>('select app.begin_stage(?, ?, ?) as ok', lease.job_id, lease.lease_token, stageKey)
  await assertOwner(ctx, lease)
  return r?.ok === true
}

/** 段 1 つ。済みなら `{ already: true }`、初めてなら fn の結果に `already: false` を足して返す */
export async function runStage<T extends object>(
  ctx: AgentCtx, lease: AgentLease, stageKey: string, fn: () => Promise<T>,
): Promise<AgentStage<T>> {
  if (!(await beginStage(ctx, lease, stageKey))) return { already: true }
  return { already: false, ...(await fn()) }
}
