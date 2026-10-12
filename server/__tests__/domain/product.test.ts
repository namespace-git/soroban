import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import { UserError } from '../../errors'
import * as product from '../../domain/product'
import * as purchase from '../../domain/purchase'
import { thisMonthJst } from '../../domain/_shared'
import type { PurchaseInput, SaleInput } from '../../../src/shared/types'
import { MEDIA_BASE, newWorld, openDomainDb, type DomainDb, type World } from './helpers'
import { bindDb } from './core-helpers'

// src/main/__tests__/db.test.ts の商品（型番）・商品画像・在庫の履歴（timeline）のテストを移したもの。
// 期待値は変えていない。書き換えたのは「呼び方」だけ：
//   * 同期の db.xxx(...) → await db.xxx(...)（db は下の薄い包み。1 回の呼び出し＝1 リクエスト＝1 トランザクション）
//   * expect(() => …).toThrow() → await expect(…).rejects.toThrow()
//   * 仕入は本物の purchase.createPurchase（仕入のドメイン）を使う。販売・出品・在庫は core-helpers の包み
//   * createCompletedSale は createSale → applySaleActuals({ status: 'completed' })（src/main/__tests__/completed-sale.ts と同じ）
//   * 存在しない在庫の id は 'no-such-id' ではなく uuid の形の「無い id」（Postgres の列が uuid のため。uuid でない文字列は UserError で別に確かめた）
//   * 偽の時計はローカル時刻ではなく UTC の瞬間で置く（サーバー＝Workers は UTC。日本時間の月は UTC の 15:00〜23:59 で翌月になる）
// 移した元（db.test.ts）：
//   variant_summary（3 本）／setProductName／setProductNote／getItemTimeline（3 本＋出品先の 2 本＋出品の 1 本）／
//   listProducts／getProduct／setProductTags（3 本）
//   recognition.test.ts の「商品別の粗利も実績と見込みを分け…」「状態未設定の手入力は実績…」の listProducts / getProduct の分
//   scenarios/ persona-02（まとめ売り）／persona-03（ばらす）／persona-11（廃棄・自家消費）の商品・履歴の分
// 移していないもの：
//   * setProductNote の getProductKarte（views.ts＝受信箱・ビューの担当）。メモは listProducts / getProduct で確かめた
//   * productImageFiles の優先順位（derive の担当が linking.test.ts に移し済み）。ここでは listProducts / getProduct の画像（thumb_url・image_manual）で確かめた
//   * persona-15 のうち HTML の解析（parseOrderDetailHtml ほか＝収集の担当）。到着状態が進んで履歴に日付が出る分だけ移した
//   * persona-21 の履歴の分は home.test.ts

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const A = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)
const core = bindDb(() => w.a)

/** 元のテストの `db.` と同じ形で呼べる、世帯 A の薄い包み */
const db = {
  ...core,
  createPurchase: (input: PurchaseInput) => A((c) => purchase.createPurchase(c, input)),
  listVariantSummary: (sort?: Parameters<typeof product.listVariantSummary>[1]) => A((c) => product.listVariantSummary(c, sort)),
  listProducts: (sort?: Parameters<typeof product.listProducts>[1]) => A((c) => product.listProducts(c, sort)),
  getProduct: (code: string) => A((c) => product.getProduct(c, code)),
  getItemTimeline: (id: string) => A((c) => product.getItemTimeline(c, id)),
  setProductTags: (code: string, tagIds: string[]) => A((c) => product.setProductTags(c, code, tagIds)),
  setProductName: (code: string, name: string | null) => A((c) => product.setProductName(c, code, name)),
  setProductNote: (code: string, note: string | null) => A((c) => product.setProductNote(c, code, note)),
  getProductImage: (code: string) => A((c) => product.getProductImage(c, code)),
  upsertProductImage: (code: string, path: string) => A((c) => product.upsertProductImage(c, code, path)),
  deleteProductImage: (code: string) => A((c) => product.deleteProductImage(c, code)),
}

/** 集計テスト用：取引完了を明示した販売を作る。状態未設定の仕様とは分ける */
async function createCompletedSale(input: SaleInput): Promise<string> {
  const id = await db.createSale(input)
  await db.applySaleActuals(id, { status: 'completed' })
  return id
}

/** uuid の形で、どの行にも当たらない id */
const NO_SUCH = '00000000-0000-4000-8000-000000000001'

