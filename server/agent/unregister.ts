import type { AgentCtx } from './lease'
import { registerAgentHandler } from './handler'

/**
 * この PC の鍵を捨てる（`POST /api/agent/unregister`。`Authorization: Agent <鍵>`）。
 * ログアウト・取り込み担当をやめるときに PC が呼ぶ。鍵の期限を「いま」にするので、この鍵では以後何も通らない
 * （`app.agent_of_token` は期限切れを引かない）。PC の行は残す（設定の一覧に出る。取り消しとは別）。
 *
 * この鍵で認証できた要求だけがここに来るので、捨てられるのは**自分の行**だけ（PC の id は鍵から決まる）。
 * 一度捨てた鍵でもう一度呼ぶと 401（認証で断られる）。PC は失敗しても止まらなくてよい（期限で切れる）
 */
export async function unregisterAgent(ctx: AgentCtx): Promise<void> {
  await ctx.sql.run(
    'update agent_device set token_expires_at = least(token_expires_at, clock_timestamp()) where id = ?',
    ctx.agentId,
  )
}

registerAgentHandler('unregister', unregisterAgent)
