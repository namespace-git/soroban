import type { Ctx } from '../context'
import { UserError } from '../errors'
import { registerHandler, registerWebHandler } from '../rpc'
import { assertUploadPath, isOwnPath, removeAfterCommit, requireStorageConfig, storageClient } from '../storage'
import type {
  InventoryItem, ItemTimeline, LinkSource, ProductDetail, ProductMonthPoint, ProductSummary, PurchaseSummary,
  SaleProfit, SalesChannel, SaleSource, SaleStatus, Tag, TimelineEvent, VariantSummary,
} from '../../src/shared/types'
import { CHANNEL_LABEL } from '../../src/shared/types'
import {
  argBool, argId, argIds, argNullableText, argOptEnum, argText, assertTagsExist, isRealized, loadTagsFor, mediaUrl,
  thisMonthJst, yenText,
} from './_shared'
import {
  attachInventoryTags, inventoryViewColumns, productImageFiles, type InventoryRow,
} from './derive'
import { formatPurchasedAt, getPurchaseSummary } from './purchase'
import { hydrateSaleProfitRows, saleProfitColumns, type SaleProfitRow } from './sale'

// ============================================================
// 商品（型番）・商品の画像・在庫の履歴（timeline）
//
// src/main/db.ts の商品（型番）ページ・在庫の履歴の移植。
// 利益はビュー（variant_summary / sale_line_share / sale_profit）から読む。ここで利益を再集計しない
// （商品ページの月別は、ビューが整数で按分した 1 点あたりの売上・粗利を月に積むだけ）。
// 実績と見込みは isRealized（取引完了＋状態のない手入力＝実績）で分ける。
//
// 日付：サーバー（Workers）は UTC。「今月」は thisMonthJst()。
// ============================================================

const MODEL_CODE_MAX = 200
const PRODUCT_NAME_MAX = 500
const PRODUCT_NOTE_MAX = 5000

type VariantSort = 'total_profit' | 'avg_profit' | 'sold'
type ProductSummarySort = 'total_profit' | 'avg_profit' | 'sold' | 'in_stock' | 'last_purchased_at'

const VARIANT_SORTS: readonly VariantSort[] = ['total_profit', 'avg_profit', 'sold']
const PRODUCT_SORTS: readonly ProductSummarySort[] = ['total_profit', 'avg_profit', 'sold', 'in_stock', 'last_purchased_at']

/** 型番（空・空白だけは断る。在庫に無い型番でも保存してよい。入力ミスは画面側で防ぐ） */
function argModelCode(modelCode: unknown): string {
  const code = argText('型番', modelCode, { max: MODEL_CODE_MAX })
  if (!code.trim()) throw new UserError('型番を指定してください')
  return code
}

// ------------------------------------------------------------
// 型番ごとの実績（variant_summary）
// ------------------------------------------------------------

/**
 * variant_summary の読む列。ビューの最後に household_id が付いているので `select *` では読まない
 * （alias を渡すと `vs.model_code, …` の形で返す）
 */
function variantSummaryColumns(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`不正な別名です: ${alias}`)
  return [
    'model_code', 'series_code', 'material', 'name', 'custom_name', 'note', 'purchased', 'sold', 'in_stock',
    'stock_value', 'avg_price', 'avg_profit', 'total_profit', 'forecast_profit',
  ].map(c => `${alias}.${c}`).join(', ')
}

export async function listVariantSummary(ctx: Ctx, sort: VariantSort = 'total_profit'): Promise<VariantSummary[]> {
  const s = argOptEnum('並び順', sort, VARIANT_SORTS) ?? 'total_profit'
  // 値は SQL に埋め込まず列名の許可リストで選ぶ。NULL は最後（SQLite の DESC と同じ）。同順位は型番順で毎回同じ並びにする
  const col: Record<VariantSort, string> = { total_profit: 'total_profit', avg_profit: 'avg_profit', sold: 'sold' }
  return ctx.sql.all<VariantSummary>(
    `select ${variantSummaryColumns('vs')} from variant_summary vs
      order by vs.${col[s]} desc nulls last, vs.model_code collate "C"`,
  )
}

