import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Ctx } from '../../context'
import * as home from '../../domain/home'
import * as listing from '../../domain/listing'
import * as monthly from '../../domain/monthly'
import { todayJst } from '../../domain/_shared'
import * as sale from '../../domain/sale'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'
import { bindDb } from './core-helpers'

// 販売を「在庫なしで確定」にする印（sale.no_inventory）。相手が受け取りを拒否して商品だけ戻ってきた販売など、
// 紐付ける在庫が無い販売を、在庫 0 点・原価 ¥0 のまま紐付け済み（sale_profit.unmatched = 0）にする。
//   * on：紐付いた在庫を全部外して在庫に戻し（同じトランザクション）、印を立てる。要対応・未処理の絞り込み・
//     自動紐付け・月次の未紐付け件数から外れる
//   * off：印を外して未紐付けに戻す（外した在庫は戻さない）
//   * 在庫を紐付けると印は戻る（linkInventory・出品の引き継ぎ）

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const db = bindDb(() => w.a)
const A = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)
const B = <T>(fn: (ctx: Ctx) => Promise<T>) => w.b.run(fn)

const setNoInventory = (id: string, on: boolean) => A((c) => sale.setSaleNoInventory(c, id, on))
const getSale = async (id: string) => (await db.listSales()).find((s) => s.id === id)!
const noInventoryOf = async (id: string) =>
  (await db.sqlGet<{ no_inventory: number }>('select no_inventory from sale where id = ?', id))!.no_inventory

