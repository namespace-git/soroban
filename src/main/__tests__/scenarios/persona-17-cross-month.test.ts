import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

beforeEach(() => { db.initDb(':memory:') })

// ペルソナ17：月をまたぐ人。
// 2026-07/08/09 に転売と私物混在で売り、月次の集計と合計が一致するか見る。
// 送料未入力の販売が月次にどう出るかも確かめる（実装を読んで期待を決める）。
describe('ペルソナ17：月をまたぐ人', () => {
  it('listMonthlyの各月・合計がsaleTotalsと一致する', () => {
    // 07月：転売1件（送料確定）・私物1件（送料確定）
    const a = db.createSale({ title: '転売A', price: 3000, sold_at: '2026-07-10', kind: 'resale' })
    db.updateSale(a, { shipping_fee: 300 }) // fee=300, profit=3000-300-300=2400

    const b = db.createSale({ title: '私物B', price: 1000, sold_at: '2026-07-20', kind: 'personal' })
    db.updateSale(b, { shipping_fee: 100 }) // fee=100, profit=1000-100-100=800

    // 08月：転売2件。1件は送料未入力のまま（＝未処理）
    const c = db.createSale({ title: '転売C', price: 4000, sold_at: '2026-08-05', kind: 'resale' })
    db.updateSale(c, { shipping_fee: 400 }) // fee=400, profit=4000-400-400=3200

    const d = db.createSale({ title: '転売D', price: 2000, sold_at: '2026-08-15', kind: 'resale' })
    // 送料はあえて未入力のまま（is_shipping_confirmed=0, shipping_fee=0既定）
    // fee=200, profit=2000-200-0=1800（送料0円換算で仮の粗利になる）

    // 09月：転売1件
    const e = db.createSale({ title: '転売E', price: 5000, sold_at: '2026-09-01', kind: 'resale' })
    db.updateSale(e, { shipping_fee: 500 }) // fee=500, profit=5000-500-500=4000

    const monthly = db.listMonthly()

    const jul = monthly.filter(m => m.month === '2026-07')
    const julResale = jul.find(m => m.kind === 'resale')!
    const julPersonal = jul.find(m => m.kind === 'personal')!
    expect(julResale).toMatchObject({
      sales_count: 1, revenue: 3000, total_fee: 300, total_shipping: 300,
      total_packaging: 0, total_cost: 0, gross_profit: 2400,
    })
    expect(julPersonal).toMatchObject({
      sales_count: 1, revenue: 1000, total_fee: 100, total_shipping: 100,
      total_packaging: 0, total_cost: 0, gross_profit: 800,
    })

    const aug = monthly.find(m => m.month === '2026-08' && m.kind === 'resale')!
    // 送料未入力のDも、送料0円換算のまま合算されている（実装の実際の挙動）
    expect(aug).toMatchObject({
      sales_count: 2, revenue: 6000, total_fee: 600, total_shipping: 400,
      total_packaging: 0, total_cost: 0, gross_profit: 5000, // 3200 + 1800
      unconfirmed_shipping: 1, // D の分。08月の粗利が仮の値を含むことがこの件数で分かる
    })
    expect(julResale.unconfirmed_shipping).toBe(0)

    const sep = monthly.find(m => m.month === '2026-09' && m.kind === 'resale')!
    expect(sep).toMatchObject({
      sales_count: 1, revenue: 5000, total_fee: 500, total_shipping: 500,
      total_packaging: 0, total_cost: 0, gross_profit: 4000,
      unconfirmed_shipping: 0,
    })

    // 全部足した合計が saleTotals() と一致する
    const totals = db.saleTotals()
    const sumField = (f: keyof typeof julResale) =>
      monthly.reduce((s, m) => s + (m[f] as number), 0)
    expect(totals.count).toBe(sumField('sales_count'))
    expect(totals.revenue).toBe(sumField('revenue'))
    expect(totals.total_fee).toBe(sumField('total_fee'))
    expect(totals.total_shipping).toBe(sumField('total_shipping'))
    expect(totals.total_cost).toBe(sumField('total_cost'))
    expect(totals.gross_profit).toBe(sumField('gross_profit'))

    // 手計算の総合計
    expect(totals.count).toBe(5)
    expect(totals.revenue).toBe(3000 + 1000 + 4000 + 2000 + 5000)
    expect(totals.gross_profit).toBe(2400 + 800 + 3200 + 1800 + 4000)

    // 送料未入力の D は「未処理」として onlyPending に出る
    const pending = db.listSales({ onlyPending: true })
    expect(pending.map(s => s.id)).toContain(d)
  })
})

// 怪しいと思った点（実装を読んで確認したこと）：
// sale_profit ビュー・monthly_summary は is_shipping_confirmed を見ない。
// 送料未入力（D）の shipping_fee は既定0円のまま合計・粗利に混ざり込み、
// 08月の粗利は「本当は送料が引かれる前」の仮の値が確定値と区別なく合算される。
// listSales({ onlyPending: true }) で個別には分かるが、listMonthly/saleTotals の
// 数字だけを見た人には「未確定を含む」ことが伝わらない。
// → R-05（期間費用）で MonthlySummary.unconfirmed_shipping を足したので、
// listMonthly() の戻り値だけでも「その月は◯件が未確定」と分かるようになった
// （上のテストで08月=1件・07月/09月=0件を確認）。それでも粗利の数字自体は
// 送料0円換算のままなので、UI側で件数を目立たせる注記は引き続き要る。
