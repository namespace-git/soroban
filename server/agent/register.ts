import type { AgentRegistration } from '../../src/shared/agent-types'
import type { Ctx } from '../context'
import { argText } from '../domain/_shared'
import { UserError } from '../errors'
import { AGENT_KEY_TTL_HOURS, generateAgentKey, hashAgentKey } from './key'

/**
 * 取り込み担当の鍵を出す（`POST /api/agent/register`）。**人の JWT で呼ぶ唯一のメソッド**。
 *
 * 32 バイトの乱数の鍵を作り、SHA-256 の 16 進だけを `app.register_agent_device` に渡す。
 * **平文の鍵はこの応答で 1 度だけ返す**（DB にもログにも出さない）。期限は 12 時間（DB の時計で数える）。
 * 同じ端末名なら行を使い回して鍵と期限を差し替える（取り直し）。取り消された PC には出さない（SB006・409）。
 */
export async function registerAgent(ctx: Ctx, deviceName: unknown): Promise<AgentRegistration> {
  const name = argText('端末の名前', deviceName, { max: 200 }).trim()
  if (!name) throw new UserError('端末の名前を入れてください')

  const token = generateAgentKey()
  const row = await ctx.sql.get<{ id: string; name: string; token_expires_at: string }>(
    'select id, name, token_expires_at from app.register_agent_device(?, ?, now() + ?::interval)',
    name, await hashAgentKey(token), `${AGENT_KEY_TTL_HOURS} hours`,
  )
  if (!row) throw new Error('register_agent_device が行を返しませんでした')
  return { agent_id: row.id, name: row.name, household_id: ctx.householdId, token, expires_at: row.token_expires_at }
}
