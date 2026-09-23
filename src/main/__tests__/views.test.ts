import { createCompletedSale } from './completed-sale'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../db'
import * as views from '../views'
import { todayLocal } from '../../shared/date'

describe('views: 売上タブの進捗', () => {
  beforeEach(() => {
    db.initDb(':memory:')
  })

  it('販売4件(発送待ち1・発送済み1・今月完了1・私物1)と出品2件(引き当て1)の件数・金額', () => {
    const today = todayLocal()
    const shopId = db.createShopAccount('メロジョイ')

    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: today,
      fulfillment: 'delivered',
      lines: [{ name: '【K100】テスト商品', unit_price: 1000, quantity: 5 }],
    })

    // A: 発送待ち・送料確定・自動紐付け
    const [saleA] = db.insertCollected([{
      mercariItemId: 'm-a', title: '【K100】テスト商品', price: 2000, soldAt: today,
      fee: 200, shippingFee: 300, status: 'waiting_shipment',
    }])
    // B: 発送済み（受取評価待ち）・送料未入力
    const [saleB] = db.insertCollected([{
      mercariItemId: 'm-b', title: '【K100】テスト商品', price: 2500, soldAt: today,
      fee: 250, status: 'shipped',
    }])
    // C: 今月完了・送料確定
    const [saleC] = db.insertCollected([{
      mercariItemId: 'm-c', title: '【K100】テスト商品', price: 3000, soldAt: today,
      fee: 300, shippingFee: 400, status: 'completed',
    }])
    // D: 型番なし・私物
    db.insertCollected([{
      mercariItemId: 'm-d', title: '普通の私物 靴', price: 500, soldAt: today, fee: 50,
    }])

    // 前提確認：A/B/C は自動紐付け済み（型番1つ・在庫が足りている）
    for (const s of [saleA, saleB, saleC]) {
      expect(db.listSales().find(x => x.id === s.id)!.unmatched).toBe(0)
    }

    // 出品2件。1件だけ在庫を引き当てる（残り2点のうち1点）
    db.upsertListings([
      { mercariItemId: 'm-list-1', title: '【K100】テスト商品 出品', price: 2200, suspended: false, thumbUrl: null },
      { mercariItemId: 'm-list-2', title: '【K100】テスト商品 出品2', price: 2400, suspended: false, thumbUrl: null },
    ])
    const remaining = db.listInventory('in_stock').filter(i => i.model_code === 'K100')
    expect(remaining).toHaveLength(2)
    db.reserveInventory('m-list-1', [remaining[0].id])

    const progress = views.getSalesProgress()

    expect(progress.to_ship).toEqual({ count: 1, revenue: 2000 })
    expect(progress.in_transit).toEqual({ count: 1, revenue: 2500 })
    expect(progress.completed_this_month).toEqual({ count: 1, revenue: 3000 })

    // listed: 出品2件のうち1件だけ引き当て済み
    expect(progress.listed.count).toBe(2)
    expect(progress.listed.unallocated).toBe(1)
    // 見込み粗利 = 2200 - floor(2200*0.1) - 1000(原価) - 0(送料未設定) = 980
    expect(progress.listed.expected_profit).toBe(980)

    // all = 販売4件 + 出品2件
    expect(progress.all).toBe(6)

    // inputs：転売のみ（私物Dは含めない）。B だけ送料未入力
    expect(progress.inputs.needs_shipping).toBe(1)
    expect(progress.inputs.needs_link).toBe(0)
    expect(progress.inputs.done).toBe(2) // A・C
  })
})

