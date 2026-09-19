import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'
import { todayLocal, thisMonthLocal } from '../../../shared/date'

beforeEach(() => { db.initDb(':memory:') })

/** exportRows() の CSV（先頭にBOM、CRLF区切り）をパースする */
function parseCsv(csv: string): Array<Record<string, string>> {
  const clean = csv.replace(/^﻿/, '')
  if (!clean) return []
  const [headerLine, ...lines] = clean.split('\r\n').filter(l => l.length > 0)
  const headers = headerLine.split(',')
  return lines.map(line => {
    const cells = line.split(',')
    return Object.fromEntries(headers.map((h, i) => [h, cells[i]]))
  })
}

// ペルソナ18：数字を突き合わせる人。
// 同じデータを複数の集計API・画面から見て、数字がどれも一致するか確かめる。
describe('ペルソナ18：数字を突き合わせる人', () => {
  it('ダッシュボード・variant・product・monthly・CSVの数字が全部一致する', () => {
    const shopId = db.createShopAccount('メロジョイA', 'mellojoy')

    // 仕入：X001-1を2点、送料200円を金額按分（1行のみなので端数なく100/100）
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: todayLocal(),
      shipping_fee: 200,
      lines: [{ name: 'ぬいぐるみ【X001-1】', unit_price: 1000, quantity: 2 }],
    })
    const items = db.listInventory('in_stock').filter(i => i.model_code === 'X001-1')
    expect(items).toHaveLength(2)
    expect(items[0].landed_cost).toBe(1100)
    expect(items[1].landed_cost).toBe(1100)

    // 販売：1点を型番完全一致で自動紐付け、送料300円を確定
    const saleId = db.createSale({ title: 'ぬいぐるみ【X001-1】美品', price: 3000, sold_at: todayLocal() })
    db.updateSale(saleId, { shipping_fee: 300 })
    // fee=300, profit = 3000-300-300-1100 = 1300
    const sale = db.listSales().find(s => s.id === saleId)!
    expect(sale.item_count).toBe(1)
    expect(sale.cost).toBe(1100)
    expect(sale.gross_profit).toBe(1300)
    expect(sale.auto_linked).toBe(1)

    // 残り1点は在庫のまま
    const remaining = db.listInventory('in_stock').filter(i => i.model_code === 'X001-1')
    expect(remaining).toHaveLength(1)
    const remainingCost = remaining[0].landed_cost

    // ---- 突き合わせ ----

    // 1) getDashboard
    const dash = db.getDashboard()
    expect(dash.needsShipping).toBe(0)
    expect(dash.needsMatch).toBe(0)
    expect(dash.needsPurchaseConfirm).toBe(0)
    expect(dash.stockCount).toBe(1)
    // 在庫金額 = in_stock の landed_cost 合計
    const stockValueByHand = db.listInventory('in_stock').reduce((s, i) => s + i.landed_cost, 0)
    expect(dash.stockValue).toBe(stockValueByHand)
    expect(dash.stockValue).toBe(remainingCost)
    expect(dash.thisMonth).toMatchObject({
      month: thisMonthLocal(), kind: 'resale',
      sales_count: 1, revenue: 3000, total_fee: 300, total_shipping: 300,
      total_cost: 1100, gross_profit: 1300,
    })

    // 2) listVariantSummary
    const variant = db.listVariantSummary().find(v => v.model_code === 'X001-1')!
    expect(variant.purchased).toBe(2)
    expect(variant.sold).toBe(1)
    expect(variant.in_stock).toBe(1)
    expect(variant.stock_value).toBe(remainingCost)
    expect(variant.total_profit).toBe(1300)

    // 3) listProducts
    const product = db.listProducts().find(p => p.model_code === 'X001-1')!
    expect(product.purchase_total).toBe(1100 + 1100)
    expect(product.avg_cost).toBe(1100)
    expect(product.total_profit).toBe(1300)
    expect(product.stock_value).toBe(remainingCost)

    // 4) getProduct().months：今月だけの1点
    const detail = db.getProduct('X001-1')!
    const thisMonthPoint = detail.months.find(m => m.month === thisMonthLocal())!
    expect(thisMonthPoint).toMatchObject({
      purchased: 2, sold: 1, in_stock: 1,
      purchase_amount: 2200, sales_amount: 3000, profit: 1300,
    })
    // months の profit 合計 = gross_profit 合計
    const monthsProfitSum = detail.months.reduce((s, m) => s + m.profit, 0)
    expect(monthsProfitSum).toBe(1300)

    // 5) listMonthly
    const monthlyRow = db.listMonthly().find(m => m.month === thisMonthLocal() && m.kind === 'resale')!
    expect(monthlyRow.gross_profit).toBe(1300)
    expect(monthlyRow.total_cost).toBe(1100)

    // 6) saleTotals：粗利合計 = 各販売のgross_profit合計（今は1件）
    const totals = db.saleTotals()
    const profitSumByHand = db.listSales().reduce((s, x) => s + x.gross_profit, 0)
    expect(totals.gross_profit).toBe(profitSumByHand)
    expect(totals.gross_profit).toBe(1300)

    // 7) exportRows（CSV）：行数 = 販売数
    const rows = parseCsv(db.exportRows())
    expect(rows).toHaveLength(db.listSales().length)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]['粗利'])).toBe(1300)
    expect(Number(rows[0]['原価'])).toBe(1100)
    expect(rows[0]['型番']).toBe('X001-1')
  })
})
