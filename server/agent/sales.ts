import type {
  AgentDescriptionResult, AgentDetailTargets, AgentListingsResult, AgentSaleRef, AgentSoldPageResult,
  AgentStage, AgentThumbTarget, AgentTradingResult, AgentYahooSalesResult,
} from '../../src/shared/agent-types'
import type { SaleStatus, SalesChannel } from '../../src/shared/types'
import {
  argArray, argDate, argEnum, argId, argInt, argNullableInt, argNullableText, argNullableYen, argObject, argText, argYen,
  extractCodes, keywordsFor, matchesAnyKeyword, todayJst,
} from '../domain/_shared'
import { normalizeThumbSrc, listingsNeedingThumb, setListingThumb, upsertListings } from '../domain/listing'
import {
  appendModelCodes, existingMercariIds, insertCollected, isMercariItemExcluded, salesNeedingPurchasedAt,
  salesNeedingThumb, setSalePurchasedAt, setSaleThumb, updateCollectedActuals, updateSaleStatus, updateYahooActuals,
} from '../domain/sale'
import { UserError } from '../errors'
import { registerAgentHandler } from './handler'
import { assertLease, parseLease, runStage, type AgentCtx } from './lease'

// ============================================================
// メルカリ・Yahoo!フリマの段（販売一覧・取引中・出品・Yahoo の売上・画像・型番救済・購入日時）
//
// どの段も、デスクトップの collector.ts / collector-yahoo.ts が `db.x(...)` を呼んでいた並びを、
// 1 つのトランザクション（＝段）にまとめたもの。既知／新規の仕分け・削除済み・キーワードの絞り込みは
// サーバーがその場で（同じトランザクションの中で）行う＝読んでから書くまでの間に帳簿が動かない。
// 行の検査は insertCollected などと同じ関数（argText / argYen …）で、変な値は 400 にする（500 にしない）。
// ============================================================

const ROWS_MAX = 1000
const ITEM_ID_MAX = 100
const TITLE_MAX = 1000
const URL_MAX = 2000
const CHANNELS: readonly SalesChannel[] = ['mercari', 'yahoo']
/** sale.ts の SALE_STATUS_ORDER と同じ（取引の進み具合） */
const SALE_STATUS_ORDER: readonly SaleStatus[] = ['waiting_payment', 'waiting_shipment', 'shipped', 'delivered', 'completed']

const thumbUrlOf = (v: unknown): string | null => argNullableText('画像のURL', v, { max: URL_MAX }) ?? null

function page(v: unknown): number {
  return argInt('ページ', v, { min: 1, max: 1000 })
}

// ---- 行の検査 ----

interface SoldRow {
  mercariItemId: string; title: string; price: number; fee: number | null; shippingFee: number | null
  otherCost: number | null; soldAt: string; thumbUrl: string | null
}

function soldRows(raw: unknown): SoldRow[] {
  return argArray('販売の一覧', raw, { max: ROWS_MAX }).map((r, i) => {
    const o = argObject(`${i + 1}件目の販売`, r)
    return {
      mercariItemId: argText('商品ID', o.mercariItemId, { max: ITEM_ID_MAX }),
      title: argText('商品名', o.title, { max: TITLE_MAX }),
      price: argYen('価格', o.price),
      fee: argNullableYen('手数料', o.fee) ?? null,
      shippingFee: argNullableYen('送料', o.shippingFee) ?? null,
      otherCost: argNullableYen('他費用', o.otherCost) ?? null,
      soldAt: argDate('販売日', o.soldAt),
      thumbUrl: thumbUrlOf(o.thumbUrl),
    }
  })
}

interface TradingRow { mercariItemId: string; title: string; price: number; status: SaleStatus | null; thumbUrl: string | null }

function tradingRows(raw: unknown): TradingRow[] {
  return argArray('取引中の一覧', raw, { max: ROWS_MAX }).map((r, i) => {
    const o = argObject(`${i + 1}件目の取引`, r)
    const status = o.status === null || o.status === undefined ? null : argEnum('取引の状態', o.status, SALE_STATUS_ORDER)
    return {
      mercariItemId: argText('商品ID', o.mercariItemId, { max: ITEM_ID_MAX }),
      title: argText('商品名', o.title, { max: TITLE_MAX }),
      price: argYen('価格', o.price),
      status,
      thumbUrl: thumbUrlOf(o.thumbUrl),
    }
  })
}

