import * as db from '../db'
import type { SaleInput } from '../../shared/types'

/** 集計テスト用：取引完了を明示した販売を作る。状態未設定の仕様とは分ける。 */
export function createCompletedSale(input: SaleInput): string {
  const id = db.createSale(input)
  db.applySaleActuals(id, { status: 'completed' })
  return id
}
