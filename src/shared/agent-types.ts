// ============================================================
// 取り込み担当の PC 用の契約（AgentApi）
//
// 画面用の SorobanApi（types.ts）・WebApi（web-types.ts）とは別の入口。取り込み担当の PC だけが呼ぶ。
// 設計：docs/web/03-agent-and-push.md
//
// 通信：POST /api/agent/<method>
//   Authorization: Agent <鍵>       … register だけは人の JWT（Authorization: Bearer <JWT>）
//   本文 {"args":[...]}
//   成功 {"result":…}（undefined は null）
//   失敗 {"error":{"code":"…","message":"<日本語>"}}（コードは AgentErrorCode）
//
// 鍵（取り込み担当の鍵）：register が 12 時間の短命の鍵を 1 度だけ返す。PC のメモリにだけ持つ（保存しない）。
// 人の JWT では register 以外は通らない。鍵では画面の API（/api/rpc）は通らない。
//
// lease（取り込みの権限）：claim が返す job_id と lease_token。**書き込みは必ず lease を渡す**。
// サーバーは書き込みのトランザクションの先頭で lease を確かめる。失効していたら何も書かずに `lease_lost`（409）。
// lease_lost を受けたら、そのまま取り込みをやめる（再試行しない）。
//
// 段（ステージ）：1 回の呼び出し＝1 トランザクション。書き込みの段は「冪等キー」を持ち、同じ段を 2 回送ると
// 2 回目は何も書かずに `{ already: true }` を返す（通信が切れて送り直しても二重に入らない）。
// `already: true` のときは件数などの結果は返らない。
// ============================================================
import type {
  CollectorRun, CollectorSource, Fulfillment, PurchaseDraftInput, PurchaseInput, RunStatus, SaleStatus, SalesChannel,
} from './types'

/** 失敗のコード。lease_lost 以外は ErrorCode（server/errors.ts）と同じ */
export type AgentErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'not_implemented'
  | 'bad_request'
  | 'conflict'
  | 'lease_lost'
  | 'internal'

// ---- 資格・要求 ----

/** register の戻り。`token` はこの応答でしか見えない（DB には SHA-256 だけ） */
export interface AgentRegistration {
  agent_id: string
  name: string
  /** 取り込み担当の鍵。`Authorization: Agent <token>` で送る */
  token: string
  /** 鍵の期限（ISO。いまから 12 時間）。近づいたら、そのときのログインで register し直す */
  expires_at: string
}

/** 書き込み・読み取りのたびに渡す取り込みの権限 */
export interface AgentLease {
  job_id: string
  lease_token: string
}

/** claim の戻り。lease_token は画面には出ない */
export interface AgentClaim extends AgentLease {
  /** lease の期限（ISO。既定 3 分）。heartbeat（60 秒ごと）で延びる */
  lease_expires_at: string
  requested_at: string
}

export interface AgentHeartbeat {
  lease_expires_at: string
}

/**
 * done = 全部の段が終わった（実行記録が 1 つ以上あり、ok か empty だけ）／
 * partial = 途中で止まった／ failed = 失敗／ cancelled = PC 側でやめた
 */
export type AgentFinishStatus = 'done' | 'partial' | 'failed' | 'cancelled'

export interface AgentFinishInput {
  status: AgentFinishStatus
  /** recordRun が返した実行記録の id。結果（CollectJob.runs）はサーバーが DB から組み立てる */
  run_ids: string[]
  /** 人に見せる補足（500 文字まで）。無ければ実行記録から作る */
  message?: string | null
}

export interface AgentFinishResult {
  status: AgentFinishStatus
  finished_at: string
  /** 失敗・要ログイン・0 件の通知を新しく積んだか */
  notified: boolean
}

/** 取り込みの計画。取り込む仕入先（有効なメロジョイのアカウント）。キーワードは持たない（サーバーが見る） */
export interface AgentCollectPlan {
  shop_accounts: Array<{ id: string; name: string }>
}

