import type {
  AgentImageUrl, AgentOrderOutcome, AgentOrderResult, AgentRevisitCandidate, AgentRevisitResult, AgentShopFulfillment,
  AgentStage,
} from '../../src/shared/agent-types'
import type { Fulfillment, PurchaseDraftInput, PurchaseInput } from '../../src/shared/types'
import {
  argArray, argEnum, argId, argNullableEnum, argObject, argText, matchesAnyKeyword, parseKeywords, settingStr,
} from '../domain/_shared'
import { setSetting } from '../domain/master'
import {
  applyFulfillmentFromShop, createPurchase, createPurchaseDraft, existingImportKeys, markMellojoyOrderExcluded,
  purchaseDetailRevisitCandidates, purchaseLinesNeedingImage, setPurchaseImageChecked, setPurchaseLineImage,
  setPurchaseLineImageUrls, updatePurchaseFulfillment,
} from '../domain/purchase'
import { UserError } from '../errors'
import { registerAgentHandler } from './handler'
import { sha1Hex } from './key'
import { assertLease, parseLease, runStage, type AgentCtx } from './lease'

// ============================================================
// メロジョイ（仕入）の段（collector-mellojoy.ts の collectShopOrders / refetchPurchaseImages）
//
// 注文の仕分け（キーワード・除外記録・既取込）はサーバーがその場で行う。PC は注文詳細を読んで
// 「確定／下書き／キャンセル」に組み立てた結果（toPurchaseInput の戻り）を送る。
// 仕入先のキーワード（shop_account.import_keywords）はサーバーが見る（PC は持たない）。
// ============================================================

const FULFILLMENTS: readonly Fulfillment[] = ['pending', 'shipped', 'delivered']
const KEYS_MAX = 1000
const ORDER_NO_MAX = 190
const NAME_MAX = 500
const IMAGE_URLS_MAX = 200
const LINES_MAX = 200
const MELLOJOY_KEY_PREFIX = 'mellojoy:'

const cursorKey = (shopAccountId: string): string => `mellojoy_image_cursor:${shopAccountId}`

/** 仕入先と、その取り込みキーワード。見つからなければ 404 */
async function shopKeywords(ctx: AgentCtx, shopAccountId: string): Promise<string[]> {
  const shop = await ctx.sql.get<{ import_keywords: string | null }>(
    'select import_keywords from shop_account where id = ?', shopAccountId,
  )
  if (!shop) throw new UserError('仕入先が見つかりません', 'not_found')
  return parseKeywords(shop.import_keywords ?? '')
}

/**
 * キーワードの印。キーワードを変えれば変わり、除外記録（mellojoy_excluded_order）が再評価される。
 * collector-mellojoy.ts の hashKeywords と同じ（並べ替えてから改行でつないだ sha1）
 */
async function keywordsHash(keywords: string[]): Promise<string> {
  return sha1Hex(keywords.slice().sort().join('\n'))
}

function orderKey(orderNo: unknown): { orderNo: string; importKey: string } {
  const no = argText('注文番号', orderNo, { max: ORDER_NO_MAX })
  if (!no.trim()) throw new UserError('注文番号を入力してください')
  return { orderNo: no, importKey: `${MELLOJOY_KEY_PREFIX}${no}` }
}

function shopFulfillment(v: unknown): AgentShopFulfillment | null {
  if (v === null || v === undefined) return null
  const o = argObject('配送の情報', v)
  argNullableEnum('到着状態', o.status, FULFILLMENTS)
  // 日付・業者・追跡番号の検査は applyFulfillmentFromShop が行う（同じ関数なのでデスクトップと同じ文言）
  return o as unknown as AgentShopFulfillment
}

function imageUrls(v: unknown): AgentImageUrl[] {
  if (v === null || v === undefined) return []
  return argArray('画像のURL', v, { max: IMAGE_URLS_MAX }).map((u, i) => {
    const o = argObject(`${i + 1}件目の画像`, u)
    argText('商品名', o.name, { max: NAME_MAX })
    return o as unknown as AgentImageUrl
  })
}

/** 明細の名前がキーワードに一致するものだけ（collector-mellojoy.ts の updatePurchaseImageUrls と同じ） */
const keywordImageUrls = (urls: AgentImageUrl[], keywords: string[]): AgentImageUrl[] =>
  urls.filter((u) => keywords.length === 0 || matchesAnyKeyword(u.name, keywords))

// ---- キーワードの絞り込み（collector-mellojoy.ts の filterPurchaseInputByKeywords / filterPurchaseDraftByKeywords） ----

