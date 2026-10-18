import type { SorobanApi } from '../src/shared/types'
import type { WebApi } from '../src/shared/web-types'
import { authenticate, bearerToken, type Identity } from './auth'
import { serverEnvFrom, withHousehold, type Ctx, type HouseholdIds, type Net, type RawServerEnv } from './context'
import type { Sql } from './db/sql'
import { ApiError, describeError, HTTP_STATUS, INTERNAL_MESSAGE, mapDbError } from './errors'
import { drainDeliveries } from './push/deliver'
import { READ_ONLY_METHODS } from '../src/shared/read-only-methods'

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
  listSaleLinesBulk: true,
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
 * 読み取りだけのメソッドの一覧は `src/shared/read-only-methods.ts`（画面の HTTP クライアントと共有）。
 * ここでは操作ログ（app_log）と、応答のあとの通知の送信に使わない判定に使う。
 */

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
    // 認証は 1 回だけ（まとめ送り `_batch` も同じ）。失敗は要求全体の 401
    const identity = await authenticate(request, deps.root, deps.env)
    const dispatchDeps: DispatchDeps = {
      root: deps.root, identity, env: deps.env, handlers: deps.handlers,
      // 検証を通ったトークン。Storage をこの人の権限で呼ぶのに使う（ログ・応答には出さない）
      userJwt: bearerToken(request), fetch: deps.fetch, sleep: deps.sleep,
    }
    if (method === BATCH_METHOD) {
      // まとめ送り：形・本数・メソッドの検査が全部通ってから（1 本でも外れたら 400 で、何も実行しない）走らせる
      const calls = parseBatchCalls(await readJson(request))
      return await dispatchBatch(calls, dispatchDeps)
    }
    if (!isApiMethod(method)) throw new ApiError('not_found', `そのメソッドはありません：${method}`)
    const args = await readArgs(request)
    return await dispatch(method, args, dispatchDeps)
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
    const handler = lookupHandler(method, deps)
    const result = await runHandler(handler, method, args, deps)
    return jsonResponse(200, { result: result === undefined ? null : result })
  } catch (e) {
    return errorResponse(e, method)
  }
}

/** メソッド名からハンドラを引く。契約に無い名前は 404、契約にあるがハンドラが無ければ 501（どちらも ApiError を投げる） */
function lookupHandler(method: string, deps: DispatchDeps): Handler {
  if (!isApiMethod(method)) throw new ApiError('not_found', `そのメソッドはありません：${method}`)
  const table = deps.handlers ?? handlers
  // 継承されたキーを拾わない（isApiMethod で名前は絞ってあるが、差し替えたテーブルも自分のキーだけを見る）
  const handler = Object.prototype.hasOwnProperty.call(table, method) ? table[method] : undefined
  if (!handler) throw new ApiError('not_implemented', `Web 版ではまだ使えません：${method}`)
  return handler
}

function householdIdsOf(deps: DispatchDeps): HouseholdIds {
  return {
    ...deps.identity, mediaBase: deps.mediaBase, env: serverEnvFrom(deps.env),
    userJwt: deps.userJwt, fetch: deps.fetch, sleep: deps.sleep,
  }
}

/** ハンドラ 1 本を世帯のトランザクションで走らせ、戻り値を返す（失敗は投げる）。`dispatch` と、まとめ送りの phased が使う */
async function runHandler(handler: Handler, method: string, args: unknown[], deps: DispatchDeps): Promise<unknown> {
  const startedAt = Date.now()
  const ids = householdIdsOf(deps)
  const logged = async (ctx: Ctx) => {
    if (isLogged(method)) await logIpc(ctx, method, Date.now() - startedAt)
  }
  if (handler.phased) {
    // 通信を挟むハンドラ：read（トランザクション 1）→ call（トランザクションの外）→ finish（トランザクション 2）
    const parts = handler.phased
    const input = await withHousehold(deps.root, ids, (ctx) => parts.read(ctx, ...args))
    const called = await parts.call(input, { fetch: deps.fetch, sleep: deps.sleep })
    return withHousehold(deps.root, ids, async (ctx) => {
      const value = await parts.finish(ctx, input, called)
      await logged(ctx)
      return value
    })
  }
  return withHousehold(deps.root, ids, async (ctx) => {
    const value = await handler(ctx, ...args)
    await logged(ctx)
    return value
  })
}

