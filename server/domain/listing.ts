import type { Ctx } from '../context'
import { UserError, registerDbErrorRule } from '../errors'
import { registerHandler } from '../rpc'
import type {
  InventoryItem, InventoryStatus, Listing, ListingStatus, SalesChannel, SearchHit,
} from '../../src/shared/types'
import { LISTING_STATUS_LABEL } from '../../src/shared/types'
import {
  argArray, argEnum, argId, argIds, argInt, argNullableId, argObject, argOptArray, argOptBool, argOptInt, argOptObject,
  argText, calcFee, extractCodeQuantities, extractCodes, extractItemCodes, matchesQuery, mediaUrl, normalizeName,
  settingStr, sortAndSlice, subtractDaysJst, todayJst,
} from './_shared'
import { attachInventoryTags, inventoryViewColumns, type InventoryRow } from './derive'
import {
  INVENTORY_VIEW_ORDER, findInventoryIdsByItemCodes, findInventoryIdsByModelCodeFifo, rankInventoryMatch,
} from './inventory'
import { feeRateBpFor } from './sale'

// ============================================================
// 出品（メルカリの出品中タブ）と在庫の引き当て
//
// 出品そのものは在庫の status を変えない（in_stock のまま。まだ売れていない資産）。
// 引き当て（listing_line）は人が行う（自動確定しない。例外は autoReserveListings の 2 条件だけ）。
// 二重引き当て・売却済み在庫の引き当ては trg_listing_line_guard（マイグレーション）も拒否するが、
// そこに任せると英語寄りの DB のエラーになるので、先に同じ文言で明示的に弾く。
//
// **画面と契約が呼ぶ「出品の id」は商品ID（listing.channel_item_id。契約の名前は mercari_item_id）**。
// listing の主キー（uuid）は listing_line.listing_id が指す別物。引数の商品ID から listing を引いて使う。
// ============================================================

// 出品の重複（同じ出品先の同じ商品ID）を同時に 2 本入れた 2 本目
registerDbErrorRule({
  code: '23505', constraint: 'listing_household_id_channel_channel_item_id_key',
  message: '同じ商品IDの出品がすでにあります', as: 'conflict',
})

const LISTING_STATUSES: readonly ListingStatus[] = ['active', 'suspended', 'sold', 'ended']
const CHANNELS: readonly SalesChannel[] = ['mercari', 'yahoo']
const ITEM_ID_MAX = 100
const TITLE_MAX = 1000

/**
 * 出品中タブの「n日前に更新」（時間・分は0日扱い）から経過日数を取り出す。読めなければ null。
 */
export function parseElapsedDays(updatedText: string | null | undefined): number | null {
  if (!updatedText) return null
  const m = /(\d+)\s*(日|時間|分)前/.exec(updatedText)
  if (!m) return null
  return m[2] === '日' ? parseInt(m[1], 10) : 0
}

interface ListingHead {
  id: string
  channel: SalesChannel
  status: ListingStatus
  title: string
  shipping_method_id: string | null
}

/** 商品ID（channel_item_id）から出品を引く。無ければ undefined */
async function findListing(ctx: Ctx, itemId: string): Promise<ListingHead | undefined> {
  return ctx.sql.get<ListingHead>(
    'select id, channel, status, title, shipping_method_id from listing where channel_item_id = ? order by updated_at desc limit 1',
    itemId,
  )
}