describe('views: 在庫タブの状態カードと型番グループ', () => {
  beforeEach(() => {
    db.initDb(':memory:')
  })

  it('在庫5点(未出品・到着2/未着1/引き当て済み2のうち1点が滞留70日)', () => {
    const today = todayLocal()
    const oldDate = (() => {
      const d = new Date()
      d.setDate(d.getDate() - 70)
      return todayLocal(d)
    })()
    const shopId = db.createShopAccount('メロジョイ')

    // 未出品・到着済み（fresh）2点
    db.createPurchase({
      shop_account_id: shopId, ordered_at: today, fulfillment: 'delivered',
      lines: [{ name: '【K200】テスト商品', unit_price: 1000, quantity: 2 }],
    })
    // 未着1点
    db.createPurchase({
      shop_account_id: shopId, ordered_at: today, fulfillment: 'pending',
      lines: [{ name: '【K200】テスト商品', unit_price: 1000, quantity: 1 }],
    })
    // 引き当て予定：到着済み(fresh)1点
    db.createPurchase({
      shop_account_id: shopId, ordered_at: today, fulfillment: 'delivered',
      lines: [{ name: '【K200】テスト商品', unit_price: 1000, quantity: 1 }],
    })
    // 引き当て予定：到着済みだが滞留70日
    db.createPurchase({
      shop_account_id: shopId, ordered_at: oldDate, fulfillment: 'delivered',
      lines: [{ name: '【K200】テスト商品', unit_price: 1000, quantity: 1 }],
    })

    db.setSetting('aging_warn_days', '60')

    const items = db.listInventory('in_stock').filter(i => i.model_code === 'K200')
    expect(items).toHaveLength(5)
    const freshUnlisted = items.filter(i => i.fulfillment === 'delivered' && i.aging_days < 60)
    const oldItem = items.find(i => i.aging_days >= 60)!
    const listedFresh = freshUnlisted.find(i => i.landed_cost === 1000)! // どれでもよい

    // 出品1件に「到着済み(fresh)1点」と「滞留70日1点」を引き当てる
    db.upsertListings([
      { mercariItemId: 'm-k200', title: '【K200】テスト商品 出品', price: 3000, suspended: false, thumbUrl: null },
    ])
    db.reserveInventory('m-k200', [listedFresh.id, oldItem.id])

    const overview = views.getInventoryOverview()

    // 未出品・到着済みは残り2点（引き当てた2点を除く）
    expect(overview.unlisted_arrived).toEqual({ count: 2, cost: 2000 })
    expect(overview.not_arrived).toEqual({ count: 1, cost: 1000 })
    expect(overview.listed.count).toBe(2)
    // 見込み粗利 = 3000 - floor(3000*0.1) - (1000+1000) - 0 = 700
    expect(overview.listed.expected_profit).toBe(700)
    expect(overview.aging).toEqual({ count: 1, cost: 1000, days: 60 })

    // 型番グループ：unlisted_arrived だけを見ると2点（引き当て済みの2点は除く）
    const groups = views.listInventoryGroups('unlisted_arrived')
    expect(groups).toHaveLength(1)
    expect(groups[0].model_code).toBe('K200')
    expect(groups[0].items).toHaveLength(2)
    expect(groups[0].unlisted_arrived).toBe(2)
    expect(groups[0].not_arrived).toBe(1)
    expect(groups[0].listed).toBe(2)
    expect(groups[0].cost_per_item).toBe(1000) // in_stock 5点、単価1000固定
  })
})

