import type { SorobanApi } from '../src/shared/types'
import type { WebApi } from '../src/shared/web-types'
import { authenticate, bearerToken, type Identity } from './auth'
import { serverEnvFrom, withHousehold, type Ctx, type HouseholdIds, type Net, type RawServerEnv } from './context'
import type { Sql } from './db/sql'
import { ApiError, describeError, HTTP_STATUS, INTERNAL_MESSAGE, mapDbError } from './errors'
import { drainDeliveries } from './push/deliver'

/**
 * `POST /api/rpc/<method>` の中身。通信の形（画面側と合わせた契約）：
 *
 * - 要求：`Authorization: Bearer <JWT>`、本文 `{"args": [...]}`
 * - 成功：`200 {"result": <値>}`（`undefined` は `null`）
 * - 失敗：`{"error": {"code": "<code>", "message": "<日本語>"}}`（`errors.ts`）
 */

/**
 * 業務ロジックの 1 本。第 1 引数が文脈、残りが `SorobanApi` のメソッドの引数。
 * `phased` があるものは `registerPhasedHandler` で登録した「通信を挟む」ハンドラで、`dispatch` は 3 段に分けて走らせる
 * （直接呼べば、1 つの ctx の中で 3 段を続けて走らせる）
 */
export type Handler = ((ctx: Ctx, ...args: any[]) => Promise<unknown>) & { phased?: PhasedParts }

/** 契約のメソッド `K` に型を合わせたハンドラ。`registerHandler` が使う */
export type HandlerFor<K extends keyof SorobanApi> = (
  ctx: Ctx,
  ...args: Parameters<SorobanApi[K]>
) => ReturnType<SorobanApi[K]>

/** Web 版だけの契約（`WebApi`）のメソッド `K` に型を合わせたハンドラ。`registerWebHandler` が使う */
export type WebHandlerFor<K extends keyof WebApi> = (ctx: Ctx, ...args: Parameters<WebApi[K]>) => ReturnType<WebApi[K]>

/**
 * 外部との長い通信（Gemini など）を挟むハンドラの 3 段。**通信のあいだ DB のトランザクションを握らない**ための分け方：
 *
 *   read   … 世帯のトランザクション（1 本目）の中。DB を読み、通信に要るもの（キー・パス・保存先の設定）を集めて返す。ここでコミット
 *   call   … **トランザクションの外**。通信だけ（ctx も DB も無い）。`read` の戻りと `net`（テストの fetch・sleep）だけを受け取る
 *   finish … 新しい世帯のトランザクション（2 本目）の中。通信の結果を整えて返す（DB を読んでも書いてもよい）
 *
 * read のあと finish までの間に他の操作が割り込んでもよい作りにすること（finish で必要なものは読み直す）。
 */
export interface PhasedParts<I = any, C = any> {
  read: (ctx: Ctx, ...args: any[]) => Promise<I>
  call: (input: I, net: Net) => Promise<C>
  finish: (ctx: Ctx, input: I, called: C) => Promise<unknown>
}

type ApiArgs<K> = K extends keyof SorobanApi ? Parameters<SorobanApi[K]> : K extends keyof WebApi ? Parameters<WebApi[K]> : never
type ApiResult<K> = K extends keyof SorobanApi ? ReturnType<SorobanApi[K]> : K extends keyof WebApi ? ReturnType<WebApi[K]> : never

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
 * 通信を挟むハンドラを 3 段（`PhasedParts`）で登録する。引数・戻り値の型は契約のとおり（食い違えば型エラー）。
 * `dispatch` はトランザクションを 2 本に分けて走らせる。直接呼ぶ（テスト・`deps.handlers` を使わない呼び出し）と、
 * 渡された ctx の中で 3 段を続けて走らせる。
 */