// ---- まとめ送り（`POST /api/rpc/_batch`） ----
//
// 画面は 1 画面で読み取りの API を十数本、売上・仕入の画面は件数ぶんを同時に出す。HTTP 1 本ごとに Worker の起動・
// JWT の検証・DB への接続・世帯の切り替えがかかるので、**読み取りだけ**を 1 本の HTTP にまとめて送れる口を作った。
//
// 通信の形（画面の src/renderer/api/http.ts と合わせた契約。変えない）：
//   要求：`Authorization: Bearer <JWT>`、本文 `{"calls": [{"method": "listTags", "args": []}, …]}`（1〜25 本）
//   成功：`200 {"results": [{"result": <値>} | {"error": {"code", "message"}}, …]}`（calls と同じ順・同じ数）
//   失敗：形が違う・本数が範囲外・読み取りだけの一覧（READ_ONLY_METHODS）に無いメソッドが 1 本でもある → 要求全体を 400（何も実行しない）。
//         認証の失敗は要求全体を 401。ハンドラが投げた失敗は、その 1 本だけ error にして残りは続ける
//         （code・message は、同じ呼び出しを `/api/rpc/<method>` で呼んだときと同じ）。
//
// 走らせ方：
//   - 認証は 1 回。ふつうのハンドラは**1 つの withHousehold（1 接続・1 回の世帯の切り替え）の中で順に**走らせ、
//     1 本ずつ savepoint で包む（失敗した 1 本だけを巻き戻して続ける。巻き戻さないと以降が「トランザクションが中断している」で全滅する）。
//     最後は**コミット**（読み取りだけなので中身は変わらない。ロールバックにしても同じだが、コミットのほうが往復が少なく例外にもならない）。
//   - phased のハンドラ（通信を挟むもの）は、まとめのトランザクションに**入れない**。まとめのトランザクションがコミットされたあとで、
//     1 本ずつふつうの経路（`runHandler`）で走らせ、結果は元の位置に入れる（通信のあいだトランザクションを握らない約束）。
//     同時に走らせない（接続は 1 本なので、まとめのトランザクションの中で走らせると互いに待って固まる）。
//   - 読み取りだけなので操作ログ（app_log）は書かない。通知も送らない（`mayQueueNotification`）。

/** `/api/rpc/_batch` のメソッド名。SorobanApi/WebApi のメソッドではない（`isApiMethod` は false） */
export const BATCH_METHOD = '_batch'

/** 1 回にまとめられる呼び出しの数 */
export const BATCH_MIN_CALLS = 1
export const BATCH_MAX_CALLS = 25

export interface BatchCall {
  method: string
  args: unknown[]
}

export type BatchItem = { result: unknown } | { error: { code: string; message: string } }

/**
 * まとめ送りの本文を検査して呼び出しの列にする。**1 本でも外れたら ApiError('bad_request')**（呼び出し側は何も実行しない）。
 * メソッドは `READ_ONLY_METHODS` にあるものだけ（書き込み・`_batch` 自身・知らない名前・継承されたキーは全部断る）。
 */
export function parseBatchCalls(body: unknown): BatchCall[] {
  const calls = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { calls?: unknown }).calls : undefined
  if (!Array.isArray(calls)) {
    throw new ApiError('bad_request', '本文は {"calls": [{"method": "...", "args": [...]}, ...]} の形で送ってください')
  }
  if (calls.length < BATCH_MIN_CALLS || calls.length > BATCH_MAX_CALLS) {
    throw new ApiError('bad_request', `まとめて呼べるのは ${BATCH_MIN_CALLS}〜${BATCH_MAX_CALLS} 本です（${calls.length} 本届きました）`)
  }
  return calls.map((call: unknown, i): BatchCall => {
    const entry = typeof call === 'object' && call !== null && !Array.isArray(call) ? (call as { method?: unknown; args?: unknown }) : undefined
    if (!entry || typeof entry.method !== 'string' || !Array.isArray(entry.args)) {
      throw new ApiError('bad_request', `${i + 1} 本目の形が正しくありません（{"method": "...", "args": [...]} で送ってください）`)
    }
    if (!READ_ONLY_METHODS.has(entry.method)) {
      // 名前は利用者が送った値。長いものは切る
      const name = entry.method.length > 64 ? `${entry.method.slice(0, 64)}…` : entry.method
      throw new ApiError('bad_request', `${i + 1} 本目の ${name} はまとめて呼べません（まとめられるのは読み取りだけのメソッドです）`)
    }
    return { method: entry.method, args: entry.args }
  })
}

