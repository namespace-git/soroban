import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import { UserError } from '../../errors'
import * as inbox from '../../domain/inbox'
import * as master from '../../domain/master'
import * as monthly from '../../domain/monthly'
import * as purchase from '../../domain/purchase'
import { subtractDaysJst, todayJst } from '../../domain/_shared'
import type { InboxItem, PurchaseInput, SaleInput } from '../../../src/shared/types'
import { MEDIA_BASE, newWorld, openDomainDb, type DomainDb, type World } from './helpers'
import { bindDb } from './core-helpers'

// src/main/__tests__/inbox.test.ts（17 本）を移したもの。期待値は変えていない。書き換えたのは「呼び方」だけ：
//   * 同期の inbox.xxx() / db.xxx(...) → await …（db は下の薄い包み。1 回の呼び出し＝1 リクエスト＝1 トランザクション）
//   * 偽の時計は vi.useFakeTimers() ではなく Date だけ（非同期の DB の待ちを止めない）。ローカル時刻 new Date(2026, 9, 3, 12, 0) は
//     UTC の瞬間で置く（サーバー＝Workers は UTC。日本時間 12:00 は UTC の 03:00、日本時間の 0 時台は UTC の前日 15 時台）
//   * 「N 日前」は dateDaysAgo(N) ではなく subtractDaysJst(todayJst(), N)（日本の暦日）
//   * 仕入は本物の purchase.createPurchase（仕入のドメイン）。販売・出品・在庫は core-helpers の包み
//   * getDb().prepare(…) の直接 SQL は db.sqlRun（Postgres の名前）に読み替えた。
//     listing の主キー mercari_item_id は channel_item_id、fulfillment_updated_at は timestamptz（ISO で入れる）
//   * 販売の日付は todayLocal() → todayJst()
// 足したもの：
//   * スヌーズが日本時間の今日＋7 日で保存される／期限の日までは消え、翌日に戻る／世帯 A のスヌーズは B に効かない
//   * 経費・月締めのリマインドが日本時間の 10 日・3 日で出る（UTC の 15:00〜23:59 で翌日扱い）
//   * 送料未入力・発送待ちの粗利の見込み（発送方法が決まっていれば 1 値、未定なら相場の幅）／日付・金額の文言
//   * 取り込みの問題の時刻が日本時間で出る／done_today が日本時間の今日の分だけ数える
//   * 世帯 B から A の受信箱が見えない／変な型の引数は UserError／dispatch 経由
// 移していないもの：なし（17 本すべて）

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

afterEach(() => {
  vi.useRealTimers()
})

const A = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)
const core = bindDb(() => w.a)

/** 元のテストの `db.` と同じ形で呼べる、世帯 A の薄い包み */
const db = {
  ...core,
  createPurchase: (input: PurchaseInput) => A((c) => purchase.createPurchase(c, input)),
  createPurchaseDraft: (input: Parameters<typeof purchase.createPurchaseDraft>[1]) => A((c) => purchase.createPurchaseDraft(c, input)),
  createShopAccount: (name: string, kind?: Parameters<typeof master.createShopAccount>[2]) => A((c) => master.createShopAccount(c, name, kind)),
  listShopAccounts: () => A((c) => master.listShopAccounts(c)),
  createExpense: (input: Parameters<typeof monthly.createExpense>[1]) => A((c) => monthly.createExpense(c, input)),
  startRun: (source: Parameters<typeof master.startRun>[1], shopAccountId?: string) => A((c) => master.startRun(c, source, shopAccountId ?? null)),
  getInbox: () => A((c) => inbox.getInbox(c)),
  snoozeReminder: (type: Parameters<typeof inbox.snoozeReminder>[1], id?: string | null) => A((c) => inbox.snoozeReminder(c, type, id)),
}

/** 集計テスト用：取引完了を明示した販売を作る。状態未設定の仕様とは分ける */
async function createCompletedSale(input: SaleInput): Promise<string> {
  const id = await db.createSale(input)
  await db.applySaleActuals(id, { status: 'completed' })
  return id
}

/** 偽の時計（Date だけ）。非同期の DB の待ちは止めない */
function setClock(utc: [number, number, number, number, number]): void {
  vi.useRealTimers()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.UTC(utc[0], utc[1] - 1, utc[2], utc[3], utc[4])))
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString()
}