/** 1 つの取り込み元（メルカリ・Yahoo!フリマ・メロジョイの 1 アカウント）が終わったときの記録 */
export interface AgentRunInput {
  source: CollectorSource
  /** メロジョイのときだけ必須 */
  shop_account_id?: string | null
  /** 始めた時刻（ISO）。省略すると取り込みを取った時刻。取った時刻より前・いまより後は丸める */
  started_at?: string | null
  /** 取得 0 件は ok にせず empty にする（静かな欠損を作らない） */
  status: RunStatus
  fetched: number
  inserted: number
  message?: string | null
}

// ---- 段の結果 ----

export type AgentStage<T = Record<never, never>> = { already: true } | ({ already: false } & T)

/** 画像を取りに行く対象（サーバーが「変わったときだけ」を判定して返す。予算で切るのは PC） */
export interface AgentThumbTarget {
  kind: 'sale' | 'listing'
  channel_item_id: string
  /** 画像の元 URL（クエリ込み＝画像の更新時刻） */
  thumb_url: string
}

/** Storage に上げた後のパスの確定 */
export interface AgentThumbInput {
  kind: 'sale' | 'listing'
  channel_item_id: string
  /** 取った元 URL。サーバーが正規化して thumb_src にする */
  thumb_url: string
  /** `<世帯の id>/` で始まる media バケットのパス（他の世帯のパスは断る） */
  path: string
}

// ---- メルカリ・Yahoo!フリマ（販売・出品） ----
// 行の形は collector の scrape の戻りそのまま（PC は読んだ行をそのまま送る。camelCase）

/** 販売履歴（売却済み）の 1 行。ScrapedSale */
export interface AgentSoldRow {
  mercariItemId: string
  title: string
  price: number
  fee: number | null
  shippingFee: number | null
  otherCost: number | null
  soldAt: string
  thumbUrl: string | null
}

export interface AgentSoldPageResult {
  inserted: number
  updated: number
  excluded_by_keyword: number
  excluded_deleted: number
  excluded_known_by_keyword: number
  thumb_targets: AgentThumbTarget[]
}

/** 取引中タブの 1 行。ScrapedTransaction（statusText・updatedText は送らない） */
export interface AgentTradingRow {
  mercariItemId: string
  title: string
  price: number
  /** 文言から解釈した状態。未知の文言なら null（決め打たない） */
  status: SaleStatus | null
  thumbUrl: string | null
}

export interface AgentTradingResult {
  inserted: number
  updated: number
  unknown_status: number
  excluded_by_keyword: number
  excluded_deleted: number
  thumb_targets: AgentThumbTarget[]
}

/** 出品中の 1 行。メルカリは ScrapedListing、Yahoo!フリマは YahooScrapedListing（yahooItemId を mercariItemId に入れる） */
export interface AgentListingRow {
  mercariItemId: string
  title: string
  price: number
  /** 「公開停止中」か。Yahoo!フリマでは見ない（false 扱い） */
  suspended: boolean
  thumbUrl: string | null
  updatedText?: string | null
  likes?: number | null
  /** 絶対的な出品日時（Yahoo!フリマの opentime）。新規行にだけ使う */
  listedAt?: string | null
}

export interface AgentListingsResult {
  inserted: number
  updated: number
  /** 出品停止に変わって引き当てを外した出品数・在庫点数 */
  released_listings: number
  released_items: number
  excluded_by_keyword: number
  thumb_targets: AgentThumbTarget[]
}

/** Yahoo!フリマの売上（取引中・取引完了の ② と 売上金管理の ③ を結合したもの）。YahooCombinedSale */
export interface AgentYahooSaleRow {
  yahooItemId: string
  title: string
  /** title が③の切れた商品名由来か（true のときキーワード判定をしない） */
  titleTruncated: boolean
  price: number
  fee: number
  shippingFee: number | null
  bundleCount: number | null
  soldAt: string
  status: SaleStatus | null
  thumbUrl: string | null
}

export interface AgentYahooSalesResult {
  inserted: number
  updated: number
  excluded_by_keyword: number
  excluded_deleted: number
  /** タイトルが切れていたため、キーワード判定をせずに取り込んだ新規の商品 id（実行記録に残す） */
  truncated_title_ids: string[]
  thumb_targets: AgentThumbTarget[]
}

/** 取引画面・商品ページを開く販売 */
export interface AgentSaleRef {
  id: string
  mercari_item_id: string
}

