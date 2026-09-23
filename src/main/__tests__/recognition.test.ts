import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../db'
import { getMonthStatement } from '../views'
import { getInbox } from '../inbox'
import { thisMonthLocal } from '../../shared/date'
import type { SaleStatus } from '../../shared/types'

beforeEach(() => db.initDb(':memory:'))

describe('取引完了だけ実績・未完了は見込み', () => {
  it('すべての未完了状態と状態不明を分離し、ホーム・月次・タグ合計が一致する', () => {
    const month = thisMonthLocal()
    const tag = db.createTag('対象')
    const statuses: Array<SaleStatus | null> = [null, 'waiting_payment', 'waiting_shipment', 'shipped', 'delivered', 'completed']
    for (const status of statuses) {
      const [{ id }] = db.insertCollected([{ mercariItemId: `state-${status}`, title: `商品【A037】${status}`, soldAt: `${month}-01`, price: 1000, status: status ?? undefined }])
      db.setSaleTags(id, [tag])
    }
    db.createExpense({ occurred_at: `${month}-01`, category: 'packaging', amount: 200 })
    const actual = db.listMonthly().find(r => r.month === month)!
    expect(actual).toMatchObject({ sales_count: 1, revenue: 1000, gross_profit: 900, net_profit: 700,
      forecast: { count: 5, revenue: 5000, gross_profit: 4500 } })
    expect(db.saleTotals({ tagId: tag })).toMatchObject({ count: 1, revenue: 1000, forecast: actual.forecast })
    expect(getMonthStatement(month)).toMatchObject({ sales_count: 1, net_profit: 700, forecast: actual.forecast })
    expect(db.getMonthDetail(month).sales).toHaveLength(1)
    expect(db.getMonthDetail(month).forecast_sales).toHaveLength(5)
    expect(getInbox().strip).toMatchObject({ revenue: 1000, gross_profit: 900, pending_profit_estimate: 4500, pending_count: 5 })
  })

  it('赤字の見込みも残し、見込みだけの月に経費を二重計上しない', () => {
    const id = db.createSale({ title: '赤字', sold_at: '2026-05-01', price: 100 })
    db.applySaleActuals(id, { status: 'shipped' })
    db.updateSale(id, { shipping_fee: 300 })
    db.createExpense({ occurred_at: '2026-05-01', category: 'packaging', amount: 50 })
    expect(db.listMonthly()[0]).toMatchObject({ revenue: 0, net_profit: -50,
      forecast: { count: 1, revenue: 100, gross_profit: -210 } })
    expect(getMonthStatement('2026-05')).toMatchObject({ revenue: 0, net_profit: -50,
      forecast: { count: 1, revenue: 100, gross_profit: -210 } })
  })

  it('月をまたいで完了した取引は完了月の実績に一度だけ移る', () => {
    const [sale] = db.insertCollected([{ mercariItemId: 'recognition-month', title: '商品【A037】', price: 2000,
      soldAt: '2026-05-30', status: 'shipped' }])
    expect(db.listMonthly()[0]).toMatchObject({ month: '2026-05', revenue: 0, forecast: { revenue: 2000 } })
    db.applySaleActuals(sale.id, { status: 'completed', completedAt: '2026-06-02', sold_at: '2026-06-02' })
    expect(db.listMonthly()).toHaveLength(1)
    expect(db.listMonthly()[0]).toMatchObject({ month: '2026-06', revenue: 2000, forecast: { count: 0, revenue: 0 } })
    db.applySaleActuals(sale.id, { status: 'completed', completedAt: '2026-06-02', sold_at: '2026-06-02' })
    expect(db.saleTotals()).toMatchObject({ count: 1, revenue: 2000 })
  })

  it('商品別の粗利も実績と見込みを分け、在庫の販売状態は変えない', () => {
    const shop = db.createShopAccount('テスト')
    db.createPurchase({ shop_account_id: shop, ordered_at: '2026-05-01',
      lines: [{ name: '商品【A037】', unit_price: 500, quantity: 2 }] })
    const done = db.createSale({ title: '商品【A037】', sold_at: '2026-05-01', price: 1000 })
    db.applySaleActuals(done, { status: 'completed' })
    const pending = db.createSale({ title: '商品【A037】', sold_at: '2026-05-02', price: 2000 })
    db.applySaleActuals(pending, { status: 'shipped' })
    expect(db.listProducts()[0]).toMatchObject({ sold: 2, in_stock: 0, total_profit: 400, forecast_profit: 1300, avg_price: 1000 })
    expect(db.getProduct('A037')!.months.find(m => m.month === '2026-05')).toMatchObject({
      sold: 2, in_stock: 0, sales_amount: 1000, profit: 400, forecast_sales_amount: 2000, forecast_profit: 1300,
    })
  })
  it('状態未設定の手入力は実績。取得分の状態不明は見込み。保存状態は変更しない', () => {
    const month = thisMonthLocal()
    const shop = db.createShopAccount('手入力テスト')
    db.createPurchase({ shop_account_id: shop, ordered_at: `${month}-01`,
      lines: [{ name: '商品【A037】', unit_price: 500, quantity: 2 }] })
    const manual = db.createSale({ title: '商品【A037】', sold_at: `${month}-01`, price: 1000 })
    db.insertCollected([{ mercariItemId: 'unknown', title: '商品【A037】', soldAt: `${month}-01`, price: 2000 }])
    expect(db.listSales().find(s => s.id === manual)?.status).toBeNull()
    expect(db.saleTotals()).toMatchObject({ count: 1, revenue: 1000, gross_profit: 400, forecast: { count: 1, revenue: 2000, gross_profit: 1300 } })
    expect(db.listMonthly()[0]).toMatchObject({ sales_count: 1, revenue: 1000, unconfirmed_shipping: 1 })
    expect(getMonthStatement(month)).toMatchObject({ sales_count: 1, revenue: 1000, gross_profit: 400 })
    expect(getInbox().strip).toMatchObject({ revenue: 1000, pending_profit_estimate: 1300 })
    expect(db.listProducts()[0]).toMatchObject({ total_profit: 400, forecast_profit: 1300 })
    expect(db.getProduct('A037')!.months.find(m => m.month === month)).toMatchObject({ sales_amount: 1000, forecast_sales_amount: 2000 })
    expect(db.getDb().prepare('SELECT revenue FROM monthly_summary').get()).toEqual({ revenue: 1000 })
    expect(db.exportRows()).toContain('実績')
    expect(db.exportRows()).toContain('見込み')
  })
})
