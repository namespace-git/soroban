import type { AgentApi, AgentErrorCode } from '../../src/shared/agent-types'
import { authenticate } from '../auth'
import { mediaBaseFromEnv, serverEnvFrom, withHousehold, type RawServerEnv, type ServerEnv } from '../context'
import type { Sql } from '../db/sql'
import { ApiError, HTTP_STATUS, INTERNAL_MESSAGE, mapDbError, readDbError } from '../errors'
import { authenticateAgent, type AgentIdentity } from './key'
import { LeaseLostError, type AgentCtx } from './lease'
import { registerAgent } from './register'

/**
 * `POST /api/agent/<method>` の中身。通信の形は `src/shared/agent-types.ts` の冒頭のとおり：
 *
 * - register … `Authorization: Bearer <JWT>`（人のログイン。`server/auth.ts` の検証をそのまま使う）
 * - それ以外 … `Authorization: Agent <鍵>`（**人の JWT では通らない**）。鍵 → SHA-256 → `app.agent_of_token`
 *   （`set role` の前、接続ロールで）→ 世帯の中で（`withHousehold` と同じく `set local role soroban_api`）実行
 * - 本文 `{"args": [...]}`、成功 `200 {"result": …}`、失敗 `{"error": {"code": "…", "message": "<日本語>"}}`
 *
 * 認証を**最初**に行う（鍵のない人にはメソッドの有無すら見せない）。例外は投げず、必ず Response を返す。
 */

/** 業務ロジックの 1 本。第 1 引数が文脈、残りが `AgentApi` のメソッドの引数 */
export type AgentHandler = (ctx: AgentCtx, ...args: any[]) => Promise<unknown>

type RpcMethod = Exclude<keyof AgentApi, 'register'>

export type AgentHandlers = Partial<Record<RpcMethod, AgentHandler>>

export type AgentHandlerFor<K extends RpcMethod> = (
  ctx: AgentCtx,
  ...args: Parameters<AgentApi[K]>
) => ReturnType<AgentApi[K]>

/** メソッド名 → 実装 */
export const agentHandlers: AgentHandlers = {}

/** 契約どおりの引数・戻り値の型で登録する（型が食い違えば型エラー） */
export function registerAgentHandler<K extends RpcMethod>(name: K, fn: AgentHandlerFor<K>): void {
  agentHandlers[name] = fn as AgentHandler
}

/** 受け付けるメソッド名。契約と食い違えば型エラー（`rpc.ts` の API_METHOD_TABLE と同じ作り） */
const AGENT_METHOD_TABLE = {
  register: true,
  claim: true,
  heartbeat: true,
  finish: true,
  getCollectPlan: true,
  listSalesNeedingDetail: true,
  listSalesNeedingPurchasedAt: true,
  existingImportKeys: true,
  excludedOrders: true,
  purchaseRevisitCandidates: true,
  recordRun: true,
  ingestSoldPage: true,
  ingestTrading: true,
  ingestListingsPage: true,
  ingestYahooSales: true,
  saveThumb: true,
  applySaleDescription: true,
  setSalePurchasedAt: true,
  updateOrderFulfillments: true,
  ingestOrder: true,
  revisitOrder: true,
  saveLineImage: true,
} satisfies Record<keyof AgentApi, true>

const AGENT_METHODS: ReadonlySet<string> = new Set(Object.keys(AGENT_METHOD_TABLE))

export function isAgentMethod(name: string): name is keyof AgentApi {
  return AGENT_METHODS.has(name)
}

export const AGENT_METHOD_NAMES = Object.keys(AGENT_METHOD_TABLE) as (keyof AgentApi)[]

/**
 * 通知を積まないメソッド（鍵を出す・権限の更新・計画や既存の読み出しだけ）。入口が、応答のあとに通知を急ぎで送ってみるか
 * （`mayQueueNotification` の agent 版）を決めるのに使う。ここに無いもの（販売・注文の取り込み、finish）は、成功すれば送ってみる。
 * 名前は契約と食い違えば型エラー
 */
const AGENT_NO_NOTIFY: readonly (keyof AgentApi)[] = [
  'register', 'claim', 'heartbeat', 'getCollectPlan', 'listSalesNeedingDetail', 'listSalesNeedingPurchasedAt',
  'existingImportKeys', 'excludedOrders', 'purchaseRevisitCandidates',
]
const AGENT_NO_NOTIFY_METHODS: ReadonlySet<string> = new Set<string>(AGENT_NO_NOTIFY)

/** 応答を返したあとに通知を急ぎで送ってよいか：成功し（＝コミットされ）、通知を積まないメソッドではないとき */
export function agentMayQueueNotification(method: string, response: Response): boolean {
  return response.ok && !AGENT_NO_NOTIFY_METHODS.has(method)
}

export interface AgentDeps {
  /** 接続ロールの Sql（鍵の照合と、世帯のトランザクションの元）。トランザクションの外のもの */
  root: Sql
  /** Cloudflare の環境変数。`Ctx.env` と、JWT の検証・画像の URL（SUPABASE_URL）に使う */
  env: RawServerEnv
  /** 既定は `agentHandlers`。テストが差し替える */
  handlers?: AgentHandlers
}

