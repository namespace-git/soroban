import type { Ctx } from '../context'
import { UserError, registerDbErrorRule } from '../errors'
import { registerHandler } from '../rpc'
import type {
  AutoLinkBlocker, FeeSource, InventoryItem, SaleFilter, SaleInput, SaleKind, SalePatch, SaleProfit, SalesChannel,
  SaleSource, SaleStatus, SaleTotals, SearchHit,
} from '../../src/shared/types'
import {
  argArray, argDate, argEnum, argId, argIds, argInt, argNullableId, argNullableText, argNullableYen, argObject,
  argOptBool, argOptEnum, argOptId, argOptMonth, argOptText, argText, argYen, assertDateText,
  assertTagsExist, assertYen, calcFee, extractCodeQuantities, extractCodes, extractItemCodes, loadTagsFor, matchesAnyKeyword,
  matchesQuery, mediaUrl, mergeInheritedTags, monthBounds, realizedTotals, keywordsFor, setting, sortAndSlice, todayJst,
} from './_shared'
import {
  attachInventoryTags, inventoryViewColumns, loadInventoryTagsForSales, loadProductTagsForSales,
  loadPurchaseTagsForSales, type InventoryRow,
} from './derive'
import {
  findInventoryIdsByItemCodes, findInventoryIdsByModelCodeFifo, linkInventory,
} from './inventory'
import { takeOverListing } from './listing'

// ============================================================
// 販売（メルカリ・Yahoo!フリマの取引）と自動紐付け
//
// src/main/db.ts の販売まわり（createSale / updateSale / insertCollected ほか）の移植。
// 利益の計算はビュー（sale_profit）に寄せる。ここで利益を再集計しない（saleTotals は一覧の合計を足すだけ）。
//
// **紐付けを自動確定しない。例外は 3 つだけ**（autoLinkSale・insertCollected の引き継ぎ）：
//   ① 抽出した型番が 1 つで、在庫の model_code と文字列として完全一致（枝番の有無は問わない。先入先出）
//   ② タイトルに在庫コード（【S-0012】）があれば、その在庫を名指し（別の出品に引き当て済みの在庫は奪わず候補止まり）
//   ③ 人が出品に引き当てた在庫を、売れたときにそのまま引き継ぐ（takeOverListing）
//
// 日付：sold_at は計上日（月次・月フィルタの基準）。purchased_at は購入日時（日本時間の素の文字列で返す）。
// completed_at は購入完了日。サーバー（Workers）は UTC なので、「今日」は todayJst()。
//
// updated_at の約束：**人が手で触ったときだけ進める**（updateSale が clock_timestamp() を入れる）。
// appendModelCodes は「一度も更新されていない（updated_at = created_at）取り込みの販売」だけを、
// 私物から販売用に戻す。収集の書き込み（applySaleActuals・updateSaleStatus・appendModelCodes）は進めない。
// デスクトップ版は収集の書き込みでも datetime('now') を入れていたが、秒の精度なので同じ秒の中なら created_at と
// 同じになり、たまたま「触っていない」のまま通っていた。Postgres では別のリクエストなら必ず違う時刻になるので、
// そのまま写すと収集が走った後の救済（Yahoo!フリマの切れたタイトルが全文に直ったとき等）が二度と効かなくなる
// ============================================================

// 同じ出品先の商品ID（channel_item_id）の販売を同時に 2 本入れた 2 本目
registerDbErrorRule({
  code: '23505', constraint: 'sale_household_id_channel_item_id_key',
  message: 'その商品IDの販売はすでにあります', as: 'conflict',
})

const CHANNELS: readonly SalesChannel[] = ['mercari', 'yahoo']
const SALE_KINDS: readonly SaleKind[] = ['resale', 'personal']
const TITLE_MAX = 1000
const NOTE_MAX = 5000
const ITEM_ID_MAX = 100

/**
 * 出品先ごとの手数料率（ベーシスポイント）。mercari は設定 fee_rate_bp（既定1000=10.00%）、
 * yahoo は fee_rate_bp_yahoo（既定500=5.00%）。
 *
 * 【Yahoo!フリマの手数料は率で計算できない】実測：6,400円→320円(5%)・5,899円→294円(切り捨て)・
 * 4,280円→213円(5%なら214円で合わない)・5,200円→0円(キャンペーン適用)。式が存在しないため、
 * ここで返す率は「実額が取れないときの見込み」にしか使えない。実額が取れたらそちらを優先すること
 * （insertCollected の fee 引数・applySaleActuals がその受け皿）。
 *
 * 率は sale.fee_rate_bp に焼き付けて使う。あとで設定を変えても、焼き付け済みの過去の販売は動かさない
 * （手数料率を変えても既存の販売を再計算しない）。
 */
export async function feeRateBpFor(ctx: Ctx, channel: SalesChannel): Promise<number> {
  const fallback = channel === 'yahoo' ? 500 : 1000
  const rate = await setting(ctx, channel === 'yahoo' ? 'fee_rate_bp_yahoo' : 'fee_rate_bp', fallback)
  // 設定が数でなければ（手で壊れた値）、見込みの率に既定を使う。NaN を手数料に入れない
  return Number.isSafeInteger(rate) && rate >= 0 ? rate : fallback
}

// ------------------------------------------------------------
// 取引の進み具合
// ------------------------------------------------------------

/**
 * メルカリの取引の進み具合。この順でしか進まない（後戻りしない）。
 * waiting_payment＝購入されたが未入金、completed＝売却済み一覧に出た（取引完了）。
 */
const SALE_STATUS_ORDER: SaleStatus[] =
  ['waiting_payment', 'waiting_shipment', 'shipped', 'delivered', 'completed']

/**
 * status の初期値（取り込み時点で既に分かっている段階）から shipped_at / delivered_at /
 * completed_at を決める。該当段階に達していれば seenAt（観測日）を入れ、以後は updateSaleStatus 側で
 * 「最初に観測した日」として固定される。
 */
export function initialSaleStatusDates(
  status: SaleStatus | null | undefined, seenAt: string,
): { shipped_at: string | null; delivered_at: string | null; completed_at: string | null } {
  if (!status) return { shipped_at: null, delivered_at: null, completed_at: null }
  const idx = SALE_STATUS_ORDER.indexOf(status)
  return {
    shipped_at: idx >= SALE_STATUS_ORDER.indexOf('shipped') ? seenAt : null,
    delivered_at: idx >= SALE_STATUS_ORDER.indexOf('delivered') ? seenAt : null,
    completed_at: status === 'completed' ? seenAt : null,
  }
}

/**
 * メルカリの取引の進み具合を更新する（取引中タブから収集が呼ぶ。API には出さない）。
 * status は前にしか進まない：後戻り・同じ状態への更新は無視して false を返す
 * （買い手都合のキャンセル等で表示が乱れても、一度進んだ記録を壊さないため）。
 * 初めて shipped 以上になった日を shipped_at、初めて delivered 以上になった日を
 * delivered_at に刻む（既に入っていれば触らない）。商品IDが無ければ何もしない。
 * 戻り値は実際に状態が進んだかどうか。
 */
export async function updateSaleStatus(
  ctx: Ctx, mercariItemId: string, status: SaleStatus, seenAt: string = todayJst(),
): Promise<boolean> {
  const row = await ctx.sql.get<{
    id: string; status: SaleStatus | null; shipped_at: string | null; delivered_at: string | null
  }>('select id, status, shipped_at, delivered_at from sale where channel_item_id = ?', mercariItemId)
  if (!row) return false

  const curIdx = row.status ? SALE_STATUS_ORDER.indexOf(row.status) : -1
  const nextIdx = SALE_STATUS_ORDER.indexOf(argEnum('取引の状態', status, SALE_STATUS_ORDER))
  if (nextIdx <= curIdx) return false

  const day = argDate('観測日', seenAt)
  const shippedAt = nextIdx >= SALE_STATUS_ORDER.indexOf('shipped') && !row.shipped_at ? day : row.shipped_at
  const deliveredAt = nextIdx >= SALE_STATUS_ORDER.indexOf('delivered') && !row.delivered_at ? day : row.delivered_at

  await ctx.sql.run(
    `update sale set status = ?, shipped_at = ?, delivered_at = ? where id = ?`,
    status, shippedAt, deliveredAt, row.id,
  )
  return true
}

// ------------------------------------------------------------
// 作成・更新・削除
// ------------------------------------------------------------

