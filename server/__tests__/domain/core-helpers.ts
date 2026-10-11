import type { Ctx } from '../../context'
import {
  allocate, extractCode, extractMaterial, splitEvenly,
} from '../../domain/_shared'
import * as derive from '../../domain/derive'
import * as inventory from '../../domain/inventory'
import { nextItemCodes } from '../../domain/inventory'
import * as listing from '../../domain/listing'
import * as master from '../../domain/master'
import * as sale from '../../domain/sale'
import type {
  InventoryPatch, InventoryStatus, ListingStatus, SaleFilter, SaleInput, SaleKind, SalePatch, SalesChannel,
  ShippingMethod,
} from '../../../src/shared/types'
import type { Member } from './helpers'

// 在庫・出品・販売・紐付け（server/domain/{derive,inventory,listing,sale}.ts）のテスト用の道具。
//
// 仕入のドメイン（purchase.ts）とは独立させるため、仕入と在庫の作成は **SQL で直接** 行う。
// 按分の計算は desktop の insertLinesAndItems（src/main/db.ts）と同じ（allocate → 明細ごとに splitEvenly）。

export interface SeedLine {
  name: string
  unit_price: number
  quantity: number
  /** 省略すると商品名から自動抽出（desktop の resolveLineCode と同じ）。null を渡すと型番なし */
  model_code?: string | null
  series_code?: string | null
  material?: string | null
  image_path?: string | null
}

export interface SeedPurchase {
  shopId: string
  ordered_at: string
  shipping_fee?: number
  discount?: number
  other_cost?: number
  alloc_method?: 'by_amount' | 'by_quantity'
  fulfillment?: 'pending' | 'shipped' | 'delivered' | null
  lines: SeedLine[]
}

/** desktop の createPurchase 相当（確定済み）。在庫は数量分だけ作り、landed_cost はここで確定する */
export async function seedPurchase(ctx: Ctx, p: SeedPurchase): Promise<string> {
  const method = p.alloc_method ?? 'by_amount'
  const pool = (p.shipping_fee ?? 0) + (p.other_cost ?? 0) - (p.discount ?? 0)
  const purchase = await ctx.sql.get<{ id: string }>(`
    insert into purchase (shop_account_id, ordered_at, shipping_fee, discount, other_cost, alloc_method, status, fulfillment)
    values (?, ?, ?, ?, ?, ?, 'confirmed', ?) returning id
  `, p.shopId, p.ordered_at, p.shipping_fee ?? 0, p.discount ?? 0, p.other_cost ?? 0, method, p.fulfillment ?? null)

  const lineRows = p.lines.map((l, i) => {
    const extracted = extractCode(l.name)
    return {
      id: `line-${i}`,
      name: l.name,
      unit_price: l.unit_price,
      quantity: l.quantity,
      sort_order: i,
      image_path: l.image_path ?? null,
      model_code: l.model_code !== undefined ? l.model_code : extracted?.model_code ?? null,
      series_code: l.series_code !== undefined ? l.series_code : extracted?.series_code ?? null,
      material: l.material !== undefined ? l.material : extractMaterial(l.name),
    }
  })
  const alloc = allocate(lineRows, pool, method)

  for (const l of lineRows) {
    const a = alloc.get(l.id)!
    const baseUnit = l.unit_price + Math.floor(a.allocated / l.quantity)
    const line = await ctx.sql.get<{ id: string }>(`
      insert into purchase_line
        (purchase_id, name, unit_price, quantity, model_code, series_code, material,
         allocated_cost, landed_unit_cost, sort_order, image_path)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id
    `, purchase!.id, l.name, l.unit_price, l.quantity, l.model_code, l.series_code, l.material,
      a.allocated, baseUnit, l.sort_order, l.image_path)

    const parts = splitEvenly(a.allocated, l.quantity)
    const codes = await nextItemCodes(ctx, l.quantity)
    for (let n = 0; n < l.quantity; n++) {
      await ctx.sql.run(`
        insert into inventory_item
          (item_code, purchase_line_id, name, landed_cost, acquired_at, model_code, series_code, material)
        values (?, ?, ?, ?, ?, ?, ?, ?)
      `, codes[n], line!.id, l.name, l.unit_price + parts[n], p.ordered_at, l.model_code, l.series_code, l.material)
    }
  }
  return purchase!.id
}

