import { describe, expect, it } from 'vitest'
import { convertValue, parentsFirst } from '../../../tools/migrate-to-web/convert'
import { daysBetween, readInstant, toDateString, toInstant } from '../../../tools/migrate-to-web/dates'
import { assertListingLinesAcceptable, assertSourceUsable } from '../../../tools/migrate-to-web/migrate'
import { skippedSettingReason } from '../../../tools/migrate-to-web/spec'
import type { SourceSnapshot } from '../../../tools/migrate-to-web/types'

// 変換の純粋な部分。process の TZ に依らない（pnpm test:server は TZ=UTC、利用者の PC は日本時間）。
// TZ を変えて回しても同じこと：TZ=Asia/Tokyo / America/Los_Angeles で vitest run しても全部通る

describe('日付（date 列）', () => {
  it('日付はそのまま', () => {
    expect(toDateString('2026-09-05')).toEqual({ value: '2026-09-05', coerced: false })
  })

  it('日本時間の壁時計（T 区切り・zone なし）は、その日付がそのまま日本の日付（Yahoo の listed_at）', () => {
    expect(toDateString('2026-09-05T00:30')).toEqual({ value: '2026-09-05', coerced: true })
    expect(toDateString('2026-09-05T23:59')).toEqual({ value: '2026-09-05', coerced: true })
  })

  it('UTC の日時（datetime(now) / Z つき）は、日本時間に直した日付。UTC の日付をそのまま使うと 0〜9 時で 1 日ずれる', () => {
    expect(toDateString('2026-09-04 15:30:00')).toEqual({ value: '2026-09-05', coerced: true }) // 日本時間では 5 日の 0:30
    expect(toDateString('2026-09-05T14:59:59.000Z')).toEqual({ value: '2026-09-05', coerced: true })
    expect(toDateString('2026-09-05T15:00:00.000Z')).toEqual({ value: '2026-09-06', coerced: true })
    expect(toDateString('2026-09-05T09:00:00+09:00')).toEqual({ value: '2026-09-05', coerced: true })
    expect(toDateString('2026-12-31T15:00:00Z')).toEqual({ value: '2027-01-01', coerced: true }) // 年またぎ
  })

  it('実在しない日付・読めない形は null（呼び出し側が止める）', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '来週', '', '2026/09/05', '2026-09-05T25:00']) {
      expect(toDateString(bad), bad).toBeNull()
    }
  })
})

describe('日時（timestamptz 列）', () => {
  it('zone つきの ISO と datetime(now)（UTC）はそのまま UTC の ISO。想定どおりの形なので coerced = false', () => {
    expect(toInstant('2026-10-11T17:06:57.123Z')).toEqual({ value: '2026-10-11T17:06:57.123Z', coerced: false })
    expect(toInstant('2026-10-11 17:06:57')).toEqual({ value: '2026-10-11T17:06:57.000Z', coerced: false })
    expect(toInstant('2026-10-12T02:06:57+09:00')).toEqual({ value: '2026-10-11T17:06:57.000Z', coerced: false })
    expect(toInstant('2026-10-12T02:06:57+0900')).toEqual({ value: '2026-10-11T17:06:57.000Z', coerced: false })
  })

  it('zone の無い T 区切り（purchased_at）は日本時間。日付だけの行は、その日の 0:00（日本時間）', () => {
    expect(toInstant('2026-09-30T00:00')).toEqual({ value: '2026-09-29T15:00:00.000Z', coerced: true })
    expect(toInstant('2026-09-30T10:05')).toEqual({ value: '2026-09-30T01:05:00.000Z', coerced: true })
    expect(toInstant('2026-09-30')).toEqual({ value: '2026-09-29T15:00:00.000Z', coerced: true })
  })

  it('Postgres が返す形（マイクロ秒・+00:00・+09:00）を読み戻せる', () => {
    expect(readInstant('2026-10-11T17:06:57.123456+00:00')).toBe('2026-10-11T17:06:57.123Z')
    expect(readInstant('2026-10-12T02:06:57+09:00')).toBe('2026-10-11T17:06:57.000Z')
  })

  it('読めない形・実在しない日時は null', () => {
    for (const bad of ['', 'あした', '2026-02-30 00:00:00', '2026-10-11 25:00:00', '2026-10-11T17:06:57+99']) {
      expect(toInstant(bad) ?? null, bad).toBeNull()
    }
  })

  it('日数の差は日付だけで数える（時刻帯に依らない）', () => {
    expect(daysBetween('2026-10-12', '2026-10-09')).toBe(3)
    expect(daysBetween('2027-01-01', '2026-12-31')).toBe(1)
    expect(daysBetween('2026-03-01', '2026-02-28')).toBe(1)
  })
})