export async function createSale(ctx: Ctx, input: SaleInput): Promise<string> {
  const i = argObject('販売', input)
  const title = argText('商品名', i.title, { max: TITLE_MAX })
  if (!title.trim()) throw new UserError('商品名を入力してください')
  const soldAt = argDate('販売日', i.sold_at)
  assertYen('価格', i.price)
  const price = i.price
  const channel = argOptEnum('出品先', i.channel, CHANNELS) ?? 'mercari'
  const kind = argOptEnum('区分', i.kind, SALE_KINDS) ?? 'resale'
  const itemIdRaw = argNullableText('商品ID', i.mercari_item_id, { max: ITEM_ID_MAX })
  const itemId = itemIdRaw && itemIdRaw.trim() ? itemIdRaw.trim() : null
  const note = argNullableText('メモ', i.note, { max: NOTE_MAX }) ?? null
  const actualFee = argNullableYen('手数料', i.fee)

  if (itemId) {
    const dup = await ctx.sql.get<{ id: string }>('select id from sale where channel_item_id = ?', itemId)
    if (dup) throw new UserError('その商品IDの販売はすでにあります', 'conflict')
  }

  const rateBp = await feeRateBpFor(ctx, channel)
  const modelCodes = extractCodes(title)

  // 実額（0円も実額。Yahoo!フリマは率で計算できないため）が渡っていればそれを使い
  // fee_source='actual' にする。無ければ率で見込みを計算し fee_source='rate'
  const hasActualFee = typeof actualFee === 'number'
  const fee = hasActualFee ? actualFee : calcFee(price, rateBp)
  const feeSource: FeeSource = hasActualFee ? 'actual' : 'rate'

  const row = await ctx.sql.get<{ id: string }>(`
    insert into sale
      (channel, channel_item_id, title, sold_at, price, kind, fee_rate_bp, fee, fee_source, note, source, model_codes)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)
    returning id
  `, channel, itemId, title, soldAt, price, kind, rateBp, fee, feeSource, note, modelCodes)
  const id = row!.id

  // 型番が完全一致すれば自動確定。それ以外は候補提示のまま（人が確定する）
  await autoLinkSale(ctx, id)
  return id
}

export async function updateSale(ctx: Ctx, id: string, patch: SalePatch): Promise<void> {
  const saleId = argId('販売', id)
  const p = argObject('販売の変更内容', patch)

  const cur = await ctx.sql.get<{
    price: number; fee_rate_bp: number; fee_source: FeeSource; title: string; model_codes: string[]
  }>('select price, fee_rate_bp, fee_source, title, model_codes from sale where id = ?', saleId)
  if (!cur) throw new UserError('販売が見つかりません', 'not_found')

  const sets: string[] = []
  const vals: unknown[] = []
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v) }

  const title = argOptText('商品名', p.title, { max: TITLE_MAX })
  if (title !== undefined) {
    if (!title.trim()) throw new UserError('商品名を入力してください')
    put('title', title)
    // model_codes は「画面のチップ」「自動紐付け（autoLinkSale）」共通の唯一の情報源（保存された列）。
    // タイトルを書き換えたら作り直す。ただし単純に extractCodes(新タイトル) で上書きすると、
    // 説明文から後追いで足された型番（appendModelCodes 由来）が消えてしまうため、
    // 「古いタイトルから来ていた型番」だけを落とし、それ以外（＝説明文由来）は残す
    const oldCodes = new Set(extractCodes(cur.title))
    const kept = (cur.model_codes ?? []).filter(c => !oldCodes.has(c))
    const seen = new Set(kept)
    const merged = [...kept]
    for (const c of extractCodes(title)) {
      if (!seen.has(c)) { seen.add(c); merged.push(c) }
    }
    put('model_codes', merged)
  }
  if (p.sold_at !== undefined) put('sold_at', argDate('販売日', p.sold_at))
  const kind = argOptEnum('区分', p.kind, SALE_KINDS)
  if (kind !== undefined) put('kind', kind)
  if (p.packaging_cost !== undefined) {
    assertYen('梱包材費', p.packaging_cost)
    put('packaging_cost', p.packaging_cost)
  }
  const note = argNullableText('メモ', p.note, { max: NOTE_MAX })
  if (note !== undefined) put('note', note)

  // 価格が変わったら手数料を再計算する。ただし実額（fee_source='actual'）は率で上書きしない
  // （Yahoo!フリマは手数料を率で計算できず、キャンペーンで実額0円のことがある。率で上書き
  // すると帳簿が実額と食い違ってしまう）
  if (p.price !== undefined) {
    assertYen('価格', p.price)
    put('price', p.price)
  }

  // patch.fee が渡っていれば、価格が同時に変わっていても実額が勝つ（number→実額、null→率に戻す）。
  // 渡っていなければ従来どおり、価格が変わったときだけ・実額でなければ率で再計算する
  const feePatch = argNullableYen('手数料', p.fee)
  if (feePatch !== undefined) {
    if (feePatch === null) {
      const price = typeof p.price === 'number' ? p.price : cur.price
      put('fee', calcFee(price, cur.fee_rate_bp))
      put('fee_source', 'rate')
    } else {
      put('fee', feePatch)
      put('fee_source', 'actual')
    }
  } else if (typeof p.price === 'number' && cur.fee_source !== 'actual') {
    put('fee', calcFee(p.price, cur.fee_rate_bp))
  }

  // 発送方法を選んだら送料をマスタから引き、確認済みにする
  const methodId = argNullableId('発送方法', p.shipping_method_id)
  if (methodId !== undefined) {
    put('shipping_method_id', methodId)
    if (methodId) {
      const m = await ctx.sql.get<{ fee: number }>('select fee from shipping_method where id = ?', methodId)
      if (!m) throw new UserError('発送方法が見つかりません', 'not_found')
      const fee = p.shipping_fee ?? m.fee
      assertYen('送料', fee)
      put('shipping_fee', fee)
      put('is_shipping_confirmed', 1)
      put('shipping_source', 'master')
    } else {
      put('is_shipping_confirmed', 0)
      put('shipping_source', null)
    }
  } else if (p.shipping_fee !== undefined) {
    assertYen('送料', p.shipping_fee)
    put('shipping_fee', p.shipping_fee)
    put('is_shipping_confirmed', 1)
    put('shipping_source', 'manual')
  }

  if (sets.length === 0) return

  // 人が手で触った印。appendModelCodes が「一度も更新されていない（created_at と同じ）」販売だけを救済するのに使う。
  // now() は同じトランザクションの中で created_at と同じ値なので、実際の時刻（clock_timestamp）を入れる
  sets.push('updated_at = clock_timestamp()')
  vals.push(saleId)
  await ctx.sql.run(`update sale set ${sets.join(', ')} where id = ?`, ...vals)
}

/**
 * メルカリの取引詳細・販売履歴ページから取れた実額で上書きする
 * （収集が使う。API には出さない）。
 *
 * shipping_fee の扱い：
 *   * null/undefined（詳細ページの取得失敗など）は「未取得」として無視する
 *   * 0 より大きい額は、メルカリ便などで実際に請求された額。人が発送方法を選んで
 *     いても（shipping_source='master'）、メルカリが請求した実額を優先して actual・確定にする
 *   * 0 は「メルカリ便を使っていない（着払い・自己手配の郵送など）」可能性が高く、
 *     実際は送料がかかっているのに 0 円で確定してしまう恐れがある。既に人が発送方法を
 *     選んでいれば（shipping_source='master'、出品時に決めて引き継いだ 'manual' も同じ）その選択を尊重して送料関連の列には一切触らない。
 *     それ以外は shipping_fee=0・shipping_source='actual' で記録しつつ is_shipping_confirmed は
 *     立てない（＝送料未入力として要対応に出す。人が発送方法を選べば updateSale が master にして確定する）
 *
 * sold_at は source='collector' の販売にだけ反映する。手入力の日付は上書きしない。
 * status が未取得（取引中タブで先に追っていない）なら sold_at をそのまま実の日付に直す
 * （一覧の取得日を仮の販売日として保存していたものを、本当の購入完了日に直すため）。
 * status='completed'・completedAt 付きで呼ばれたとき（取引完了を観測した）は、取引中タブで
 * 先に status が付いていた販売でも sold_at を completedAt に動かす（仮置きから本当の完了日へ）。
 *
 * status に 'completed' を渡すと、completed_at が未設定なら completedAt で埋める
 * （既に入っていれば触らない。「最初に観測した日」を刻む他の日付と同じ規則）。
 *
 * title：Yahoo!フリマの売上金管理は商品名が途中で切れる。取引ページで全文が取れたときにここへ渡すと、
 * 切れたタイトルを全文に直す。ただし無条件には書き換えない。
 * 「今の値より長く、かつ今の値がその先頭と一致する（＝同じタイトルの続き）」ときだけ書き換える：
 *   ・人が手でタイトルを直していれば、たいてい先頭が崩れるので上書きしない
 *   ・すでに全文が入っていれば新しい値は同じ長さ以下になるので上書きしない（短い値で長い値を潰さない）
 * source='collector' の販売にだけ効く。書き換えたときは、新しい全文から拾える型番を
 * appendModelCodes で追記する（自動紐付けまで進む）。
 */