describe('views: 商品カルテ', () => {
  beforeEach(() => {
    db.initDb(':memory:')
  })

  it('型番Xの在庫3点・販売2件', () => {
    const today = todayLocal()
    const monthAgo = (() => {
      const d = new Date()
      d.setDate(d.getDate() - 30)
      return todayLocal(d)
    })()
    const shopId = db.createShopAccount('メロジョイ')

    db.createPurchase({
      shop_account_id: shopId, ordered_at: today, fulfillment: 'delivered',
      lines: [{ name: 'X999 テスト商品', unit_price: 1000, quantity: 3, model_code: 'X999' }],
    })
    const items = db.listInventory('in_stock').filter(i => i.model_code === 'X999')
    expect(items).toHaveLength(3)

    db.saveShippingMethod({ name: 'ゆうパケット', fee: 200 })
    db.saveShippingMethod({ name: 'ネコポス', fee: 300 })
    const methods = db.listShippingMethods()
    const method1 = methods.find(m => m.name === 'ゆうパケット')!
    const method2 = methods.find(m => m.name === 'ネコポス')!

    // 古い方の販売（30日前）：ゆうパケット
    // タイトルに型番っぽい文字列（英字1+数字3）を入れると自動紐付けが割り込むため、
    // ここでは含めず手動での紐付けだけを試す
    const sale1 = createCompletedSale({ title: 'テスト商品の販売その1', sold_at: monthAgo, price: 2000, kind: 'resale' })
    db.linkInventory(sale1, [items[0].id])
    db.updateSale(sale1, { shipping_method_id: method1.id })

    // 新しい方の販売（今日）：ネコポス
    const sale2 = createCompletedSale({ title: 'テスト商品の販売その2', sold_at: today, price: 2500, kind: 'resale' })
    db.linkInventory(sale2, [items[1].id])
    db.updateSale(sale2, { shipping_method_id: method2.id })

    const karte = views.getProductKarte('X999')

    expect(karte.summary.model_code).toBe('X999')
    expect(karte.in_stock).toEqual({ count: 1, arrived: 1, not_arrived: 0, cost: 1000 })
    expect(karte.price_range).toEqual({ min: 2000, max: 2500 })

    // 手計算：sale1 粗利 = 2000-200(手数料)-200(送料)-1000(原価) = 600
    //         sale2 粗利 = 2500-250(手数料)-300(送料)-1000(原価) = 950
    // avg_price=(2000+2500)/2=2250, avg_profit=(600+950)/2=775
    // profit_rate = round(775/2250*100) = 34
    expect(karte.profit_rate).toBe(34)

    // 先入先出の未出品在庫（残り1点）
    expect(karte.estimate_default.inventory_item_id).toBe(items[2].id)
    // 最後に使った発送方法（sold_at が新しい sale2 のもの）
    expect(karte.estimate_default.shipping_method_id).toBe(method2.id)

    expect(() => views.getProductKarte('NOPE')).toThrow()
  })
})

describe('views: 月次の計算書', () => {
  beforeEach(() => {
    db.initDb(':memory:')
  })

  it('getMonthDetail と粗利・純利益が一致し、タグ別集計とmulti_tag_countが合う', () => {
    const today = todayLocal()
    const month = today.slice(0, 7)
    const shopId = db.createShopAccount('メロジョイ')
    const tagA = db.createTag('タグA')
    const tagB = db.createTag('タグB')

    db.createPurchase({
      shop_account_id: shopId, ordered_at: today, fulfillment: 'delivered',
      lines: [{ name: 'M001 テスト商品', unit_price: 1000, quantity: 3, model_code: 'M001' }],
    })
    const items = db.listInventory('in_stock').filter(i => i.model_code === 'M001')
    db.setInventoryTags(items[2].id, [tagB]) // sale3 に派生で付く

    // タイトルに型番っぽい文字列（英字1+数字3）を入れると自動紐付けが割り込むため含めない
    const sale1 = createCompletedSale({ title: 'テスト商品の販売その1', sold_at: today, price: 1000, kind: 'resale' })
    db.linkInventory(sale1, [items[0].id])
    db.setSaleTags(sale1, [tagA])

    const sale2 = createCompletedSale({ title: 'テスト商品の販売その2', sold_at: today, price: 1500, kind: 'resale' })
    db.linkInventory(sale2, [items[1].id])
    db.setSaleTags(sale2, [tagA, tagB])

    const sale3 = createCompletedSale({ title: 'テスト商品の販売その3', sold_at: today, price: 2000, kind: 'resale' })
    db.linkInventory(sale3, [items[2].id])
    // sale3 はタグを直接付けない（tagB は在庫からの派生）

    const detail = db.getMonthDetail(month)
    const statement = views.getMonthStatement(month)

    expect(statement.sales_count).toBe(detail.totals.sales_count)
    expect(statement.revenue).toBe(detail.totals.revenue)
    expect(statement.gross_profit).toBe(detail.totals.gross_profit)
    expect(statement.net_profit).toBe(detail.totals.net_profit)
    expect(statement.cost_items).toBe(3) // 3件とも1点ずつ紐付け

    const tagAEntry = statement.by_tag.find(t => t.tag.id === tagA)!
    const tagBEntry = statement.by_tag.find(t => t.tag.id === tagB)!
    const s1 = detail.sales.find(s => s.id === sale1)!
    const s2 = detail.sales.find(s => s.id === sale2)!
    const s3 = detail.sales.find(s => s.id === sale3)!

    expect(tagAEntry.count).toBe(2) // sale1・sale2
    expect(tagAEntry.gross_profit).toBe(s1.gross_profit + s2.gross_profit)
    expect(tagBEntry.count).toBe(2) // sale2（直接）・sale3（派生）
    expect(tagBEntry.gross_profit).toBe(s2.gross_profit + s3.gross_profit)

    // 2つ以上タグを持つのは sale2 だけ（tagA + tagB 直接）
    expect(statement.multi_tag_count).toBe(1)
  })
})

