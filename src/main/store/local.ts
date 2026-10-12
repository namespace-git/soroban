import * as db from '../db'
import { extractCodes } from '../code'
import { todayLocal } from '../../shared/date'
import type {
  AgentImageTarget, AgentImageUrl, AgentOrderResult, AgentSoldRow, AgentStage, AgentThumbTarget, AgentYahooSaleRow,
} from '../../shared/agent-types'
import type { SalesChannel } from '../../shared/types'
import {
  filterPurchaseDraftByKeywords, filterPurchaseInputByKeywords, hashKeywords, splitYahooCombinedSales,
} from './rules'
import type { CollectorStore } from './types'

// ============================================================
// ローカルの store：いまの SQLite（db.ts）に書く
//
// 各段は、収集のコード（collector*.ts）が今まで `db.x(...)` を呼んでいた並びを、そのままの順・同じ関数で
// 1 つにまとめたもの。サーバー側の段（server/agent/sales.ts・orders.ts・jobs.ts）と同じ順で同じ規則（キーワードの絞り込み・
// 削除済みの除外・取引中の判定・型番の救済）をここで行うので、PC は「読んだ行をそのまま送る」だけでよい。
//
// ローカルは冪等キーを持たない（同じ段を 2 回呼べば、今までと同じに 2 回動く）。戻りは常に `already: false`。
// どの段も await を挟まずに最後まで走る（読んでから書くまでの間に、同時に走っている別の収集の書き込みが
// 割り込まない＝今までの同期呼びと同じ）。
// ============================================================

/** 結果を `already: false` つきで返す */
function stage<T extends object>(value: T): AgentStage<T> {
  return { already: false as const, ...value }
}

/** 出品先ごとの取り込みキーワード（設定 mercari_keyword / yahoo_keyword）。空なら全部取り込む */
function channelKeywords(channel: SalesChannel): string[] {
  return db.parseKeywords(db.getSettings()[`${channel}_keyword`] ?? '')
}

/** 仕入先の取り込みキーワード（shop_account.import_keywords）。空なら全部取り込む */
function shopKeywords(shopAccountId: string): string[] {
  return db.parseKeywords(db.getShopAccount(shopAccountId)?.import_keywords ?? '')
}

/** 巡回の位置（注文詳細を開き直す順の続き）を覚える設定のキー */
const cursorKey = (shopAccountId: string): string => `mellojoy_image_cursor:${shopAccountId}`

/** 明細の名前がキーワードに一致するものだけ（保存済みの明細へ名前の完全一致で画像の URL を書く前の絞り込み） */
const keywordImageUrls = (urls: AgentImageUrl[], keywords: string[]): AgentImageUrl[] =>
  urls.filter(u => keywords.length === 0 || db.matchesAnyKeyword(u.name, keywords))

/** 販売履歴（売却済み）の 1 行を insertCollected / updateCollectedActuals に渡す形にする */
function soldRow(s: AgentSoldRow) {
  return {
    mercariItemId: s.mercariItemId,
    title: s.title,
    price: s.price,
    soldAt: s.soldAt,
    fee: s.fee,
    shippingFee: s.shippingFee,
    otherCost: s.otherCost,
    // 販売履歴（sold）タブに出ている時点で取引完了（購入完了日つき）
    status: 'completed' as const,
  }
}

/** 販売の id（sale.mercari_item_id から引く）。saveThumb の fallback */
function findSaleId(mercariItemId: string): string | null {
  const row = db.getDb().prepare('SELECT id FROM sale WHERE mercari_item_id = ?').get(mercariItemId) as
    | { id: string } | undefined
  return row?.id ?? null
}