export async function applySaleActuals(
  ctx: Ctx,
  id: string,
  actuals: {
    fee?: number | null
    shipping_fee?: number | null
    /** 決済金額の実額。undefined/null なら触らない（Yahoo!フリマの売上金管理向け） */
    price?: number | null
    sold_at?: string
    status?: SaleStatus
    completedAt?: string
    title?: string
  },
): Promise<void> {
  const sets: string[] = []
  const vals: unknown[] = []
  let titleApplied = false

  if (actuals.title !== undefined) {
    const cur = await ctx.sql.get<{ title: string; source: SaleSource }>('select title, source from sale where id = ?', id)
    if (
      cur && cur.source === 'collector'
      && actuals.title.length > cur.title.length && actuals.title.startsWith(cur.title)
    ) {
      sets.push('title = ?')
      vals.push(actuals.title)
      titleApplied = true
    }
  }

  if (actuals.fee !== undefined && actuals.fee !== null) {
    assertYen('手数料', actuals.fee)
    // 0円も実額（Yahoo!フリマのキャンペーン等）。fee_source='actual' にして、以後
    // updateSale の価格変更で率に上書きされないようにする
    sets.push('fee = ?', `fee_source = 'actual'`)
    vals.push(actuals.fee)
  }
  if (actuals.price !== undefined && actuals.price !== null) {
    assertYen('価格', actuals.price)
    sets.push('price = ?')
    vals.push(actuals.price)
  }
  if (actuals.shipping_fee !== undefined && actuals.shipping_fee !== null) {
    assertYen('送料', actuals.shipping_fee)
    if (actuals.shipping_fee > 0) {
      sets.push('shipping_fee = ?', `shipping_source = 'actual'`, 'is_shipping_confirmed = 1')
      vals.push(actuals.shipping_fee)
    } else {
      const cur = await ctx.sql.get<{ shipping_source: string | null }>('select shipping_source from sale where id = ?', id)
      if (cur?.shipping_source !== 'master' && cur?.shipping_source !== 'manual') { // manual＝出品時に決めた発送方法の引き継ぎ
        sets.push('shipping_fee = ?', `shipping_source = 'actual'`, 'is_shipping_confirmed = 0')
        vals.push(0)
      }
    }
  }
  if (actuals.sold_at !== undefined) {
    const soldAt = argDate('計上日', actuals.sold_at)
    if (actuals.status === 'completed' && actuals.completedAt !== undefined) {
      // 取引完了を観測した：source='collector' の販売は sold_at を完了日へ動かす
      // （取引中タブで先に status が付いていた仮置きも、ここで本当の完了日に直す）
      sets.push(`sold_at = case when source = 'collector' then ?::date else sold_at end`)
      vals.push(argDate('完了日', actuals.completedAt))
    } else {
      // status が既に付いている（取引中タブで先に取り込んだ）販売は sold_at を触らない
      sets.push(`sold_at = case when source = 'collector' and status is null then ?::date else sold_at end`)
      vals.push(soldAt)
    }
  }
  if (actuals.status !== undefined) {
    sets.push('status = ?')
    vals.push(argEnum('取引の状態', actuals.status, SALE_STATUS_ORDER))
  }
  if (actuals.completedAt !== undefined) {
    sets.push('completed_at = coalesce(completed_at, ?::date)')
    vals.push(argDate('完了日', actuals.completedAt))
  }
  if (sets.length === 0) return

  // updated_at は触らない（人が手で触った印だけに保つ。冒頭の updated_at の約束を参照）
  vals.push(id)
  await ctx.sql.run(`update sale set ${sets.join(', ')} where id = ?`, ...vals)

  // タイトルが全文に直った：新しい全文から型番を拾えれば追記し、型番が1つに絞れれば
  // 自動紐付けまで進める（appendModelCodes に委譲）
  if (titleApplied) {
    const codes = extractCodes(actuals.title as string)
    if (codes.length > 0) await appendModelCodes(ctx, id, codes)
  }
}

/**
 * メルカリの販売履歴ページ（一覧）から取れた実額・購入完了日で、既知の取引を更新する（収集が使う）。
 * 売却済み一覧（販売履歴）に出た時点で取引は完了しているので、status='completed'・
 * completed_at（初回のみ）も併せて刻む。
 *
 * スキップ判定は「取得元が actual かどうか」ではなく、取得できた各値（fee・shipping_fee・
 * sold_at・status='completed'）と保存済みの値を1つずつ比べて行う。どれか1つでも違えば
 * applySaleActuals まで進む（一度 actual になった後でも、メルカリ側の実額が後から変わった
 * ケースを取りこぼさない）。送料 0 円のとき shipping_source='master'/'manual' の選択を守る
 * 規則は applySaleActuals 側にあるのでここでは変えない。kind・紐付けには触らない。
 *
 * fee が同額でも fee_source がまだ 'actual' でなければ進める（自己修復）。fee の値自体は変えない。
 * 戻り値は実際に applySaleActuals まで進んだ件数。
 */
export async function updateCollectedActuals(
  ctx: Ctx,
  rows: Array<{
    mercariItemId: string
    soldAt: string
    fee?: number | null
    shippingFee?: number | null
  }>,
): Promise<number> {
  let updated = 0
  for (const r of rows) {
    const sale = await ctx.sql.get<{
      id: string; sold_at: string; status: SaleStatus | null; fee: number; fee_source: FeeSource
      shipping_fee: number; source: SaleSource
    }>(
      'select id, sold_at, status, fee, fee_source, shipping_fee, source from sale where channel_item_id = ?',
      r.mercariItemId,
    )
    if (!sale) continue

    const feeChanged = r.fee != null && r.fee !== sale.fee
    const feeSourceStale = r.fee != null && sale.fee_source !== 'actual'
    const shippingChanged = r.shippingFee != null && r.shippingFee !== sale.shipping_fee
    // status に関わらず、source='collector' の販売は完了観測で sold_at が完了日へ動く
    // （applySaleActuals の規則）ので、それだけを見る
    const soldAtChanged = sale.source === 'collector' && sale.sold_at !== r.soldAt
    const statusChanged = sale.status !== 'completed'

    if (!feeChanged && !feeSourceStale && !shippingChanged && !soldAtChanged && !statusChanged) continue

    await applySaleActuals(ctx, sale.id, {
      fee: r.fee, shipping_fee: r.shippingFee, sold_at: r.soldAt,
      status: 'completed', completedAt: r.soldAt,
    })
    updated++
  }
  return updated
}

/**
 * Yahoo!フリマの売上金管理ページから取れた実額・状態で、既知の取引を更新する（収集が使う）。
 *
 * メルカリの販売履歴と違い、Yahoo!フリマの売上金管理には「受取連絡待ち」等、まだ完了していない
 * 取引も出る。だから updateCollectedActuals と違い、status を 'completed' に決め打ちしない。
 * 渡された status をそのまま使う。status='completed' のときだけ completed_at を埋め、sold_at を
 * 完了日へ動かす。status が null/undefined（状態不明）のときは status・sold_at・completed_at に
 * 一切触らない（推測で埋めない）。
 *
 * fee・shippingFee・price の実額判定・fee_source の自己修復、送料0円のとき
 * shipping_source='master'/'manual' を守る規則は applySaleActuals に委譲する。
 * kind・紐付けには触らない。戻り値は実際に applySaleActuals まで進んだ件数。
 *
 * bundleCount：まとめ買いの点数（②の `計n点`）。入れば expected_item_count にだけ刻む
 * （sale_line・在庫には触らない）。null なら触らない。まとめ買いは autoLinkSale が自動確定しない
 * ので、人が n 点選んで揃える。
 *
 * title：切れたタイトルを全文（取引ページ）に直したいときに渡す。ここでの「変わっているか」は単純な
 * 文字列比較で緩く見る。「短い値で長い値を潰さない・人が直した値を上書きしない」という厳密な判定は
 * applySaleActuals 側の役割。
 */