// ------------------------------------------------------------
// 商品画像（人がセットしたもの）
//
// 行の読み書き（getProductImage / upsertProductImage / deleteProductImage）と、画像のアップロードの口
// （setProductImagePath / setProductImageAuto）。
// 優先順位（①人がセット ＞ ②仕入先 ＞ ③最新の出品 ＞ ④最新の販売）は derive.ts の productImageFiles。
//
// 人がセットした画像は公開バケット media の `<世帯>/product/<uuid>.<ext>`（画面が prepareUpload でもらった置き場所へ直接上げる）。
// 「自動を固定する」は、今の自動画像（仕入先・出品・販売の画像）を**コピーせず同じパスを指す**。
// そのパスは `<世帯>/product/` の下ではない（別の種類のフォルダ）ので、あとで外しても元の画像は消えない。
// Storage のファイルを消すのは**コミットの後**（ctx.afterCommit）で、`<世帯>/product/` の下のものだけ
// ------------------------------------------------------------

/** 型番が人がセットした商品画像（product_image）。Storage のパス。無ければ null */
export async function getProductImage(ctx: Ctx, modelCode: string): Promise<{ path: string } | null> {
  const code = argModelCode(modelCode)
  const row = await ctx.sql.get<{ path: string }>('select path from product_image where model_code = ?', code)
  return row ?? null
}

/** 商品画像を保存する（置き換え）。Storage への保存・旧ファイルの削除は呼ぶ側の仕事 */
export async function upsertProductImage(ctx: Ctx, modelCode: string, path: string): Promise<void> {
  const code = argModelCode(modelCode)
  const p = argText('画像のパス', path, { max: 1000 })
  if (!p.trim()) throw new UserError('画像のパスを指定してください')
  await ctx.sql.run(
    `insert into product_image (model_code, path, updated_at) values (?, ?, now())
     on conflict (household_id, model_code) do update set path = excluded.path, updated_at = excluded.updated_at`,
    code, p,
  )
}

export async function deleteProductImage(ctx: Ctx, modelCode: string): Promise<void> {
  const code = argModelCode(modelCode)
  await ctx.sql.run('delete from product_image where model_code = ?', code)
}

/**
 * 外した・置き換えた前の画像を、コミットの後に Storage から消す。
 * `<世帯>/product/` の下のものだけ（固定した自動画像は別のフォルダなので消えない）。
 * まだ別の型番が同じパスを指していれば消さない（行を書き換えた後に呼ぶ）
 */
async function removeProductFileAfterCommit(ctx: Ctx, path: string | null | undefined): Promise<void> {
  if (!isOwnPath(ctx, 'product', path)) return
  const stillUsed = await ctx.sql.get('select model_code from product_image where path = ?', path)
  if (!stillUsed) removeAfterCommit(ctx, 'media', [path])
}

/**
 * 上げた画像を商品（型番）の画像にする（人がセットした画像。取り込みで上書きしない）。常に true。
 * 前の人の画像（`<世帯>/product/` の下）は、コミットの後に Storage から消す。
 * 署名の確認でファイルが本当に上がっているかを確かめてから結ぶ（無ければ結ばない）
 */
export async function setProductImagePath(ctx: Ctx, modelCode: string, path: string): Promise<boolean> {
  const code = argModelCode(modelCode)
  const imagePath = assertUploadPath(ctx, 'product', path)
  const cfg = requireStorageConfig(ctx)
  const prev = await getProductImage(ctx, code)
  if (prev?.path === imagePath) return true

  const used = await ctx.sql.get('select model_code from product_image where path = ? and model_code <> ?', imagePath, code)
  if (used) throw new UserError('この画像はすでに別の商品に使われています', 'conflict')

  try {
    await storageClient(cfg, ctx.fetch).signUrl('media', imagePath, 60)
  } catch (e) {
    if (e instanceof UserError && e.code === 'not_found') {
      throw new UserError('アップロードした画像が見つかりません。もう一度アップロードしてください', 'not_found')
    }
    throw e
  }
  await upsertProductImage(ctx, code, imagePath)
  await removeProductFileAfterCommit(ctx, prev?.path)
  return true
}

/**
 * auto=true：人がセットした画像を外して自動（仕入先・出品・販売の最新画像）に戻す。前の画像は、`<世帯>/product/` の下なら
 * コミットの後に Storage から消す。
 * auto=false：今の自動画像を**同じパスを指す人の画像として固定する**（コピーしない。以後、出品・販売の画像が変わっても追従しない）。
 * 自動画像が無い・すでに人の画像なら何もしない。
 */
