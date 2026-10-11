import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createMigratedDb } from '../../test/migrate'
import { asApi } from '../schema/helpers'
import { normalizePg, normalizeSqlite, readView, sortRows } from '../views/helpers'
import { migrateToWeb, MigrationVerifyError, type MigrateOutput } from '../../../tools/migrate-to-web/migrate'
import { formatReport } from '../../../tools/migrate-to-web/report'
import { HouseholdNotEmptyError } from '../../../tools/migrate-to-web/write'
import { TABLE_SPECS } from '../../../tools/migrate-to-web/spec'
import { VIEW_NAMES, type Row, type SourceSnapshot } from '../../../tools/migrate-to-web/types'
import {
  createHouseholdFor, db, imagesForFixture, loadFixture, recordingUploader, remapSnapshot, sequentialIds, snapshotFromFixture,
} from './helpers'

// SQLite の帳簿（見本）を Postgres の世帯に移して、いまの帳簿と 1 円も違わないことを確かめる。
// 期待値（views/fixtures/expected.json）は、SQLite に db.ts の関数で見本を入れて書き出した「表の中身」と「ビューの出力」

const fx = loadFixture()
let pg: PGlite

// 見本には無い表を足した、移行元のスナップショット（画像・設定・タグ・お金の出入りなど）
const T = (n: number): string => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`
const secretGemini = 'SECRET-GEMINI-KEY-ENCRYPTED'
const secretTrack = 'SECRET-TRACK17-KEY-ENCRYPTED'

const firstSale = fx.tables.sale[0].id as string
const firstItem = fx.tables.inventory_item[0].id as string
const firstPurchase = fx.tables.purchase[0].id as string
const firstAccount = fx.tables.shop_account[0].id as string
const maxItemCode = Math.max(...fx.tables.inventory_item.map((i) => Number(String(i.item_code).slice(2))))

function extraTables(): Record<string, Row[]> {
  const listing = structuredClone(fx.tables.listing)
  listing[0].thumb_file = 'listing-l1.jpg'
  listing[1].thumb_file = 'listing-gone.jpg' // 画像のファイルが無い
  const purchaseLine = structuredClone(fx.tables.purchase_line)
  purchaseLine[0].image_file = 'pl-0.png'
  const expense = structuredClone(fx.tables.expense)
  expense[0].receipt_file = 'receipt-0.jpeg'
  return {
    listing,
    purchase_line: purchaseLine,
    expense,
    setting: [
      { key: 'fee_rate_bp', value: '900' },
      { key: 'item_code_seq', value: String(maxItemCode + 5) },
      { key: 'mercari_keyword', value: 'もこ山' },
      { key: 'snooze:manual_purchase:-', value: '2026-10-20' },
      { key: `mellojoy_image_cursor:${firstAccount}`, value: firstPurchase },
      { key: 'schema_version', value: '34' },
      { key: 'gemini_api_key_enc', value: secretGemini },
      { key: 'track17_api_key_enc', value: secretTrack },
      { key: 'auto_backup', value: '1' },
      { key: 'auto_backup_last_at', value: '2026-10-09T00:16:00.000Z' },
    ],
    tag: [{ id: T(1), name: 'セール', sort_order: 1, created_at: '2026-10-01 00:00:00' }],
    sale_tag: [{ sale_id: firstSale, tag_id: T(1) }],
    inventory_tag: [{ inventory_item_id: firstItem, tag_id: T(1) }],
    purchase_tag: [{ purchase_id: firstPurchase, tag_id: T(1) }],
    product_tag: [{ model_code: 'A037', tag_id: T(1) }],
    shop_account_tag: [{ shop_account_id: firstAccount, tag_id: T(1) }],
    shop_alias: [{ key: 'reg:T1234567890123', shop: 'テスト店', hits: 2, updated_at: '2026-10-02 03:04:05' }],
    product_image: [
      { model_code: 'A037', file: 'product-A037.webp', updated_at: '2026-10-03 00:00:00' },
      { model_code: 'A099', file: 'product-gone.webp', updated_at: '2026-10-03 00:00:00' }, // ファイルが無い → 行ごと移さない
    ],
    mellojoy_excluded_order: [{ shop_account_id: firstAccount, order_key: 'o-1', keywords_hash: 'h', excluded_at: '2026-10-04 00:00:00' }],
    sale_exclusion: [{ mercari_item_id: 'm-gone', title: '削除した販売', excluded_at: '2026-10-05 00:00:00' }],
    collector_run: [{
      id: T(2), started_at: '2026-10-09T00:00:00.000Z', finished_at: '2026-10-09T00:01:00.000Z', status: 'ok',
      fetched: 3, inserted: 1, message: null, source: 'mellojoy', shop_account_id: firstAccount,
    }],
    cash_account: [{ id: T(3), name: '銀行', kind: 'bank', opening_balance: 100000, opening_date: '2026-09-01', sort_order: 0, is_active: 1, created_at: '2026-09-01 00:00:00' }],
    liability: [T(4), T(11), T(12)].map((id) => ({
      id, kind: 'loan', counterparty: '家族', occurred_at: '2026-09-02', due_at: '2026-12-31', amount: 50000, note: null,
      basis_sale_id: null, basis_amount: null, basis_rate_bp: null, month: null, created_at: '2026-09-02 00:00:00',
    })),
    cash_entry: [{
      id: T(5), account_id: T(3), occurred_at: '2026-09-02', direction: 'in', amount: 50000, category: 'loan_in', note: null,
      sale_id: null, created_at: '2026-09-02 00:00:00',
    }],
    // id の順とは逆に並べる（入力した順＝SQLite の rowid 順が、settle_order に残ること）
    liability_settlement: [
      { id: T(30), entry_id: T(5), liability_id: T(4), amount: 1000 },
      { id: T(20), entry_id: T(5), liability_id: T(11), amount: 2000 },
      { id: T(10), entry_id: T(5), liability_id: T(12), amount: 3000 },
    ],
  }
}

const IMAGE_FILES = {
  'listing-l1.jpg': 2048, 'pl-0.png': 4096, 'receipt-0.jpeg': 8192, 'product-A037.webp': 1024,
}

function snapshot(): SourceSnapshot {
  return snapshotFromFixture(fx, { tables: extraTables(), skippedTables: { app_log: 3890 } })
}

let hhA: string
let hhB: string
let result: MigrateOutput
const uploaderA = recordingUploader()

beforeAll(async () => {
  pg = await createMigratedDb()
  // Supabase の既定と同じ UTC のセッション
  await pg.exec("set time zone 'UTC'")
  hhA = (await createHouseholdFor(pg, '世帯A')).householdId
  hhB = (await createHouseholdFor(pg, '世帯B')).householdId
  result = await migrateToWeb({
    sql: db(pg), householdId: hhA, snapshot: snapshot(),
    images: { source: imagesForFixture(fx, IMAGE_FILES), uploader: uploaderA },
    newId: sequentialIds(),
  })
})

afterAll(async () => {
  await pg.close()
})

/** 世帯 id を条件に、接続したロール（持ち主）で数える。RLS を通さないので、他の世帯への書き込みも見える */
async function countAll(table: string, household: string): Promise<number> {
  return (await pg.query<{ n: number }>(`select count(*)::integer as n from app.${table} where household_id = $1`, [household])).rows[0].n
}

describe('見本を移した結果', () => {
  it('突き合わせは全部一致している（表の中身・金額のビュー 5 本・月次・その他の確認）', () => {
    const r = result.report
    expect(r.ok).toBe(true)
    expect(r.tables.every((t) => t.ok)).toBe(true)
    expect(r.sums.every((s) => s.ok)).toBe(true)
    expect(r.monthly.every((m) => m.ok)).toBe(true)
    expect(r.views.map((v) => v.view)).toEqual([...VIEW_NAMES])
    expect(r.views.every((v) => v.ok && v.mismatchCount === 0)).toBe(true)
    expect(r.invariants.every((i) => i.ok)).toBe(true)
    // 画面に出る表（文言が崩れていない）
    const text = formatReport(r)
    expect(text).toContain('すべて一致しました')
    expect(text).toContain('sale_profit')
  })

  it('SQLite の行数と Postgres の行数が表ごとに合う（移さなかった行・設定の合算を除く）', async () => {
    const src = snapshot()
    for (const spec of TABLE_SPECS) {
      const n = await countAll(spec.name, hhA)
      const sourceRows = (src.tables[spec.name] ?? []).length
      if (spec.name === 'setting') {
        expect(n).toBe(11) // 世帯の初期値 9 件 + SQLite にだけあるキー 2 件（中身は下の「設定」で見る）
      } else if (spec.name === 'product_image') {
        expect(n).toBe(sourceRows - 1) // ファイルが無い 1 行は移さない
      } else {
        expect(n, spec.name).toBe(sourceRows)
      }
    }
  })

  it('金額のビューの出力が expected.json（SQLite の出力）と全行・全列で一致する（日付は書き出した日に固定）', async () => {
    const paths = new Map(result.images.filter((i) => i.table === 'sale').map((i) => [i.rowKey, i.path]))
    for (const view of VIEW_NAMES) {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(`${fx.generated_on}T03:00:00Z`))
      let rows: Row[]
      try {
        rows = await asApi(pg, hhA, (tx) => readView(tx, view))
      } finally {
        vi.useRealTimers()
      }
      const actual = sortRows(view, normalizePg(view, rows, hhA))
      const expected = sortRows(view, normalizeSqlite(view, fx.views[view]).map((r) => withMappedThumb(view, r, paths)))
      expect(actual.length).toBe(expected.length)
      expect(actual).toEqual(expected)
    }
  })

  it('まとめ売りの端数（1,001 円を 3 点 → 333/334/334）と、按分の合計が価格・粗利と一致する', async () => {
    const rows = await asApi(pg, hhA, async (tx) =>
      (await tx.query<{ price_share: number }>(
        `select s.price_share from app.sale_line_share s
           join app.sale_line l on l.id = s.sale_line_id
           join app.sale sa on sa.id = s.sale_id
          where sa.channel_item_id = 'm-s14' order by l.allocation_order`)).rows.map((r) => r.price_share))
    expect(rows).toEqual([333, 334, 334])
    const bad = await asApi(pg, hhA, async (tx) =>
      (await tx.query<{ n: number }>(
        `select count(*)::integer as n from app.sale_profit p
           join (select sale_id, sum(price_share)::integer sp, sum(profit_share)::integer pf from app.sale_line_share group by sale_id) s
             on s.sale_id = p.id where s.sp <> p.price or s.pf <> p.gross_profit`)).rows[0].n)
    expect(bad).toBe(0)
  })
})

function withMappedThumb(view: string, r: Row, paths: Map<string, string | null>): Row {
  if (view === 'sale_profit') return { ...r, thumb_path: r.thumb_path === null ? null : (paths.get(String(r.id)) ?? null) }
  if (view === 'inventory_view') {
    return { ...r, thumb_path: r.thumb_path === null ? null : (paths.get(String(r.sold_sale_id)) ?? null) }
  }
  return r
}

describe('紐付けの順番（sale_line）', () => {
  it('SQLite の rowid 順（見本の配列の順）のまま、allocation_order が振られる', async () => {
    const ids = (await pg.query<{ id: string }>('select id from app.sale_line where household_id = $1 order by allocation_order', [hhA]))
      .rows.map((r) => r.id)
    expect(ids).toEqual(fx.tables.sale_line.map((l) => l.id))
  })

  it('消込（liability_settlement）も、入力した順（SQLite の rowid 順）が settle_order に残る', async () => {
    const ids = (await pg.query<{ id: string }>('select id from app.liability_settlement where household_id = $1 order by settle_order', [hhA]))
      .rows.map((r) => r.id)
    expect(ids).toEqual([T(30), T(20), T(10)])
    expect(result.report.invariants.find((i) => i.name.startsWith('消込の順'))?.ok).toBe(true)
  })

  it('配列の順を入れ替えると、その順で振られる（道具は順番を入れ替えない。rowid 順に並べるのは読む側）', async () => {
    const { householdId } = await createHouseholdFor(pg, '逆順')
    const snap = remapSnapshot(snapshot())
    snap.tables.sale_line = [...snap.tables.sale_line].reverse()
    // 並びが変わると 1 点あたりの按分の端数の行が変わるので、SQLite のビュー（正）とは一致しなくなる＝突き合わせが落ちる
    const err = await migrateToWeb({
      sql: db(pg), householdId, snapshot: snap, images: { source: imagesForFixture(fx, IMAGE_FILES), uploader: null },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MigrationVerifyError)
    const report = (err as MigrationVerifyError).report
    expect(report.ok).toBe(false)
    expect(report.invariants.find((i) => i.name.startsWith('紐付けた順'))?.ok).toBe(true) // 書いた順どおりには入っている
    expect(report.views.find((v) => v.view === 'sale_line_share')?.ok).toBe(false)
    // 落ちたので、何も残っていない
    expect(await countAll('sale_line', householdId)).toBe(0)
  })
})

describe('在庫の更新日時', () => {
  it('紐付けで動くトリガーが updated_at を「いま」にしても、SQLite の値に戻してある。原価は触らない', async () => {
    const rows = (await pg.query<{ id: string; updated_at: string; landed_cost: number; status: string }>(
      `select id, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as updated_at, landed_cost, status
         from app.inventory_item where household_id = $1`, [hhA])).rows
    const byId = new Map(rows.map((r) => [r.id, r]))
    const sold = fx.tables.inventory_item.filter((i) => i.status === 'sold')
    expect(sold.length).toBeGreaterThan(5)
    for (const item of fx.tables.inventory_item) {
      const got = byId.get(item.id as string)
      expect(got?.updated_at, String(item.item_code)).toBe(item.updated_at)
      expect(got?.landed_cost).toBe(item.landed_cost)
      expect(got?.status).toBe(item.status)
    }
  })
})

describe('発送方法と設定（世帯を作ったときの初期データとの衝突）', () => {
  it('初期の発送方法は消えて、SQLite の行が同じ id で入る。販売はその id を指している', async () => {
    const rows = (await pg.query<{ id: string; name: string }>(
      'select id, name from app.shipping_method where household_id = $1 order by sort_order', [hhA])).rows
    expect(rows.map((r) => r.id)).toEqual(fx.tables.shipping_method.map((s) => s.id))
    expect(result.report.replacedShippingMethods).toBe(8)
    const refs = (await pg.query<{ n: number }>(
      `select count(*)::integer as n from app.sale s join app.shipping_method m on m.household_id = s.household_id and m.id = s.shipping_method_id
        where s.household_id = $1`, [hhA])).rows[0].n
    expect(refs).toBe(fx.tables.sale.filter((s) => s.shipping_method_id !== null).length)
  })

  it('設定はキーで上書きされる。SQLite に無いキーは初期値のまま、SQLite にだけあるキーは増える', async () => {
    const rows = (await pg.query<{ key: string; value: string }>('select key, value from app.setting where household_id = $1', [hhA])).rows
    const m = new Map(rows.map((r) => [r.key, r.value]))
    expect(m.get('fee_rate_bp')).toBe('900') // 初期値 1000 を上書き
    expect(m.get('item_code_seq')).toBe(String(maxItemCode + 5))
    expect(m.get('mercari_keyword')).toBe('もこ山')
    expect(m.get('transfer_fee')).toBe('200') // SQLite に無い → 初期値のまま
    expect(m.get('snooze:manual_purchase:-')).toBe('2026-10-20') // SQLite にだけあるキー
    expect(m.get(`mellojoy_image_cursor:${firstAccount}`)).toBe(firstPurchase)
    expect(rows.length).toBe(9 + 2) // 初期 9 件 + snooze と image_cursor
  })

  it('schema_version・API キー（*_enc）・自動バックアップの設定は移さない。値はどこにも出てこない', async () => {
    const keys = (await pg.query<{ key: string }>('select key from app.setting where household_id = $1', [hhA])).rows.map((r) => r.key)
    for (const k of ['schema_version', 'gemini_api_key_enc', 'track17_api_key_enc', 'auto_backup', 'auto_backup_last_at']) {
      expect(keys).not.toContain(k)
    }
    expect(result.report.settings.skipped.map((s) => s.key).sort()).toEqual(
      ['auto_backup', 'auto_backup_last_at', 'gemini_api_key_enc', 'schema_version', 'track17_api_key_enc'])
    // 暗号化されたキーの値が、どの表のどの列にも入っていない（レポートにも出ない）
    for (const spec of TABLE_SPECS) {
      const hit = await pg.query<{ n: number }>(
        `select count(*)::integer as n from app.${spec.name} t where to_jsonb(t)::text like '%SECRET-%'`)
      expect(hit.rows[0].n, spec.name).toBe(0)
    }
    const text = JSON.stringify(result.report)
    expect(text).not.toContain('SECRET-')
    expect(formatReport(result.report)).not.toContain('SECRET-')
    expect(formatReport(result.report)).toContain('API キー')
  })

  it('世帯を作ったときの初期データ（発送方法 8 行）が、道具の定数と同じ（ずれたら検知する）', async () => {
    const { householdId } = await createHouseholdFor(pg, '定数の確認')
    const rows = (await pg.query<{ name: string; carrier: string | null; fee: number; sort_order: number }>(
      'select name, carrier, fee, sort_order from app.shipping_method where household_id = $1 order by sort_order', [householdId])).rows
    const { INITIAL_SHIPPING_METHODS } = await import('../../../tools/migrate-to-web/spec')
    expect(rows).toEqual(INITIAL_SHIPPING_METHODS.map((m) => ({ ...m })))
  })
})

describe('画像の対応表', () => {
  it('パスは <世帯>/<種類>/<ランダムな uuid>.<拡張子>。レシートだけ receipts、ほかは media', () => {
    const ready = result.images.filter((i) => i.status === 'ready')
    expect(ready.map((i) => `${i.table}.${i.column}`).sort()).toEqual([
      'expense.receipt_file', 'listing.thumb_file', 'product_image.file', 'purchase_line.image_file', 'sale.thumb_file',
    ])
    for (const i of ready) {
      expect(i.path).toMatch(new RegExp(`^${hhA}/(sale|listing|purchase-line|product|receipt)/[0-9a-f-]{36}\\.[a-z0-9]+$`))
      expect(i.bucket).toBe(i.table === 'expense' ? 'receipts' : 'media')
    }
    expect(uploaderA.uploaded.map((u) => `${u.bucket}:${u.path}`).sort()).toEqual(ready.map((i) => `${i.bucket}:${i.path}`).sort())
    expect(uploaderA.uploaded.find((u) => u.path.endsWith('.webp'))?.contentType).toBe('image/webp')
    expect(uploaderA.uploaded.find((u) => u.path.endsWith('.png'))?.contentType).toBe('image/png')
    expect(uploaderA.uploaded.find((u) => u.path.endsWith('.jpeg'))?.contentType).toBe('image/jpeg')
  })

  it('行のパスの列に、対応表の新しいパスが入る。元のファイル名は DB に残らない', async () => {
    const sale = (await pg.query<{ thumb_path: string | null }>(
      "select thumb_path from app.sale where household_id = $1 and channel_item_id = 'm-s1'", [hhA])).rows[0].thumb_path
    expect(sale).toBe(result.images.find((i) => i.table === 'sale')?.path)
    const all = (await pg.query<{ t: string }>(
      `select string_agg(coalesce(thumb_path, ''), ',') as t from (
         select thumb_path from app.sale where household_id = $1 union all select thumb_path from app.listing where household_id = $1) x`, [hhA])).rows[0].t
    expect(all).not.toContain('thumb-s1.jpg')
    expect(all).not.toContain('listing-l1.jpg')
  })

  it('見つからない画像は参照を null にし、件数をレポートに出す（黙って落とさない）', async () => {
    const missing = result.report.images.missing
    expect(missing.map((m) => `${m.table}:${m.sourceFile}`).sort()).toEqual(['listing:listing-gone.jpg', 'product_image:product-gone.webp'])
    const listing = (await pg.query<{ thumb_path: string | null }>(
      "select thumb_path from app.listing where household_id = $1 and channel_item_id = 'm-l2'", [hhA])).rows[0].thumb_path
    expect(listing).toBeNull()
    // 画像が必須の表（product_image）は行ごと移さない。レポートに理由が出る
    expect((await pg.query('select 1 from app.product_image where household_id = $1 and model_code = $2', [hhA, 'A099'])).rows).toHaveLength(0)
    expect((await pg.query('select 1 from app.product_image where household_id = $1 and model_code = $2', [hhA, 'A037'])).rows).toHaveLength(1)
    expect(result.report.notMigrated.some((n) => n.name.startsWith('product_image'))).toBe(true)
    expect(formatReport(result.report)).toContain('見つからなかった画像 2 件')
  })
})

describe('世帯の分離', () => {
  it('A への移行で、同じ DB の世帯 B には 1 行も入らない（B は初期データのまま）', async () => {
    for (const spec of TABLE_SPECS) {
      const n = await countAll(spec.name, hhB)
      const initial = spec.name === 'shipping_method' ? 8 : spec.name === 'setting' ? 9 : 0
      expect(n, spec.name).toBe(initial)
    }
    // B の発送方法は A の id に置き換わっていない（B 自身の初期の行のまま）
    const b = (await pg.query<{ id: string }>('select id from app.shipping_method where household_id = $1', [hhB])).rows.map((r) => r.id)
    const ids = new Set(fx.tables.shipping_method.map((s) => s.id))
    expect(b.some((id) => ids.has(id))).toBe(false)
    // B の画面（B として入った世帯の文脈）から、A のビューが 1 行も見えない
    const seen = await asApi(pg, hhB, async (tx) =>
      (await tx.query<{ n: number }>('select (select count(*) from app.sale_profit)::integer + (select count(*) from app.inventory_view)::integer as n')).rows[0].n)
    expect(seen).toBe(0)
  })

  it('Web 版だけの表（取り込み要求・Push・通知・秘密の値）には触らない', async () => {
    for (const table of [
      'collect_job', 'push_subscription', 'notification_event', 'notification_delivery', 'setting_secret',
      'agent_device', 'collect_job_stage', 'tracking_lease',
    ]) {
      expect(await countAll(table, hhA), table).toBe(0)
    }
  })

  it('B にも見本を移せる（id が違う別の世帯。A の行と混ざらない）', async () => {
    const mapped = remapSnapshot(snapshot(), 'bbbbbbbb')
    const out = await migrateToWeb({
      sql: db(pg), householdId: hhB, snapshot: mapped,
      images: { source: imagesForFixture(fx, IMAGE_FILES), uploader: null }, dryRun: true,
    })
    expect(out.report.ok).toBe(true)
    expect(await countAll('sale', hhB)).toBe(fx.tables.sale.length)
    expect(await countAll('sale', hhA)).toBe(fx.tables.sale.length)
  })
})

describe('断る・巻き戻す', () => {
  it('空でない世帯には断る。何も書かず、画像も送らない', async () => {
    const uploader = recordingUploader()
    const before = await countAll('sale', hhA)
    const err = await migrateToWeb({
      sql: db(pg), householdId: hhA, snapshot: snapshot(), images: { source: imagesForFixture(fx, IMAGE_FILES), uploader },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HouseholdNotEmptyError)
    expect((err as Error).message).toContain('販売')
    expect((err as Error).message).toContain('仕入')
    expect((err as Error).message).toContain('在庫')
    expect(uploader.uploaded).toHaveLength(0)
    expect(await countAll('sale', hhA)).toBe(before)
  })

  it('販売・仕入・在庫でなくても、移す表に 1 行でもあれば断る（タグ 1 件でも）', async () => {
    const { householdId } = await createHouseholdFor(pg, 'タグだけある')
    await pg.query("insert into app.tag (household_id, name) values ($1, 'x')", [householdId])
    const err = await migrateToWeb({
      sql: db(pg), householdId, snapshot: snapshot(), images: { source: imagesForFixture(fx, IMAGE_FILES), uploader: null },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HouseholdNotEmptyError)
    expect((err as Error).message).toContain('タグ 1 件')
  })

  it('Web 版で編集した発送方法を、黙って消さない', async () => {
    const { householdId } = await createHouseholdFor(pg, '発送方法を編集した')
    await pg.query("update app.shipping_method set fee = 999 where household_id = $1 and name = 'ネコポス'", [householdId])
    const err = await migrateToWeb({
      sql: db(pg), householdId, snapshot: snapshot(), images: { source: imagesForFixture(fx, IMAGE_FILES), uploader: null },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HouseholdNotEmptyError)
    expect((err as Error).message).toContain('発送方法')
    expect((await pg.query("select fee from app.shipping_method where household_id = $1 and name = 'ネコポス'", [householdId])).rows[0]).toEqual({ fee: 999 })
  })

  it('存在しない世帯には書かない', async () => {
    const err = await migrateToWeb({
      sql: db(pg), householdId: randomUUID(), snapshot: snapshot(), images: { source: imagesForFixture(fx, IMAGE_FILES), uploader: null },
    }).catch((e: unknown) => e)
    expect((err as Error).message).toContain('世帯が見つかりません')
  })

  it('途中で失敗したら何も残らない：発送方法も設定も元の初期データのまま、置いた画像は片付ける', async () => {
    const { householdId } = await createHouseholdFor(pg, '途中で失敗')
    const snap = remapSnapshot(snapshot())
    // 最後のほうの表（liability_settlement）で外部キー違反を起こす。それまでの表は全部書けている
    snap.tables.liability_settlement = [{ id: T(7), entry_id: randomUUID(), liability_id: snap.tables.liability[0].id, amount: 1 }]
    const uploader = recordingUploader()
    const err = await migrateToWeb({
      sql: db(pg), householdId, snapshot: snap, images: { source: imagesForFixture(fx, IMAGE_FILES), uploader },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('liability_settlement')
    expect((err as Error).message).toContain(T(7)) // どの行かを言う
    for (const spec of TABLE_SPECS) {
      const n = await countAll(spec.name, householdId)
      const initial = spec.name === 'shipping_method' ? 8 : spec.name === 'setting' ? 9 : 0
      expect(n, spec.name).toBe(initial)
    }
    // 初期の発送方法は消えていない（置き換えもロールバックされた）
    expect((await pg.query("select count(*)::integer as n from app.shipping_method where household_id = $1 and name = 'ネコポス' and fee = 210", [householdId])).rows[0]).toEqual({ n: 1 })
    expect((await pg.query("select value from app.setting where household_id = $1 and key = 'fee_rate_bp'", [householdId])).rows[0]).toEqual({ value: '1000' })
    // 画像は先に置いてあった → DB が巻き戻ったので片付ける
    expect(uploader.uploaded.length).toBeGreaterThan(0)
    expect(uploader.removed.flatMap((r) => r.paths).sort()).toEqual(uploader.uploaded.map((u) => u.path).sort())
  })

  it('突き合わせで 1 つでも違えば失敗。巻き戻す（SQLite 側の数字を 1 円ずらしてみる）', async () => {
    const { householdId } = await createHouseholdFor(pg, '突き合わせで失敗')
    const snap = remapSnapshot(snapshot())
    const row = snap.views.sale_profit.find((r) => r.gross_profit !== null) as Row
    row.gross_profit = (row.gross_profit as number) + 1
    const err = await migrateToWeb({
      sql: db(pg), householdId, snapshot: snap, images: { source: imagesForFixture(fx, IMAGE_FILES), uploader: null },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MigrationVerifyError)
    const report = (err as MigrationVerifyError).report
    expect(report.ok).toBe(false)
    expect(report.sums.find((s) => s.name === 'gross_profit')).toMatchObject({ ok: false })
    expect(report.views.find((v) => v.view === 'sale_profit')?.mismatches[0].columns.map((c) => c.column)).toContain('gross_profit')
    expect(formatReport(report)).toContain('不一致')
    for (const t of ['sale', 'purchase', 'inventory_item', 'sale_line']) expect(await countAll(t, householdId)).toBe(0)
  })

  it('在庫コードの採番が移した在庫より小さければ失敗（次に発行する S-xxxx がぶつかる）', async () => {
    const { householdId } = await createHouseholdFor(pg, '採番')
    const snap = remapSnapshot(snapshot())
    snap.tables.setting = snap.tables.setting.map((s) => (s.key === 'item_code_seq' ? { ...s, value: '3' } : s))
    const err = await migrateToWeb({
      sql: db(pg), householdId, snapshot: snap, images: { source: imagesForFixture(fx, IMAGE_FILES), uploader: null },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MigrationVerifyError)
    expect((err as MigrationVerifyError).report.invariants.find((i) => i.name.includes('item_code_seq'))?.ok).toBe(false)
  })

  it('道具が知らない表にデータがあれば、何も触らずに止める', async () => {
    const { householdId } = await createHouseholdFor(pg, '知らない表')
    const snap = snapshot()
    snap.unknownTables = { future_table: 3 }
    const err = await migrateToWeb({
      sql: db(pg), householdId, snapshot: snap, images: { source: imagesForFixture(fx, IMAGE_FILES), uploader: null },
    }).catch((e: unknown) => e)
    expect((err as Error).message).toContain('future_table')
    expect(await countAll('sale', householdId)).toBe(0)
  })

  it('古い schema_version の SQLite は断る', async () => {
    const { householdId } = await createHouseholdFor(pg, '古い')
    const err = await migrateToWeb({
      sql: db(pg), householdId, snapshot: snapshotFromFixture(fx, { schemaVersion: 20 }),
      images: { source: imagesForFixture(fx, IMAGE_FILES), uploader: null },
    }).catch((e: unknown) => e)
    expect((err as Error).message).toContain('schema_version')
  })

  it('Postgres のトリガーが断る引き当て（終了した出品への listing_line）は、書く前に行を言って止める', async () => {
    const { householdId } = await createHouseholdFor(pg, '引き当て')
    const snap = snapshot()
    snap.tables.listing_line = [{ ...snap.tables.listing_line[0], listing_id: 'm-l1' }] // m-l1 は sold の出品
    const err = await migrateToWeb({
      sql: db(pg), householdId, snapshot: snap, images: { source: imagesForFixture(fx, IMAGE_FILES), uploader: null },
    }).catch((e: unknown) => e)
    expect((err as Error).message).toContain('listing_line')
    expect(await countAll('sale', householdId)).toBe(0)
  })

  it('型に合わない値は、表・列・行を言って止める（金額に小数、日付でない文字列）', async () => {
    const { householdId } = await createHouseholdFor(pg, '壊れた値')
    const bad1 = snapshot()
    bad1.tables.sale[0].price = 2500.5
    const e1 = await migrateToWeb({
      sql: db(pg), householdId, snapshot: bad1, images: { source: imagesForFixture(fx, IMAGE_FILES), uploader: null },
    }).catch((e: unknown) => e)
    expect((e1 as Error).message).toContain('sale.price')
    expect((e1 as Error).message).toContain('整数')
    const bad2 = snapshot()
    bad2.tables.sale[0].sold_at = '来週'
    const e2 = await migrateToWeb({
      sql: db(pg), householdId, snapshot: bad2, images: { source: imagesForFixture(fx, IMAGE_FILES), uploader: null },
    }).catch((e: unknown) => e)
    expect((e2 as Error).message).toContain('sale.sold_at')
    expect(await countAll('sale', householdId)).toBe(0)
  })

  it('Postgres に無い列が SQLite に増えていたら、書く前に止める', async () => {
    const { householdId } = await createHouseholdFor(pg, '列が増えた')
    const snap = snapshot()
    snap.tables.sale[0].new_column_in_desktop = 'x'
    const err = await migrateToWeb({
      sql: db(pg), householdId, snapshot: snap, images: { source: imagesForFixture(fx, IMAGE_FILES), uploader: null },
    }).catch((e: unknown) => e)
    expect((err as Error).message).toContain('new_column_in_desktop')
  })
})

describe('dry-run（画像を送らない）', () => {
  it('uploader が無ければ画像は置かず、対応表とレポートは作る', async () => {
    const { householdId } = await createHouseholdFor(pg, 'dry')
    const source = imagesForFixture(fx, IMAGE_FILES)
    const out = await migrateToWeb({
      sql: db(pg), householdId, snapshot: remapSnapshot(snapshot()), images: { source, uploader: null }, dryRun: true,
    })
    expect(out.report.ok).toBe(true)
    expect(out.report.dryRun).toBe(true)
    expect(out.report.images.uploaded).toBe(0)
    expect(out.report.images.ready).toBe(5)
    expect(source.reads).toHaveLength(0) // ファイルの中身も読まない
    expect(formatReport(out.report)).toContain('Storage には送っていません')
  })
})
