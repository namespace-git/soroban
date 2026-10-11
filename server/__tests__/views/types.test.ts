import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createMigratedDb } from '../../test/migrate'
import { VIEW_NAMES, type ViewName } from './helpers'

// ビューの列の型。count() / sum() は Postgres では bigint になる（ドライバによっては文字列で返る）。
// 画面の契約は number なので、ビューの列は integer に揃えてある。
// 日付は date、日時は timestamptz（Sql の境界で 'YYYY-MM-DD' / ISO に正規化される）

let db: PGlite

beforeAll(async () => {
  db = await createMigratedDb()
})

afterAll(async () => {
  await db.close()
})

async function columnsOf(view: ViewName): Promise<Map<string, string>> {
  const { rows } = await db.query<{ column_name: string; data_type: string }>(
    `select column_name, data_type from information_schema.columns
      where table_schema = 'app' and table_name = $1 order by ordinal_position`,
    [view],
  )
  return new Map(rows.map((r) => [r.column_name, r.data_type]))
}

/** 金額・件数・日数（画面では number）の列 */
const INTEGER_COLUMNS: Record<ViewName, string[]> = {
  sale_profit: [
    'price', 'fee', 'shipping_fee', 'packaging_cost', 'is_shipping_confirmed', 'cost', 'gross_profit',
    'item_count', 'unmatched', 'auto_linked',
  ],
  monthly_summary: [
    'sales_count', 'revenue', 'total_fee', 'total_shipping', 'total_packaging', 'total_cost', 'gross_profit',
  ],
  inventory_view: ['landed_cost', 'aging_days', 'sold_price', 'listing_price'],
  sale_line_share: ['cost', 'price_share', 'profit_share'],
  variant_summary: [
    'purchased', 'sold', 'in_stock', 'stock_value', 'avg_price', 'avg_profit', 'total_profit', 'forecast_profit',
  ],
}

describe('ビューの列の型', () => {
  it('5 本とも、bigint・numeric・倍精度が 1 列も無い（数は integer、それ以外は text / date / timestamptz / uuid / 配列）', async () => {
    const allowed = new Set(['integer', 'text', 'date', 'timestamp with time zone', 'uuid', 'ARRAY'])
    for (const view of VIEW_NAMES) {
      const cols = await columnsOf(view)
      expect(cols.size, view).toBeGreaterThan(5)
      for (const [name, type] of cols) expect(allowed.has(type), `${view}.${name} が ${type}`).toBe(true)
    }
  })

  for (const view of VIEW_NAMES) {
    it(`${view}：金額・件数・日数の列はすべて integer`, async () => {
      const cols = await columnsOf(view)
      for (const name of INTEGER_COLUMNS[view]) expect(cols.get(name), `${view}.${name}`).toBe('integer')
    })
  }

  it('日付は date、日時は timestamptz、model_codes は text[]', async () => {
    const sp = await columnsOf('sale_profit')
    for (const c of ['sold_at', 'shipped_at', 'delivered_at', 'completed_at']) expect(sp.get(c), c).toBe('date')
    expect(sp.get('purchased_at')).toBe('timestamp with time zone')
    expect(sp.get('model_codes')).toBe('ARRAY')
    const iv = await columnsOf('inventory_view')
    expect(iv.get('acquired_at')).toBe('date')
    expect(iv.get('sold_sold_at')).toBe('date')
    expect((await columnsOf('monthly_summary')).get('month')).toBe('text')
  })

  it('SQLite から名前が変わった列：mercari_item_id → channel_item_id、thumb_file → thumb_path。元の名前は残っていない', async () => {
    const sp = await columnsOf('sale_profit')
    expect(sp.has('channel_item_id')).toBe(true)
    expect(sp.has('thumb_path')).toBe(true)
    expect(sp.has('mercari_item_id')).toBe(false)
    expect(sp.has('thumb_file')).toBe(false)
    const iv = await columnsOf('inventory_view')
    expect(iv.has('thumb_path')).toBe(true)
    expect(iv.has('thumb_file')).toBe(false)
    // listing_id は出品先での商品 ID（SQLite の mercari_item_id と同じ値）
    expect(iv.get('listing_id')).toBe('text')
  })

  it('household_id は各ビューの最後の列（それ以外の列の並びは SQLite のまま）', async () => {
    for (const view of VIEW_NAMES) {
      const names = [...(await columnsOf(view)).keys()]
      expect(names[names.length - 1], view).toBe('household_id')
    }
  })
})