describe('在庫なしで確定（setSaleNoInventory）', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('on：紐付け済み（unmatched = 0）・原価 ¥0。粗利は 価格 − 手数料 − 送料 − 梱包材。要対応と未処理の絞り込みから消える', async () => {
    const id = await db.createSale({ title: '返品で戻ってきた品', sold_at: '2026-10-05', price: 3000 })
    // 手数料は 10%（3,000 → 300）。送料と梱包材を入れて「送料未入力」を外す
    await db.updateSale(id, { shipping_fee: 700, packaging_cost: 50 })
    // 比較用：何もしていない未紐付けの販売（これは残り続ける）
    const other = await db.createSale({ title: '未紐付けのまま', sold_at: '2026-10-06', price: 2000 })
    await db.updateSale(other, { shipping_fee: 200 })

    const before = await getSale(id)
    expect(before.unmatched).toBe(1)
    expect(before.no_inventory).toBe(0)
    expect((await A((c) => home.getDashboard(c))).needsMatch).toBe(2)
    expect((await db.listSales({ onlyPending: true })).map((s) => s.id).sort()).toEqual([id, other].sort())

    await setNoInventory(id, true)

    const after = await getSale(id)
    expect(after.no_inventory).toBe(1)
    expect(after.unmatched).toBe(0)
    expect(after.item_count).toBe(0)
    expect(after.cost).toBe(0)
    expect(after.fee).toBe(300)
    expect(after.gross_profit).toBe(3000 - 300 - 700 - 50) // 1,950
    expect(after.gross_profit).toBe(after.price - after.fee - after.shipping_fee - after.packaging_cost)

    // ホームの要対応（未紐付けの数）と、売上タブの「未処理だけ」から消える。ほかの未紐付けの販売は残る
    expect((await A((c) => home.getDashboard(c))).needsMatch).toBe(1)
    expect((await db.listSales({ onlyPending: true })).map((s) => s.id)).toEqual([other])
    // 区分も送料も触っていない
    expect(after.kind).toBe('resale')
    expect(after.is_shipping_confirmed).toBe(1)
  })

  it('on：送料未入力の販売は「送料未入力」としては残る（印が消すのは未紐付けだけ）', async () => {
    const id = await db.createSale({ title: '送料はまだ', sold_at: '2026-10-05', price: 1000 })
    await setNoInventory(id, true)

    const s = await getSale(id)
    expect(s.unmatched).toBe(0)
    expect(s.is_shipping_confirmed).toBe(0)
    expect((await db.listSales({ onlyPending: true })).map((x) => x.id)).toEqual([id])
    expect((await A((c) => home.getDashboard(c))).needsShipping).toBe(1)
    expect((await A((c) => home.getDashboard(c))).needsMatch).toBe(0)
  })

  it('在庫が紐付いた販売で on：sale_line が消え、その在庫は in_stock に戻り、原価は 0 になる', async () => {
    const [item1, item2] = await db.createPurchaseItems({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 100,
      lines: [{ name: '戻ってきた品A', unit_price: 1000, quantity: 1 }, { name: '戻ってきた品B', unit_price: 2000, quantity: 1 }],
    })
    const id = await db.createSale({ title: 'まとめ売り', sold_at: '2026-10-05', price: 6000 })
    await db.updateSale(id, { shipping_fee: 500 })
    await db.linkInventory(id, [item1, item2])

    const linked = await getSale(id)
    expect(linked.unmatched).toBe(0)
    expect(linked.item_count).toBe(2)
    expect(linked.cost).toBe(1000 + 2000 + 100) // 仕入送料 100 は金額按分で明細に乗っている
    expect((await db.listInventory('sold')).map((i) => i.id).sort()).toEqual([item1, item2].sort())

    await setNoInventory(id, true)

    expect(await db.sql('select * from sale_line where sale_id = ?', id)).toHaveLength(0)
    expect(await db.listSaleLines(id)).toHaveLength(0)
    const after = await getSale(id)
    expect(after.unmatched).toBe(0)
    expect(after.no_inventory).toBe(1)
    expect(after.item_count).toBe(0)
    expect(after.cost).toBe(0)
    expect(after.gross_profit).toBe(6000 - 600 - 500)
    // 在庫は売れた扱いから在庫に戻っている（原価は生成時のまま動かない）
    expect(await db.listInventory('sold')).toHaveLength(0)
    const back = await db.listInventory('in_stock')
    expect(back.map((i) => i.id).sort()).toEqual([item1, item2].sort())
    expect(back.reduce((sum, i) => sum + i.landed_cost, 0)).toBe(3100)
  })

  it('型番が一致する在庫があっても、autoLinkPending も autoLinkSale もその販売に紐付けない', async () => {
    // 在庫が無い時点の販売（createSale の自動紐付けは失敗して未紐付けのまま）
    const id = await db.createSale({ title: '【Z080-1】クリームわん', sold_at: '2026-10-05', price: 2000 })
    expect((await getSale(id)).unmatched).toBe(1)
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
    })

    await setNoInventory(id, true)

    expect(await db.autoLinkPending()).toBe(0)
    expect(await db.autoLinkPending([id])).toBe(0)
    expect(await db.autoLinkSale(id)).toBe(false)
    expect(await db.getAutoLinkBlockers(id)).toEqual([])
    const s = await getSale(id)
    expect(s.unmatched).toBe(0)
    expect(s.item_count).toBe(0)
    expect(s.auto_linked).toBe(0)
    expect(await db.listInventory('sold')).toHaveLength(0)
    expect(await db.listInventory('in_stock')).toHaveLength(1)

    // 印を外せば、また自動紐付けの対象に戻る（同じ在庫が型番一致で紐付く）
    await setNoInventory(id, false)
    expect(await db.autoLinkPending()).toBe(1)
    const linked = await getSale(id)
    expect(linked.unmatched).toBe(0)
    expect(linked.auto_linked).toBe(1)
    expect(linked.cost).toBe(1000)
  })

  it('off：未紐付け（unmatched = 1）に戻る。外した在庫は戻らない。何度呼んでも同じ', async () => {
    const [item] = await db.createPurchaseItems({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [{ name: '戻ってきた品', unit_price: 1500, quantity: 1 }],
    })
    const id = await db.createSale({ title: '一度紐付けた販売', sold_at: '2026-10-05', price: 4000 })
    await db.linkInventory(id, [item])

    await setNoInventory(id, true)
    await setNoInventory(id, true) // 2 回目も同じ
    expect((await getSale(id)).unmatched).toBe(0)

    await setNoInventory(id, false)
    await setNoInventory(id, false) // 2 回目も同じ
    const s = await getSale(id)
    expect(s.no_inventory).toBe(0)
    expect(s.unmatched).toBe(1)
    expect(s.item_count).toBe(0)
    expect(s.cost).toBe(0)
    // 外した在庫は戻らない（在庫のまま。もう一度紐付けるのは人の操作）
    expect(await db.sql('select * from sale_line where sale_id = ?', id)).toHaveLength(0)
    expect((await db.listInventory('in_stock')).map((i) => i.id)).toEqual([item])
    expect((await A((c) => home.getDashboard(c))).needsMatch).toBe(1)
    expect((await db.listSales({ onlyPending: true })).map((x) => x.id)).toEqual([id])
  })

  it('off：紐付けの無い販売に呼んでも何も壊れない（最初から印が無い販売も同じ）', async () => {
    const id = await db.createSale({ title: '何もしていない販売', sold_at: '2026-10-05', price: 1000 })
    await setNoInventory(id, false)
    const s = await getSale(id)
    expect(s.no_inventory).toBe(0)
    expect(s.unmatched).toBe(1)
  })

  it('on の販売に linkInventory：印が戻り、ふつうの紐付け済みになる（原価が入る）', async () => {
    const [item] = await db.createPurchaseItems({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [{ name: '後から見つかった在庫', unit_price: 1800, quantity: 1 }],
    })
    const id = await db.createSale({ title: '在庫なしで確定した販売', sold_at: '2026-10-05', price: 4000 })
    await setNoInventory(id, true)
    expect(await noInventoryOf(id)).toBe(1)

    await db.linkInventory(id, [item])

    expect(await noInventoryOf(id)).toBe(0)
    const s = await getSale(id)
    expect(s.no_inventory).toBe(0)
    expect(s.unmatched).toBe(0)
    expect(s.item_count).toBe(1)
    expect(s.cost).toBe(1800)
    expect(s.gross_profit).toBe(4000 - 400 - 1800)
    expect((await db.listInventory('sold')).map((i) => i.id)).toEqual([item])

    // その紐付けを外せば、ふつうの未紐付けに戻る（印は戻らない）
    await db.unlinkInventory(id, item)
    const unlinked = await getSale(id)
    expect(unlinked.no_inventory).toBe(0)
    expect(unlinked.unmatched).toBe(1)
  })

  it('出品の引き当てを引き継ぐ（takeOverListing）と印が戻る。引き当てが無ければ印は残る', async () => {
    const [item] = await db.createPurchaseItems({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [{ name: '出品に引き当てた在庫', unit_price: 900, quantity: 1 }],
    })
    await db.upsertListings([
      { mercariItemId: 'mNoInvA', title: '出品A', price: 3000, suspended: false, thumbUrl: null },
      { mercariItemId: 'mNoInvB', title: '出品B', price: 3000, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('mNoInvA', [item])

    const withLine = await db.createSale({ title: '出品Aが売れた', sold_at: '2026-10-05', price: 3000 })
    const withoutLine = await db.createSale({ title: '出品Bが売れた', sold_at: '2026-10-05', price: 3000 })
    await setNoInventory(withLine, true)
    await setNoInventory(withoutLine, true)

    // 引き当てが無い出品が売れても、在庫が付かないので印は残る
    expect(await A((c) => listing.takeOverListing(c, withoutLine, 'mNoInvB'))).toBe(false)
    expect(await noInventoryOf(withoutLine)).toBe(1)
    expect((await getSale(withoutLine)).unmatched).toBe(0)

    expect(await A((c) => listing.takeOverListing(c, withLine, 'mNoInvA'))).toBe(true)
    expect(await noInventoryOf(withLine)).toBe(0)
    const s = await getSale(withLine)
    expect(s.unmatched).toBe(0)
    expect(s.cost).toBe(900)
    expect(await db.sql<{ link_source: string }>('select link_source from sale_line where sale_id = ?', withLine))
      .toEqual([{ link_source: 'listing' }])
  })

  it('取引完了（completed）の on の販売が monthly_summary に原価 0 で入る。月の未紐付け件数には数えない', async () => {
    const id = await db.createSale({ title: '返品された品', sold_at: '2026-10-05', price: 5000 })
    await db.updateSale(id, { shipping_fee: 800, packaging_cost: 100 })
    await db.applySaleActuals(id, { status: 'completed' })
    // 比較用：同じ月の、ふつうの紐付け済みの販売（原価 1,200）
    const [item] = await db.createPurchaseItems({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [{ name: 'ふつうに売れた品', unit_price: 1200, quantity: 1 }],
    })
    const normal = await db.createSale({ title: 'ふつうの販売', sold_at: '2026-10-07', price: 2000 })
    await db.updateSale(normal, { shipping_fee: 0 })
    await db.applySaleActuals(normal, { status: 'completed' })
    await db.linkInventory(normal, [item])

    const month = async () => (await db.sql<{
      sales_count: number; revenue: number; total_fee: number; total_shipping: number; total_packaging: number
      total_cost: number; gross_profit: number
    }>(`
      select sales_count, revenue, total_fee, total_shipping, total_packaging, total_cost, gross_profit
        from monthly_summary where month = '2026-10' and kind = 'resale'
    `))[0]

    // on にする前（未紐付け）：原価 0 で入っているが、月の未紐付けは 1 件
    expect((await A((c) => monthly.getMonthDetail(c, '2026-10'))).pending.unmatched).toBe(1)

    await setNoInventory(id, true)

    expect(await month()).toEqual({
      sales_count: 2,
      revenue: 5000 + 2000,
      total_fee: 500 + 200,
      total_shipping: 800,
      total_packaging: 100,
      total_cost: 1200, // 在庫なしで確定した販売の原価は 0
      gross_profit: (5000 - 500 - 800 - 100) + (2000 - 200 - 1200), // 3,600 + 600
    })
    const detail = await A((c) => monthly.getMonthDetail(c, '2026-10'))
    expect(detail.pending.unmatched).toBe(0)
    expect(detail.totals.gross_profit).toBe(4200)
    // 画面側の合計（sale_profit の一覧の和）もビューの月次と一致する
    const sales = await db.listSales({ month: '2026-10' })
    expect(sales.reduce((sum, s) => sum + s.gross_profit, 0)).toBe(4200)
  })

  it('型番の後足し（appendModelCodes）や createSale 経由の autoLinkSale が直に呼ばれても、人の「在庫なしで確定」を覆さない', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [{ name: 'モコ【Z090-1】', unit_price: 1000, quantity: 2 }],
    })
    const noInv = await db.createSale({ title: '型番がまだ無い販売A', sold_at: '2026-10-05', price: 2000 })
    const control = await db.createSale({ title: '型番がまだ無い販売B', sold_at: '2026-10-05', price: 2000 })
    await setNoInventory(noInv, true)

    // 説明文から型番が見つかった（収集が後から足す）。在庫は型番一致で 2 点ある
    expect(await db.appendModelCodes(noInv, ['Z090-1'])).toBe(true)
    expect(await db.appendModelCodes(control, ['Z090-1'])).toBe(true)

    // 印の無い販売は型番 FIFO で自動確定する。印のある販売は覆されず、在庫も使われない
    const c = await getSale(control)
    expect(c.unmatched).toBe(0)
    expect(c.auto_linked).toBe(1)
    const s = await getSale(noInv)
    expect(s.model_codes).toEqual(['Z090-1'])
    expect(s.no_inventory).toBe(1)
    expect(s.unmatched).toBe(0)
    expect(s.item_count).toBe(0)
    expect(s.cost).toBe(0)
    expect(await db.sql('select * from sale_line where sale_id = ?', noInv)).toHaveLength(0)
    expect(await db.listInventory('in_stock')).toHaveLength(1) // 残りの 1 点は control に使われた分を除いた在庫
    expect(await db.autoLinkSale(noInv)).toBe(false)
  })

  it('getAutoLinkBlockers：印のある販売は [] を返す（出品が在庫を取っていても理由を出さない）。外せば出る', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [{ name: '【A051】商品', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.upsertListings([
      { mercariItemId: 'm-noinv-blk', title: '【A051】商品', price: 3000, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('m-noinv-blk', [item.id])
    const id = await db.createSale({ title: '商品【A051】', sold_at: '2026-10-05', price: 3000 })
    expect((await getSale(id)).unmatched).toBe(1)
    expect((await db.getAutoLinkBlockers(id)).map((b) => b.inventory_item_id)).toEqual([item.id])

    await setNoInventory(id, true)
    expect(await db.getAutoLinkBlockers(id)).toEqual([])

    await setNoInventory(id, false)
    expect((await db.getAutoLinkBlockers(id)).map((b) => b.inventory_item_id)).toEqual([item.id])
  })

  it('ホームの点検：unmatched-old と listing-blocks-sale は、印のある販売を数えない（外せば数える）', async () => {
    const checks = async () => A((c) => home.getHealthChecks(c))
    const count = async (checkId: string) => (await checks()).find((x) => x.id === checkId)?.count ?? 0

    // 30 日以上前の、紐付けていない転売の販売
    const old = await db.createSale({ title: '古い未紐付け', sold_at: '2020-01-10', price: 1000 })
    // 型番が 1 つで、在庫が出品に取ってあって止まっている販売
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [{ name: '【A051】商品', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.upsertListings([
      { mercariItemId: 'm-noinv-home', title: '【A051】商品', price: 3000, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('m-noinv-home', [item.id])
    // 古くない販売（unmatched-old には数えない）にして、listing-blocks-sale だけを見る
    const blocked = await db.createSale({ title: '商品【A051】', sold_at: todayJst(), price: 3000 })
    expect((await getSale(blocked)).unmatched).toBe(1)

    expect(await count('unmatched-old')).toBe(1)
    expect(await count('listing-blocks-sale')).toBe(1)

    await setNoInventory(old, true)
    expect(await count('unmatched-old')).toBe(0)
    expect(await count('listing-blocks-sale')).toBe(1) // 別の販売なので変わらない

    await setNoInventory(blocked, true)
    expect(await count('listing-blocks-sale')).toBe(0)

    await setNoInventory(old, false)
    await setNoInventory(blocked, false)
    expect(await count('unmatched-old')).toBe(1)
    expect(await count('listing-blocks-sale')).toBe(1)
  })

  it('API の入口（dispatch）経由：200 で印が付き、真偽値でない引数は 400、存在しない販売は 404', async () => {
    const id = await db.createSale({ title: 'API から確定する販売', sold_at: '2026-10-05', price: 1000 })

    const ok = await w.a.call('setSaleNoInventory', id, true)
    expect(ok.status).toBe(200)
    expect(await noInventoryOf(id)).toBe(1)
    expect((await getSale(id)).unmatched).toBe(0)

    const off = await w.a.call('setSaleNoInventory', id, false)
    expect(off.status).toBe(200)
    expect(await noInventoryOf(id)).toBe(0)

    // 真偽値でない（'true' / 1 / null）は断る。何も書き換えない
    for (const bad of ['true', 1, null, undefined]) {
      const res = await w.a.call('setSaleNoInventory', id, bad)
      expect(res.status, String(bad)).toBe(400)
    }
    expect((await w.a.call('setSaleNoInventory', 'not-a-uuid', true)).status).toBe(400)
    expect(await noInventoryOf(id)).toBe(0)

    const missing = await w.a.call('setSaleNoInventory', randomUUID(), true)
    expect(missing.status).toBe(404)
    expect(missing.body.error?.message).toBe('販売が見つかりません')
  })

  it('世帯 B から世帯 A の販売は見つからない（id を知っていても。紐付けも印も動かない）', async () => {
    const [item] = await db.createPurchaseItems({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [{ name: '世帯Aの在庫', unit_price: 1000, quantity: 1 }],
    })
    const saleA = await db.createSale({ title: '世帯Aの販売', sold_at: '2026-10-05', price: 3000 })
    await db.linkInventory(saleA, [item])

    const res = await w.b.call('setSaleNoInventory', saleA, true)
    expect(res.status).toBe(404)
    expect(res.body.error?.message).toBe('販売が見つかりません')
    await expect(B((c) => sale.setSaleNoInventory(c, saleA, true))).rejects.toThrow('販売が見つかりません')
    await expect(B((c) => sale.setSaleNoInventory(c, saleA, false))).rejects.toThrow('販売が見つかりません')

    // A の販売は何も変わっていない（紐付けも、在庫の状態も、印も）
    expect(await noInventoryOf(saleA)).toBe(0)
    const s = await getSale(saleA)
    expect(s.item_count).toBe(1)
    expect(s.unmatched).toBe(0)
    expect(await db.sql('select * from sale_line where sale_id = ?', saleA)).toHaveLength(1)
    expect((await db.listInventory('sold')).map((i) => i.id)).toEqual([item])
  })
})
