import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'

describe('ペルソナ08：下書きから確定する人', () => {
  let shopId: string

  beforeEach(() => {
    db.initDb(':memory:')
    shopId = db.createShopAccount('メロジョイ下書きテスト')
  })

  it('draft→confirm：在庫は確定するまで無く、按分後の合計が一致する。二重積み・再確定は弾かれる', () => {
    const draftId = db.createPurchaseDraft({
      import_key: 'order-8001',
      shop_account_id: shopId,
      ordered_at: '2026-02-01',
      order_no: '8001',
      lines: [{ name: 'テスト商品【D001】', quantity: 3 }],
    })
    expect(draftId).not.toBe('')

    // 在庫はまだ無い
    expect(db.listInventory('in_stock')).toHaveLength(0)

    // ダッシュボードの「要対応」に出る
    expect(db.getDashboard().needsPurchaseConfirm).toBe(1)

    const detail = db.getPurchase(draftId)
    expect(detail.status).toBe('draft')
    expect(detail.lines[0].unit_price).toBe(0) // 単価0のまま

    // 同じ import_key でもう一度積んでも増えない
    const dup = db.createPurchaseDraft({
      import_key: 'order-8001',
      shop_account_id: shopId,
      ordered_at: '2026-02-01',
      lines: [{ name: 'テスト商品【D001】', quantity: 3 }],
    })
    expect(dup).toBe('')
    expect(db.listPurchases()).toHaveLength(1)

    // 確定：単価・送料を入れる
    db.confirmPurchase(draftId, {
      shop_account_id: shopId,
      ordered_at: '2026-02-01',
      order_no: '8001',
      shipping_fee: 100,
      lines: [{ name: 'テスト商品【D001】', unit_price: 1000, quantity: 3 }],
    })

    const confirmed = db.getPurchase(draftId)
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.total_cost).toBe(1000 * 3 + 100) // 3100

    const items = db.listInventory('in_stock')
    expect(items).toHaveLength(3)
    // 端数は最終アイテムへ寄る（1033/1033/1034）。合計はpool(3100)と一致
    const sorted = [...items].sort((a, b) => a.landed_cost - b.landed_cost)
    expect(sorted.map(i => i.landed_cost)).toEqual([1033, 1033, 1034])
    expect(items.reduce((s, i) => s + i.landed_cost, 0)).toBe(3100)

    expect(db.getDashboard().needsPurchaseConfirm).toBe(0)

    // 確定済みを再確定するとエラー（landed_costは後から書き換えない）
    expect(() => db.confirmPurchase(draftId, {
      shop_account_id: shopId,
      ordered_at: '2026-02-01',
      lines: [{ name: 'x', unit_price: 1, quantity: 1 }],
    })).toThrow('確定済みの仕入は再確定できません')

    // 在庫は増えていない（再確定は失敗したまま）
    expect(db.listInventory('in_stock')).toHaveLength(3)
  })
})
