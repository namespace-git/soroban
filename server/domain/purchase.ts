import type { Ctx } from '../context'
import { UserError, mapDbError, registerDbErrorRule } from '../errors'
import { registerHandler } from '../rpc'
import type {
  AllocMethod, Fulfillment, Material, PurchaseDetail, PurchaseDraftInput, PurchaseImportResult, PurchaseInput,
  PurchaseLine, PurchaseSummary, SearchHit, Tag,
} from '../../src/shared/types'
import {
  allocate, argArray, argId, argIds, argNullableDate, argNullableEnum, argNullableText, argObject, argOptEnum,
  argOptInt, argText, assertDateText, assertQty, assertTagsExist, assertYen, extractCode, extractMaterial, isUuid,
  loadTagsFor, matchesAnyKeyword, matchesQuery, mediaUrl, monthBounds, rowsToCsv, sortAndSlice, splitEvenly,
  subtractDaysJst, todayJst, MAX_INT4,
} from './_shared'
import { nextItemCodes } from './inventory'
import { applyShopAccountAutoTags } from './master'

// ============================================================
// 仕入・按分・配送・追跡・明細画像・店名の学習
//
// src/main/db.ts の仕入まわりの移植。仕入は**原価の出どころ**。
//   配賦対象 = 仕入送料 + その他費用 − 割引
// を money.ts の allocate（金額按分か数量按分。端数は最終行へ）で明細に配り、明細の数量分だけ在庫を作る。
// inventory_item.landed_cost は**ここで確定し、以後は書き換えない**。
// ============================================================

// 同時に同じ注文を入れた 2 本目（事前の存在確認をすり抜けたとき）も、同じ文言で断る
registerDbErrorRule({
  code: '23505', constraint: 'purchase_household_id_shop_account_id_order_no_key',
  message: 'この仕入先には同じ注文番号の仕入が既にあります', as: 'conflict',
})
registerDbErrorRule({
  code: '23505', constraint: 'purchase_household_id_import_key_key',
  message: '同じ注文が既に取り込まれています', as: 'conflict',
})

const FULFILLMENTS: readonly Fulfillment[] = ['pending', 'shipped', 'delivered']
const ALLOC_METHODS: readonly AllocMethod[] = ['by_amount', 'by_quantity']

// デスクトップ版には無かった上限。数量分だけ在庫の行を作るので、桁違いの数量を入れられると DB が止まる
const MAX_LINES = 200
const MAX_LINE_QUANTITY = 1000
const MAX_ITEMS_PER_PURCHASE = 1000
const MAX_IMPORT_ORDERS = 1000

const NAME_MAX = 500
const ORDER_NO_MAX = 200
const NOTE_MAX = 5000
const IMPORT_KEY_MAX = 500
const CODE_MAX = 100
const URL_MAX = 2000
const TRACKING_TEXT_MAX = 200

// ------------------------------------------------------------
// 小さな部品
// ------------------------------------------------------------

/**
 * purchased_at（`YYYY-MM-DDTHH:mm` か `YYYY-MM-DD`）を「YYYY/MM/DD HH:mm」表示に直す。
 * 時刻が無ければ日付だけ。getItemTimeline の detail で使う（販売の購入日時の表示。商品の担当が import する）
 */
export function formatPurchasedAt(purchasedAt: string): string {
  const [datePart, timePart] = purchasedAt.split('T')
  const dateText = datePart.replace(/-/g, '/')
  return timePart ? `${dateText} ${timePart}` : dateText
}

/**
 * fulfillment の初期値から shipped_at / delivered_at を決める。
 * shipped 以上なら発送日を今日（日本時間）、delivered なら到着日も今日にする
 * （setPurchaseFulfillment と同じ規則。後から追いつく分は null のままにして、後の更新で刻む）。
 */
export function initialFulfillmentDates(
  fulfillment: Fulfillment | null | undefined,
  now: Date = new Date(),
): { shipped_at: string | null; delivered_at: string | null } {
  if (fulfillment === 'delivered') {
    const today = todayJst(now)
    return { shipped_at: today, delivered_at: today }
  }
  if (fulfillment === 'shipped') {
    return { shipped_at: todayJst(now), delivered_at: null }
  }
  return { shipped_at: null, delivered_at: null }
}

/** 明細の型番・素材。手で指定されていなければ商品名から自動抽出する */
export function resolveLineCode(l: { name: string; model_code?: string | null; series_code?: string | null; material?: Material | null }): {
  model_code: string | null
  series_code: string | null
  material: Material | null
} {
  const extracted = extractCode(l.name)
  return {
    model_code: l.model_code !== undefined ? l.model_code : extracted?.model_code ?? null,
    series_code: l.series_code !== undefined ? l.series_code : extracted?.series_code ?? null,
    material: l.material !== undefined ? l.material : extractMaterial(l.name),
  }
}

/** order_no の前後の空白を除く。空文字・空白のみは null（UNIQUE 制約に引っかからない値）。 */
export function normalizeOrderNo(orderNo: string | null | undefined): string | null {
  if (orderNo == null) return null
  const trimmed = orderNo.trim()
  return trimmed === '' ? null : trimmed
}

function modelCodeText(v: unknown, name: string): string | null | undefined {
  return argNullableText(name, v, { max: CODE_MAX })
}