interface ListingRow {
  mercariItemId: string; title: string; price: number; suspended: boolean; thumbUrl: string | null
  updatedText: string | null; likes: number | null; listedAt: string | null
}

function listingRows(raw: unknown): ListingRow[] {
  return argArray('出品の一覧', raw, { max: ROWS_MAX }).map((r, i) => {
    const o = argObject(`${i + 1}件目の出品`, r)
    return {
      mercariItemId: argText('商品ID', o.mercariItemId, { max: ITEM_ID_MAX }),
      title: argText('出品のタイトル', o.title, { max: TITLE_MAX }),
      price: argYen('出品の価格', o.price),
      suspended: o.suspended === true,
      thumbUrl: thumbUrlOf(o.thumbUrl),
      updatedText: argNullableText('更新の表示', o.updatedText, { max: 200 }) ?? null,
      likes: argNullableInt('いいね数', o.likes, { min: 0 }) ?? null,
      listedAt: argNullableText('出品日時', o.listedAt, { max: 64 }) ?? null,
    }
  })
}

interface YahooRow {
  yahooItemId: string; title: string; titleTruncated: boolean; price: number; fee: number; shippingFee: number | null
  bundleCount: number | null; soldAt: string; status: SaleStatus | null; thumbUrl: string | null
}

function yahooRows(raw: unknown): YahooRow[] {
  return argArray('Yahoo!フリマの売上の一覧', raw, { max: ROWS_MAX }).map((r, i) => {
    const o = argObject(`${i + 1}件目の売上`, r)
    return {
      yahooItemId: argText('商品ID', o.yahooItemId, { max: ITEM_ID_MAX }),
      title: argText('商品名', o.title, { max: TITLE_MAX }),
      titleTruncated: o.titleTruncated === true,
      price: argYen('価格', o.price),
      fee: argYen('手数料', o.fee),
      shippingFee: argNullableYen('送料', o.shippingFee) ?? null,
      bundleCount: argNullableInt('まとめ買いの点数', o.bundleCount, { min: 1 }) ?? null,
      soldAt: argDate('販売日', o.soldAt),
      status: o.status === null || o.status === undefined ? null : argEnum('取引の状態', o.status, SALE_STATUS_ORDER),
      thumbUrl: thumbUrlOf(o.thumbUrl),
    }
  })
}

// ---- 画像の対象 ----

const saleTargets = (list: Array<{ mercariItemId: string; thumbUrl: string }>): AgentThumbTarget[] =>
  list.map((t) => ({ kind: 'sale' as const, channel_item_id: t.mercariItemId, thumb_url: t.thumbUrl }))

const listingTargets = (list: Array<{ id: string; thumbUrl: string }>): AgentThumbTarget[] =>
  list.map((t) => ({ kind: 'listing' as const, channel_item_id: t.id, thumb_url: t.thumbUrl }))

// ------------------------------------------------------------
// 販売履歴（collector.ts の 825〜861 行）
// ------------------------------------------------------------

/**
 * 販売履歴（売却済み）の 1 ページ。新規は入れる（削除済み・キーワード不一致は入れない＝詳細も画像も取りに行かない）、
 * 既知は実額・購入完了日で更新する。status は 'completed'（販売履歴に出た時点で取引完了）。
 * 0 件のページでも書き込みは起きない（`inserted: 0`。静かに成功にせず、empty にするかは PC が実行記録で決める）
 */
