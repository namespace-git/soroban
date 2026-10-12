import type { SorobanApi } from '../src/shared/types'
import type { WebApi } from '../src/shared/web-types'
import { authenticate, type AuthEnv, type Identity } from './auth'
import { mediaBaseFromEnv, withHousehold, type Ctx } from './context'
import type { Sql } from './db/sql'
import { ApiError, HTTP_STATUS, INTERNAL_MESSAGE, mapDbError } from './errors'

/**
 * `POST /api/rpc/<method>` の中身。通信の形（画面側と合わせた契約）：
 *
 * - 要求：`Authorization: Bearer <JWT>`、本文 `{"args": [...]}`
 * - 成功：`200 {"result": <値>}`（`undefined` は `null`）
 * - 失敗：`{"error": {"code": "<code>", "message": "<日本語>"}}`（`errors.ts`）
 */

/** 業務ロジックの 1 本。第 1 引数が文脈、残りが `SorobanApi` のメソッドの引数 */
export type Handler = (ctx: Ctx, ...args: any[]) => Promise<unknown>

/** 契約のメソッド `K` に型を合わせたハンドラ。`registerHandler` が使う */
export type HandlerFor<K extends keyof SorobanApi> = (
  ctx: Ctx,
  ...args: Parameters<SorobanApi[K]>
) => ReturnType<SorobanApi[K]>

/** Web 版だけの契約（`WebApi`）のメソッド `K` に型を合わせたハンドラ。`registerWebHandler` が使う */
export type WebHandlerFor<K extends keyof WebApi> = (ctx: Ctx, ...args: Parameters<WebApi[K]>) => ReturnType<WebApi[K]>

export type Handlers = Partial<Record<keyof SorobanApi | keyof WebApi, Handler>>

/** メソッド名 → 実装。移植が済んだものからここに入る。無いものは 501 */
export const handlers: Handlers = {}

/** 契約どおりの引数・戻り値の型でハンドラを登録する（型が食い違えば型エラー） */
export function registerHandler<K extends keyof SorobanApi>(name: K, fn: HandlerFor<K>): void {
  handlers[name] = fn as Handler
}

/** Web 版だけの契約（`WebApi`）のハンドラを、契約どおりの型で登録する（型が食い違えば型エラー） */
export function registerWebHandler<K extends keyof WebApi>(name: K, fn: WebHandlerFor<K>): void {
  handlers[name] = fn as Handler
}

/**
 * 受け付けるメソッド名の一覧。**`SorobanApi` のキーだけ**（任意の文字列で任意の関数を呼ばせない）。
 * 型から実行時の配列は作れないので、ここに書き写す。
 * `satisfies Record<keyof SorobanApi, true>` なので、契約に足したのにここに無い／ここにあるのに契約に無い、
 * はどちらも型エラーになる。
 */