/** 明細の名前が文字列であることを確かめる（matchesAnyKeyword に変な値を渡さない）。lines を返す */
function checkedLines<T extends { name: string }>(raw: unknown): T[] {
  return argArray('明細', raw, { max: LINES_MAX }).map((l, i) => {
    const o = argObject(`${i + 1}行目`, l)
    argText(`${i + 1}行目の商品名`, o.name, { max: NAME_MAX })
    return o as unknown as T
  })
}

/**
 * 確定済みの仕入を口座の import_keywords で絞る。一致する明細が無ければ null（取り込まない）。
 * 一部だけ一致するなら、一致した明細だけにして、送料・割引は注文全体の金額比（一致した小計 ÷ 全体の小計）で
 * 按分する（私物の分の送料を転売の原価に混ぜない）。小計が 0 なら按分せず 0
 */
export function filterPurchaseInput(input: PurchaseInput, keywords: string[]): PurchaseInput | null {
  if (keywords.length === 0) return input
  const lines = input.lines
  const matched = lines.filter((l) => matchesAnyKeyword(l.name, keywords))
  if (matched.length === 0) return null
  if (matched.length === lines.length) return input

  const fullSubtotal = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0)
  const matchedSubtotal = matched.reduce((s, l) => s + l.unit_price * l.quantity, 0)
  const ratio = fullSubtotal > 0 ? matchedSubtotal / fullSubtotal : 0

  const addition = `キーワード不一致の明細 ${lines.length - matched.length} 件を除外（送料・割引は金額比で按分）`
  return {
    ...input,
    lines: matched,
    shipping_fee: Math.round((input.shipping_fee ?? 0) * ratio),
    discount: Math.round((input.discount ?? 0) * ratio),
    note: input.note ? `${input.note}\n${addition}` : addition,
  }
}

/** 下書きの絞り込み。単価が未確定のことがあるので按分はせず、送料・割引は注文全体のまま残してメモで知らせる */
export function filterPurchaseDraft(input: PurchaseDraftInput, keywords: string[]): PurchaseDraftInput | null {
  if (keywords.length === 0) return input
  const lines = input.lines
  const matched = lines.filter((l) => matchesAnyKeyword(l.name, keywords))
  if (matched.length === 0) return null
  if (matched.length === lines.length) return input

  const addition =
    `キーワード不一致の明細 ${lines.length - matched.length} 件を除外（送料・割引は注文全体の値。確定時に見直してください）`
  return { ...input, lines: matched, note: input.note ? `${input.note}\n${addition}` : addition }
}

// ------------------------------------------------------------
// 読む
// ------------------------------------------------------------

/** 既に取り込んだ注文のキー（差分取得）。Set は JSON にならないので配列で返す */
async function existingKeys(ctx: AgentCtx, rawLease: unknown, rawKeys: unknown): Promise<string[]> {
  await assertLease(ctx, parseLease(rawLease))
  const keys = argArray('注文のキー', rawKeys, { max: KEYS_MAX }).map((k) => argText('注文のキー', k, { max: 500 }))
  return [...(await existingImportKeys(ctx, keys))]
}

/** 前回キーワード不一致と分かっていて、キーワードが変わっていない注文番号（詳細を開かずに飛ばす） */
async function excludedOrders(ctx: AgentCtx, rawLease: unknown, rawShopId: unknown, rawOrderNos: unknown): Promise<string[]> {
  await assertLease(ctx, parseLease(rawLease))
  const shopId = argId('仕入先', rawShopId)
  const orderNos = argArray('注文番号', rawOrderNos, { max: KEYS_MAX }).map((n) => argText('注文番号', n, { max: ORDER_NO_MAX }))
  if (orderNos.length === 0) return []
  const hash = await keywordsHash(await shopKeywords(ctx, shopId))
  const rows = await ctx.sql.all<{ order_key: string }>(
    'select order_key from mellojoy_excluded_order where shop_account_id = ? and order_key = any(?::text[]) and keywords_hash = ?',
    shopId, orderNos, hash,
  )
  return rows.map((r) => r.order_key)
}

/**
 * 既取込の注文のうち、詳細を開き直す理由があるもの（画像の取りこぼし・配送の追跡番号がまだ無い）。
 * 巡回は前回の続きから：`mellojoy_image_cursor:<仕入先>` に覚えた注文の次から並べ直して返す
 */
