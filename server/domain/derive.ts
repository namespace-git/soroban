import type { Ctx } from '../context'
import type { InventoryItem, ListingStatus, SalesChannel, Tag } from '../../src/shared/types'
import { loadTagsFor, mediaUrl, mergeInheritedTags } from './_shared'

// ============================================================
// 派生（タグと画像）
//
// 仕入・商品（型番）・在庫のタグは、下流（在庫・販売）へコピーせず「派生」で見せる。
// ここは読み出しだけ。在庫・販売・出品のドメインが一覧を組み立てるときに使う。
// src/main/db.ts の loadPurchaseTagsForInventory ほか、attachInventoryTags・productImageFiles の移植。
// ============================================================

interface TagRow { owner_id: string; id: string; name: string; sort_order: number }

function groupTags(rows: TagRow[]): Map<string, Tag[]> {
  const map = new Map<string, Tag[]>()
  for (const r of rows) {
    const arr = map.get(r.owner_id) ?? []
    arr.push({ id: r.id, name: r.name, sort_order: r.sort_order })
    map.set(r.owner_id, arr)
  }
  return map
}

/**
 * 在庫が「派生」で持つタグのうち、仕入から来るもの
 * （purchase_line → purchase に付いた purchase_tag）を1クエリで引く。
 */
export async function loadPurchaseTagsForInventory(ctx: Ctx, itemIds: string[]): Promise<Map<string, Tag[]>> {
  if (itemIds.length === 0) return new Map()
  const rows = await ctx.sql.all<TagRow>(`
    select i.id as owner_id, t.id, t.name, t.sort_order
      from inventory_item i
      join purchase_line pl on pl.household_id = i.household_id and pl.id = i.purchase_line_id
      join purchase_tag  pt on pt.household_id = pl.household_id and pt.purchase_id = pl.purchase_id
      join tag t on t.household_id = pt.household_id and t.id = pt.tag_id
     where i.id = any(?::uuid[])
     order by t.sort_order, t.name collate "C"
  `, itemIds)
  return groupTags(rows)
}

/**
 * 在庫が「派生」で持つタグのうち、商品（型番）から来るもの（product_tag。model_code一致）。
 * model_code の無い在庫（私物の手入力等）は対象外。
 */
export async function loadProductTagsForInventory(
  ctx: Ctx, items: Array<{ id: string; model_code: string | null }>,
): Promise<Map<string, Tag[]>> {
  const map = new Map<string, Tag[]>()
  const withCode = items.filter((i): i is { id: string; model_code: string } => !!i.model_code)
  if (withCode.length === 0) return map

  const codes = [...new Set(withCode.map(i => i.model_code))]
  const rows = await ctx.sql.all<{ model_code: string; id: string; name: string; sort_order: number }>(`
    select pt.model_code as model_code, t.id, t.name, t.sort_order
      from product_tag pt
      join tag t on t.household_id = pt.household_id and t.id = pt.tag_id
     where pt.model_code = any(?::text[])
     order by t.sort_order, t.name collate "C"
  `, codes)

  const byCode = new Map<string, Tag[]>()
  for (const r of rows) {
    const arr = byCode.get(r.model_code) ?? []
    arr.push({ id: r.id, name: r.name, sort_order: r.sort_order })
    byCode.set(r.model_code, arr)
  }
  for (const i of withCode) {
    map.set(i.id, byCode.get(i.model_code) ?? [])
  }
  return map
}

/** 販売が「派生」で持つタグのうち、紐付いた在庫の直接タグ（inventory_tag）由来。 */
export async function loadInventoryTagsForSales(ctx: Ctx, saleIds: string[]): Promise<Map<string, Tag[]>> {
  if (saleIds.length === 0) return new Map()
  const rows = await ctx.sql.all<TagRow>(`
    select sl.sale_id as owner_id, t.id, t.name, t.sort_order
      from sale_line sl
      join inventory_tag it on it.household_id = sl.household_id and it.inventory_item_id = sl.inventory_item_id
      join tag t on t.household_id = it.household_id and t.id = it.tag_id
     where sl.sale_id = any(?::uuid[])
     order by t.sort_order, t.name collate "C"
  `, saleIds)
  return groupTags(rows)
}

/** 販売が「派生」で持つタグのうち、紐付いた在庫の仕入（purchase_tag）由来。 */
export async function loadPurchaseTagsForSales(ctx: Ctx, saleIds: string[]): Promise<Map<string, Tag[]>> {
  if (saleIds.length === 0) return new Map()
  const rows = await ctx.sql.all<TagRow>(`
    select sl.sale_id as owner_id, t.id, t.name, t.sort_order
      from sale_line sl
      join inventory_item i on i.household_id = sl.household_id and i.id = sl.inventory_item_id
      join purchase_line pl on pl.household_id = i.household_id and pl.id = i.purchase_line_id
      join purchase_tag  pt on pt.household_id = pl.household_id and pt.purchase_id = pl.purchase_id
      join tag t on t.household_id = pt.household_id and t.id = pt.tag_id
     where sl.sale_id = any(?::uuid[])
     order by t.sort_order, t.name collate "C"
  `, saleIds)
  return groupTags(rows)
}