export async function setProductImageAuto(ctx: Ctx, modelCode: string, auto: boolean): Promise<void> {
  const code = argModelCode(modelCode)
  const toAuto = argBool('自動に戻すか', auto)
  if (toAuto) {
    const prev = await getProductImage(ctx, code)
    if (!prev) return
    await deleteProductImage(ctx, code)
    await removeProductFileAfterCommit(ctx, prev.path)
    return
  }
  const image = (await productImageFiles(ctx, [code])).get(code)
  if (!image || image.manual) return
  await upsertProductImage(ctx, code, image.path)
}

// ------------------------------------------------------------
// 商品（型番）ページ
// ------------------------------------------------------------

type ProductSummaryRow = VariantSummary & {
  purchase_total: number
  avg_cost: number | null
  last_purchased_at: string | null
  last_sold_at: string | null
}

/**
 * variant_summary に仕入額・最新日を足したもの（画像は productImageFiles で別途付ける）。
 * purchase_total / avg_cost は split 親を除いた在庫（= variant_summary の purchased と同じ母集団）で計算する。
 * modelCode を渡すとその型番だけ（getProduct が全件を読まずに済むように）。
 */
async function selectProducts(ctx: Ctx, sort: ProductSummarySort, modelCode?: string): Promise<ProductSummaryRow[]> {
  // NULL は最後（SQLite は NULL を最小として扱うため DESC で自然に最後になる。Postgres は nulls last を明示する）。
  // 同順位は型番順で毎回同じ並びにする
  const col: Record<ProductSummarySort, string> = {
    total_profit: 'vs.total_profit',
    avg_profit: 'vs.avg_profit',
    sold: 'vs.sold',
    in_stock: 'vs.in_stock',
    last_purchased_at: 'pt.last_purchased_at',
  }

  return ctx.sql.all<ProductSummaryRow>(`
    select
      ${variantSummaryColumns('vs')},
      coalesce(pt.purchase_total, 0)::bigint as purchase_total,
      pt.avg_cost                            as avg_cost,
      pt.last_purchased_at                   as last_purchased_at,
      st.last_sold_at                        as last_sold_at
    from variant_summary vs
    left join (
      select
        household_id,
        model_code,
        sum(landed_cost)::bigint           as purchase_total,
        round(avg(landed_cost))::integer   as avg_cost,
        max(acquired_at)                   as last_purchased_at
      from inventory_item
      where model_code is not null and status != 'split'
      group by household_id, model_code
    ) pt on pt.household_id = vs.household_id and pt.model_code = vs.model_code
    left join (
      select i.household_id, i.model_code, max(s.sold_at) as last_sold_at
      from inventory_item i
      join sale_line sl on sl.household_id = i.household_id and sl.inventory_item_id = i.id
      join sale s       on s.household_id  = sl.household_id and s.id = sl.sale_id
      group by i.household_id, i.model_code
    ) st on st.household_id = vs.household_id and st.model_code = vs.model_code
    ${modelCode === undefined ? '' : 'where vs.model_code = ?'}
    order by ${col[sort]} desc nulls last, vs.model_code collate "C"
  `, ...(modelCode === undefined ? [] : [modelCode]))
}

function toProductSummary(
  ctx: Ctx, r: ProductSummaryRow, tags: Tag[], image: { path: string; manual: boolean } | undefined,
): ProductSummary {
  return { ...r, thumb_url: mediaUrl(ctx, image?.path ?? null), image_manual: image?.manual ?? false, tags }
}

export async function listProducts(ctx: Ctx, sort: ProductSummarySort = 'total_profit'): Promise<ProductSummary[]> {
  const s = argOptEnum('並び順', sort, PRODUCT_SORTS) ?? 'total_profit'
  const rows = await selectProducts(ctx, s)
  const codes = rows.map(r => r.model_code)
  const tagMap = await loadTagsFor(ctx, 'product_tag', 'model_code', codes)
  const imageMap = await productImageFiles(ctx, codes)
  return rows.map(r => toProductSummary(ctx, r, tagMap.get(r.model_code) ?? [], imageMap.get(r.model_code)))
}