const info = (type: string, nullable = false): { type: string; nullable: boolean } => ({ type, nullable })
const noNote = (): void => {}

describe('値の変換（型に合わなければ、表・列・行を言って止める）', () => {
  const conv = (type: string, raw: unknown, nullable = false): unknown => convertValue('sale', 'col', info(type, nullable), raw, 'row-1', noNote)

  it('金額は円の整数。小数・文字列は止める（丸めて入れない）', () => {
    expect(conv('integer', 2500)).toBe(2500)
    expect(conv('integer', -300)).toBe(-300)
    expect(() => conv('integer', 2500.5)).toThrow(/sale\.col（row-1）が整数ではありません/)
    expect(() => conv('integer', '2500')).toThrow(/整数ではありません/)
    expect(() => conv('integer', Number.NaN)).toThrow(/整数ではありません/)
  })

  it('空は、null を許す列なら null、許さない列なら止める', () => {
    expect(conv('text', null, true)).toBeNull()
    expect(() => conv('text', null, false)).toThrow(/必須の列/)
  })

  it('uuid は小文字にそろえる。形が違えば止める。空文字は null を許す列でだけ null', () => {
    expect(conv('uuid', 'ABCDEF01-0000-4000-8000-000000000001')).toBe('abcdef01-0000-4000-8000-000000000001')
    expect(() => conv('uuid', 'sm_neko')).toThrow(/uuid の形ではありません/)
    expect(conv('uuid', '', true)).toBeNull()
    expect(() => conv('uuid', '', false)).toThrow(/uuid の形ではありません/)
  })

  it('日付・日時が読めなければ、形（数字を 9 にしたもの）だけを言って止める。中身は出さない', () => {
    expect(conv('date', '2026-09-05T10:00')).toBe('2026-09-05')
    expect(conv('timestamp with time zone', '2026-09-05 01:02:03')).toBe('2026-09-05T01:02:03.000Z')
    expect(() => conv('date', '2026年9月5日')).toThrow(/日付ではありません: 9999年9月9日/)
    expect(() => conv('timestamp with time zone', '昨日')).toThrow(/日時ではありません/)
  })

  it('model_codes（JSON の文字列）は配列に。配列でなければ止める', () => {
    expect(conv('ARRAY', '["A037","Z100-1"]')).toEqual(['A037', 'Z100-1'])
    expect(conv('ARRAY', '[]')).toEqual([])
    expect(() => conv('ARRAY', '{"a":1}')).toThrow(/文字列の配列ではありません/)
    expect(() => conv('ARRAY', 'A037')).toThrow(/JSON として読めません/)
  })

  it('raw（JSON の文字列）はそのまま JSON に。読めない文字列は捨てずに JSON の文字列として残し、件数を数える', () => {
    const notes: string[] = []
    const json = convertValue('sale', 'raw', info('jsonb', true), '{"a": 1}', 'r', (k) => notes.push(k))
    expect(json).toBe('{"a":1}')
    const broken = convertValue('sale', 'raw', info('jsonb', true), 'not json', 'r', (k) => notes.push(k))
    expect(JSON.parse(broken as string)).toBe('not json')
    expect(notes).toHaveLength(1)
  })

  it('NUL 文字（Postgres の text に入らない）は、入れる前に止める', () => {
    expect(() => conv('text', 'a\u0000b')).toThrow(/NUL 文字/)
    expect(() => conv('jsonb', '{"a":"x\\u0000y"}')).toThrow(/NUL 文字/)
  })

  it('知らない列の型は止める（黙って文字列にしない）', () => {
    expect(() => conv('numeric', 1)).toThrow(/想定していない列の型/)
  })
})

