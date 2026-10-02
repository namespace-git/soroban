import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { todayLocal } from '../../shared/date'

// db.ts は electron の app.getPath を参照する（:memory: を使うときは呼ばれないが、
// import 時点で electron モジュールへの依存があるため潰しておく）
vi.mock('electron', () => ({ app: { getPath: () => '', getVersion: () => '9.9.9' } }))

import * as db from '../db'
import * as inbox from '../inbox'

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString()
}

/** SQLite の datetime('now') と同じ書式（UTC、'YYYY-MM-DD HH:MM:SS'） */
function sqliteDaysAgo(days: number): string {
  return isoDaysAgo(days).slice(0, 19).replace('T', ' ')
}

function dateDaysAgo(days: number): string {
  return isoDaysAgo(days).slice(0, 10)
}

describe('inbox（:memory:）', () => {
  beforeEach(() => {
    db.initDb(':memory:')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('空DB → groupsは空、stripは全部0、done_todayは0', () => {
    // 経費・月締めのリマインドは「今日」の日付（月初か10日以降か）に左右されるため、
    // 月の早い日（経費・締めのリマインド条件に触れない日）に固定して検証する
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T03:00:00Z'))

    const result = inbox.getInbox()
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

  it('発送待ち・送料未入力・未紐付け（候補1点）・下書きの4グループが順番どおりに出る。link の profit_hint は数字が合う', () => {
    // 'mellojoy' 口座は manual_purchase リマインドの対象外（取り込みがあるため）。
    // ここでの日付は「今日」から離れていない可能性があるので、他のリマインドが紛れ込まないようにする
    // （締めのリマインドは「先月の行があり、今日が3日以降」で出るので、月の早い日に固定する。日付に左右されない）
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T03:00:00Z'))
    const shopId = db.createShopAccount('メロジョイA', 'mellojoy')

    // 発送待ち：発送方法を決めておき in_stock を紐付けて他グループに紛れ込ませない
    db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [{ name: '発送待ち商品', unit_price: 500, quantity: 1 }],
    })
    const shipStockItem = db.listInventory('in_stock')[0]
    const shipSaleId = db.createSale({ title: '発送待ち商品', sold_at: '2026-09-10', price: 1000 })
    db.linkInventory(shipSaleId, [shipStockItem.id])
    db.saveShippingMethod({ name: 'ゆうパケット', fee: 175 })
    const method = db.listShippingMethods()[0]
    db.updateSale(shipSaleId, { shipping_method_id: method.id })
    db.getDb().prepare(`UPDATE sale SET status = 'waiting_shipment' WHERE id = ?`).run(shipSaleId)

    // 送料未入力：紐付け済みだが送料未確定
    db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      lines: [{ name: '送料未入力商品', unit_price: 500, quantity: 1 }],
    })
    const shippingStockItem = db.listInventory('in_stock')[0]
    const shippingSaleId = db.createSale({ title: '送料未入力商品', sold_at: '2026-09-11', price: 1200 })
    db.linkInventory(shippingSaleId, [shippingStockItem.id])

    // 未紐付け（候補1点）：先に販売を作ってから同じ型番の在庫を後から作る
    // （createSale時点で在庫が無いのでautoLinkSaleは発動せず、未紐付けのまま残る）
    const linkSaleId = db.createSale({ title: '【Z100】未紐付け商品', sold_at: '2026-09-12', price: 3000 })
    db.saveShippingMethod({ name: '定形外', fee: 210 })
    const linkMethod = db.listShippingMethods().find(m => m.name === '定形外')!
    db.updateSale(linkSaleId, { shipping_method_id: linkMethod.id })
    db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-05', shipping_fee: 0,
      lines: [{ name: '【Z100】未紐付け商品', unit_price: 1000, quantity: 1, model_code: 'Z100' }],
    })

    // 下書き仕入
    db.createPurchaseDraft({
      import_key: 'draft-1', shop_account_id: shopId, ordered_at: '2026-09-13',
      lines: [{ name: '下書き商品', quantity: 1 }],
    })

    // 今月の経費を1件入れて「経費がまだ0件」リマインドが紛れ込まないようにする（日付依存を避ける）
    db.createExpense({ occurred_at: todayLocal(), category: 'packaging', amount: 500 })

    const result = inbox.getInbox()
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

  it('manual_purchase：8日前が最後の登録なら出る／スヌーズすると出ない', () => {
    const tiktokId = db.createShopAccount('TikTok本店', 'tiktok')
    db.createPurchase({
      shop_account_id: tiktokId, ordered_at: dateDaysAgo(8), shipping_fee: 0,
      lines: [{ name: 'TikTok商品', unit_price: 1000, quantity: 1 }],
    })

    const before = inbox.getInbox()
    const reminderGroup = before.groups.find(g => g.kind === 'reminder')
    expect(reminderGroup).toBeDefined()
    const item = reminderGroup!.items.find(i => i.reminder?.type === 'manual_purchase')
    expect(item).toBeDefined()
    expect(item!.id).toBe(tiktokId)

    inbox.snoozeReminder('manual_purchase', tiktokId)
    const after = inbox.getInbox()
    const afterGroup = after.groups.find(g => g.kind === 'reminder')
    const afterItem = afterGroup?.items.find(i => i.reminder?.type === 'manual_purchase')
    expect(afterItem).toBeUndefined()
  })

  it('delivery：手入力・配送中のまま5日以上でリマインドが出る', () => {
    const shopId = db.createShopAccount('その他仕入先')
    const purchaseId = db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
      fulfillment: 'pending',
      lines: [{ name: '未着確認商品', unit_price: 800, quantity: 1, model_code: 'A001' }],
    })
    db.getDb().prepare(`UPDATE purchase SET fulfillment_updated_at = ? WHERE id = ?`)
      .run(sqliteDaysAgo(6), purchaseId)

    const result = inbox.getInbox()
    const reminderGroup = result.groups.find(g => g.kind === 'reminder')!
    const item = reminderGroup.items.find(i => i.reminder?.type === 'delivery')
    expect(item).toBeDefined()
    expect(item!.reminder?.purchase_id).toBe(purchaseId)
    expect(item!.title).toContain('A001')
  })

  it('strip.awaiting_payoutはshippedの販売の価格−手数料', () => {
    const saleId = db.createSale({ title: '発送済み商品', sold_at: todayLocal(), price: 2000 })
    db.getDb().prepare(`UPDATE sale SET status = 'shipped' WHERE id = ?`).run(saleId)

    const result = inbox.getInbox()
    // fee_rate_bp 既定1000(10%) → fee = floor(2000*1000/10000) = 200
    expect(result.strip.awaiting_payout).toBe(2000 - 200)
    expect(result.strip.awaiting_payout_count).toBe(1)
  })

  describe('release：止めた出品が在庫を押さえている', () => {
    function stockItems(qty: number, name = '止め出品の商品'): string[] {
      const shopId = db.createShopAccount('メロジョイA', 'mellojoy')
      db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 0,
        lines: [{ name, unit_price: 1000, quantity: qty }],
      })
      return db.listInventory('in_stock').map(i => i.id)
    }

    function listing(id: string, status: 'active' | 'suspended' | 'sold' | 'ended', title = '出品タイトル', channel: 'mercari' | 'yahoo' = 'mercari') {
      db.upsertListings([{ mercariItemId: id, title, price: 2000, suspended: false, thumbUrl: null }])
      db.getDb().prepare('UPDATE listing SET status = ?, channel = ? WHERE mercari_item_id = ?').run(status, channel, id)
    }

    function releaseGroup() {
      return inbox.getInbox().groups.find(g => g.kind === 'release')
    }

    it('止めた出品が在庫1点を押さえている → 項目が1件。title/detail と items が入る', () => {
      const [itemId] = stockItems(1)
      listing('m111111111', 'active', '止めた出品')
      db.reserveInventory('m111111111', [itemId])
      db.getDb().prepare(`UPDATE listing SET status = 'suspended' WHERE mercari_item_id = ?`).run('m111111111')

      const group = releaseGroup()!
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

    it('1つの出品が2点押さえている → 項目は1件で items が2点', () => {
      const ids = stockItems(2)
      listing('m222222222', 'active', 'セット出品', 'yahoo')
      db.reserveInventory('m222222222', ids)
      db.getDb().prepare(`UPDATE listing SET status = 'suspended' WHERE mercari_item_id = ?`).run('m222222222')

      const group = releaseGroup()!
      expect(group.items).toHaveLength(1)
      expect(group.items[0].release!.items.map(i => i.inventory_item_id).sort()).toEqual([...ids].sort())
      expect(group.items[0].release!.listing_channel).toBe('yahoo')
      expect(group.items[0].detail).toContain('Yahoo!フリマで出品停止中')
      expect(group.items[0].detail).toContain('2 点')
    })

    it('商品名（product_name）があれば在庫名より優先する', () => {
      const [itemId] = stockItems(1)
      const modelCode = 'K001'
      db.getDb().prepare('UPDATE inventory_item SET model_code = ? WHERE id = ?').run(modelCode, itemId)
      db.getDb().prepare("INSERT INTO product_name (model_code, name, updated_at) VALUES (?, ?, datetime('now'))").run(modelCode, '登録した商品名')
      listing('m333333333', 'active')
      db.reserveInventory('m333333333', [itemId])
      db.getDb().prepare(`UPDATE listing SET status = 'suspended' WHERE mercari_item_id = ?`).run('m333333333')

      expect(releaseGroup()!.items[0].release!.items[0].name).toBe('登録した商品名')
    })

    it('active の出品が押さえている → 出ない', () => {
      const [itemId] = stockItems(1)
      listing('m444444444', 'active')
      db.reserveInventory('m444444444', [itemId])
      expect(releaseGroup()).toBeUndefined()
    })

    it('sold / ended の出品 → 出ない', () => {
      const ids = stockItems(2)
      listing('m555555551', 'active')
      listing('m555555552', 'active')
      db.reserveInventory('m555555551', [ids[0]])
      db.reserveInventory('m555555552', [ids[1]])
      db.getDb().prepare(`UPDATE listing SET status = 'sold' WHERE mercari_item_id = ?`).run('m555555551')
      db.getDb().prepare(`UPDATE listing SET status = 'ended' WHERE mercari_item_id = ?`).run('m555555552')
      expect(releaseGroup()).toBeUndefined()
    })

    it('在庫が売れている（in_stock でない）なら出ない', () => {
      const [itemId] = stockItems(1)
      listing('m666666666', 'active')
      db.reserveInventory('m666666666', [itemId])
      db.getDb().prepare(`UPDATE listing SET status = 'suspended' WHERE mercari_item_id = ?`).run('m666666666')
      expect(releaseGroup()).toBeDefined()

      db.getDb().prepare(`UPDATE inventory_item SET status = 'sold' WHERE id = ?`).run(itemId)
      expect(releaseGroup()).toBeUndefined()
    })

    it('該当が無ければグループごと出ない（止めた出品だが在庫を押さえていない）', () => {
      listing('m777777777', 'suspended')
      expect(releaseGroup()).toBeUndefined()
    })

    it('release は link の後・confirm の前に並ぶ', () => {
      const [itemId] = stockItems(1)
      listing('m888888888', 'active')
      db.reserveInventory('m888888888', [itemId])
      db.getDb().prepare(`UPDATE listing SET status = 'suspended' WHERE mercari_item_id = ?`).run('m888888888')
      db.createSale({ title: '未紐付けの販売', sold_at: '2026-09-10', price: 1000 })
      db.createPurchaseDraft({
        import_key: 'draft-2', shop_account_id: db.listShopAccounts()[0].id, ordered_at: '2026-09-13',
        lines: [{ name: '下書き商品', quantity: 1 }],
      })

      const kinds = inbox.getInbox().groups.map(g => g.kind)
      expect(kinds.indexOf('release')).toBeGreaterThan(kinds.indexOf('link'))
      expect(kinds.indexOf('release')).toBeLessThan(kinds.indexOf('confirm'))
    })
  })

  describe('ストリップ：見込みは月で切らない（月が変わった瞬間に消えない）', () => {
    /** 受取評価待ち（shipped）の販売を n 件。価格は 1,000 円から 100 円刻み、手数料は 10%（送料・原価なし） */
    function pendingSales(n: number, soldAt: string, prefix = 'pending') {
      return db.insertCollected(Array.from({ length: n }, (_, i) => ({
        mercariItemId: `${prefix}-${i}`, title: `未完了の商品【A037】${i}`, soldAt, price: 1000 + i * 100, status: 'shipped' as const,
      })))
    }

    it('販売が全部先月で未完了が 15 件でも、今月の見込みは 15 件・合計の粗利が出る（0 にならない）', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 9, 3, 12, 0)) // 2026-10-03（ローカル）
      pendingSales(15, '2026-09-20')
      // 先月の実績も 1 件（今月の実績に混ざらないこと）
      db.insertCollected([{ mercariItemId: 'done-sep', title: '完了済みの商品【A037】', soldAt: '2026-09-10', price: 5000, status: 'completed' }])

      const { strip } = inbox.getInbox()
      // 価格 1000..2400（100 刻み 15 件）= 25,500、手数料 10% = 2,550 → 粗利 22,950
      expect(strip.month).toBe('2026-10')
      expect(strip.pending_count).toBe(15)
      expect(strip.pending_profit_estimate).toBe(22950)
      // 実績は今月のまま（先月の 5,000 円は混ざらない）
      expect(strip).toMatchObject({ gross_profit: 0, net_profit: 0, revenue: 0, sales_count: 0 })
    })

    it('見込みの合計は sale_profit の未完了分の粗利の合計と一致する（赤字も含む）', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 9, 3, 12, 0))
      const sales = pendingSales(3, '2026-08-31')
      db.updateSale(sales[0].id, { shipping_fee: 5000 }) // 赤字になる 1 件

      const expected = db.listSales().filter(s => s.status !== 'completed').reduce((sum, s) => sum + s.gross_profit, 0)
      const { strip } = inbox.getInbox()
      expect(strip.pending_count).toBe(3)
      expect(strip.pending_profit_estimate).toBe(expected)
      expect(strip.pending_profit_estimate).toBe((1000 - 100 - 5000) + (1100 - 110) + (1200 - 120))
    })

    it('今月の実績は今月のまま。未完了は月をまたいで全部数える', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 9, 3, 12, 0))
      pendingSales(2, '2026-09-20', 'last')
      pendingSales(1, '2026-10-02', 'this')
      db.insertCollected([{ mercariItemId: 'done-oct', title: '今月完了【A037】', soldAt: '2026-10-02', price: 2000, status: 'completed' }])
      db.insertCollected([{ mercariItemId: 'done-sep2', title: '先月完了【A037】', soldAt: '2026-09-15', price: 7000, status: 'completed' }])

      const { strip } = inbox.getInbox()
      expect(strip).toMatchObject({ revenue: 2000, gross_profit: 1800, sales_count: 1 })
      expect(strip.pending_count).toBe(3)
      expect(strip.pending_profit_estimate).toBe((1000 - 100) + (1100 - 110) + (1000 - 100))
    })

    it('日本時間の 0 時台（UTC では前月）でも、月初に見込みが消えない', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 9, 1, 0, 5)) // ローカル 2026-10-01 00:05
      pendingSales(4, '2026-09-30')

      const { strip } = inbox.getInbox()
      expect(strip.month).toBe('2026-10')
      expect(strip.pending_count).toBe(4)
    })
  })
})