export async function handleAgent(request: Request, method: string, deps: AgentDeps): Promise<Response> {
  try {
    if (method === 'register') {
      const identity = await authenticate(request, deps.root, deps.env)
      const args = await readArgs(request)
      const result = await withHousehold(
        deps.root, { ...identity, env: serverEnvFrom(deps.env) }, (ctx) => registerAgent(ctx, args[0]),
      )
      return jsonResponse(200, { result })
    }
    const agent = await authenticateAgent(request, deps.root)
    if (!isAgentMethod(method)) throw new ApiError('not_found', `そのメソッドはありません：${method}`)
    const args = await readArgs(request)
    return await dispatchAgent(method, args, { root: deps.root, agent, env: deps.env, handlers: deps.handlers })
  } catch (e) {
    return errorResponse(e, method)
  }
}

export interface AgentDispatchDeps {
  root: Sql
  /** `authenticateAgent` の結果 */
  agent: AgentIdentity
  /** 環境変数。`Ctx.env` になり、画像の URL（`Ctx.mediaBase`）も SUPABASE_URL から作る。省略すると全部「無い」 */
  env?: RawServerEnv
  mediaBase?: string | null
  handlers?: AgentHandlers
}

/** 認証済みの要求をハンドラに渡す。1 リクエスト＝1 トランザクション。例外は投げず、必ず Response を返す */
export async function dispatchAgent(method: string, args: unknown[], deps: AgentDispatchDeps): Promise<Response> {
  try {
    if (!isAgentMethod(method) || method === 'register') throw new ApiError('not_found', `そのメソッドはありません：${method}`)
    const table = deps.handlers ?? agentHandlers
    // 継承されたキーを拾わない
    const handler = Object.prototype.hasOwnProperty.call(table, method) ? table[method as RpcMethod] : undefined
    if (!handler) throw new ApiError('not_implemented', `Web 版ではまだ使えません：${method}`)
    const env = serverEnvFrom(deps.env)
    const mediaBase = deps.mediaBase !== undefined ? deps.mediaBase : mediaBaseFromEnv(env)
    const result = await withAgent(deps.root, deps.agent, mediaBase, env, (ctx) => handler(ctx, ...args))
    return jsonResponse(200, { result: result === undefined ? null : result })
  } catch (e) {
    return errorResponse(e, method)
  }
}

/**
 * 世帯の中で agent として動く。`withHousehold`（context.ts）と同じ順：
 * `set local search_path` → `set local role soroban_api`（ここから RLS が効く）→ `set_config(..., true)`。
 * agent は人ではないので `app.user_id` は空（押した人を名乗らない）。`ctx.userId` は PC の id。
 */
async function withAgent<T>(
  root: Sql, agent: AgentIdentity, mediaBase: string | null, env: ServerEnv, fn: (ctx: AgentCtx) => Promise<T>,
): Promise<T> {
  return root.tx(async (sql) => {
    await sql.run('set local search_path = app, public')
    await sql.run('set local role soroban_api')
    await sql.get("select set_config('app.household_id', ?, true), set_config('app.user_id', '', true)", agent.householdId)
    return fn({ sql, householdId: agent.householdId, userId: agent.agentId, agentId: agent.agentId, mediaBase, env })
  })
}

async function readArgs(request: Request): Promise<unknown[]> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new ApiError('bad_request', '要求の本文が JSON として読めません')
  }
  const args = typeof body === 'object' && body !== null ? (body as { args?: unknown }).args : undefined
  if (!Array.isArray(args)) throw new ApiError('bad_request', '本文は {"args": [...]} の形で送ってください')
  return args
}

const STATUS: Record<AgentErrorCode, number> = { ...HTTP_STATUS, lease_lost: 409 }

function errorResponse(e: unknown, method: string): Response {
  const { code, message } = toAgentError(e, method)
  return jsonResponse(STATUS[code], { error: { code, message } })
}

function toAgentError(e: unknown, method: string): { code: AgentErrorCode; message: string } {
  if (e instanceof LeaseLostError) return { code: 'lease_lost', message: e.message }
  if (e instanceof ApiError) return { code: e.code, message: e.message }
  // SB003＝取り込みの権限（lease）の失効。PC はこのコードを見て取り込みをやめる（409 conflict の他の理由と区別する）
  const info = readDbError(e)
  if (info?.code === 'SB003') return { code: 'lease_lost', message: info.message || new LeaseLostError().message }
  const mapped = mapDbError(e)
  if (mapped) return { code: mapped.code, message: mapped.message }
  // それ以外は丸める。原因はサーバーのログにだけ出す。引数・オブジェクトそのものは載せない（鍵・lease が入りうる）
  console.error(`[agent] ${method}: 予期しないエラー`, describeError(e))
  return { code: 'internal', message: INTERNAL_MESSAGE }
}

function describeError(e: unknown): Record<string, unknown> {
  if (e instanceof Error) return { name: e.name, code: (e as { code?: unknown }).code, message: e.message, stack: e.stack }
  return { value: String(e) }
}

function jsonResponse(status: number, body: unknown): Response {
  let text: string
  try {
    text = JSON.stringify(body)
  } catch (e) {
    console.error('[agent] 応答を JSON にできません', describeError(e))
    return new Response(JSON.stringify({ error: { code: 'internal', message: INTERNAL_MESSAGE } }), {
      status: HTTP_STATUS.internal,
      headers: JSON_HEADERS,
    })
  }
  return new Response(text, { status, headers: JSON_HEADERS })
}

// 鍵・lease を含む応答なので、ブラウザや中間のキャッシュに残さない
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}
