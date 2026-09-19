import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

// db.ts は electron.app、collector-mellojoy.ts（経由で collector.ts）は
// electron.BrowserWindow / electron.session を参照する。どちらも import 時点で
// 解決される必要があるので、まとめて潰しておく（実際に呼ぶのは createShopWindow 等
// 収集本体だけで、このペルソナでは触らない）
vi.mock('electron', () => ({
  app: { getPath: () => '' },
  BrowserWindow: class {},
  session: { fromPartition: () => ({ setUserAgent: () => {} }) },
}))

import * as db from '../../db'
import {
  fulfillmentFromStatus, parseOrderDetailHtml, parseOrderListHtml, toPurchaseInput,
} from '../../collector-mellojoy'
import { todayLocal } from '../../../shared/date'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ordersListHtml = readFileSync(join(__dirname, '..', 'fixtures', 'mellojoy-orders.html'), 'utf-8')
const orderDetailHtml = readFileSync(join(__dirname, '..', 'fixtures', 'mellojoy-order.html'), 'utf-8')

beforeEach(() => { db.initDb(':memory:') })

// ペルソナ15：メロジョイの注文が自動で入る人。
// 注文履歴（一覧→詳細）を読み、按分して在庫を作り、到着状態が進むのを見る。
describe('ペルソナ15：メロジョイの注文が自動で入る人', () => {
  it('注文履歴を取り込み→按分の手計算と一致→二重取り込みは弾く→到着状態が進む→履歴に出る', () => {
    const shopId = db.createShopAccount('メロジョイA', 'mellojoy')

    // 1) 一覧から #268526（確認済み＝pending）を見つけ、詳細を解析する
    const list = parseOrderListHtml(ordersListHtml)
    const order = list.find(o => o.orderNo === '#268526')
    expect(order).toBeDefined()
    expect(fulfillmentFromStatus(order!.status)).toBe('pending')

    const detail = parseOrderDetailHtml(orderDetailHtml)
    const result = toPurchaseInput(detail, {
      shopAccountId: shopId,
      orderedAt: '2026-09-19',
      orderNo: order!.orderNo,
      fulfillment: fulfillmentFromStatus(order!.status),
    })
    expect(result.kind).toBe('confirmed')
    if (result.kind !== 'confirmed') throw new Error('confirmed になるはず')

    // 2) db.createPurchase で確定する
    const purchaseId = db.createPurchase(result.input)

    // 3) 按分の手計算：単価2499・2399、送料499を金額按分（by_amount）
    //    total = 4898、line1 share = round(499*2499/4898) = round(254.59) = 255
    //    line2（最終行）share = 499 - 255 = 244
    //    landed_cost = 単価 + 端数配分（quantity=1なので配分そのまま）
    const z0782 = db.listInventory('in_stock').find(i => i.model_code === 'Z078-2')
    const z0744 = db.listInventory('in_stock').find(i => i.model_code === 'Z074-4')
    expect(z0782).toBeDefined()
    expect(z0744).toBeDefined()
    expect(z0782!.landed_cost).toBe(2499 + 255) // 2754
    expect(z0744!.landed_cost).toBe(2399 + 244) // 2643
    // 合計が総額（小計+送料）と一致する
    expect(z0782!.landed_cost + z0744!.landed_cost).toBe(4898 + 499)

    // 4) 同じ注文をもう一度取り込もうとすると existingImportKeys で弾かれる
    const importKey = `mellojoy:${order!.orderNo}`
    expect(db.existingImportKeys([importKey]).has(importKey)).toBe(true)

    // 5) createPurchase に同じ import_key を渡すとエラー
    expect(() => db.createPurchase({ ...result.input })).toThrow(/同じ注文が既に取り込まれています/)

    // 6) 到着状態を pending → shipped → delivered と進める
    let p = db.getPurchase(purchaseId)
    expect(p.fulfillment).toBe('pending')
    expect(p.shipped_at).toBeNull()
    expect(p.delivered_at).toBeNull()

    expect(db.updatePurchaseFulfillment(importKey, 'shipped')).toBe(true)
    p = db.getPurchase(purchaseId)
    expect(p.fulfillment).toBe('shipped')
    expect(p.shipped_at).toBe(todayLocal())
    expect(p.delivered_at).toBeNull()

    expect(db.updatePurchaseFulfillment(importKey, 'delivered')).toBe(true)
    p = db.getPurchase(purchaseId)
    expect(p.fulfillment).toBe('delivered')
    expect(p.shipped_at).toBe(todayLocal())
    expect(p.delivered_at).toBe(todayLocal())

    // 在庫側の fulfillment（inventory_view 経由）も delivered に変わっている
    const afterDelivery = db.listInventory('in_stock').find(i => i.model_code === 'Z078-2')
    expect(afterDelivery!.fulfillment).toBe('delivered')

    // 7) 履歴ドロワー（getItemTimeline）に「仕入先が発送」「到着」が日付付きで出る
    const timeline = db.getItemTimeline(afterDelivery!.id)
    expect(timeline).not.toBeNull()
    const shippedEvent = timeline!.events.find(e => e.kind === 'purchase_shipped')
    const deliveredEvent = timeline!.events.find(e => e.kind === 'purchase_delivered')
    expect(shippedEvent).toMatchObject({ title: '仕入先が発送', date: todayLocal() })
    expect(deliveredEvent).toMatchObject({ title: '到着', date: todayLocal() })
  })

  it('同じ注文を updatePurchaseFulfillment で変化なしのまま呼ぶと false（既取込の再更新を空振りさせない）', () => {
    const shopId = db.createShopAccount('メロジョイA', 'mellojoy')
    const detail = parseOrderDetailHtml(orderDetailHtml)
    const result = toPurchaseInput(detail, {
      shopAccountId: shopId, orderedAt: '2026-09-19', orderNo: '#268526', fulfillment: 'pending',
    })
    if (result.kind !== 'confirmed') throw new Error('confirmed になるはず')
    db.createPurchase(result.input)

    // 状態が変わらないなら false
    expect(db.updatePurchaseFulfillment('mellojoy:#268526', 'pending')).toBe(false)
    // 存在しない import_key も false
    expect(db.updatePurchaseFulfillment('mellojoy:#999999', 'shipped')).toBe(false)
  })
})