async function ingestSoldPage(ctx: AgentCtx, rawLease: unknown, rawPage: unknown, rawRows: unknown): Promise<AgentStage<AgentSoldPageResult>> {
  const lease = parseLease(rawLease)
  const no = page(rawPage)
  return runStage(ctx, lease, `sales:${no}`, async () => {
    const rows = soldRows(rawRows)
    const known = await existingMercariIds(ctx, rows.map((r) => r.mercariItemId))
    const freshAll = rows.filter((r) => !known.has(r.mercariItemId))
    const knownScraped = rows.filter((r) => known.has(r.mercariItemId))

    // 削除した販売（sale_exclusion）は再取り込みしない。挿入の前に弾く
    const freshNotDeleted: SoldRow[] = []
    for (const r of freshAll) if (!(await isMercariItemExcluded(ctx, r.mercariItemId))) freshNotDeleted.push(r)
    const excludedDeleted = freshAll.length - freshNotDeleted.length

    const keywords = await keywordsFor(ctx, 'mercari')
    const fresh = keywords.length > 0 ? freshNotDeleted.filter((r) => matchesAnyKeyword(r.title, keywords)) : freshNotDeleted
    const toRow = (s: SoldRow) => ({
      mercariItemId: s.mercariItemId, title: s.title, price: s.price, soldAt: s.soldAt,
      fee: s.fee, shippingFee: s.shippingFee, otherCost: s.otherCost, status: 'completed' as const,
    })
    const insertedRows = fresh.length > 0 ? await insertCollected(ctx, fresh.map(toRow)) : []
    const updated = knownScraped.length > 0 ? await updateCollectedActuals(ctx, knownScraped.map(toRow)) : 0

    // 既知分は「現在のキーワードに一致する」ものだけサムネの対象にする（判定は新規と同じ関数）
    const knownMatched = keywords.length > 0 ? knownScraped.filter((r) => matchesAnyKeyword(r.title, keywords)) : knownScraped
    const thumbs = await salesNeedingThumb(ctx, [...fresh, ...knownMatched])

    return {
      inserted: insertedRows.length,
      updated,
      excluded_by_keyword: freshNotDeleted.length - fresh.length,
      excluded_deleted: excludedDeleted,
      excluded_known_by_keyword: knownScraped.length - knownMatched.length,
      thumb_targets: saleTargets(thumbs),
    }
  })
}

// ------------------------------------------------------------
// 取引中（collector.ts の 972〜1002 行）
// ------------------------------------------------------------

/**
 * 取引中のスナップショット。キーワードで絞り、既知は状態だけ前に進め（後戻りは無視）、未知は新しい販売として入れる
 * （計上日は今日。本当の購入完了日は販売履歴に出たときに直る）。状態の文言が読めなかった行（status: null）は数えて返す
 */
async function ingestTrading(ctx: AgentCtx, rawLease: unknown, rawRows: unknown): Promise<AgentStage<AgentTradingResult>> {
  const lease = parseLease(rawLease)
  return runStage(ctx, lease, 'trading', async () => {
    const rows = tradingRows(rawRows)
    const keywords = await keywordsFor(ctx, 'mercari')
    const target = keywords.length > 0 ? rows.filter((t) => matchesAnyKeyword(t.title, keywords)) : rows

    const known = await existingMercariIds(ctx, target.map((t) => t.mercariItemId))
    const freshAll = target.filter((t) => !known.has(t.mercariItemId))
    const fresh: TradingRow[] = []
    for (const t of freshAll) if (!(await isMercariItemExcluded(ctx, t.mercariItemId))) fresh.push(t)

    let updated = 0
    let unknownStatus = 0
    for (const t of target) {
      if (t.status === null) unknownStatus++
      if (!known.has(t.mercariItemId) || !t.status) continue
      if (await updateSaleStatus(ctx, t.mercariItemId, t.status)) updated++
    }

    const insertedRows = fresh.length > 0
      ? await insertCollected(ctx, fresh.map((t) => ({
          mercariItemId: t.mercariItemId, title: t.title, price: t.price, soldAt: todayJst(), status: t.status,
        })))
      : []

    const thumbs = await salesNeedingThumb(ctx, target)
    return {
      inserted: insertedRows.length,
      updated,
      unknown_status: unknownStatus,
      excluded_by_keyword: rows.length - target.length,
      excluded_deleted: freshAll.length - fresh.length,
      thumb_targets: saleTargets(thumbs),
    }
  })
}