/** 'YYYY-MM' を 1 か月進める（暦の計算だけ。サーバーのタイムゾーンに依らない） */
function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m, 1)) // m は 1〜12（次の月がそのまま月のインデックスになる）
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export async function getProduct(ctx: Ctx, modelCode: string): Promise<ProductDetail | null> {
  const code = argModelCode(modelCode)
  const base = (await selectProducts(ctx, 'total_profit', code))[0]
  if (!base) return null

  const purchaseRows = await ctx.sql.all<{ acquired_at: string; landed_cost: number }>(`
    select acquired_at, landed_cost
      from inventory_item
     where model_code = ? and status != 'split'
  `, code)

  // 1点あたりの売上・粗利は sale_line_share の整数按分をそのまま使う（端数は最終行に寄っている）
  const soldRows = await ctx.sql.all<{
    sold_at: string; status: SaleStatus | null; source: SaleSource; price: number; profit: number
  }>(`
    select s.sold_at, s.status, s.source, sls.price_share as price, sls.profit_share as profit
      from inventory_item i
      join sale_line       sl  on sl.household_id  = i.household_id  and sl.inventory_item_id = i.id
      join sale            s   on s.household_id   = sl.household_id and s.id = sl.sale_id
      join sale_line_share sls on sls.household_id = i.household_id  and sls.inventory_item_id = i.id
     where i.model_code = ?
  `, code)

  const disposedRows = await ctx.sql.all<{ disposed_at: string }>(`
    select disposed_at
      from inventory_item
     where model_code = ? and status in ('disposed', 'personal_use') and disposed_at is not null
  `, code)

  const purchaseByMonth = new Map<string, { purchased: number; purchase_amount: number }>()
  for (const r of purchaseRows) {
    const m = r.acquired_at.slice(0, 7)
    const cur = purchaseByMonth.get(m) ?? { purchased: 0, purchase_amount: 0 }
    cur.purchased += 1
    cur.purchase_amount += r.landed_cost
    purchaseByMonth.set(m, cur)
  }

  const soldByMonth = new Map<string, { sold: number; sales_amount: number; profit: number; forecast_sales_amount: number; forecast_profit: number }>()
  for (const r of soldRows) {
    const m = r.sold_at.slice(0, 7)
    const cur = soldByMonth.get(m) ?? { sold: 0, sales_amount: 0, profit: 0, forecast_sales_amount: 0, forecast_profit: 0 }
    cur.sold += 1
    if (isRealized(r)) {
      cur.sales_amount += r.price
      cur.profit += r.profit
    } else {
      cur.forecast_sales_amount += r.price
      cur.forecast_profit += r.profit
    }
    soldByMonth.set(m, cur)
  }

  const disposedByMonth = new Map<string, number>()
  for (const r of disposedRows) {
    const m = r.disposed_at.slice(0, 7)
    disposedByMonth.set(m, (disposedByMonth.get(m) ?? 0) + 1)
  }

  const knownMonths = [...purchaseByMonth.keys(), ...soldByMonth.keys()].sort()
  const lastMonth = thisMonthJst()
  const firstMonth = knownMonths[0] ?? lastMonth

  const months: ProductMonthPoint[] = []
  let cumulative = 0
  for (let m = firstMonth; m <= lastMonth; m = nextMonth(m)) {
    const p = purchaseByMonth.get(m) ?? { purchased: 0, purchase_amount: 0 }
    const s = soldByMonth.get(m) ?? { sold: 0, sales_amount: 0, profit: 0, forecast_sales_amount: 0, forecast_profit: 0 }
    const disposed = disposedByMonth.get(m) ?? 0
    cumulative += p.purchased - s.sold - disposed
    months.push({
      month: m,
      purchased: p.purchased,
      sold: s.sold,
      in_stock: cumulative,
      purchase_amount: p.purchase_amount,
      sales_amount: s.sales_amount,
      profit: s.profit,
      forecast_sales_amount: s.forecast_sales_amount,
      forecast_profit: s.forecast_profit,
    })
  }

  // 新しい順。同じ日に仕入れたものは在庫コード順（桁数 → 文字列で数の大小になる）
  const items = await attachInventoryTags(ctx, await ctx.sql.all<InventoryRow>(`
    select ${inventoryViewColumns()} from inventory_view
     where model_code = ?
     order by acquired_at desc, length(item_code), item_code collate "C"
  `, code))

  const saleRows = await ctx.sql.all<SaleProfitRow>(`
    select ${saleProfitColumns('sp')}
      from sale_profit sp
     where sp.id in (
       select sl.sale_id
         from sale_line sl
         join inventory_item i on i.household_id = sl.household_id and i.id = sl.inventory_item_id
        where i.model_code = ?
     )
     order by sp.sold_at desc, sp.title collate "C", sp.id
  `, code)

  const tagMap = await loadTagsFor(ctx, 'product_tag', 'model_code', [code])
  const imageMap = await productImageFiles(ctx, [code])
  return {
    ...toProductSummary(ctx, base, tagMap.get(code) ?? [], imageMap.get(code)),
    months,
    items,
    sales: await hydrateSaleProfitRows(ctx, saleRows),
  }
}