describe('inbox（getInbox・snoozeReminder）', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  it('空DB → groupsは空、stripは全部0、done_todayは0', async () => {
    // 経費・月締めのリマインドは「今日」の日付（月初か10日以降か）に左右されるため、
    // 月の早い日（経費・締めのリマインド条件に触れない日）に固定して検証する
    setClock([2026, 9, 5, 3, 0]) // JST 2026-09-05 12:00

    const result = await db.getInbox()
    expect(result.groups).toEqual([])
    expect(result.strip.gross_profit).toBe(0)
    expect(result.strip.net_profit).toBe(0)
    expect(result.strip.revenue).toBe(0)
    expect(result.strip.sales_count).toBe(0)
    expect(result.strip.pending_profit_estimate).toBe(0)
    expect(result.strip.pending_count).toBe(0)
    expect(result.strip.awaiting_payout).toBe(0)
    expect(result.strip.awaiting_payout_count).toBe(0)
    expect(result.strip.last_month).toBeNull()
    expect(result.done_today).toBe(0)
    expect(result.review.aging_count).toBe(0)
    expect(result.review.top_model).toBeNull()
    expect(result.review.unallocated_listings).toBe(0)
    expect(result.review.last_month_unclosed).toBeNull()
  })

  it('発送待ち・送料未入力・未紐付け（候補1点）・下書きの4グループが順番どおりに出る。link の profit_hint は数字が合う', async () => {
    // 'mellojoy' 口座は manual_purchase リマインドの対象外（取り込みがあるため）。
    // ここでの日付は「今日」から離れていない可能性があるので、他のリマインドが紛れ込まないようにする
    // （締めのリマインドは「先月の行があり、今日が3日以降」で出るので、月の早い日に固定する。日付に左右されない）
    setClock([2026, 9, 5, 3, 0]) // JST 2026-09-05 12:00
    const shopId = await db.createShopAccount('メロジョイA', 'mellojoy')

    // 発送待ち：発送方法を決めておき in_stock を紐付けて他グループに紛れ込ませない
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [{ name: '発送待ち商品', unit_price: 500, quantity: 1 }],
    })
    const shipStockItem = (await db.listInventory('in_stock'))[0]
    const shipSaleId = await db.createSale({ title: '発送待ち商品', sold_at: '2026-09-10', price: 1000 })
    await db.linkInventory(shipSaleId, [shipStockItem.id])
    await db.saveShippingMethod({ name: 'ゆうパケット', fee: 175 })
    const method = (await db.listShippingMethods())[0]
    await db.updateSale(shipSaleId, { shipping_method_id: method.id })
    await db.sqlRun(`update sale set status = 'waiting_shipment' where id = ?`, shipSaleId)

    // 送料未入力：紐付け済みだが送料未確定
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [{ name: '送料未入力商品', unit_price: 500, quantity: 1 }],
    })
    const shippingStockItem = (await db.listInventory('in_stock'))[0]
    const shippingSaleId = await db.createSale({ title: '送料未入力商品', sold_at: '2026-09-11', price: 1200 })
    await db.linkInventory(shippingSaleId, [shippingStockItem.id])

    // 未紐付け（候補1点）：先に販売を作ってから同じ型番の在庫を後から作る
    // （createSale時点で在庫が無いのでautoLinkSaleは発動せず、未紐付けのまま残る）
    const linkSaleId = await db.createSale({ title: '【Z100】未紐付け商品', sold_at: '2026-09-12', price: 3000 })
    await db.saveShippingMethod({ name: '定形外', fee: 210 })
    const linkMethod = (await db.listShippingMethods()).find(m => m.name === '定形外')!
    await db.updateSale(linkSaleId, { shipping_method_id: linkMethod.id })
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-05', shipping_fee: 0,
      lines: [{ name: '【Z100】未紐付け商品', unit_price: 1000, quantity: 1, model_code: 'Z100' }],
    })

    // 下書き仕入
    await db.createPurchaseDraft({
      import_key: 'draft-1', shop_account_id: shopId, ordered_at: '2026-09-13',
      lines: [{ name: '下書き商品', quantity: 1 }],
    })

    // 今月の経費を1件入れて「経費がまだ0件」リマインドが紛れ込まないようにする（日付依存を避ける）
    await db.createExpense({ occurred_at: todayJst(), category: 'packaging', amount: 500 })

    const result = await db.getInbox()
    expect(result.groups.map(g => g.kind)).toEqual(['ship', 'shipping', 'link', 'confirm'])

    const shipGroup = result.groups.find(g => g.kind === 'ship')!
    expect(shipGroup.items).toHaveLength(1)
    expect(shipGroup.items[0].id).toBe(shipSaleId)

    const shippingGroup = result.groups.find(g => g.kind === 'shipping')!
    expect(shippingGroup.items).toHaveLength(1)
    expect(shippingGroup.items[0].id).toBe(shippingSaleId)

    const linkGroup = result.groups.find(g => g.kind === 'link')!
    expect(linkGroup.items).toHaveLength(1)
    const linkItem = linkGroup.items[0]
    expect(linkItem.id).toBe(linkSaleId)
    expect(linkItem.candidate).not.toBeNull()
    expect(linkItem.candidate?.item_code).toBeTruthy()
    // 価格3,000・手数料300（10%）・送料210・原価1,000 → 1,490
    expect(linkItem.profit_hint).toEqual({ min: 1490, max: 1490 })

    const confirmGroup = result.groups.find(g => g.kind === 'confirm')!
    expect(confirmGroup.items).toHaveLength(1)
    expect(confirmGroup.items[0].title).toBe('下書き商品')
  })

  it('manual_purchase：8日前が最後の登録なら出る／スヌーズすると出ない', async () => {
    const tiktokId = await db.createShopAccount('TikTok本店', 'tiktok')
    await db.createPurchase({
      shop_account_id: tiktokId, ordered_at: subtractDaysJst(todayJst(), 8), shipping_fee: 0,
      lines: [{ name: 'TikTok商品', unit_price: 1000, quantity: 1 }],
    })

    const before = await db.getInbox()
    const reminderGroup = before.groups.find(g => g.kind === 'reminder')
    expect(reminderGroup).toBeDefined()
    const item = reminderGroup!.items.find(i => i.reminder?.type === 'manual_purchase')
    expect(item).toBeDefined()
    expect(item!.id).toBe(tiktokId)

    await db.snoozeReminder('manual_purchase', tiktokId)
    const after = await db.getInbox()
    const afterGroup = after.groups.find(g => g.kind === 'reminder')
    const afterItem = afterGroup?.items.find(i => i.reminder?.type === 'manual_purchase')
    expect(afterItem).toBeUndefined()
  })

  it('delivery：手入力・配送中のまま5日以上でリマインドが出る', async () => {
    const shopId = await db.createShopAccount('その他仕入先')
    const purchaseId = await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      fulfillment: 'pending',
      lines: [{ name: '未着確認商品', unit_price: 800, quantity: 1, model_code: 'A001' }],
    })
    await db.sqlRun(`update purchase set fulfillment_updated_at = ? where id = ?`, isoDaysAgo(6), purchaseId)

    const result = await db.getInbox()
    const reminderGroup = result.groups.find(g => g.kind === 'reminder')!
    const item = reminderGroup.items.find(i => i.reminder?.type === 'delivery')
    expect(item).toBeDefined()
    expect(item!.reminder?.purchase_id).toBe(purchaseId)
    expect(item!.title).toContain('A001')
  })

  it('strip.awaiting_payoutはshippedの販売の価格−手数料', async () => {
    const saleId = await db.createSale({ title: '発送済み商品', sold_at: todayJst(), price: 2000 })
    await db.sqlRun(`update sale set status = 'shipped' where id = ?`, saleId)

    const result = await db.getInbox()
    // fee_rate_bp 既定1000(10%) → fee = floor(2000*1000/10000) = 200
    expect(result.strip.awaiting_payout).toBe(2000 - 200)
    expect(result.strip.awaiting_payout_count).toBe(1)
  })

  describe('release：止めた出品が在庫を押さえている', () => {
    async function stockItems(qty: number, name = '止め出品の商品'): Promise<string[]> {
      const shopId = await db.createShopAccount('メロジョイA', 'mellojoy')
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
        lines: [{ name, unit_price: 1000, quantity: qty }],
      })
      return (await db.listInventory('in_stock')).map(i => i.id)
    }

    async function listing(id: string, status: 'active' | 'suspended' | 'sold' | 'ended', title = '出品タイトル', channel: 'mercari' | 'yahoo' = 'mercari') {
      await db.upsertListings([{ mercariItemId: id, title, price: 2000, suspended: false, thumbUrl: null }])
      await db.sqlRun('update listing set status = ?, channel = ? where channel_item_id = ?', status, channel, id)
    }

    async function releaseGroup() {
      return (await db.getInbox()).groups.find(g => g.kind === 'release')
    }

    it('止めた出品が在庫1点を押さえている → 項目が1件。title/detail と items が入る', async () => {
      const [itemId] = await stockItems(1)
      await listing('m111111111', 'active', '止めた出品')
      await db.reserveInventory('m111111111', [itemId])
      await db.sqlRun(`update listing set status = 'suspended' where channel_item_id = ?`, 'm111111111')

      const group = (await releaseGroup())!
      expect(group.items).toHaveLength(1)
      const it0 = group.items[0]
      expect(it0.id).toBe('m111111111')
      expect(it0.title).toBe('止めた出品')
      expect(it0.profit_hint).toBeUndefined()
      expect(it0.release!.listing_id).toBe('m111111111')
      expect(it0.release!.listing_channel).toBe('mercari')
      expect(it0.release!.items).toHaveLength(1)
      expect(it0.release!.items[0].inventory_item_id).toBe(itemId)
      expect(it0.release!.items[0].name).toBe('止め出品の商品')
      expect(it0.release!.items[0].landed_cost).toBe(1000)
      expect(it0.detail).toContain('メルカリで出品停止中')
      expect(it0.detail).toContain(it0.release!.items[0].item_code)
    })

    it('1つの出品が2点押さえている → 項目は1件で items が2点', async () => {
      const ids = await stockItems(2)
      await listing('m222222222', 'active', 'セット出品', 'yahoo')
      await db.reserveInventory('m222222222', ids)
      await db.sqlRun(`update listing set status = 'suspended' where channel_item_id = ?`, 'm222222222')

      const group = (await releaseGroup())!
      expect(group.items).toHaveLength(1)
      expect(group.items[0].release!.items.map(i => i.inventory_item_id).sort()).toEqual([...ids].sort())
      expect(group.items[0].release!.listing_channel).toBe('yahoo')
      expect(group.items[0].detail).toContain('Yahoo!フリマで出品停止中')
      expect(group.items[0].detail).toContain('2 点')
    })

    it('商品名（product_name）があれば在庫名より優先する', async () => {
      const [itemId] = await stockItems(1)
      const modelCode = 'K001'
      await db.sqlRun('update inventory_item set model_code = ? where id = ?', modelCode, itemId)
      await db.sqlRun(`insert into product_name (model_code, name, updated_at) values (?, ?, now())`, modelCode, '登録した商品名')
      await listing('m333333333', 'active')
      await db.reserveInventory('m333333333', [itemId])
      await db.sqlRun(`update listing set status = 'suspended' where channel_item_id = ?`, 'm333333333')

      expect((await releaseGroup())!.items[0].release!.items[0].name).toBe('登録した商品名')
    })

    it('active の出品が押さえている → 出ない', async () => {
      const [itemId] = await stockItems(1)
      await listing('m444444444', 'active')
      await db.reserveInventory('m444444444', [itemId])
      expect(await releaseGroup()).toBeUndefined()
    })

    it('sold / ended の出品 → 出ない', async () => {
      const ids = await stockItems(2)
      await listing('m555555551', 'active')
      await listing('m555555552', 'active')
      await db.reserveInventory('m555555551', [ids[0]])
      await db.reserveInventory('m555555552', [ids[1]])
      await db.sqlRun(`update listing set status = 'sold' where channel_item_id = ?`, 'm555555551')
      await db.sqlRun(`update listing set status = 'ended' where channel_item_id = ?`, 'm555555552')
      expect(await releaseGroup()).toBeUndefined()
    })

    it('在庫が売れている（in_stock でない）なら出ない', async () => {
      const [itemId] = await stockItems(1)
      await listing('m666666666', 'active')
      await db.reserveInventory('m666666666', [itemId])
      await db.sqlRun(`update listing set status = 'suspended' where channel_item_id = ?`, 'm666666666')
      expect(await releaseGroup()).toBeDefined()

      await db.sqlRun(`update inventory_item set status = 'sold' where id = ?`, itemId)
      expect(await releaseGroup()).toBeUndefined()
    })

    it('該当が無ければグループごと出ない（止めた出品だが在庫を押さえていない）', async () => {
      await listing('m777777777', 'suspended')
      expect(await releaseGroup()).toBeUndefined()
    })

    it('release は link の後・confirm の前に並ぶ', async () => {
      const [itemId] = await stockItems(1)
      await listing('m888888888', 'active')
      await db.reserveInventory('m888888888', [itemId])
      await db.sqlRun(`update listing set status = 'suspended' where channel_item_id = ?`, 'm888888888')
      await db.createSale({ title: '未紐付けの販売', sold_at: '2026-09-10', price: 1000 })
      await db.createPurchaseDraft({
        import_key: 'draft-2', shop_account_id: (await db.listShopAccounts())[0].id, ordered_at: '2026-09-13',
        lines: [{ name: '下書き商品', quantity: 1 }],
      })

      const kinds = (await db.getInbox()).groups.map(g => g.kind)
      expect(kinds.indexOf('release')).toBeGreaterThan(kinds.indexOf('link'))
      expect(kinds.indexOf('release')).toBeLessThan(kinds.indexOf('confirm'))
    })

    it('出品のサムネイルは Storage の URL で出る。出品先が違えば同じ商品ID でも別の出品として並ぶ', async () => {
      const ids = await stockItems(2)
      await listing('m999999999', 'active', 'メルカリの出品')
      await db.reserveInventory('m999999999', [ids[0]])
      await db.sqlRun(`update listing set status = 'suspended', thumb_path = 'h/listing/a.jpg' where channel_item_id = ?`, 'm999999999')

      // 同じ商品ID・別の出品先（Yahoo!フリマ）の出品が、別の在庫を押さえている
      await db.sqlRun(
        `insert into listing (channel, channel_item_id, title, price, status, first_seen_at, last_seen_at, listed_at)
         values ('yahoo', 'm999999999', 'Yahooの出品', 2000, 'suspended', '2026-09-01', now(), '2026-09-01')`,
      )
      const yahooId = (await db.sqlGet<{ id: string }>(`select id from listing where channel = 'yahoo' and channel_item_id = 'm999999999'`))!.id
      await db.sqlRun('insert into listing_line (listing_id, inventory_item_id) values (?, ?)', yahooId, ids[1])

      const group = (await releaseGroup())!
      expect(group.items).toHaveLength(2)
      const mercari = group.items.find(i => i.release!.listing_channel === 'mercari')!
      const yahoo = group.items.find(i => i.release!.listing_channel === 'yahoo')!
      expect(mercari.thumb_url).toBe(`${MEDIA_BASE}/h/listing/a.jpg`)
      expect(yahoo.thumb_url).toBeNull()
      expect(mercari.release!.items.map(i => i.inventory_item_id)).toEqual([ids[0]])
      expect(yahoo.release!.items.map(i => i.inventory_item_id)).toEqual([ids[1]])
    })
  })

  describe('ストリップ：見込みは月で切らない（月が変わった瞬間に消えない）', () => {
    /** 受取評価待ち（shipped）の販売を n 件。価格は 1,000 円から 100 円刻み、手数料は 10%（送料・原価なし） */
    function pendingSales(n: number, soldAt: string, prefix = 'pending') {
      return db.insertCollected(Array.from({ length: n }, (_, i) => ({
        mercariItemId: `${prefix}-${i}`, title: `未完了の商品【A037】${i}`, soldAt, price: 1000 + i * 100, status: 'shipped' as const,
      })))
    }

    it('販売が全部先月で未完了が 15 件でも、今月の見込みは 15 件・合計の粗利が出る（0 にならない）', async () => {
      setClock([2026, 10, 3, 3, 0]) // JST 2026-10-03 12:00
      await pendingSales(15, '2026-09-20')
      // 先月の実績も 1 件（今月の実績に混ざらないこと）
      await db.insertCollected([{ mercariItemId: 'done-sep', title: '完了済みの商品【A037】', soldAt: '2026-09-10', price: 5000, status: 'completed' }])

      const { strip } = await db.getInbox()
      // 価格 1000..2400（100 刻み 15 件）= 25,500、手数料 10% = 2,550 → 粗利 22,950
      expect(strip.month).toBe('2026-10')
      expect(strip.pending_count).toBe(15)
      expect(strip.pending_profit_estimate).toBe(22950)
      // 実績は今月のまま（先月の 5,000 円は混ざらない）
      expect(strip).toMatchObject({ gross_profit: 0, net_profit: 0, revenue: 0, sales_count: 0 })
    })

    it('見込みの合計は sale_profit の未完了分の粗利の合計と一致する（赤字も含む）', async () => {
      setClock([2026, 10, 3, 3, 0])
      const sales = await pendingSales(3, '2026-08-31')
      await db.updateSale(sales[0].id, { shipping_fee: 5000 }) // 赤字になる 1 件

      const expected = (await db.listSales()).filter(s => s.status !== 'completed').reduce((sum, s) => sum + s.gross_profit, 0)
      const { strip } = await db.getInbox()
      expect(strip.pending_count).toBe(3)
      expect(strip.pending_profit_estimate).toBe(expected)
      expect(strip.pending_profit_estimate).toBe((1000 - 100 - 5000) + (1100 - 110) + (1200 - 120))
    })

    it('今月の実績は今月のまま。未完了は月をまたいで全部数える', async () => {
      setClock([2026, 10, 3, 3, 0])
      await pendingSales(2, '2026-09-20', 'last')
      await pendingSales(1, '2026-10-02', 'this')
      await db.insertCollected([{ mercariItemId: 'done-oct', title: '今月完了【A037】', soldAt: '2026-10-02', price: 2000, status: 'completed' }])
      await db.insertCollected([{ mercariItemId: 'done-sep2', title: '先月完了【A037】', soldAt: '2026-09-15', price: 7000, status: 'completed' }])

      const { strip } = await db.getInbox()
      expect(strip).toMatchObject({ revenue: 2000, gross_profit: 1800, sales_count: 1 })
      expect(strip.pending_count).toBe(3)
      expect(strip.pending_profit_estimate).toBe((1000 - 100) + (1100 - 110) + (1000 - 100))
    })

    it('日本時間の 0 時台（UTC では前月）でも、月初に見込みが消えない', async () => {
      setClock([2026, 9, 30, 15, 5]) // UTC 2026-09-30 15:05 = JST 2026-10-01 00:05
      await pendingSales(4, '2026-09-30')

      const { strip } = await db.getInbox()
      expect(strip.month).toBe('2026-10')
      expect(strip.pending_count).toBe(4)
    })
  })

  // ------------------------------------------------------------
  // ここから Web 版で足したもの
  // ------------------------------------------------------------

  describe('送料未入力・発送待ちの粗利の見込みと、行の文言', () => {
    beforeEach(() => {
      setClock([2026, 9, 5, 3, 0]) // JST 2026-09-05 12:00（月の早い日。経費・締めのリマインドが紛れ込まない）
    })

    it('発送方法が未定なら有効な発送方法の最小〜最大の幅、決まっていれば 1 値。日付・金額・買い手・発送方法の文言', async () => {
      // 世帯を作ると発送方法の初期値が入る（送料なし・着払い ¥0 〜 宅急便 60サイズ ¥750）。それを相場の幅にする
      const methods = await db.listShippingMethods()
      expect(Math.min(...methods.map(m => m.fee))).toBe(0)
      expect(Math.max(...methods.map(m => m.fee))).toBe(750)
      const compact = methods.find(m => m.name === '宅急便コンパクト')!
      expect(compact.fee).toBe(520)
      // 未紐付け・型番なし（原価は 0 として見込む）の販売を 2 件。片方だけ発送方法を決める
      const noMethod = await db.createSale({ title: '発送方法が未定の販売', sold_at: '2026-09-10', price: 3000 })
      const withMethod = await db.createSale({ title: '発送方法が決まった販売', sold_at: '2026-09-11', price: 3000 })
      await db.updateSale(withMethod, { shipping_method_id: compact.id })
      // updateSale が送料を確定させるなら、送料未入力に戻して「発送方法だけ決まっている」状態にする
      await db.sqlRun('update sale set is_shipping_confirmed = 0, shipping_fee = 0 where id = ?', withMethod)

      const group = (await db.getInbox()).groups.find(g => g.kind === 'shipping')!
      const a = group.items.find(i => i.id === noMethod)!
      const b = group.items.find(i => i.id === withMethod)!
      // 価格3,000・手数料300。幅は送料 750〜0
      expect(a.profit_hint).toEqual({ min: 3000 - 300 - 750, max: 3000 - 300 - 0 })
      // 発送方法が決まっていれば、その料金（520）の 1 値
      expect(b.profit_hint).toEqual({ min: 3000 - 300 - 520, max: 3000 - 300 - 520 })
      expect(a.detail).toBe('09/10 に売れた ・ ¥3,000 ・ 買い手 不明 ・ 発送方法 未定')
      expect(b.detail).toBe('09/11 に売れた ・ ¥3,000 ・ 買い手 不明 ・ 発送方法 宅急便コンパクト')
    })

    it('発送待ち：紐付け済みで送料が確定していれば、その送料と原価で 1 値（梱包材も引く）', async () => {
      const shopId = await db.createShopAccount('メロジョイA', 'mellojoy')
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
        lines: [{ name: '原価の商品', unit_price: 700, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      const saleId = await db.createSale({ title: '原価の商品', sold_at: '2026-09-10', price: 2500 })
      await db.linkInventory(saleId, [item.id])
      await db.updateSale(saleId, { shipping_fee: 200, packaging_cost: 30 })
      await db.sqlRun(`update sale set status = 'waiting_shipment' where id = ?`, saleId)

      const ship = (await db.getInbox()).groups.find(g => g.kind === 'ship')!.items[0]
      // 価格2,500 − 手数料250 − 送料200 − 梱包材30 − 原価700 = 1,320
      expect(ship.profit_hint).toEqual({ min: 1320, max: 1320 })
      expect(ship.sale?.gross_profit).toBe(1320)
    })

    it('未紐付けで候補が 2 点以上なら candidate は出さない（人が選ぶ）。送料未入力のグループにも同じ販売が出る', async () => {
      const shopId = await db.createShopAccount('メロジョイA', 'mellojoy')
      const saleId = await db.createSale({ title: '【Z200】候補が2点', sold_at: '2026-09-12', price: 3000 })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-09-05', shipping_fee: 0,
        lines: [{ name: '【Z200】候補が2点', unit_price: 1000, quantity: 2, model_code: 'Z200' }],
      })

      const groups = (await db.getInbox()).groups
      const link = groups.find(g => g.kind === 'link')!.items.find(i => i.id === saleId)!
      expect(link.candidate).toBeNull()
      expect(link.profit_hint).toBeNull()
      // 送料も未入力なので「送料を入れる」にも出る（原価は先入先出の 1 点目＝1,000 で見込み、送料は相場の幅 750〜0）
      const shipping = groups.find(g => g.kind === 'shipping')!.items.find(i => i.id === saleId)!
      expect(shipping.profit_hint).toEqual({ min: 3000 - 300 - 750 - 1000, max: 3000 - 300 - 0 - 1000 })
    })
  })

  describe('link：候補の名前と、その候補を紐付けたときの粗利の見込み', () => {
    // デスクトップ版（src/main/__tests__/inbox.test.ts）の同じ describe と、同じデータ・同じ数字を期待する
    beforeEach(() => {
      setClock([2026, 9, 5, 3, 0]) // JST 2026-09-05 12:00
    })

    /** 有効な発送方法をこの一覧だけにする（世帯の初期値は無効にする）。無効にした方法は相場に入らない。名前 → id を返す */
    async function onlyShippingMethods(
      active: Array<[string, number]>, inactive: Array<[string, number]> = [],
    ): Promise<Record<string, string>> {
      for (const m of await db.listShippingMethods()) await db.deleteShippingMethod(m.id)
      for (const [name, fee] of [...active, ...inactive]) await db.saveShippingMethod({ name, fee })
      const ids = Object.fromEntries((await db.listShippingMethods()).map(m => [m.name, m.id]))
      for (const [name] of inactive) await db.deleteShippingMethod(ids[name]) // 無効にする（行は残る）
      return ids
    }

    /** 価格 3,000（手数料 300）・梱包材 30 の未紐付けの販売と、同じ型番 Z300 の在庫 1 点（原価 1,000）。候補はその 1 点 */
    async function linkSale(): Promise<string> {
      const shopId = await db.createShopAccount('メロジョイA', 'mellojoy')
      const saleId = await db.createSale({ title: '【Z300】候補の確認', sold_at: '2026-09-12', price: 3000 })
      await db.updateSale(saleId, { packaging_cost: 30 })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-09-05', shipping_fee: 0,
        lines: [{ name: 'Z300 の明細名', unit_price: 1000, quantity: 1, model_code: 'Z300' }],
      })
      return saleId
    }

    async function inboxItem(kind: 'link' | 'shipping', saleId: string): Promise<InboxItem> {
      return (await db.getInbox()).groups.find(g => g.kind === kind)!.items.find(i => i.id === saleId)!
    }

    it('candidate.name は在庫の商品名。型番に表示名を付ければそれ、無ければ明細の名前', async () => {
      const saleId = await linkSale()
      const stock = (await db.listInventory('in_stock')).find(i => i.model_code === 'Z300')!

      const before = (await inboxItem('link', saleId)).candidate!
      expect(before).toMatchObject({ inventory_item_id: stock.id, item_code: stock.item_code, landed_cost: 1000 })
      expect(before.name).toBe('Z300 の明細名')

      await db.setProductName('Z300', 'Z300 の登録した商品名')
      expect((await inboxItem('link', saleId)).candidate!.name).toBe('Z300 の登録した商品名')
    })

    it('送料が確定している：min = max = 価格 − 手数料 − 送料 − 梱包材 − 原価', async () => {
      const saleId = await linkSale()
      await db.updateSale(saleId, { shipping_fee: 200 })

      const link = await inboxItem('link', saleId)
      // 3,000 − 300 − 200 − 30 − 1,000 = 1,470
      expect(link.profit_hint).toEqual({ min: 1470, max: 1470 })
    })

    it('送料が未入力で発送方法も未選択：有効な発送方法の最高〜最安の送料で幅になる（無効にした方法は入れない）', async () => {
      await onlyShippingMethods([['A便', 200], ['B便', 600]], [['無効の高い便', 900]])
      const saleId = await linkSale()

      const link = await inboxItem('link', saleId)
      expect(link.candidate).not.toBeNull()
      // min = 3,000 − 300 − 600（最高）− 30 − 1,000 = 1,070 ／ max = 3,000 − 300 − 200（最安）− 30 − 1,000 = 1,470
      expect(link.profit_hint).toEqual({ min: 1070, max: 1470 })
      // 送料未入力の行（shipping）と同じ見込みになる
      expect((await inboxItem('shipping', saleId)).profit_hint).toEqual({ min: 1070, max: 1470 })
    })

    it('発送方法は選んであるが送料は未確定：その発送方法の料金で 1 値（0 円の shipping_fee は使わない）', async () => {
      const ids = await onlyShippingMethods([['A便', 200], ['B便', 600]])
      const saleId = await linkSale()
      await db.updateSale(saleId, { shipping_method_id: ids['B便'] })
      // updateSale が送料を確定させるので、「発送方法だけ決まっている・送料未確定（0 円）」に戻す
      await db.sqlRun('update sale set is_shipping_confirmed = 0, shipping_fee = 0 where id = ?', saleId)

      const link = await inboxItem('link', saleId)
      // 3,000 − 300 − 600（B便）− 30 − 1,000 = 1,070
      expect(link.profit_hint).toEqual({ min: 1070, max: 1070 })
    })

    it('有効な発送方法が 1 つも無く送料も分からない → profit_hint は null（候補は出る）。送料が分かっていれば出る', async () => {
      await onlyShippingMethods([])
      expect(await db.listShippingMethods()).toEqual([])
      const saleId = await linkSale()

      const link = await inboxItem('link', saleId)
      expect(link.candidate).not.toBeNull()
      expect(link.profit_hint).toBeNull()

      // 送料を入れれば（確定すれば）有効な発送方法が無くても 1 値で出る
      await db.updateSale(saleId, { shipping_fee: 200 })
      expect((await inboxItem('link', saleId)).profit_hint).toEqual({ min: 1470, max: 1470 })
    })
  })

  describe('スヌーズは日本時間で数える', () => {
    it('今日（日本時間）＋7 日を世帯の設定に保存する。UTC の 15:00〜23:59 は日本ではもう翌日', async () => {
      setClock([2026, 10, 2, 16, 0]) // UTC 2026-10-02 16:00 = JST 2026-10-03 01:00
      await db.snoozeReminder('manual_purchase', 'abc')
      await db.snoozeReminder('close_month', null)
      await db.snoozeReminder('expense')
      const settings = await db.getSettings()
      expect(settings['snooze:manual_purchase:abc']).toBe('2026-10-10')
      expect(settings['snooze:close_month:-']).toBe('2026-10-10')
      expect(settings['snooze:expense:-']).toBe('2026-10-10')
    })

    it('期限の日までは消え、翌日に戻る。世帯 A のスヌーズは B に効かない', async () => {
      setClock([2026, 10, 2, 16, 0]) // JST 2026-10-03 01:00
      const tiktokId = await db.createShopAccount('TikTok本店', 'tiktok')
      await db.createPurchase({
        shop_account_id: tiktokId, ordered_at: '2026-09-25', shipping_fee: 0, // 日本時間の 8 日前
        lines: [{ name: 'TikTok商品', unit_price: 1000, quantity: 1 }],
      })
      const manual = async () => (await db.getInbox()).groups.find(g => g.kind === 'reminder')?.items
        .find(i => i.reminder?.type === 'manual_purchase')
      expect(await manual()).toBeDefined()

      await db.snoozeReminder('manual_purchase', tiktokId)
      expect(await manual()).toBeUndefined()

      setClock([2026, 10, 9, 16, 0]) // JST 2026-10-10 01:00（期限の日。まだ消えている）
      expect(await manual()).toBeUndefined()
      setClock([2026, 10, 10, 16, 0]) // JST 2026-10-11 01:00（期限の翌日。戻る）
      expect(await manual()).toBeDefined()

      // B には A のスヌーズの設定が無い
      const keys = (settings: Record<string, string>) => Object.keys(settings).filter(k => k.startsWith('snooze:'))
      expect(keys(await w.a.run((c) => master.getSettings(c)))).toEqual([`snooze:manual_purchase:${tiktokId}`])
      expect(keys(await w.b.run((c) => master.getSettings(c)))).toEqual([])
    })
  })

  describe('経費・月締めのリマインドは日本時間の 10 日・3 日から', () => {
    it('経費：日本時間の 10 日 0 時（UTC の 9 日 15 時）から出る。9 日の 23 時台は出ない', async () => {
      setClock([2026, 10, 9, 14, 30]) // JST 2026-10-09 23:30
      const reminders = async () => (await db.getInbox()).groups.find(g => g.kind === 'reminder')?.items
        .filter(i => i.reminder?.type === 'expense') ?? []
      expect(await reminders()).toHaveLength(0)

      setClock([2026, 10, 9, 15, 30]) // JST 2026-10-10 00:30
      const items = await reminders()
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ id: '2026-10', title: '今月の経費がまだ0件です', detail: '先月も経費の記録がありません' })

      // 先月の経費があれば、いちばん大きい項目を金額つきで出す
      await db.createExpense({ occurred_at: '2026-09-15', category: 'packaging', amount: 1200 })
      await db.createExpense({ occurred_at: '2026-09-16', category: 'supplies', amount: 3400 })
      await db.createExpense({ occurred_at: '2026-09-17', category: 'packaging', amount: 2300 })
      expect((await reminders())[0].detail).toBe('先月は 梱包費 ¥3,500')

      // 今月の経費が 1 件でもあれば出ない
      await db.createExpense({ occurred_at: '2026-10-09', category: 'other', amount: 100 })
      expect(await reminders()).toHaveLength(0)
    })

    it('月締め：先月の行があって未締めなら、日本時間の 3 日 0 時から出る。売上・純利益の文言と、見直すものの先月分', async () => {
      setClock([2026, 10, 1, 3, 0]) // JST 2026-10-01 12:00
      await createCompletedSale({ title: '先月の販売', sold_at: '2026-09-10', price: 1000 })

      setClock([2026, 10, 2, 14, 30]) // JST 2026-10-02 23:30（3 日前）
      const closing = async () => (await db.getInbox()).groups.find(g => g.kind === 'reminder')?.items
        .find(i => i.reminder?.type === 'close_month')
      expect(await closing()).toBeUndefined()

      setClock([2026, 10, 2, 15, 30]) // JST 2026-10-03 00:30
      const item = (await closing())!
      expect(item).toMatchObject({
        id: '2026-09', title: '先月（2026-09）を締めましょう', detail: '売上 ¥1,000 ・ 純利益 ¥900',
        reminder: { type: 'close_month', action_label: '月次を開く', month: '2026-09' },
      })
      const inbox1 = await db.getInbox()
      expect(inbox1.strip.last_month).toEqual({ month: '2026-09', net_profit: 900, closed: false })
      expect(inbox1.review.last_month_unclosed).toBe('2026-09')

      // 締めると出ない（見直すものからも消える）
      await A((c) => monthly.closeMonth(c, '2026-09'))
      expect(await closing()).toBeUndefined()
      const inbox2 = await db.getInbox()
      expect(inbox2.strip.last_month).toEqual({ month: '2026-09', net_profit: 900, closed: true })
      expect(inbox2.review.last_month_unclosed).toBeNull()
    })
  })

  describe('取り込みの問題・今日片付けた件数・見直すもの', () => {
    it('取り込みの問題：失敗した取り込みを日本時間の時刻つきで出す。成功したものは出ない', async () => {
      setClock([2026, 9, 5, 3, 0])
      // 2026-10-01 15:05 UTC = JST 10/2 00:05
      await db.sqlRun(
        `insert into collector_run (started_at, finished_at, status, source, message) values (?, ?, 'auth_required', 'mercari', null)`,
        '2026-10-01T15:05:00Z', '2026-10-01T15:06:00Z',
      )
      const shopId = await db.createShopAccount('メロジョイA', 'mellojoy')
      await db.sqlRun(
        `insert into collector_run (started_at, finished_at, status, source, shop_account_id, message) values (?, ?, 'failed', 'mellojoy', ?, ?)`,
        '2026-10-01T03:09:00Z', '2026-10-01T03:10:00Z', shopId, '通信に失敗しました',
      )

      const group = (await db.getInbox()).groups.find(g => g.kind === 'collect')!
      const mercari = group.items.find(i => i.title === 'メルカリ')!
      const mello = group.items.find(i => i.title === 'メロジョイA')!
      expect(mercari.detail).toBe('10/2 00:05 ・ ログインが必要')
      expect(mello.detail).toBe('10/1 12:09 ・ 通信に失敗しました')
      expect(mercari.run?.status).toBe('auth_required')

      // 同じ取り込み元の最新が成功なら、問題は消える
      await db.sqlRun(
        `insert into collector_run (started_at, finished_at, status, source) values (?, ?, 'ok', 'mercari')`,
        '2026-10-02T03:00:00Z', '2026-10-02T03:01:00Z',
      )
      const after = (await db.getInbox()).groups.find(g => g.kind === 'collect')!
      expect(after.items.map(i => i.title)).toEqual(['メロジョイA'])
    })

    it('done_today：日本時間の今日の、書き込み系の操作ログ（エラーなし）だけを数える', async () => {
      setClock([2026, 10, 2, 3, 0]) // JST 2026-10-02 12:00
      const log = (kind: string, ts: string, error: string | null = null, source = 'ipc') =>
        db.sqlRun(`insert into app_log (source, kind, message, ts, error) values (?, ?, ?, ?, ?)`, source, kind, kind, ts, error)
      await log('updateSale', '2026-10-01T15:00:00Z') // JST 10/2 00:00（今日）
      await log('linkInventory', '2026-10-02T14:59:59Z') // JST 10/2 23:59:59（今日）
      await log('confirmPurchase', '2026-10-01T14:59:59Z') // JST 10/1 23:59:59（きのう）
      await log('reserveInventory', '2026-10-02T15:00:00Z') // JST 10/3 00:00（あした）
      await log('setListingShipping', '2026-10-02T01:00:00Z', 'エラー') // エラーは数えない
      await log('listSales', '2026-10-02T01:00:00Z') // 書き込み系ではない
      await log('updateSale', '2026-10-02T01:00:00Z', null, 'renderer') // 画面の例外のログは数えない

      expect((await db.getInbox()).done_today).toBe(2)
      // 世帯 B には数えない
      expect(await w.b.run((c) => inbox.getInbox(c))).toMatchObject({ done_today: 0 })
    })

    it('見直すもの：長期滞留（設定の日数。壊れた値は既定の 60 日）・未引き当ての出品・いちばん稼いだ型番', async () => {
      setClock([2026, 9, 5, 3, 0])
      const shopId = await db.createShopAccount('メロジョイA', 'mellojoy')
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
        lines: [{ name: 'ランキングの商品【R100】', unit_price: 1000, quantity: 2 }],
      })
      const [item] = await db.listInventory('in_stock')
      const saleId = await createCompletedSale({ title: 'ランキングの商品', sold_at: '2026-09-02', price: 3000 })
      await db.linkInventory(saleId, [item.id])
      await db.upsertListings([{ mercariItemId: 'm-unalloc', title: '未引き当て', price: 2000, suspended: false, thumbUrl: null }])

      const r = await db.getInbox()
      expect(r.review).toMatchObject({
        unallocated_listings: 1, aging_days: 90,
        top_model: { model_code: 'R100', total_profit: 3000 - 300 - 1000 },
      })

      // 設定が数でなければ、既定の 60 日にして、ホームが開けなくなることはない
      await db.setSetting('aging_warn_days', 'abc')
      expect((await db.getInbox()).review.aging_days).toBe(60)
      await db.setSetting('aging_warn_days', '45')
      expect((await db.getInbox()).review.aging_days).toBe(45)
    })
  })

  describe('世帯の分離・引数の検査・dispatch', () => {
    it('世帯 B の受信箱に A の販売・仕入・出品は出ない', async () => {
      setClock([2026, 9, 5, 3, 0])
      const shopId = await db.createShopAccount('メロジョイA', 'mellojoy')
      await db.createSale({ title: 'Aの未処理の販売', sold_at: '2026-09-02', price: 1000 })
      await db.createPurchaseDraft({ import_key: 'a-draft', shop_account_id: shopId, ordered_at: '2026-09-01', lines: [{ name: 'A下書き', quantity: 1 }] })
      expect((await db.getInbox()).groups.map(g => g.kind)).toEqual(['shipping', 'link', 'confirm'])

      const b = await w.b.run((c) => inbox.getInbox(c))
      expect(b.groups).toEqual([])
      expect(b.strip).toMatchObject({ pending_count: 0, awaiting_payout: 0, revenue: 0 })
      expect(b.review).toMatchObject({ aging_count: 0, unallocated_listings: 0, top_model: null })
    })

    it('変な型の引数は UserError（snoozeReminder の種類・対象）', async () => {
      await expect(A((c) => inbox.snoozeReminder(c, 'bogus' as never))).rejects.toBeInstanceOf(UserError)
      await expect(A((c) => inbox.snoozeReminder(c, 123 as never))).rejects.toBeInstanceOf(UserError)
      await expect(A((c) => inbox.snoozeReminder(c, undefined as never))).rejects.toBeInstanceOf(UserError)
      await expect(A((c) => inbox.snoozeReminder(c, 'delivery', 5 as never))).rejects.toBeInstanceOf(UserError)
      await expect(A((c) => inbox.snoozeReminder(c, 'delivery', { a: 1 } as never))).rejects.toBeInstanceOf(UserError)
      await expect(A((c) => inbox.snoozeReminder(c, 'delivery', 'x'.repeat(101)))).rejects.toBeInstanceOf(UserError)
      // 何も保存されていない
      expect(Object.keys(await db.getSettings()).filter(k => k.startsWith('snooze:'))).toEqual([])
    })

    it('dispatch 経由：getInbox は 200、snoozeReminder は id を省略（null）してもよい。変な型は 400', async () => {
      setClock([2026, 9, 5, 3, 0])
      await db.createSale({ title: 'ディスパッチの販売', sold_at: '2026-09-02', price: 1000 })

      const r = await w.a.call('getInbox')
      expect(r.status).toBe(200)
      const result = r.body.result as { groups: Array<{ kind: string; items: InboxItem[] }>; strip: { month: string } }
      expect(result.strip.month).toBe('2026-09')
      expect(result.groups.map(g => g.kind)).toEqual(['shipping', 'link'])
      expect((await w.b.call('getInbox')).body.result).toMatchObject({ groups: [] })

      expect((await w.a.call('snoozeReminder', 'expense', null)).status).toBe(200)
      expect((await w.a.call('snoozeReminder', 'expense')).status).toBe(200)
      expect((await w.a.call('snoozeReminder', 'close_month', '2026-08')).status).toBe(200)
      expect((await w.a.call('snoozeReminder', 'bogus')).status).toBe(400)
      expect((await w.a.call('snoozeReminder', 'expense', 7)).status).toBe(400)
      expect(Object.keys(await db.getSettings()).filter(k => k.startsWith('snooze:')).sort())
        .toEqual(['snooze:close_month:2026-08', 'snooze:expense:-'])
    })
  })
})