/** 仕入を 1 件作って、できた在庫の id を作った順（明細順 → 在庫コード順）に返す */
export async function seedItems(ctx: Ctx, p: SeedPurchase): Promise<string[]> {
  const purchaseId = await seedPurchase(ctx, p)
  return itemIdsOfPurchase(ctx, purchaseId)
}

async function itemIdsOfPurchase(ctx: Ctx, purchaseId: string): Promise<string[]> {
  const rows = await ctx.sql.all<{ id: string }>(`
    select i.id from inventory_item i
      join purchase_line pl on pl.household_id = i.household_id and pl.id = i.purchase_line_id
     where pl.purchase_id = ?
     order by pl.sort_order, length(i.item_code), i.item_code
  `, purchaseId)
  return rows.map(r => r.id)
}

/** 世帯の `run` を取り出す（beforeEach で world が入れ替わるので、呼ぶたびに最新を見る） */
export type MemberGetter = () => Member

/** desktop の `createPurchase(input)` と同じ形の入力（仕入のドメインが無くても在庫が作れる） */
export interface PurchaseInputLike extends Omit<SeedPurchase, 'shopId'> {
  shop_account_id: string
}

/**
 * 元のテストの `db.` と同じ形で呼べる薄い包み。1 回の呼び出し＝1 リクエスト＝1 トランザクション。
 * 仕入と在庫の作成（createPurchase）だけは SQL の直接投入（seedPurchase）で、それ以外は本物のドメイン関数。
 */