function imageUrlText(v: unknown, name: string): string | null | undefined {
  const url = argNullableText(name, v, { max: URL_MAX })
  if (url === undefined || url === null) return url
  // 取り込みの PC が後でこの URL を取りに行く。http(s) 以外（file:// など）は受けない
  if (!/^https?:\/\//i.test(url)) throw new UserError(`${name}は http か https の URL で入力してください`)
  return url
}

/** 画像の保存先（Storage のパス）。この世帯のフォルダの中だけ（他の世帯の画像を指させない） */
function storagePath(ctx: Ctx, name: string, v: unknown): string {
  const path = argText(name, v, { max: 500 })
  if (!path.startsWith(`${ctx.householdId}/`) || path.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) {
    throw new UserError(`${name}が正しくありません`)
  }
  return path
}

// ------------------------------------------------------------
// 入力の検査
// ------------------------------------------------------------

interface ValidLine {
  name: string
  unit_price: number
  quantity: number
  model_code: string | null
  series_code: string | null
  material: Material | null
  image_url: string | null
}

interface ValidPurchase {
  shop_account_id: string
  ordered_at: string
  order_no: string | null
  shipping_fee: number
  discount: number
  other_cost: number
  alloc_method: AllocMethod
  note: string | null
  import_key: string | null
  fulfillment: Fulfillment | null
  lines: ValidLine[]
}

function validLines(rawLines: unknown): ValidLine[] {
  const raw = argArray('明細', rawLines, { max: MAX_LINES })
  if (raw.length === 0) throw new UserError('明細がありません')
  let items = 0
  const lines = raw.map((l, i) => {
    const o = argObject(`${i + 1}行目`, l)
    const name = argText(`${i + 1}行目の商品名`, o.name, { max: NAME_MAX })
    assertQty(`${i + 1}行目の数量`, o.quantity)
    assertYen(`${i + 1}行目の単価`, o.unit_price)
    if (o.quantity > MAX_LINE_QUANTITY) throw new UserError(`${i + 1}行目の数量は${MAX_LINE_QUANTITY}以下で入力してください`)
    items += o.quantity
    // 手で指定されていなければ（undefined）商品名から自動抽出する。null は「無し」と指定したことになる
    const code = resolveLineCode({
      name,
      model_code: modelCodeText(o.model_code, `${i + 1}行目の型番`),
      series_code: modelCodeText(o.series_code, `${i + 1}行目のシリーズ`),
      material: argNullableText(`${i + 1}行目の素材`, o.material, { max: CODE_MAX }) as Material | null | undefined,
    })
    return {
      name, unit_price: o.unit_price, quantity: o.quantity, ...code,
      image_url: imageUrlText(o.image_url, `${i + 1}行目の画像URL`) ?? null,
    }
  })
  if (items > MAX_ITEMS_PER_PURCHASE) throw new UserError(`1回の仕入で登録できるのは合計${MAX_ITEMS_PER_PURCHASE}点までです`)
  return lines
}

/**
 * createPurchase / confirmPurchase 共通の入力チェック。
 * 制約違反（UNIQUE/CHECK/NOT NULL 違反）がそのまま画面に出ないよう、分かる範囲で先に日本語で弾く。
 * 戻り値は検査済みで、order_no は trim 済み（保存にそのまま使う）。
 */
async function validatePurchaseInput(ctx: Ctx, input: unknown, excludeId?: string): Promise<ValidPurchase> {
  const o = argObject('仕入', input)
  const shopId = argId('仕入先', o.shop_account_id)
  const shop = await ctx.sql.get<{ id: string }>('select id from shop_account where id = ?', shopId)
  if (!shop) throw new UserError('仕入先が見つかりません', 'not_found')

  const lines = validLines(o.lines)
  const shippingFee = o.shipping_fee ?? 0
  const discount = o.discount ?? 0
  const otherCost = o.other_cost ?? 0
  assertYen('送料', shippingFee)
  assertYen('割引', discount)
  assertYen('その他費用', otherCost)
  assertDateText('注文日', o.ordered_at)

  const orderNo = normalizeOrderNo(argNullableText('注文番号', o.order_no, { max: ORDER_NO_MAX }))
  if (orderNo) {
    const dup = await findDuplicateOrderNo(ctx, shopId, orderNo, excludeId)
    if (dup) {
      throw new UserError(
        `この仕入先には注文番号「${orderNo}」の仕入が既にあります（${dup.ordered_at} の登録）`, 'conflict',
      )
    }
  }

  return {
    shop_account_id: shopId,
    ordered_at: o.ordered_at,
    order_no: orderNo,
    shipping_fee: shippingFee,
    discount,
    other_cost: otherCost,
    alloc_method: argOptEnum('按分方法', o.alloc_method, ALLOC_METHODS) ?? 'by_amount',
    note: argNullableText('メモ', o.note, { max: NOTE_MAX }) ?? null,
    // 空文字は「キー無し」（'' のまま入れると、2 件目から一意制約に当たる）
    import_key: argNullableText('注文のキー', o.import_key, { max: IMPORT_KEY_MAX }) || null,
    fulfillment: argNullableEnum('到着状態', o.fulfillment, FULFILLMENTS) ?? null,
    lines,
  }
}

/**
 * 同じ仕入先に同じ注文番号の仕入が既にあれば、その仕入の情報を返す（人が読める文にするため）。
 * excludeId は自分自身を除くとき（確定時の変更）に使う。
 */
export async function findDuplicateOrderNo(
  ctx: Ctx, shopAccountId: string, orderNo: string, excludeId?: string,
): Promise<{ id: string; ordered_at: string } | undefined> {
  const shopId = argId('仕入先', shopAccountId)
  if (excludeId) {
    return ctx.sql.get(
      'select id, ordered_at from purchase where shop_account_id = ? and btrim(order_no) = ? and id <> ?',
      shopId, orderNo, argId('仕入', excludeId),
    )
  }
  return ctx.sql.get('select id, ordered_at from purchase where shop_account_id = ? and btrim(order_no) = ?', shopId, orderNo)
}

// ------------------------------------------------------------
// 登録（按分して明細・在庫を作る）
// ------------------------------------------------------------

/**
 * 按分して明細・在庫アイテムを作る。createPurchase / confirmPurchase の共通処理。
 * landed_cost・item_code はここで確定し、以後は独立（過去の利益を動かさない）
 */
async function insertLinesAndItems(
  ctx: Ctx, purchaseId: string, lines: ValidLine[], pool: number, method: AllocMethod, orderedAt: string,
): Promise<void> {
  // 按分は money.ts の allocate をそのまま使う（端数は最終行へ。pool が負でも合計は pool に一致する）
  let alloc: Map<string, { allocated: number }>
  try {
    alloc = allocate(lines.map((l, i) => ({ id: String(i), unit_price: l.unit_price, quantity: l.quantity })), pool, method)
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : '按分できません')
  }

  // 先に全部の数字を作って範囲を確かめる（途中で integer 列からあふれて半端に書かない）
  const planned = lines.map((l, i) => {
    const allocated = alloc.get(String(i))!.allocated
    // purchase_line.landed_unit_cost は基準値（端数切り捨て）。実際のアイテムごとの原価は splitEvenly で 1 円単位まで割り振る
    const baseUnit = l.unit_price + Math.floor(allocated / l.quantity)
    const costs = splitEvenly(allocated, l.quantity).map(part => l.unit_price + part)
    for (const v of [allocated, baseUnit, ...costs]) {
      if (!Number.isSafeInteger(v) || Math.abs(v) > MAX_INT4) throw new UserError('金額が大きすぎます')
    }
    return { allocated, baseUnit, costs }
  })

  // 在庫コードは全部まとめて 1 回で採番する（在庫の担当の nextItemCodes。1 点ずつ採番しない）
  const allCodes = await nextItemCodes(ctx, lines.reduce((s, l) => s + l.quantity, 0))
  let codeAt = 0
  // 在庫の created_at の起点。同じトランザクションの now() は同着で、clock_timestamp() も環境によっては粗いので、
  // 起点を 1 回だけ読み、点ごとに 1 マイクロ秒ずつ進める（明細をまたいでも、作った順に並ぶ）
  const base = (await ctx.sql.get<{ t: string }>('select clock_timestamp() as t'))!.t

  for (const [i, l] of lines.entries()) {
    const p = planned[i]
    const row = await ctx.sql.get<{ id: string }>(
      `insert into purchase_line
         (purchase_id, name, unit_price, quantity, model_code, series_code, material,
          allocated_cost, landed_unit_cost, sort_order, image_url)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       returning id`,
      purchaseId, l.name, l.unit_price, l.quantity, l.model_code, l.series_code, l.material,
      p.allocated, p.baseUnit, i, l.image_url,
    )
    const lineId = row!.id

    // 数量分だけ在庫アイテムを生成する（コードは在庫の採番に従う）
    const codes = allCodes.slice(codeAt, codeAt + l.quantity)
    await ctx.sql.run(
      `insert into inventory_item
         (item_code, purchase_line_id, name, landed_cost, acquired_at, model_code, series_code, material, created_at)
       select t.code, ?::uuid, ?::text, t.cost, ?::date, ?::text, ?::text, ?::text,
              ?::timestamptz + (t.n + ?::integer) * interval '1 microsecond'
         from unnest(?::text[], ?::integer[]) with ordinality as t(code, cost, n)`,
      lineId, l.name, orderedAt, l.model_code, l.series_code, l.material, base, codeAt, codes, p.costs,
    )
    codeAt += l.quantity
  }
}

export async function createPurchase(ctx: Ctx, input: PurchaseInput): Promise<string> {
  const v = await validatePurchaseInput(ctx, input)

  if (v.import_key) {
    const exists = await ctx.sql.get<{ id: string }>('select id from purchase where import_key = ?', v.import_key)
    if (exists) throw new UserError(`同じ注文が既に取り込まれています: ${v.import_key}`, 'conflict')
  }

  // 配賦対象額：送料 + その他 − 割引
  const pool = v.shipping_fee + v.other_cost - v.discount
  const { shipped_at, delivered_at } = initialFulfillmentDates(v.fulfillment)

  // created_at は clock_timestamp()（同じトランザクションで何件入れても、入れた順に並ぶように）
  const row = await ctx.sql.get<{ id: string }>(
    `insert into purchase
       (shop_account_id, ordered_at, order_no, shipping_fee, discount, other_cost, alloc_method, note, import_key,
        status, fulfillment, fulfillment_updated_at, shipped_at, delivered_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?::text, case when ?::text is not null then now() end, ?, ?, clock_timestamp())
     returning id`,
    v.shop_account_id, v.ordered_at, v.order_no, v.shipping_fee, v.discount, v.other_cost, v.alloc_method, v.note, v.import_key,
    v.fulfillment, v.fulfillment, shipped_at, delivered_at,
  )
  const purchaseId = row!.id

  await insertLinesAndItems(ctx, purchaseId, v.lines, pool, v.alloc_method, v.ordered_at)
  await applyShopAccountAutoTags(ctx, purchaseId, v.shop_account_id)
  return purchaseId
}

