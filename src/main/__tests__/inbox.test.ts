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
})