/** 販売が「派生」で持つタグのうち、紐付いた在庫の商品（型番。product_tag）由来。 */
export async function loadProductTagsForSales(ctx: Ctx, saleIds: string[]): Promise<Map<string, Tag[]>> {
  if (saleIds.length === 0) return new Map()
  const rows = await ctx.sql.all<TagRow>(`
    select sl.sale_id as owner_id, t.id, t.name, t.sort_order
      from sale_line sl
      join inventory_item i on i.household_id = sl.household_id and i.id = sl.inventory_item_id
      join product_tag  pt on pt.household_id = i.household_id and pt.model_code = i.model_code
      join tag t on t.household_id = pt.household_id and t.id = pt.tag_id
     where sl.sale_id = any(?::uuid[])
     group by sl.sale_id, t.id, t.name, t.sort_order
     order by t.sort_order, t.name collate "C"
  `, saleIds)
  return groupTags(rows)
}

// ------------------------------------------------------------
// 在庫の一覧（inventory_view）の行に、タグ・サムネイル・出品・販売先をつける
// ------------------------------------------------------------

/**
 * inventory_view の読む列。ビューの最後に household_id が付いているので `select *` では読まない。
 * alias を渡すと `iv.id, iv.item_code, …` の形で返す（join と並べて読むとき）
 */
export function inventoryViewColumns(alias?: string): string {
  // alias は SQL にそのまま埋め込むので、識別子の形だけを通す（画面からの値は絶対に渡さない）
  if (alias !== undefined && !/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`不正な別名です: ${alias}`)
  const cols = [
    'id', 'item_code', 'name', 'landed_cost', 'acquired_at', 'status', 'aging_days', 'order_no',
    'shop_account_name', 'model_code', 'product_name', 'series_code', 'material', 'parent_id', 'note',
    'fulfillment', 'thumb_path', 'sold_sale_id', 'sold_title', 'sold_price', 'sold_sold_at',
    'listing_id', 'listing_channel', 'listing_price', 'listing_status',
  ]
  return cols.map(c => (alias ? `${alias}.${c}` : c)).join(', ')
}

/**
 * inventory_view の1行。thumb_url・listing・sold_to は組み立てる前の生の列。
 * listing_id は出品先での商品ID（listing.channel_item_id。listing.id の uuid ではない）
 */
export type InventoryRow = Omit<InventoryItem, 'tags' | 'inherited_tags' | 'thumb_url' | 'listing' | 'sold_to'> & {
  thumb_path: string | null
  listing_id: string | null
  listing_channel: SalesChannel | null
  listing_price: number | null
  listing_status: ListingStatus | null
  sold_sale_id: string | null
  sold_title: string | null
  sold_price: number | null
  sold_sold_at: string | null
}

/**
 * in_stock（等）を inventory_view から引いた結果に、まとめて引いた直接タグと
 * 派生タグ（仕入・商品＝型番から。優先順位 purchase > product。tags と重複するものは除く）を付ける。
 * サムネイルが無い（＝未販売の）行は、型番があれば商品画像（productImageFiles）で埋める。
 */
export async function attachInventoryTags(ctx: Ctx, items: InventoryRow[]): Promise<InventoryItem[]> {
  const ids = items.map(i => i.id)
  const tagMap = await loadTagsFor(ctx, 'inventory_tag', 'inventory_item_id', ids)
  const purchaseMap = await loadPurchaseTagsForInventory(ctx, ids)
  const productMap = await loadProductTagsForInventory(ctx, items)

  const missingThumbCodes = [...new Set(
    items.filter(i => !i.thumb_path && i.model_code).map(i => i.model_code as string),
  )]
  const imageMap = await productImageFiles(ctx, missingThumbCodes)

  return items.map(i => {
    const {
      thumb_path, listing_id, listing_channel, listing_price, listing_status,
      sold_sale_id, sold_title, sold_price, sold_sold_at, ...rest
    } = i
    const tags = tagMap.get(i.id) ?? []
    const directIds = new Set(tags.map(t => t.id))
    const inherited_tags = mergeInheritedTags(directIds, [
      { from: 'purchase', tags: purchaseMap.get(i.id) ?? [] },
      { from: 'product', tags: productMap.get(i.id) ?? [] },
    ])
    const fallbackThumb = !thumb_path && i.model_code ? imageMap.get(i.model_code)?.path ?? null : null
    return {
      ...rest,
      thumb_url: mediaUrl(ctx, thumb_path ?? fallbackThumb),
      tags,
      inherited_tags,
      listing: listing_id
        ? { channel: listing_channel!, mercari_item_id: listing_id, price: listing_price!, status: listing_status! }
        : null,
      sold_to: sold_sale_id
        ? { sale_id: sold_sale_id, title: sold_title!, price: sold_price!, sold_at: sold_sold_at! }
        : null,
    }
  })
}

