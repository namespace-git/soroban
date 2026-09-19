import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ24：月末に締める人（期間費用）', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('月次テスト仕入先')
  })

  it('自動の振込手数料・手動の期間費用・設定変更・区分変更・resetDataが月次に正しく反映される', () => {
    // 2026-01：転売2件（送料確定・未確定を混ぜる）＋私物1件
    const saleA = db.createSale({ title: '1月商品A', sold_at: '2026-01-05', price: 1000 })
    db.updateSale(saleA, { shipping_fee: 100 }) // 確定
    const saleB = db.createSale({ title: '1月商品B', sold_at: '2026-01-15', price: 2000 })
    // 送料は未入力のまま（is_shipping_confirmed=0）
    db.createSale({ title: '私物1月', sold_at: '2026-01-10', price: 500, kind: 'personal' })

    // 2026-02：転売2件
    const saleA2 = db.createSale({ title: '2月商品A', sold_at: '2026-02-05', price: 1500 })
    db.updateSale(saleA2, { shipping_fee: 50 })
    db.createSale({ title: '2月商品B', sold_at: '2026-02-20', price: 2500 })

    // 手計算（fee_rate_bp既定1000=10%、floor）：
    // 1月resale: fee=100+200=300, shipping=100+0=100, gross=(1000-100-100)+(2000-200-0)=800+1800=2600
    // 2月resale: fee=150+250=400, shipping=50+0=50, gross=(1500-150-50)+(2500-250-0)=1300+2250=3550
    let monthly = db.listMonthly()
    const jan = monthly.find(m => m.month === '2026-01' && m.kind === 'resale')!
    expect(jan.gross_profit).toBe(2600)
    expect(jan.unconfirmed_shipping).toBe(1) // saleBだけ未確定
    expect(jan.expense_total).toBe(200) // 自動の振込手数料（既定200）
    expect(jan.net_profit).toBe(2600 - 200)

    const janPersonal = monthly.find(m => m.month === '2026-01' && m.kind === 'personal')!
    expect(janPersonal.expense_total).toBe(0) // 私物の行はexpense_total=0

    const feb = monthly.find(m => m.month === '2026-02' && m.kind === 'resale')!
    expect(feb.gross_profit).toBe(3550)
    expect(feb.unconfirmed_shipping).toBe(1)
    expect(feb.expense_total).toBe(200)
    expect(feb.net_profit).toBe(3550 - 200)

    // listExpensesに自動行（auto=1）が月1件
    const janExpensesBefore = db.listExpenses('2026-01')
    expect(janExpensesBefore).toHaveLength(1)
    expect(janExpensesBefore[0].auto).toBe(1)
    expect(janExpensesBefore[0].amount).toBe(200)
    const autoExpenseId = janExpensesBefore[0].id

    // 梱包材300をcreateExpense → その月（1月）だけ500
    db.createExpense({ occurred_at: '2026-01-20', category: 'supplies', amount: 300, note: '梱包材' })
    monthly = db.listMonthly()
    expect(monthly.find(m => m.month === '2026-01' && m.kind === 'resale')!.expense_total).toBe(500)
    expect(monthly.find(m => m.month === '2026-02' && m.kind === 'resale')!.expense_total).toBe(200)

    // 自動行をdeleteExpense → もう一度listMonthly()しても再作成されず300のまま
    db.deleteExpense(autoExpenseId)
    monthly = db.listMonthly()
    expect(monthly.find(m => m.month === '2026-01' && m.kind === 'resale')!.expense_total).toBe(300)
    expect(db.listExpenses('2026-01').every(e => e.auto === 0)).toBe(true)
    monthly = db.listMonthly() // もう一度呼んでも再作成されない
    expect(monthly.find(m => m.month === '2026-01' && m.kind === 'resale')!.expense_total).toBe(300)
    expect(db.listExpenses('2026-01')).toHaveLength(1) // 手動の300だけ

    // 設定transfer_feeを300に変えて新しい月（3月）に販売 → 新しい月は300、古い月（1月・2月）は変わらない
    db.setSetting('transfer_fee', '300')
    const saleC = db.createSale({ title: '3月商品', sold_at: '2026-03-05', price: 1000 })
    db.updateSale(saleC, { shipping_fee: 0 })
    monthly = db.listMonthly()
    const mar = monthly.find(m => m.month === '2026-03' && m.kind === 'resale')!
    // fee=floor(1000/10)=100、gross=1000-100-0-0-0=900
    expect(mar.expense_total).toBe(300)
    expect(mar.gross_profit).toBe(900)
    expect(mar.net_profit).toBe(900 - 300)
    expect(monthly.find(m => m.month === '2026-01' && m.kind === 'resale')!.expense_total).toBe(300) // 変わらない
    expect(monthly.find(m => m.month === '2026-02' && m.kind === 'resale')!.expense_total).toBe(200) // 変わらない（旧設定のまま）

    // 転売の販売を全部私物に変えた月（1月）→ 自動行はもう無いが、月自体が「転売0件」になる。
    // 手動の300だけ残り、resale行は0件で出る
    db.updateSale(saleA, { kind: 'personal' })
    db.updateSale(saleB, { kind: 'personal' })
    monthly = db.listMonthly()
    const janAfter = monthly.find(m => m.month === '2026-01' && m.kind === 'resale')!
    expect(janAfter.sales_count).toBe(0)
    expect(janAfter.expense_total).toBe(300) // 手動の300だけ残る
    expect(janAfter.net_profit).toBe(-300)
    expect(db.listExpenses('2026-01')).toHaveLength(1)
    expect(db.listExpenses('2026-01')[0].auto).toBe(0)

    // resetData()で費用も消える
    db.resetData()
    expect(db.listExpenses()).toHaveLength(0)
    expect(db.listMonthly()).toHaveLength(0)

    // まとめ売り3点（価格10,000）のgetProduct().monthsの合計が販売と一致する（sale_line_share）
    db.createPurchase({
      shop_account_id: shopId,
      ordered_at: '2026-08-01',
      shipping_fee: 0,
      lines: [{ name: '商品【P100】', unit_price: 1000, quantity: 3 }],
    })
    const items = db.listInventory('in_stock').filter(i => i.model_code === 'P100')
    expect(items).toHaveLength(3)
    expect(items.every(i => i.landed_cost === 1000)).toBe(true) // 送料なし

    const bundleSaleId = db.createSale({ title: 'まとめ売り', sold_at: '2026-08-10', price: 10000 })
    db.updateSale(bundleSaleId, { shipping_fee: 0 })
    db.linkInventory(bundleSaleId, items.map(i => i.id))

    const bundleSale = db.listSales().find(s => s.id === bundleSaleId)!
    // fee=floor(10000/10)=1000, cost=3000, gross=10000-1000-0-0-3000=6000
    expect(bundleSale.fee).toBe(1000)
    expect(bundleSale.cost).toBe(3000)
    expect(bundleSale.gross_profit).toBe(6000)

    const product = db.getProduct('P100')!
    const totalSalesAmount = product.months.reduce((s, m) => s + m.sales_amount, 0)
    const totalProfit = product.months.reduce((s, m) => s + m.profit, 0)
    expect(totalSalesAmount).toBe(bundleSale.price)
    expect(totalProfit).toBe(bundleSale.gross_profit)
  })
})