export function registerPhasedHandler<K extends keyof SorobanApi | keyof WebApi, I, C>(
  name: K,
  parts: {
    read: (ctx: Ctx, ...args: ApiArgs<K>) => Promise<I>
    call: (input: I, net: Net) => Promise<C>
    finish: (ctx: Ctx, input: I, called: C) => ApiResult<K>
  },
): void {
  const whole: Handler = async (ctx, ...args) => {
    const input = await parts.read(ctx, ...(args as ApiArgs<K>))
    const called = await parts.call(input, { fetch: ctx.fetch, sleep: ctx.sleep })
    return parts.finish(ctx, input, called)
  }
  whole.phased = parts as PhasedParts
  handlers[name] = whole
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
  prepareUpload: true,
  attachReceiptPath: true,
  readReceiptAt: true,
  setProductImagePath: true,
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

/**
 * 読み取りだけのメソッド。操作ログ（app_log）にも、応答のあとの通知の送信にも使わない
 * （画面を開くたびに書き込む・DB に聞くのを避ける）。
 * デスクトップの `UNLOGGED_HANDLERS`（src/main/index.ts）の読み取り分と、同じ読み取りだけのものを足した。
 * 名前は契約と食い違えば型エラー。ここに無い（書き込みの）メソッドは、成功すれば記録する
 */
const READ_ONLY: readonly (keyof SorobanApi | keyof WebApi)[] = [
  'getDashboard', 'getInbox', 'getSalesProgress', 'getInventoryOverview', 'listInventoryGroups', 'getProductKarte',
  'getMonthStatement', 'listPurchaseAccountCards', 'listSales', 'saleTotals', 'suggestInventory', 'suggestProductInventory',
  'getAutoLinkBlockers', 'listSaleLines', 'listPurchases', 'getPurchase', 'listInventory', 'listMonthly', 'listExpenses',
  'getTrackingApiStatus', 'getAiStatus', 'testGemini', 'listGeminiModels', 'getMonthDetail', 'listTags',
  'getProduct', 'listProducts', 'getItemTimeline', 'listListings', 'suggestForListing', 'searchAll',
  'listShopAccounts', 'listShopAccountStats', 'listVariantSummary', 'listShippingMethods', 'getSettings',
  'getLastTrackingSummary', 'estimateSaleProfit', 'listSaleExclusions', 'listRuns', 'getHealthChecks', 'exportCsv',
  'getAutoBackupStatus', 'listCashAccounts', 'listLiabilities', 'listCashEntries', 'getCashMonth',
  'getCollectStatus', 'listAgentDevices', 'getPushConfig', 'listPushDevices', 'getTrackingNumber',
]
const READ_ONLY_METHODS: ReadonlySet<string> = new Set<string>(READ_ONLY)

/**
 * 読み取りだけでも書き込みでもないが記録しないもの。logClient は記録用の呼び出しで、記録すると無限に増える。
 * API キーの設定は、デスクトップでは引数にキーが載るので記録しない。Web 版は引数を書かないが、揃えて記録しない
 */
const UNLOGGED_METHODS: ReadonlySet<string> = new Set<string>(
  ['logClient', 'setGeminiApiKey', 'setTrack17ApiKey'] satisfies (keyof SorobanApi)[],
)

/** このメソッドの成功を操作ログ（source='ipc'）に残すか。デスクトップの `handle` と同じ規則（書き込み系だけ） */
function isLogged(method: string): boolean {
  return !READ_ONLY_METHODS.has(method) && !UNLOGGED_METHODS.has(method)
}

export interface RpcDeps {
  /** 接続ロールの Sql（世帯の解決と、withHousehold の元）。トランザクションの外のもの */
  root: Sql
  /** Cloudflare の環境変数。`Ctx.env`（VAPID_*・SECRET_KEYS など）と、JWT の検証・画像の URL（SUPABASE_URL）に使う */
  env: RawServerEnv
  /** 既定は `handlers`。テストが差し替える */
  handlers?: Handlers
  /** 外部（Storage・Gemini）への通信の差し替え（テスト用）。入口は渡さない */
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
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
    return await dispatch(method, args, {
      root: deps.root, identity, env: deps.env, handlers: deps.handlers,
      // 検証を通ったトークン。Storage をこの人の権限で呼ぶのに使う（ログ・応答には出さない）
      userJwt: bearerToken(request), fetch: deps.fetch, sleep: deps.sleep,
    })
  } catch (e) {
    return errorResponse(e, method)
  }
}