/**
 * 出品中タブの一覧を取り込む（収集が使う。API には出さない）。新規は first_seen_at を今日（日本時間）にする。
 * 既存は title/price/status/last_seen_at を更新するが、sold/ended になったものは
 * 一覧に出ていても active/suspended へ戻さない（1ページしか読まないため、
 * 一覧から消えたことと「取り下げた」を区別できない）。
 * 一覧に無い listing は何もしない。
 *
 * listed_at（出品日の推定）：updatedText から経過日数 n を出し、候補 = today − n日。
 * 新規は候補（取れなければ today）。既存は候補と現在値の min（＝より古い方）に更新する
 * （一覧の「更新順」表示の揺れで出品日が新しく巻き戻るのを防ぐ）。likes は毎回上書きする。
 * 列は date なので、時刻つきの値（listedAt）は日付の部分だけを使う。
 *
 * 出品停止中への切り替え：既存の出品が active → suspended に**変わったその取り込みでだけ**、
 * その出品の listing_line（引き当て）を外す（設定 auto_release_suspended、既定オン）。
 * すでに suspended のものは対象外。在庫（inventory_item）と sale_line には触らない。
 * メルカリの取り込みだけ（Yahoo は停止中を観測しない）。
 * 外した件数は releasedListings（出品数）・releasedItems（在庫の点数）で返す。
 *
 * listedAt（絶対的な出品日時。例：Yahoo!フリマの opentime）が渡っていれば、updatedText
 * からの相対推定より優先して使う。ただし使うのは**新規行だけ**。既存行の更新では触らない。
 */
