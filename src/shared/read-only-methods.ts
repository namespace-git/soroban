import type { SorobanApi } from './types'
import type { WebApi } from './web-types'

/**
 * 読み取りだけのメソッド。次の 2 か所が同じ一覧を見る（片方だけ直さないよう、ここに 1 本化した）。
 *
 * - サーバー（server/rpc.ts）：操作ログ（app_log）にも、応答のあとの通知の送信にも使わない
 *   （画面を開くたびに書き込む・DB に聞くのを避ける）。
 *   デスクトップの `UNLOGGED_HANDLERS`（src/main/index.ts）の読み取り分と、同じ読み取りだけのものを足した。
 *   ここに無い（書き込みの）メソッドは、成功すれば記録する
 * - 画面の HTTP クライアント（renderer/api/http.ts）：同時に出た同じ呼び出し（同じメソッド・同じ引数）を
 *   HTTP 1 本にまとめてよい。まとめるのは飛んでいる最中だけで、結果は使い回さない。
 *   書き込みは何があってもまとめないので、**書き込みのメソッドをここに入れないこと**
 *
 * 名前は契約と食い違えば型エラー。
 */
export const READ_ONLY: readonly (keyof SorobanApi | keyof WebApi)[] = [
  'getDashboard', 'getInbox', 'getSalesProgress', 'getInventoryOverview', 'listInventoryGroups', 'getProductKarte',
  'getMonthStatement', 'listPurchaseAccountCards', 'listSales', 'saleTotals', 'suggestInventory', 'suggestProductInventory',
  'getAutoLinkBlockers', 'listSaleLines', 'listSaleLinesBulk', 'listPurchases', 'getPurchase', 'listInventory', 'listMonthly', 'listExpenses',
  'getTrackingApiStatus', 'getAiStatus', 'testGemini', 'listGeminiModels', 'getMonthDetail', 'listTags',
  'getProduct', 'listProducts', 'getItemTimeline', 'listListings', 'suggestForListing', 'searchAll',
  'listShopAccounts', 'listShopAccountStats', 'listVariantSummary', 'listShippingMethods', 'getSettings',
  'getLastTrackingSummary', 'estimateSaleProfit', 'listSaleExclusions', 'listRuns', 'getHealthChecks', 'exportCsv',
  'getAutoBackupStatus', 'listCashAccounts', 'listLiabilities', 'listCashEntries', 'getCashMonth',
  'getCollectStatus', 'listAgentDevices', 'getPushConfig', 'listPushDevices', 'getTrackingNumber',
]

export const READ_ONLY_METHODS: ReadonlySet<string> = new Set<string>(READ_ONLY)