const API_METHOD_TABLE = {
  getDashboard: true,
  getInbox: true,
  snoozeReminder: true,
  getSalesProgress: true,
  getInventoryOverview: true,
  listInventoryGroups: true,
  getProductKarte: true,
  getMonthStatement: true,
  listPurchaseAccountCards: true,
  listSales: true,
  saleTotals: true,
  createSale: true,
  updateSale: true,
  deleteSale: true,
  linkInventory: true,
  autoLinkPending: true,
  unlinkInventory: true,
  getAutoLinkBlockers: true,
  suggestInventory: true,
  suggestProductInventory: true,
  listSaleLines: true,
  listPurchases: true,
  getPurchase: true,
  createPurchase: true,
  importPurchases: true,
  confirmPurchase: true,
  updatePurchaseNote: true,
  updatePurchaseFulfillment: true,
  deletePurchase: true,
  listInventory: true,
  updateInventory: true,
  splitInventory: true,
  mergeSplitInventory: true,
  disposeInventory: true,
  restoreInventory: true,
  openTracking: true,
  checkTracking: true,
  listMonthly: true,
  listExpenses: true,
  createExpense: true,
  updateExpense: true,
  deleteExpense: true,
  attachReceipt: true,
  removeReceipt: true,
  readReceiptImage: true,
  readReceipt: true,
  getTrackingApiStatus: true,
  setTrack17ApiKey: true,
  getAiStatus: true,
  setGeminiApiKey: true,
  setAiModel: true,
  testGemini: true,
  listGeminiModels: true,
  getMonthDetail: true,
  setMonthAllocMethod: true,
  closeMonth: true,
  reopenMonth: true,
  listTags: true,
  createTag: true,
  renameTag: true,
  deleteTag: true,
  setSaleTags: true,
  setInventoryTags: true,
  setPurchaseTags: true,
  setProductTags: true,
  setProductName: true,
  setProductNote: true,
  setProductImage: true,
  setProductImageAuto: true,
  refetchSaleDates: true,
  refetchPurchaseImages: true,
  listShopAccountStats: true,
  listVariantSummary: true,
  listProducts: true,
  getProduct: true,
  getItemTimeline: true,
  listListings: true,
  reserveInventory: true,
  unreserveInventory: true,
  suggestForListing: true,
  endListing: true,
  autoReserveListings: true,
  setListingShipping: true,
  searchAll: true,
  listShopAccounts: true,
  createShopAccount: true,
  updateShopAccount: true,
  deleteShopAccount: true,
  listShippingMethods: true,
  saveShippingMethod: true,
  deleteShippingMethod: true,
  getSettings: true,
  setSetting: true,
  collect: true,
  getLastTrackingSummary: true,
  openLogin: true,
  openYahooLogin: true,
  estimateSaleProfit: true,
  listSaleExclusions: true,
  removeSaleExclusion: true,
  openShopLogin: true,
  listRuns: true,
  getHealthChecks: true,
  exportCsv: true,
  getAutoBackupStatus: true,
  setAutoBackupEnabled: true,
  runAutoBackupNow: true,
  openBackupFolder: true,
  backupDb: true,
  restoreBackup: true,
  revealDbFolder: true,
  resetData: true,
  openChannelPage: true,
  listCashAccounts: true,
  createCashAccount: true,
  updateCashAccount: true,
  listLiabilities: true,
  createLiability: true,
  updateLiability: true,
  deleteLiability: true,
  listCashEntries: true,
  createCashEntry: true,
  deleteCashEntry: true,
  getCashMonth: true,
  logClient: true,
  checkForUpdate: true,
  installUpdate: true,
} satisfies Record<keyof SorobanApi, true>

/**
 * Web 版だけの契約（`WebApi`、src/shared/web-types.ts）のメソッド名。`API_METHOD_TABLE` と同じく、契約と食い違えば型エラー。
 * 画面からは `SorobanApi` と同じ `POST /api/rpc/<method>` で呼ぶ。`SorobanApi` と名前を重ねない。
 */
const WEB_API_METHOD_TABLE = {
  requestCollect: true,
  getCollectStatus: true,
  cancelCollectJob: true,
  listAgentDevices: true,
  revokeAgentDevice: true,
  getPushConfig: true,
  savePushSubscription: true,
  deletePushSubscription: true,
  listPushDevices: true,
  setPushKinds: true,
  sendTestPush: true,
  getTrackingNumber: true,
} satisfies Record<keyof WebApi, true>

/** `Object.keys` ではなく Set にして、`constructor`・`__proto__` などの継承されたキーを拾わない */
const API_METHODS: ReadonlySet<string> = new Set([
  ...Object.keys(API_METHOD_TABLE),
  ...Object.keys(WEB_API_METHOD_TABLE),
])

export function isApiMethod(name: string): name is keyof SorobanApi | keyof WebApi {
  return API_METHODS.has(name)
}

export const API_METHOD_NAMES: readonly (keyof SorobanApi | keyof WebApi)[] = [
  ...(Object.keys(API_METHOD_TABLE) as (keyof SorobanApi)[]),
  ...(Object.keys(WEB_API_METHOD_TABLE) as (keyof WebApi)[]),
]