/** 型番救済で商品ページを開く販売。キーワードで絞った後の先頭 limit 件 */
export interface AgentDetailTargets {
  targets: AgentSaleRef[]
  /** 現在のキーワードに合わず対象から外した件数（limit で切る前の全体） */
  excluded_by_keyword: number
}

export interface AgentDescriptionResult {
  /** 説明文から拾えた型番の数 */
  codes_found: number
  /** 販売の型番に追記したか */
  applied: boolean
}

// ---- メロジョイ（仕入） ----

/** 注文詳細の配送セクションから読めたもの（applyFulfillmentFromShop と同じ形） */
export interface AgentShopFulfillment {
  status: Fulfillment | null
  shipped_at: string | null
  delivered_at: string | null
  carrier: string | null
  tracking_number: string | null
}

/** 明細の商品画像の元 URL。name は明細の名前（バリアント込み。既存の明細と完全一致のものだけ更新する） */
export interface AgentImageUrl {
  name: string
  image_url: string
}

/** 一覧の状態表示だけで更新する到着状態（既取込の注文） */
export interface AgentOrderFulfillmentUpdate {
  import_key: string
  fulfillment: Fulfillment | null
}

export interface AgentOrderInput {
  /** 注文番号（import_key は `mellojoy:<order_no>`） */
  order_no: string
  /**
   * 詳細ページから組み立てた結果。
   * confirmed / draft … toPurchaseInput の戻り。キーワードの絞り込みはサーバーが行う／
   * cancelled … 合計 0 円（キャンセル）と読めた
   */
  purchase:
    | { kind: 'confirmed'; input: PurchaseInput }
    | { kind: 'draft'; input: PurchaseDraftInput }
    | { kind: 'cancelled' }
  /** 詳細ページの配送セクション。読めなければ null */
  fulfillment: AgentShopFulfillment | null
  /** 下書きの明細の画像 URL（確定は input.lines[].image_url に入っている） */
  image_urls: AgentImageUrl[]
}

/**
 * confirmed / draft … 仕入を作った／ excluded … キーワード不一致で取り込まず除外を記録／
 * cancelled … キャンセルで除外を記録／ existing … すでにある（何もしない）
 */
export type AgentOrderOutcome = 'confirmed' | 'draft' | 'excluded' | 'cancelled' | 'existing'

/** 画像を取りに行く明細（image_url はあるが保存がまだ） */
export interface AgentImageTarget {
  id: string
  image_url: string
}

export interface AgentOrderResult {
  outcome: AgentOrderOutcome
  purchase_id: string | null
  /** 配送の状態・日付・追跡番号のどれかが変わったか */
  fulfillment_updated: boolean
  image_targets: AgentImageTarget[]
}

/** 既取込の注文の詳細を開き直す候補（巡回の順。前回の続きから） */
export interface AgentRevisitCandidate {
  id: string
  import_key: string
}

/** 開き直した結果。読めなかった（shouldSkipDetail・例外）ときは null を渡す（巡回の位置だけ進める） */
export interface AgentRevisitInput {
  image_urls: AgentImageUrl[]
  fulfillment: AgentShopFulfillment | null
}

export interface AgentRevisitResult {
  fulfillment_updated: boolean
  image_targets: AgentImageTarget[]
}

// ---- 契約 ----

export interface AgentApi {
  // --- 資格（register だけ人の JWT） ---
  /** 取り込み担当の鍵を出す。端末名が同じなら取り直し。取り消された PC は 409 */
  register(deviceName: string): Promise<AgentRegistration>

  // --- 取り込み要求 ---
  /** 積まれた要求を 1 本取る（20 秒ごと）。無ければ null。端末名・PC の id は鍵から決まる */
  claim(): Promise<AgentClaim | null>
  /** 60 秒ごと。lease を延ばす。失効していたら lease_lost */
  heartbeat(lease: AgentLease): Promise<AgentHeartbeat>
  /** 取り込みを終える。実行記録は先に recordRun で書いておく。通知（失敗・要ログイン・0 件）もここで積む */
  finish(lease: AgentLease, input: AgentFinishInput): Promise<AgentFinishResult>