// ------------------------------------------------------------
// 出品（collector.ts の 903〜930 行・collector-yahoo.ts の 1459〜1480 行）
// ------------------------------------------------------------

/**
 * 出品中の 1 ページ。キーワード（出品先ごと）に合うものだけ入れる。出品停止に**変わった**取り込みでだけ引き当てを
 * 外す（設定 auto_release_suspended。メルカリのみ）。**書き込みの前に lease を確かめる**ので、スリープから戻った
 * 古い PC の観測で引き当てが静かに外れることはない。一覧から消えただけでは何もしない（未観測≠取り下げ）
 */
async function ingestListingsPage(
  ctx: AgentCtx, rawLease: unknown, rawChannel: unknown, rawPage: unknown, rawRows: unknown,
): Promise<AgentStage<AgentListingsResult>> {
  const lease = parseLease(rawLease)
  const channel = argEnum('出品先', rawChannel, CHANNELS)
  const no = page(rawPage)
  return runStage(ctx, lease, `listings:${channel}:${no}`, async () => {
    const rows = listingRows(rawRows)
    const keywords = await keywordsFor(ctx, channel)
    const target = keywords.length > 0 ? rows.filter((l) => matchesAnyKeyword(l.title, keywords)) : rows

    const result = await upsertListings(ctx, target.map((l) => ({
      mercariItemId: l.mercariItemId,
      title: l.title,
      price: l.price,
      // Yahoo!フリマは「公開停止中」を観測しない（出品中＝active のみ）
      suspended: channel === 'yahoo' ? false : l.suspended,
      thumbUrl: l.thumbUrl,
      updatedText: l.updatedText,
      likes: l.likes,
      listedAt: l.listedAt,
    })), channel)

    const thumbs = await listingsNeedingThumb(ctx, target.map((l) => ({ mercariItemId: l.mercariItemId, thumbUrl: l.thumbUrl })))
    return {
      inserted: result.inserted,
      updated: result.updated,
      released_listings: result.releasedListings,
      released_items: result.releasedItems,
      excluded_by_keyword: rows.length - target.length,
      thumb_targets: listingTargets(thumbs),
    }
  })
}

// ------------------------------------------------------------
// Yahoo!フリマの売上（collector-yahoo.ts の 1403〜1457 行）
// ------------------------------------------------------------

/**
 * Yahoo!フリマの売上（② 取引中・取引完了 と ③ 売上金管理 を PC が結合したもの）。
 * 新規はキーワード（yahoo_keyword）に合うものだけ入れる。**タイトルが③の切れた商品名由来の行はキーワード判定を
 * しない**（切れた先にキーワードがあるかもしれない）で入れ、その id を返す。既知はキーワードに関わらず全件を更新へ
 * （キーワードは「取り込むか」を決めるもので、もう帳簿にあるものの更新を止めない）
 */