/**
 * まとめて登録。1 件ずつ createPurchase と同じ検証で登録し、失敗した行は理由を付けて返す
 * （全体を止めない。1 件ごとに SAVEPOINT を張るので、失敗した 1 件だけが巻き戻る）。
 * 同じ呼び出しの中で注文番号が重複（同じ仕入先・同じ注文番号が 2 回）したら、
 * DB へ当たる前に「同じCSVの中で重複」として弾く（空の注文番号は見ない）。
 */
export async function importPurchases(ctx: Ctx, inputs: PurchaseInput[]): Promise<PurchaseImportResult> {
  const list = argArray('取り込む仕入', inputs, { max: MAX_IMPORT_ORDERS })
  const result: PurchaseImportResult = { created: 0, skipped: [] }
  // このインポート内だけで見る注文番号の重複チェック（shop_account_id + order_no）
  const seen = new Set<string>()

  for (const [index, raw] of list.entries()) {
    const input = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as PurchaseInput
    const orderNo = typeof input.order_no === 'string' ? normalizeOrderNo(input.order_no) : null
    if (orderNo) {
      const key = `${String(input.shop_account_id).toLowerCase()}|${orderNo}`
      if (seen.has(key)) {
        result.skipped.push({ index, reason: `同じCSVの中で注文番号「${orderNo}」が重複しています` })
        continue
      }
      seen.add(key)
    }

    try {
      await ctx.sql.tx((sql) => createPurchase({ ...ctx, sql }, input))
      result.created += 1
    } catch (e) {
      // 利用者に見せてよい日本語（UserError）だけを理由にする。SQL のエラーの文面は見せない
      const known = e instanceof UserError ? e : mapDbError(e)
      if (!known) console.error('仕入の取り込みで想定外のエラー', e)
      result.skipped.push({ index, reason: known ? known.message : '登録できませんでした' })
    }
  }

  return result
}

/**
 * 注文履歴から積む下書き。価格・送料・注文番号は取れていれば入れ、まだなら 0 のまま
 * status='draft' で積む。在庫は確定するまで作らない。
 * 同じ import_key が既にあれば飛ばす（'' を返す）。
 */