describe('views: 仕入タブの仕入先カード', () => {
  beforeEach(() => {
    db.initDb(':memory:')
  })

  it('2仕入先・期間で絞る', () => {
    const shop1 = db.createShopAccount('メロジョイA', 'mellojoy')
    const shop2 = db.createShopAccount('メロジョイB', 'other')

    // shop1：期間内の確定（2点・3000円）
    db.createPurchase({
      shop_account_id: shop1, ordered_at: '2025-06-10',
      lines: [{ name: 'A1', unit_price: 1000, quantity: 1 }, { name: 'A2', unit_price: 2000, quantity: 1 }],
    })
    // shop1：期間外の確定（除外される）
    db.createPurchase({
      shop_account_id: shop1, ordered_at: '2025-05-01',
      lines: [{ name: 'A3', unit_price: 500, quantity: 1 }],
    })
    // shop1：期間内の下書き
    db.createPurchaseDraft({
      import_key: 'draft-1', shop_account_id: shop1, ordered_at: '2025-06-15',
      lines: [{ name: 'D1', quantity: 1 }],
    })
    // shop1：期間内の未着（確定）
    db.createPurchase({
      shop_account_id: shop1, ordered_at: '2025-06-20', fulfillment: 'pending',
      lines: [{ name: 'P1', unit_price: 100, quantity: 1 }],
    })

    // shop2：期間内の確定（3点・900円）
    db.createPurchase({
      shop_account_id: shop2, ordered_at: '2025-06-05',
      lines: [{ name: 'B1', unit_price: 300, quantity: 3 }],
    })

    // shop1：ログイン切れの実行記録
    const runId = db.startRun('mellojoy', shop1)
    db.finishRun(runId, 'auth_required', 0, 0, 'ログインが必要です')

    const cards = views.listPurchaseAccountCards('2025-06-01', '2025-06-30')

    expect(cards[0]).toMatchObject({ shop_account_id: null, name: 'すべて' })
    const all = cards[0]
    const card1 = cards.find(c => c.shop_account_id === shop1)!
    const card2 = cards.find(c => c.shop_account_id === shop2)!

    // shop1：確定2件（2000+1000=3000円の注文 + 100円の未着注文）、点数3、下書き1、未着1
    expect(card1.orders).toBe(2)
    expect(card1.items).toBe(3)
    expect(card1.total_cost).toBe(3100)
    expect(card1.drafts).toBe(1)
    expect(card1.not_arrived).toBe(1)
    expect(card1.auth_required).toBe(true)

    expect(card2.orders).toBe(1)
    expect(card2.items).toBe(3)
    expect(card2.total_cost).toBe(900)
    expect(card2.drafts).toBe(0)
    expect(card2.not_arrived).toBe(0)
    expect(card2.auth_required).toBe(false)

    expect(all.orders).toBe(card1.orders + card2.orders)
    expect(all.items).toBe(card1.items + card2.items)
    expect(all.total_cost).toBe(card1.total_cost + card2.total_cost)
    expect(all.drafts).toBe(card1.drafts + card2.drafts)
    expect(all.not_arrived).toBe(card1.not_arrived + card2.not_arrived)
    expect(all.auth_required).toBe(true)
  })
})
