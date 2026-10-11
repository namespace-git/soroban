import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createMigratedDb } from '../../test/migrate'
import { asApi, HH_A, HH_B, seedHouseholds } from '../schema/helpers'
import {
  evenly, loadFixture, loadFixtureInto, mapIds, normalizePg, normalizeSqlite, readView, remapUuid, sortRows,
  VIEW_NAMES, type Row, type ViewName,
} from './helpers'

// 金額のビュー 5 本が、SQLite（いまの帳簿）と 1 円も違わない数字を出すことの確認。
// 期待値（fixtures/expected.json）は SQLite に db.ts の関数で見本を入れて書き出したもの。
// 同じ行を同じ id で Postgres に入れ、ビューを読んで完全一致を見る。
// 世帯 A に見本そのまま、世帯 B に id だけ写した同じ見本を入れる：
// ビューが世帯をまたいで混ざれば（RLS が効かなければ）合計が倍になって一致しない

const fx = loadFixture()
let db: PGlite

const households = [
  { label: '世帯A（見本そのまま）', id: HH_A, remap: null },
  { label: '世帯B（同じ見本・id だけ別）', id: HH_B, remap: remapUuid },
] as const

beforeAll(async () => {
  db = await createMigratedDb()
  // Supabase の既定と同じ UTC のセッション。日本時間の「今日」がセッションの時刻帯に頼っていないことの前提
  await db.exec("set time zone 'UTC'")
  await seedHouseholds(db)
  await loadFixtureInto(db, HH_A, fx)
  await loadFixtureInto(db, HH_B, fx, remapUuid)
})

afterAll(async () => {
  await db.close()
})