// ------------------------------------------------------------
// 在庫 1 点の履歴
// ------------------------------------------------------------

/** イベントの日付が無い（予定の段）ときの並び替え用。日付のある段より後ろ */
const NO_DATE_KEY = '9999-99-99'

type ListingInfo = { channel: SalesChannel; price: number; listed_at: string }

/**
 * 在庫 1 点の履歴（仕入→到着→販売→発送→受取→取引完了）。
 * 在庫が無ければ null。仕入・販売のどちらかが無くても組み立てられる分だけ返す。
 */
export async function getItemTimeline(ctx: Ctx, inventoryItemId: string): Promise<ItemTimeline | null> {
  const id = argId('在庫', inventoryItemId)
  const itemRow = await ctx.sql.get<InventoryRow>(`select ${inventoryViewColumns()} from inventory_view where id = ?`, id)
  if (!itemRow) return null
  const item: InventoryItem = (await attachInventoryTags(ctx, [itemRow]))[0]

  const raw = (await ctx.sql.get<{
    purchase_line_id: string | null
    parent_id: string | null
    disposed_at: string | null
    disposed_note: string | null
  }>('select purchase_line_id, parent_id, disposed_at, disposed_note from inventory_item where id = ?', id))!

  let purchase: PurchaseSummary | null = null
  let lineUnitPrice: number | null = null
  if (raw.purchase_line_id) {
    const line = await ctx.sql.get<{ unit_price: number; purchase_id: string }>(
      'select unit_price, purchase_id from purchase_line where id = ?', raw.purchase_line_id,
    )
    if (line) {
      lineUnitPrice = line.unit_price
      purchase = (await getPurchaseSummary(ctx, line.purchase_id)) ?? null
    }
  }

  const saleRow = await ctx.sql.get<SaleProfitRow>(`
    select ${saleProfitColumns('sp')}
      from sale_line sl
      join sale_profit sp on sp.household_id = sl.household_id and sp.id = sl.sale_id
     where sl.inventory_item_id = ?
  `, id)
  const sale: SaleProfit | null = saleRow ? (await hydrateSaleProfitRows(ctx, [saleRow]))[0] : null

  const events: TimelineEvent[] = []

  if (purchase && lineUnitPrice !== null) {
    const allocatedForItem = item.landed_cost - lineUnitPrice
    const detail = allocatedForItem === 0
      ? `${yenText(lineUnitPrice)} → 原価 ${yenText(item.landed_cost)}`
      : `${yenText(lineUnitPrice)} ＋送料按分 ${yenText(allocatedForItem)} → 原価 ${yenText(item.landed_cost)}`
    events.push({
      date: purchase.ordered_at,
      kind: 'ordered',
      title: `${purchase.shop_account_name}で注文${purchase.order_no ? ' ' + purchase.order_no : ''}`,
      detail,
      amount: item.landed_cost,
    })
  }

  // fulfillment が null（手入力）なら発送・到着の予定は出さない
  if (purchase && purchase.fulfillment !== null) {
    events.push({
      date: purchase.shipped_at,
      kind: 'purchase_shipped',
      title: '仕入先が発送',
      detail: null,
      amount: null,
    })
    events.push({
      date: purchase.delivered_at,
      kind: 'purchase_delivered',
      title: '到着',
      detail: null,
      amount: null,
    })
  }

  if (raw.parent_id) {
    const parent = await ctx.sql.get<{ name: string }>('select name from inventory_item where id = ?', raw.parent_id)
    events.push({
      date: item.acquired_at,
      kind: 'split',
      title: '分割で生成',
      detail: parent ? `「${parent.name}」から分割` : null,
      amount: null,
    })
  }

  // 出品への引き当て（未販売なら item.listing から）／売れたあとも、その紐付けが
  // link_source='listing'（出品からの引き継ぎ）なら「出品」イベントを足す。
  // 出品は (出品先, 出品先での商品ID) で引く（メルカリと Yahoo!フリマで同じ ID が来ても取り違えない）
  const findListing = (channel: SalesChannel, channelItemId: string) =>
    ctx.sql.get<ListingInfo>(
      'select channel, price, listed_at from listing where channel = ? and channel_item_id = ?', channel, channelItemId,
    )
  let listingInfo: ListingInfo | null = null
  if (item.listing) {
    listingInfo = (await findListing(item.listing.channel, item.listing.mercari_item_id)) ?? null
  } else if (sale) {
    const saleLine = await ctx.sql.get<{ link_source: LinkSource }>(
      'select link_source from sale_line where inventory_item_id = ? and sale_id = ?', id, sale.id,
    )
    if (saleLine?.link_source === 'listing' && sale.mercari_item_id) {
      listingInfo = (await findListing(sale.channel, sale.mercari_item_id)) ?? null
    }
  }
  if (listingInfo) {
    events.push({
      date: listingInfo.listed_at,
      kind: 'listed',
      title: `${CHANNEL_LABEL[listingInfo.channel]}に出品`,
      detail: yenText(listingInfo.price),
      amount: listingInfo.price,
    })
  }

  if (sale) {
    const detailParts = [yenText(sale.price)]
    if (sale.item_count > 1) {
      // この在庫 1 点あたりの取り分。sale_line_share の整数按分（端数は最終行）を使う
      const share = await ctx.sql.get<{ price_share: number }>(
        'select price_share from sale_line_share where inventory_item_id = ? and sale_id = ?', id, sale.id,
      )
      const perItem = share?.price_share ?? Math.floor(sale.price / sale.item_count)
      detailParts.push(`（まとめ売り ${sale.item_count} 点、1 点あたり ${yenText(perItem)}）`)
    }
    if (sale.buyer) detailParts.push(`買い手：${sale.buyer}`)
    if (sale.purchased_at) detailParts.push(`購入日時 ${formatPurchasedAt(sale.purchased_at)}`)

    events.push({
      // 購入日時が取れていればそちらを優先（sold_at は取引完了までの仮置きのことがある）
      date: sale.purchased_at ? sale.purchased_at.slice(0, 10) : sale.sold_at,
      kind: 'sold',
      title: `${CHANNEL_LABEL[sale.channel]}で売れた`,
      detail: detailParts.join(' '),
      amount: sale.price,
    })
    events.push({
      date: sale.shipped_at,
      kind: 'sale_shipped',
      title: '発送済み',
      detail: null,
      amount: null,
    })
    events.push({
      date: sale.delivered_at,
      kind: 'sale_delivered',
      title: '受取済み',
      detail: null,
      amount: null,
    })
    events.push({
      date: sale.completed_at,
      kind: 'sale_completed',
      title: '取引完了',
      detail: `売上金 ${yenText(sale.price - sale.fee - sale.shipping_fee)} 反映`,
      amount: null,
    })
  }

  if (item.status === 'disposed' || item.status === 'personal_use') {
    events.push({
      date: raw.disposed_at,
      kind: item.status,
      title: item.status === 'disposed' ? '廃棄' : '自家消費',
      detail: raw.disposed_note,
      amount: null,
    })
  }

  // 日付昇順。同日（null 同士も含む）は上で積んだ順（＝仕様の並び）を保つ
  // （Array#sort は安定ソートなので、比較が同値なら元の順序が保たれる）
  const dateKey = (d: string | null) => d ?? NO_DATE_KEY
  events.sort((a, b) => (dateKey(a.date) < dateKey(b.date) ? -1 : dateKey(a.date) > dateKey(b.date) ? 1 : 0))

  return { item, events, sale, purchase }
}

