import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'
import { thisMonthLocal } from '../../../shared/date'

// ペルソナ26：月末に締める人（経費の按分・締め）。
//
// 2026-01に転売3件（うち2件は未紐付け・1件は在庫2点をまとめて紐付け）＋私物1件、
// 経費2件（合計1,001円）を積み、金額按分・数量按分それぞれで手計算と一致することを確かめる。
// 締め→経費追加でchanged_since_close→reopenで戻る、までの一連の流れも確認する。
describe('ペルソナ26：月末に締める人（経費の按分・締め）', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('月次テスト仕入先')
  })

  it('経費の金額按分・数量按分が端数を最後の行に寄せて手計算と一致し、タグ絞り込み・締め・再オープンが正しく動く', () => {
    // ---- 販売3件（転売）＋私物1件。2026-01 ----
    // A：未紐付け（item_count=0）、送料は未確定のまま（pending.unconfirmed_shippingを見る）
    const saleA = db.createSale({ title: '月次A', sold_at: '2026-01-20', price: 1000 })
    // B：未紐付け（item_count=0）。送料だけ確定
    const saleB = db.createSale({ title: '月次B', sold_at: '2026-01-15', price: 2000 })
    db.updateSale(saleB, { shipping_fee: 0 })
    // C：在庫2点をまとめて紐付け（item_count=2）
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-01-01',
      shipping_fee: 0,
      lines: [{ name: '月次C用の商品', unit_price: 1000, quantity: 2 }],
    })
    const cItems = db.listInventory('in_stock')
    expect(cItems).toHaveLength(2)
    const saleC = db.createSale({ title: '月次C', sold_at: '2026-01-10', price: 3000 })
    db.linkInventory(saleC, cItems.map(i => i.id))
    db.updateSale(saleC, { shipping_fee: 0 })

    // 私物1件（按分・集計の対象外）
    const personalId = db.createSale({
      title: '私物・月次', sold_at: '2026-01-12', price: 5000, kind: 'personal',
    })

    // 手計算（fee_rate_bp既定1000=10%、floor）：
    // A: fee=100, cost=0, gross=1000-100=900
    // B: fee=200, cost=0, gross=2000-200=1800
    // C: fee=300, cost=2000（1000*2）, gross=3000-300-2000=700
    const salesBefore = db.listSales({ month: '2026-01', kind: 'resale' })
    expect(salesBefore.find(s => s.id === saleA)!.gross_profit).toBe(900)
    expect(salesBefore.find(s => s.id === saleB)!.gross_profit).toBe(1800)
    expect(salesBefore.find(s => s.id === saleC)!.gross_profit).toBe(700)

    // ---- 経費2件、合計1,001円 ----
    db.createExpense({ occurred_at: '2026-01-05', category: 'packaging', amount: 700 })
    db.createExpense({ occurred_at: '2026-01-25', category: 'shipping', amount: 301 })

    // ---- タグ：Aに直接、Cの在庫1点に（→Cへ派生） ----
    const tagId = db.createTag('按分テスト対象')
    db.setSaleTags(saleA, [tagId])
    db.setInventoryTags(cItems[0].id, [tagId])

    // ============================================================
    // 金額按分（既定 by_amount）
    // ============================================================
    let detail = db.getMonthDetail('2026-01', { tagId })
    expect(detail.alloc_method).toBe('by_amount')
    expect(detail.sales.map(s => s.id)).toEqual([saleA, saleB, saleC]) // sold_at DESC

    // 手計算：pool=1001, weight=price(1000,2000,3000), total=6000
    // A: floor(1001*1000/6000)=166 / B: floor(1001*2000/6000)=333 / C（最終行）: 1001-166-333=502
    const rowA = detail.sales.find(s => s.id === saleA)!
    const rowB = detail.sales.find(s => s.id === saleB)!
    const rowC = detail.sales.find(s => s.id === saleC)!
    expect(rowA.allocated_expense).toBe(166)
    expect(rowB.allocated_expense).toBe(333)
    expect(rowC.allocated_expense).toBe(502)
    expect(rowA.allocated_expense + rowB.allocated_expense + rowC.allocated_expense).toBe(1001) // 合計は必ず一致

    expect(rowA.net_profit).toBe(900 - 166)
    expect(rowB.net_profit).toBe(1800 - 333)
    expect(rowC.net_profit).toBe(700 - 502)

    expect(detail.personal_sales.map(s => s.id)).toEqual([personalId])
    expect(detail.expenses).toHaveLength(2)
    expect(detail.expense_by_category.find(c => c.category === 'packaging')!.amount).toBe(700)
    expect(detail.expense_by_category.find(c => c.category === 'shipping')!.amount).toBe(301)

    expect(detail.totals).toMatchObject({
      sales_count: 3, revenue: 6000, total_fee: 600, total_shipping: 0, total_packaging: 0,
      total_cost: 2000, gross_profit: 3400, expense_total: 1001,
    })
    expect(detail.totals.net_profit).toBe(3400 - 1001) // 2399

    // タグ絞り込み：直接（A）＋派生（C。Aは重複しない）
    expect(detail.filtered).not.toBeNull()
    expect(detail.filtered!.tag.id).toBe(tagId)
    expect(detail.filtered!.sales_count).toBe(2)
    expect(detail.filtered!.revenue).toBe(1000 + 3000)
    expect(detail.filtered!.gross_profit).toBe(900 + 700)
    expect(detail.filtered!.expense_total).toBe(166 + 502)
    expect(detail.filtered!.net_profit).toBe((900 - 166) + (700 - 502))

    expect(detail.purchases_by_account).toEqual([
      { shop_account_id: shopId, shop_account_name: '月次テスト仕入先', count: 1, total_cost: 2000 },
    ])
    expect(detail.pending).toEqual({ unconfirmed_shipping: 1, unmatched: 2 }) // A=未確定、A・B=未紐付け
    expect(detail.close).toBeNull()
    expect(detail.changed_since_close).toBe(false)

    // ============================================================
    // 数量按分に切り替え（締め済みでも変えられる）
    // ============================================================
    db.setMonthAllocMethod('2026-01', 'by_quantity')
    detail = db.getMonthDetail('2026-01')
    expect(detail.alloc_method).toBe('by_quantity')

    // 手計算：weight=item_count（0なら1）→ A=1, B=1, C=2, total=4
    // A: floor(1001*1/4)=250 / B: floor(1001*1/4)=250 / C（最終行）: 1001-250-250=501
    const qA = detail.sales.find(s => s.id === saleA)!
    const qB = detail.sales.find(s => s.id === saleB)!
    const qC = detail.sales.find(s => s.id === saleC)!
    expect(qA.allocated_expense).toBe(250)
    expect(qB.allocated_expense).toBe(250)
    expect(qC.allocated_expense).toBe(501)
    expect(qA.allocated_expense + qB.allocated_expense + qC.allocated_expense).toBe(1001)

    // 按分方法が変わっても、月全体の純利益（合計）は変わらない
    expect(detail.totals.net_profit).toBe(3400 - 1001)
    expect(qA.net_profit + qB.net_profit + qC.net_profit).toBe(3400 - 1001)

    // ============================================================
    // 締め・再オープン
    // ============================================================
    expect(() => db.closeMonth(thisMonthLocal())).toThrow('終わった月だけ締められます')

    const close = db.closeMonth('2026-01')
    expect(close).toMatchObject({
      month: '2026-01', alloc_method: 'by_quantity',
      sales_count: 3, revenue: 6000, gross_profit: 3400, expense_total: 1001, net_profit: 2399,
    })
    expect(close.closed_at).toBeTruthy()

    let afterClose = db.getMonthDetail('2026-01')
    expect(afterClose.close).not.toBeNull()
    expect(afterClose.changed_since_close).toBe(false)
    expect(db.listMonthly().find(m => m.month === '2026-01' && m.kind === 'resale')!.closed).toBe(true)

    // 締めた後に経費を足すと数字がずれ、changed_since_closeがtrueになる
    db.createExpense({ occurred_at: '2026-01-28', category: 'other', amount: 50 })
    afterClose = db.getMonthDetail('2026-01')
    expect(afterClose.totals.expense_total).toBe(1051)
    expect(afterClose.totals.net_profit).toBe(3400 - 1051)
    expect(afterClose.changed_since_close).toBe(true)
    // 締めた時点の数字自体は動かない
    expect(afterClose.close!.expense_total).toBe(1001)

    db.reopenMonth('2026-01')
    const reopened = db.getMonthDetail('2026-01')
    expect(reopened.close).toBeNull()
    expect(reopened.changed_since_close).toBe(false)
    expect(db.listMonthly().find(m => m.month === '2026-01' && m.kind === 'resale')!.closed).toBe(false)

    // ============================================================
    // 販売0件の月は配賦しない
    // ============================================================
    db.createExpense({ occurred_at: '2026-02-01', category: 'other', amount: 300 })
    const empty = db.getMonthDetail('2026-02')
    expect(empty.sales).toHaveLength(0)
    expect(empty.totals).toMatchObject({
      sales_count: 0, revenue: 0, gross_profit: 0, expense_total: 300, net_profit: -300,
    })
  })
})