async function ingestYahooSales(ctx: AgentCtx, rawLease: unknown, rawPage: unknown, rawRows: unknown): Promise<AgentStage<AgentYahooSalesResult>> {
  const lease = parseLease(rawLease)
  const no = page(rawPage)
  return runStage(ctx, lease, `yahoo-sales:${no}`, async () => {
    const rows = yahooRows(rawRows)
    const keywords = await keywordsFor(ctx, 'yahoo')
    const known = await existingMercariIds(ctx, rows.map((r) => r.yahooItemId))

    const freshAll = rows.filter((r) => !known.has(r.yahooItemId))
    const knownMatched = rows.filter((r) => known.has(r.yahooItemId))
    const freshNotDeleted: YahooRow[] = []
    for (const r of freshAll) if (!(await isMercariItemExcluded(ctx, r.yahooItemId))) freshNotDeleted.push(r)

    const truncated = freshNotDeleted.filter((r) => r.titleTruncated)
    const judgeable = freshNotDeleted.filter((r) => !r.titleTruncated)
    const judgeableMatched = keywords.length > 0 ? judgeable.filter((r) => matchesAnyKeyword(r.title, keywords)) : judgeable
    const freshMatched = [...judgeableMatched, ...truncated]

    const insertedRows = freshMatched.length > 0
      ? await insertCollected(ctx, freshMatched.map((c) => ({
          mercariItemId: c.yahooItemId, title: c.title, price: c.price, soldAt: c.soldAt, fee: c.fee,
          shippingFee: c.shippingFee, bundleCount: c.bundleCount, status: c.status,
        })), 'yahoo')
      : []

    // メルカリ用の updateCollectedActuals は status='completed' を決め打ちするので使わない
    // （titleTruncated の行は切れたタイトルで上書きしない）
    const updated = knownMatched.length > 0
      ? await updateYahooActuals(ctx, knownMatched.map((c) => ({
          mercariItemId: c.yahooItemId, soldAt: c.soldAt, fee: c.fee, shippingFee: c.shippingFee, bundleCount: c.bundleCount,
          price: c.price, status: c.status, title: c.titleTruncated ? undefined : c.title,
        })))
      : 0

    const thumbs = await salesNeedingThumb(
      ctx,
      [...freshMatched, ...knownMatched].filter((c) => !!c.thumbUrl).map((c) => ({ mercariItemId: c.yahooItemId, thumbUrl: c.thumbUrl })),
    )
    return {
      inserted: insertedRows.length,
      updated,
      excluded_by_keyword: judgeable.length - judgeableMatched.length,
      excluded_deleted: freshAll.length - freshNotDeleted.length,
      truncated_title_ids: truncated.map((r) => r.yahooItemId),
      thumb_targets: saleTargets(thumbs),
    }
  })
}

// ------------------------------------------------------------
// 画像（Storage に上げた後のパスの確定）
// ------------------------------------------------------------

/** 画像の保存先（Storage のパス）。この世帯のフォルダの中だけ（他の世帯の画像を指させない） */
function storagePath(ctx: AgentCtx, v: unknown): string {
  const path = argText('画像の保存先', v, { max: 500 })
  if (!path.startsWith(`${ctx.householdId}/`) || path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new UserError('画像の保存先が正しくありません')
  }
  return path
}

/**
 * 画像 1 枚のパスの確定。サムネの元 URL（正規化したもの。クエリ込み＝画像の更新時刻）を thumb_src に残す＝
 * 「変わったときだけ」取り直す判定の根拠。売れる前後で持ち主が変わるだけで同じ画像なので、対になる側にも書く
 * （setSaleThumb / setListingThumb が行う）
 */
async function saveThumb(ctx: AgentCtx, rawLease: unknown, rawInput: unknown): Promise<AgentStage> {
  const lease = parseLease(rawLease)
  const o = argObject('画像', rawInput)
  const kind = argEnum('画像の持ち主', o.kind, ['sale', 'listing'] as const)
  const itemId = argText('商品ID', o.channel_item_id, { max: ITEM_ID_MAX })
  const src = normalizeThumbSrc(argText('画像のURL', o.thumb_url, { max: URL_MAX }))
  if (!src) throw new UserError('画像のURLを入力してください')
  return runStage(ctx, lease, `thumb:${kind}:${itemId}:${src}`, async () => {
    const path = storagePath(ctx, o.path)
    if (kind === 'sale') {
      const sale = await ctx.sql.get<{ id: string }>('select id from sale where channel_item_id = ? limit 1', itemId)
      if (!sale) throw new UserError('販売が見つかりません', 'not_found')
      await setSaleThumb(ctx, sale.id, path, src)
    } else {
      const listing = await ctx.sql.get<{ id: string }>('select id from listing where channel_item_id = ? limit 1', itemId)
      if (!listing) throw new UserError('出品が見つかりません', 'not_found')
      await setListingThumb(ctx, itemId, path, src)
    }
    return {}
  })
}

// ------------------------------------------------------------
// 型番救済（collector.ts の 1009〜1047 行）・購入日時（1049〜1075 行）
// ------------------------------------------------------------