// ------------------------------------------------------------
// 商品（型番）の画像
// ------------------------------------------------------------

/**
 * 型番ごとの商品画像（Storage のパス）を優先順位で決める：
 *   ① product_image（人がセット。setProductImage）→ manual: true
 *   ② その型番の仕入先（メロジョイ）の商品画像（purchase_line.image_path、注文日が最新の明細）
 *   ③ その型番の最新の出品の画像（listing_line 経由、またはタイトルに型番文字列を含む。
 *      last_seen_at が新しい順、画像があるもの）
 *   ④ その型番の最新の販売の画像（sale_line 経由、sold_at が新しい順）
 * 画像が無い型番は Map に入れない。画面に出す URL は呼ぶ側が `mediaUrl(ctx, path)` で作る。
 *
 * デスクトップ版は型番ごとに SQL を投げていた（N+1）。ここは優先順位ごとに1本ずつ、全部の型番をまとめて引く
 * （同じ型番に同じ順位の候補が複数あるとき、並びの決め方は desktop と同じ。同着は新しく作った方）
 */
export async function productImageFiles(
  ctx: Ctx, modelCodes: string[],
): Promise<Map<string, { path: string; manual: boolean }>> {
  const map = new Map<string, { path: string; manual: boolean }>()
  const codes = [...new Set(modelCodes)]
  if (codes.length === 0) return map

  const remaining = new Set(codes)
  const pick = (rows: Array<{ code: string; path: string | null }>, manual: boolean) => {
    for (const r of rows) {
      if (r.path && remaining.has(r.code)) {
        map.set(r.code, { path: r.path, manual })
        remaining.delete(r.code)
      }
    }
  }

  // ① 人がセットした画像
  pick(await ctx.sql.all<{ code: string; path: string }>(
    'select model_code as code, path from product_image where model_code = any(?::text[])', codes,
  ), true)
  if (remaining.size === 0) return map

  // ② その型番の仕入先（メロジョイ）の商品画像。注文日（ordered_at）が最新の明細を使う
  pick(await ctx.sql.all<{ code: string; path: string }>(`
    select distinct on (pl.model_code) pl.model_code as code, pl.image_path as path
      from purchase_line pl
      join purchase p on p.household_id = pl.household_id and p.id = pl.purchase_id
     where pl.model_code = any(?::text[]) and pl.image_path is not null
     order by pl.model_code, p.ordered_at desc, pl.created_at desc, pl.sort_order desc, pl.id
  `, [...remaining]), false)
  if (remaining.size === 0) return map

  // ③ その型番の最新の出品（listing_line 経由、またはタイトルに型番文字列を含む）
  pick(await ctx.sql.all<{ code: string; path: string }>(`
    select distinct on (c.code) c.code as code, c.thumb_path as path
      from (
        select i.model_code as code, l.thumb_path, l.last_seen_at
          from listing l
          join listing_line ll on ll.household_id = l.household_id and ll.listing_id = l.id
          join inventory_item i on i.household_id = ll.household_id and i.id = ll.inventory_item_id
         where i.model_code = any(?::text[]) and l.thumb_path is not null
        union all
        select k.code, l.thumb_path, l.last_seen_at
          from unnest(?::text[]) as k(code)
          join listing l on position(lower(k.code) in lower(l.title)) > 0
         where l.thumb_path is not null
      ) c
     order by c.code, c.last_seen_at desc
  `, [...remaining], [...remaining]), false)
  if (remaining.size === 0) return map

  // ④ その型番の最新の販売（取り込みで画像が取れていなければ、そこで終わり。古い販売の画像には遡らない）
  pick(await ctx.sql.all<{ code: string; path: string | null }>(`
    select distinct on (i.model_code) i.model_code as code, s.thumb_path as path
      from inventory_item i
      join sale_line sl on sl.household_id = i.household_id and sl.inventory_item_id = i.id
      join sale s on s.household_id = sl.household_id and s.id = sl.sale_id
     where i.model_code = any(?::text[])
     order by i.model_code, s.sold_at desc, s.created_at desc, s.id
  `, [...remaining]), false)

  return map
}
