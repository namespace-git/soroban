import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createMigratedDb } from '../../test/migrate'
import { asApi, HH_A, seedHouseholds } from '../schema/helpers'

// 「今日」の境界。inventory_view.aging_days（滞留日数）は日本時間の今日で数える：
//   (now() at time zone 'Asia/Tokyo')::date − acquired_at
// UTC の日付で数えると、日本時間の 0:00〜9:00 に 1 日ずれる（このプロジェクトで何度も踏んだ）。
//
// now() を差し替える方法：Postgres の now() は PGlite（WASM）が JS の Date.now() から読むので、
// vitest の偽の時計（Date だけ。タイマーは本物）で任意の時刻に止められる。ビューを「基準日を引数に取る関数」
// にしたり、テストのためだけの設定値（app.today など）を本番のビューに入れたりしなくて済む。
// ビューそのもの（本番と同じ定義）を、時計だけ変えて読む

let db: PGlite

// 取得日。今日との差をいろいろな日で見る（月末・年末・うるう日・未来を含む）
const ACQUIRED = [
  '2026-08-01', '2026-09-30', '2026-10-01', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13',
  '2026-12-31', '2027-01-01', '2028-02-28', '2028-02-29',
]

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
  await asApi(db, HH_A, async (tx) => {
    for (const [i, d] of ACQUIRED.entries()) {
      await tx.query(
        `insert into app.inventory_item (item_code, name, landed_cost, acquired_at) values ($1, $2, 100, $3)`,
        [`S-${String(i + 1).padStart(4, '0')}`, `在庫 ${d}`, d],
      )
    }
  })
})

afterAll(async () => {
  vi.useRealTimers()
  await db.close()
})

/** 'YYYY-MM-DD' 同士の暦の日数差（JS で数える。Postgres とは独立の基準） */
function daysBetween(from: string, to: string): number {
  const ms = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)))
  return Math.round((ms(to) - ms(from)) / 86400000)
}

/** その時刻の日本時間の日付 */
function jstDate(instant: string): string {
  return new Date(new Date(instant).getTime() + 9 * 3600000).toISOString().slice(0, 10)
}

function utcDate(instant: string): string {
  return new Date(instant).toISOString().slice(0, 10)
}

async function agingAt(instant: string): Promise<Map<string, number>> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(instant))
  try {
    const { rows } = await asApi(db, HH_A, (tx) =>
      tx.query<{ acquired_at: string; aging_days: number }>(
        `select to_char(acquired_at, 'YYYY-MM-DD') as acquired_at, aging_days from app.inventory_view`))
    return new Map(rows.map((r) => [r.acquired_at, r.aging_days]))
  } finally {
    vi.useRealTimers()
  }
}

// [時刻(UTC), その時刻の日本時間の日付, 補足]
const INSTANTS: Array<[string, string, string]> = [
  ['2026-10-11T14:59:59Z', '2026-10-11', '日本時間 10/11 23:59:59（日付が変わる 1 秒前）'],
  ['2026-10-11T15:00:00Z', '2026-10-12', '日本時間 10/12 0:00:00（日付が変わった瞬間。UTC はまだ 10/11）'],
  ['2026-10-11T15:30:00Z', '2026-10-12', '日本時間 10/12 0:30（UTC はまだ 10/11）← UTC で数えると 1 日ずれる'],
  ['2026-10-11T23:59:59Z', '2026-10-12', '日本時間 10/12 8:59:59（UTC はまだ 10/11）'],
  ['2026-10-12T00:00:00Z', '2026-10-12', '日本時間 10/12 9:00（UTC も 10/12 になった）'],
  ['2026-10-12T14:59:59Z', '2026-10-12', '日本時間 10/12 23:59:59'],
  ['2026-10-12T15:00:00Z', '2026-10-13', '日本時間 10/13 0:00:00'],
  ['2026-09-30T15:30:00Z', '2026-10-01', '月末→月初：日本時間 10/1 0:30（UTC は 9/30）'],
  ['2026-12-31T15:30:00Z', '2027-01-01', '年末→年始：日本時間 1/1 0:30（UTC は 12/31）'],
  ['2028-02-28T15:30:00Z', '2028-02-29', 'うるう日：日本時間 2/29 0:30（UTC は 2/28）'],
]

// セッションの時刻帯が何であっても同じになること（Supabase は UTC。手元の PGlite は TZ 環境変数に従う）
const ZONES = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Europe/London']

describe('滞留日数は日本時間の「今日」で数える', () => {
  for (const zone of ZONES) {
    describe(`セッションの時刻帯 ${zone}`, () => {
      beforeAll(async () => {
        await db.exec(`set time zone '${zone}'`)
      })

      for (const [instant, today, note] of INSTANTS) {
        it(`${instant}：${note}`, async () => {
          expect(jstDate(instant)).toBe(today) // テストの前提
          const aging = await agingAt(instant)
          for (const acquired of ACQUIRED) {
            expect(aging.get(acquired), `取得日 ${acquired} / 今日 ${today}`).toBe(daysBetween(acquired, today))
          }
        })
      }
    })
  }

  it('境界の時刻は、UTC の日付で数えると実際にずれる（このテストが境界を見分けている裏付け）', () => {
    const [instant, today] = INSTANTS[2]
    expect(utcDate(instant)).not.toBe(today)
    expect(daysBetween('2026-10-10', utcDate(instant))).toBe(1) // UTC の日付で数えると 1 日
    expect(daysBetween('2026-10-10', today)).toBe(2) // 日本時間では 2 日
  })

  it('日本時間 0:30（UTC では前日）に、10/10 取得の在庫は 2 日、10/11 取得は 1 日、10/12 取得は 0 日', async () => {
    await db.exec("set time zone 'UTC'")
    const aging = await agingAt('2026-10-11T15:30:00Z')
    expect(aging.get('2026-10-10')).toBe(2)
    expect(aging.get('2026-10-11')).toBe(1)
    expect(aging.get('2026-10-12')).toBe(0)
    expect(aging.get('2026-10-13')).toBe(-1) // 未来の取得日は負（SQLite の CAST(julianday - julianday AS INTEGER) と同じ）
  })

  it('時計を差し替えない（本物の now()）でも、日本時間の今日で数えている', async () => {
    await db.exec("set time zone 'UTC'")
    const before = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
    const { rows } = await asApi(db, HH_A, (tx) =>
      tx.query<{ acquired_at: string; aging_days: number }>(
        `select to_char(acquired_at, 'YYYY-MM-DD') as acquired_at, aging_days from app.inventory_view`))
    const after = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
    const todays = [...new Set([before, after])]
    for (const r of rows) {
      expect(todays.map((t) => daysBetween(r.acquired_at, t)), `取得日 ${r.acquired_at}`).toContain(r.aging_days)
    }
  })
})