  // --- 読む（lease を確かめる。何も書かない） ---
  getCollectPlan(lease: AgentLease): Promise<AgentCollectPlan>
  /** 型番救済で説明文を読む販売（メルカリ・転売・未紐付け・型番なし）。コレクターの listSales({onlyPending}) の絞り込み */
  listSalesNeedingDetail(lease: AgentLease, limit: number): Promise<AgentDetailTargets>
  /** 購入日時を取り直す販売（salesNeedingPurchasedAt） */
  listSalesNeedingPurchasedAt(lease: AgentLease, limit: number): Promise<AgentSaleRef[]>
  /** 既に取り込んだ注文のキー（existingImportKeys） */
  existingImportKeys(lease: AgentLease, keys: string[]): Promise<string[]>
  /** 前回キーワード不一致と分かっていて、キーワードが変わっていない注文番号（isMellojoyOrderExcluded） */
  excludedOrders(lease: AgentLease, shopAccountId: string, orderNos: string[]): Promise<string[]>
  /** 既取込の注文のうち詳細を開き直す理由があるもの（purchaseDetailRevisitCandidates）。前回の続きの順 */
  purchaseRevisitCandidates(lease: AgentLease, shopAccountId: string, importKeys: string[]): Promise<AgentRevisitCandidate[]>

  // --- 書く：実行記録 ---
  /** 取り込み元ごとの記録（startRun + finishRun）。終わったときに 1 度。同じ取り込み元を 2 回送ると前の記録を返す */
  recordRun(lease: AgentLease, run: AgentRunInput): Promise<CollectorRun>

  // --- 書く：メルカリ・Yahoo!フリマ ---
  /** 販売履歴の 1 ページ。冪等キー sales:<page> */
  ingestSoldPage(lease: AgentLease, page: number, rows: AgentSoldRow[]): Promise<AgentStage<AgentSoldPageResult>>
  /** 取引中のスナップショット。冪等キー trading */
  ingestTrading(lease: AgentLease, rows: AgentTradingRow[]): Promise<AgentStage<AgentTradingResult>>
  /** 出品の 1 ページ。冪等キー listings:<channel>:<page> */
  ingestListingsPage(
    lease: AgentLease, channel: SalesChannel, page: number, rows: AgentListingRow[],
  ): Promise<AgentStage<AgentListingsResult>>
  /** Yahoo!フリマの売上。冪等キー yahoo-sales:<page> */
  ingestYahooSales(lease: AgentLease, page: number, rows: AgentYahooSaleRow[]): Promise<AgentStage<AgentYahooSalesResult>>
  /** 画像 1 枚のパスの確定。冪等キー thumb:<kind>:<商品ID>:<元URL> */
  saveThumb(lease: AgentLease, input: AgentThumbInput): Promise<AgentStage>
  /** 説明文から型番を拾って販売に追記する。冪等キー detail:<販売の id> */
  applySaleDescription(lease: AgentLease, saleId: string, description: string): Promise<AgentStage<AgentDescriptionResult>>
  /** 購入日時を保存する（読めなかった null も「試行済み」として記録）。冪等キー purchased-at:<販売の id> */
  setSalePurchasedAt(lease: AgentLease, saleId: string, purchasedAt: string | null): Promise<AgentStage>

  // --- 書く：メロジョイ ---
  /** 既取込の注文の到着状態を一覧の表示で更新する（前に進む方向だけ）。冪等キー list-fulfillment:<仕入先> */
  updateOrderFulfillments(
    lease: AgentLease, shopAccountId: string, updates: AgentOrderFulfillmentUpdate[],
  ): Promise<AgentStage<{ updated: number }>>
  /** 注文 1 件。冪等キー order:mellojoy:<order_no> */
  ingestOrder(lease: AgentLease, shopAccountId: string, order: AgentOrderInput): Promise<AgentStage<AgentOrderResult>>
  /** 既取込の注文を開き直した結果（画像 URL・配送）。detail が null なら巡回の位置だけ進める。冪等キー revisit:<仕入の id> */
  revisitOrder(
    lease: AgentLease, shopAccountId: string, purchaseId: string, detail: AgentRevisitInput | null,
  ): Promise<AgentStage<AgentRevisitResult>>
  /** 明細の画像 1 枚のパスの確定。冪等キー line-image:<明細の id>:<パス> */
  saveLineImage(lease: AgentLease, lineId: string, path: string): Promise<AgentStage>
}
