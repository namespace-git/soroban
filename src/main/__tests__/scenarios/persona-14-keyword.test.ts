import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ14：キーワードで私物判定される人', () => {
  beforeEach(() => {
    db.initDb(':memory:')
  })

  it('キーワード設定時：含む→転売、含まない→私物。未設定なら型番の有無で判定。私物は月次で別列で粗利集計に入らない。切替で未処理に出る', () => {
    db.setSetting('mercari_keyword', 'Mellojoy, メロジョイ')

    db.insertCollected([
      { status: 'completed', mercariItemId: 'kw-1', title: 'Mellojoyの限定コラボ', price: 2000, soldAt: '2026-08-01' },
      { status: 'completed', mercariItemId: 'kw-2', title: 'メロジョイのおまけ付き', price: 1500, soldAt: '2026-08-02' },
      { status: 'completed', mercariItemId: 'kw-3', title: '普通の商品です', price: 1000, soldAt: '2026-08-03' },
    ])
    const sales = db.listSales()
    expect(sales.find(s => s.mercari_item_id === 'kw-1')!.kind).toBe('resale')
    expect(sales.find(s => s.mercari_item_id === 'kw-2')!.kind).toBe('resale')
    expect(sales.find(s => s.mercari_item_id === 'kw-3')!.kind).toBe('personal')

    // キーワード未設定に戻す：型番の有無で判定
    db.setSetting('mercari_keyword', '')
    db.insertCollected([
      { status: 'completed', mercariItemId: 'kw-4', title: 'テスト商品【K001】', price: 1200, soldAt: '2026-08-04' },
      { status: 'completed', mercariItemId: 'kw-5', title: '型番の無い商品', price: 800, soldAt: '2026-08-05' },
    ])
    const sales2 = db.listSales()
    expect(sales2.find(s => s.mercari_item_id === 'kw-4')!.kind).toBe('resale')
    expect(sales2.find(s => s.mercari_item_id === 'kw-5')!.kind).toBe('personal')

    // 私物は月次で別列。転売の粗利集計には私物分が混ざらない
    const monthly = db.listMonthly().filter(m => m.month === '2026-08')
    const resaleRow = monthly.find(m => m.kind === 'resale')!
    const personalRow = monthly.find(m => m.kind === 'personal')!

    // 転売：kw-1(2000) kw-2(1500) kw-4(1200) の3件
    expect(resaleRow.sales_count).toBe(3)
    expect(resaleRow.revenue).toBe(2000 + 1500 + 1200)
    // fee = floor(price*1000/10000) = 200 / 150 / 120
    expect(resaleRow.gross_profit).toBe((2000 - 200) + (1500 - 150) + (1200 - 120))

    // 私物：kw-3(1000) kw-5(800) の2件。転売側の集計に混入していない
    expect(personalRow.sales_count).toBe(2)
    expect(personalRow.revenue).toBe(1000 + 800)

    // 私物を転売に切り替えると未紐付けとして未処理に出る
    const personalSale = sales2.find(s => s.mercari_item_id === 'kw-5')!
    expect(personalSale.unmatched).toBe(1) // 元々在庫紐付けは無い

    // 送料は確定済みにしておき、「unmatched && kind」の効果だけを見る
    // （is_shipping_confirmed=0はkindに関係なくonlyPendingに出るため）
    db.updateSale(personalSale.id, { shipping_fee: 0 })
    expect(db.listSales({ onlyPending: true }).some(s => s.id === personalSale.id)).toBe(false)

    db.updateSale(personalSale.id, { kind: 'resale' })
    expect(db.listSales({ onlyPending: true }).some(s => s.id === personalSale.id)).toBe(true)
  })
})