export async function updateYahooActuals(
  ctx: Ctx,
  rows: Array<{
    mercariItemId: string
    soldAt: string
    fee?: number | null
    shippingFee?: number | null
    /** 決済金額の実額。②③の突き合わせで金額が動くことがあれば渡す */
    price?: number | null
    /** まとめ買いの点数（②の `計n点`）。null/undefined なら触らない。入れば expected_item_count に刻む */
    bundleCount?: number | null
    /** ②のtradstatから判定した状態。②に出ていなければ null（推測で埋めない） */
    status?: SaleStatus | null
    /** ②（取引ページ）の全文タイトル。切れたタイトルなら渡さない */
    title?: string
  }>,
): Promise<number> {
  let updated = 0
  for (const r of rows) {
    const sale = await ctx.sql.get<{
      id: string; sold_at: string; status: SaleStatus | null; fee: number; fee_source: FeeSource
      shipping_fee: number; price: number; title: string; source: SaleSource; expected_item_count: number | null
    }>(`
      select id, sold_at, status, fee, fee_source, shipping_fee, price, title, source, expected_item_count
        from sale where channel_item_id = ?
    `, r.mercariItemId)
    if (!sale) continue

    const isCompleted = r.status === 'completed'
    const feeChanged = r.fee != null && r.fee !== sale.fee
    const feeSourceStale = r.fee != null && sale.fee_source !== 'actual'
    const shippingChanged = r.shippingFee != null && r.shippingFee !== sale.shipping_fee
    const priceChanged = r.price != null && r.price !== sale.price
    // 完了を観測したときだけ、source='collector' の販売の sold_at を完了日へ動かす
    const soldAtChanged = sale.source === 'collector' && isCompleted && sale.sold_at !== r.soldAt
    // status が不明（null）のときは状態不一致を理由に進めない（推測で埋めない）
    const statusChanged = r.status != null && sale.status !== r.status
    // 緩い判定でよい（厳密な判定は applySaleActuals 側）
    const titleChanged = r.title != null && r.title !== sale.title
    const bundleCountChanged = r.bundleCount != null && r.bundleCount !== sale.expected_item_count

    if (
      !feeChanged && !feeSourceStale && !shippingChanged && !priceChanged
      && !soldAtChanged && !statusChanged && !titleChanged && !bundleCountChanged
    ) continue

    // 点数だけを刻む（sale_line・在庫には触らない）。すでに紐付いていても点数が足りなければ
    // 揃うまで未紐付け（要対応）に出る（sale_profit.unmatched）
    if (bundleCountChanged) {
      await ctx.sql.run(
        'update sale set expected_item_count = ? where id = ?',
        argInt('まとめ買いの点数', r.bundleCount, { min: 1 }), sale.id,
      )
    }

    await applySaleActuals(ctx, sale.id, {
      fee: r.fee, shipping_fee: r.shippingFee, price: r.price,
      sold_at: isCompleted ? r.soldAt : undefined,
      status: r.status ?? undefined,
      completedAt: isCompleted ? r.soldAt : undefined,
      title: r.title,
    })
    updated++
  }
  return updated
}

/** 販売の商品ID（取り込みでなければ null）。購入日時の取り直し（収集）が使う */
export async function saleMercariItemId(ctx: Ctx, saleId: string): Promise<string | null> {
  const row = await ctx.sql.get<{ channel_item_id: string | null }>(
    'select channel_item_id from sale where id = ?', saleId,
  )
  return row?.channel_item_id ?? null
}

/**
 * 取引画面の「購入日時」を保存する（収集が使う）。purchasedAt は日本時間の素の文字列
 * （`YYYY-MM-DDTHH:mm` か、日付だけの `YYYY-MM-DD`＝その日の 0:00）。取れなかった（null）ときも
 * purchased_at_checked を立てて、以後は再試行しない。sold_at・thumb と同じ理由で updated_at は触らない
 * （appendModelCodes の「人が手で触ったか」判定を壊さないため）。
 *
 * source='collector' の販売で、まだ取引完了を観測していなければ（status が 'completed' でなければ）
 * sold_at の仮置き（初めて見た日）を購入日（日付部分）に直す。完了済みなら sold_at は
 * 既に completed_at を反映済みなので触らない。
 */
export async function setSalePurchasedAt(ctx: Ctx, saleId: string, purchasedAt: string | null): Promise<void> {
  if (purchasedAt === null) {
    await ctx.sql.run('update sale set purchased_at_checked = 1 where id = ?', saleId)
    return
  }
  if (typeof purchasedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?$/.test(purchasedAt)) {
    throw new UserError('購入日時はYYYY-MM-DDTHH:mmの形式で入力してください')
  }
  assertDateText('購入日時', purchasedAt.slice(0, 10))
  // 日本時間の素の文字列を、日本時間として timestamptz に直す
  await ctx.sql.run(
    `update sale set purchased_at = (?::timestamp at time zone 'Asia/Tokyo'), purchased_at_checked = 1 where id = ?`,
    purchasedAt, saleId,
  )

  const sale = await ctx.sql.get<{ source: SaleSource; status: SaleStatus | null }>(
    'select source, status from sale where id = ?', saleId,
  )
  if (sale && sale.source === 'collector' && sale.status !== 'completed') {
    await ctx.sql.run('update sale set sold_at = ?::date where id = ?', purchasedAt.slice(0, 10), saleId)
  }
}

/**
 * 購入日時がまだ取れていない取り込み済み販売（取引画面を一度も開いていないもの）。
 * 収集が予算を切って回す。新しい順。
 */
export async function salesNeedingPurchasedAt(
  ctx: Ctx, limit: number,
): Promise<Array<{ id: string; mercari_item_id: string }>> {
  return ctx.sql.all<{ id: string; mercari_item_id: string }>(`
    select id, channel_item_id as mercari_item_id from sale
     where source = 'collector' and purchased_at is null and purchased_at_checked = 0
       and channel_item_id is not null
     order by sold_at desc, id
     limit ?
  `, limit)
}

/**
 * 販売を削除する。取り込んだ販売（source='collector' かつ商品IDあり）は、
 * 次回の収集で再取り込みしないよう sale_exclusion に記録する（設定 → データ で見て解除できる）。
 * 紐付いていた在庫は sale_line の削除で in_stock に戻る。
 */
export async function deleteSale(ctx: Ctx, id: string): Promise<void> {
  const saleId = argId('販売', id)
  const sale = await ctx.sql.get<{ source: string; channel_item_id: string | null; title: string }>(
    'select source, channel_item_id, title from sale where id = ?', saleId,
  )

  await ctx.sql.run('delete from sale where id = ?', saleId)
  if (sale && sale.source === 'collector' && sale.channel_item_id) {
    await ctx.sql.run(`
      insert into sale_exclusion (channel_item_id, title, excluded_at)
      values (?, ?, now())
      on conflict (household_id, channel_item_id) do update set title = excluded.title, excluded_at = excluded.excluded_at
    `, sale.channel_item_id, sale.title)
  }
}

/** 取り込んだ販売の除外記録（deleteSale が作る）。次回の収集で再取り込みしないために見る */
export async function isMercariItemExcluded(ctx: Ctx, mercariItemId: string): Promise<boolean> {
  const row = await ctx.sql.get('select 1 from sale_exclusion where channel_item_id = ?', mercariItemId)
  return !!row
}

export async function listSaleExclusions(
  ctx: Ctx,
): Promise<Array<{ mercari_item_id: string; title: string; excluded_at: string }>> {
  return ctx.sql.all(`
    select channel_item_id as mercari_item_id, title, excluded_at
      from sale_exclusion order by excluded_at desc, channel_item_id collate "C"
  `)
}

/** 除外を解除する（次回の収集で再取り込みできるようにする） */
export async function removeSaleExclusion(ctx: Ctx, mercariItemId: string): Promise<void> {
  await ctx.sql.run(
    'delete from sale_exclusion where channel_item_id = ?', argText('商品ID', mercariItemId, { max: ITEM_ID_MAX }),
  )
}

// ------------------------------------------------------------
// 一覧（sale_profit ビュー）
// ------------------------------------------------------------