describe('在庫を親から先に並べる（分割した子は親を指す外部キー）', () => {
  it('孫がいても、親 → 子 → 孫の順。同じ深さの中は元の順', () => {
    const rows = [
      { id: 'c2', parent_id: 'p' },
      { id: 'g', parent_id: 'c1' },
      { id: 'c1', parent_id: 'p' },
      { id: 'x', parent_id: null },
      { id: 'p', parent_id: null },
    ]
    expect(parentsFirst(rows).map((r) => r.id)).toEqual(['x', 'p', 'c2', 'c1', 'g'])
  })

  it('循環していたら止める', () => {
    expect(() => parentsFirst([{ id: 'a', parent_id: 'b' }, { id: 'b', parent_id: 'a' }])).toThrow(/循環/)
  })
})

describe('移行元の確認', () => {
  const base = (): SourceSnapshot => ({
    tables: {}, views: {} as SourceSnapshot['views'], skippedTables: {}, unknownTables: {}, schemaVersion: 34,
  })

  it('知らない表に行があれば止める。行が無ければ構わない', () => {
    expect(() => assertSourceUsable({ ...base(), unknownTables: { future: 0 } })).not.toThrow()
    expect(() => assertSourceUsable({ ...base(), unknownTables: { future: 2 } })).toThrow(/future（2 行）/)
  })

  it('schema_version が読めない・古いときは止める', () => {
    expect(() => assertSourceUsable({ ...base(), schemaVersion: null })).toThrow(/schema_version/)
    expect(() => assertSourceUsable({ ...base(), schemaVersion: 33 })).toThrow(/古すぎます/)
    expect(() => assertSourceUsable({ ...base(), schemaVersion: 35 })).not.toThrow()
  })

  it('引き当て：同じ在庫が 2 つの引き当てに入っている・販売済みの在庫・終わった出品は、行を言って止める', () => {
    const ok = {
      listing: [{ mercari_item_id: 'a', status: 'active' }, { mercari_item_id: 'b', status: 'suspended' }],
      inventory_item: [{ id: 'i1', status: 'in_stock' }, { id: 'i2', status: 'in_stock' }],
      listing_line: [{ id: 'l1', listing_id: 'a', inventory_item_id: 'i1' }, { id: 'l2', listing_id: 'b', inventory_item_id: 'i2' }],
    }
    expect(() => assertListingLinesAcceptable({ tables: ok })).not.toThrow()
    expect(() => assertListingLinesAcceptable({
      tables: { ...ok, listing_line: [...ok.listing_line, { id: 'l3', listing_id: 'b', inventory_item_id: 'i1' }] },
    })).toThrow(/l3: 同じ在庫が l1 にも/)
    expect(() => assertListingLinesAcceptable({
      tables: { ...ok, inventory_item: [{ id: 'i1', status: 'sold' }, { id: 'i2', status: 'in_stock' }] },
    })).toThrow(/l1: 未販売でない在庫/)
    expect(() => assertListingLinesAcceptable({
      tables: { ...ok, listing: [{ mercari_item_id: 'a', status: 'sold' }, { mercari_item_id: 'b', status: 'active' }] },
    })).toThrow(/l1: 終了した出品/)
  })
})

describe('移さない設定', () => {
  it('schema_version・*_enc（API キー）・auto_backup* は移さない。ほかは移す', () => {
    for (const key of ['schema_version', 'gemini_api_key_enc', 'track17_api_key_enc', 'any_future_secret_enc', 'auto_backup', 'auto_backup_last_at']) {
      expect(skippedSettingReason(key), key).not.toBeNull()
    }
    for (const key of ['fee_rate_bp', 'item_code_seq', 'ai_model', 'collect_show_window', 'snooze:manual_purchase:-', 'mellojoy_image_cursor:x', 'mercari_keyword']) {
      expect(skippedSettingReason(key), key).toBeNull()
    }
  })
})