async function purchaseRevisitCandidates(
  ctx: AgentCtx, rawLease: unknown, rawShopId: unknown, rawImportKeys: unknown,
): Promise<AgentRevisitCandidate[]> {
  await assertLease(ctx, parseLease(rawLease))
  const shopId = argId('仕入先', rawShopId)
  const keys = argArray('注文のキー', rawImportKeys, { max: KEYS_MAX }).map((k) => argText('注文のキー', k, { max: 500 }))
  const keywords = await shopKeywords(ctx, shopId)
  const candidates = await purchaseDetailRevisitCandidates(ctx, shopId, keys, keywords)
  const cursor = await settingStr(ctx, cursorKey(shopId), '')
  const index = candidates.findIndex((p) => p.id === cursor)
  return [...candidates.slice(index + 1), ...candidates.slice(0, index + 1)]
}

// ------------------------------------------------------------
// 書く
// ------------------------------------------------------------

/**
 * 既取込の注文の到着状態を、注文一覧の状態表示だけで更新する（詳細は開かない）。前に進む方向だけ
 * （人が「到着済」にしたものを一覧の「配送中」で戻さない）。メロジョイの注文（`mellojoy:` で始まるキー）だけ
 */
async function updateOrderFulfillments(
  ctx: AgentCtx, rawLease: unknown, rawShopId: unknown, rawUpdates: unknown,
): Promise<AgentStage<{ updated: number }>> {
  const lease = parseLease(rawLease)
  const shopId = argId('仕入先', rawShopId)
  return runStage(ctx, lease, `list-fulfillment:${shopId}`, async () => {
    let updated = 0
    for (const [i, raw] of argArray('到着状態の更新', rawUpdates, { max: KEYS_MAX }).entries()) {
      const o = argObject(`${i + 1}件目の更新`, raw)
      const key = argText('注文のキー', o.import_key, { max: 500 })
      if (!key.startsWith(MELLOJOY_KEY_PREFIX)) throw new UserError('メロジョイの注文のキーではありません')
      const fulfillment = argNullableEnum('到着状態', o.fulfillment, FULFILLMENTS) ?? null
      if (await updatePurchaseFulfillment(ctx, key, fulfillment)) updated++
    }
    return { updated }
  })
}

/**
 * 注文 1 件（新規）。冪等キー `order:mellojoy:<注文番号>`。
 * - すでにその注文がある … 何もしない（existing）
 * - キャンセル（合計 0 円）… 除外を記録（cancelled）
 * - キーワードに一致する明細が無い … 取り込まず除外を記録（excluded。キーワードを変えれば再評価される）
 * - それ以外 … 確定なら createPurchase（在庫も生成）、下書きなら createPurchaseDraft
 *   → 詳細を読んだ印（image_checked_at）・配送の反映・画像の URL。画像を取る明細を返す
 * 失敗（検査に通らない・DB の制約）すると段ごと巻き戻る。PC はその注文を「失敗」に数えて次へ進んでよい
 */
async function ingestOrder(
  ctx: AgentCtx, rawLease: unknown, rawShopId: unknown, rawOrder: unknown,
): Promise<AgentStage<AgentOrderResult>> {
  const lease = parseLease(rawLease)
  const shopId = argId('仕入先', rawShopId)
  const o = argObject('注文', rawOrder)
  const { orderNo, importKey } = orderKey(o.order_no)

  return runStage(ctx, lease, `order:${importKey}`, async () => {
    const p = argObject('仕入', o.purchase)
    const kind = argEnum('仕入の種類', p.kind, ['confirmed', 'draft', 'cancelled'] as const)
    const fulfillment = shopFulfillment(o.fulfillment)
    const urls = imageUrls(o.image_urls)

    const keywords = await shopKeywords(ctx, shopId)
    const hash = await keywordsHash(keywords)
    const result = (outcome: AgentOrderOutcome, purchaseId: string | null, fulfillmentUpdated = false, targets: AgentOrderResult['image_targets'] = []): AgentOrderResult =>
      ({ outcome, purchase_id: purchaseId, fulfillment_updated: fulfillmentUpdated, image_targets: targets })

    const existing = await ctx.sql.get<{ id: string }>('select id from purchase where import_key = ?', importKey)
    if (existing) return result('existing', existing.id)

    if (kind === 'cancelled') {
      await markMellojoyOrderExcluded(ctx, shopId, orderNo, hash)
      return result('cancelled', null)
    }

    const input = argObject('仕入の内容', p.input)
    if (input.import_key !== importKey) throw new UserError('注文のキーが注文番号と合いません')
    if (typeof input.shop_account_id !== 'string' || input.shop_account_id.toLowerCase() !== shopId) {
      throw new UserError('仕入先が合いません')
    }
    const lines = checkedLines<{ name: string; unit_price: number; quantity: number }>(input.lines)

    let purchaseId: string
    if (kind === 'confirmed') {
      const filtered = filterPurchaseInput({ ...input, lines } as unknown as PurchaseInput, keywords)
      if (filtered === null) {
        await markMellojoyOrderExcluded(ctx, shopId, orderNo, hash)
        return result('excluded', null)
      }
      purchaseId = await createPurchase(ctx, filtered)
    } else {
      const filtered = filterPurchaseDraft({ ...input, lines } as unknown as PurchaseDraftInput, keywords)
      if (filtered === null) {
        await markMellojoyOrderExcluded(ctx, shopId, orderNo, hash)
        return result('excluded', null)
      }
      purchaseId = await createPurchaseDraft(ctx, filtered)
      if (!purchaseId) return result('existing', null)
      await setPurchaseLineImageUrls(ctx, purchaseId, keywordImageUrls(urls, keywords))
    }

    // 取り込みでこの注文の詳細は読み終えている（あとで画像巡回に拾わせない）
    await setPurchaseImageChecked(ctx, purchaseId)
    const fulfillmentUpdated = fulfillment ? await applyFulfillmentFromShop(ctx, purchaseId, fulfillment) : false
    const targets = await purchaseLinesNeedingImage(ctx, purchaseId, keywords)
    return result(kind, purchaseId, fulfillmentUpdated, targets)
  })
}