/** sale_profit の生行（タグ・サムネイルURLをつける前）。thumb_path は Storage のパス */
export type SaleProfitRow = Omit<SaleProfit, 'tags' | 'inherited_tags' | 'thumb_url'> & { thumb_path: string | null }

/** 別名は SQL にそのまま埋め込むので、識別子の形だけを通す（画面からの値は絶対に渡さない） */
function sqlAlias(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`不正な別名です: ${alias}`)
  return alias
}

/**
 * sale_profit の読む列。ビューの最後に household_id が付いているので `select *` では読まない。
 * 契約の名前に合わせる：channel_item_id → mercari_item_id、purchased_at は日本時間の素の文字列
 * （`YYYY-MM-DDTHH:mm`。画面が先頭 10 文字を日付として使うので、UTC のままだと日本の 0〜9 時に 1 日ずれる）
 */
export function saleProfitColumns(alias = 'sale_profit'): string {
  const a = sqlAlias(alias)
  return `
    ${a}.id, ${a}.channel, ${a}.channel_item_id as mercari_item_id, ${a}.thumb_path, ${a}.sold_at,
    to_char(${a}.purchased_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI') as purchased_at,
    ${a}.title, ${a}.kind, ${a}.price, ${a}.fee, ${a}.fee_source, ${a}.shipping_fee, ${a}.packaging_cost,
    ${a}.is_shipping_confirmed, ${a}.shipping_method_id, ${a}.shipping_source, ${a}.note, ${a}.model_codes,
    ${a}.source, ${a}.status, ${a}.shipped_at, ${a}.delivered_at, ${a}.completed_at, ${a}.buyer,
    ${a}.cost, ${a}.gross_profit, ${a}.item_count, ${a}.unmatched, ${a}.auto_linked
  `
}

/**
 * listSales / saleTotals 共通の絞り込み。sale_profit ビューに対する WHERE を組み立てる。
 * **絞り込みの値は SQL に埋め込まず、必ず `?`（vals）で渡す**。alias はビューの別名（サブクエリが参照する）
 */
export function buildSaleFilterWhere(
  filter?: SaleFilter | null, aliasName = 'sale_profit',
): { where: string; vals: unknown[] } {
  const alias = sqlAlias(aliasName)
  const clauses: string[] = []
  const vals: unknown[] = []
  const f = filter ? argObject('販売の絞り込み', filter) : {}

  const month = argOptMonth('月', f.month)
  if (month) {
    const { start, end } = monthBounds(month)
    clauses.push(`${alias}.sold_at >= ?::date and ${alias}.sold_at <= ?::date`)
    vals.push(start, end)
  }
  const kind = argOptEnum('区分', f.kind, SALE_KINDS)
  if (kind) { clauses.push(`${alias}.kind = ?`); vals.push(kind) }
  // 未処理＝送料未入力、または（転売なのに）在庫が未紐付け
  if (argOptBool('未処理だけ', f.onlyPending)) {
    clauses.push(`(${alias}.is_shipping_confirmed = 0 or (${alias}.unmatched = 1 and ${alias}.kind = 'resale'))`)
  }
  const tagId = argOptId('タグ', f.tagId)
  if (tagId) {
    // 直接付いたタグ ∪ 派生タグ（紐付いた在庫のタグ・その仕入のタグ・その商品＝型番のタグ）で一致させる
    clauses.push(`(
      exists (
        select 1 from sale_tag st
         where st.household_id = ${alias}.household_id and st.sale_id = ${alias}.id and st.tag_id = ?
      )
      or exists (
        select 1 from sale_line sl
          join inventory_tag it on it.household_id = sl.household_id and it.inventory_item_id = sl.inventory_item_id
         where sl.household_id = ${alias}.household_id and sl.sale_id = ${alias}.id and it.tag_id = ?
      )
      or exists (
        select 1 from sale_line sl
          join inventory_item i on i.household_id = sl.household_id and i.id = sl.inventory_item_id
          join purchase_line pl on pl.household_id = i.household_id and pl.id = i.purchase_line_id
          join purchase_tag pt on pt.household_id = pl.household_id and pt.purchase_id = pl.purchase_id
         where sl.household_id = ${alias}.household_id and sl.sale_id = ${alias}.id and pt.tag_id = ?
      )
      or exists (
        select 1 from sale_line sl
          join inventory_item i on i.household_id = sl.household_id and i.id = sl.inventory_item_id
          join product_tag pt on pt.household_id = i.household_id and pt.model_code = i.model_code
         where sl.household_id = ${alias}.household_id and sl.sale_id = ${alias}.id and pt.tag_id = ?
      )
    )`)
    vals.push(tagId, tagId, tagId, tagId)
  }

  return { where: clauses.length ? 'where ' + clauses.join(' and ') : '', vals }
}

/**
 * sale_profit の生行を SaleProfit（タグ・型番配列・サムネイルURL）に直す。
 * listSales / getItemTimeline / getProduct で共通に使う。
 */
export async function hydrateSaleProfitRows(ctx: Ctx, rows: SaleProfitRow[]): Promise<SaleProfit[]> {
  const ids = rows.map(r => r.id)
  const tagMap = await loadTagsFor(ctx, 'sale_tag', 'sale_id', ids)
  const purchaseMap = await loadPurchaseTagsForSales(ctx, ids)
  const productMap = await loadProductTagsForSales(ctx, ids)
  const inventoryMap = await loadInventoryTagsForSales(ctx, ids)
  return rows.map(r => {
    const { thumb_path, ...rest } = r
    const tags = tagMap.get(r.id) ?? []
    const directIds = new Set(tags.map(t => t.id))
    // 優先順位 purchase > product > inventory で1つにまとめる
    const inherited_tags = mergeInheritedTags(directIds, [
      { from: 'purchase', tags: purchaseMap.get(r.id) ?? [] },
      { from: 'product', tags: productMap.get(r.id) ?? [] },
      { from: 'inventory', tags: inventoryMap.get(r.id) ?? [] },
    ])
    return {
      ...rest,
      model_codes: rest.model_codes ?? [],
      tags,
      inherited_tags,
      thumb_url: mediaUrl(ctx, thumb_path),
    }
  })
}

export async function listSales(ctx: Ctx, filter?: SaleFilter | null): Promise<SaleProfit[]> {
  const { where, vals } = buildSaleFilterWhere(filter, 'sp')
  const rows = await ctx.sql.all<SaleProfitRow>(
    `select ${saleProfitColumns('sp')} from sale_profit sp ${where} order by sp.sold_at desc, sp.title collate "C", sp.id`,
    ...vals,
  )
  return hydrateSaleProfitRows(ctx, rows)
}

/** 絞り込んだ販売の合計（実績だけ。見込みは forecast に別に出す）。0件なら全部0 */
export async function saleTotals(ctx: Ctx, filter?: SaleFilter | null): Promise<SaleTotals> {
  return realizedTotals(await listSales(ctx, filter))
}

/** 販売の一覧の合計（実績と見込みを分けない素の合計ではない。月次などが数字を足すのに使う） */
export function sumSaleTotals(sales: SaleProfit[]): {
  sales_count: number; revenue: number; total_fee: number; total_shipping: number
  total_packaging: number; total_cost: number; gross_profit: number
} {
  return sales.reduce((acc, s) => ({
    sales_count: acc.sales_count + 1,
    revenue: acc.revenue + s.price,
    total_fee: acc.total_fee + s.fee,
    total_shipping: acc.total_shipping + s.shipping_fee,
    total_packaging: acc.total_packaging + s.packaging_cost,
    total_cost: acc.total_cost + s.cost,
    gross_profit: acc.gross_profit + s.gross_profit,
  }), {
    sales_count: 0, revenue: 0, total_fee: 0, total_shipping: 0,
    total_packaging: 0, total_cost: 0, gross_profit: 0,
  })
}

// ------------------------------------------------------------
// 自動紐付け（紐付けを自動確定しない。例外は冒頭の 3 つだけ）
// ------------------------------------------------------------

/**
 * Yahoo!フリマの「まとめ買い」（複数の出品を 1 回の取引で買われたもの）か。
 * タイトルは `＜まとめ買い＞ 商品名 計2点` で、出るのは中の 1 つぶんの商品名だけ（残りが何かは
 * 分からない）。型番が 1 つ取れても 1 点しか引き当てられず、2 点以上の取引を「紐付け済み」に見せてしまう
 * （静かに間違う）。だから自動確定の対象にしない。人が点数ぶんの在庫を選ぶ（点数は expected_item_count に入っている）。
 */