describe('商品（型番）', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  // ---------------- variant_summary ----------------

  it('variant_summary：purchased/sold/avg_price/avg_profit/total_profitが手計算と一致する', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      shipping_fee: 100,
      lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
    })
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-10',
      shipping_fee: 150,
      lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
    })
    await createCompletedSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-09-15', price: 2000 })
    await createCompletedSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-09-16', price: 2000 })

    const summary = (await db.listVariantSummary()).find(v => v.model_code === 'Z080-1')!
    expect(summary.purchased).toBe(2)
    expect(summary.sold).toBe(2)
    expect(summary.in_stock).toBe(0)
    // 手数料10%: fee=200 → gross_profit = 2000-200-cost
    // cost: 1100, 1150 → gross_profit: 700, 650
    expect(summary.avg_price).toBe(2000)
    expect(summary.avg_profit).toBe(Math.round((700 + 650) / 2))
    expect(summary.total_profit).toBe(700 + 650)
  })

  it('variant_summary：分割した在庫はまるごと換算（1/分割数の重み）で平均する', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      shipping_fee: 0,
      lines: [{ name: 'ぬいぐるみ【X001】', unit_price: 3000, quantity: 2 }],
    })
    const [whole, toSplit] = await db.listInventory('in_stock')

    // 1点目はまるごと¥3,600で販売。手数料10%: fee=360 → 粗利 = 3600-360-3000 = 240
    const saleWhole = await createCompletedSale({ title: 'まるごと販売', sold_at: '2026-09-10', price: 3600 })
    await db.linkInventory(saleWhole, [whole.id])

    // 2点目は4分割（750ずつ）。1個¥1,000で4個販売。手数料10%: fee=100 → 粗利 = 1000-100-750 = 150
    const childIds = await db.splitInventory(toSplit.id, 4)
    let n = 0
    for (const childId of childIds) {
      n += 1
      const saleId = await createCompletedSale({ title: `ばら売り${n}`, sold_at: '2026-09-11', price: 1000 })
      await db.linkInventory(saleId, [childId])
    }

    const summary = (await db.listVariantSummary()).find(v => v.model_code === 'X001')!
    expect(summary.sold).toBe(5) // 件数（「点」）は従来どおり5点
    // avg_price = Σprice_share ÷ Σweight = (3600 + 4*1000) / (1 + 4*0.25) = 7600 / 2 = 3800
    expect(summary.avg_price).toBe(3800)
    // avg_profit = Σprofit_share ÷ Σweight = (240 + 4*150) / 2 = 840 / 2 = 420
    expect(summary.avg_profit).toBe(420)
    expect(summary.total_profit).toBe(240 + 4 * 150)
  })

  it('variant_summary：分割の分割（孫）も再帰的に重みを算出する（1/8）', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      shipping_fee: 0,
      lines: [{ name: 'ぬいぐるみ【Y001】', unit_price: 800, quantity: 1 }],
    })
    const parent = (await db.listInventory('in_stock'))[0]
    const children = await db.splitInventory(parent.id, 4) // 各200（重み1/4）
    const grandchildren = await db.splitInventory(children[0], 2) // 各100（重み1/8）

    // 孫2点をまとめて¥600で販売。手数料10%: fee=60 → 粗利 = 600-60-(100+100) = 340
    const saleId = await createCompletedSale({ title: 'まとめ売り', sold_at: '2026-09-12', price: 600 })
    await db.linkInventory(saleId, grandchildren)

    const summary = (await db.listVariantSummary()).find(v => v.model_code === 'Y001')!
    // Σweight = 1/8 + 1/8 = 0.25 → avg_price = 600/0.25 = 2400、avg_profit = 340/0.25 = 1360
    expect(summary.avg_price).toBe(2400)
    expect(summary.avg_profit).toBe(1360)
    expect(summary.total_profit).toBe(340)
  })

  it('listVariantSummary：並び順（利益の大きい順／平均利益／販売数）。未計算（null）は最後。画面に世帯の id は出ない', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [
        { name: '高い利益【H001】', unit_price: 1000, quantity: 1 },
        { name: '低い利益【L001】', unit_price: 1000, quantity: 2 },
        { name: '売れない【N001】', unit_price: 1000, quantity: 1 },
      ],
    })
    await createCompletedSale({ title: '高い利益【H001】', sold_at: '2026-09-10', price: 5000 }) // 粗利 3500
    await createCompletedSale({ title: '低い利益【L001】', sold_at: '2026-09-10', price: 1500 }) // 粗利 350
    await createCompletedSale({ title: '低い利益【L001】', sold_at: '2026-09-11', price: 1500 }) // 粗利 350

    const byProfit = await db.listVariantSummary('total_profit')
    expect(byProfit.map(v => v.model_code)).toEqual(['H001', 'L001', 'N001'])
    const byAvg = await db.listVariantSummary('avg_profit')
    // N001 は一度も売れていないので avg_profit が null → 最後
    expect(byAvg.map(v => v.model_code)).toEqual(['H001', 'L001', 'N001'])
    expect(byAvg[2].avg_profit).toBeNull()
    const bySold = await db.listVariantSummary('sold')
    expect(bySold.map(v => v.model_code)).toEqual(['L001', 'H001', 'N001'])
    // 既定は total_profit
    expect((await db.listVariantSummary()).map(v => v.model_code)).toEqual(['H001', 'L001', 'N001'])
    for (const v of byProfit) expect(Object.keys(v)).not.toContain('household_id')
  })

  // ---------------- 表示名・メモ ----------------

  it('setProductName：表示名を上書きし、nullで最新の在庫名に戻る', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      shipping_fee: 0,
      lines: [{ name: 'ムースクリーム（箱）旧名【Z078-2】', unit_price: 1000, quantity: 1 }],
    })

    await db.setProductName('Z078-2', 'ムースクリーム（箱）')

    const products = await db.listProducts()
    const p = products.find(x => x.model_code === 'Z078-2')!
    expect(p.name).toBe('ムースクリーム（箱）')
    expect(p.custom_name).toBe('ムースクリーム（箱）')

    const variants = await db.listVariantSummary()
    const v = variants.find(x => x.model_code === 'Z078-2')!
    expect(v.name).toBe('ムースクリーム（箱）')
    expect(v.custom_name).toBe('ムースクリーム（箱）')

    await db.setProductName('Z078-2', null)
    const after = (await db.listProducts()).find(x => x.model_code === 'Z078-2')!
    expect(after.name).toBe('ムースクリーム（箱）旧名【Z078-2】')
    expect(after.custom_name).toBeNull()
  })

  it('setProductNote：型番のメモを付ける／消す。表示名とは独立に残る', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-09-01',
      shipping_fee: 0,
      lines: [{ name: 'ムースクリーム（箱）【Z078-2】', unit_price: 1000, quantity: 1 }],
    })

    // メモだけ付ける（表示名は付けない）
    await db.setProductNote('Z078-2', '型崩れしやすいので注意')
    let p = (await db.listProducts()).find(x => x.model_code === 'Z078-2')!
    expect(p.note).toBe('型崩れしやすいので注意')
    expect(p.custom_name).toBeNull()
    // 商品ページ（getProduct）にも同じメモが出る（元は views.getProductKarte の summary.note で確かめていた）
    expect((await db.getProduct('Z078-2'))!.note).toBe('型崩れしやすいので注意')

    // 表示名を付けてもメモは残る
    await db.setProductName('Z078-2', 'ムースクリーム（箱）')
    p = (await db.listProducts()).find(x => x.model_code === 'Z078-2')!
    expect(p.custom_name).toBe('ムースクリーム（箱）')
    expect(p.note).toBe('型崩れしやすいので注意')

    // メモを消しても表示名は残る
    await db.setProductNote('Z078-2', null)
    p = (await db.listProducts()).find(x => x.model_code === 'Z078-2')!
    expect(p.note).toBeNull()
    expect(p.custom_name).toBe('ムースクリーム（箱）')

    // 空文字も null 扱いで消える
    await db.setProductNote('Z078-2', '追記メモ')
    await db.setProductNote('Z078-2', '   ')
    p = (await db.listProducts()).find(x => x.model_code === 'Z078-2')!
    expect(p.note).toBeNull()
  })

  it('setProductName / setProductNote：両方が空になったら行ごと消える。在庫に無い型番にも保存できる', async () => {
    await db.setProductName('NOSTOCK-1', '在庫の無い型番')
    await db.setProductNote('NOSTOCK-1', 'メモ')
    expect(await db.sql('select name, note from product_name where model_code = ?', 'NOSTOCK-1'))
      .toEqual([{ name: '在庫の無い型番', note: 'メモ' }])

    await db.setProductName('NOSTOCK-1', '  ') // 表示名だけ消す（メモが残るので行は残る）
    expect(await db.sql('select name, note from product_name where model_code = ?', 'NOSTOCK-1'))
      .toEqual([{ name: null, note: 'メモ' }])

    await db.setProductNote('NOSTOCK-1', null) // 両方空 → 行ごと消える
    expect(await db.sql('select 1 from product_name where model_code = ?', 'NOSTOCK-1')).toEqual([])
  })

  // ---------------- 履歴（getItemTimeline） ----------------

  it('getItemTimeline：仕入（送料按分あり）→販売（まとめ売り2点）でeventsの順・detailの数字が合う', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      order_no: 'ORDER-9',
      shipping_fee: 100,
      lines: [{ name: 'タイムライン商品', unit_price: 1000, quantity: 3 }],
    })
    // fulfillment未指定（null）＝手入力扱い。発送・到着イベントは出ない
    const items = [...await db.listInventory('in_stock')].sort((a, b) => a.landed_cost - b.landed_cost)
    expect(items.map(i => i.landed_cost)).toEqual([1033, 1033, 1034])

    const saleId = await db.createSale({ title: 'まとめ売りテスト', sold_at: '2026-01-10', price: 4000 })
    await db.linkInventory(saleId, [items[0].id, items[2].id]) // 1033 と 1034 をまとめ売り

    const timeline = (await db.getItemTimeline(items[2].id))! // landed_cost 1034（端数が乗った方）
    expect(timeline).not.toBeNull()
    expect(timeline.purchase?.order_no).toBe('ORDER-9')
    expect(timeline.sale?.id).toBe(saleId)

    const kinds = timeline.events.map(e => e.kind)
    expect(kinds).toEqual(['ordered', 'sold', 'sale_shipped', 'sale_delivered', 'sale_completed'])

    const ordered = timeline.events[0]
    expect(ordered.date).toBe('2026-01-01')
    expect(ordered.detail).toBe('¥1,000 ＋送料按分 ¥34 → 原価 ¥1,034')
    expect(ordered.amount).toBe(1034)

    const sold = timeline.events[1]
    expect(sold.date).toBe('2026-01-10')
    expect(sold.detail).toBe('¥4,000 （まとめ売り 2 点、1 点あたり ¥2,000）')
    expect(sold.amount).toBe(4000)

    // 発送・受取・取引完了はまだ取れていないので日付null（予定）
    expect(timeline.events[2].date).toBeNull()
    expect(timeline.events[3].date).toBeNull()
    const completed = timeline.events[4]
    expect(completed.date).toBeNull()
    // fee = floor(4000*1000/10000) = 400、shipping_fee = 0
    expect(completed.detail).toBe('売上金 ¥3,600 反映')
  })

  it('getItemTimeline：fulfillmentがpendingなら仕入の発送・到着が日付nullで出る（nullなら出ない）', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      fulfillment: 'pending',
      import_key: 'mellojoy:#timeline-pending',
      lines: [{ name: 'pending商品', unit_price: 1000, quantity: 1 }],
    })
    const pendingItem = (await db.listInventory('in_stock'))[0]
    const pendingTimeline = (await db.getItemTimeline(pendingItem.id))!
    expect(pendingTimeline.events.map(e => e.kind)).toEqual(['ordered', 'purchase_shipped', 'purchase_delivered'])
    expect(pendingTimeline.events[1].date).toBeNull()
    expect(pendingTimeline.events[2].date).toBeNull()

    // fulfillment未指定（null）の仕入では発送・到着イベントが出ない
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: 'null商品', unit_price: 1000, quantity: 1 }],
    })
    const nullItem = (await db.listInventory('in_stock')).find(i => i.name === 'null商品')!
    const nullTimeline = (await db.getItemTimeline(nullItem.id))!
    expect(nullTimeline.events.map(e => e.kind)).toEqual(['ordered'])
  })

  it('persona-15：到着状態が進むと履歴の「仕入先が発送」「到着」に日付が入る。お店の実際の日付を渡せばそちらが出る', async () => {
    const purchaseId = await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-19', shipping_fee: 499,
      import_key: 'mellojoy:#268526', fulfillment: 'pending',
      lines: [
        { name: '【Z078-2】ムースクリーム', unit_price: 2499, quantity: 1 },
        { name: '【Z074-4】いちごスフレ', unit_price: 2399, quantity: 1 },
      ],
    })
    const item = (await db.listInventory('in_stock')).find(i => i.model_code === 'Z078-2')!
    // 按分の手計算：total = 4898、line1 = trunc(499*2499/4898) = 254、最終行は残り 245。原価 = 単価 + 配分
    expect(item.landed_cost).toBe(2499 + 254)

    let timeline = (await db.getItemTimeline(item.id))!
    expect(timeline.events.map(e => e.kind)).toEqual(['ordered', 'purchase_shipped', 'purchase_delivered'])
    expect(timeline.events[0].detail).toBe('¥2,499 ＋送料按分 ¥254 → 原価 ¥2,753')
    expect(timeline.events[1].date).toBeNull()

    // 注文一覧の状態から進める（気づいた日＝今日の日付が入る）
    expect(await A((c) => purchase.updatePurchaseFulfillment(c, 'mellojoy:#268526', 'shipped'))).toBe(true)
    expect(await A((c) => purchase.updatePurchaseFulfillment(c, 'mellojoy:#268526', 'delivered'))).toBe(true)
    timeline = (await db.getItemTimeline(item.id))!
    const today = (await db.sqlGet<{ d: string }>(`select (now() at time zone 'Asia/Tokyo')::date::text as d`))!.d
    expect(timeline.events.find(e => e.kind === 'purchase_shipped')).toMatchObject({ title: '仕入先が発送', date: today })
    expect(timeline.events.find(e => e.kind === 'purchase_delivered')).toMatchObject({ title: '到着', date: today })

    // 注文詳細から読めた「お店の実際の日」で上書きすると、履歴はその日付で並ぶ
    await A((c) => purchase.applyFulfillmentFromShop(c, purchaseId, {
      status: 'delivered', shipped_at: '2026-09-21', delivered_at: '2026-09-24', carrier: null, tracking_number: null,
    }))
    timeline = (await db.getItemTimeline(item.id))!
    expect(timeline.events.map(e => [e.kind, e.date])).toEqual([
      ['ordered', '2026-09-19'], ['purchase_shipped', '2026-09-21'], ['purchase_delivered', '2026-09-24'],
    ])
    // 仕入の要約（注文番号・仕入先・注文日・到着日）もそのまま返る
    expect(timeline.purchase).toMatchObject({ id: purchaseId, ordered_at: '2026-09-19', delivered_at: '2026-09-24' })
  })

  it('getItemTimeline：存在しない在庫はnull。uuid の形でない id は UserError（500 にしない）', async () => {
    expect(await db.getItemTimeline(NO_SUCH)).toBeNull()
    await expect(db.getItemTimeline('no-such-id')).rejects.toBeInstanceOf(UserError)
  })

  it('getItemTimeline：出品先の名前が履歴に出る（Yahoo!フリマ→「Yahoo!フリマで売れた」、メルカリ→「メルカリで売れた」）', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: '出品先の履歴確認', unit_price: 1000, quantity: 2 }],
    })
    const [yahooItem, mercariItem] = await db.listInventory('in_stock')

    const yahooSaleId = await db.createSale({
      title: 'Yahoo販売', sold_at: '2026-01-10', price: 5000, channel: 'yahoo',
    })
    await db.linkInventory(yahooSaleId, [yahooItem.id])
    const mercariSaleId = await db.createSale({
      title: 'メルカリ販売', sold_at: '2026-01-10', price: 5000, channel: 'mercari',
    })
    await db.linkInventory(mercariSaleId, [mercariItem.id])

    const yahooSold = (await db.getItemTimeline(yahooItem.id))!.events.find(e => e.kind === 'sold')!
    const mercariSold = (await db.getItemTimeline(mercariItem.id))!.events.find(e => e.kind === 'sold')!
    expect(yahooSold.title).toBe('Yahoo!フリマで売れた')
    expect(yahooSold.title).not.toContain('メルカリ')
    expect(mercariSold.title).toBe('メルカリで売れた')
  })

  it('getItemTimeline：Yahoo!フリマの出品に引き当てた在庫は「Yahoo!フリマに出品」と出る（売れたあとも）', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2020-01-01',
      shipping_fee: 0,
      lines: [{ name: 'Yahoo出品履歴確認', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.upsertListings(
      [{ mercariItemId: 'YLT', title: 'Yahoo出品履歴確認', price: 3000, suspended: false, thumbUrl: null }],
      'yahoo',
    )
    await db.reserveInventory('YLT', [item.id])

    const listed = (await db.getItemTimeline(item.id))!.events.find(e => e.kind === 'listed')!
    expect(listed.title).toBe('Yahoo!フリマに出品')
    expect(listed.title).not.toContain('メルカリ')

    await db.insertCollected(
      [{ mercariItemId: 'YLT', title: 'Yahoo出品履歴確認', price: 3000, soldAt: '2099-01-01' }],
      'yahoo',
    )
    const events = (await db.getItemTimeline(item.id))!.events
    expect(events.find(e => e.kind === 'listed')!.title).toBe('Yahoo!フリマに出品')
    expect(events.find(e => e.kind === 'sold')!.title).toBe('Yahoo!フリマで売れた')
  })

  it('getItemTimeline：メルカリと Yahoo!フリマで同じ商品IDの出品があっても、在庫を引き当てた出品の価格を出す', async () => {
    // 出品は (出品先, 商品ID) で一意。同じ ID の別の出品先の出品を取り違えない（新規：Web 版は出品先もキーにして引く）
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2020-01-01', shipping_fee: 0,
      lines: [{ name: '同じID確認', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    const insertListing = async (channel: string, title: string, price: number) =>
      (await db.sqlGet<{ id: string }>(
        `insert into listing (channel, channel_item_id, title, price, status, first_seen_at, last_seen_at, listed_at)
         values (?, 'SAME', ?, ?, 'active', '2026-01-01', now(), '2026-01-02') returning id`,
        channel, title, price,
      ))!.id
    await insertListing('mercari', 'メルカリの出品', 1111)
    const yahooListingId = await insertListing('yahoo', 'Yahooの出品', 2222)
    await db.sqlRun('insert into listing_line (listing_id, inventory_item_id) values (?, ?)', yahooListingId, item.id)

    const listed = (await db.getItemTimeline(item.id))!.events.find(e => e.kind === 'listed')!
    expect(listed.title).toBe('Yahoo!フリマに出品')
    expect(listed.amount).toBe(2222)
    expect(listed.date).toBe('2026-01-02')
  })

  it('getItemTimeline：出品への引き当て・出品経由の売却でlistedイベントが「注文」と「売れた」の間に出る', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2020-01-01',
      shipping_fee: 0,
      lines: [{ name: 'タイムライン出品商品', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]
    await db.upsertListings([
      { mercariItemId: 'LT', title: 'タイムライン出品商品', price: 3000, suspended: false, thumbUrl: null },
    ])
    await db.reserveInventory('LT', [item.id])

    const beforeSale = (await db.getItemTimeline(item.id))!
    expect(beforeSale.events.map(e => e.kind)).toEqual(['ordered', 'listed'])
    const listedEvent = beforeSale.events[1]
    expect(listedEvent.title).toBe('メルカリに出品')
    expect(listedEvent.detail).toBe('¥3,000')
    expect(listedEvent.amount).toBe(3000)

    // 未来日で確実に「今日」より後にする（first_seen_atは今日になるため）
    await db.insertCollected([
      { mercariItemId: 'LT', title: 'タイムライン出品商品', price: 3000, soldAt: '2099-01-01' },
    ])

    const afterSale = (await db.getItemTimeline(item.id))!
    expect(afterSale.events.map(e => e.kind)).toEqual([
      'ordered', 'listed', 'sold', 'sale_shipped', 'sale_delivered', 'sale_completed',
    ])
  })

  it('getItemTimeline：分割で生まれた子は「分割で生成」が出る。購入日時があれば日付はそちら（日本時間）で、detail に購入日時が出る', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-04-01', shipping_fee: 0,
      lines: [{ name: '分割する箱【W900】', unit_price: 3000, quantity: 1 }],
    })
    const parent = (await db.listInventory('in_stock'))[0]
    const [child] = await db.splitInventory(parent.id, 3)
    const childTimeline = (await db.getItemTimeline(child))!
    const split = childTimeline.events.find(e => e.kind === 'split')!
    expect(split.title).toBe('分割で生成')
    expect(split.detail).toBe('「分割する箱【W900】」から分割')

    // 購入日時：UTC では 4/9 の 20:30、日本時間では 4/10 の 05:30。履歴の日付は日本時間の 4/10
    const saleId = await db.createSale({ title: '購入日時の確認', sold_at: '2026-04-12', price: 2000 })
    await db.linkInventory(saleId, [child])
    await db.sqlRun(`update sale set purchased_at = '2026-04-09T20:30:00Z' where id = ?`, saleId)
    const sold = (await db.getItemTimeline(child))!.events.find(e => e.kind === 'sold')!
    expect(sold.date).toBe('2026-04-10')
    expect(sold.detail).toContain('購入日時 2026/04/10 05:30')
  })

  // ---------------- 商品一覧・商品ページ ----------------

  it('listProducts：purchase_totalがlanded_costの合計と一致し、split親は数えない', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-01',
      shipping_fee: 0,
      lines: [{ name: 'listProducts商品【Z090-1】', unit_price: 1000, quantity: 1 }],
    })
    const parent = (await db.listInventory('in_stock'))[0]
    await db.splitInventory(parent.id, 2) // 500/500 の子2点。親はsplitでpurchase_totalから除外

    const products = await db.listProducts()
    const target = products.find(p => p.model_code === 'Z090-1')!
    expect(target.purchase_total).toBe(1000) // 親(1000)を含めず、子2点(500+500)の合計
    expect(target.avg_cost).toBe(500)
    expect(target.last_purchased_at).toBe('2026-05-01')
    expect(target.last_sold_at).toBeNull()
  })

  it('listProducts：並び順（利益／平均利益／販売数／在庫／最新の仕入日）と、最新の販売日。未計算（null）は最後', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-03-01', shipping_fee: 0,
      lines: [{ name: '古い仕入【S001】', unit_price: 1000, quantity: 1 }],
    })
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-04-01', shipping_fee: 0,
      lines: [{ name: '新しい仕入【S002】', unit_price: 1000, quantity: 3 }],
    })
    await createCompletedSale({ title: '古い仕入【S001】', sold_at: '2026-05-01', price: 4000 })

    const codes = async (sort?: Parameters<typeof db.listProducts>[0]) => (await db.listProducts(sort)).map(p => p.model_code)
    expect(await codes('total_profit')).toEqual(['S001', 'S002'])
    expect(await codes('avg_profit')).toEqual(['S001', 'S002']) // S002 は未販売＝null＝最後
    expect(await codes('sold')).toEqual(['S001', 'S002'])
    expect(await codes('in_stock')).toEqual(['S002', 'S001'])
    expect(await codes('last_purchased_at')).toEqual(['S002', 'S001'])
    expect(await codes()).toEqual(['S001', 'S002'])

    const s001 = (await db.listProducts()).find(p => p.model_code === 'S001')!
    expect(s001.last_sold_at).toBe('2026-05-01')
    expect(Object.keys(s001)).not.toContain('household_id')
  })

  it('getProduct：月を埋め、in_stockの累積が「仕入3-販売1=2」になる。型番が無ければnull', async () => {
    expect(await db.getProduct('no-such-model')).toBeNull()

    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-06-01',
      shipping_fee: 0,
      lines: [{ name: 'getProduct商品【Z091-1】', unit_price: 1000, quantity: 3 }],
    })
    const items = (await db.listInventory('in_stock')).filter(i => i.model_code === 'Z091-1')
    expect(items).toHaveLength(3)

    // タイトルの型番が1つに絞れるので createSale が自動で先入先出で紐付ける（手で linkInventory しない）
    const saleId = await db.createSale({ title: 'getProduct商品【Z091-1】', sold_at: '2026-08-15', price: 2000 })
    expect((await db.listSales()).find(s => s.id === saleId)!.unmatched).toBe(0)

    const detail = (await db.getProduct('Z091-1'))!
    expect(detail.items).toHaveLength(3)
    expect(detail.sales.map(s => s.id)).toEqual([saleId])

    // 2026-06（仕入3）〜2026-08（売上1）まで、間の2026-07も空月として埋まる
    const monthKeys = detail.months.map(m => m.month)
    expect(monthKeys).toContain('2026-06')
    expect(monthKeys).toContain('2026-07')
    expect(monthKeys).toContain('2026-08')

    const june = detail.months.find(m => m.month === '2026-06')!
    expect(june.purchased).toBe(3)
    expect(june.in_stock).toBe(3)

    const july = detail.months.find(m => m.month === '2026-07')!
    expect(july.purchased).toBe(0)
    expect(july.sold).toBe(0)
    expect(july.in_stock).toBe(3) // 空月も前月の累積を引き継ぐ

    const august = detail.months.find(m => m.month === '2026-08')!
    expect(august.sold).toBe(1)
    expect(august.in_stock).toBe(2) // 仕入3 − 販売1 = 2
  })

  it('getProduct：月の並びは日本時間の今月まで。UTC ではまだ前の月の 15:00〜23:59 でも、日本時間の今月が入る', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 30, 16, 0, 0))) // UTC 2026-09-30 16:00 = JST 2026-10-01 01:00
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-08-20', shipping_fee: 0,
        lines: [{ name: '月の確認【Z092】', unit_price: 1000, quantity: 1 }],
      })
      const detail = (await db.getProduct('Z092'))!
      expect(detail.months.map(m => m.month)).toEqual(['2026-08', '2026-09', '2026-10'])
      expect(detail.months.map(m => m.in_stock)).toEqual([1, 1, 1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('getProduct：廃棄・自家消費は月の在庫の累積から引かれる。実績と見込みは別の列（isRealized）', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-05-01',
      lines: [{ name: '商品【A037】', unit_price: 500, quantity: 3 }],
    })
    const [first] = await db.listInventory('in_stock')
    await db.disposeInventory(first.id, '傷あり', 'disposed')

    const done = await db.createSale({ title: '商品【A037】', sold_at: '2026-05-01', price: 1000 })
    await db.applySaleActuals(done, { status: 'completed' })
    const pending = await db.createSale({ title: '商品【A037】', sold_at: '2026-05-02', price: 2000 })
    await db.applySaleActuals(pending, { status: 'shipped' })

    const detail = (await db.getProduct('A037'))!
    const may = detail.months.find(m => m.month === '2026-05')!
    // 廃棄は今日（日本時間）の日付で記録されるので、5月はまだ 仕入3 − 販売2 = 1
    expect(may).toMatchObject({ purchased: 3, sold: 2, in_stock: 1 })
    expect(may).toMatchObject({ sales_amount: 1000, profit: 400, forecast_sales_amount: 2000, forecast_profit: 1300 })
    // 廃棄した月に引かれて、今月は 仕入3 − 販売2 − 廃棄1 = 0
    expect(detail.months[detail.months.length - 1]).toMatchObject({ month: thisMonthJst(), in_stock: 0 })
  })

  it('商品別の粗利も実績と見込みを分け、在庫の販売状態は変えない（recognition）', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-05-01',
      lines: [{ name: '商品【A037】', unit_price: 500, quantity: 2 }],
    })
    const done = await db.createSale({ title: '商品【A037】', sold_at: '2026-05-01', price: 1000 })
    await db.applySaleActuals(done, { status: 'completed' })
    const pending = await db.createSale({ title: '商品【A037】', sold_at: '2026-05-02', price: 2000 })
    await db.applySaleActuals(pending, { status: 'shipped' })
    expect((await db.listProducts())[0]).toMatchObject({ sold: 2, in_stock: 0, total_profit: 400, forecast_profit: 1300, avg_price: 1000 })
    expect((await db.getProduct('A037'))!.months.find(m => m.month === '2026-05')).toMatchObject({
      sold: 2, in_stock: 0, sales_amount: 1000, profit: 400, forecast_sales_amount: 2000, forecast_profit: 1300,
    })
  })

  it('状態未設定の手入力は実績。取得分の状態不明は見込み。保存状態は変更しない（recognition・商品の分）', async () => {
    const month = '2026-06'
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: `${month}-01`,
      lines: [{ name: '商品【A037】', unit_price: 500, quantity: 2 }],
    })
    const manual = await db.createSale({ title: '商品【A037】', sold_at: `${month}-01`, price: 1000 })
    await db.insertCollected([{ mercariItemId: 'unknown', title: '商品【A037】', soldAt: `${month}-01`, price: 2000 }])
    expect((await db.listSales()).find(s => s.id === manual)?.status).toBeNull()
    expect((await db.listProducts())[0]).toMatchObject({ total_profit: 400, forecast_profit: 1300 })
    expect((await db.getProduct('A037'))!.months.find(m => m.month === month)).toMatchObject({ sales_amount: 1000, forecast_sales_amount: 2000 })
  })

  it('getProduct：まとめ売りの 1 点あたりの売上・粗利を商品ごとの月に積んでも、合計は販売の金額と必ず一致する（端数は最終行）', async () => {
    // 3 点（別の型番）を ¥10,001 でまとめ売り。10001 / 3 = 3333 余り 2 → 最後の 2 行に +1（3333 / 3334 / 3334）
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-03-01', shipping_fee: 100,
      lines: [
        { name: 'まとめA【B001】', unit_price: 1000, quantity: 1 },
        { name: 'まとめB【B002】', unit_price: 2000, quantity: 1 },
        { name: 'まとめC【B003】', unit_price: 3000, quantity: 1 },
      ],
    })
    const items = await db.listInventory('in_stock')
    const saleId = await createCompletedSale({ title: 'まとめ売り（型番なし）', sold_at: '2026-03-10', price: 10001 })
    await db.linkInventory(saleId, items.map(i => i.id))
    const sale = (await db.listSales()).find(s => s.id === saleId)!
    expect(sale.item_count).toBe(3)

    let revenueSum = 0
    let profitSum = 0
    for (const code of ['B001', 'B002', 'B003']) {
      const march = (await db.getProduct(code))!.months.find(m => m.month === '2026-03')!
      expect(march.sold).toBe(1)
      revenueSum += march.sales_amount
      profitSum += march.profit
    }
    expect(revenueSum).toBe(10001)
    expect(profitSum).toBe(sale.gross_profit)
  })

  // ---------------- 商品画像 ----------------

  it('商品画像：人がセットした画像が最優先（image_manual）。消すと仕入先の画像に戻る。URL は公開バケットの URL', async () => {
    const purchaseId = await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'クリームわん【P100】', unit_price: 1000, quantity: 1 }],
    })
    await db.setFirstLineImage(purchaseId, 'h/purchase/p100.jpg')

    // 仕入先の画像だけ → manual ではない
    let p = (await db.listProducts()).find(x => x.model_code === 'P100')!
    expect(p.thumb_url).toBe(`${MEDIA_BASE}/h/purchase/p100.jpg`)
    expect(p.image_manual).toBe(false)
    expect(await db.getProductImage('P100')).toBeNull()

    await db.upsertProductImage('P100', 'h/product/p100-manual.jpg')
    expect(await db.getProductImage('P100')).toEqual({ path: 'h/product/p100-manual.jpg' })
    p = (await db.listProducts()).find(x => x.model_code === 'P100')!
    expect(p.thumb_url).toBe(`${MEDIA_BASE}/h/product/p100-manual.jpg`)
    expect(p.image_manual).toBe(true)
    expect((await db.getProduct('P100'))!.thumb_url).toBe(`${MEDIA_BASE}/h/product/p100-manual.jpg`)

    // 置き換え
    await db.upsertProductImage('P100', 'h/product/p100-2.jpg')
    expect((await db.getProductImage('P100'))!.path).toBe('h/product/p100-2.jpg')

    await db.deleteProductImage('P100')
    expect(await db.getProductImage('P100')).toBeNull()
    p = (await db.listProducts()).find(x => x.model_code === 'P100')!
    expect(p.thumb_url).toBe(`${MEDIA_BASE}/h/purchase/p100.jpg`)
    expect(p.image_manual).toBe(false)
  })

  it('商品画像：どこにも画像が無ければ thumb_url は null', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '画像なし【P101】', unit_price: 1000, quantity: 1 }],
    })
    const p = (await db.listProducts()).find(x => x.model_code === 'P101')!
    expect(p.thumb_url).toBeNull()
    expect(p.image_manual).toBe(false)
  })

  // ---------------- 商品のタグ ----------------

  describe('setProductTags：商品（型番）のタグ。在庫・販売へ派生し、優先順位 purchase > product で1つにまとまる', () => {
    it('型番タグが在庫のinherited_tags（from: product）・販売のinherited_tagsに出る。listProducts/getProductのtagsにも出る', async () => {
      const tagId = await db.createTag('型番タグ')
      await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '型番タグ対象【Z900】', unit_price: 1000, quantity: 1 }],
      })
      await db.setProductTags('Z900', [tagId])

      const item = (await db.listInventory('in_stock'))[0]
      expect(item.tags).toEqual([])
      expect(item.inherited_tags).toEqual([{ id: tagId, name: '型番タグ', sort_order: 0, from: 'product' }])

      expect((await db.listProducts()).find(p => p.model_code === 'Z900')!.tags.map(t => t.id)).toEqual([tagId])
      expect((await db.getProduct('Z900'))!.tags.map(t => t.id)).toEqual([tagId])

      const saleId = await db.createSale({ title: '型番タグ対象【Z900】', sold_at: '2026-01-05', price: 2000 })
      const sale = (await db.listSales()).find(s => s.id === saleId)!
      expect(sale.tags).toEqual([])
      expect(sale.inherited_tags).toEqual([{ id: tagId, name: '型番タグ', sort_order: 0, from: 'product' }])
    })

    it('優先順位：同じタグが仕入(purchase)・商品(product)の両方から来たら purchase を優先して1つにまとめる', async () => {
      const tagId = await db.createTag('共通タグ')
      const purchaseId = await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '優先順位確認【Z901】', unit_price: 1000, quantity: 1 }],
      })
      await db.setPurchaseTags(purchaseId, [tagId])
      await db.setProductTags('Z901', [tagId])

      const item = (await db.listInventory('in_stock'))[0]
      expect(item.inherited_tags).toEqual([{ id: tagId, name: '共通タグ', sort_order: 0, from: 'purchase' }])
    })

    it('setProductTags：置き換え（丸ごと入れ替え）。deleteTagでCASCADEされ、product_tagからも消える', async () => {
      const tagA = await db.createTag('A')
      const tagB = await db.createTag('B')
      await db.setProductTags('Z902', [tagA, tagB])
      expect((await db.listProducts()).find(p => p.model_code === 'Z902')).toBeUndefined() // まだ在庫が無ければ商品一覧に出ない

      await db.createPurchase({
        shop_account_id: shopId,
        ordered_at: '2026-01-01',
        shipping_fee: 0,
        lines: [{ name: '置き換え確認【Z902】', unit_price: 1000, quantity: 1 }],
      })
      expect((await db.listProducts()).find(p => p.model_code === 'Z902')!.tags.map(t => t.id).sort())
        .toEqual([tagA, tagB].sort())

      await db.setProductTags('Z902', [tagB])
      expect((await db.listProducts()).find(p => p.model_code === 'Z902')!.tags.map(t => t.id)).toEqual([tagB])

      await db.deleteTag(tagB)
      expect((await db.listProducts()).find(p => p.model_code === 'Z902')!.tags).toEqual([])
    })

    it('同じタグを重ねて渡しても 1 つ。空配列で全部外れる', async () => {
      const tag = await db.createTag('重複')
      await db.setProductTags('Z903', [tag, tag, tag])
      expect(await db.sql('select tag_id from product_tag where model_code = ?', 'Z903')).toHaveLength(1)
      await db.setProductTags('Z903', [])
      expect(await db.sql('select tag_id from product_tag where model_code = ?', 'Z903')).toHaveLength(0)
    })
  })

  // ---------------- シナリオ（persona） ----------------

  it('persona-02：同じ型番2点＋別型番1点を1販売に手で紐付け→商品ページの按分・履歴の表記が一致する', async () => {
    // X001を2点、Y001を1点、送料300を金額按分
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-03-01',
      shipping_fee: 300,
      lines: [
        { name: '【X001】うさぎクリーム', unit_price: 1000, quantity: 2 },
        { name: '【Y001】くまクリーム', unit_price: 2000, quantity: 1 },
      ],
    })

    const items = await db.listInventory('in_stock')
    const xItems = items.filter(i => i.model_code === 'X001')
    const yItems = items.filter(i => i.model_code === 'Y001')
    expect(xItems).toHaveLength(2)
    expect(yItems).toHaveLength(1)

    // 手計算：pool=300, total=1000*2+2000*1=4000
    // X001（先頭行）：round(300*2000/4000)=150 → 2点で等分（端数なし）→ 75ずつ
    expect(xItems.map(i => i.landed_cost).sort()).toEqual([1075, 1075])
    // Y001（最終行）：残り 300-150=150
    expect(yItems[0].landed_cost).toBe(2150)

    const saleId = await createCompletedSale({ title: 'まとめ売り', sold_at: '2026-03-10', price: 12000 })
    await db.linkInventory(saleId, [xItems[0].id, xItems[1].id, yItems[0].id])

    const sale = (await db.listSales()).find(s => s.id === saleId)!
    expect(sale.item_count).toBe(3)
    // 原価合計 = 1075*2 + 2150 = 4300 (= 4000 + 300 と一致)
    expect(sale.cost).toBe(4300)
    // fee_rate_bp 既定1000(10%) → fee = floor(12000*1000/10000) = 1200
    expect(sale.fee).toBe(1200)
    // 粗利 = 12000 - 1200 - 0 - 0 - 4300 = 6500
    expect(sale.gross_profit).toBe(6500)

    // 商品ページの按分：価格・粗利を紐付けた点数(3)で整数按分したもの（sale_line_share）が月別に積まれる。
    // 按分の順序は sale_line の挿入順（= linkInventory に渡した配列の順）：
    //   price 12000 / 3 = 4000 ちょうど（余りなし）→ 3点とも 4000
    //   gross_profit 6500 / 3 = 2166 余り2 → 余り2は「最後の2行」に+1
    //     rn1 = xItems[0] → 2166 / rn2 = xItems[1] → 2167 / rn3 = yItems[0] → 2167
    //   （2166 + 2167 + 2167 = 6500 で sale.gross_profit と一致）
    const month = '2026-03'
    const productX = (await db.getProduct('X001'))!
    const pointX = productX.months.find(m => m.month === month)!
    expect(pointX.sold).toBe(2)
    expect(pointX.sales_amount).toBe(4000 * 2)
    expect(pointX.profit).toBe(2166 + 2167)

    const productY = (await db.getProduct('Y001'))!
    const pointY = productY.months.find(m => m.month === month)!
    expect(pointY.sold).toBe(1)
    expect(pointY.sales_amount).toBe(4000)
    expect(pointY.profit).toBe(2167)

    // 按分の合計は必ず販売の price / gross_profit に一致する（丸めで総額をずらさない）
    const shares = await db.sql<{ price_share: number; profit_share: number }>(
      'select price_share, profit_share from sale_line_share where sale_id = ?', saleId,
    )
    expect(shares.reduce((s, r) => s + r.price_share, 0)).toBe(sale.price)
    expect(shares.reduce((s, r) => s + r.profit_share, 0)).toBe(sale.gross_profit)

    // 履歴ドロワー：「まとめ売り 3 点」の表記
    const timeline = (await db.getItemTimeline(yItems[0].id))!
    const soldEvent = timeline.events.find(e => e.kind === 'sold')!
    expect(soldEvent.detail).toContain('まとめ売り 3 点')
    expect(soldEvent.detail).toContain('¥4,000') // 1点あたり floor(12000/3)=4000
  })

  it('persona-03：箱1点(原価3198)を4つに分割→2つ売る→商品ページの月別 in_stock が正しい。戻すと分割前に戻る', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-04-01',
      shipping_fee: 0,
      lines: [{ name: '【W001】ケース', unit_price: 3198, quantity: 1 }],
    })
    const parent = (await db.listInventory('in_stock'))[0]
    expect(parent.landed_cost).toBe(3198)

    // splitEvenly(3198, 4)：base=floor(3198/4)=799, 余り2は最後の2個へ+1 → [799, 799, 800, 800]
    const childIds = await db.splitInventory(parent.id, 4)
    const children = (await db.listInventory('in_stock')).filter(i => childIds.includes(i.id))
    expect(children.map(i => i.landed_cost).sort((a, b) => a - b)).toEqual([799, 799, 800, 800])
    expect(children.reduce((s, i) => s + i.landed_cost, 0)).toBe(3198)

    // 子を2つ売る（799の子と800の子を1つずつ）
    const sorted = [...children].sort((a, b) => a.landed_cost - b.landed_cost)
    for (const item of [sorted[0], sorted[2]]) {
      const saleId = await db.createSale({ title: 'ケース売却', sold_at: '2026-04-05', price: 1500 })
      await db.linkInventory(saleId, [item.id])
    }

    // 商品ページ：purchased は親を除いた子(4点)、sold=2、in_stock=2
    const product = (await db.getProduct('W001'))!
    expect(product.purchased).toBe(4)
    expect(product.sold).toBe(2)
    expect(product.in_stock).toBe(2)

    const point = product.months.find(m => m.month === '2026-04')!
    expect(point.purchased).toBe(4)
    expect(point.sold).toBe(2)
    expect(point.in_stock).toBe(2)
  })

  it('persona-03：箱1点を3つに分割→間違えたので戻す→商品ページも分割前に戻る', async () => {
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-01',
      shipping_fee: 0,
      lines: [{ name: '【W002】ケース', unit_price: 2400, quantity: 1 }],
    })
    const parent = (await db.listInventory('in_stock'))[0]
    await db.splitInventory(parent.id, 3)
    await db.mergeSplitInventory(parent.id)

    const product = (await db.getProduct('W002'))!
    expect(product.purchased).toBe(1)
    expect(product.in_stock).toBe(1)
  })

  it('persona-11：廃棄・自家消費は商品の利益に原価が混ざらず、履歴に「廃棄」「自家消費」が出る', async () => {
    // 型番は枝番まで（【E001-1】）にする。在庫のmodel_codeと文字列完全一致するので自動確定される
    await db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-05-01',
      shipping_fee: 0,
      lines: [{ name: 'テスト商品【E001-1】', unit_price: 1000, quantity: 5 }],
    })
    const items = await db.listInventory('in_stock')
    expect(items).toHaveLength(5)

    const [disposedItem, personalItem] = items
    await db.disposeInventory(disposedItem.id, '傷あり', 'disposed')
    await db.disposeInventory(personalItem.id, '自分で使う', 'personal_use')

    // 型番が在庫のmodel_codeと完全一致で自動紐付け（先入先出）。残っている在庫のうち1点だけが原価として乗る
    const saleId = await createCompletedSale({ title: 'テスト商品【E001-1】', sold_at: '2026-05-10', price: 2000 })
    const sale = (await db.listSales()).find(s => s.id === saleId)!
    expect(sale.unmatched).toBe(0)
    expect(sale.cost).toBe(1000) // 廃棄・自家消費分(合計2000)は混ざらない

    const variant = (await db.listVariantSummary()).find(v => v.model_code === 'E001-1')!
    // fee = floor(2000*1000/10000) = 200 → gross_profit = 2000-200-0-0-1000 = 800
    expect(variant.total_profit).toBe(800)

    // 履歴ドロワーに「廃棄」「自家消費」が出る
    const disposedTimeline = (await db.getItemTimeline(disposedItem.id))!
    expect(disposedTimeline.events.some(e => e.kind === 'disposed' && e.title === '廃棄' && e.detail === '傷あり')).toBe(true)
    const personalTimeline = (await db.getItemTimeline(personalItem.id))!
    expect(personalTimeline.events.some(e => e.kind === 'personal_use' && e.title === '自家消費')).toBe(true)

    // 商品ページの月別：廃棄・自家消費の 2 点は、それをした月（今日）に在庫の累積から引かれる（仕入5 − 販売1 − 廃棄2 = 2）
    const detail = (await db.getProduct('E001-1'))!
    expect(detail.months.find(m => m.month === '2026-05')).toMatchObject({ purchased: 5, sold: 1, in_stock: 4 })
    expect(detail.months[detail.months.length - 1]).toMatchObject({ month: thisMonthJst(), in_stock: 2 })
  })
})