export function bindDb(getMember: MemberGetter) {
  const A = <T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> => getMember().run(fn)
  return {
    // ---- 仕入・マスタ（仕入のドメインの代わりに SQL で直接）----
    createPurchase: (input: PurchaseInputLike): Promise<string> =>
      A((c) => seedPurchase(c, { ...input, shopId: input.shop_account_id })),
    /** 仕入を作って、できた在庫の id を返す（desktop の `getPurchase(id).lines[0].items[0].id` の置き換え） */
    createPurchaseItems: (input: PurchaseInputLike): Promise<string[]> =>
      A((c) => seedItems(c, { ...input, shopId: input.shop_account_id })),
    /** 仕入の最初の明細に、仕入先の商品画像のパスを付ける（desktop の setPurchaseLineImage の置き換え） */
    setFirstLineImage: (purchaseId: string, path: string) =>
      A((c) => c.sql.run(
        `update purchase_line set image_path = ?
          where id = (select id from purchase_line where purchase_id = ? order by sort_order, created_at limit 1)`,
        path, purchaseId,
      )),
    /** 仕入にタグを付ける（desktop の setPurchaseTags の置き換え。丸ごと置き換え） */
    setPurchaseTags: (purchaseId: string, tagIds: string[]) =>
      A(async (c) => {
        await c.sql.run('delete from purchase_tag where purchase_id = ?', purchaseId)
        for (const t of tagIds) await c.sql.run('insert into purchase_tag (purchase_id, tag_id) values (?, ?)', purchaseId, t)
      }),
    /** 型番にタグを付ける（desktop の setProductTags の置き換え。丸ごと置き換え） */
    setProductTags: (modelCode: string, tagIds: string[]) =>
      A(async (c) => {
        await c.sql.run('delete from product_tag where model_code = ?', modelCode)
        for (const t of tagIds) await c.sql.run('insert into product_tag (model_code, tag_id) values (?, ?)', modelCode, t)
      }),
    /** 型番の表示名を付ける（desktop の setProductName の置き換え） */
    setProductName: (modelCode: string, name: string) =>
      A((c) => c.sql.run(
        `insert into product_name (model_code, name, updated_at) values (?, ?, now())
         on conflict (household_id, model_code) do update set name = excluded.name, updated_at = excluded.updated_at`,
        modelCode, name,
      )),
    /** 人がセットした商品画像（desktop の upsertProductImage の置き換え） */
    upsertProductImage: (modelCode: string, path: string) =>
      A((c) => c.sql.run(
        `insert into product_image (model_code, path) values (?, ?)
         on conflict (household_id, model_code) do update set path = excluded.path, updated_at = now()`,
        modelCode, path,
      )),
    createShopAccount: (name: string): Promise<string> => A((c) => master.createShopAccount(c, name)),
    createTag: (name: string): Promise<string> => A((c) => master.createTag(c, name)),
    deleteTag: (id: string) => A((c) => master.deleteTag(c, id)),
    listTags: () => A((c) => master.listTags(c)),
    setSetting: (key: string, value: string) => A((c) => master.setSetting(c, key, value)),
    getSettings: () => A((c) => master.getSettings(c)),
    listShippingMethods: (): Promise<ShippingMethod[]> => A((c) => master.listShippingMethods(c)),
    saveShippingMethod: (m: Parameters<typeof master.saveShippingMethod>[1]) => A((c) => master.saveShippingMethod(c, m)),
    deleteShippingMethod: (id: string) => A((c) => master.deleteShippingMethod(c, id)),

    // ---- 在庫 ----
    listInventory: (status?: InventoryStatus) => A((c) => inventory.listInventory(c, status)),
    updateInventory: (id: string, patch: InventoryPatch) => A((c) => inventory.updateInventory(c, id, patch)),
    splitInventory: (id: string, count: number) => A((c) => inventory.splitInventory(c, id, count)),
    mergeSplitInventory: (parentId: string) => A((c) => inventory.mergeSplitInventory(c, parentId)),
    disposeInventory: (id: string, note: string, status?: 'disposed' | 'personal_use') =>
      A((c) => inventory.disposeInventory(c, id, note, status)),
    restoreInventory: (id: string) => A((c) => inventory.restoreInventory(c, id)),
    setInventoryTags: (itemId: string, tagIds: string[]) => A((c) => inventory.setInventoryTags(c, itemId, tagIds)),
    /** 画面の入口と同じ（紐付けの種類は manual） */
    linkInventory: (saleId: string, itemIds: string[], opts?: { takeFromSale?: boolean }) =>
      A((c) => inventory.linkInventory(c, saleId, itemIds, 'manual', opts)),
    /** 紐付けの種類を指定して紐付ける（収集・自動確定の経路。画面は受けない） */
    linkInventoryAs: (saleId: string, itemIds: string[], source: 'auto' | 'manual' | 'listing', opts?: { takeFromSale?: boolean }) =>
      A((c) => inventory.linkInventory(c, saleId, itemIds, source, opts)),
    unlinkInventory: (saleId: string, itemId: string) => A((c) => inventory.unlinkInventory(c, saleId, itemId)),
    suggestInventory: (saleId: string, limit?: number, opts?: { includeSold?: boolean }) =>
      A((c) => inventory.suggestInventory(c, saleId, limit, opts)),
    suggestProductInventory: (modelCode: string, quantity: number, excludeIds?: string[]) =>
      A((c) => inventory.suggestProductInventory(c, modelCode, quantity, excludeIds)),
    nextItemCode: () => A((c) => inventory.nextItemCode(c)),
    exportInventoryRows: () => A((c) => inventory.exportInventoryRows(c)),
    searchInventoryHits: (terms: string[], perKind: number) => A((c) => inventory.searchInventoryHits(c, terms, perKind)),
    productImageFiles: (codes: string[]) => A((c) => derive.productImageFiles(c, codes)),

    // ---- 出品 ----
    upsertListings: (rows: Parameters<typeof listing.upsertListings>[1], channel?: SalesChannel) =>
      A((c) => listing.upsertListings(c, rows, channel)),
    listListings: (filter?: { status?: ListingStatus[]; onlyUnallocated?: boolean }) => A((c) => listing.listListings(c, filter)),
    reserveInventory: (itemId: string, ids: string[], opts?: { takeFromSale?: boolean }) =>
      A((c) => listing.reserveInventory(c, itemId, ids, opts)),
    unreserveInventory: (itemId: string, inventoryItemId: string) =>
      A((c) => listing.unreserveInventory(c, itemId, inventoryItemId)),
    suggestForListing: (itemId: string, limit?: number, opts?: { includeSold?: boolean }) =>
      A((c) => listing.suggestForListing(c, itemId, limit, opts)),
    endListing: (itemId: string) => A((c) => listing.endListing(c, itemId)),
    autoReserveListings: (ids?: string[]) => A((c) => listing.autoReserveListings(c, ids)),
    setListingShipping: (itemId: string, methodId: string | null) => A((c) => listing.setListingShipping(c, itemId, methodId)),
    setListingThumb: (itemId: string, path: string, src?: string | null) => A((c) => listing.setListingThumb(c, itemId, path, src)),
    listingsNeedingThumb: (scraped: Array<{ mercariItemId: string; thumbUrl: string | null }>) =>
      A((c) => listing.listingsNeedingThumb(c, scraped)),
    listingsWithoutThumb: (ids: string[]) => A((c) => listing.listingsWithoutThumb(c, ids)),
    searchListingHits: (terms: string[], perKind: number) => A((c) => listing.searchListingHits(c, terms, perKind)),

    // ---- 販売 ----
    createSale: (input: SaleInput) => A((c) => sale.createSale(c, input)),
    updateSale: (id: string, patch: SalePatch) => A((c) => sale.updateSale(c, id, patch)),
    deleteSale: (id: string) => A((c) => sale.deleteSale(c, id)),
    listSales: (filter?: SaleFilter) => A((c) => sale.listSales(c, filter)),
    saleTotals: (filter?: SaleFilter) => A((c) => sale.saleTotals(c, filter)),
    setSaleTags: (saleId: string, tagIds: string[]) => A((c) => sale.setSaleTags(c, saleId, tagIds)),
    listSaleLines: (saleId: string) => A((c) => sale.listSaleLines(c, saleId)),
    autoLinkSale: (saleId: string) => A((c) => sale.autoLinkSale(c, saleId)),
    autoLinkPending: (ids?: string[]) => A((c) => sale.autoLinkPending(c, ids)),
    getAutoLinkBlockers: (saleId: string) => A((c) => sale.getAutoLinkBlockers(c, saleId)),
    appendModelCodes: (saleId: string, codes: string[]) => A((c) => sale.appendModelCodes(c, saleId, codes)),
    estimateSaleProfit: (input: Parameters<typeof sale.estimateSaleProfit>[1]) => A((c) => sale.estimateSaleProfit(c, input)),
    applySaleActuals: (id: string, actuals: Parameters<typeof sale.applySaleActuals>[2]) =>
      A((c) => sale.applySaleActuals(c, id, actuals)),
    insertCollected: (rows: Parameters<typeof sale.insertCollected>[1], channel?: SalesChannel) =>
      A((c) => sale.insertCollected(c, rows, channel)),
    updateCollectedActuals: (rows: Parameters<typeof sale.updateCollectedActuals>[1]) =>
      A((c) => sale.updateCollectedActuals(c, rows)),
    updateYahooActuals: (rows: Parameters<typeof sale.updateYahooActuals>[1]) => A((c) => sale.updateYahooActuals(c, rows)),
    updateSaleStatus: (itemId: string, status: Parameters<typeof sale.updateSaleStatus>[2], seenAt?: string) =>
      A((c) => sale.updateSaleStatus(c, itemId, status, seenAt)),
    setSalePurchasedAt: (saleId: string, purchasedAt: string | null) => A((c) => sale.setSalePurchasedAt(c, saleId, purchasedAt)),
    salesNeedingPurchasedAt: (limit: number) => A((c) => sale.salesNeedingPurchasedAt(c, limit)),
    setSaleThumb: (saleId: string, path: string, src?: string | null) => A((c) => sale.setSaleThumb(c, saleId, path, src)),
    salesNeedingThumb: (scraped: Array<{ mercariItemId: string; thumbUrl: string | null }>) =>
      A((c) => sale.salesNeedingThumb(c, scraped)),
    salesWithoutThumb: (ids: string[]) => A((c) => sale.salesWithoutThumb(c, ids)),
    existingMercariIds: (ids: string[]) => A((c) => sale.existingMercariIds(c, ids)),
    saleMercariItemId: (saleId: string) => A((c) => sale.saleMercariItemId(c, saleId)),
    isMercariItemExcluded: (itemId: string) => A((c) => sale.isMercariItemExcluded(c, itemId)),
    listSaleExclusions: () => A((c) => sale.listSaleExclusions(c)),
    removeSaleExclusion: (itemId: string) => A((c) => sale.removeSaleExclusion(c, itemId)),
    hoursSinceLastOk: () => A((c) => sale.hoursSinceLastOk(c)),
    searchSaleHits: (terms: string[], perKind: number) => A((c) => sale.searchSaleHits(c, terms, perKind)),
    saleKindOf: (saleId: string): Promise<SaleKind | undefined> =>
      A(async (c) => (await c.sql.get<{ kind: SaleKind }>('select kind from sale where id = ?', saleId))?.kind),

    // ---- SQL を直接（desktop の `getDb().prepare(…)` の置き換え）----
    sql: <T = Record<string, unknown>>(text: string, ...params: unknown[]) => A((c) => c.sql.all<T>(text, ...params)),
    sqlRun: (text: string, ...params: unknown[]) => A((c) => c.sql.run(text, ...params)),
    sqlGet: <T = Record<string, unknown>>(text: string, ...params: unknown[]) => A((c) => c.sql.get<T>(text, ...params)),
  }
}
