import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Ctx } from '../../context'
import * as master from '../../domain/master'
import * as inventory from '../../domain/inventory'
import * as purchase from '../../domain/purchase'
import { normalizeSearchText, subtractDaysJst, todayJst } from '../../domain/_shared'
import type { Fulfillment, InventoryStatus, PurchaseInput } from '../../../src/shared/types'
import { MEDIA_BASE, newWorld, openDomainDb, type DomainDb, type World } from './helpers'

// src/main/__tests__/db.test.ts の db（:memory:）の中の、仕入・按分・配送・追跡・明細画像・店名の学習のテストを移したもの。
// 期待値は変えていない。書き換えたのは「呼び方」だけ：
//   * 同期の db.xxx(...) → await db.xxx(...)（db は下の薄い包み。1 回の呼び出し＝1 リクエスト＝1 トランザクション）
//   * expect(() => …).toThrow(x) → await expect(…).rejects.toThrow(x)
//   * id が uuid でないもの（'no-such-shop' など）は、uuid の形の「無い id」に変えた（DB の列が uuid のため）。
//     元の文字列そのままを渡したときの扱いは、purchase-web.test.ts で別に確かめている
//   * 販売・出品の作成は、このウェーブにまだ無いドメインの代わりに SQL で直接行う
// 期待値を変えたもの（理由つき）は、各テストのコメントに書いた

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const A = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)

/** 元のテストの `db.` と同じ形で呼べる、世帯 A の薄い包み */
const db = {
  createShopAccount: (name: string) => A((c) => master.createShopAccount(c, name)),
  getShopAccount: (id: string) => A((c) => master.getShopAccount(c, id)),
  updateShopAccount: (id: string, patch: Parameters<typeof master.updateShopAccount>[2]) => A((c) => master.updateShopAccount(c, id, patch)),
  createTag: (name: string) => A((c) => master.createTag(c, name)),

  createPurchase: (input: PurchaseInput) => A((c) => purchase.createPurchase(c, input)),
  importPurchases: (inputs: PurchaseInput[]) => A((c) => purchase.importPurchases(c, inputs)),
  createPurchaseDraft: (input: Parameters<typeof purchase.createPurchaseDraft>[1]) => A((c) => purchase.createPurchaseDraft(c, input)),
  confirmPurchase: (id: string, input: PurchaseInput) => A((c) => purchase.confirmPurchase(c, id, input)),
  listPurchases: () => A((c) => purchase.listPurchases(c)),
  getPurchase: (id: string) => A((c) => purchase.getPurchase(c, id)),
  setPurchaseTags: (id: string, tagIds: string[]) => A((c) => purchase.setPurchaseTags(c, id, tagIds)),
  deletePurchase: (id: string) => A((c) => purchase.deletePurchase(c, id)),
  existingImportKeys: (keys: string[]) => A((c) => purchase.existingImportKeys(c, keys)),

  updatePurchaseFulfillment: (importKey: string, f: Fulfillment | null) => A((c) => purchase.updatePurchaseFulfillment(c, importKey, f)),
  setPurchaseFulfillment: (id: string, f: Fulfillment | null) => A((c) => purchase.setPurchaseFulfillment(c, id, f)),
  applyFulfillmentFromShop: (id: string, f: Parameters<typeof purchase.applyFulfillmentFromShop>[2]) =>
    A((c) => purchase.applyFulfillmentFromShop(c, id, f)),
  getPurchaseTrackingNumber: (id: string) => A((c) => purchase.getPurchaseTrackingNumber(c, id)),
  getPurchaseTracking: (id: string) => A((c) => purchase.getPurchaseTracking(c, id)),
  applyTrackingResult: (id: string, r: Parameters<typeof purchase.applyTrackingResult>[2]) => A((c) => purchase.applyTrackingResult(c, id, r)),
  trackingCheckCandidates: (limit?: number) => A((c) => purchase.trackingCheckCandidates(c, limit)),
  trackingRegisterCandidates: () => A((c) => purchase.trackingRegisterCandidates(c)),
  markTrackingRegistered: (ids: string[]) => A((c) => purchase.markTrackingRegistered(c, ids)),
  trackingCounts: () => A((c) => purchase.trackingCounts(c)),

  purchaseLinesNeedingImage: (id: string, keywords?: string[]) => A((c) => purchase.purchaseLinesNeedingImage(c, id, keywords)),
  purchaseDetailRevisitCandidates: (shopId: string, keys: string[], keywords: string[], now?: Date) =>
    A((c) => purchase.purchaseDetailRevisitCandidates(c, shopId, keys, keywords, now)),
  setPurchaseImageChecked: (id: string) => A((c) => purchase.setPurchaseImageChecked(c, id)),
  setPurchaseLineImage: (lineId: string, path: string) => A((c) => purchase.setPurchaseLineImage(c, lineId, path)),
  setPurchaseLineImageUrls: (id: string, urls: Array<{ name: string; image_url: string }>) =>
    A((c) => purchase.setPurchaseLineImageUrls(c, id, urls)),

  learnShopAlias: (no: string, shop: string) => A((c) => purchase.learnShopAlias(c, no, shop)),
  lookupShopAlias: (no: string) => A((c) => purchase.lookupShopAlias(c, no)),
  isMellojoyOrderExcluded: (shopId: string, key: string, hash: string) => A((c) => purchase.isMellojoyOrderExcluded(c, shopId, key, hash)),
  markMellojoyOrderExcluded: (shopId: string, key: string, hash: string) => A((c) => purchase.markMellojoyOrderExcluded(c, shopId, key, hash)),

  exportPurchaseRows: (month?: string) => A((c) => purchase.exportPurchaseRows(c, month)),
  searchPurchaseHits: (query: string, perKind = 15) =>
    A((c) => purchase.searchPurchaseHits(c, normalizeSearchText(query).trim().split(/\s+/).filter(Boolean), perKind)),

  // ---- 在庫（在庫の担当の関数。ここでは読み取りと、紐付け・分割の準備にだけ使う）----
  listInventory: (status: InventoryStatus = 'in_stock') => A((c) => inventory.listInventory(c, status)),
  setInventoryTags: (id: string, tagIds: string[]) => A((c) => inventory.setInventoryTags(c, id, tagIds)),
  splitInventory: (id: string, count: number) => A((c) => inventory.splitInventory(c, id, count)),
  linkInventory: (saleId: string, itemIds: string[]) => A((c) => inventory.linkInventory(c, saleId, itemIds)),

  // ---- 販売・出品（それぞれのドメインが入るまでの代わり。SQL で直接）----
  createSale: (i: { title: string; sold_at: string; price: number }) =>
    A(async (c) => (await c.sql.get<{ id: string }>(
      'insert into sale (title, sold_at, price) values (?, ?, ?) returning id', i.title, i.sold_at, i.price,
    ))!.id),
  createListing: (channelItemId: string, title: string, price: number, status = 'active') =>
    A(async (c) => (await c.sql.get<{ id: string }>(
      `insert into listing (channel_item_id, title, price, status, first_seen_at, last_seen_at, listed_at)
       values (?, ?, ?, ?, '2026-01-01', now(), '2026-01-01') returning id`,
      channelItemId, title, price, status,
    ))!.id),
  reserve: (listingId: string, itemId: string) =>
    A((c) => c.sql.run('insert into listing_line (listing_id, inventory_item_id) values (?, ?)', listingId, itemId)),
  /** 画像 URL の理由を外すために、型番に人がセットした商品画像を持たせる／消す（商品の担当の upsertProductImage / deleteProductImage の代わり） */
  upsertProductImage: (modelCode: string, path: string) =>
    A((c) => c.sql.run(
      'insert into product_image (model_code, path) values (?, ?) on conflict (household_id, model_code) do update set path = excluded.path',
      modelCode, path,
    )),
  deleteProductImage: (modelCode: string) => A((c) => c.sql.run('delete from product_image where model_code = ?', modelCode)),
  sql: <T>(text: string, ...params: unknown[]) => A((c) => c.sql.all<T>(text, ...params)),
}

/** uuid の形で、どの行にも当たらない id（元のテストの 'no-such-id' の代わり） */
const NO_SUCH = '00000000-0000-4000-8000-000000000001'

