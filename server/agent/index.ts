// 取り込み担当の PC 用の API（/api/agent/<method>）。各メソッドの登録（registerAgentHandler の副作用）をまとめて読み込む。
// 入口は functions/api/agent/[method].ts
import './jobs'
import './sales'
import './orders'

export {
  handleAgent, dispatchAgent, agentHandlers, registerAgentHandler, isAgentMethod, agentMayQueueNotification, AGENT_METHOD_NAMES,
} from './handler'
export type { AgentDeps, AgentHandler, AgentHandlers } from './handler'
export { authenticateAgent, generateAgentKey, hashAgentKey, AGENT_KEY_RE } from './key'
export type { AgentIdentity } from './key'
export type { AgentCtx } from './lease'