export interface DispatchDeps {
  root: Sql
  /** `authenticate` の結果 */
  identity: Identity
  /** 環境変数。`Ctx.env` になり、画像の URL（`Ctx.mediaBase`）も SUPABASE_URL から作る。省略すると全部「無い」 */
  env?: RawServerEnv
  /** 画像の URL の頭を直接渡す（テスト用）。省略すると `env` から作る */
  mediaBase?: string | null
  handlers?: Handlers
  /** 要求した人のアクセストークン（`authenticate` を通ったもの）。`Ctx.userJwt` になる。省略は null（Storage は呼べない） */
  userJwt?: string | null
  /** 外部（Storage・Gemini）への通信の差し替え（テスト用）。`Ctx.fetch` / `Ctx.sleep` になる */
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

/**
 * 認証済みの要求をハンドラに渡す。
 * `SorobanApi` に無い名前は 404、契約にあるがハンドラが無ければ 501。
 * ハンドラは `withHousehold` の中（1 リクエスト＝1 トランザクション）で呼ぶ。例外は投げず、必ず Response を返す。
 * 例外：`registerPhasedHandler` で登録した「通信を挟む」ハンドラ（レシートの AI 読み取り）は、通信のあいだ
 * トランザクションを握らないよう、トランザクション 2 本（読み出し／整えて返す）とその間の通信に分けて走らせる。
 * 書き込み系のメソッドが成功したら、同じトランザクションの中で操作ログ（app_log）に 1 行残す（`logIpc`）。
 * `ctx.afterCommit` に積まれた後始末は、そのトランザクションがコミットされた後に走る（`withHousehold`）。
 */
export async function dispatch(method: string, args: unknown[], deps: DispatchDeps): Promise<Response> {
  try {
    if (!isApiMethod(method)) throw new ApiError('not_found', `そのメソッドはありません：${method}`)
    const table = deps.handlers ?? handlers
    // 継承されたキーを拾わない（isApiMethod で名前は絞ってあるが、差し替えたテーブルも自分のキーだけを見る）
    const handler = Object.prototype.hasOwnProperty.call(table, method) ? table[method] : undefined
    if (!handler) throw new ApiError('not_implemented', `Web 版ではまだ使えません：${method}`)
    const startedAt = Date.now()
    const ids: HouseholdIds = {
      ...deps.identity, mediaBase: deps.mediaBase, env: serverEnvFrom(deps.env),
      userJwt: deps.userJwt, fetch: deps.fetch, sleep: deps.sleep,
    }
    const logged = async (ctx: Ctx) => {
      if (isLogged(method)) await logIpc(ctx, method, Date.now() - startedAt)
    }
    let result: unknown
    if (handler.phased) {
      // 通信を挟むハンドラ：read（トランザクション 1）→ call（トランザクションの外）→ finish（トランザクション 2）
      const parts = handler.phased
      const input = await withHousehold(deps.root, ids, (ctx) => parts.read(ctx, ...args))
      const called = await parts.call(input, { fetch: deps.fetch, sleep: deps.sleep })
      result = await withHousehold(deps.root, ids, async (ctx) => {
        const value = await parts.finish(ctx, input, called)
        await logged(ctx)
        return value
      })
    } else {
      result = await withHousehold(deps.root, ids, async (ctx) => {
        const value = await handler(ctx, ...args)
        await logged(ctx)
        return value
      })
    }
    return jsonResponse(200, { result: result === undefined ? null : result })
  } catch (e) {
    return errorResponse(e, method)
  }
}

// 操作ログ（app_log）。デスクトップの handle（src/main/index.ts）が書き込み系の IPC を source='ipc' で書くのと同じ。
// ホームの「今日やったこと」（inbox.ts の done_today）がこれを数える。
// **引数は書かない**（API キーなどが入りうる）。kind・message はメソッド名。
// 14 日より古い行は書くたびに消す（master.ts の logClient と同じ）。書けなくてもリクエストは成功させる（savepoint の中で書く）
const LOG_RETENTION_DAYS = 14

async function logIpc(ctx: Ctx, method: string, durationMs: number): Promise<void> {
  try {
    await ctx.sql.tx(async (sql) => {
      await sql.run(`delete from app_log where ts < now() - make_interval(days => ${LOG_RETENTION_DAYS})`)
      await sql.run(
        `insert into app_log (source, kind, message, duration_ms) values ('ipc', ?, ?, ?)`,
        method, method, Math.max(0, Math.round(durationMs)),
      )
    })
  } catch (e) {
    // エラーのオブジェクトそのものは出さない（SQL の引数に個人データが入りうる）
    console.error('操作ログの書き込みに失敗しました', describeError(e))
  }
}

/** 応答を返したあとに、急ぎで送る通知の件数の上限。残りは Cron の Worker が 5 分以内に送る */
export const QUICK_DRAIN_LIMIT = 5

/** 応答を返したあとに通知を急ぎで送ってよいか：成功し（＝コミットされ）、読み取りだけのメソッドではないとき */
export function mayQueueNotification(method: string, response: Response): boolean {
  return response.ok && !READ_ONLY_METHODS.has(method)
}

/**
 * 応答を返したあとの後始末（入口が `waitUntil` に渡す）。
 * `notify` なら、コミットの済んだ通知を急ぎで送ってみる（失敗しても Cron が拾う。鍵が無ければ何もしない）。
 * **接続はそのあとで閉じる**（先に閉じると送れない）。例外は投げない。
 */
export async function closeAfterResponse(
  db: Sql & { end(): Promise<void> }, env: RawServerEnv, notify: boolean,
): Promise<void> {
  try {
    if (notify) await drainDeliveries(db, env, { limit: QUICK_DRAIN_LIMIT })
  } catch (e) {
    // 原因だけ。鍵・宛先は出さない（drainDeliveries のエラーにも入っていない）
    console.error('[push] 応答のあとの通知の送信に失敗しました', e instanceof Error ? `${e.name}: ${e.message}` : 'error')
  } finally {
    await db.end().catch(() => {})
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
  // それ以外は丸める。原因（名前・コード・メッセージ・スタック）はサーバーのログにだけ出す。
  // 引数・エラーのオブジェクトそのものは載せない（API キー・個人データが入りうる）
  console.error(`[rpc] ${method}: 予期しないエラー`, describeError(e))
  return new ApiError('internal', INTERNAL_MESSAGE)
}

function jsonResponse(status: number, body: unknown): Response {
  let text: string
  try {
    text = JSON.stringify(body)
  } catch (e) {
    // bigint など JSON にできない値がハンドラから返ってきた
    console.error('[rpc] 応答を JSON にできません', describeError(e))
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