/**
 * 説明文を読む販売（メルカリ・転売・未紐付け・型番なし）。デスクトップの `listSales({onlyPending})` の絞り込みに、
 * 現在のキーワードでの絞り込みを足したもの。キーワードを変えた後、取り込み時点では resale だったが今のキーワードに
 * 一致しない販売が残っていても、詳細を取りに行かない。
 * デスクトップでは出品先を見ていなかった（Yahoo!フリマの販売にメルカリの URL を開いていた）が、メルカリの販売だけにする
 */
async function listSalesNeedingDetail(ctx: AgentCtx, rawLease: unknown, rawLimit: unknown): Promise<AgentDetailTargets> {
  await assertLease(ctx, parseLease(rawLease))
  const limit = argInt('件数', rawLimit, { min: 0, max: 100 })
  const rows = await ctx.sql.all<{ id: string; mercari_item_id: string; title: string }>(`
    select sp.id, sp.channel_item_id as mercari_item_id, sp.title
      from sale_profit sp
     where sp.channel = 'mercari' and sp.channel_item_id is not null
       and sp.kind = 'resale' and sp.unmatched = 1 and coalesce(cardinality(sp.model_codes), 0) = 0
     order by sp.sold_at desc, sp.title collate "C", sp.id
  `)
  const keywords = await keywordsFor(ctx, 'mercari')
  const matched = keywords.length > 0 ? rows.filter((r) => matchesAnyKeyword(r.title, keywords)) : rows
  return {
    targets: matched.slice(0, limit).map((r) => ({ id: r.id, mercari_item_id: r.mercari_item_id })),
    excluded_by_keyword: rows.length - matched.length,
  }
}

/**
 * 説明文から型番を拾って販売に追記する。型番が 1 つに絞れたら自動紐付けまで進む（appendModelCodes）。
 * 拾えなくても段は済みにする（同じ取り込みの中では開き直さない。次の取り込みでまた候補になる）
 */
async function applySaleDescription(
  ctx: AgentCtx, rawLease: unknown, rawSaleId: unknown, rawDescription: unknown,
): Promise<AgentStage<AgentDescriptionResult>> {
  const lease = parseLease(rawLease)
  const saleId = argId('販売', rawSaleId)
  return runStage(ctx, lease, `detail:${saleId}`, async () => {
    const description = argText('説明文', rawDescription, { max: 100_000 })
    const codes = extractCodes(description)
    const applied = codes.length > 0 ? await appendModelCodes(ctx, saleId, codes) : false
    return { codes_found: codes.length, applied }
  })
}

/** 購入日時を取り直す販売（新しい順に limit 件まで） */
async function listSalesNeedingPurchasedAt(ctx: AgentCtx, rawLease: unknown, rawLimit: unknown): Promise<AgentSaleRef[]> {
  await assertLease(ctx, parseLease(rawLease))
  return salesNeedingPurchasedAt(ctx, argInt('件数', rawLimit, { min: 0, max: 100 }))
}

/** 購入日時を保存する。null（取引画面から読めなかった）も「試行済み」として残し、再試行しない */
async function saveSalePurchasedAt(ctx: AgentCtx, rawLease: unknown, rawSaleId: unknown, rawPurchasedAt: unknown): Promise<AgentStage> {
  const lease = parseLease(rawLease)
  const saleId = argId('販売', rawSaleId)
  return runStage(ctx, lease, `purchased-at:${saleId}`, async () => {
    const purchasedAt = rawPurchasedAt === null || rawPurchasedAt === undefined ? null : argText('購入日時', rawPurchasedAt, { max: 32 })
    await setSalePurchasedAt(ctx, saleId, purchasedAt)
    return {}
  })
}

registerAgentHandler('ingestSoldPage', ingestSoldPage)
registerAgentHandler('ingestTrading', ingestTrading)
registerAgentHandler('ingestListingsPage', ingestListingsPage)
registerAgentHandler('ingestYahooSales', ingestYahooSales)
registerAgentHandler('saveThumb', saveThumb)
registerAgentHandler('listSalesNeedingDetail', listSalesNeedingDetail)
registerAgentHandler('applySaleDescription', applySaleDescription)
registerAgentHandler('listSalesNeedingPurchasedAt', listSalesNeedingPurchasedAt)
registerAgentHandler('setSalePurchasedAt', saveSalePurchasedAt)