export function isYahooBundleSale(sale: { channel: SalesChannel; title: string }): boolean {
  return sale.channel === 'yahoo' && sale.title.trimStart().startsWith('＜まとめ買い＞')
}

/**
 * 優先順で1回だけ自動確定を試みる：
 *   1. タイトルに在庫コードがあれば、見つかった分だけ全部（1つでも見つからない／販売済みなら
 *      その分は候補止まり。見つかった分だけ確定し、expected_item_count との差分で unmatched を残す）
 *   2. 在庫コードが無ければ型番：抽出した型番が1つで在庫と完全一致するときだけ、
 *      FIFOで個数表記（×2 等。無ければ1）の分だけ充てる（足りなければある分だけ）
 *   3. 型番が2つ以上なら候補止まり（何もしない）
 * 条件を満たさない、またはsale_lineが既にあれば何もしない。戻り値は1点でも確定できたか。
 * まとめ買い（isYahooBundleSale）は常に候補止まり（expected_item_count も触らない）。
 */
export async function autoLinkSale(ctx: Ctx, saleId: string): Promise<boolean> {
  const sale = await ctx.sql.get<{ channel: SalesChannel; kind: SaleKind; title: string; model_codes: string[] }>(
    'select channel, kind, title, model_codes from sale where id = ?', saleId,
  )
  if (!sale || sale.kind !== 'resale') return false
  if (isYahooBundleSale(sale)) return false

  const already = await ctx.sql.get<{ c: number }>('select count(*) as c from sale_line where sale_id = ?', saleId)
  if (already!.c > 0) return false

  const itemCodes = extractItemCodes(sale.title)
  if (itemCodes.length > 0) {
    await ctx.sql.run('update sale set expected_item_count = ? where id = ?', itemCodes.length, saleId)
    const ids = await findInventoryIdsByItemCodes(ctx, itemCodes)
    if (ids.length === 0) return false
    await linkInventory(ctx, saleId, ids, 'auto')
    return true
  }

  const codes = sale.model_codes ?? []
  if (codes.length !== 1) return false

  const qty = extractCodeQuantities(sale.title).find(q => q.code === codes[0])?.qty ?? 1
  await ctx.sql.run('update sale set expected_item_count = ? where id = ?', qty, saleId)
  const ids = await findInventoryIdsByModelCodeFifo(ctx, codes[0], qty)
  if (ids.length === 0) return false

  await linkInventory(ctx, saleId, ids, 'auto')
  return true
}

/**
 * その販売が自動で紐付かない理由のうち、在庫はあるのに出品に取ってあるせいで外れているものを返す。
 * 判定条件は findInventoryIdsByModelCodeFifo の除外条件（RESERVED_BY_ACTIVE_LISTING）の裏返し。
 * autoLinkSale と同じ前提（未紐付けの転売・型番が1つ）でないときは空配列（＝この理由ではない）。
 * 読み取り専用。何も書き換えない。
 */
export async function getAutoLinkBlockers(ctx: Ctx, saleId: string): Promise<AutoLinkBlocker[]> {
  const id = argId('販売', saleId)
  const sale = await ctx.sql.get<{ channel: SalesChannel; kind: SaleKind; title: string; model_codes: string[] }>(
    'select channel, kind, title, model_codes from sale where id = ?', id,
  )
  if (!sale || sale.kind !== 'resale') return []
  if (isYahooBundleSale(sale)) return []

  const already = await ctx.sql.get<{ c: number }>('select count(*) as c from sale_line where sale_id = ?', id)
  if (already!.c > 0) return []

  const codes = sale.model_codes ?? []
  if (codes.length !== 1) return []

  // 条件は RESERVED_BY_ACTIVE_LISTING の裏返し（同じ断片を共有する）。結合した出品の状態で絞るので、断片は使わず同じ形で書く
  return ctx.sql.all<AutoLinkBlocker>(`
    select i.id as inventory_item_id, i.item_code as item_code, i.model_code as model_code,
           coalesce((select pn.name from product_name pn where pn.household_id = i.household_id and pn.model_code = i.model_code), i.name) as name,
           i.landed_cost as landed_cost,
           l.channel_item_id as listing_id, l.channel as listing_channel,
           l.status as listing_status, l.title as listing_title
      from inventory_item i
      join listing_line ll on ll.household_id = i.household_id and ll.inventory_item_id = i.id
      join listing l on l.household_id = ll.household_id and l.id = ll.listing_id
     where i.model_code = ? and i.status = 'in_stock' and l.status in ('active', 'suspended')
     order by i.acquired_at, i.created_at, length(i.item_code), i.item_code collate "C"
  `, codes[0])
}

/**
 * 未紐付けの転売すべてに autoLinkSale を回す。戻り値は確定した件数。
 *
 * saleIds を渡すと、その id に絞る（画面の絞り込みに合わせる用）。**省略時は従来どおり全件**。
 * 空配列を渡したときは「対象0件」として何もしない（全件と取り違えない）。
 * SQL 側は絞り込まず、常に unmatched な全件を読んでから JS 側で id を突き合わせる
 * （対象外の id は黙って無視できる）。先入先出が古い販売から在庫を使うよう、古い販売から順に回す。
 */
export async function autoLinkPending(ctx: Ctx, saleIds?: string[]): Promise<number> {
  const allow = saleIds === undefined ? undefined : new Set(argIds('販売', saleIds, { max: 10_000 }))
  const pending = await ctx.sql.all<{ id: string }>(
    `select id from sale_profit where unmatched = 1 and kind = 'resale' order by sold_at, id`,
  )
  const targets = allow === undefined ? pending : pending.filter(p => allow.has(p.id))

  let count = 0
  for (const p of targets) {
    if (await autoLinkSale(ctx, p.id)) count++
  }
  return count
}

/**
 * 説明文から後追いで見つかった型番を model_codes に追記する（収集が使う）。
 * 既存の配列と結合し重複除去（出現順は既存が先）。変化がなければ false。
 *
 * 追記後、型番が1つに絞れたら autoLinkSale を試みる。また、タイトルに型番が無く
 * 説明文にだけあったせいで私物扱いになっていた販売は resale に戻す（keyword 判定を
 * 使っていない場合のみ）。ただし人が手で personal にした販売（一度でも更新された
 * 販売）は戻さない。
 */
export async function appendModelCodes(ctx: Ctx, saleId: string, codes: string[]): Promise<boolean> {
  const sale = await ctx.sql.get<{
    channel: SalesChannel; kind: SaleKind; source: string; model_codes: string[]
    created_at: string; updated_at: string
  }>('select channel, kind, source, model_codes, created_at, updated_at from sale where id = ?', saleId)
  if (!sale) return false

  const existing = sale.model_codes ?? []
  const seen = new Set(existing)
  const merged = [...existing]
  for (const c of codes) {
    if (!seen.has(c)) {
      seen.add(c)
      merged.push(c)
    }
  }
  if (merged.length === existing.length) return false

  // その販売の出品先（channel）に応じたキーワードで判定する（mercari_keyword 固定にしない）
  const keywords = await keywordsFor(ctx, sale.channel)
  // source='collector' かつ一度も更新されていない（=人が手で触っていない）ときだけ救済する
  const untouched = sale.source === 'collector' && sale.updated_at === sale.created_at
  const kind: SaleKind =
    sale.kind === 'personal' && keywords.length === 0 && merged.length > 0 && untouched
      ? 'resale'
      : sale.kind

  await ctx.sql.run(
    `update sale set model_codes = ?, kind = ? where id = ?`, merged, kind, saleId,
  )

  await autoLinkSale(ctx, saleId)
  return true
}

// ------------------------------------------------------------
// サムネイル（収集が使う）
// ------------------------------------------------------------

/** 既存の商品IDを返す（差分取得用） */
export async function existingMercariIds(ctx: Ctx, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await ctx.sql.all<{ channel_item_id: string }>(
    'select channel_item_id from sale where channel_item_id = any(?::text[])', ids,
  )
  return new Set(rows.map(r => r.channel_item_id))
}

/**
 * 渡した商品IDのうち、まだサムネイルを保存していない（thumb_path が NULL）
 * 既存の販売を返す。元からあった販売（新規取り込みではない）にも、今回の一覧に
 * 出ている間にサムネイルを追いつかせるために使う。
 */