export async function upsertListings(
  ctx: Ctx,
  rows: Array<{
    mercariItemId: string
    title: string
    price: number
    suspended: boolean
    thumbUrl: string | null
    /** 出品中タブの「n日前に更新」等。取れなければ null */
    updatedText?: string | null
    /** いいね数。取れなければ null */
    likes?: number | null
    /** 絶対的な出品日時（取れるチャンネルだけ渡す）。新規行の listed_at に優先して使う（日付の部分だけ） */
    listedAt?: string | null
  }>,
  /** 出品先（省略時 'mercari'）。1回の呼び出しは1チャンネル分の一覧を渡す前提 */
  channel: SalesChannel = 'mercari',
): Promise<{ inserted: number; updated: number; releasedListings: number; releasedItems: number }> {
  const ch = argEnum('出品先', channel, CHANNELS)
  const list = argArray('出品の一覧', rows)
  const today = todayJst()
  // last_seen_at は画面側で collector_run.finished_at（ISO）と比較するため ISO 文字列（UTC）で保存する
  const now = new Date().toISOString()
  const releaseOnSuspend = ch === 'mercari' && (await settingStr(ctx, 'auto_release_suspended', '1')) !== '0'

  let inserted = 0
  let updated = 0
  let releasedListings = 0
  let releasedItems = 0
  for (const raw of list) {
    const r = argObject('出品', raw)
    const itemId = argText('商品ID', r.mercariItemId, { max: ITEM_ID_MAX })
    const title = argText('出品のタイトル', r.title, { max: TITLE_MAX })
    const price = argInt('出品の価格', r.price, { min: 0 })
    const status: ListingStatus = r.suspended === true ? 'suspended' : 'active'
    const days = parseElapsedDays(typeof r.updatedText === 'string' ? r.updatedText : null)
    const candidate = days !== null ? subtractDaysJst(today, days) : null
    const likes = typeof r.likes === 'number' ? argInt('いいね数', r.likes, { min: 0 }) : null
    const absolute = typeof r.listedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r.listedAt) ? r.listedAt.slice(0, 10) : null

    const existing = await ctx.sql.get<{ id: string; status: ListingStatus; listed_at: string }>(
      'select id, status, listed_at from listing where channel = ? and channel_item_id = ?', ch, itemId,
    )
    if (!existing) {
      const listedAt = absolute ?? candidate ?? today
      await ctx.sql.run(`
        insert into listing (channel, channel_item_id, title, price, status, first_seen_at, last_seen_at, listed_at, likes)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, ch, itemId, title, price, status, today, now, listedAt, likes)
      inserted++
    } else if (existing.status === 'active' || existing.status === 'suspended') {
      // listedAt（絶対値）は既存行の更新では使わない。従来どおり相対推定の min 寄せだけ行う
      const listedAt = candidate !== null && candidate < existing.listed_at ? candidate : existing.listed_at
      await ctx.sql.run(`
        update listing set title = ?, price = ?, status = ?, last_seen_at = ?, listed_at = ?, likes = ?, updated_at = now()
         where id = ?
      `, title, price, status, now, listedAt, likes, existing.id)
      updated++
      // 「変わったとき」だけ。すでに suspended のものは外さない
      if (releaseOnSuspend && existing.status === 'active' && status === 'suspended') {
        const n = (await ctx.sql.run('delete from listing_line where listing_id = ?', existing.id)).changes
        if (n > 0) {
          releasedListings++
          releasedItems += n
        }
      }
    }
    // sold / ended は一覧に出ていても戻さない
  }
  return { inserted, updated, releasedListings, releasedItems }
}

interface ListingRow {
  id: string
  mercari_item_id: string
  channel: SalesChannel
  title: string
  price: number
  status: ListingStatus
  first_seen_at: string
  last_seen_at: string
  listed_at: string
  likes: number | null
  shipping_method_id: string | null
  thumb_path: string | null
}

const LISTING_COLUMNS = `
  id, channel_item_id as mercari_item_id, channel, title, price, status, first_seen_at, last_seen_at, listed_at,
  likes, shipping_method_id, thumb_path
`

/** 出品の行を、引き当てた在庫・発送方法・見込み粗利つきにまとめて直す（行ごとに SQL を投げない） */
async function hydrateListings(ctx: Ctx, rows: ListingRow[]): Promise<Listing[]> {
  if (rows.length === 0) return []

  const itemRows = await ctx.sql.all<{
    listing_uuid: string; id: string; item_code: string; name: string; model_code: string | null
    product_name: string | null; landed_cost: number
  }>(`
    select ll.listing_id as listing_uuid, i.id, i.item_code, i.name, i.model_code,
           (select pn.name from product_name pn where pn.household_id = i.household_id and pn.model_code = i.model_code) as product_name,
           i.landed_cost
      from listing_line ll
      join inventory_item i on i.household_id = ll.household_id and i.id = ll.inventory_item_id
     where ll.listing_id = any(?::uuid[])
     order by ll.created_at, length(i.item_code), i.item_code collate "C"
  `, rows.map(r => r.id))
  const itemsByListing = new Map<string, Listing['items']>()
  for (const r of itemRows) {
    const arr = itemsByListing.get(r.listing_uuid) ?? []
    arr.push({
      id: r.id, item_code: r.item_code, name: r.name, model_code: r.model_code,
      product_name: r.product_name, landed_cost: r.landed_cost,
    })
    itemsByListing.set(r.listing_uuid, arr)
  }

  const methodIds = [...new Set(rows.map(r => r.shipping_method_id).filter((x): x is string => !!x))]
  const methods = new Map<string, { name: string; fee: number }>()
  if (methodIds.length > 0) {
    for (const m of await ctx.sql.all<{ id: string; name: string; fee: number }>(
      'select id, name, fee from shipping_method where id = any(?::uuid[])', methodIds,
    )) methods.set(m.id, { name: m.name, fee: m.fee })
  }

  const rates = new Map<SalesChannel, number>()
  for (const ch of new Set(rows.map(r => r.channel))) rates.set(ch, await feeRateBpFor(ctx, ch))

  return rows.map(r => {
    const items = itemsByListing.get(r.id) ?? []
    const reserved_cost = items.reduce((s, i) => s + i.landed_cost, 0)
    const method = r.shipping_method_id ? methods.get(r.shipping_method_id) : undefined
    const shippingFee = method?.fee ?? 0

    // 手数料は設定の率。発送方法が決まっていればその送料も引く（梱包は引かない）
    const expected_profit = items.length === 0
      ? null
      : r.price - calcFee(r.price, rates.get(r.channel)!) - reserved_cost - shippingFee

    return {
      mercari_item_id: r.mercari_item_id,
      channel: r.channel,
      title: r.title,
      price: r.price,
      status: r.status,
      first_seen_at: r.first_seen_at,
      last_seen_at: r.last_seen_at,
      listed_at: r.listed_at,
      likes: r.likes,
      shipping_method_id: r.shipping_method_id,
      shipping_method_name: method?.name ?? null,
      thumb_url: mediaUrl(ctx, r.thumb_path),
      model_codes: extractCodes(r.title),
      items,
      reserved_cost,
      expected_profit,
    }
  })
}

export async function hydrateListing(ctx: Ctx, r: ListingRow): Promise<Listing> {
  return (await hydrateListings(ctx, [r]))[0]
}

/** status 未指定なら active + suspended。onlyUnallocated で未引き当てだけ */
export async function listListings(
  ctx: Ctx, filter?: { status?: ListingStatus[]; onlyUnallocated?: boolean },
): Promise<Listing[]> {
  const f = filter ? argObject('出品の絞り込み', filter) : undefined
  const statuses = f?.status === undefined || f.status === null
    ? (['active', 'suspended'] as ListingStatus[])
    : argArray('出品の状態', f.status, { max: 10 }).map(s => argEnum('出品の状態', s, LISTING_STATUSES))
  const onlyUnallocated = argOptBool('未引き当てだけ', f?.onlyUnallocated) === true

  const rows = await ctx.sql.all<ListingRow>(`
    select ${LISTING_COLUMNS} from listing l
     where l.status = any(?::text[])
       ${onlyUnallocated
         ? 'and not exists (select 1 from listing_line ll where ll.household_id = l.household_id and ll.listing_id = l.id)'
         : ''}
     order by l.first_seen_at desc, l.created_at desc, l.channel_item_id collate "C"
  `, statuses)
  return hydrateListings(ctx, rows)
}

/** 出品時に発送方法を決めておく（null で外す）。売れたとき takeOverListing が販売へ引き継ぐ */
export async function setListingShipping(ctx: Ctx, itemId: string, shippingMethodId: string | null): Promise<void> {
  const channelItemId = argText('出品', itemId, { max: ITEM_ID_MAX })
  const methodId = argNullableId('発送方法', shippingMethodId)
  if (methodId === undefined) throw new UserError('発送方法を指定してください')
  if (methodId !== null) {
    const method = await ctx.sql.get<{ id: string }>('select id from shipping_method where id = ?', methodId)
    if (!method) throw new UserError('発送方法が見つかりません', 'not_found')
  }
  const r = await ctx.sql.run(
    'update listing set shipping_method_id = ?, updated_at = now() where channel_item_id = ?', methodId, channelItemId,
  )
  if (r.changes === 0) throw new UserError('出品が見つかりません', 'not_found')
}

/**
 * 出品に在庫を引き当てる（追加）。既に他の active/suspended な出品に引き当て済みの
 * 在庫は、その引き当てを同じトランザクション内で先に外してからこちらへ移す
 * （再出品・付け替え。人の最新の決定を優先。元の出品は未引き当てに戻る）。
 * 販売済み・廃棄済みの在庫は拒否する。
 *
 * opts.takeFromSale: true なら、販売済み（status='sold'）の在庫はその sale_line を
 * 同じトランザクションの中で先に外してから（in_stock に戻して）引き当てる
 * （メンテ用。画面で警告してから呼ぶ）。それ以外の非 in_stock は拒否する。
 */
export async function reserveInventory(
  ctx: Ctx, itemId: string, inventoryItemIds: string[], opts?: { takeFromSale?: boolean },
): Promise<void> {
  const channelItemId = argText('出品', itemId, { max: ITEM_ID_MAX })
  const ids = [...new Set(argIds('在庫', inventoryItemIds))]
  const takeFromSale = opts?.takeFromSale === true

  const listing = await findListing(ctx, channelItemId)
  if (!listing || (listing.status !== 'active' && listing.status !== 'suspended')) {
    throw new UserError('終了した出品には引き当てられません')
  }
  if (ids.length === 0) return

  const rows = await ctx.sql.all<{ id: string; status: InventoryStatus }>(
    'select id, status from inventory_item where id = any(?::uuid[])', ids,
  )
  const byId = new Map(rows.map(r => [r.id, r.status]))
  // 先に全部確かめてから書く（途中の 1 点で断る場合に、前の点だけが動かないように）
  for (const id of ids) {
    const status = byId.get(id)
    if (status === undefined) throw new UserError('在庫が見つかりません', 'not_found')
    if (status !== 'in_stock' && !(takeFromSale && status === 'sold')) {
      throw new UserError('未販売の在庫だけ引き当てられます')
    }
  }

  for (const id of ids) {
    // 付け替え：売れた在庫は先に元の sale_line を外す（trg_sline_unsold で in_stock に戻る）
    if (takeFromSale && byId.get(id) === 'sold') {
      await ctx.sql.run('delete from sale_line where inventory_item_id = ?', id)
    }
    // 他の出品（active / suspended）への引き当ては外して、こちらへ移す
    await ctx.sql.run(`
      delete from listing_line
       where inventory_item_id = ?
         and listing_id in (select id from listing where status in ('active', 'suspended'))
    `, id)
    await ctx.sql.run('insert into listing_line (listing_id, inventory_item_id) values (?, ?)', listing.id, id)
  }
}

export async function unreserveInventory(ctx: Ctx, itemId: string, inventoryItemId: string): Promise<void> {
  const channelItemId = argText('出品', itemId, { max: ITEM_ID_MAX })
  const id = argId('在庫', inventoryItemId)
  await ctx.sql.run(`
    delete from listing_line
     where inventory_item_id = ?
       and listing_id in (select id from listing where channel_item_id = ?)
  `, id, channelItemId)
}

/**
 * 出品の引き当て候補。在庫コード一致 → 型番の完全一致 → シリーズ一致 → 名前の一致の順。
 * 廃棄済みは除く。他の出品に引き当て済みの在庫も候補に含める
 * （InventoryItem.listing に引き当て先が入る。この出品自身に引き当て済みのものは除く）。
 * 同順位なら未引き当てを先に、次に sold より in_stock を先に。
 *
 * opts.includeSold: 販売済み（sale_line あり）在庫も候補に含める（sold_to 付き。付け替え用）
 */
export async function suggestForListing(
  ctx: Ctx, itemId: string, limit = 20, opts?: { includeSold?: boolean },
): Promise<InventoryItem[]> {
  const channelItemId = argText('出品', itemId, { max: ITEM_ID_MAX })
  const max = argInt('件数', limit, { min: 1, max: 1000 })
  const listing = await findListing(ctx, channelItemId)
  if (!listing) return []

  const codes = extractCodes(listing.title)
  const codeSet = new Set(codes)
  const seriesCodes = new Set(codes.map(c => c.split('-')[0]))
  const itemCodeSet = new Set(extractItemCodes(listing.title))

  const target = normalizeName(listing.title)
  const head = target.slice(0, 6)

  const statusClause = opts?.includeSold ? `status in ('in_stock', 'sold')` : `status = 'in_stock'`
  const items = await ctx.sql.all<InventoryRow>(`
    select ${inventoryViewColumns()} from inventory_view
     where ${statusClause} and (listing_id is null or listing_id <> ?)
     order by ${INVENTORY_VIEW_ORDER}
  `, channelItemId)

  const picked = items
    .map(item => ({ item, r: rankInventoryMatch(item, itemCodeSet, codeSet, seriesCodes, target, head) }))
    .sort((a, b) => {
      if (a.r !== b.r) return a.r - b.r
      const aReserved = a.item.listing_id ? 1 : 0
      const bReserved = b.item.listing_id ? 1 : 0
      if (aReserved !== bReserved) return aReserved - bReserved
      const aSold = a.item.status === 'sold' ? 1 : 0
      const bSold = b.item.status === 'sold' ? 1 : 0
      if (aSold !== bSold) return aSold - bSold
      return b.item.aging_days - a.item.aging_days
    })
    .slice(0, max)
    .map(({ item }) => item)

  return attachInventoryTags(ctx, picked)
}

/** 人が「取り下げた」と記録する。引き当ては外れ、在庫は未出品に戻る */
export async function endListing(ctx: Ctx, itemId: string): Promise<void> {
  const channelItemId = argText('出品', itemId, { max: ITEM_ID_MAX })
  const listing = await findListing(ctx, channelItemId)
  if (!listing) throw new UserError('出品が見つかりません', 'not_found')
  await ctx.sql.run('delete from listing_line where listing_id = ?', listing.id)
  await ctx.sql.run(`update listing set status = 'ended', updated_at = now() where id = ?`, listing.id)
}

/**
 * 未引き当ての出品（active／suspended）に在庫を引き当てる。autoLinkSale と同じ優先順：
 *   1. タイトルに在庫コードがあれば、見つかった分だけ全部
 *   2. 在庫コードが無ければ型番が1つに絞れるときだけ、FIFOで個数表記（×2等。無ければ1）の分だけ
 *   3. 型番が2つ以上なら候補止まり
 * 引き当てた出品の数を返す。reserveInventory で引き当てるので、1クリック（unreserveInventory）
 * で解除できる。
 *
 * listingIds を渡すと、その商品ID（mercari_item_id）に絞る（画面の絞り込みに合わせる用）。
 * **省略時は従来どおり全件**。空配列を渡したときは「対象0件」として何もしない。
 * autoLinkPending と同じ理由で、SQL 側は絞り込まず JS 側で突き合わせる。
 */
export async function autoReserveListings(ctx: Ctx, listingIds?: string[]): Promise<number> {
  const allow = listingIds === undefined
    ? undefined
    : new Set(argArray('出品', listingIds, { max: 10_000 }).map(x => argText('出品', x, { max: ITEM_ID_MAX })))

  const pending = await ctx.sql.all<{ channel_item_id: string; title: string }>(`
    select l.channel_item_id, l.title from listing l
     where l.status in ('active', 'suspended')
       and not exists (select 1 from listing_line ll where ll.household_id = l.household_id and ll.listing_id = l.id)
     order by l.first_seen_at, l.created_at, l.channel_item_id collate "C"
  `)
  const targets = allow === undefined ? pending : pending.filter(p => allow.has(p.channel_item_id))

  let count = 0
  for (const p of targets) {
    const itemCodes = extractItemCodes(p.title)
    if (itemCodes.length > 0) {
      const ids = await findInventoryIdsByItemCodes(ctx, itemCodes)
      if (ids.length === 0) continue
      await reserveInventory(ctx, p.channel_item_id, ids)
      count++
      continue
    }

    const codes = extractCodes(p.title)
    if (codes.length !== 1) continue

    const qty = extractCodeQuantities(p.title).find(q => q.code === codes[0])?.qty ?? 1
    const ids = await findInventoryIdsByModelCodeFifo(ctx, codes[0], qty)
    if (ids.length === 0) continue

    await reserveInventory(ctx, p.channel_item_id, ids)
    count++
  }
  return count
}

/**
 * 新しく取り込んだ販売の商品ID（channel_item_id）と同じ出品があれば、その出品を sold にする
 * （引き当ての有無に関わらず。売れた以上、出品タブに active のまま残さない）。収集（insertCollected）が使う。
 * 引き当て（listing_line）があれば、それをそのまま sale_line（link_source='listing'）へ移す
 * （人の決定をそのまま引き継ぐ。型番一致より優先）。
 * 出品時に発送方法を決めていれば、販売の shipping_method_id・shipping_fee・
 * is_shipping_confirmed・shipping_source（'manual'）へ引き継ぐ。ただし販売側に既に実額
 * （shipping_source='actual' かつ確定済み）があればそちらを優先し、触らない。引き当てが0件でも
 * 発送方法だけは引き継ぐ。
 * 出品が無ければ何もせず false。引き当てが無かった（sale_line へ引き継げなかった）ときも
 * false を返す（呼び出し側が型番FIFOにフォールバック。出品を sold にする処理自体はここで完了済み）。
 */
export async function takeOverListing(ctx: Ctx, saleId: string, itemId: string | null): Promise<boolean> {
  if (!itemId) return false

  const listing = await ctx.sql.get<{ id: string; shipping_method_id: string | null }>(`
    select id, shipping_method_id from listing
     where channel_item_id = ? and status in ('active', 'suspended')
     order by updated_at desc limit 1
  `, itemId)
  if (!listing) return false

  const lines = await ctx.sql.all<{ inventory_item_id: string }>(
    'select inventory_item_id from listing_line where listing_id = ? order by created_at, id', listing.id,
  )

  if (lines.length > 0) {
    for (const l of lines) {
      await ctx.sql.run(
        `insert into sale_line (sale_id, inventory_item_id, link_source) values (?, ?, 'listing')`,
        saleId, l.inventory_item_id,
      )
    }
    await ctx.sql.run('delete from listing_line where listing_id = ?', listing.id)
  }
  await ctx.sql.run(`update listing set status = 'sold', updated_at = now() where id = ?`, listing.id)

  if (listing.shipping_method_id) {
    const sale = await ctx.sql.get<{ shipping_source: string | null; is_shipping_confirmed: number }>(
      'select shipping_source, is_shipping_confirmed from sale where id = ?', saleId,
    )
    // 既に実額（actual）で確定していればそちらを優先し、触らない。
    // 実額が ¥0（メルカリ便以外＝未確定）なら、出品時に決めた発送方法を引き継ぐ
    if (sale && !(sale.shipping_source === 'actual' && sale.is_shipping_confirmed)) {
      const method = await ctx.sql.get<{ fee: number }>(
        'select fee from shipping_method where id = ?', listing.shipping_method_id,
      )
      if (method) {
        await ctx.sql.run(`
          update sale
             set shipping_method_id = ?, shipping_fee = ?, is_shipping_confirmed = 1, shipping_source = 'manual'
           where id = ?
        `, listing.shipping_method_id, method.fee, saleId)
      }
    }
  }

  return lines.length > 0
}

/** サムネイルをまだ持っていない出品（商品ID）を返す */
export async function listingsWithoutThumb(ctx: Ctx, itemIds: string[]): Promise<string[]> {
  if (itemIds.length === 0) return []
  const rows = await ctx.sql.all<{ id: string }>(
    'select channel_item_id as id from listing where channel_item_id = any(?::text[]) and thumb_path is null', itemIds,
  )
  return rows.map(r => r.id)
}

/**
 * サムネイルURLを比較用の文字列にする（前後の空白とフラグメントだけ落とす）。
 * メルカリの画像URLは `.../m123_1.jpg?1789781431` の形で、パスは写真の番号、
 * クエリは画像の更新時刻。写真を差し替えるとパスは同じままクエリだけ変わるので、
 * **クエリは落とさない**（落とすと差し替えを見逃す）。
 */
export function normalizeThumbSrc(url: string): string {
  return url.trim().split('#')[0]
}

/**
 * 出品と同じ画像（thumb_path・thumb_src）を、対になる sale（商品IDが同じ）にも書く
 * （売れる前は listing、売れた後は sale がサムネイルの持ち主だが、同じ画像を共有しているため）。
 * path は Storage のパス（media バケット）
 */
export async function setListingThumb(ctx: Ctx, itemId: string, path: string, src: string | null = null): Promise<void> {
  await ctx.sql.run(
    `update listing set thumb_path = ?, thumb_src = ?, updated_at = now() where channel_item_id = ?`, path, src, itemId,
  )
  await ctx.sql.run('update sale set thumb_path = ?, thumb_src = ? where channel_item_id = ?', path, src, itemId)
}

/**
 * サムネイルを差し替えるべき対象を返す。scraped は今回の一覧取得で分かった
 * （mercariItemId, 画像URL）の組。判定規則：
 *   (a) thumb_path が無い → 対象（新規保存）
 *   (b) thumb_path はあるが thumb_src が無い（旧データ）→ 対象にせず、今の src を記録するだけ
 *   (c) thumb_src はあるが正規化した URL と違う → 対象（差し替え）
 * (a) を先、(c) を後の順で返す（予算は呼び出し側の収集が切る）。画像URLが無いものは対象外。
 * 旧ファイルの削除はしない（収集側の仕事）。
 */
export async function listingsNeedingThumb(
  ctx: Ctx, scraped: Array<{ mercariItemId: string; thumbUrl: string | null }>,
): Promise<Array<{ id: string; thumbUrl: string }>> {
  const withUrl = scraped.filter((r): r is { mercariItemId: string; thumbUrl: string } => !!r.thumbUrl)
  if (withUrl.length === 0) return []

  const rows = await ctx.sql.all<{ id: string; thumbPath: string | null; thumbSrc: string | null }>(`
    select channel_item_id as id, thumb_path as "thumbPath", thumb_src as "thumbSrc"
      from listing where channel_item_id = any(?::text[])
  `, withUrl.map(r => r.mercariItemId))
  const byId = new Map(rows.map(r => [r.id, r]))

  const toFetch: Array<{ id: string; thumbUrl: string }> = []
  const toReplace: Array<{ id: string; thumbUrl: string }> = []
  for (const r of withUrl) {
    const row = byId.get(r.mercariItemId)
    if (!row) continue
    const normalized = normalizeThumbSrc(r.thumbUrl)
    if (row.thumbPath === null) {
      toFetch.push({ id: r.mercariItemId, thumbUrl: r.thumbUrl })
    } else if (row.thumbSrc === null) {
      await ctx.sql.run('update listing set thumb_src = ? where channel_item_id = ?', normalized, r.mercariItemId)
    } else if (row.thumbSrc !== normalized) {
      toReplace.push({ id: r.mercariItemId, thumbUrl: r.thumbUrl })
    }
  }
  return [...toFetch, ...toReplace]
}

// ------------------------------------------------------------
// 横断検索
// ------------------------------------------------------------

const SEARCH_LISTING_STATUSES: ListingStatus[] = ['active', 'suspended', 'sold', 'ended']

// 出品の状態の表示名は shared/types.ts の LISTING_STATUS_LABEL が唯一の正
// （検索結果と画面で呼び名が食い違わないように）
export function listingStatusLabel(status: ListingStatus): string {
  return LISTING_STATUS_LABEL[status]
}

export async function searchListingHits(ctx: Ctx, terms: string[], perKind: number): Promise<SearchHit[]> {
  const listings = await listListings(ctx, { status: SEARCH_LISTING_STATUSES })

  const hits: SearchHit[] = listings
    .filter(l => matchesQuery([
      l.title, ...l.model_codes,
      ...l.items.map(i => i.name), ...l.items.map(i => i.model_code),
    ], terms))
    .map(l => ({
      kind: 'listing' as const,
      id: l.mercari_item_id,
      title: l.title,
      model_code: l.model_codes[0] ?? null,
      status_label: listingStatusLabel(l.status),
      amount: l.price,
      date: l.first_seen_at,
      thumb_url: l.thumb_url,
    }))

  return sortAndSlice(hits, perKind)
}

// ------------------------------------------------------------
// API として登録する（引数は信用しない。型が違えば UserError）。
// 収集が使う関数（upsertListings・takeOverListing・setListingThumb ほか）は export するだけで登録しない
// ------------------------------------------------------------

registerHandler('listListings', (ctx, filter) => listListings(ctx, filter ?? undefined))
registerHandler('reserveInventory', (ctx, mercariItemId, inventoryItemIds, opts) => {
  const o = argOptObject('オプション', opts)
  return reserveInventory(ctx, mercariItemId, inventoryItemIds, o ? { takeFromSale: argOptBool('付け替え', o.takeFromSale) } : undefined)
})
registerHandler('unreserveInventory', (ctx, mercariItemId, inventoryItemId) =>
  unreserveInventory(ctx, mercariItemId, inventoryItemId))
registerHandler('suggestForListing', (ctx, mercariItemId, limit, opts) => {
  const o = argOptObject('オプション', opts)
  return suggestForListing(
    ctx, mercariItemId, argOptInt('件数', limit, { min: 1, max: 1000 }) ?? 20,
    o ? { includeSold: argOptBool('販売済みを含める', o.includeSold) } : undefined,
  )
})
registerHandler('endListing', (ctx, mercariItemId) => endListing(ctx, mercariItemId))
registerHandler('autoReserveListings', (ctx, listingIds) =>
  autoReserveListings(ctx, argOptArray('出品', listingIds, { max: 10_000 }) as string[] | undefined))
registerHandler('setListingShipping', (ctx, mercariItemId, shippingMethodId) =>
  setListingShipping(ctx, mercariItemId, shippingMethodId ?? null))