// ------------------------------------------------------------
// 商品（型番）のタグ・表示名・メモ
// ------------------------------------------------------------

/**
 * 商品（型番）のタグを丸ごと置き換える（空配列で全部外す）。
 * その型番の在庫すべて・その在庫が紐付いた販売に派生で見える（コピーしない）
 */
export async function setProductTags(ctx: Ctx, modelCode: string, tagIds: string[]): Promise<void> {
  const code = argModelCode(modelCode)
  const unique = [...new Set(argIds('タグ', tagIds))]
  await assertTagsExist(ctx, unique)

  await ctx.sql.run('delete from product_tag where model_code = ?', code)
  for (const tagId of unique) {
    await ctx.sql.run('insert into product_tag (model_code, tag_id) values (?, ?)', code, tagId)
  }
}

/**
 * 型番の表示名を人が上書きする（商品ページ）。trim して空/null なら消し、
 * variant_summary.name は最新の在庫名に戻る。modelCode は在庫に無くても保存してよい
 * （型番の入力ミスは画面側で防ぐ）。データのリセットでは消さない（shop_alias と同じ扱い）。
 * メモ（note）が付いていれば消さない（名前だけ外れて行は残る）
 */
export async function setProductName(ctx: Ctx, modelCode: string, name: string | null): Promise<void> {
  const code = argModelCode(modelCode)
  const trimmed = (argNullableText('表示名', name, { max: PRODUCT_NAME_MAX }) ?? '').trim()
  if (!trimmed) {
    // メモが無ければ行ごと消す。メモが残っていれば name だけ null にして行を残す
    const row = await ctx.sql.get<{ note: string | null }>('select note from product_name where model_code = ?', code)
    if (!row?.note) {
      await ctx.sql.run('delete from product_name where model_code = ?', code)
    } else {
      await ctx.sql.run('update product_name set name = null, updated_at = now() where model_code = ?', code)
    }
    return
  }
  await ctx.sql.run(
    `insert into product_name (model_code, name, updated_at) values (?, ?, now())
     on conflict (household_id, model_code) do update set name = excluded.name, updated_at = now()`,
    code, trimmed,
  )
}