export interface RpcDeps {
  /** 接続ロールの Sql（世帯の解決と、withHousehold の元）。トランザクションの外のもの */
  root: Sql
  env: AuthEnv
  /** 既定は `handlers`。テストが差し替える */
  handlers?: Handlers
}

/**
 * 要求 1 本を処理する：認証 → メソッド名 → 本文 → `dispatch`。
 * 認証を**最初**に行う（ログインしていない人にはメソッドの有無すら見せない）。例外は投げず、必ず Response を返す。
 */
export async function handleRpc(request: Request, method: string, deps: RpcDeps): Promise<Response> {
  try {
    const identity = await authenticate(request, deps.root, deps.env)
    if (!isApiMethod(method)) throw new ApiError('not_found', `そのメソッドはありません：${method}`)
    const args = await readArgs(request)
    return await dispatch(method, args, { root: deps.root, identity, env: deps.env, handlers: deps.handlers })
  } catch (e) {
    return errorResponse(e, method)
  }
}

export interface DispatchDeps {
  root: Sql
  /** `authenticate` の結果 */
  identity: Identity
  /** 画像の URL（`Ctx.mediaBase`）を作るのに SUPABASE_URL を見る。`mediaBase` を渡したときはそちらが先 */
  env?: AuthEnv
  /** 画像の URL の頭を直接渡す（テスト用）。省略すると `env` から作る */
  mediaBase?: string | null
  handlers?: Handlers
}

/**
 * 認証済みの要求をハンドラに渡す。
 * `SorobanApi` に無い名前は 404、契約にあるがハンドラが無ければ 501。
 * ハンドラは `withHousehold` の中（1 リクエスト＝1 トランザクション）で呼ぶ。例外は投げず、必ず Response を返す。
 */
export async function dispatch(method: string, args: unknown[], deps: DispatchDeps): Promise<Response> {
  try {
    if (!isApiMethod(method)) throw new ApiError('not_found', `そのメソッドはありません：${method}`)
    const table = deps.handlers ?? handlers
    // 継承されたキーを拾わない（isApiMethod で名前は絞ってあるが、差し替えたテーブルも自分のキーだけを見る）
    const handler = Object.prototype.hasOwnProperty.call(table, method) ? table[method] : undefined
    if (!handler) throw new ApiError('not_implemented', `Web 版ではまだ使えません：${method}`)
    const mediaBase = deps.mediaBase !== undefined ? deps.mediaBase : deps.env ? mediaBaseFromEnv(deps.env) : null
    const result = await withHousehold(deps.root, { ...deps.identity, mediaBase }, (ctx) => handler(ctx, ...args))
    return jsonResponse(200, { result: result === undefined ? null : result })
  } catch (e) {
    return errorResponse(e, method)
  }
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

function errorResponse(e: unknown, method: string): Response {
  const apiError = toApiError(e, method)
  return jsonResponse(HTTP_STATUS[apiError.code], { error: { code: apiError.code, message: apiError.message } })
}

function toApiError(e: unknown, method: string): ApiError {
  // UserError（業務ロジックの日本語）・認証・メソッド名の誤りは、そのまま利用者に見せてよい
  if (e instanceof ApiError) return e
  const mapped = mapDbError(e)
  if (mapped) return mapped
  // それ以外は丸める。原因（SQL・スタック）はサーバーのログにだけ出す。引数は載せない（API キーが入りうる）
  console.error(`[rpc] ${method}: 予期しないエラー`, e)
  return new ApiError('internal', INTERNAL_MESSAGE)
}

function jsonResponse(status: number, body: unknown): Response {
  let text: string
  try {
    text = JSON.stringify(body)
  } catch (e) {
    // bigint など JSON にできない値がハンドラから返ってきた
    console.error('[rpc] 応答を JSON にできません', e)
    return new Response(JSON.stringify({ error: { code: 'internal', message: INTERNAL_MESSAGE } }), {
      status: HTTP_STATUS.internal,
      headers: JSON_HEADERS,
    })
  }
  return new Response(text, { status, headers: JSON_HEADERS })
}

// 帳簿の中身なので、ブラウザや中間のキャッシュに残さない
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}