describe('商品（型番）：世帯の分離・引数の検査・API', () => {
  let shopId: string
  let tagA: string
  let itemA: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
    tagA = await db.createTag('Aのタグ')
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-06-01', shipping_fee: 0,
      lines: [{ name: '世帯Aの商品【Q001】', unit_price: 1000, quantity: 1 }],
    })
    itemA = (await db.listInventory('in_stock'))[0].id
    await db.setProductTags('Q001', [tagA])
    await db.setProductName('Q001', 'Aが付けた名前')
    await db.setProductNote('Q001', 'Aのメモ')
    await db.upsertProductImage('Q001', 'a/product/q001.jpg')
  })

  it('世帯 B から A の商品・履歴・タグ・画像は見えない（id を知っていても）', async () => {
    expect(await w.b.run((c) => product.listProducts(c))).toEqual([])
    expect(await w.b.run((c) => product.listVariantSummary(c))).toEqual([])
    expect(await w.b.run((c) => product.getProduct(c, 'Q001'))).toBeNull()
    expect(await w.b.run((c) => product.getItemTimeline(c, itemA))).toBeNull()
    expect(await w.b.run((c) => product.getProductImage(c, 'Q001'))).toBeNull()
  })

  it('世帯 B は A のタグを型番に付けられない（UserError・404）。B が同じ型番に名前・メモ・画像を付けても A は変わらない', async () => {
    await expect(w.b.run((c) => product.setProductTags(c, 'Q001', [tagA]))).rejects.toThrow('タグが見つかりません')
    await w.b.run((c) => product.setProductName(c, 'Q001', 'Bの名前'))
    await w.b.run((c) => product.setProductNote(c, 'Q001', 'Bのメモ'))
    await w.b.run((c) => product.upsertProductImage(c, 'Q001', 'b/product/q001.jpg'))
    await w.b.run((c) => product.deleteProductImage(c, 'Q001'))

    const p = (await db.listProducts()).find(x => x.model_code === 'Q001')!
    expect(p.custom_name).toBe('Aが付けた名前')
    expect(p.note).toBe('Aのメモ')
    expect(p.tags.map(t => t.id)).toEqual([tagA])
    expect(p.image_manual).toBe(true)
    expect(p.thumb_url).toBe(`${MEDIA_BASE}/a/product/q001.jpg`)
  })

  it('A のタグを B の画面から外す操作も、A の型番には効かない（setProductTags の置き換えは自分の世帯の行だけ）', async () => {
    await w.b.run((c) => product.setProductTags(c, 'Q001', []))
    expect((await db.listProducts()).find(x => x.model_code === 'Q001')!.tags.map(t => t.id)).toEqual([tagA])
  })

  it('変な型の引数は UserError（500 にならない）', async () => {
    const bad = (fn: (c: Ctx) => Promise<unknown>) => expect(w.a.run(fn)).rejects.toBeInstanceOf(UserError)
    await bad((c) => product.listProducts(c, 'bogus' as never))
    await bad((c) => product.listVariantSummary(c, 'in_stock' as never)) // 商品一覧だけの並び順
    await bad((c) => product.getProduct(c, 123 as never))
    await bad((c) => product.getProduct(c, '   '))
    await bad((c) => product.getItemTimeline(c, 'not-a-uuid'))
    await bad((c) => product.setProductTags(c, 'Q001', 'abc' as never))
    await bad((c) => product.setProductTags(c, 'Q001', ['not-a-uuid']))
    await bad((c) => product.setProductTags(c, '', [tagA]))
    await bad((c) => product.setProductName(c, 'Q001', 123 as never))
    await bad((c) => product.setProductName(c, 'Q001', 'x'.repeat(501)))
    await bad((c) => product.setProductNote(c, 'Q001', {} as never))
    await bad((c) => product.setProductNote(c, 'Q001', 'x'.repeat(5001)))
    await bad((c) => product.upsertProductImage(c, 'Q001', ' '))
    // 存在しないタグ（uuid の形）は 404
    await expect(w.a.run((c) => product.setProductTags(c, 'Q001', [randomUUID()]))).rejects.toThrow('タグが見つかりません')
  })

  it('dispatch 経由：成功は 200、不正な引数は 400、Web 版でまだ使えない setProductImage は 501', async () => {
    const list = await w.a.call('listProducts', 'total_profit')
    expect(list.status).toBe(200)
    expect((list.body.result as Array<{ model_code: string }>).map(p => p.model_code)).toEqual(['Q001'])

    // 途中の引数は null で届く（HTTP は undefined を null で送る）
    expect((await w.a.call('listProducts', null)).status).toBe(200)
    expect((await w.a.call('listVariantSummary')).status).toBe(200)

    const detail = await w.a.call('getProduct', 'Q001')
    expect(detail.status).toBe(200)
    expect((detail.body.result as { custom_name: string }).custom_name).toBe('Aが付けた名前')
    expect((await w.a.call('getProduct', 'NOPE')).body.result).toBeNull()

    expect((await w.a.call('getItemTimeline', itemA)).status).toBe(200)
    expect((await w.a.call('getItemTimeline', 'x')).status).toBe(400)
    expect((await w.a.call('getProduct', null)).status).toBe(400)
    expect((await w.a.call('setProductTags', 'Q001', 'abc')).status).toBe(400)
    expect((await w.a.call('setProductTags', 'Q001', [tagA])).status).toBe(200)
    expect((await w.a.call('setProductName', 'Q001', null)).status).toBe(200)
    expect((await w.a.call('setProductNote', 'Q001', null)).status).toBe(200)
    expect((await w.b.call('getProduct', 'Q001')).body.result).toBeNull()

    // ファイルを選ぶダイアログの setProductImage は Web では登録しない。自動に戻す側は使える（画像のアップロードは upload/）
    expect((await w.a.call('setProductImage', 'Q001')).status).toBe(501)
    expect((await w.a.call('setProductImageAuto', 'Q001', true)).status).toBe(200)
    expect((await w.a.call('setProductImageAuto', 'Q001', 'yes')).status).toBe(400)
  })
})
