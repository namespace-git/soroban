import type { AgentApi, AgentLease } from '../../shared/agent-types'

// ============================================================
// 収集のコードが帳簿に書く・読むときの入口（段の形）
//
// 収集（collector*.ts）は DB を直接呼ばず、ここの `CollectorStore` 経由で書く。
// 形は AgentApi（サーバーの /api/agent）の「段」から lease を取り除いたもの：
//   * 1 ページ分を集め終わってから、その分を 1 回で書く（販売一覧・取引中・出品・Yahoo の売上・仕入の 1 注文）
//   * 画像の対象・件数は段の戻り値で受け取る（書いた直後に別途読み直さない）
//   * 全メソッド Promise を返す（ローカルでも同じ形。取り込み担当モードで /api/agent に差し替える）
//
// 実装：
//   * local.ts … いまの SQLite（db.ts）を呼ぶ。冪等キーは持たない＝同じ段を 2 回呼べば今までと同じに 2 回動く
//   * （次の段で）/api/agent を呼ぶ実装。lease はそちらが持つ
//
// AgentApi のうち claim / heartbeat / finish / register（取り込み要求の受け渡し）は、帳簿を書く段ではないのでここに含めない。
// ============================================================

/** AgentApi のメソッドから先頭の lease 引数を取り除いた形 */
type WithoutLease<F> = F extends (lease: AgentLease, ...args: infer A) => infer R ? (...args: A) => R : never

/** 収集のコードが使う段（AgentApi のうち、帳簿を読む・書くもの） */
export type CollectorStoreMethod =
  // 読む
  | 'getCollectPlan'
  | 'listSalesNeedingDetail'
  | 'listSalesNeedingPurchasedAt'
  | 'existingImportKeys'
  | 'excludedOrders'
  | 'purchaseRevisitCandidates'
  // 実行記録
  | 'recordRun'
  // メルカリ・Yahoo!フリマ
  | 'ingestSoldPage'
  | 'ingestTrading'
  | 'ingestListingsPage'
  | 'ingestYahooSales'
  | 'saveThumb'
  | 'applySaleDescription'
  | 'setSalePurchasedAt'
  // メロジョイ
  | 'updateOrderFulfillments'
  | 'ingestOrder'
  | 'revisitOrder'
  | 'saveLineImage'

export type CollectorStore = { [K in CollectorStoreMethod]: WithoutLease<AgentApi[K]> }