describe('db（:memory:）の中の仕入', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('createPurchase：送料100・数量3の1行で在庫合計がpoolと一致する', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 100,
      lines: [{ name: 'テスト商品', unit_price: 1000, quantity: 3 }],
    })

    const items = await db.listInventory('in_stock')
    expect(items).toHaveLength(3)

    const totalLanded = items.reduce((s, i) => s + i.landed_cost, 0)
    // subtotal(1000*3=3000) + pool(100) = 3100 と一致するはず
    expect(totalLanded).toBe(3000 + 100)

    // 端数(100/3=33.33)は最後のアイテムに寄る
    const sorted = [...items].sort((a, b) => a.landed_cost - b.landed_cost)
    expect(sorted.map(i => i.landed_cost)).toEqual([1033, 1033, 1034])
  })

  it('createPurchase：複数行でも明細ごと・全体の合計が一致する', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-02',
      shipping_fee: 100,
      other_cost: 50,
      discount: 20,
      lines: [
        { name: '商品A', unit_price: 1000, quantity: 2 },
        { name: '商品B', unit_price: 500, quantity: 3 },
      ],
    })

    const items = await db.listInventory('in_stock')
    expect(items).toHaveLength(5)

    const subtotal = 1000 * 2 + 500 * 3
    const pool = 100 + 50 - 20
    const totalLanded = items.reduce((s, i) => s + i.landed_cost, 0)
    expect(totalLanded).toBe(subtotal + pool)

    const purchases = await db.listPurchases()
    expect(purchases[0].total_cost).toBe(subtotal + pool)
    expect(purchases[0].subtotal).toBe(subtotal)
  })

  it('listPurchases/getPurchase：first_line_name・first_model_codeは先頭明細（下書きで明細ゼロならnull）', async () => {
    const purchaseId = await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-02',
      shipping_fee: 0,
      lines: [
        { name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 },
        { name: 'いちごスフレ【Z072-8】', unit_price: 1500, quantity: 1 },
        { name: 'シーソルト【Z001-4】', unit_price: 900, quantity: 1 },
      ],
    })

    const summary = (await db.listPurchases()).find(p => p.id === purchaseId)!
    expect(summary.first_line_name).toBe('クリームわん【Z080-1】')
    expect(summary.first_model_code).toBe('Z080-1')

    const detail = await db.getPurchase(purchaseId)
    expect(detail.first_line_name).toBe('クリームわん【Z080-1】')
    expect(detail.first_model_code).toBe('Z080-1')

    const draftId = await db.createPurchaseDraft({
      import_key: 'empty-draft-1',
      shop_account_id: shopId,
      ordered_at: '2026-01-03',
      lines: [],
    })
    const draftSummary = (await db.listPurchases()).find(p => p.id === draftId)!
    expect(draftSummary.first_line_name).toBeNull()
    expect(draftSummary.first_model_code).toBeNull()
    expect((await db.getPurchase(draftId)).first_line_name).toBeNull()
  })

  it('下書き→確定：在庫は確定するまで作られず、按分後原価の合計が明細合計+送料と一致する', async () => {
    const draftId = await db.createPurchaseDraft({
      import_key: 'mellojoy-watch/2026-01-01-001',
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      lines: [
        { name: 'クリームわん【Z080-1】', quantity: 2 },
        { name: 'いちごスフレ【Z072-8】', quantity: 1 },
      ],
    })
    expect(draftId).not.toBe('')
    expect(await db.listInventory('in_stock')).toHaveLength(0)
    // 元は db.getDashboard().needsPurchaseConfirm（ホームの担当）。その元になっている「下書きの仕入の件数」を SQL で数える
    const drafts = async () => (await db.sql<{ n: number }>(`select count(*) as n from purchase where status = 'draft'`))[0].n
    expect(await drafts()).toBe(1)

    // 同じ import_key は積み直さない
    const dup = await db.createPurchaseDraft({
      import_key: 'mellojoy-watch/2026-01-01-001',
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      lines: [{ name: 'クリームわん【Z080-1】', quantity: 2 }],
    })
    expect(dup).toBe('')
    expect(await db.listPurchases()).toHaveLength(1)
    expect(await drafts()).toBe(1)

    const detail = await db.getPurchase(draftId)
    expect(detail.status).toBe('draft')
    expect(detail.lines.map(l => l.model_code)).toEqual(['Z080-1', 'Z072-8'])

    await db.confirmPurchase(draftId, {
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 300,
      lines: [
        { name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 2 },
        { name: 'いちごスフレ【Z072-8】', unit_price: 1500, quantity: 1 },
      ],
    })

    const confirmed = await db.getPurchase(draftId)
    expect(confirmed.status).toBe('confirmed')
    const subtotal = 1000 * 2 + 1500 * 1
    expect(confirmed.total_cost).toBe(subtotal + 300)

    const items = await db.listInventory('in_stock')
    expect(items).toHaveLength(3)
    expect(items.reduce((s, i) => s + i.landed_cost, 0)).toBe(subtotal + 300)
    expect(await drafts()).toBe(0)

    // 確定済みを再確定しようとすると例外（landed_cost は後から書き換えない）
    await expect(db.confirmPurchase(draftId, {
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      lines: [{ name: 'x', unit_price: 1, quantity: 1 }],
    })).rejects.toThrow()
  })

  it('createPurchaseDraft：order_no・shipping_fee・discount・unit_priceが取れていれば確定画面に前もって埋まる', async () => {
    const draftId = await db.createPurchaseDraft({
      import_key: 'order-100',
      shop_account_id: shopId,
      ordered_at: '2026-02-01',
      order_no: 'ORDER-100',
      shipping_fee: 300,
      discount: 50,
      lines: [{ name: 'いちごスフレ【Z072-8】', quantity: 2, unit_price: 800 }],
    })
    expect(draftId).not.toBe('')

    const detail = await db.getPurchase(draftId)
    expect(detail.order_no).toBe('ORDER-100')
    expect(detail.shipping_fee).toBe(300)
    expect(detail.discount).toBe(50)
    expect(detail.lines[0].unit_price).toBe(800)
  })

  it('createPurchase：import_keyが一致すればlistPurchasesに出る。同じkeyの2回目はthrow', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-02-01',
      import_key: 'order-200',
      lines: [{ name: '商品', unit_price: 1000, quantity: 1 }],
    })

    expect((await db.listPurchases())[0].import_key).toBe('order-200')
    expect(await db.existingImportKeys(['order-200', 'no-such-key'])).toEqual(new Set(['order-200']))

    await expect(db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-02-02',
      import_key: 'order-200',
      lines: [{ name: '別の商品', unit_price: 500, quantity: 1 }],
    })).rejects.toThrow('同じ注文が既に取り込まれています: order-200')

    // 2回目が弾かれているので仕入は1件のまま
    expect(await db.listPurchases()).toHaveLength(1)
  })

  describe('createPurchase：注文番号の重複を分かる言葉で断る', () => {
    it('同じ仕入先・同じ注文番号は2回目がエラー。別の仕入先なら通る', async () => {
      await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-01',
        order_no: 'ORD-1',
        lines: [{ name: '商品A', unit_price: 1000, quantity: 1 }],
      })

      await expect(db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-05',
        order_no: 'ORD-1',
        lines: [{ name: '商品B', unit_price: 1000, quantity: 1 }],
      })).rejects.toThrow('この仕入先には注文番号「ORD-1」の仕入が既にあります（2026-03-01 の登録）')

      const otherShopId = await db.createShopAccount('メロジョイB')
      await expect(db.createPurchase({
        shop_account_id: otherShopId,
        ordered_at: '2026-03-06',
        order_no: 'ORD-1',
        lines: [{ name: '商品C', unit_price: 1000, quantity: 1 }],
      })).resolves.toBeTruthy()

      // 弾かれた1件は登録されていない
      expect(await db.listPurchases()).toHaveLength(2)
    })

    it('注文番号がnull・空文字・空白だけなら何件でも通る（空文字はnullとして保存される）', async () => {
      await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-01',
        order_no: null,
        lines: [{ name: '商品A', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-02',
        order_no: '',
        lines: [{ name: '商品B', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-03',
        order_no: '   ',
        lines: [{ name: '商品C', unit_price: 1000, quantity: 1 }],
      })

      const list = await db.listPurchases()
      expect(list).toHaveLength(3)
      expect(list.every(p => p.order_no === null)).toBe(true)
    })

    it('他のCHECK/NOT NULL違反も日本語で弾く', async () => {
      // 元は 'no-such-shop'。uuid の形の「無い仕入先」に変えた（形が違う id は「指定が正しくありません」で断る）
      await expect(db.createPurchase({
        shop_account_id: NO_SUCH,
        ordered_at: '2026-03-01',
        lines: [{ name: '商品', unit_price: 1000, quantity: 1 }],
      })).rejects.toThrow('仕入先が見つかりません')

      await expect(db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-01',
        lines: [],
      })).rejects.toThrow('明細がありません')

      await expect(db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-01',
        lines: [{ name: '商品', unit_price: 1000, quantity: 0 }],
      })).rejects.toThrow('数量は1以上の整数で入力してください')

      await expect(db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-03-01',
        lines: [{ name: '商品', unit_price: -1, quantity: 1 }],
      })).rejects.toThrow('単価は整数で入力してください')

      await expect(db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026/03/01',
        lines: [{ name: '商品', unit_price: 1000, quantity: 1 }],
      })).rejects.toThrow('注文日はYYYY-MM-DDの形式で入力してください')
    })
  })

  describe('importPurchases：まとめて登録', () => {
    it('正常・DB重複・ファイル内重複が混ざっても、成功分だけ登録され失敗理由が返る', async () => {
      await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-04-01',
        order_no: 'DUP-1',
        lines: [{ name: '既存', unit_price: 1000, quantity: 1 }],
      })

      const result = await db.importPurchases([
        {
          shop_account_id: shopId,
          ordered_at: '2026-04-02',
          order_no: 'NEW-1',
          lines: [{ name: '新規', unit_price: 1000, quantity: 1 }],
        },
        {
          // DB既存と重複
          shop_account_id: shopId,
          ordered_at: '2026-04-03',
          order_no: 'DUP-1',
          lines: [{ name: 'DB重複', unit_price: 1000, quantity: 1 }],
        },
        {
          shop_account_id: shopId,
          ordered_at: '2026-04-04',
          order_no: 'SAME-IN-FILE',
          lines: [{ name: 'ファイル内1件目', unit_price: 1000, quantity: 1 }],
        },
        {
          // 同じ呼び出しの中で注文番号が重複
          shop_account_id: shopId,
          ordered_at: '2026-04-05',
          order_no: 'SAME-IN-FILE',
          lines: [{ name: 'ファイル内2件目', unit_price: 1000, quantity: 1 }],
        },
      ])

      expect(result.created).toBe(2)
      expect(result.skipped).toEqual([
        { index: 1, reason: expect.stringContaining('この仕入先には注文番号「DUP-1」の仕入が既にあります') },
        { index: 3, reason: '同じCSVの中で注文番号「SAME-IN-FILE」が重複しています' },
      ])

      const names = (await db.listPurchases()).map(p => p.first_line_name).sort()
      expect(names).toEqual(['新規', '既存', 'ファイル内1件目'].sort())
    })

    it('数量0の行はskipになり、他の行は登録される', async () => {
      const result = await db.importPurchases([
        {
          shop_account_id: shopId,
          ordered_at: '2026-05-01',
          lines: [{ name: '正常', unit_price: 1000, quantity: 1 }],
        },
        {
          shop_account_id: shopId,
          ordered_at: '2026-05-02',
          lines: [{ name: '数量0', unit_price: 1000, quantity: 0 }],
        },
        {
          shop_account_id: shopId,
          ordered_at: '2026-05-03',
          lines: [{ name: '正常2', unit_price: 500, quantity: 2 }],
        },
      ])

      expect(result.created).toBe(2)
      expect(result.skipped).toEqual([
        { index: 1, reason: expect.stringContaining('数量は1以上の整数で入力してください') },
      ])
    })
  })

  it('fulfillment：createPurchaseで指定した到着状態が仕入・在庫の両方に出て、updatePurchaseFulfillmentで更新できる', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-03-01',
      import_key: 'mellojoy:#111',
      fulfillment: 'pending',
      lines: [{ name: '到着状態テスト', unit_price: 1000, quantity: 1 }],
    })

    expect((await db.listPurchases())[0].fulfillment).toBe('pending')
    expect((await db.listInventory('in_stock'))[0].fulfillment).toBe('pending')

    // 一覧の状態が進んだら import_key で引いて更新できる（在庫側にも反映される）
    const changed = await db.updatePurchaseFulfillment('mellojoy:#111', 'delivered')
    expect(changed).toBe(true)
    expect((await db.listPurchases())[0].fulfillment).toBe('delivered')
    expect((await db.listInventory('in_stock'))[0].fulfillment).toBe('delivered')

    // 同じ値なら false（変化なし）
    expect(await db.updatePurchaseFulfillment('mellojoy:#111', 'delivered')).toBe(false)

    // 未知の import_key は false
    expect(await db.updatePurchaseFulfillment('mellojoy:#no-such', 'shipped')).toBe(false)
  })

  it('updatePurchaseFulfillment：今より低い状態には巻き戻さない（人が到着済にしたものを収集で戻さない）', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-03-05',
      import_key: 'mellojoy:#downgrade',
      fulfillment: 'delivered',
      lines: [{ name: '巻き戻り防止テスト', unit_price: 1000, quantity: 1 }],
    })
    expect((await db.listPurchases())[0].fulfillment).toBe('delivered')

    // delivered → shipped（一覧が「配送中」を指している）は変えない
    expect(await db.updatePurchaseFulfillment('mellojoy:#downgrade', 'shipped')).toBe(false)
    expect((await db.listPurchases())[0].fulfillment).toBe('delivered')

    // shipped → null（取れなかった）も変えない
    expect(await db.updatePurchaseFulfillment('mellojoy:#downgrade', null)).toBe(false)
    expect((await db.listPurchases())[0].fulfillment).toBe('delivered')

    // pending → shipped は進むので変わる
    const draftId = await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-03-06',
      import_key: 'mellojoy:#upgrade',
      fulfillment: 'pending',
      lines: [{ name: '前進はできる', unit_price: 1000, quantity: 1 }],
    })
    expect(await db.updatePurchaseFulfillment('mellojoy:#upgrade', 'shipped')).toBe(true)
    expect((await db.getPurchase(draftId)).fulfillment).toBe('shipped')

    // 手動（setPurchaseFulfillment）は今まで通り何にでも変えられる（shipped → pending に戻せる）
    await db.setPurchaseFulfillment(draftId, 'pending')
    expect((await db.getPurchase(draftId)).fulfillment).toBe('pending')
  })

  it('fulfillment：指定しなければ null。confirmPurchaseはfulfillmentに触らない', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-03-01',
      lines: [{ name: 'fulfillment未指定', unit_price: 1000, quantity: 1 }],
    })
    expect((await db.listPurchases())[0].fulfillment).toBeNull()

    const draftId = await db.createPurchaseDraft({
      import_key: 'mellojoy:#222',
      shop_account_id: shopId,
      ordered_at: '2026-03-02',
      fulfillment: 'shipped',
      lines: [{ name: '下書きfulfillment', quantity: 1 }],
    })
    expect((await db.getPurchase(draftId)).fulfillment).toBe('shipped')

    await db.confirmPurchase(draftId, {
      shop_account_id: shopId,
      ordered_at: '2026-03-02',
      shipping_fee: 0,
      lines: [{ name: '下書きfulfillment', unit_price: 1000, quantity: 1 }],
    })
    // 確定時にfulfillmentを渡さなくても、下書きの値が保たれる（確定処理では触らない）
    expect((await db.getPurchase(draftId)).fulfillment).toBe('shipped')
  })

  it('setPurchaseFulfillment：idを指定して到着状態を手で変えられる（TikTok Shopなど自動取得しない仕入先向け）', async () => {
    const id = await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-01',
      lines: [{ name: '手動fulfillment', unit_price: 1000, quantity: 1 }],
    })
    expect((await db.getPurchase(id)).fulfillment).toBeNull()

    await db.setPurchaseFulfillment(id, 'shipped')
    const afterShipped = await db.getPurchase(id)
    expect(afterShipped.fulfillment).toBe('shipped')
    expect(afterShipped.shipped_at).not.toBeNull()
    expect(afterShipped.delivered_at).toBeNull()

    await db.setPurchaseFulfillment(id, 'delivered')
    const afterDelivered = await db.getPurchase(id)
    expect(afterDelivered.fulfillment).toBe('delivered')
    expect(afterDelivered.shipped_at).toBe(afterShipped.shipped_at) // 既に入っていた日は触らない
    expect(afterDelivered.delivered_at).not.toBeNull()

    // 後戻り（delivered → pending）も許可するが、日付は消さない
    await db.setPurchaseFulfillment(id, 'pending')
    const afterPending = await db.getPurchase(id)
    expect(afterPending.fulfillment).toBe('pending')
    expect(afterPending.shipped_at).toBe(afterShipped.shipped_at)
    expect(afterPending.delivered_at).toBe(afterDelivered.delivered_at)

    // 在庫側（inventory_view由来のfulfillment）も追従する
    expect((await db.listInventory('in_stock'))[0].fulfillment).toBe('pending')

    // 元は 'no-such-id'。uuid の形の「無い仕入」に変えた
    await expect(db.setPurchaseFulfillment(NO_SUCH, 'shipped')).rejects.toThrow('仕入が見つかりません')
  })

  it('createPurchase：fulfillmentを指定した状態で保存できる（フォームからの初期状態）', async () => {
    const id = await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-02',
      fulfillment: 'pending',
      lines: [{ name: 'フォームの初期状態', unit_price: 1000, quantity: 1 }],
    })
    expect((await db.getPurchase(id)).fulfillment).toBe('pending')
  })

  it('updatePurchaseFulfillment：shipped_at・delivered_atが最初に観測した日で入る（delivered直行ならshipped_atも同時に埋まる）', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-01',
      import_key: 'mellojoy:#date-1',
      fulfillment: 'pending',
      lines: [{ name: '日付テスト', unit_price: 1000, quantity: 1 }],
    })
    expect((await db.listPurchases())[0].shipped_at).toBeNull()
    expect((await db.listPurchases())[0].delivered_at).toBeNull()

    await db.updatePurchaseFulfillment('mellojoy:#date-1', 'shipped')
    const afterShipped = (await db.listPurchases())[0]
    expect(afterShipped.shipped_at).not.toBeNull()
    expect(afterShipped.delivered_at).toBeNull()

    await db.updatePurchaseFulfillment('mellojoy:#date-1', 'delivered')
    const afterDelivered = (await db.listPurchases())[0]
    expect(afterDelivered.shipped_at).toBe(afterShipped.shipped_at) // 既に入っていた日は上書きしない
    expect(afterDelivered.delivered_at).not.toBeNull()

    // delivered へ直行した場合はshipped_atも同時に埋まる
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-02',
      import_key: 'mellojoy:#date-2',
      fulfillment: 'pending',
      lines: [{ name: '直行テスト', unit_price: 1000, quantity: 1 }],
    })
    await db.updatePurchaseFulfillment('mellojoy:#date-2', 'delivered')
    const direct = (await db.listPurchases()).find(p => p.import_key === 'mellojoy:#date-2')!
    expect(direct.shipped_at).not.toBeNull()
    expect(direct.delivered_at).not.toBeNull()
  })

  it('createPurchase：fulfillmentがshipped/deliveredなら生成時点でshipped_at/delivered_atが入る', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-01',
      fulfillment: 'shipped',
      lines: [{ name: '生成時shipped', unit_price: 1000, quantity: 1 }],
    })
    const shipped = (await db.listPurchases()).find(p => p.first_line_name === '生成時shipped')!
    expect(shipped.shipped_at).not.toBeNull()
    expect(shipped.delivered_at).toBeNull()

    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-01',
      fulfillment: 'delivered',
      lines: [{ name: '生成時delivered', unit_price: 1000, quantity: 1 }],
    })
    const delivered = (await db.listPurchases()).find(p => p.first_line_name === '生成時delivered')!
    expect(delivered.shipped_at).not.toBeNull()
    expect(delivered.delivered_at).not.toBeNull()
  })

  it('applyFulfillmentFromShop：状態はupdatePurchaseFulfillmentと同じ規則で前に進み、日付はお店の日付でそのまま入る', async () => {
    const id = await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      fulfillment: 'pending',
      lines: [{ name: 'お店の日付テスト', unit_price: 1000, quantity: 1 }],
    })

    const changed = await db.applyFulfillmentFromShop(id, {
      status: 'shipped',
      shipped_at: '2026-09-23',
      delivered_at: null,
      carrier: null,
      tracking_number: null,
    })
    expect(changed).toBe(true)
    const after = await db.getPurchase(id)
    expect(after.fulfillment).toBe('shipped')
    expect(after.shipped_at).toBe('2026-09-23')
    expect(after.delivered_at).toBeNull()
  })

  it('applyFulfillmentFromShop：今より低い状態には巻き戻さないが、日付はお店の日付で上書きされる（気づいた日より正確なため）', async () => {
    const id = await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      fulfillment: 'delivered',
      lines: [{ name: '降格しないテスト', unit_price: 1000, quantity: 1 }],
    })
    const before = await db.getPurchase(id)
    expect(before.fulfillment).toBe('delivered')

    const changed = await db.applyFulfillmentFromShop(id, {
      status: 'shipped',
      shipped_at: '2026-09-10',
      delivered_at: null,
      carrier: null,
      tracking_number: null,
    })
    expect(changed).toBe(true) // 状態は変わらないが日付が変わったのでtrue
    const after = await db.getPurchase(id)
    // 状態はdeliveredのまま（一覧が「配送中」を指していても巻き戻さない）
    expect(after.fulfillment).toBe('delivered')
    // 日付はお店から読めた実際の日で上書きされる
    expect(after.shipped_at).toBe('2026-09-10')
  })

  it('applyFulfillmentFromShop：日付・追跡番号・業者がnullのときは既存の値を消さない', async () => {
    const id = await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      fulfillment: 'pending',
      lines: [{ name: 'null温存テスト', unit_price: 1000, quantity: 1 }],
    })
    await db.applyFulfillmentFromShop(id, {
      status: 'shipped',
      shipped_at: '2026-09-05',
      delivered_at: null,
      carrier: 'SF Express',
      tracking_number: 'SF1234567890',
    })
    expect(await db.getPurchaseTrackingNumber(id)).toBe('SF1234567890')

    // 次の収集で追跡番号・業者・日付が読めなかった（null）→ 消えない
    const changed = await db.applyFulfillmentFromShop(id, {
      status: 'shipped',
      shipped_at: null,
      delivered_at: null,
      carrier: null,
      tracking_number: null,
    })
    expect(changed).toBe(false) // 何も変わっていない
    const after = await db.getPurchase(id)
    expect(after.shipped_at).toBe('2026-09-05')
    expect(after.tracking_carrier).toBe('SF Express')
    expect(after.tracking_number).toBe('SF1234567890')
    expect(await db.getPurchaseTrackingNumber(id)).toBe('SF1234567890')
  })

  it('applyFulfillmentFromShop：存在しない仕入idはfalse', async () => {
    // uuid の形の「無い仕入」と、元の 'no-such-id'（uuid でない）のどちらも、例外にせず false
    for (const id of [NO_SUCH, 'no-such-id']) {
      expect(await db.applyFulfillmentFromShop(id, {
        status: 'shipped', shipped_at: '2026-09-05', delivered_at: null, carrier: null, tracking_number: null,
      })).toBe(false)
    }
  })

  it('getPurchaseTrackingNumber：追跡番号を登録していない仕入はnull', async () => {
    const id = await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      lines: [{ name: '追跡番号なし', unit_price: 1000, quantity: 1 }],
    })
    expect(await db.getPurchaseTrackingNumber(id)).toBeNull()
    expect(await db.getPurchaseTrackingNumber(NO_SUCH)).toBeNull()
    expect(await db.getPurchaseTrackingNumber('no-such-id')).toBeNull()
  })

  it('getPurchaseTracking：番号・到着状態・保存済みの状態をまとめて返す。存在しない仕入はnull', async () => {
    const id = await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      fulfillment: 'shipped',
      lines: [{ name: '配送中', unit_price: 1000, quantity: 1 }],
    })
    await db.applyFulfillmentFromShop(id, {
      status: null, shipped_at: null, delivered_at: null, carrier: null, tracking_number: 'TRK-GET-1',
    })
    expect(await db.getPurchaseTracking(id)).toEqual({
      tracking_number: 'TRK-GET-1', fulfillment: 'shipped', tracking_status: null,
      tracking_registered_at: null,
    })

    await db.applyTrackingResult(id, { status_text: '輸送中', fulfillment: null, delivered_at: null })
    expect(await db.getPurchaseTracking(id)).toEqual({
      tracking_number: 'TRK-GET-1', fulfillment: 'shipped', tracking_status: '輸送中',
      tracking_registered_at: null,
    })

    await db.markTrackingRegistered([id])
    expect((await db.getPurchaseTracking(id))!.tracking_registered_at).not.toBeNull()

    expect(await db.getPurchaseTracking(NO_SUCH)).toBeNull()
    expect(await db.getPurchaseTracking('no-such-id')).toBeNull()
  })

  describe('trackingCheckCandidates / applyTrackingResult：17TRACK（追跡番号のサイト）を見るべき仕入と結果の反映', () => {
    async function makeTrackedPurchase(
      name: string, trackingNumber: string | null,
      fulfillment: 'pending' | 'shipped' | 'delivered' | null = 'shipped',
      registered = true,
    ) {
      const id = await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-09-01',
        fulfillment,
        lines: [{ name, unit_price: 1000, quantity: 1 }],
      })
      if (trackingNumber !== null) {
        await db.applyFulfillmentFromShop(id, {
          status: null, shipped_at: null, delivered_at: null, carrier: null, tracking_number: trackingNumber,
        })
        if (registered) await db.markTrackingRegistered([id])
      }
      return id
    }

    it('追跡番号が無い仕入は候補に出ない', async () => {
      await makeTrackedPurchase('番号なし', null)
      expect(await db.trackingCheckCandidates(10)).toEqual([])
    })

    it('到着済み（delivered）は候補に出ない', async () => {
      const id = await makeTrackedPurchase('到着済', 'TRK-DELIVERED', 'delivered')
      expect((await db.trackingCheckCandidates(10)).some(c => c.id === id)).toBe(false)
    })

    it('17TRACKにまだ登録していない（tracking_registered_atがnull）は候補に出ない（register前にgettrackinfoを呼ぶとエラーになるため）', async () => {
      const id = await makeTrackedPurchase('未登録', 'TRK-UNREGISTERED', 'shipped', false)
      expect((await db.trackingCheckCandidates(10)).some(c => c.id === id)).toBe(false)
      expect((await db.trackingCheckCandidates()).some(c => c.id === id)).toBe(false)
    })

    it('未確認（tracking_checked_atがnull）が先、次に古い順', async () => {
      const idUnchecked = await makeTrackedPurchase('未確認', 'TRK-A')
      const idOldChecked = await makeTrackedPurchase('前に確認済み', 'TRK-B')
      const idRecentChecked = await makeTrackedPurchase('直近に確認済み', 'TRK-C')

      // 元は datetime('now', '-25 hours') / '-1 hours'
      await db.sql(`update purchase set tracking_checked_at = now() - interval '25 hours' where id = ?`, idOldChecked)
      await db.sql(`update purchase set tracking_checked_at = now() - interval '1 hours' where id = ?`, idRecentChecked)

      const ids = (await db.trackingCheckCandidates(10)).map(c => c.id)
      expect(ids).toEqual([idUnchecked, idOldChecked, idRecentChecked])
    })

    it('最後に見た時刻にかかわらず候補に出る（取り込みは起動時と手動のときだけで間隔を空ける意味が無い）', async () => {
      const idJustChecked = await makeTrackedPurchase('1分前に確認済み', 'TRK-1M')

      await db.sql(`update purchase set tracking_checked_at = now() - interval '1 minutes' where id = ?`, idJustChecked)

      const ids = (await db.trackingCheckCandidates(10)).map(c => c.id)
      expect(ids).toContain(idJustChecked)
    })

    it('limitを渡すと絞られる、省略すると全件返る', async () => {
      await makeTrackedPurchase('limit-a', 'TRK-L1')
      await makeTrackedPurchase('limit-b', 'TRK-L2')
      expect(await db.trackingCheckCandidates(1)).toHaveLength(1)
      expect(await db.trackingCheckCandidates()).toHaveLength(2)
    })

    it('applyTrackingResult：配送中→delivered＋到着日で、fulfillmentとdelivered_atが入りtrue', async () => {
      const id = await makeTrackedPurchase('配達完了', 'TRK-D1', 'shipped')

      const changed = await db.applyTrackingResult(id, {
        status_text: '配達完了', fulfillment: 'delivered', delivered_at: '2026-09-20',
      })
      expect(changed).toBe(true)

      const after = await db.getPurchase(id)
      expect(after.fulfillment).toBe('delivered')
      expect(after.delivered_at).toBe('2026-09-20')
      expect(after.tracking_status).toBe('配達完了')
      expect(after.tracking_checked_at).not.toBeNull()
    })

    it('applyTrackingResult：すでに人が到着済にしている仕入にshippedを渡しても戻らない', async () => {
      const id = await makeTrackedPurchase('到着済み・人の手で確定', 'TRK-D2', 'delivered')

      await db.applyTrackingResult(id, { status_text: '輸送中', fulfillment: 'shipped', delivered_at: null })

      const after = await db.getPurchase(id)
      expect(after.fulfillment).toBe('delivered') // 前に進む方向だけなので戻らない
    })

    it('applyTrackingResult：status_textだけ（fulfillment: null）でもtracking_status/tracking_checked_atは進み、到着状態は変わらずfalse', async () => {
      const id = await makeTrackedPurchase('情報不明', 'TRK-D3', 'shipped')

      const changed = await db.applyTrackingResult(id, {
        status_text: '情報が見つかりません', fulfillment: null, delivered_at: null,
      })
      expect(changed).toBe(false)

      const after = await db.getPurchase(id)
      expect(after.fulfillment).toBe('shipped') // 変わらない
      expect(after.tracking_status).toBe('情報が見つかりません') // 表示用の言葉は進む
      expect(after.tracking_checked_at).not.toBeNull() // 次の収集で同じものばかり引かないよう進む
    })

    it('applyTrackingResult：存在しない仕入idはfalse（例外を投げない）', async () => {
      for (const id of [NO_SUCH, 'no-such-id']) {
        expect(await db.applyTrackingResult(id, {
          status_text: '配達完了', fulfillment: 'delivered', delivered_at: '2026-09-20',
        })).toBe(false)
      }
    })
  })

  describe('trackingRegisterCandidates / markTrackingRegistered / trackingCounts：17TRACKへの登録（無料枠を消費する側）', () => {
    async function makeUnregisteredPurchase(
      name: string, trackingNumber: string | null,
      fulfillment: 'pending' | 'shipped' | 'delivered' | null = 'shipped',
    ) {
      const id = await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-09-01',
        fulfillment,
        lines: [{ name, unit_price: 1000, quantity: 1 }],
      })
      if (trackingNumber !== null) {
        await db.applyFulfillmentFromShop(id, {
          status: null, shipped_at: null, delivered_at: null, carrier: null, tracking_number: trackingNumber,
        })
      }
      return id
    }

    it('trackingRegisterCandidates：追跡番号が無い／到着済／すでに登録済みは出ない。未登録の未到着だけ出る', async () => {
      const noNumber = await makeUnregisteredPurchase('番号なし', null)
      const delivered = await makeUnregisteredPurchase('到着済', 'TRK-REG-DELIVERED', 'delivered')
      const alreadyRegistered = await makeUnregisteredPurchase('登録済み', 'TRK-REG-DONE', 'shipped')
      await db.markTrackingRegistered([alreadyRegistered])
      const target = await makeUnregisteredPurchase('未登録', 'TRK-REG-TARGET', 'shipped')

      const ids = (await db.trackingRegisterCandidates()).map(c => c.id)
      expect(ids).not.toContain(noNumber)
      expect(ids).not.toContain(delivered)
      expect(ids).not.toContain(alreadyRegistered)
      expect(ids).toContain(target)
    })

    it('trackingRegisterCandidates：新しい注文が先（ordered_at DESC）', async () => {
      const older = await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        fulfillment: 'shipped',
        lines: [{ name: '古い注文', unit_price: 1000, quantity: 1 }],
      })
      await db.applyFulfillmentFromShop(older, {
        status: null, shipped_at: null, delivered_at: null, carrier: null, tracking_number: 'TRK-REG-OLD',
      })
      const newer = await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-09-01',
        fulfillment: 'shipped',
        lines: [{ name: '新しい注文', unit_price: 1000, quantity: 1 }],
      })
      await db.applyFulfillmentFromShop(newer, {
        status: null, shipped_at: null, delivered_at: null, carrier: null, tracking_number: 'TRK-REG-NEW',
      })

      const ids = (await db.trackingRegisterCandidates()).map(c => c.id)
      expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older))
    })

    it('markTrackingRegistered：印が付き、updated_atは変わらない。空配列では何も起きない。複数idをまとめて更新できる', async () => {
      const a = await makeUnregisteredPurchase('まとめて登録A', 'TRK-MARK-A')
      const b = await makeUnregisteredPurchase('まとめて登録B', 'TRK-MARK-B')
      const before = (await db.sql<{ updated_at: string }>('select updated_at from purchase where id = ?', a))[0]

      await expect(db.markTrackingRegistered([])).resolves.toBeUndefined()
      expect((await db.getPurchaseTracking(a))!.tracking_registered_at).toBeNull()

      await db.markTrackingRegistered([a, b])

      expect((await db.getPurchaseTracking(a))!.tracking_registered_at).not.toBeNull()
      expect((await db.getPurchaseTracking(b))!.tracking_registered_at).not.toBeNull()
      const after = (await db.sql<{ updated_at: string }>('select updated_at from purchase where id = ?', a))[0]
      expect(after.updated_at).toBe(before.updated_at)
    })

    it('trackingCounts：未登録2件・登録済み未到着1件・到着済1件で { unregistered: 2, watching: 1 }', async () => {
      await makeUnregisteredPurchase('未登録1', 'TRK-COUNT-1', 'shipped')
      await makeUnregisteredPurchase('未登録2', 'TRK-COUNT-2', 'shipped')
      const watching = await makeUnregisteredPurchase('登録済み・未到着', 'TRK-COUNT-3', 'shipped')
      await db.markTrackingRegistered([watching])
      const arrived = await makeUnregisteredPurchase('到着済', 'TRK-COUNT-4', 'shipped')
      await db.markTrackingRegistered([arrived])
      await db.applyTrackingResult(arrived, { status_text: '配達完了', fulfillment: 'delivered', delivered_at: '2026-09-20' })

      expect(await db.trackingCounts()).toEqual({ unregistered: 2, watching: 1 })
    })
  })

  describe('deletePurchase', () => {
    it('出品に引き当て中の在庫を含む仕入も削除できる（引き当ては外れ、出品は未引き当てに戻る）', async () => {
      const purchaseId = await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '引き当て中の商品', unit_price: 1000, quantity: 1 }],
      })
      expect((await db.listPurchases()).find(p => p.first_line_name === '引き当て中の商品')!.id).toBe(purchaseId)
      const item = (await db.listInventory('in_stock')).find(i => i.name === '引き当て中の商品')!
      // 元は db.upsertListings + db.reserveInventory（出品の担当）。SQL で出品と引き当てを作る
      const listingId = await db.createListing('mDeletePurchase', '引き当て中の商品', 2000)
      await db.reserve(listingId, item.id)

      // listing_line にON DELETEが無いためFK違反で失敗していた（修正前）。今は成功する
      await expect(db.deletePurchase(purchaseId)).resolves.toBeUndefined()

      // 出品自体は残るが、未引き当てに戻る（在庫が消えたので）
      expect(await db.sql('select id from listing where id = ?', listingId)).toHaveLength(1)
      expect(await db.sql('select id from listing_line where listing_id = ?', listingId)).toEqual([])
      expect((await db.listPurchases()).find(p => p.id === purchaseId)).toBeUndefined()
      // 在庫・明細も一緒に消える
      expect(await db.listInventory('in_stock')).toEqual([])
    })

    it('分割した在庫（親と子）を含む仕入も消せる。子が売れていれば消させない', async () => {
      const purchaseId = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01',
        lines: [{ name: '分割する商品', unit_price: 1000, quantity: 1 }, { name: '分割しない商品', unit_price: 500, quantity: 1 }],
      })
      const parent = (await db.listInventory('in_stock')).find(i => i.name === '分割する商品')!
      const [child1] = await db.splitInventory(parent.id, 2)
      const tag = await db.createTag('子のタグ')
      await db.setInventoryTags(child1, [tag])

      // 子が売れていれば、親（split）を含む仕入全体を消させない
      const saleId = await db.createSale({ title: '子が売れた', sold_at: '2026-01-05', price: 800 })
      await db.linkInventory(saleId, [child1])
      await expect(db.deletePurchase(purchaseId)).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('販売済みの在庫が1点') })
      expect((await db.sql('select id from inventory_item')).length).toBe(4)

      // 紐付けを外せば、子・親・在庫のタグごと消える
      await db.sql('delete from sale_line where inventory_item_id = ?', child1)
      await db.deletePurchase(purchaseId)
      for (const table of ['purchase', 'purchase_line', 'inventory_item', 'inventory_tag']) {
        expect(await db.sql(`select 1 from ${table}`), table).toEqual([])
      }
    })

    it('販売済みの在庫がぶら下がっていたら消させない（売れた原価が消えて過去の利益が壊れるため）', async () => {
      const purchaseId = await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        lines: [{ name: '売れた商品', unit_price: 1000, quantity: 2 }],
      })
      const [first] = await db.listInventory('in_stock')
      const saleId = await db.createSale({ title: '売れた商品', sold_at: '2026-01-05', price: 2000 })
      await db.linkInventory(saleId, [first.id])

      await expect(db.deletePurchase(purchaseId)).rejects.toThrow('この仕入には販売済みの在庫が1点あります。先に紐付けを解除してください')
      // 何も消えていない
      expect(await db.listPurchases()).toHaveLength(1)
      expect(await db.listInventory('in_stock')).toHaveLength(1)
      expect(await db.listInventory('sold')).toHaveLength(1)
    })
  })

  describe('タグの派生：仕入→在庫（仕入のタグは在庫にコピーせず「派生」で見える）', () => {
    // 元の『仕入→在庫3点→紐付いた販売、へ派生する』のうち、仕入と在庫の部分。販売への派生（listSales の inherited_tags）は販売の担当
    it('仕入のタグは、その在庫3点すべてに派生する。直接タグとは重複せず、仕入のタグを外すと派生も消える', async () => {
      const purchaseId = await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '派生タグ対象', unit_price: 1000, quantity: 3 }],
      })
      const tagA = await db.createTag('A')
      const tagB = await db.createTag('B')
      await db.setPurchaseTags(purchaseId, [tagA])

      // 仕入のタグ → その在庫3点すべてに派生する
      const items = await db.listInventory('in_stock')
      expect(items).toHaveLength(3)
      for (const item of items) {
        expect(item.tags).toEqual([])
        expect(item.inherited_tags.map(t => t.id)).toEqual([tagA])
      }

      // 1点に直接タグBを付ける（在庫のタグと派生タグは重複しない）
      const [target, other] = items
      await db.setInventoryTags(target.id, [tagB])
      const targetAfter = (await db.listInventory('in_stock')).find(i => i.id === target.id)!
      expect(targetAfter.tags.map(t => t.id)).toEqual([tagB])
      expect(targetAfter.inherited_tags.map(t => t.id)).toEqual([tagA])

      // 仕入のタグを外すと、まだ紐付いていない在庫からも派生タグが消える
      await db.setPurchaseTags(purchaseId, [])
      const afterRemove = (await db.listInventory('in_stock')).find(i => i.id === other.id)!
      expect(afterRemove.inherited_tags).toEqual([])
    })
  })

  describe('setPurchaseTags / listPurchases・getPurchase の tags', () => {
    it('setPurchaseTags：置き換え（丸ごと入れ替え）。listPurchases・getPurchaseの両方に出る', async () => {
      const tagA = await db.createTag('A')
      const tagB = await db.createTag('B')

      const purchaseId = await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '仕入タグ対象', unit_price: 1000, quantity: 1 }],
      })
      await db.setPurchaseTags(purchaseId, [tagA, tagB])
      expect((await db.listPurchases()).find(p => p.id === purchaseId)!.tags.map(t => t.id).sort())
        .toEqual([tagA, tagB].sort())
      expect((await db.getPurchase(purchaseId)).tags.map(t => t.id).sort()).toEqual([tagA, tagB].sort())

      // 置き換え：Bだけになる
      await db.setPurchaseTags(purchaseId, [tagB])
      expect((await db.listPurchases()).find(p => p.id === purchaseId)!.tags.map(t => t.id)).toEqual([tagB])
      expect((await db.getPurchase(purchaseId)).tags.map(t => t.id)).toEqual([tagB])

      // 空配列で全部外す
      await db.setPurchaseTags(purchaseId, [])
      expect((await db.listPurchases()).find(p => p.id === purchaseId)!.tags).toEqual([])
    })
  })

  describe('仕入先の自動タグ（shop_account_tag）：作成時にだけ purchase_tag へ自動で付く', () => {
    // 元の『…売れた販売にもA』の部分（listSales の inherited_tags）は販売の担当。ここは仕入・在庫まで
    it('口座に自動タグA→createPurchaseの仕入にA、その在庫のinherited_tagsにA(from purchase)。下書き→確定でも残る。setPurchaseTags([])で外せる', async () => {
      const tagId = await db.createTag('自動タグA')
      await db.updateShopAccount(shopId, { auto_tag_ids: [tagId] })
      expect((await db.getShopAccount(shopId))!.auto_tags.map(t => t.id)).toEqual([tagId])

      const purchaseId = await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '自動タグ対象', unit_price: 1000, quantity: 1 }],
      })
      expect((await db.getPurchase(purchaseId)).tags.map(t => t.id)).toEqual([tagId])

      const item = (await db.listInventory('in_stock')).find(i => i.name === '自動タグ対象')!
      expect(item.inherited_tags).toEqual([{ id: tagId, name: '自動タグA', sort_order: 0, from: 'purchase' }])

      // 下書き→確定でも残る
      const draftId = await db.createPurchaseDraft({
        import_key: 'mellojoy:#900001',
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        lines: [{ name: '下書き対象', quantity: 1 }],
      })
      expect((await db.getPurchase(draftId)).tags.map(t => t.id)).toEqual([tagId])
      await db.confirmPurchase(draftId, {
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '下書き対象', unit_price: 1000, quantity: 1 }],
      })
      expect((await db.getPurchase(draftId)).tags.map(t => t.id)).toEqual([tagId])

      // 後から外せる（作成時だけの挙動。外しても再付与しない）
      await db.setPurchaseTags(purchaseId, [])
      expect((await db.getPurchase(purchaseId)).tags).toEqual([])
    })
  })

  describe('getPurchase：lines[].items（明細ごとの在庫の状態）', () => {
    it('3点のうち1点出品中・1点販売済・1点未出品の内訳が返る', async () => {
      const purchaseId = await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '内訳確認', unit_price: 1000, quantity: 3 }],
      })
      const [a, b, c] = await db.listInventory('in_stock')

      // 元は db.upsertListings / db.reserveInventory / db.createSale / db.linkInventory
      const listingId = await db.createListing('LDETAIL', '内訳確認', 3000)
      await db.reserve(listingId, a.id)

      const saleId = await db.createSale({ title: '内訳確認', sold_at: '2026-01-10', price: 2500 })
      await db.linkInventory(saleId, [b.id])
      // c は未出品のまま

      const detail = await db.getPurchase(purchaseId)
      expect(detail.lines).toHaveLength(1)
      const items = detail.lines[0].items
      expect(items).toHaveLength(3)
      for (const it of items) expect(it.landed_cost).toBeGreaterThan(0)

      const itemA = items.find(i => i.id === a.id)!
      expect(itemA.status).toBe('in_stock')
      expect(itemA.listing_price).toBe(3000)
      expect(itemA.sale_id).toBeNull()

      const itemB = items.find(i => i.id === b.id)!
      expect(itemB.status).toBe('sold')
      expect(itemB.listing_price).toBeNull()
      expect(itemB.sale_id).toBe(saleId)
      expect(itemB.sale_price).toBe(2500)
      expect(itemB.sold_at).toBe('2026-01-10')

      const itemC = items.find(i => i.id === c.id)!
      expect(itemC.status).toBe('in_stock')
      expect(itemC.listing_price).toBeNull()
      expect(itemC.sale_id).toBeNull()
    })

    it('終わった出品（ended）の引き当ては出品価格に出ない。出品中（suspended 含む）だけが出る', async () => {
      const purchaseId = await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        lines: [{ name: '出品の履歴', unit_price: 1000, quantity: 1 }],
      })
      const [item] = await db.listInventory('in_stock')
      // 終わった出品への引き当ては trg_listing_line_guard が断るので、いったん active で引き当ててから状態を変える
      const listingId = await db.createListing('LACTIVE', '出品の履歴', 3000)
      await db.reserve(listingId, item.id)
      expect((await db.getPurchase(purchaseId)).lines[0].items[0].listing_price).toBe(3000)

      await db.sql(`update listing set status = 'suspended' where id = ?`, listingId)
      expect((await db.getPurchase(purchaseId)).lines[0].items[0].listing_price).toBe(3000)

      await db.sql(`update listing set status = 'ended' where id = ?`, listingId)
      expect((await db.getPurchase(purchaseId)).lines[0].items[0].listing_price).toBeNull()
      expect((await db.getPurchase(purchaseId)).lines[0].items).toHaveLength(1)
    })

    it('下書きは明細のitemsが空配列', async () => {
      const draftId = await db.createPurchaseDraft({
        import_key: 'mellojoy:#900002',
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        lines: [{ name: '下書き明細', quantity: 2 }],
      })
      const detail = await db.getPurchase(draftId)
      expect(detail.lines[0].items).toEqual([])
    })

    it('分割で生まれた子は親のpurchase_line_idを引き継ぎ、items には split 親は出ず子だけ出る', async () => {
      const purchaseId = await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '分割確認', unit_price: 1000, quantity: 1 }],
      })
      const parent = (await db.listInventory('in_stock'))[0]
      const childIds = await db.splitInventory(parent.id, 2)

      const items = (await db.getPurchase(purchaseId)).lines[0].items
      expect(items.map(i => i.id).sort()).toEqual([...childIds].sort())
      expect(items.every(i => i.status === 'in_stock')).toBe(true)
    })
  })

  describe('shop_alias：登録番号→店名の学習', () => {
    it('登録番号→店名を学習し、次回の読み取りで使える（learnShopAlias / lookupShopAlias）', async () => {
      expect(await db.lookupShopAlias('T2290801007056')).toBeNull()

      await db.learnShopAlias('T2290801007056', 'セブンイレブン 小倉貫店')
      expect(await db.lookupShopAlias('T2290801007056')).toBe('セブンイレブン 小倉貫店')

      // 同じ番号で別の店名を学習すると上書きされ、hits が増える
      await db.learnShopAlias('T2290801007056', 'セブンイレブン 小倉貫店２号店')
      expect(await db.lookupShopAlias('T2290801007056')).toBe('セブンイレブン 小倉貫店２号店')
      const [row] = await db.sql<{ hits: number }>(`select hits from shop_alias where key = 'reg:T2290801007056'`)
      expect(row.hits).toBe(2)

      // 空文字は何もしない
      await db.learnShopAlias('T9999999999999', '   ')
      expect(await db.lookupShopAlias('T9999999999999')).toBeNull()
    })
  })

  describe('横断検索の仕入の分（searchPurchaseHits）', () => {
    // 元は db.searchAll。種類ごとの合成（searchAll）は商品・ホームの担当なので、仕入の分だけを直接呼ぶ
    it('型番・注文番号・メモ・タグ名でヒットする。status_label は 下書き/未着/配送中/到着済', async () => {
      const tag = await db.createTag('限定品')
      const id = await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        order_no: 'PO-Z200',
        note: '特別な注文',
        lines: [{ name: 'クリームわん【Z200-1】', unit_price: 1000, quantity: 1 }],
      })
      await db.setPurchaseTags(id, [tag])

      for (const q of ['Z200-1', 'PO-Z200', '特別な注文', '限定品']) {
        const hits = await db.searchPurchaseHits(q)
        expect(hits.map(h => h.kind), q).toEqual(['purchase'])
        expect(hits[0].id).toBe(id)
      }
      const purchaseHit = (await db.searchPurchaseHits('Z200-1'))[0]
      expect(purchaseHit.model_code).toBe('Z200-1')
      expect(purchaseHit.status_label).toBe('未着')
      expect(purchaseHit.amount).toBe(1000)
      expect(purchaseHit.date).toBe('2026-01-01')
      expect(purchaseHit.thumb_url).toBeNull()
    })

    it('全角英数はNFKC正規化で半角と同一視する', async () => {
      await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{
          name: 'ぜんかく検索テスト', unit_price: 1000, quantity: 1,
          model_code: 'Z300', series_code: 'Z300',
        }],
      })

      const hits = await db.searchPurchaseHits('Ｚ３００')
      expect(hits.some(h => h.model_code === 'Z300')).toBe(true)
    })

    it('purchase の status_label：下書き/未着/配送中/到着済', async () => {
      await db.createPurchaseDraft({
        import_key: 'IMP-DRAFT',
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        lines: [{ name: '下書き商品テスト', quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '未着商品テスト', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        fulfillment: 'shipped',
        lines: [{ name: '配送中商品テスト', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        fulfillment: 'delivered',
        lines: [{ name: '到着済商品テスト', unit_price: 1000, quantity: 1 }],
      })

      expect((await db.searchPurchaseHits('下書き商品テスト'))[0].status_label).toBe('下書き')
      expect((await db.searchPurchaseHits('未着商品テスト'))[0].status_label).toBe('未着')
      expect((await db.searchPurchaseHits('配送中商品テスト'))[0].status_label).toBe('配送中')
      expect((await db.searchPurchaseHits('到着済商品テスト'))[0].status_label).toBe('到着済')
    })

    it('空白区切りAND、種類ごとの上限（perKind）で切る', async () => {
      for (let i = 0; i < 5; i++) {
        await db.createPurchase({
          shop_account_id: shopId,
          ordered_at: `2026-01-${String(i + 1).padStart(2, '0')}`,
          lines: [{ name: `件数テスト${i} AAA`, unit_price: 100, quantity: 1 }],
          note: i === 0 ? 'BBB' : null,
        })
      }
      expect(await db.searchPurchaseHits('AAA BBB')).toHaveLength(1)
      expect(await db.searchPurchaseHits('AAA')).toHaveLength(5)
      // 新しい順に perKind 件
      const top = await db.searchPurchaseHits('AAA', 2)
      expect(top.map(h => h.date)).toEqual(['2026-01-05', '2026-01-04'])
    })
  })

  // src/main/__tests__/scenarios の、仕入の部分だけ（販売の削除・自動紐付け・ダッシュボードは別の担当）
  describe('シナリオ（ペルソナ08・12・19 の仕入の部分）', () => {
    it('ペルソナ08 draft→confirm：在庫は確定するまで無く、二重積み・再確定は弾かれ、在庫は増えない', async () => {
      const draftId = await db.createPurchaseDraft({
        import_key: 'order-8001', shop_account_id: shopId, ordered_at: '2026-02-01', order_no: '8001',
        lines: [{ name: 'テスト商品【D001】', quantity: 3 }],
      })
      expect(draftId).not.toBe('')
      expect(await db.listInventory('in_stock')).toHaveLength(0)

      const detail = await db.getPurchase(draftId)
      expect(detail.status).toBe('draft')
      expect(detail.lines[0].unit_price).toBe(0) // 単価0のまま

      const dup = await db.createPurchaseDraft({
        import_key: 'order-8001', shop_account_id: shopId, ordered_at: '2026-02-01',
        lines: [{ name: 'テスト商品【D001】', quantity: 3 }],
      })
      expect(dup).toBe('')
      expect(await db.listPurchases()).toHaveLength(1)

      await db.confirmPurchase(draftId, {
        shop_account_id: shopId, ordered_at: '2026-02-01', order_no: '8001', shipping_fee: 100,
        lines: [{ name: 'テスト商品【D001】', unit_price: 1000, quantity: 3 }],
      })
      const confirmed = await db.getPurchase(draftId)
      expect(confirmed.status).toBe('confirmed')
      expect(confirmed.total_cost).toBe(1000 * 3 + 100) // 3100

      const items = await db.listInventory('in_stock')
      expect(items).toHaveLength(3)
      // 端数は最終アイテムへ寄る（1033/1033/1034）。合計はpool(3100)と一致
      expect([...items].sort((a, b) => a.landed_cost - b.landed_cost).map(i => i.landed_cost)).toEqual([1033, 1033, 1034])
      expect(items.reduce((s, i) => s + i.landed_cost, 0)).toBe(3100)

      // 確定済みを再確定するとエラー（landed_costは後から書き換えない）
      await expect(db.confirmPurchase(draftId, {
        shop_account_id: shopId, ordered_at: '2026-02-01', lines: [{ name: 'x', unit_price: 1, quantity: 1 }],
      })).rejects.toThrow('確定済みの仕入は再確定できません')
      // 在庫は増えていない（再確定は失敗したまま）
      expect(await db.listInventory('in_stock')).toHaveLength(3)
    })

    it('ペルソナ12 消す人：未販売のみの仕入は削除できる。売れた在庫がある仕入は削除できない。販売を消して在庫が戻れば削除できる', async () => {
      const purchaseId1 = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-06-01', shipping_fee: 0,
        lines: [{ name: '未販売の商品', unit_price: 1000, quantity: 2 }],
      })
      expect(await db.listInventory('in_stock')).toHaveLength(2)
      await db.deletePurchase(purchaseId1)
      expect(await db.listInventory('in_stock')).toHaveLength(0)
      expect(await db.listPurchases()).toHaveLength(0)

      const purchaseId2 = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-06-02', shipping_fee: 0,
        lines: [{ name: '売れた商品', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      const saleId = await db.createSale({ title: '売れた商品', sold_at: '2026-06-05', price: 2000 })
      await db.linkInventory(saleId, [item.id])
      await expect(db.deletePurchase(purchaseId2))
        .rejects.toThrow('この仕入には販売済みの在庫が1点あります。先に紐付けを解除してください')

      // 販売を削除 → 紐付いていた在庫がin_stockに戻る（元は db.deleteSale。販売の担当）
      await db.sql('delete from sale where id = ?', saleId)
      expect((await db.listInventory('in_stock')).map(i => i.id)).toEqual([item.id])

      // 在庫が戻ったので、今度は仕入を削除できる
      await db.deletePurchase(purchaseId2)
      expect(await db.listInventory('in_stock')).toHaveLength(0)
    })

    it('ペルソナ19 手入力仕入：型番・シリーズは商品名から自動抽出され、在庫にも同じ値が入る', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-06-01',
        lines: [
          { name: 'メロジョイ【A035-1】メロージョイ ミニランド', unit_price: 1500, quantity: 1 },
          { name: 'メロジョイ【Z001-3】抹茶スフレ-クリーミークリーム', unit_price: 1200, quantity: 1 },
        ],
      })
      const items = await db.listInventory('in_stock')
      const a = items.find(i => i.model_code === 'A035-1')!
      const z = items.find(i => i.model_code === 'Z001-3')!
      expect(a.series_code).toBe('A035')
      expect(z.series_code).toBe('Z001')
      expect(z.material).toBe('クリーミークリーム')
    })
  })

  describe('小さな部品とサマリー', () => {
    it('getPurchaseSummary：1 件分の PurchaseSummary（listPurchases の行と同じ）。無ければ undefined', async () => {
      const tag = await db.createTag('サマリー')
      const id = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-02-02', shipping_fee: 100, order_no: 'SUM-1',
        lines: [{ name: 'サマリー商品【S001】', unit_price: 1000, quantity: 2 }],
      })
      await db.setPurchaseTags(id, [tag])
      const one = await A((c) => purchase.getPurchaseSummary(c, id))
      expect(one).toEqual((await db.listPurchases()).find(p => p.id === id))
      expect(one).toMatchObject({ line_count: 1, subtotal: 2000, total_cost: 2100, first_model_code: 'S001', shop_account_name: 'メロジョイA' })
      expect(one!.tags.map(t => t.id)).toEqual([tag])
      expect(await A((c) => purchase.getPurchaseSummary(c, NO_SUCH))).toBeUndefined()
    })

    it('findDuplicateOrderNo / normalizeOrderNo / formatPurchasedAt / purchaseStatusLabel', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-02-02', order_no: 'DUP-9',
        lines: [{ name: 'A', unit_price: 1, quantity: 1 }],
      })
      const id = (await db.listPurchases())[0].id
      expect(await A((c) => purchase.findDuplicateOrderNo(c, shopId, 'DUP-9'))).toEqual({ id, ordered_at: '2026-02-02' })
      expect(await A((c) => purchase.findDuplicateOrderNo(c, shopId, 'DUP-9', id))).toBeUndefined()
      expect(await A((c) => purchase.findDuplicateOrderNo(c, shopId, 'OTHER'))).toBeUndefined()

      expect(purchase.normalizeOrderNo(undefined)).toBeNull()
      expect(purchase.normalizeOrderNo('  ')).toBeNull()
      expect(purchase.normalizeOrderNo(' X ')).toBe('X')

      expect(purchase.formatPurchasedAt('2026-03-04T05:06')).toBe('2026/03/04 05:06')
      expect(purchase.formatPurchasedAt('2026-03-04')).toBe('2026/03/04')

      expect(purchase.purchaseStatusLabel({ status: 'draft', fulfillment: 'delivered' })).toBe('下書き')
      expect(purchase.purchaseStatusLabel({ status: 'confirmed', fulfillment: 'delivered' })).toBe('到着済')
      expect(purchase.purchaseStatusLabel({ status: 'confirmed', fulfillment: 'shipped' })).toBe('配送中')
      expect(purchase.purchaseStatusLabel({ status: 'confirmed', fulfillment: 'pending' })).toBe('未着')
      expect(purchase.purchaseStatusLabel({ status: 'confirmed', fulfillment: null })).toBe('未着')
    })

    it('空文字の import_key は「キー無し」。何件入れても一意制約に当たらない', async () => {
      const mk = () => db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-02-02', import_key: '',
        lines: [{ name: 'A', unit_price: 1, quantity: 1 }],
      })
      await mk()
      await mk()
      expect((await db.listPurchases()).map(p => p.import_key)).toEqual([null, null])
    })
  })

  describe('mellojoy_excluded_order：メロジョイの注文取り込みの除外記録', () => {
    it('markで記録するとisがtrueになり、keywords_hashが変われば再評価されfalseに戻る', async () => {
      expect(await db.isMellojoyOrderExcluded(shopId, 'order-1', 'hashA')).toBe(false)

      await db.markMellojoyOrderExcluded(shopId, 'order-1', 'hashA')
      expect(await db.isMellojoyOrderExcluded(shopId, 'order-1', 'hashA')).toBe(true)

      // キーワードが変わってhashが変わると再評価する（除外を引き継がない）
      expect(await db.isMellojoyOrderExcluded(shopId, 'order-1', 'hashB')).toBe(false)

      // 同じ注文をもう一度印すと、新しい hash で上書きされる
      await db.markMellojoyOrderExcluded(shopId, 'order-1', 'hashB')
      expect(await db.isMellojoyOrderExcluded(shopId, 'order-1', 'hashB')).toBe(true)
      expect(await db.isMellojoyOrderExcluded(shopId, 'order-1', 'hashA')).toBe(false)
    })
  })

  describe('入力値チェック（assertYen/assertQty）：画面からの入口で整数以外はエラーになる', () => {
    it('createPurchase：単価・送料が小数だとthrow', async () => {
      await expect(db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '商品', unit_price: 100.5, quantity: 1 }],
      })).rejects.toThrow('単価は整数で入力してください')

      await expect(db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 99.9,
        lines: [{ name: '商品', unit_price: 100, quantity: 1 }],
      })).rejects.toThrow('送料は整数で入力してください')
    })
  })

  describe('仕入明細の画像（purchase_line.image_url / image_path）', () => {
    // 元は image_file（ファイル名）と soroban-thumb://。Web 版は Storage のパス（image_path）と、公開バケットの URL
    const imagePath = (name: string) => `${w.a.householdId}/purchase/${name}`

    it('画像巡回は同じ口座・対象注文・キーワード一致の自動更新商品のみ', async () => {
      const id = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-01', import_key: 'mellojoy:#images',
        lines: [{ name: 'テスト【A001-2】青', unit_price: 1000, quantity: 1 }],
      })
      const keys = ['mellojoy:#images']
      expect(await db.purchaseDetailRevisitCandidates(shopId, keys, ['テスト'])).toEqual([{ id, import_key: keys[0] }])
      // 元は 'other-shop'。uuid の形の「別の口座」と、uuid でない文字列のどちらも []
      expect(await db.purchaseDetailRevisitCandidates(NO_SUCH, keys, [])).toEqual([])
      expect(await db.purchaseDetailRevisitCandidates('other-shop', keys, [])).toEqual([])
      expect(await db.purchaseDetailRevisitCandidates(shopId, ['mellojoy:#other'], [])).toEqual([])
      expect(await db.purchaseDetailRevisitCandidates(shopId, keys, ['不一致'])).toEqual([])
      await db.upsertProductImage('A001-2', 'fixed.jpg')
      // 画像の理由は外れる。2026-04-01 の注文は 90 日より前なので、配送の理由でも開き直さない
      expect(await db.purchaseDetailRevisitCandidates(shopId, keys, [])).toEqual([])
      await db.deleteProductImage('A001-2')
      expect(await db.purchaseDetailRevisitCandidates(shopId, keys, [])).toHaveLength(1)
    })

    it('image_checked_atで画像巡回の終わりを判定する（取り終えたら候補から外れ、失敗が残れば対象のまま）', async () => {
      const id = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-01', import_key: 'mellojoy:#checked',
        lines: [{ name: 'テスト【A002】', unit_price: 1000, quantity: 1, image_url: 'https://cdn.example/a002.jpg' }],
      })
      const keys = ['mellojoy:#checked']
      // (a) 未確認（image_checked_at が NULL）：候補に出る
      expect(await db.purchaseDetailRevisitCandidates(shopId, keys, [])).toHaveLength(1)

      await db.setPurchaseImageChecked(id)
      const line = (await db.getPurchase(id)).lines[0]
      // (c) 確認済みだが、URLはあるのにダウンロードが済んでいない（前回失敗）：候補のまま
      expect(await db.purchaseDetailRevisitCandidates(shopId, keys, [])).toHaveLength(1)

      await db.setPurchaseLineImage(line.id, imagePath('a002.jpg'))
      // (b) 確認済み・全明細の画像を保存済み：候補から外れる＝巡回が終わる
      expect(await db.purchaseDetailRevisitCandidates(shopId, keys, [])).toEqual([])
    })

    it('バリアントを取り違えず更新し、自動OFFの画像は固定、ONなら公式画像を優先する', async () => {
      // 元は productImageFiles（商品の担当）の優先順位まで確かめていた。ここは仕入の担当の部分
      // （setPurchaseLineImageUrls が取り違えず、変わった行だけ取り直させること）だけ
      const id = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-01',
        lines: [
          { name: '商品 【A001-1】赤', unit_price: 1000, quantity: 1, image_url: 'https://cdn.example/red.jpg' },
          { name: '商品 【A001-2】青', unit_price: 1000, quantity: 1, image_url: 'https://cdn.example/blue.jpg' },
        ],
      })
      const [red, blue] = (await db.getPurchase(id)).lines
      await db.setPurchaseLineImage(red.id, imagePath('red.jpg'))
      await db.setPurchaseLineImage(blue.id, imagePath('blue.jpg'))
      await db.upsertProductImage('A001-2', 'fixed.jpg')
      expect(await db.setPurchaseLineImageUrls(id, [{ name: blue.name, image_url: 'https://cdn.example/blue.jpg?v=2' }])).toBe(1)
      expect(await db.purchaseLinesNeedingImage(id)).toEqual([{ id: blue.id, image_url: 'https://cdn.example/blue.jpg?v=2' }])
      expect(await db.purchaseLinesNeedingImage(id, ['赤'])).toEqual([])
      await db.setPurchaseLineImage(blue.id, imagePath('blue-new.jpg'))
      expect(await db.setPurchaseLineImageUrls(id, [{ name: blue.name, image_url: 'https://cdn.example/blue.jpg?v=2' }])).toBe(0)
      expect(await db.purchaseLinesNeedingImage(id)).toEqual([])
    })

    it('createPurchase で image_url を保存し、在庫アイテムの image_url に同じ画像のURLが出る（数量分すべて同じ）', async () => {
      const id = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-01', shipping_fee: 0,
        lines: [{ name: '画像テスト', unit_price: 1000, quantity: 2, image_url: 'https://mellojoy.example/img/300.jpg' }],
      })
      const detail = await db.getPurchase(id)
      expect(detail.lines[0].items).toHaveLength(2)
      // まだダウンロード前（image_path が無い）なので item.image_url は null
      expect(detail.lines[0].items[0].image_url).toBeNull()
      expect(detail.lines[0].items[1].image_url).toBeNull()

      const needing = await db.purchaseLinesNeedingImage(id)
      expect(needing).toEqual([{ id: detail.lines[0].id, image_url: 'https://mellojoy.example/img/300.jpg' }])

      await db.setPurchaseLineImage(detail.lines[0].id, imagePath('purchase-300.jpg'))
      const after = await db.getPurchase(id)
      // 元は 'soroban-thumb://purchase-300.jpg'。Web 版は公開バケット media の URL
      const url = `${MEDIA_BASE}/${w.a.householdId}/purchase/purchase-300.jpg`
      expect(after.lines[0].items[0].image_url).toBe(url)
      expect(after.lines[0].items[1].image_url).toBe(url)
      // ダウンロード済みなので needing から消える
      expect(await db.purchaseLinesNeedingImage(id)).toEqual([])
    })

    it('image_url を省略すれば null（items の image_url も null、needing にも出ない）', async () => {
      const id = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-02', shipping_fee: 0,
        lines: [{ name: '画像なし', unit_price: 1000, quantity: 1 }],
      })
      const detail = await db.getPurchase(id)
      expect(detail.lines[0].items[0].image_url).toBeNull()
      expect(await db.purchaseLinesNeedingImage(id)).toEqual([])
    })

    it('setPurchaseLineImageUrls：名前で突き合わせて image_url を更新し、変わった行だけ image_path をリセットする', async () => {
      const id = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-04-03', shipping_fee: 0,
        lines: [
          { name: 'A商品', unit_price: 1000, quantity: 1, image_url: 'https://x/a-old.jpg' },
          { name: 'B商品', unit_price: 1000, quantity: 1 },
        ],
      })
      const before = await db.getPurchase(id)
      await db.setPurchaseLineImage(before.lines[0].id, imagePath('a-old.jpg'))

      // A商品：URLが変わった → image_path はリセットされ、取り直し対象になる
      // B商品：新しくURLが付いた → 同様に取り直し対象
      // 存在しない名前は無視
      const updated = await db.setPurchaseLineImageUrls(id, [
        { name: 'A商品', image_url: 'https://x/a-new.jpg' },
        { name: 'B商品', image_url: 'https://x/b-new.jpg' },
        { name: 'C商品（無い）', image_url: 'https://x/c.jpg' },
      ])
      expect(updated).toBe(2)

      const needing = await db.purchaseLinesNeedingImage(id)
      expect(needing.map(n => n.image_url).sort()).toEqual(['https://x/a-new.jpg', 'https://x/b-new.jpg'])

      // 同じURLをもう一度渡しても変化なし（0件）
      expect(await db.setPurchaseLineImageUrls(id, [{ name: 'A商品', image_url: 'https://x/a-new.jpg' }])).toBe(0)
    })

    it('confirmPurchase：下書きを確定するときも image_url を保存する', async () => {
      const draftId = await db.createPurchaseDraft({
        import_key: 'mellojoy:#img-draft', shop_account_id: shopId, ordered_at: '2026-04-04',
        lines: [{ name: '下書き画像', quantity: 1 }],
      })
      await db.confirmPurchase(draftId, {
        shop_account_id: shopId, ordered_at: '2026-04-04', shipping_fee: 0,
        lines: [{ name: '下書き画像', unit_price: 1000, quantity: 1, image_url: 'https://x/confirm.jpg' }],
      })
      expect(await db.purchaseLinesNeedingImage(draftId)).toEqual([
        { id: (await db.getPurchase(draftId)).lines[0].id, image_url: 'https://x/confirm.jpg' },
      ])
    })
  })

  describe('purchaseDetailRevisitCandidates：配送状況・追跡番号のためにも注文詳細を開き直す', () => {
    // 元は todayLocal(new Date(Date.now() - n * 24h))。サーバーは UTC なので日本時間の暦日で数える
    const daysAgo = (n: number): string => subtractDaysJst(todayJst(), n)

    // 画像は取り終えた状態（product_image を登録済み＝画像の理由では候補に出ない）にして、
    // 配送の理由だけを見る
    async function makeImageDoneButUndelivered(name: string, importKey: string, orderedAt: string) {
      return db.createPurchase({
        shop_account_id: shopId, ordered_at: orderedAt, import_key: importKey,
        lines: [{ name, unit_price: 1000, quantity: 1 }],
      })
    }

    it('画像を取り終えていても、追跡番号が無く未到着なら候補に出る', async () => {
      await db.upsertProductImage('D001', 'fixed.jpg')
      const id = await makeImageDoneButUndelivered('テスト【D001】', 'mellojoy:#deliv-1', daysAgo(1))
      expect((await db.purchaseDetailRevisitCandidates(shopId, ['mellojoy:#deliv-1'], []))
        .map(c => c.id)).toEqual([id])
    })

    it('追跡番号が入ったら（未到着でも）その理由では候補に出ない', async () => {
      await db.upsertProductImage('D002', 'fixed.jpg')
      const id = await makeImageDoneButUndelivered('テスト【D002】', 'mellojoy:#deliv-2', daysAgo(1))
      await db.applyFulfillmentFromShop(id, {
        status: 'shipped', shipped_at: null, delivered_at: null, carrier: null, tracking_number: 'TRK-DELIV-2',
      })
      expect(await db.purchaseDetailRevisitCandidates(shopId, ['mellojoy:#deliv-2'], [])).toEqual([])
    })

    it('手で商品画像をセットした型番を含む注文でも、追跡番号が無く未到着なら候補に出る', async () => {
      // 通常なら product_image が存在する型番は画像の理由から丸ごと外れるが、配送の理由は別
      await db.upsertProductImage('D003', 'manual.jpg')
      const id = await makeImageDoneButUndelivered('テスト【D003】', 'mellojoy:#deliv-3', daysAgo(1))
      expect((await db.purchaseDetailRevisitCandidates(shopId, ['mellojoy:#deliv-3'], []))
        .map(c => c.id)).toEqual([id])
    })

    it('90日より古い注文は、追跡番号が無くても候補に出ない', async () => {
      await db.upsertProductImage('D004', 'fixed.jpg')
      await makeImageDoneButUndelivered('テスト【D004】', 'mellojoy:#deliv-4', daysAgo(91))
      expect(await db.purchaseDetailRevisitCandidates(shopId, ['mellojoy:#deliv-4'], [])).toEqual([])
    })

    it('90日の線はJSTの暦日で引く。UTCではまだ前日にあたる時刻（JST深夜0時台）に実行しても、' +
      'ちょうど90日前は候補に出て91日前は出ない', async () => {
      // 「いま」を JST 2026-04-10 00:15（= UTC 2026-04-09 15:15）に固定する。
      // 元は vi.useFakeTimers で時計を止めていた。ここは時計を引数（now）で渡す
      const now = new Date(Date.UTC(2026, 3, 9, 15, 15, 0))
      const base = '2026-04-10'
      expect(todayJst(now)).toBe(base)

      await db.upsertProductImage('D005', 'fixed.jpg')
      await db.upsertProductImage('D006', 'fixed.jpg')
      const exactly90 = await makeImageDoneButUndelivered('テスト【D005】', 'mellojoy:#deliv-5', subtractDaysJst(base, 90))
      await makeImageDoneButUndelivered('テスト【D006】', 'mellojoy:#deliv-6', subtractDaysJst(base, 91))

      const ids = (await db.purchaseDetailRevisitCandidates(
        shopId, ['mellojoy:#deliv-5', 'mellojoy:#deliv-6'], [], now,
      )).map(c => c.id)
      expect(ids).toEqual([exactly90])
    })
  })

  describe('exportCsvRows：CSV書き出し（purchases）', () => {
    // 元は db.exportCsvRows('purchases', month)。CSV 全体の入口（exportCsv）はホームの担当で、仕入の分はここ
    function parseCsvLine(line: string): string[] {
      const cells: string[] = []
      let cur = ''
      let inQuotes = false
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (inQuotes) {
          if (c === '"') {
            if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
          } else {
            cur += c
          }
        } else if (c === '"') {
          inQuotes = true
        } else if (c === ',') {
          cells.push(cur)
          cur = ''
        } else {
          cur += c
        }
      }
      cells.push(cur)
      return cells
    }
    function parseCsv(csv: string): { headers: string[]; rows: string[][] } {
      const clean = csv.replace(/^﻿/, '')
      if (!clean) return { headers: [], rows: [] }
      const lines = clean.split('\r\n').filter(l => l.length > 0)
      const [headerLine, ...rest] = lines
      return { headers: parseCsvLine(headerLine), rows: rest.map(parseCsvLine) }
    }

    it('0件は空文字（保存ダイアログを出さない判定に使う）', async () => {
      expect(await db.exportPurchaseRows()).toBe('')
    })

    it('purchases：1行=仕入の1明細。見出しと列数が一致し、monthでordered_at（注文日）を絞れる', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-10', shipping_fee: 100,
        lines: [{ name: '仕入品A【Q001】', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-02-10', shipping_fee: 50,
        lines: [{ name: '仕入品B【Q002】', unit_price: 2000, quantity: 1 }],
      })

      const all = parseCsv(await db.exportPurchaseRows())
      expect(all.rows).toHaveLength(2)
      expect(all.rows[0]).toHaveLength(all.headers.length)
      expect(all.headers).toEqual([
        '注文日', '仕入先', '注文番号', '状態', '商品名', '型番', '数量', '単価',
        '按分後原価', '注文の送料', '注文のその他費用', '注文の割引', 'メモ',
      ])

      const jan = parseCsv(await db.exportPurchaseRows('2026-01'))
      expect(jan.rows).toHaveLength(1)
      expect(jan.rows[0][jan.headers.indexOf('商品名')]).toBe('仕入品A【Q001】')
      expect(jan.rows[0][jan.headers.indexOf('型番')]).toBe('Q001')
      expect(jan.rows[0][jan.headers.indexOf('状態')]).toBe('確定')
      // 金額は円の整数のまま（按分後原価 = 単価 + 送料の按分）
      expect(jan.rows[0][jan.headers.indexOf('按分後原価')]).toBe('1100')
      expect(jan.rows[0][jan.headers.indexOf('注文日')]).toBe('2026-01-10')
    })

    it('月末の日付（2月28日・31日のある月）も漏れずに絞れる', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-02-28',
        lines: [{ name: '2月末', unit_price: 100, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-03-31',
        lines: [{ name: '3月末', unit_price: 100, quantity: 1 }],
      })
      expect(parseCsv(await db.exportPurchaseRows('2026-02')).rows).toHaveLength(1)
      expect(parseCsv(await db.exportPurchaseRows('2026-03')).rows).toHaveLength(1)
    })

    it('値にカンマを含む商品名は"で囲まれる', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-10',
        lines: [{ name: 'りんご,みかん', unit_price: 100, quantity: 1 }],
      })
      const csv = await db.exportPurchaseRows()
      expect(csv).toContain('"りんご,みかん"')
    })
  })
})