export async function createPurchaseDraft(ctx: Ctx, input: PurchaseDraftInput): Promise<string> {
  const o = argObject('仕入の下書き', input)
  const importKey = argText('注文のキー', o.import_key, { max: IMPORT_KEY_MAX })
  if (!importKey) throw new UserError('注文のキーを入力してください')
  const shopId = argId('仕入先', o.shop_account_id)
  assertDateText('注文日', o.ordered_at)
  const orderNo = argNullableText('注文番号', o.order_no, { max: ORDER_NO_MAX }) ?? null
  const shippingFee = o.shipping_fee ?? 0
  const discount = o.discount ?? 0
  assertYen('送料', shippingFee)
  assertYen('割引', discount)
  const fulfillment = argNullableEnum('到着状態', o.fulfillment, FULFILLMENTS) ?? null
  const note = argNullableText('メモ', o.note, { max: NOTE_MAX }) ?? null

  const rawLines = argArray('明細', o.lines, { max: MAX_LINES })
  const lines = rawLines.map((l, i) => {
    const lo = argObject(`${i + 1}行目`, l)
    const name = argText(`${i + 1}行目の商品名`, lo.name, { max: NAME_MAX })
    assertQty(`${i + 1}行目の数量`, lo.quantity)
    if (lo.quantity > MAX_LINE_QUANTITY) throw new UserError(`${i + 1}行目の数量は${MAX_LINE_QUANTITY}以下で入力してください`)
    const unitPrice = lo.unit_price ?? 0
    assertYen(`${i + 1}行目の単価`, unitPrice)
    const code = resolveLineCode({
      name,
      model_code: modelCodeText(lo.model_code, `${i + 1}行目の型番`),
      series_code: modelCodeText(lo.series_code, `${i + 1}行目のシリーズ`),
      material: argNullableText(`${i + 1}行目の素材`, lo.material, { max: CODE_MAX }) as Material | null | undefined,
    })
    return { name, quantity: lo.quantity, unit_price: unitPrice, ...code }
  })

  const shop = await ctx.sql.get<{ id: string }>('select id from shop_account where id = ?', shopId)
  if (!shop) throw new UserError('仕入先が見つかりません', 'not_found')

  const exists = await ctx.sql.get<{ id: string }>('select id from purchase where import_key = ?', importKey)
  if (exists) return ''

  const { shipped_at, delivered_at } = initialFulfillmentDates(fulfillment)
  const row = await ctx.sql.get<{ id: string }>(
    `insert into purchase
       (shop_account_id, ordered_at, order_no, shipping_fee, discount, status, import_key, note,
        fulfillment, fulfillment_updated_at, shipped_at, delivered_at, created_at)
     values (?, ?, ?, ?, ?, 'draft', ?, ?, ?::text, case when ?::text is not null then now() end, ?, ?, clock_timestamp())
     returning id`,
    shopId, o.ordered_at, orderNo, shippingFee, discount, importKey, note,
    fulfillment, fulfillment, shipped_at, delivered_at,
  )
  const purchaseId = row!.id

  for (const [i, l] of lines.entries()) {
    await ctx.sql.run(
      `insert into purchase_line (purchase_id, name, unit_price, quantity, model_code, series_code, material, sort_order)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      purchaseId, l.name, l.unit_price, l.quantity, l.model_code, l.series_code, l.material, i,
    )
  }
  await applyShopAccountAutoTags(ctx, purchaseId, shopId)
  return purchaseId
}

/** 下書きを確定する：内容を input で置き換え、按分して在庫を生成する */
export async function confirmPurchase(ctx: Ctx, id: string, input: PurchaseInput): Promise<void> {
  const purchaseId = argId('仕入', id)
  // 同じ下書きを同時に 2 回確定されても在庫が二重に作られないよう、行をロックして状態を読む
  const cur = await ctx.sql.get<{ status: string }>('select status from purchase where id = ? for update', purchaseId)
  if (!cur) throw new UserError('仕入が見つかりません', 'not_found')
  if (cur.status !== 'draft') {
    throw new UserError('確定済みの仕入は再確定できません（原価は後から書き換えません）', 'conflict')
  }

  const v = await validatePurchaseInput(ctx, input, purchaseId)
  const pool = v.shipping_fee + v.other_cost - v.discount

  await ctx.sql.run(
    `update purchase
        set shop_account_id = ?, ordered_at = ?, order_no = ?,
            shipping_fee = ?, discount = ?, other_cost = ?, alloc_method = ?,
            note = ?, status = 'confirmed', updated_at = now()
      where id = ?`,
    v.shop_account_id, v.ordered_at, v.order_no, v.shipping_fee, v.discount, v.other_cost, v.alloc_method, v.note, purchaseId,
  )

  // 下書きの明細を作り直す（この時点では在庫はまだ無いので安全）
  await ctx.sql.run('delete from purchase_line where purchase_id = ?', purchaseId)

  await insertLinesAndItems(ctx, purchaseId, v.lines, pool, v.alloc_method, v.ordered_at)
}

export async function updatePurchaseNote(ctx: Ctx, id: string, note: string | null): Promise<void> {
  const purchaseId = argId('仕入', id)
  const text = argNullableText('メモ', note, { max: NOTE_MAX })
  if (text === undefined) throw new UserError('メモを指定してください')
  const result = await ctx.sql.run('update purchase set note = ?, updated_at = now() where id = ?', text, purchaseId)
  if (result.changes === 0) throw new UserError('仕入が見つかりません', 'not_found')
}

// ------------------------------------------------------------
// 到着状態（配送）
// ------------------------------------------------------------

type FulfillmentRow = {
  id: string
  fulfillment: Fulfillment | null
  shipped_at: string | null
  delivered_at: string | null
}

/** 到着状態の順位。noDowngrade の判定にだけ使う */
const FULFILLMENT_RANK: Record<Fulfillment, number> = { pending: 0, shipped: 1, delivered: 2 }

/**
 * 到着状態の更新の共通処理。import_key / id のどちらで引くかだけが呼び出し側で違う。
 * 変化が無ければ何もせず false。到着状態が shipped / delivered に進んだのを最初に
 * 観測した日を shipped_at / delivered_at に刻む（既に入っていれば触らない。後戻りしても消さない）。
 *
 * opts.noDowngrade：true なら今より低い状態（pending < shipped < delivered）や null には変えない
 * （人が「到着済」にしたものを、収集の自動更新が古い一覧の表示で巻き戻さないため）。
 * 「分からない（null）」から進める分は降格ではないので許可する
 */
async function applyFulfillment(
  ctx: Ctx, whereCol: 'import_key' | 'id', whereVal: string, fulfillment: Fulfillment | null,
  opts?: { noDowngrade?: boolean },
): Promise<boolean> {
  // 収集と画面の操作が重なっても、後から来た方が先の結果を見てから判断するよう行をロックする
  const cur = await ctx.sql.get<FulfillmentRow>(
    `select id, fulfillment, shipped_at, delivered_at from purchase where ${whereCol} = ? for update`, whereVal,
  )
  if (!cur) return false
  if (cur.fulfillment === fulfillment) return false

  if (opts?.noDowngrade) {
    if (fulfillment === null) {
      // 分かっている状態から「分からない」には戻さない
      if (cur.fulfillment !== null) return false
    } else if (cur.fulfillment !== null && FULFILLMENT_RANK[fulfillment] < FULFILLMENT_RANK[cur.fulfillment]) {
      return false
    }
  }

  const today = todayJst()
  let shippedAt = cur.shipped_at
  let deliveredAt = cur.delivered_at
  if (fulfillment === 'shipped' && !shippedAt) shippedAt = today
  if (fulfillment === 'delivered') {
    if (!shippedAt) shippedAt = today
    if (!deliveredAt) deliveredAt = today
  }

  await ctx.sql.run(
    `update purchase
        set fulfillment = ?, fulfillment_updated_at = now(),
            shipped_at = ?, delivered_at = ?, updated_at = now()
      where id = ?`,
    fulfillment, shippedAt, deliveredAt, cur.id,
  )
  return true
}

/**
 * 仕入元の注文の到着状態を更新する（取り込みが一覧の表示から更新する）。
 * import_key で引く。変化が無ければ何もせず false を返す。
 * 今より低い状態には変えない（人が手で進めた状態を、1 ページしか読まない収集で巻き戻さない）
 */
export async function updatePurchaseFulfillment(
  ctx: Ctx, importKey: string, fulfillment: Fulfillment | null,
): Promise<boolean> {
  const key = argText('注文のキー', importKey, { max: IMPORT_KEY_MAX })
  const f = argNullableEnum('到着状態', fulfillment, FULFILLMENTS) ?? null
  return applyFulfillment(ctx, 'import_key', key, f, { noDowngrade: true })
}

/**
 * 仕入先の注文詳細から読めた配送の情報を反映する（取り込みが呼ぶ）。
 * 状態は updatePurchaseFulfillment と同じ規則（前に進む方向だけ。今より低い状態や null には戻さない）。
 * 日付（shipped_at / delivered_at）は状態と切り離して扱う：渡された値があればお店の日付でそのまま
 * 上書きする（「気づいた日」ではなく、注文詳細から読めた実際の日の方が正しい）。
 * null が渡された（読めなかった）ときは既存の値を消さない。
 * 追跡番号・配送業者も読めたときだけ書き、null では消さない。
 * 戻り値は状態・日付・追跡番号のいずれかが変わったら true。仕入が無ければ false
 */
export async function applyFulfillmentFromShop(ctx: Ctx, purchaseId: string, f: {
  status: Fulfillment | null
  shipped_at: string | null
  delivered_at: string | null
  carrier: string | null
  tracking_number: string | null
}): Promise<boolean> {
  const o = argObject('配送の情報', f)
  const status = argNullableEnum('到着状態', o.status, FULFILLMENTS) ?? null
  const shippedAt = argNullableDate('発送日', o.shipped_at) ?? null
  const deliveredAt = argNullableDate('到着日', o.delivered_at) ?? null
  const carrier = argNullableText('配送業者', o.carrier, { max: TRACKING_TEXT_MAX }) ?? null
  const trackingNumber = argNullableText('追跡番号', o.tracking_number, { max: TRACKING_TEXT_MAX }) ?? null
  if (!isUuid(purchaseId)) return false
  const id = purchaseId.toLowerCase()

  const statusChanged = await applyFulfillment(ctx, 'id', id, status, { noDowngrade: true })

  const cur = await ctx.sql.get<{
    shipped_at: string | null; delivered_at: string | null; tracking_carrier: string | null; tracking_number: string | null
  }>('select shipped_at, delivered_at, tracking_carrier, tracking_number from purchase where id = ?', id)
  if (!cur) return statusChanged

  const nextShippedAt = shippedAt !== null ? shippedAt : cur.shipped_at
  const nextDeliveredAt = deliveredAt !== null ? deliveredAt : cur.delivered_at
  const nextCarrier = carrier !== null ? carrier : cur.tracking_carrier
  const nextTracking = trackingNumber !== null ? trackingNumber : cur.tracking_number

  const fieldsChanged =
    nextShippedAt !== cur.shipped_at || nextDeliveredAt !== cur.delivered_at ||
    nextCarrier !== cur.tracking_carrier || nextTracking !== cur.tracking_number
  if (!fieldsChanged) return statusChanged

  await ctx.sql.run(
    `update purchase
        set shipped_at = ?, delivered_at = ?, tracking_carrier = ?, tracking_number = ?, updated_at = now()
      where id = ?`,
    nextShippedAt, nextDeliveredAt, nextCarrier, nextTracking, id,
  )
  return true
}

/**
 * 到着状態を手で変える（TikTok Shop など自動取得しない仕入先向け。API の updatePurchaseFulfillment）。
 * shipped / delivered に初めて到達した日を shipped_at / delivered_at に刻む（既に入っていれば触らない）。
 * メロジョイの自動取得がある仕入は次の取り込みで注文一覧の状態に戻る。手動はどこへでも変えられる
 */
export async function setPurchaseFulfillment(ctx: Ctx, id: string, fulfillment: Fulfillment | null): Promise<void> {
  const purchaseId = argId('仕入', id)
  const f = argNullableEnum('到着状態', fulfillment, FULFILLMENTS)
  if (f === undefined) throw new UserError('到着状態を指定してください')
  const exists = await ctx.sql.get<{ id: string }>('select id from purchase where id = ?', purchaseId)
  if (!exists) throw new UserError('仕入が見つかりません', 'not_found')
  await applyFulfillment(ctx, 'id', purchaseId, f)
}

// ------------------------------------------------------------
// 追跡（17TRACK）
//
// 17TRACK は 2 段：register（追跡番号を登録。無料枠を消費する）→ gettrackinfo（登録済みの状況を読む）。
// 一度 register したら tracking_registered_at に印を付け、二度と送らない。到着済にできるのは 17TRACK だけ
// （メロジョイは「配達済み」を出さない）。tracking_status / tracking_checked_at は表示用で、到着の判定は
// fulfillment / delivered_at を見る。
// ------------------------------------------------------------

/**
 * まだ 17TRACK に登録していない追跡番号。登録（register）は無料枠を消費するので、
 * 一度登録したら二度と送らない。新しい注文が先
 */
export async function trackingRegisterCandidates(ctx: Ctx): Promise<Array<{ id: string; tracking_number: string }>> {
  return ctx.sql.all<{ id: string; tracking_number: string }>(`
    select id, tracking_number
      from purchase
     where tracking_number is not null and btrim(tracking_number) <> ''
       and (fulfillment is null or fulfillment <> 'delivered')
       and tracking_registered_at is null
     order by ordered_at desc, created_at desc, id
  `)
}

/**
 * 17TRACK に登録（register）できた仕入に印をつける。ここを忘れると無料枠を食い続ける。
 * updated_at は触らない（人が見る「更新」ではないため。setPurchaseImageChecked と同じ考え方）。
 * すでに印があるものは付け直さない（最初に登録した日時を保つ）
 */
export async function markTrackingRegistered(ctx: Ctx, purchaseIds: string[]): Promise<void> {
  const ids = argIds('仕入', purchaseIds)
  if (ids.length === 0) return
  await ctx.sql.run(
    'update purchase set tracking_registered_at = now() where id = any(?::uuid[]) and tracking_registered_at is null', ids,
  )
}

/**
 * 17TRACK を見るべき仕入。追跡番号を登録済みで、まだ到着が分かっていないもの。
 * 未登録の番号を送るとエラーになるだけなので対象にしない。未確認が先、次に古い順。
 * 取り込みは時間ごとのタイマーを持たず起動時と手動ボタンのときだけ（1 日数回）走るため、
 * 見た時刻による間隔・件数の絞り込みは不要。limit を省略すると全件返す
 */
export async function trackingCheckCandidates(ctx: Ctx, limit?: number): Promise<Array<{ id: string; tracking_number: string }>> {
  const n = argOptInt('件数', limit, { min: 0 })
  const sql = `select id, tracking_number
       from purchase
      where tracking_number is not null and btrim(tracking_number) <> ''
        and (fulfillment is null or fulfillment <> 'delivered')
        and tracking_registered_at is not null
      order by (tracking_checked_at is null) desc, tracking_checked_at asc, ordered_at desc, id`
  if (n === undefined) return ctx.sql.all<{ id: string; tracking_number: string }>(sql)
  return ctx.sql.all<{ id: string; tracking_number: string }>(`${sql} limit ?`, n)
}

/**
 * 設定画面に出す件数。17TRACK の無料枠を気にするので、これから登録する数が分かるようにする。
 * unregistered = trackingRegisterCandidates と同じ条件の件数、watching = 登録済みで未到着の件数
 */
export async function trackingCounts(ctx: Ctx): Promise<{ unregistered: number; watching: number }> {
  const unregistered = await ctx.sql.get<{ n: number }>(`
    select count(*) as n
      from purchase
     where tracking_number is not null and btrim(tracking_number) <> ''
       and (fulfillment is null or fulfillment <> 'delivered')
       and tracking_registered_at is null
  `)
  const watching = await ctx.sql.get<{ n: number }>(`
    select count(*) as n
      from purchase
     where tracking_registered_at is not null
       and (fulfillment is null or fulfillment <> 'delivered')
  `)
  return { unregistered: unregistered?.n ?? 0, watching: watching?.n ?? 0 }
}

/**
 * 17TRACK で見た結果を仕入に反映する（17TRACK の取り込みが呼ぶ）。
 * tracking_status / tracking_checked_at は必ず更新する（読めなかったときも進めて、
 * 次の収集で同じものばかり引かないようにする）。
 * 到着状態は前に進む方向だけ（noDowngrade。updatePurchaseFulfillment と同じ規則）。
 * 到着日は渡されたら上書きする（気づいた日ではなく配送会社の実際の日の方が正しいため）。
 * 知らない fulfillment・読めない日付は**捨てる**（推測で埋めない。状態・到着日は変えず、見た言葉と時刻だけ進む）。
 * 到着状態か到着日が変わったら true。仕入が無ければ false
 */
export async function applyTrackingResult(ctx: Ctx, purchaseId: string, r: {
  status_text: string | null
  fulfillment: Fulfillment | null
  delivered_at: string | null
}): Promise<boolean> {
  if (!isUuid(purchaseId)) return false
  const id = purchaseId.toLowerCase()
  const o = typeof r === 'object' && r !== null ? r : { status_text: null, fulfillment: null, delivered_at: null }
  const statusText = typeof o.status_text === 'string' ? o.status_text.replace(/\u0000/g, '').slice(0, TRACKING_TEXT_MAX) : null
  const fulfillment = FULFILLMENTS.includes(o.fulfillment as Fulfillment) ? (o.fulfillment as Fulfillment) : null
  const deliveredAt = typeof o.delivered_at === 'string' && isDateText(o.delivered_at) ? o.delivered_at : null

  const statusChanged = fulfillment !== null
    ? await applyFulfillment(ctx, 'id', id, fulfillment, { noDowngrade: true })
    : false

  const cur = await ctx.sql.get<{ delivered_at: string | null }>('select delivered_at from purchase where id = ?', id)
  if (!cur) return false

  const nextDeliveredAt = deliveredAt !== null ? deliveredAt : cur.delivered_at
  const deliveredAtChanged = nextDeliveredAt !== cur.delivered_at

  await ctx.sql.run(
    `update purchase
        set tracking_status = ?, tracking_checked_at = now(), delivered_at = ?, updated_at = now()
      where id = ?`,
    statusText, nextDeliveredAt, id,
  )

  return statusChanged || deliveredAtChanged
}

function isDateText(v: string): boolean {
  try {
    assertDateText('日付', v)
    return true
  } catch {
    return false
  }
}

/** 追跡番号（openTracking が URL を組み立てるのに使う）。無ければ null */
export async function getPurchaseTrackingNumber(ctx: Ctx, purchaseId: string): Promise<string | null> {
  if (!isUuid(purchaseId)) return null
  const row = await ctx.sql.get<{ tracking_number: string | null }>(
    'select tracking_number from purchase where id = ?', purchaseId.toLowerCase(),
  )
  return row?.tracking_number ?? null
}

/**
 * 17TRACK を見るのに必要な情報をまとめて返す（checkTracking が使う）。
 * 到着済（fulfillment === 'delivered'）なら二度と見に行かないので、判定できるよう
 * fulfillment と、既に保存済みの tracking_status も一緒に返す。
 * tracking_registered_at が null なら、まだ register していないので先に登録が要る。仕入が無ければ null
 */
export async function getPurchaseTracking(ctx: Ctx, purchaseId: string): Promise<{
  tracking_number: string | null
  fulfillment: Fulfillment | null
  tracking_status: string | null
  tracking_registered_at: string | null
} | null> {
  if (!isUuid(purchaseId)) return null
  const row = await ctx.sql.get<{
    tracking_number: string | null
    fulfillment: Fulfillment | null
    tracking_status: string | null
    tracking_registered_at: string | null
  }>(
    'select tracking_number, fulfillment, tracking_status, tracking_registered_at from purchase where id = ?',
    purchaseId.toLowerCase(),
  )
  return row ?? null
}

// ------------------------------------------------------------
// 明細の画像（仕入先の商品画像）
// ------------------------------------------------------------

/**
 * この仕入の明細のうち、元 URL はあるがまだ保存（ダウンロード）していないもの
 * （image_url is not null and image_path is null）。取り込みが画像を取る対象を探すのに使う。
 */
export async function purchaseLinesNeedingImage(
  ctx: Ctx, purchaseId: string, keywords: string[] = [],
): Promise<Array<{ id: string; image_url: string }>> {
  if (!isUuid(purchaseId)) return []
  const rows = await ctx.sql.all<{ id: string; name: string; image_url: string }>(
    `select id, name, image_url from purchase_line
      where purchase_id = ? and image_url is not null and image_path is null
      order by sort_order, created_at, id`,
    purchaseId.toLowerCase(),
  )
  return rows.filter(r => keywords.length === 0 || matchesAnyKeyword(r.name, keywords))
    .map(({ id, image_url }) => ({ id, image_url }))
}

/**
 * 一覧にある既取込注文のうち、注文詳細を開き直す理由があるもの。口座とキーワードも照合する。
 *
 * 注文詳細は画像だけでなく、配送状況・追跡番号（applyFulfillmentFromShop）もここから読むため、
 * 開く理由は次の OR：
 *   ① 画像のため … 自動画像を使う商品を含み（product_image を人が個別にセットした型番は除く）、
 *     かつ画像の確認が済んでいない（一度も詳細を開いていないか、URL は分かっているのに
 *     ダウンロードが済んでいない明細がある＝前回の保存失敗）
 *   ② 配送のため … まだ到着が分かっておらず、追跡番号もまだ無い（付けば 17TRACK が引き継ぐので
 *     以降はこの理由では開かない）。ただし ordered_at が 90 日より前の注文は対象にしない
 *     （キャンセル・国内発送など最後まで追跡番号が付かない古い注文を毎回開き続けないため）
 * ①も②も理由が無くなれば、この注文は候補から外れる。
 * 90 日の線は日本時間の暦日で引く（now は試験用。省略すれば今）
 */
export async function purchaseDetailRevisitCandidates(
  ctx: Ctx, shopAccountId: string, importKeys: string[], keywords: string[], now: Date = new Date(),
): Promise<Array<{ id: string; import_key: string }>> {
  if (!isUuid(shopAccountId) || importKeys.length === 0) return []
  const rows = await ctx.sql.all<{ id: string; import_key: string; name: string }>(`
    select p.id, p.import_key, pl.name
      from purchase p join purchase_line pl on pl.household_id = p.household_id and pl.purchase_id = p.id
     where p.shop_account_id = ? and p.import_key = any(?::text[])
       and (
         (
           not exists (select 1 from product_image pi where pi.household_id = pl.household_id and pi.model_code = pl.model_code)
           and (
             p.image_checked_at is null
             or exists (
               select 1 from purchase_line pl2
                where pl2.household_id = p.household_id and pl2.purchase_id = p.id
                  and pl2.image_url is not null and pl2.image_path is null
             )
           )
         )
         or (
           (p.fulfillment is null or p.fulfillment <> 'delivered')
           and (p.tracking_number is null or btrim(p.tracking_number) = '')
           and p.ordered_at >= ?::date
         )
       )
     order by p.ordered_at desc, p.id, pl.sort_order, pl.id
  `, shopAccountId.toLowerCase(), importKeys, subtractDaysJst(todayJst(now), 90))
  const candidates = new Map<string, { id: string; import_key: string }>()
  for (const row of rows) {
    if (keywords.length === 0 || matchesAnyKeyword(row.name, keywords)) {
      candidates.set(row.id, { id: row.id, import_key: row.import_key })
    }
  }
  return [...candidates.values()]
}

/**
 * 注文詳細を開いて画像 URL を確認したことを刻む（巡回で詳細を読めたときだけ呼ぶ）。
 * 読めなかった（例外・shouldSkipDetail）ときは呼ばない＝次回また候補に残る。updated_at は触らない
 */
export async function setPurchaseImageChecked(ctx: Ctx, purchaseId: string): Promise<void> {
  await ctx.sql.run('update purchase set image_checked_at = now() where id = ?', argId('仕入', purchaseId))
}

/** ダウンロードした画像の保存先（Storage のパス）を明細に保存する（取り込みが呼ぶ） */
export async function setPurchaseLineImage(ctx: Ctx, lineId: string, path: string): Promise<void> {
  await ctx.sql.run(
    'update purchase_line set image_path = ? where id = ?', storagePath(ctx, '画像の保存先', path), argId('明細', lineId),
  )
}

/**
 * メンテ用：仕入の明細を名前で突き合わせて image_url を更新する（refetchPurchaseImages が使う）。
 * image_path はそのまま持つが、URL が変わった行だけ image_path を NULL に戻して取り直させる。
 * 更新した行数を返す
 */
export async function setPurchaseLineImageUrls(
  ctx: Ctx, purchaseId: string, urls: Array<{ name: string; image_url: string }>,
): Promise<number> {
  const id = argId('仕入', purchaseId)
  const list = argArray('画像の URL', urls).map((u, i) => {
    const o = argObject(`${i + 1}件目の画像`, u)
    const url = imageUrlText(o.image_url, `${i + 1}件目の画像URL`)
    if (!url) throw new UserError(`${i + 1}件目の画像URLを入力してください`)
    return { name: argText(`${i + 1}件目の商品名`, o.name, { max: NAME_MAX }), image_url: url }
  })

  let updated = 0
  for (const u of list) {
    const rows = await ctx.sql.all<{ id: string; image_url: string | null }>(
      'select id, image_url from purchase_line where purchase_id = ? and name = ? order by sort_order, created_at, id', id, u.name,
    )
    for (const row of rows) {
      if (row.image_url !== u.image_url) {
        await ctx.sql.run('update purchase_line set image_url = ?, image_path = null where id = ?', u.image_url, row.id)
        updated += 1
      }
    }
  }
  return updated
}

// ------------------------------------------------------------
// 一覧・詳細
// ------------------------------------------------------------

/**
 * listPurchases / getPurchaseSummary で共通の select（where・order by は呼び出し側で足す）。
 * 単価 × 数量は integer の範囲を超えうるので bigint で掛け、sum(bigint) は numeric（文字列）になるので ::bigint に戻す
 */
const PURCHASE_SUMMARY_SELECT = `
  select
    p.id, p.status, p.ordered_at, p.order_no, p.shop_account_id,
    p.shipping_fee, p.discount, p.note, p.import_key, p.fulfillment,
    p.shipped_at, p.delivered_at, p.tracking_carrier, p.tracking_number,
    p.tracking_status, p.tracking_checked_at,
    sa.name as shop_account_name,
    count(pl.id) as line_count,
    coalesce(sum(pl.unit_price::bigint * pl.quantity), 0)::bigint as subtotal,
    coalesce(sum(pl.unit_price::bigint * pl.quantity + pl.allocated_cost), 0)::bigint as total_cost,
    (select x.name from purchase_line x
      where x.household_id = p.household_id and x.purchase_id = p.id
      order by x.sort_order, x.created_at, x.id limit 1) as first_line_name,
    (select x.model_code from purchase_line x
      where x.household_id = p.household_id and x.purchase_id = p.id
      order by x.sort_order, x.created_at, x.id limit 1) as first_model_code
  from purchase p
  join shop_account sa on sa.household_id = p.household_id and sa.id = p.shop_account_id
  left join purchase_line pl on pl.household_id = p.household_id and pl.purchase_id = p.id
`

export async function listPurchases(ctx: Ctx): Promise<PurchaseSummary[]> {
  const rows = await ctx.sql.all<Omit<PurchaseSummary, 'tags'>>(
    `${PURCHASE_SUMMARY_SELECT} group by p.id, sa.id order by p.ordered_at desc, p.created_at desc, p.id`,
  )
  const tagMap = await loadTagsFor(ctx, 'purchase_tag', 'purchase_id', rows.map(r => r.id))
  return rows.map(r => ({ ...r, tags: tagMap.get(r.id) ?? [] }))
}

/** 1 件分の PurchaseSummary（getItemTimeline が使う）。無ければ undefined */
export async function getPurchaseSummary(ctx: Ctx, id: string): Promise<PurchaseSummary | undefined> {
  const purchaseId = argId('仕入', id)
  const row = await ctx.sql.get<Omit<PurchaseSummary, 'tags'>>(
    `${PURCHASE_SUMMARY_SELECT} where p.id = ? group by p.id, sa.id`, purchaseId,
  )
  if (!row) return undefined
  const tagMap = await loadTagsFor(ctx, 'purchase_tag', 'purchase_id', [purchaseId])
  return { ...row, tags: tagMap.get(purchaseId) ?? [] }
}

/**
 * 仕入明細から生まれた在庫 1 点ずつのいまの状態（getPurchase が使う）。
 * 分割で生まれた子は親の purchase_line_id を引き継ぐため、分割済みの親（status='split'）を
 * 除けば子だけが自然に対象になる。明細ごとに問い合わせず 1 クエリでまとめて引く。
 * 出品価格は active / suspended の出品に引き当てられているものだけ（終わった出品は出さない）
 */
export async function loadPurchaseLineItems(ctx: Ctx, lineIds: string[]): Promise<Map<string, PurchaseLine['items']>> {
  const map = new Map<string, PurchaseLine['items']>()
  if (lineIds.length === 0) return map

  const rows = await ctx.sql.all<{
    line_id: string
    id: string; item_code: string; status: PurchaseLine['items'][number]['status']; landed_cost: number
    listing_price: number | null
    sale_id: string | null; sale_price: number | null; sold_at: string | null
    image_path: string | null
  }>(`
    select
      i.purchase_line_id as line_id,
      i.id, i.item_code, i.status, i.landed_cost,
      (select lst.price
         from listing_line ll
         join listing lst on lst.household_id = ll.household_id and lst.id = ll.listing_id
        where ll.household_id = i.household_id and ll.inventory_item_id = i.id
          and lst.status in ('active', 'suspended')
        order by lst.last_seen_at desc, lst.id
        limit 1) as listing_price,
      sl.sale_id   as sale_id,
      s.price      as sale_price,
      s.sold_at    as sold_at,
      pl.image_path as image_path
    from inventory_item i
    join purchase_line pl on pl.household_id = i.household_id and pl.id = i.purchase_line_id
    left join sale_line sl on sl.household_id = i.household_id and sl.inventory_item_id = i.id
    left join sale s       on s.household_id = sl.household_id and s.id = sl.sale_id
    where i.purchase_line_id = any(?::uuid[]) and i.status <> 'split'
    order by i.created_at, i.item_code collate "C"
  `, lineIds)

  for (const r of rows) {
    const arr = map.get(r.line_id) ?? []
    arr.push({
      id: r.id,
      item_code: r.item_code,
      status: r.status,
      landed_cost: r.landed_cost,
      listing_price: r.listing_price,
      sale_id: r.sale_id,
      sale_price: r.sale_price,
      sold_at: r.sold_at,
      image_url: mediaUrl(ctx, r.image_path),
    })
    map.set(r.line_id, arr)
  }
  return map
}

export async function getPurchase(ctx: Ctx, id: string): Promise<PurchaseDetail> {
  const purchaseId = argId('仕入', id)
  const p = await ctx.sql.get<PurchaseSummary & { other_cost: number; alloc_method: AllocMethod }>(
    `select p.id, p.status, p.ordered_at, p.order_no, p.shop_account_id, sa.name as shop_account_name,
            p.shipping_fee, p.discount, p.other_cost, p.alloc_method, p.note, p.import_key,
            p.fulfillment, p.shipped_at, p.delivered_at,
            p.tracking_carrier, p.tracking_number, p.tracking_status, p.tracking_checked_at
       from purchase p
       join shop_account sa on sa.household_id = p.household_id and sa.id = p.shop_account_id
      where p.id = ?`,
    purchaseId,
  )
  if (!p) throw new UserError('仕入が見つかりません', 'not_found')

  const lineRows = await ctx.sql.all<Omit<PurchaseLine, 'items'>>(
    `select id, name, unit_price, quantity, model_code, series_code, material, allocated_cost, landed_unit_cost
       from purchase_line where purchase_id = ? order by sort_order, created_at, id`,
    purchaseId,
  )
  const itemsMap = await loadPurchaseLineItems(ctx, lineRows.map(l => l.id))
  const lines: PurchaseLine[] = lineRows.map(l => ({ ...l, items: itemsMap.get(l.id) ?? [] }))

  const subtotal = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0)
  const total_cost = lines.reduce((s, l) => s + l.unit_price * l.quantity + l.allocated_cost, 0)
  const tagMap = await loadTagsFor(ctx, 'purchase_tag', 'purchase_id', [purchaseId])

  return {
    id: p.id,
    status: p.status,
    ordered_at: p.ordered_at,
    order_no: p.order_no,
    shop_account_id: p.shop_account_id,
    shop_account_name: p.shop_account_name,
    shipping_fee: p.shipping_fee,
    discount: p.discount,
    other_cost: p.other_cost,
    alloc_method: p.alloc_method,
    note: p.note,
    import_key: p.import_key,
    fulfillment: p.fulfillment,
    shipped_at: p.shipped_at,
    delivered_at: p.delivered_at,
    tracking_carrier: p.tracking_carrier,
    tracking_number: p.tracking_number,
    tracking_status: p.tracking_status,
    tracking_checked_at: p.tracking_checked_at,
    line_count: lines.length,
    first_line_name: lines[0]?.name ?? null,
    first_model_code: lines[0]?.model_code ?? null,
    subtotal,
    total_cost,
    tags: tagMap.get(purchaseId) ?? [],
    lines,
  }
}

// ------------------------------------------------------------
// 削除・タグ
// ------------------------------------------------------------

export async function deletePurchase(ctx: Ctx, id: string): Promise<void> {
  const purchaseId = argId('仕入', id)

  // 在庫の行を先にロックする（確かめた後に別の端末が販売へ紐付けても、ここを抜けられないように）
  await ctx.sql.all(
    `select i.id from inventory_item i
       join purchase_line pl on pl.household_id = i.household_id and pl.id = i.purchase_line_id
      where pl.purchase_id = ? for update of i`,
    purchaseId,
  )

  // 売れた在庫がぶら下がっていたら消させない。消すと販売側の原価が消えて過去の利益が壊れる
  const sold = await ctx.sql.get<{ c: number }>(`
    select count(*) as c
      from inventory_item i
      join purchase_line pl on pl.household_id = i.household_id and pl.id = i.purchase_line_id
     where pl.purchase_id = ? and i.status = 'sold'
  `, purchaseId)

  if ((sold?.c ?? 0) > 0) {
    throw new UserError(`この仕入には販売済みの在庫が${sold!.c}点あります。先に紐付けを解除してください`, 'conflict')
  }

  // 出品への引き当て（listing_line）は inventory_item への外部キーに ON DELETE が無いため、
  // 在庫より先に purchase を消すと外部キー違反になる。先に引き当てだけ外す
  // （出品自体は残り、未引き当てに戻る。listing.status は変えない）
  await ctx.sql.run(`
    delete from listing_line
     where inventory_item_id in (
       select i.id from inventory_item i
         join purchase_line pl on pl.household_id = i.household_id and pl.id = i.purchase_line_id
        where pl.purchase_id = ?
     )
  `, purchaseId)
  await ctx.sql.run('delete from purchase where id = ?', purchaseId)
}

/**
 * 仕入のタグを丸ごと置き換える（空配列で全部外す）。
 * その仕入から生まれた在庫すべて・その在庫が紐付いた販売に派生で見える（コピーしない）
 */
export async function setPurchaseTags(ctx: Ctx, purchaseId: string, tagIds: string[]): Promise<void> {
  const id = argId('仕入', purchaseId)
  const unique = [...new Set(argIds('タグ', tagIds))]
  const exists = await ctx.sql.get<{ id: string }>('select id from purchase where id = ?', id)
  if (!exists) throw new UserError('仕入が見つかりません', 'not_found')
  await assertTagsExist(ctx, unique)

  await ctx.sql.run('delete from purchase_tag where purchase_id = ?', id)
  if (unique.length > 0) {
    await ctx.sql.run(
      'insert into purchase_tag (purchase_id, tag_id) select ?::uuid, t.tag_id from unnest(?::uuid[]) as t(tag_id)', id, unique,
    )
  }
}

// ------------------------------------------------------------
// 取り込みの除外記録・店名の学習
// ------------------------------------------------------------

/**
 * メロジョイの注文取り込みの除外記録（取り込み用）。
 * キーワードが変わったら（keywords_hash 不一致）再評価する。初期化では消さない
 * （shop_alias・product_name と同じ、学習に近い知識のため）
 */
export async function isMellojoyOrderExcluded(
  ctx: Ctx, shopAccountId: string, orderKey: string, keywordsHash: string,
): Promise<boolean> {
  if (!isUuid(shopAccountId)) return false
  const row = await ctx.sql.get<{ keywords_hash: string }>(
    'select keywords_hash from mellojoy_excluded_order where shop_account_id = ? and order_key = ?',
    shopAccountId.toLowerCase(), argText('注文のキー', orderKey, { max: IMPORT_KEY_MAX }),
  )
  return !!row && row.keywords_hash === argText('キーワードの印', keywordsHash, { max: 200 })
}

export async function markMellojoyOrderExcluded(
  ctx: Ctx, shopAccountId: string, orderKey: string, keywordsHash: string,
): Promise<void> {
  const shopId = argId('仕入先', shopAccountId)
  const key = argText('注文のキー', orderKey, { max: IMPORT_KEY_MAX })
  const hash = argText('キーワードの印', keywordsHash, { max: 200 })
  const shop = await ctx.sql.get<{ id: string }>('select id from shop_account where id = ?', shopId)
  if (!shop) throw new UserError('仕入先が見つかりません', 'not_found')
  await ctx.sql.run(`
    insert into mellojoy_excluded_order (shop_account_id, order_key, keywords_hash, excluded_at)
    values (?, ?, ?, now())
    on conflict (household_id, shop_account_id, order_key)
      do update set keywords_hash = excluded.keywords_hash, excluded_at = excluded.excluded_at
  `, shopId, key, hash)
}

/** 学習済みの店名を返す（レシートの登録番号 T＋13桁 → 店名）。無ければ null */
export async function lookupShopAlias(ctx: Ctx, registrationNo: string): Promise<string | null> {
  const no = argText('登録番号', registrationNo, { max: 100 })
  const row = await ctx.sql.get<{ shop: string }>('select shop from shop_alias where key = ?', `reg:${no}`)
  return row ? row.shop : null
}

/** 「この登録番号＝この店名」を覚える（upsert）。shop は trim、空なら何もしない */
export async function learnShopAlias(ctx: Ctx, registrationNo: string, shop: string): Promise<void> {
  const no = argText('登録番号', registrationNo, { max: 100 })
  const trimmed = argText('店名', shop, { max: 200 }).trim()
  if (!trimmed) return
  await ctx.sql.run(`
    insert into shop_alias (key, shop, hits, updated_at)
    values (?, ?, 1, now())
    on conflict (household_id, key)
      do update set shop = excluded.shop, hits = shop_alias.hits + 1, updated_at = now()
  `, `reg:${no}`, trimmed)
}

/** 既存の import_key を返す（仕入の注文履歴の差分取得用） */
export async function existingImportKeys(ctx: Ctx, keys: string[]): Promise<Set<string>> {
  const list = argArray('注文のキー', keys)
  if (list.length === 0) return new Set()
  const rows = await ctx.sql.all<{ import_key: string }>(
    'select import_key from purchase where import_key = any(?::text[])', list.map((k, i) => argText(`${i + 1}件目の注文のキー`, k, { max: IMPORT_KEY_MAX })),
  )
  return new Set(rows.map(r => r.import_key))
}

// ------------------------------------------------------------
// 検索・CSV
// ------------------------------------------------------------

export function purchaseStatusLabel(p: Pick<PurchaseSummary, 'status' | 'fulfillment'>): string {
  if (p.status === 'draft') return '下書き'
  if (p.fulfillment === 'delivered') return '到着済'
  if (p.fulfillment === 'shipped') return '配送中'
  return '未着'
}

/** 仕入の明細（全件）の name/model_code を、purchase_id ごとにまとめて 1 クエリで引く */
export async function loadPurchaseLineTexts(ctx: Ctx, purchaseIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (purchaseIds.length === 0) return map

  const rows = await ctx.sql.all<{ purchase_id: string; name: string; model_code: string | null }>(
    'select purchase_id, name, model_code from purchase_line where purchase_id = any(?::uuid[]) order by sort_order, created_at, id',
    purchaseIds,
  )

  for (const r of rows) {
    const arr = map.get(r.purchase_id) ?? []
    arr.push(r.name)
    if (r.model_code) arr.push(r.model_code)
    map.set(r.purchase_id, arr)
  }
  return map
}

/** 横断検索の仕入の分（terms は正規化済みの語。searchAll が種類ごとに呼ぶ） */
export async function searchPurchaseHits(ctx: Ctx, terms: string[], perKind: number): Promise<SearchHit[]> {
  const purchases = await listPurchases(ctx)
  const lineTexts = await loadPurchaseLineTexts(ctx, purchases.map(p => p.id))

  const hits: SearchHit[] = purchases
    .filter(p => matchesQuery([
      p.first_line_name, p.order_no, p.shop_account_name, p.note,
      ...p.tags.map((t: Tag) => t.name), ...(lineTexts.get(p.id) ?? []),
    ], terms))
    .map(p => ({
      kind: 'purchase' as const,
      id: p.id,
      title: p.first_line_name ?? p.order_no ?? '(仕入)',
      model_code: p.first_model_code,
      status_label: purchaseStatusLabel(p),
      amount: p.total_cost,
      date: p.ordered_at,
      thumb_url: null,
    }))

  return sortAndSlice(hits, perKind)
}

/** 仕入（1 行＝仕入の 1 明細）の CSV。month（YYYY-MM）を渡すと注文日（ordered_at）で絞る。0 件は空文字 */
export async function exportPurchaseRows(ctx: Ctx, month?: string): Promise<string> {
  const range = month === undefined || month === null ? null : monthBounds(month)
  const rows = await ctx.sql.all<Record<string, unknown>>(`
    select
      p.ordered_at                                        as "注文日",
      sa.name                                             as "仕入先",
      p.order_no                                          as "注文番号",
      case p.status when 'draft' then '下書き' else '確定' end as "状態",
      pl.name                                             as "商品名",
      pl.model_code                                       as "型番",
      pl.quantity                                         as "数量",
      pl.unit_price                                       as "単価",
      pl.landed_unit_cost                                 as "按分後原価",
      p.shipping_fee                                      as "注文の送料",
      p.other_cost                                        as "注文のその他費用",
      p.discount                                          as "注文の割引",
      p.note                                              as "メモ"
    from purchase_line pl
    join purchase p on p.household_id = pl.household_id and p.id = pl.purchase_id
    left join shop_account sa on sa.household_id = p.household_id and sa.id = p.shop_account_id
    ${range ? 'where p.ordered_at between ?::date and ?::date' : ''}
    order by p.ordered_at, p.created_at, p.id, pl.sort_order, pl.id
  `, ...(range ? [range.start, range.end] : []))
  return rowsToCsv(rows)
}

// ------------------------------------------------------------
// API として出す
//
// 収集・追跡が使う関数（createPurchaseDraft・applyFulfillmentFromShop・tracking*・setPurchaseLineImage* など）は
// export するだけで登録しない（PC の取り込み／サーバーの 17TRACK 用の口は次の段）。openTracking・checkTracking も同じ
// ------------------------------------------------------------

registerHandler('listPurchases', (ctx) => listPurchases(ctx))
registerHandler('getPurchase', (ctx, id) => getPurchase(ctx, id))
registerHandler('createPurchase', (ctx, input) => createPurchase(ctx, input))
registerHandler('importPurchases', (ctx, inputs) => importPurchases(ctx, inputs))
registerHandler('confirmPurchase', (ctx, id, input) => confirmPurchase(ctx, id, input))
registerHandler('updatePurchaseNote', (ctx, id, note) => updatePurchaseNote(ctx, id, note))
registerHandler('updatePurchaseFulfillment', (ctx, id, f) => setPurchaseFulfillment(ctx, id, f))
registerHandler('deletePurchase', (ctx, id) => deletePurchase(ctx, id))
registerHandler('setPurchaseTags', (ctx, purchaseId, tagIds) => setPurchaseTags(ctx, purchaseId, tagIds))