/** inventory_view の滞留日数は「今日」で変わるので、期待値を書き出した日の正午（日本時間）に時計を止めて読む */
async function readAt(householdId: string, view: ViewName): Promise<Row[]> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${fx.generated_on}T03:00:00Z`))
  try {
    return await asApi(db, householdId, (tx) => readView(tx, view))
  } finally {
    vi.useRealTimers()
  }
}

function expectedFor(view: ViewName, remap: ((s: string) => string) | null): Row[] {
  const rows = normalizeSqlite(view, fx.views[view])
  return remap ? mapIds(rows, remap) : rows
}

describe('見本が想定どおりの中身である（作り直したときに網羅が減らない）', () => {
  const sp = fx.views.sale_profit as Array<Record<string, any>>
  const iv = fx.views.inventory_view as Array<Record<string, any>>

  it('仕入：3 件以上。送料・その他費用・割引があり、金額按分と数量按分の両方', () => {
    const p = fx.tables.purchase as Array<Record<string, any>>
    expect(p.length).toBeGreaterThanOrEqual(3)
    expect(p.some((x) => x.shipping_fee > 0 && x.other_cost > 0 && x.discount > 0 && x.alloc_method === 'by_amount')).toBe(true)
    expect(p.some((x) => x.shipping_fee > 0 && x.other_cost > 0 && x.discount > 0 && x.alloc_method === 'by_quantity')).toBe(true)
    expect(p.some((x) => x.discount > 0 && x.shipping_fee === 0 && x.other_cost === 0)).toBe(true)
  })

  it('在庫：すべての状態と、分割（親子・孫）、出品の引き当て（出品中・停止中）', () => {
    expect(new Set(iv.map((x) => x.status))).toEqual(new Set(['in_stock', 'sold', 'split', 'disposed', 'personal_use']))
    const children = iv.filter((x) => x.parent_id)
    expect(children.length).toBeGreaterThanOrEqual(5)
    // 孫（親も子）がいる
    expect(children.some((c) => iv.find((p) => p.id === c.parent_id)?.parent_id)).toBe(true)
    expect(new Set(iv.map((x) => x.listing_status).filter(Boolean))).toEqual(new Set(['active', 'suspended']))
  })

  it('販売：完了・未完了・手入力・私物・Yahoo・まとめ売り・送料確定/未確定・梱包材・未紐付け・自動/引き継ぎ', () => {
    expect(sp.some((x) => x.status === 'completed' && x.source === 'collector')).toBe(true)
    expect(sp.some((x) => x.status !== 'completed' && x.status !== null)).toBe(true) // 見込み
    expect(sp.some((x) => x.status === null && x.source === 'collector')).toBe(true) // 状態なしの取り込み（見込み）
    expect(sp.some((x) => x.status === null && x.source === 'manual')).toBe(true) // 手入力（実績）
    expect(sp.some((x) => x.kind === 'personal')).toBe(true)
    expect(sp.some((x) => x.channel === 'yahoo')).toBe(true)
    expect(sp.some((x) => x.is_shipping_confirmed === 0)).toBe(true)
    expect(sp.some((x) => x.is_shipping_confirmed === 1)).toBe(true)
    expect(sp.some((x) => x.packaging_cost > 0)).toBe(true)
    expect(sp.some((x) => x.unmatched === 1 && x.item_count === 0)).toBe(true)
    expect(sp.some((x) => x.unmatched === 1 && x.item_count > 0)).toBe(true) // 見積もった点数に届いていない
    expect(sp.some((x) => x.auto_linked === 1)).toBe(true)
    // まとめ売り 3 点で、価格に端数が出るもの・粗利が負で端数が出るもの
    const bundle3 = sp.filter((x) => x.item_count === 3)
    expect(bundle3.some((x) => x.price % 3 !== 0)).toBe(true)
    expect(bundle3.some((x) => x.gross_profit < 0 && x.gross_profit % 3 !== 0)).toBe(true)
    expect(sp.some((x) => x.mercari_item_id === 'm-s14' && x.price === 1001 && x.item_count === 3)).toBe(true)
    expect(sp.some((x) => x.thumb_file)).toBe(true)
  })

  it('月をまたぐ販売：9 月に購入され、10 月に完了して 10 月に計上されている', () => {
    const crossed = sp.filter((x) => x.purchased_at && x.sold_at.slice(0, 7) > String(x.purchased_at).slice(0, 7))
    expect(crossed.length).toBeGreaterThanOrEqual(1)
    expect(crossed.some((x) => x.status === 'completed')).toBe(true)
    const months = (fx.views.monthly_summary as Array<Record<string, any>>).map((x) => x.month)
    expect(new Set(months)).toEqual(new Set(['2026-09', '2026-10']))
  })

  it('経費・月の按分と締め：テーブルとして入っている', () => {
    expect((fx.tables.expense ?? []).length).toBeGreaterThanOrEqual(2)
    expect((fx.tables.expense_line ?? []).length).toBeGreaterThanOrEqual(1)
    const mb = fx.tables.month_book as Array<Record<string, any>>
    expect(mb.some((x) => x.alloc_method === 'by_quantity' && x.closed_at)).toBe(true)
  })

  it('sale_line は SQLite の rowid 順（紐付けた順）に並んでいる：まとめ売りの紐付けが在庫の並びと違う', () => {
    const lines = fx.tables.sale_line as Array<Record<string, any>>
    const items = fx.tables.inventory_item as Array<Record<string, any>>
    const rank = new Map(items.map((i, n) => [i.id, n]))
    const bySale = new Map<string, number[]>()
    for (const l of lines) bySale.set(l.sale_id, [...(bySale.get(l.sale_id) ?? []), rank.get(l.inventory_item_id)!])
    const bundles = [...bySale.values()].filter((v) => v.length >= 3)
    expect(bundles.length).toBeGreaterThanOrEqual(3)
    // 在庫の並びと違う順で紐付けたまとめ売りがある（端数をどの行に寄せるかが rowid 順に依存する）
    expect(bundles.some((v) => v.some((x, i) => i > 0 && x < v[i - 1]))).toBe(true)
  })
})

describe('Postgres のビューの出力が SQLite と完全に一致する', () => {
  const report: string[] = []

  for (const h of households) {
    for (const view of VIEW_NAMES) {
      it(`${view}：${h.label}`, async () => {
        const pg = sortRows(view, normalizePg(view, await readAt(h.id, view), h.id))
        const expected = sortRows(view, expectedFor(view, h.remap))
        const columns = Object.keys(expected[0]).length

        expect(pg.length).toBe(expected.length)
        // 列の集合が同じ（足りない列も余計な列も無い）
        expect(Object.keys(pg[0]).sort()).toEqual(Object.keys(expected[0]).sort())
        // 全行・全列が一致（値の型も：数は number、日付は文字列、null は null）
        expect(pg).toEqual(expected)

        report.push(`${h.label} ${view}: ${expected.length} 行 × ${columns} 列 = ${expected.length * columns} セル 一致`)
      })
    }
  }

  afterAll(() => {
    console.log(`\n[パリティ] 見本=${fx.generated_on} 生成, SQLite ${fx.sqlite_version}\n${report.join('\n')}`)
  })
})

describe('見本の手計算（期待値の書き出しに頼らない確認）', () => {
  /** channel_item_id の販売の 1 点あたりの按分を、紐付けた順（allocation_order）に返す */
  async function sharesOf(itemId: string): Promise<{ price: number[]; profit: number[]; salePrice: number; grossProfit: number }> {
    return asApi(db, HH_A, async (tx) => {
      const s = await tx.query<{ id: string; price: number; gross_profit: number }>(
        'select id, price, gross_profit from app.sale_profit where channel_item_id = $1', [itemId])
      const r = await tx.query<{ price_share: number; profit_share: number }>(
        `select sls.price_share, sls.profit_share
           from app.sale_line_share sls
           join app.sale_line sl on sl.id = sls.sale_line_id
          where sls.sale_id = $1 order by sl.allocation_order`, [s.rows[0].id])
      return {
        price: r.rows.map((x) => x.price_share), profit: r.rows.map((x) => x.profit_share),
        salePrice: s.rows[0].price, grossProfit: s.rows[0].gross_profit,
      }
    })
  }

  it('1,001 円のまとめ売り 3 点は 333/334/334（余りは末尾の行に）。合計は 1,001 円', async () => {
    const r = await sharesOf('m-s14')
    expect(r.salePrice).toBe(1001)
    expect(r.price).toEqual([333, 334, 334])
    expect(r.price.reduce((a, b) => a + b, 0)).toBe(1001)
    expect(r.profit.reduce((a, b) => a + b, 0)).toBe(r.grossProfit)
  })

  it('10,001 円のまとめ売り 3 点は 3333/3334/3334', async () => {
    const r = await sharesOf('m-s2')
    expect(r.price).toEqual([3333, 3334, 3334])
  })

  it('粗利が負で端数の出るまとめ売り：床の割り算で、余りは末尾の行へ。合計は粗利と一致', async () => {
    const r = await sharesOf('m-s3')
    expect(r.salePrice).toBe(3500)
    expect(r.price).toEqual([1166, 1167, 1167])
    // 見本の原価からの粗利。赤字で、3 で割り切れない（-2038 ÷ 3 → -680/-679/-679）
    expect(r.grossProfit).toBe(-2038)
    expect(r.profit).toEqual([-680, -679, -679])
    expect(r.profit).toEqual(evenly(r.grossProfit, 3))
    expect(r.profit.reduce((a, b) => a + b, 0)).toBe(-2038)
  })

  it('全部の販売で、1 点あたりの合計が 価格 / 粗利 と一致する', async () => {
    const rows = await asApi(db, HH_A, async (tx) =>
      (await tx.query<{ id: string; price: number; gross_profit: number; sp: number; pf: number }>(
        `select p.id, p.price, p.gross_profit,
                sum(s.price_share)::integer as sp, sum(s.profit_share)::integer as pf
           from app.sale_profit p join app.sale_line_share s on s.sale_id = p.id
          group by p.id, p.price, p.gross_profit`)).rows)
    expect(rows.length).toBeGreaterThan(10)
    for (const r of rows) {
      expect(r.sp, `価格 ${r.id}`).toBe(r.price)
      expect(r.pf, `粗利 ${r.id}`).toBe(r.gross_profit)
    }
  })

  it('月次は実績だけ：見込み（発送待ち・発送済み・状態なしの取り込み）は入らない。売上の合計を手で足して一致', async () => {
    const r = await asApi(db, HH_A, async (tx) => {
      const sales = (await tx.query<{ price: number; gross_profit: number; sold_at: string; kind: string; status: string | null; source: string }>(
        `select price, gross_profit, to_char(sold_at, 'YYYY-MM-DD') as sold_at, kind, status, source from app.sale_profit`)).rows
      const monthly = (await tx.query<{ month: string; kind: string; revenue: number; gross_profit: number; sales_count: number }>(
        'select month, kind, revenue, gross_profit, sales_count from app.monthly_summary')).rows
      return { sales, monthly }
    })
    const realized = r.sales.filter((s) => s.status === 'completed' || (s.source === 'manual' && s.status === null))
    expect(realized.length).toBeLessThan(r.sales.length)
    for (const m of r.monthly) {
      const mine = realized.filter((s) => s.sold_at.slice(0, 7) === m.month && s.kind === m.kind)
      expect(m.sales_count).toBe(mine.length)
      expect(m.revenue).toBe(mine.reduce((a, s) => a + s.price, 0))
      expect(m.gross_profit).toBe(mine.reduce((a, s) => a + s.gross_profit, 0))
    }
    expect(r.monthly.reduce((a, m) => a + m.sales_count, 0)).toBe(realized.length)
  })

  it('平均がちょうど .5 の型番は 0 から遠い方へ丸める：価格 1000.5 → 1001、粗利 -1200.5 → -1201（偶数丸めなら 1000 / -1200）', async () => {
    const r = await asApi(db, HH_A, async (tx) =>
      (await tx.query<{ avg_price: number; avg_profit: number }>(
        `select avg_price, avg_profit from app.variant_summary where model_code = 'J700'`)).rows[0])
    expect(r).toEqual({ avg_price: 1001, avg_profit: -1201 })
  })

  it('月またぎ：9/30 に購入・10/2 に完了した販売は 10 月に計上される（購入日時は 9/30 の日本時間のまま）', async () => {
    const r = await asApi(db, HH_A, async (tx) =>
      (await tx.query<{ sold_at: string; completed_at: string; purchased_at: string }>(
        `select to_char(sold_at, 'YYYY-MM-DD') as sold_at, to_char(completed_at, 'YYYY-MM-DD') as completed_at,
                to_char(purchased_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') as purchased_at
           from app.sale_profit where channel_item_id = 'm-s8'`)).rows[0])
    expect(r).toEqual({ sold_at: '2026-10-02', completed_at: '2026-10-02', purchased_at: '2026-09-30 00:00' })
  })
})