/** 検査済みの呼び出しを走らせて、`{"results": [...]}` の応答にする。ハンドラの失敗は 1 本ずつ error にする（インフラの失敗だけが 500） */
export async function dispatchBatch(calls: BatchCall[], deps: DispatchDeps): Promise<Response> {
  try {
    const items = await runBatch(calls, deps)
    return batchResponse(calls, items)
  } catch (e) {
    return errorResponse(e, BATCH_METHOD)
  }
}

async function runBatch(calls: BatchCall[], deps: DispatchDeps): Promise<BatchItem[]> {
  const items: BatchItem[] = new Array(calls.length)
  const handlerOf: Handler[] = new Array(calls.length)
  const plain: number[] = []
  const phased: number[] = []
  calls.forEach((call, i) => {
    try {
      const handler = lookupHandler(call.method, deps)
      handlerOf[i] = handler
      if (handler.phased) phased.push(i)
      else plain.push(i)
    } catch (e) {
      items[i] = errorItem(e, call.method)
    }
  })

  // ふつうのハンドラ：1 つの世帯のトランザクションの中で順に。1 本ずつ savepoint
  if (plain.length > 0) {
    await withHousehold(deps.root, householdIdsOf(deps), async (ctx) => {
      for (const i of plain) items[i] = await runInSavepoint(ctx, calls[i], handlerOf[i])
    })
  }

  // phased：まとめのトランザクションの外（上でコミット済み）。1 本ずつふつうの経路で
  for (const i of phased) {
    try {
      const value = await runHandler(handlerOf[i], calls[i].method, calls[i].args, deps)
      items[i] = { result: value === undefined ? null : value }
    } catch (e) {
      items[i] = errorItem(e, calls[i].method)
    }
  }
  return items
}

/**
 * 呼び出し 1 本を savepoint の中で走らせる。失敗したらその savepoint だけ巻き戻して error にする（外のトランザクションは生きたまま）。
 * ハンドラには**内側の sql を載せた ctx**を渡す（外側の `ctx.sql` を savepoint の中で使うと例外になる）。
 * `afterCommit` はこの 1 本のぶんを手元に貯め、成功したときだけ外の ctx に渡す（巻き戻した 1 本の後始末をコミット後に走らせない）。
 */
async function runInSavepoint(ctx: Ctx, call: BatchCall, handler: Handler): Promise<BatchItem> {
  const deferred: Array<() => Promise<void>> = []
  try {
    const value = await ctx.sql.tx((sql) =>
      handler({ ...ctx, sql, afterCommit: (task) => { deferred.push(task) } }, ...call.args))
    for (const task of deferred) ctx.afterCommit(task)
    return { result: value === undefined ? null : value }
  } catch (e) {
    return errorItem(e, call.method)
  }
}

/** ふつうの `/api/rpc/<method>` の失敗と同じ code・message（`toApiError`）にする。internal の原因はサーバーのログにだけ出る */
function errorItem(e: unknown, method: string): BatchItem {
  const apiError = toApiError(e, method)
  return { error: { code: apiError.code, message: apiError.message } }
}

/**
 * 1 本ずつ JSON にして並べる。JSON にできない値（bigint など）を返した 1 本だけが internal の error になり、他の結果は残る
 * （全体を 1 度に JSON にすると、1 本の不具合で全部が 500 になる）。
 */
function batchResponse(calls: BatchCall[], items: BatchItem[]): Response {
  const parts = items.map((item, i) => {
    try {
      return JSON.stringify(item)
    } catch (e) {
      console.error(`[rpc] ${calls[i].method}: 応答を JSON にできません`, describeError(e))
      return JSON.stringify({ error: { code: 'internal', message: INTERNAL_MESSAGE } })
    }
  })
  return new Response(`{"results":[${parts.join(',')}]}`, { status: 200, headers: JSON_HEADERS })
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

/**
 * 応答を返したあとに通知を急ぎで送ってよいか：成功し（＝コミットされ）、読み取りだけのメソッドではないとき。
 * まとめ送り（`_batch`）は読み取りだけなので送らない
 */
export function mayQueueNotification(method: string, response: Response): boolean {
  return response.ok && method !== BATCH_METHOD && !READ_ONLY_METHODS.has(method)
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

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new ApiError('bad_request', '要求の本文が JSON として読めません')
  }
}

async function readArgs(request: Request): Promise<unknown[]> {
  const body = await readJson(request)
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