/**
 * 既取込の注文の詳細を開き直した結果。冪等キー `revisit:<仕入の id>`。
 * detail が null＝読めなかった（shouldSkipDetail・例外）ときは、詳細を読んだ印は付けず（次回また候補に残る）、
 * 巡回の位置だけ進める。読めたときは画像の URL・詳細を読んだ印・配送を反映して、画像を取る明細を返す
 */
async function revisitOrder(
  ctx: AgentCtx, rawLease: unknown, rawShopId: unknown, rawPurchaseId: unknown, rawDetail: unknown,
): Promise<AgentStage<AgentRevisitResult>> {
  const lease = parseLease(rawLease)
  const shopId = argId('仕入先', rawShopId)
  const purchaseId = argId('仕入', rawPurchaseId)
  return runStage(ctx, lease, `revisit:${purchaseId}`, async () => {
    const purchase = await ctx.sql.get<{ shop_account_id: string }>('select shop_account_id from purchase where id = ?', purchaseId)
    if (!purchase) throw new UserError('仕入が見つかりません', 'not_found')
    if (purchase.shop_account_id !== shopId) throw new UserError('仕入先が合いません')

    let fulfillmentUpdated = false
    let targets: AgentRevisitResult['image_targets'] = []
    if (rawDetail !== null && rawDetail !== undefined) {
      const d = argObject('詳細', rawDetail)
      const fulfillment = shopFulfillment(d.fulfillment)
      const urls = imageUrls(d.image_urls)
      const keywords = await shopKeywords(ctx, shopId)
      await setPurchaseLineImageUrls(ctx, purchaseId, keywordImageUrls(urls, keywords))
      await setPurchaseImageChecked(ctx, purchaseId)
      if (fulfillment) fulfillmentUpdated = await applyFulfillmentFromShop(ctx, purchaseId, fulfillment)
      targets = await purchaseLinesNeedingImage(ctx, purchaseId, keywords)
    }
    await setSetting(ctx, cursorKey(shopId), purchaseId)
    return { fulfillment_updated: fulfillmentUpdated, image_targets: targets }
  })
}

/** 明細の画像 1 枚のパスの確定（Storage に上げた後）。パスは `<世帯の id>/` で始まるものだけ */
async function saveLineImage(ctx: AgentCtx, rawLease: unknown, rawLineId: unknown, rawPath: unknown): Promise<AgentStage> {
  const lease = parseLease(rawLease)
  const lineId = argId('明細', rawLineId)
  const path = argText('画像の保存先', rawPath, { max: 500 })
  return runStage(ctx, lease, `line-image:${lineId}:${path}`, async () => {
    const line = await ctx.sql.get<{ id: string }>('select id from purchase_line where id = ?', lineId)
    if (!line) throw new UserError('明細が見つかりません', 'not_found')
    await setPurchaseLineImage(ctx, lineId, path)
    return {}
  })
}

registerAgentHandler('existingImportKeys', existingKeys)
registerAgentHandler('excludedOrders', excludedOrders)
registerAgentHandler('purchaseRevisitCandidates', purchaseRevisitCandidates)
registerAgentHandler('updateOrderFulfillments', updateOrderFulfillments)
registerAgentHandler('ingestOrder', ingestOrder)
registerAgentHandler('revisitOrder', revisitOrder)
registerAgentHandler('saveLineImage', saveLineImage)