/**
 * 型番のメモ（商品カルテ）。trim して空/null なら消す。在庫・販売のメモとは別で型番そのものに付く。
 * 表示名（name）が無くてもメモだけの行を持てる。表示名を消さない（upsert は note だけ更新）
 */
export async function setProductNote(ctx: Ctx, modelCode: string, note: string | null): Promise<void> {
  const code = argModelCode(modelCode)
  const trimmed = (argNullableText('メモ', note, { max: PRODUCT_NOTE_MAX }) ?? '').trim()
  if (!trimmed) {
    // 表示名が無ければ行ごと消す。表示名が残っていれば note だけ null にして行を残す
    const row = await ctx.sql.get<{ name: string | null }>('select name from product_name where model_code = ?', code)
    if (!row?.name) {
      await ctx.sql.run('delete from product_name where model_code = ?', code)
    } else {
      await ctx.sql.run('update product_name set note = null, updated_at = now() where model_code = ?', code)
    }
    return
  }
  await ctx.sql.run(
    `insert into product_name (model_code, note, updated_at) values (?, ?, now())
     on conflict (household_id, model_code) do update set note = excluded.note, updated_at = now()`,
    code, trimmed,
  )
}

// ------------------------------------------------------------
// API として登録する（引数は信用しない。型が違えば UserError）。
// setProductImage（ファイルを選ぶダイアログ）は Web では登録しない（画面が prepareUpload → Storage へ直接 →
// setProductImagePath に置き換える）
// ------------------------------------------------------------

registerHandler('listVariantSummary', (ctx, sort) => listVariantSummary(ctx, sort ?? undefined))
registerHandler('listProducts', (ctx, sort) => listProducts(ctx, sort ?? undefined))
registerHandler('getProduct', (ctx, modelCode) => getProduct(ctx, modelCode))
registerHandler('getItemTimeline', (ctx, inventoryItemId) => getItemTimeline(ctx, inventoryItemId))
registerHandler('setProductTags', (ctx, modelCode, tagIds) => setProductTags(ctx, modelCode, tagIds))
registerHandler('setProductName', (ctx, modelCode, name) => setProductName(ctx, modelCode, name ?? null))
registerHandler('setProductNote', (ctx, modelCode, note) => setProductNote(ctx, modelCode, note ?? null))
registerWebHandler('setProductImagePath', (ctx, modelCode, path) => setProductImagePath(ctx, modelCode, path))
registerHandler('setProductImageAuto', (ctx, modelCode, auto) => setProductImageAuto(ctx, modelCode, auto))
