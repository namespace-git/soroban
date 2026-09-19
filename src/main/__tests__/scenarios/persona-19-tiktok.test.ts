import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import * as db from '../../db'
import { todayLocal } from '../../../shared/date'

beforeEach(() => { db.initDb(':memory:') })

// ペルソナ19：TikTokで仕入れる人。
// メロジョイ以外の仕入先（kind='tiktok'）を作り、手入力で仕入れる。
// 型番はタイトルから自動抽出され、メルカリ取り込みで枝番まで一致するものだけ
// 自動紐付けされるはず（CLAUDE.mdの原則）。
describe('ペルソナ19：TikTokで仕入れる人', () => {
  it('手入力仕入→型番自動抽出→枝番一致は自動紐付け、シリーズのみは候補止まりのはず', () => {
    const tiktokId = db.createShopAccount('TikTok仕入れ', 'tiktok')

    // 手入力仕入：タイトルから【A035】（枝番なし＝シリーズのみ）と
    // 【Z001-3】（枝番まで完全一致）を自動抽出させる
    db.createPurchase({
      shop_account_id: tiktokId,
      ordered_at: todayLocal(),
      lines: [
        { name: 'メロジョイ【A035】メロージョイ ミニランド', unit_price: 1500, quantity: 1 },
        { name: 'メロジョイ【Z001-3】抹茶スフレ-クリーミークリーム', unit_price: 1200, quantity: 1 },
      ],
    })

    const a035 = db.listInventory('in_stock').find(i => i.model_code === 'A035')
    const z0013 = db.listInventory('in_stock').find(i => i.model_code === 'Z001-3')
    expect(a035).toBeDefined()
    expect(z0013).toBeDefined()
    expect(a035!.series_code).toBe('A035')
    expect(z0013!.series_code).toBe('Z001')

    // メルカリ取り込み：【Z001-3】は枝番まで完全一致 → 自動紐付け
    const inserted = db.insertCollected([
      { mercariItemId: 'm-z0013', title: '【Z001-3】抹茶スフレ 新品未開封', price: 2500, soldAt: todayLocal() },
      { mercariItemId: 'm-a035', title: '【A035】メロージョイ ミニランド 新品', price: 1800, soldAt: todayLocal() },
    ])

    const saleZ = db.listSales().find(s => s.id === inserted.find(i => i.mercariItemId === 'm-z0013')!.id)!
    expect(saleZ.item_count).toBe(1)
    expect(saleZ.auto_linked).toBe(1)
    expect(saleZ.unmatched).toBe(0)

    // 【A035】はシリーズのみ（枝番なし）。CLAUDE.mdの原則どおりなら
    // 候補提示止まり（unmatched のまま）のはず
    const saleA = db.listSales().find(s => s.id === inserted.find(i => i.mercariItemId === 'm-a035')!.id)!
    expect(saleA.item_count).toBe(0)
    expect(saleA.unmatched).toBe(1)
    expect(saleA.auto_linked).toBe(0)
    // 候補には出ている（確定はしていない）
    const suggestions = db.suggestInventory(saleA.id)
    expect(suggestions.some(i => i.model_code === 'A035')).toBe(true)

    // 仕入先の無効化・改名
    db.updateShopAccount(tiktokId, { is_active: 0 })
    expect(db.listShopAccounts().find(a => a.id === tiktokId)?.is_active).toBe(0)
    db.updateShopAccount(tiktokId, { name: 'TikTok(改名後)' })
    expect(db.listShopAccounts().find(a => a.id === tiktokId)?.name).toBe('TikTok(改名後)')

    // 仕入で使っている仕入先は削除できない
    expect(() => db.deleteShopAccount(tiktokId)).toThrow(/仕入で使われています/)

    // 使っていない仕入先は削除できる。実行記録は残る
    const unusedId = db.createShopAccount('未使用アカウント', 'tiktok')
    const runId = db.startRun('mellojoy', unusedId)
    db.finishRun(runId, 'ok', 1, 1)
    db.deleteShopAccount(unusedId)
    expect(db.listShopAccounts().find(a => a.id === unusedId)).toBeUndefined()
    const run = db.listRuns().find(r => r.id === runId)
    expect(run).toBeDefined()
    expect(run!.shop_account_id).toBeNull()
  })
})