export async function salesWithoutThumb(
  ctx: Ctx, mercariItemIds: string[],
): Promise<Array<{ id: string; mercariItemId: string }>> {
  if (mercariItemIds.length === 0) return []
  return ctx.sql.all<{ id: string; mercariItemId: string }>(`
    select id, channel_item_id as "mercariItemId" from sale
     where channel_item_id = any(?::text[]) and thumb_path is null
  `, mercariItemIds)
}

/**
 * サムネイルを差し替えるべき対象を返す。scraped は今回の一覧取得で分かった
 * （mercariItemId, 画像URL）の組。判定規則：
 *   (a) thumb_path が無い → 対象（新規保存）
 *   (b) thumb_path はあるが thumb_src が無い（旧データ）→ 対象にせず、今の src を記録するだけ
 *   (c) thumb_src はあるが正規化した URL と違う → 対象（差し替え）
 * (a) を先、(c) を後の順で返す（予算は呼び出し側の収集が切る）。画像URLが無いものは対象外。
 */
export async function salesNeedingThumb(
  ctx: Ctx, scraped: Array<{ mercariItemId: string; thumbUrl: string | null }>,
): Promise<Array<{ id: string; mercariItemId: string; thumbUrl: string }>> {
  const withUrl = scraped.filter((r): r is { mercariItemId: string; thumbUrl: string } => !!r.thumbUrl)
  if (withUrl.length === 0) return []

  const rows = await ctx.sql.all<{ id: string; mercariItemId: string; thumbPath: string | null; thumbSrc: string | null }>(`
    select id, channel_item_id as "mercariItemId", thumb_path as "thumbPath", thumb_src as "thumbSrc"
      from sale where channel_item_id = any(?::text[])
  `, withUrl.map(r => r.mercariItemId))
  const byItemId = new Map(rows.map(r => [r.mercariItemId, r]))

  const toFetch: Array<{ id: string; mercariItemId: string; thumbUrl: string }> = []
  const toReplace: Array<{ id: string; mercariItemId: string; thumbUrl: string }> = []
  for (const r of withUrl) {
    const row = byItemId.get(r.mercariItemId)
    if (!row) continue
    const normalized = normalizeSrc(r.thumbUrl)
    if (row.thumbPath === null) {
      toFetch.push({ id: row.id, mercariItemId: r.mercariItemId, thumbUrl: r.thumbUrl })
    } else if (row.thumbSrc === null) {
      await ctx.sql.run('update sale set thumb_src = ? where id = ?', normalized, row.id)
    } else if (row.thumbSrc !== normalized) {
      toReplace.push({ id: row.id, mercariItemId: r.mercariItemId, thumbUrl: r.thumbUrl })
    }
  }
  return [...toFetch, ...toReplace]
}

/** listing.ts の normalizeThumbSrc と同じ（前後の空白とフラグメントだけ落とす。クエリは落とさない）。循環を避けて小さく持つ */
function normalizeSrc(url: string): string {
  return url.trim().split('#')[0]
}

/**
 * サムネイルのパスを保存する（収集が、画像取得に成功したときに呼ぶ）。
 * 生成後の landed_cost と違い、サムネイルは後から書き込んでも過去の利益には影響しないので
 * updated_at は触らない（appendModelCodes の「人が手で触ったか」判定を壊さないため）。
 * 対になる listing（商品IDが同じ）があれば、そちらにも同じ画像を書く
 * （売れる前後で持ち主が変わるだけで、同じ画像を共有しているため）。
 */
export async function setSaleThumb(ctx: Ctx, saleId: string, path: string, src: string | null = null): Promise<void> {
  const row = await ctx.sql.get<{ channel_item_id: string | null }>(
    'select channel_item_id from sale where id = ?', saleId,
  )
  await ctx.sql.run('update sale set thumb_path = ?, thumb_src = ? where id = ?', path, src, saleId)
  if (row?.channel_item_id) {
    await ctx.sql.run('update listing set thumb_path = ?, thumb_src = ? where channel_item_id = ?', path, src, row.channel_item_id)
  }
}

// ------------------------------------------------------------
// 取り込み（収集が使う。API には出さない）
// ------------------------------------------------------------

/**
 * 収集した販売を入れる。戻り値は入れた販売の id と商品ID。
 * 空なら「型番が抜けるか」で転売/私物を判定。空でなければキーワード（どれか1つでも部分一致・大小無視）で判定。
 * キーワードは出品先（channel）ごとに独立（mercari_keyword / yahoo_keyword）。
 * 出品への引き当てがあれば、そのままそれを引き継ぐ（人の決定が最優先）。無ければ型番の完全一致でFIFO自動確定する。
 */
export async function insertCollected(
  ctx: Ctx,
  rows: Array<{
    mercariItemId: string
    title: string
    price: number
    soldAt: string
    description?: string
    /** 販売手数料の実額。undefined/null なら従来どおり料率で計算 */
    fee?: number | null
    /**
     * 送料の実額。undefined/null なら未確定のまま。0 はメルカリ便を使っていない
     * （着払い・自己手配など）可能性が高く、実額として shipping_fee=0・shipping_source='actual'
     * は記録するが is_shipping_confirmed は立てない（送料未入力として要対応に出す）
     */
    shippingFee?: number | null
    /**
     * まとめ買いの点数（Yahoo!フリマ）。入れば expected_item_count に刻む（人が n 点選べば
     * 紐付けが揃う）。まとめ買いそのものは autoLinkSale が自動確定しない。null/undefined なら触らない
     */
    bundleCount?: number | null
    /** 他費用。列は増やさない。raw に残すだけ */
    otherCost?: number | null
    /**
     * メルカリの取引の進み具合。取引中タブから来た行は waiting_payment 等、
     * 販売履歴（売却済み）から来た行は 'completed'。undefined/null なら未取得のまま
     */
    status?: SaleStatus | null
  }>,
  /** 出品先（省略時 'mercari'）。手数料率（feeRateBpFor）・sale.channel に効く */
  channel: SalesChannel = 'mercari',
): Promise<Array<{ id: string; mercariItemId: string }>> {
  const ch = argEnum('出品先', channel, CHANNELS)
  const list = argArray('販売の一覧', rows)
  const rateBp = await feeRateBpFor(ctx, ch)
  const keywords = await keywordsFor(ctx, ch)

  const inserted: Array<{ id: string; mercariItemId: string }> = []
  for (const raw of list) {
    const r = argObject('販売', raw) as unknown as (typeof rows)[number]
    const itemId = argText('商品ID', r.mercariItemId, { max: ITEM_ID_MAX })
    const title = argText('商品名', r.title, { max: TITLE_MAX })
    const soldAt = argDate('販売日', r.soldAt)
    assertYen('価格', r.price)

    const text = title + (r.description ? ' ' + r.description : '')
    const codes = extractCodes(text)
    const kind: SaleKind = keywords.length > 0
      ? (matchesAnyKeyword(text, keywords) ? 'resale' : 'personal')
      : (codes.length > 0 ? 'resale' : 'personal')

    // hasFee は typeof で判定する。0 も実額（Yahoo!フリマのキャンペーン等）なので
    // 「値が渡っているか」と「0円か」を混同しない
    const hasFee = typeof r.fee === 'number'
    if (hasFee) assertYen('手数料', r.fee)
    const fee = hasFee ? (r.fee as number) : calcFee(r.price, rateBp)
    const feeSource: FeeSource = hasFee ? 'actual' : 'rate'

    // shippingFee は実額として記録するが、0 はメルカリ便を使っていない可能性が高いので
    // 確定扱いにしない（送料未入力として要対応に出す）。undefined/null は従来どおり未確定
    const hasShippingFee = typeof r.shippingFee === 'number'
    if (hasShippingFee) assertYen('送料', r.shippingFee)
    const shippingFee = hasShippingFee ? (r.shippingFee as number) : 0
    const shippingSource = hasShippingFee ? 'actual' : null
    const confirmed = hasShippingFee && shippingFee > 0 ? 1 : 0

    const status = argOptEnum('取引の状態', r.status, SALE_STATUS_ORDER) ?? null
    const statusDates = initialSaleStatusDates(status, soldAt)

    const row = await ctx.sql.get<{ id: string }>(`
      insert into sale
        (channel, channel_item_id, title, sold_at, price, kind, fee_rate_bp, fee, fee_source, source, raw,
         is_shipping_confirmed, model_codes, shipping_fee, shipping_source, status, shipped_at, delivered_at, completed_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'collector', ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?)
      returning id
    `,
      ch, itemId, title, soldAt, r.price, kind, rateBp, fee, feeSource, JSON.stringify(r),
      confirmed, codes, shippingFee, shippingSource, status,
      statusDates.shipped_at, statusDates.delivered_at, statusDates.completed_at,
    )
    const id = row!.id
    inserted.push({ id, mercariItemId: itemId })

    if (typeof r.bundleCount === 'number') {
      await ctx.sql.run('update sale set expected_item_count = ? where id = ?', argInt('まとめ買いの点数', r.bundleCount, { min: 1 }), id)
    }

    // 出品への引き当てがあれば、そのままそれを引き継ぐ（人の決定が最優先）。
    // 無ければ今までどおり型番の完全一致でFIFO自動確定する
    if (await takeOverListing(ctx, id, itemId)) {
      // 人が出品に在庫を引き当てていた＝転売の意思。キーワード不一致・型番なしの
      // タイトルでも kind は 'resale' にする
      if (kind !== 'resale') {
        await ctx.sql.run(`update sale set kind = 'resale' where id = ?`, id)
      }
    } else {
      await autoLinkSale(ctx, id)
    }
  }
  return inserted
}