export function createLocalStore(): CollectorStore {
  // 画像の対象を返すとき、販売の id（channel_item_id → sale.id）を覚えておく。saveThumb が id を引き直さずに済む
  const saleIds = new Map<string, string>()

  const saleThumbTargets = (list: Array<{ id: string; mercariItemId: string; thumbUrl: string }>): AgentThumbTarget[] =>
    list.map((t) => {
      saleIds.set(t.mercariItemId, t.id)
      return { kind: 'sale' as const, channel_item_id: t.mercariItemId, thumb_url: t.thumbUrl }
    })

  const listingThumbTargets = (list: Array<{ id: string; thumbUrl: string }>): AgentThumbTarget[] =>
    list.map(t => ({ kind: 'listing' as const, channel_item_id: t.id, thumb_url: t.thumbUrl }))

  return {
    // ------------------------------------------------------------
    // 読む
    // ------------------------------------------------------------

    async getCollectPlan() {
      return {
        shop_accounts: db.listShopAccounts()
          .filter(a => a.is_active && a.kind === 'mellojoy')
          .map(a => ({ id: a.id, name: a.name })),
      }
    },

    async listSalesNeedingDetail(limit) {
      // 詳細を開く対象：未紐付けの転売で model_codes が空のものだけ（説明文に型番があれば紐付けを救える）。
      // キーワードを変えた後は、取り込み時点では resale だったが現在のキーワードには一致しない販売が
      // 残っていることがあるため、ここでも同じ関数で絞る
      const keywords = channelKeywords('mercari')
      const all = db.listSales({ onlyPending: true })
        .filter(s => s.mercari_item_id
          && s.kind === 'resale' && s.unmatched === 1 && s.model_codes.length === 0)
      const matched = keywords.length > 0
        ? all.filter(s => db.matchesAnyKeyword(s.title, keywords))
        : all
      return {
        targets: matched.slice(0, Math.max(0, limit)).map(s => ({ id: s.id, mercari_item_id: s.mercari_item_id as string })),
        excluded_by_keyword: all.length - matched.length,
      }
    },

    async listSalesNeedingPurchasedAt(limit) {
      return db.salesNeedingPurchasedAt(limit)
    },

    async existingImportKeys(keys) {
      return [...db.existingImportKeys(keys)]
    },

    async excludedOrders(shopAccountId, orderNos) {
      if (orderNos.length === 0) return []
      const hash = hashKeywords(shopKeywords(shopAccountId))
      return orderNos.filter(no => db.isMellojoyOrderExcluded(shopAccountId, no, hash))
    },

    async purchaseRevisitCandidates(shopAccountId, importKeys) {
      // 新規取り込みの後の余った詳細枠で既存注文も巡回する。前回の続き（cursor の次）から並べ直す
      const candidates = db.purchaseDetailRevisitCandidates(shopAccountId, importKeys, shopKeywords(shopAccountId))
      const cursor = db.getSettings()[cursorKey(shopAccountId)]
      const cursorIndex = candidates.findIndex(p => p.id === cursor)
      return [...candidates.slice(cursorIndex + 1), ...candidates.slice(0, cursorIndex + 1)]
    },

    // ------------------------------------------------------------
    // 実行記録
    // ------------------------------------------------------------

    async recordRun(run) {
      const id = db.startRun(run.source, run.shop_account_id ?? null)
      const finished = db.finishRun(id, run.status, run.fetched, run.inserted, run.message ?? undefined)

      // 始めた時刻は、収集のコードが走り始めたときのものを残す（startRun はいまの時刻を刻むので、終わったあとで戻す）
      const startedAt = run.started_at ?? null
      const parsed = startedAt === null ? Number.NaN : Date.parse(startedAt)
      if (startedAt === null || Number.isNaN(parsed) || parsed > Date.now() || startedAt === finished.started_at) {
        return finished
      }
      db.getDb().prepare('UPDATE collector_run SET started_at = ? WHERE id = ?').run(startedAt, id)
      return { ...finished, started_at: startedAt }
    },

    // ------------------------------------------------------------
    // メルカリ・Yahoo!フリマ
    // ------------------------------------------------------------

    async ingestSoldPage(_page, rows) {
      const known = db.existingMercariIds(rows.map(s => s.mercariItemId))
      const freshAll = rows.filter(s => !known.has(s.mercariItemId))
      const knownScraped = rows.filter(s => known.has(s.mercariItemId))

      // 削除した販売（sale_exclusion）は再取り込みしない。挿入の前に弾く
      const freshNotDeleted = freshAll.filter(s => !db.isMercariItemExcluded(s.mercariItemId))
      const excludedDeleted = freshAll.length - freshNotDeleted.length

      // キーワードが設定されていれば、出品中タブと同じ規則（タイトル一致）で絞る。
      // 不一致のものは insertCollected に渡さない＝詳細ページもサムネイルも取りに行かない
      const keywords = channelKeywords('mercari')
      const fresh = keywords.length > 0
        ? freshNotDeleted.filter(s => db.matchesAnyKeyword(s.title, keywords))
        : freshNotDeleted

      const insertedRows = fresh.length > 0 ? db.insertCollected(fresh.map(soldRow)) : []
      const knownRows = knownScraped.map(soldRow)
      const updated = knownRows.length > 0 ? db.updateCollectedActuals(knownRows) : 0

      // サムネイル対象：新規に入れた分 ＋ 今回の一覧に出ていて画像がまだ／画像URLが変わった既存分
      // （db.salesNeedingThumb が判定する）。既知分は「現在のキーワードに一致する」ものだけを対象にする
      // （キーワードを変えた後、既に取り込んだ不一致の販売にサムネを取りに行かないため。判定は新規と同じ関数）
      const knownMatched = keywords.length > 0
        ? knownScraped.filter(s => db.matchesAnyKeyword(s.title, keywords))
        : knownScraped
      const thumbs = db.salesNeedingThumb([...fresh, ...knownMatched])

      return stage({
        inserted: insertedRows.length,
        updated,
        excluded_by_keyword: freshNotDeleted.length - fresh.length,
        excluded_deleted: excludedDeleted,
        excluded_known_by_keyword: knownScraped.length - knownMatched.length,
        thumb_targets: saleThumbTargets(thumbs),
      })
    },

    async ingestTrading(rows) {
      const keywords = channelKeywords('mercari')
      const target = keywords.length > 0
        ? rows.filter(t => db.matchesAnyKeyword(t.title, keywords))
        : rows

      const knownIds = db.existingMercariIds(target.map(t => t.mercariItemId))
      const freshAll = target.filter(t => !knownIds.has(t.mercariItemId))
      // 削除した販売は取引中タブからも再取り込みしない
      const fresh = freshAll.filter(t => !db.isMercariItemExcluded(t.mercariItemId))

      let updated = 0
      let unknownStatus = 0
      for (const t of target) {
        if (t.status === null) unknownStatus++
        if (!knownIds.has(t.mercariItemId) || !t.status) continue
        if (db.updateSaleStatus(t.mercariItemId, t.status)) updated++
      }

      const insertedRows = fresh.length > 0
        ? db.insertCollected(fresh.map(t => ({
            mercariItemId: t.mercariItemId,
            title: t.title,
            price: t.price,
            soldAt: todayLocal(),
            status: t.status,
          })))
        : []

      const thumbs = db.salesNeedingThumb(target)
      return stage({
        inserted: insertedRows.length,
        updated,
        unknown_status: unknownStatus,
        excluded_by_keyword: rows.length - target.length,
        excluded_deleted: freshAll.length - fresh.length,
        thumb_targets: saleThumbTargets(thumbs),
      })
    },

    async ingestListingsPage(channel, _page, rows) {
      const keywords = channelKeywords(channel)
      const target = keywords.length > 0
        ? rows.filter(l => db.matchesAnyKeyword(l.title, keywords))
        : rows

      const result = db.upsertListings(target.map(l => ({
        mercariItemId: l.mercariItemId,
        title: l.title,
        price: l.price,
        // Yahoo!フリマの「公開停止中」相当の表示は未観測（tradstat=NONE のみ出品中とみなす）
        suspended: channel === 'yahoo' ? false : l.suspended,
        thumbUrl: l.thumbUrl,
        updatedText: l.updatedText,
        likes: l.likes,
        listedAt: l.listedAt,
      })), channel)

      // 画像は「変わったときだけ」取り直す（db.listingsNeedingThumb が判定する）
      const thumbs = db.listingsNeedingThumb(target.map(l => ({ mercariItemId: l.mercariItemId, thumbUrl: l.thumbUrl })))
      return stage({
        inserted: result.inserted,
        updated: result.updated,
        released_listings: result.releasedListings,
        released_items: result.releasedItems,
        excluded_by_keyword: rows.length - target.length,
        thumb_targets: listingThumbTargets(thumbs),
      })
    },

    async ingestYahooSales(_page, rows) {
      const keywords = channelKeywords('yahoo')

      const known = db.existingMercariIds(rows.map(c => c.yahooItemId))
      // 削除した販売（sale_exclusion）は再取り込みしない（新規側だけ）
      const excludedIds = new Set(
        rows.filter(c => !known.has(c.yahooItemId) && db.isMercariItemExcluded(c.yahooItemId))
          .map(c => c.yahooItemId),
      )

      // キーワードが設定されていれば、新規のうち不一致は insertCollected に渡さない（詳細・サムネイルも
      // 取りに行かない）。既知（knownMatched）はキーワードに関わらず更新へ渡る。タイトルが途中で切れている
      // 新規行はキーワード判定をスキップしてそのまま取り込む（truncatedTitleIds に id が残る）
      const { freshMatched, knownMatched, excludedByKeyword, excludedDeleted, truncatedTitleIds } =
        splitYahooCombinedSales(rows, known, excludedIds, keywords)

      const insertedRows = freshMatched.length > 0
        ? db.insertCollected(freshMatched.map(c => ({
            mercariItemId: c.yahooItemId,
            title: c.title,
            price: c.price,
            soldAt: c.soldAt,
            fee: c.fee,
            shippingFee: c.shippingFee,
            bundleCount: c.bundleCount,
            status: c.status,
          })), 'yahoo')
        : []

      // 既に取り込み済みの販売を実額・状態で更新する（キーワードには関わらない）。
      // メルカリ用の updateCollectedActuals は status='completed' を決め打ちするため使わない
      // （Yahoo!は受取連絡待ちの取引も出るので、渡された status（null もそのまま）を使う updateYahooActuals を使う）。
      // title は全文（②取引ページ由来）が取れたときだけ渡す（titleTruncated=true のものは切れたタイトルで上書きしない）
      const updated = knownMatched.length > 0
        ? db.updateYahooActuals(knownMatched.map(c => ({
            mercariItemId: c.yahooItemId,
            soldAt: c.soldAt,
            fee: c.fee,
            shippingFee: c.shippingFee,
            bundleCount: c.bundleCount,
            price: c.price,
            status: c.status,
            title: c.titleTruncated ? undefined : c.title,
          })))
        : 0

      // サムネイル：新規 ＋ 既知（キーワードには関わらない）
      const thumbs = db.salesNeedingThumb(
        [...freshMatched, ...knownMatched]
          .filter((c): c is AgentYahooSaleRow & { thumbUrl: string } => !!c.thumbUrl)
          .map(c => ({ mercariItemId: c.yahooItemId, thumbUrl: c.thumbUrl })),
      )

      return stage({
        inserted: insertedRows.length,
        updated,
        excluded_by_keyword: excludedByKeyword,
        excluded_deleted: excludedDeleted,
        truncated_title_ids: truncatedTitleIds,
        thumb_targets: saleThumbTargets(thumbs),
      })
    },

    async saveThumb(input) {
      // 元 URL を正規化して thumb_src に残す＝「変わったときだけ」取り直す判定の根拠。
      // setSaleThumb / setListingThumb は、売れる前後で持ち主が変わるだけで同じ画像なので対になる側にも書く
      const src = db.normalizeThumbSrc(input.thumb_url)
      if (input.kind === 'sale') {
        const saleId = saleIds.get(input.channel_item_id) ?? findSaleId(input.channel_item_id)
        if (!saleId) throw new Error('販売が見つかりません')
        db.setSaleThumb(saleId, input.path, src)
        saleIds.delete(input.channel_item_id)
      } else {
        db.setListingThumb(input.channel_item_id, input.path, src)
      }
      return stage({})
    },

    async applySaleDescription(saleId, description) {
      const codes = extractCodes(description)
      const applied = codes.length > 0 ? db.appendModelCodes(saleId, codes) : false
      return stage({ codes_found: codes.length, applied })
    },

    async setSalePurchasedAt(saleId, purchasedAt) {
      db.setSalePurchasedAt(saleId, purchasedAt)
      return stage({})
    },

    // ------------------------------------------------------------
    // メロジョイ
    // ------------------------------------------------------------

    async updateOrderFulfillments(_shopAccountId, updates) {
      let updated = 0
      for (const u of updates) {
        if (db.updatePurchaseFulfillment(u.import_key, u.fulfillment)) updated++
      }
      return stage({ updated })
    },

    async ingestOrder(shopAccountId, order) {
      const keywords = shopKeywords(shopAccountId)
      const keywordsHash = hashKeywords(keywords)
      const result = (
        outcome: AgentOrderResult['outcome'], purchaseId: string | null,
        fulfillmentUpdated = false, targets: AgentImageTarget[] = [],
      ): AgentStage<AgentOrderResult> => stage<AgentOrderResult>({
        outcome, purchase_id: purchaseId, fulfillment_updated: fulfillmentUpdated, image_targets: targets,
      })

      const p = order.purchase
      if (p.kind === 'cancelled') {
        db.markMellojoyOrderExcluded(shopAccountId, order.order_no, keywordsHash)
        return result('cancelled', null)
      }

      let purchaseId: string
      if (p.kind === 'confirmed') {
        const filtered = filterPurchaseInputByKeywords(p.input, keywords)
        if (filtered === null) {
          db.markMellojoyOrderExcluded(shopAccountId, order.order_no, keywordsHash)
          return result('excluded', null)
        }
        purchaseId = db.createPurchase(filtered)
      } else {
        const filtered = filterPurchaseDraftByKeywords(p.input, keywords)
        if (filtered === null) {
          db.markMellojoyOrderExcluded(shopAccountId, order.order_no, keywordsHash)
          return result('excluded', null)
        }
        purchaseId = db.createPurchaseDraft(filtered)
        // 同じ注文がすでにある（createPurchaseDraft は '' を返す）
        if (!purchaseId) return result('existing', null)
        db.setPurchaseLineImageUrls(purchaseId, keywordImageUrls(order.image_urls, keywords))
      }

      // 取り込みでこの注文の詳細は読み終えている（あとで画像巡回に拾わせない）
      db.setPurchaseImageChecked(purchaseId)
      const fulfillmentUpdated = order.fulfillment ? db.applyFulfillmentFromShop(purchaseId, order.fulfillment) : false
      return result(p.kind, purchaseId, fulfillmentUpdated, db.purchaseLinesNeedingImage(purchaseId, keywords))
    },

    async revisitOrder(shopAccountId, purchaseId, detail) {
      let fulfillmentUpdated = false
      let targets: AgentImageTarget[] = []
      if (detail) {
        const keywords = shopKeywords(shopAccountId)
        db.setPurchaseLineImageUrls(purchaseId, keywordImageUrls(detail.image_urls, keywords))
        // 詳細を読めたので image_checked_at を刻む（次回以降この注文を候補から外すため）
        db.setPurchaseImageChecked(purchaseId)
        if (detail.fulfillment) fulfillmentUpdated = db.applyFulfillmentFromShop(purchaseId, detail.fulfillment)
        targets = db.purchaseLinesNeedingImage(purchaseId, keywords)
      }
      // 読めなかったときも、巡回の位置だけは進める（同じ注文で詰まらない）
      db.setSetting(cursorKey(shopAccountId), purchaseId)
      return stage({ fulfillment_updated: fulfillmentUpdated, image_targets: targets })
    },

    async saveLineImage(lineId, path) {
      db.setPurchaseLineImage(lineId, path)
      return stage({})
    },
  }
}

/** いまの SQLite に書く store（collector*.ts の既定） */
export const localStore: CollectorStore = createLocalStore()