/** 前回成功（ok / empty）からの経過時間（時間単位）。未実行なら Infinity */
export async function hoursSinceLastOk(ctx: Ctx): Promise<number> {
  const r = await ctx.sql.get<{ started_at: string }>(
    `select started_at from collector_run where status in ('ok', 'empty') order by started_at desc limit 1`,
  )
  if (!r) return Infinity
  return (Date.now() - new Date(r.started_at).getTime()) / 3_600_000
}

// ------------------------------------------------------------
// 紐付いた在庫・粗利の見積もり・タグ
// ------------------------------------------------------------

/** その販売に紐付いている在庫（解除・付け替え用） */
export async function listSaleLines(ctx: Ctx, saleId: string): Promise<InventoryItem[]> {
  const id = argId('販売', saleId)
  const items = await ctx.sql.all<InventoryRow>(`
    select ${inventoryViewColumns('iv')}
      from inventory_view iv
      join sale_line sl on sl.household_id = iv.household_id and sl.inventory_item_id = iv.id
     where sl.sale_id = ?
     order by iv.name collate "C", iv.item_code collate "C"
  `, id)
  return attachInventoryTags(ctx, items)
}

/**
 * 粗利の見積もり（AllocateDrawer が使う。画面で再計算しないための共通計算）。
 * 手数料は channel（省略時 mercari）の現在の率で floor。input.fee に実額（0 も実額）が
 * 渡っていれば率は使わずそのまま返す（Yahoo!フリマは率で計算できないため）。
 * 送料は発送方法の料金（無効化・削除済み＝is_active=0でも引く。shipping_method_id が
 * 無ければ 0）、原価は渡した在庫の landed_cost の合計。既存の販売・手数料率は変えない（見るだけ）。
 */
export async function estimateSaleProfit(ctx: Ctx, input: {
  price: number
  shipping_method_id: string | null
  packaging_cost?: number
  inventory_item_ids: string[]
  channel?: SalesChannel
  fee?: number | null
}): Promise<{ fee: number; shipping_fee: number; packaging_cost: number; cost: number; gross_profit: number }> {
  const i = argObject('粗利の見積もり', input)
  const price = argYen('価格', i.price)
  const methodId = argNullableId('発送方法', i.shipping_method_id) ?? null
  const packaging_cost = i.packaging_cost === undefined || i.packaging_cost === null ? 0 : argYen('梱包材費', i.packaging_cost)
  const itemIds = [...new Set(argIds('在庫', i.inventory_item_ids))]
  const channel = argOptEnum('出品先', i.channel, CHANNELS) ?? 'mercari'
  const actualFee = argNullableYen('手数料', i.fee)

  const rateBp = await feeRateBpFor(ctx, channel)
  const fee = typeof actualFee === 'number' ? actualFee : calcFee(price, rateBp)

  let shipping_fee = 0
  if (methodId) {
    const m = await ctx.sql.get<{ fee: number }>('select fee from shipping_method where id = ?', methodId)
    shipping_fee = m?.fee ?? 0
  }

  let cost = 0
  if (itemIds.length > 0) {
    const row = await ctx.sql.get<{ c: number }>(
      'select coalesce(sum(landed_cost), 0)::bigint as c from inventory_item where id = any(?::uuid[])', itemIds,
    )
    cost = row!.c
  }

  const gross_profit = price - fee - shipping_fee - packaging_cost - cost
  return { fee, shipping_fee, packaging_cost, cost, gross_profit }
}

/** 販売のタグを丸ごと置き換える（空配列で全部外す）。派生分は対象外 */
export async function setSaleTags(ctx: Ctx, saleId: string, tagIds: string[]): Promise<void> {
  const id = argId('販売', saleId)
  const unique = [...new Set(argIds('タグ', tagIds))]
  const sale = await ctx.sql.get<{ id: string }>('select id from sale where id = ?', id)
  if (!sale) throw new UserError('販売が見つかりません', 'not_found')
  await assertTagsExist(ctx, unique)

  await ctx.sql.run('delete from sale_tag where sale_id = ?', id)
  for (const tagId of unique) {
    await ctx.sql.run('insert into sale_tag (sale_id, tag_id) values (?, ?)', id, tagId)
  }
}

// ------------------------------------------------------------
// 横断検索
// ------------------------------------------------------------

/** 優先はこの順、複数なら先頭：送料未入力 → 未紐付け（転売のみ） → 私物 → 完了 */
export function saleStatusLabel(s: Pick<SaleProfit, 'is_shipping_confirmed' | 'unmatched' | 'kind'>): string {
  if (s.is_shipping_confirmed === 0) return '送料未入力'
  if (s.unmatched === 1 && s.kind === 'resale') return '未紐付け'
  if (s.kind === 'personal') return '私物'
  return '完了'
}

export async function searchSaleHits(ctx: Ctx, terms: string[], perKind: number): Promise<SearchHit[]> {
  const sales = await listSales(ctx)

  const hits: SearchHit[] = sales
    .filter(s => matchesQuery([
      s.title, s.note, s.buyer, ...s.model_codes,
      ...s.tags.map(t => t.name), ...s.inherited_tags.map(t => t.name),
    ], terms))
    .map(s => ({
      kind: 'sale' as const,
      id: s.id,
      title: s.title,
      model_code: s.model_codes[0] ?? null,
      status_label: saleStatusLabel(s),
      amount: s.price,
      date: s.sold_at,
      thumb_url: s.thumb_url,
    }))

  return sortAndSlice(hits, perKind)
}

// ------------------------------------------------------------
// API として登録する（引数は信用しない。型が違えば UserError）。
// 収集が使う関数（insertCollected・updateCollectedActuals・updateYahooActuals・updateSaleStatus・
// appendModelCodes・setSalePurchasedAt・setSaleThumb ほか）は export するだけで登録しない
// ------------------------------------------------------------

registerHandler('listSales', (ctx, filter) => listSales(ctx, filter ?? undefined))
registerHandler('saleTotals', (ctx, filter) => saleTotals(ctx, filter ?? undefined))
registerHandler('createSale', (ctx, input) => createSale(ctx, input))
registerHandler('updateSale', (ctx, id, patch) => updateSale(ctx, id, patch))
registerHandler('deleteSale', (ctx, id) => deleteSale(ctx, id))
// 画面は「全件」のとき省略する（HTTP では null で届く）。空配列は「対象0件」で、省略（全件）とは別
registerHandler('autoLinkPending', (ctx, saleIds) =>
  autoLinkPending(ctx, saleIds === undefined || saleIds === null ? undefined : argIds('販売', saleIds, { max: 10_000 })))
registerHandler('getAutoLinkBlockers', (ctx, saleId) => getAutoLinkBlockers(ctx, saleId))
registerHandler('listSaleLines', (ctx, saleId) => listSaleLines(ctx, saleId))
registerHandler('estimateSaleProfit', (ctx, input) => estimateSaleProfit(ctx, input))
registerHandler('listSaleExclusions', (ctx) => listSaleExclusions(ctx))
registerHandler('removeSaleExclusion', (ctx, mercariItemId) => removeSaleExclusion(ctx, mercariItemId))
registerHandler('setSaleTags', (ctx, saleId, tagIds) => setSaleTags(ctx, saleId, tagIds))
