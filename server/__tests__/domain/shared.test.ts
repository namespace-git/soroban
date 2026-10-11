import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import { mediaBaseFromEnv } from '../../context'
import { UserError } from '../../errors'
import { dispatch } from '../../rpc'
import * as money from '../../../src/main/money'
import type { SearchHit, Tag } from '../../../src/shared/types'
import {
  MAX_INT4, allocate, argArray, argBool, argDate, argEnum, argFlag, argId, argIds, argInt, argMonth, argNullableDate,
  argNullableEnum, argNullableId, argNullableInt, argNullableMonth, argNullableText, argNullableYen, argObject, argOptArray,
  argOptBool, argOptDate, argOptEnum, argOptFlag, argOptId, argOptInt, argOptMonth, argOptObject, argOptText, argOptYen,
  argText, argYen, assertDateText, assertMonthText, assertPositiveYen, assertQty, assertTagsExist, assertYen, isUuid,
  keywordsFor, loadTagsFor, matchesAnyKeyword, matchesQuery, mediaUrl, mergeInheritedTags, monthBounds, nowIso,
  normalizeName, normalizeSearchText, parseKeywords, rowsToCsv, setting, settingStr, sortAndSlice, splitEvenly,
  subtractDaysJst, thisMonthJst, todayJst, toolShareAmount, trimOrNull, yenText,
} from '../../domain/_shared'
import { createTag } from '../../domain/master'
import { MEDIA_BASE, SUPABASE_URL, newWorld, openDomainDb, type DomainDb, type World } from './helpers'

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const A = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)

/** UserError（400）になること。メッセージの一部も確かめる */
const userError = (fn: () => unknown, message?: string, code: UserError['code'] = 'bad_request') => {
  let thrown: unknown
  try {
    fn()
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeInstanceOf(UserError)
  expect((thrown as UserError).code).toBe(code)
  if (message) expect((thrown as UserError).message).toContain(message)
}

describe('文字・検索', () => {
  it('normalizeName：記号と空白を落として小文字にする', () => {
    expect(normalizeName('【A037】 もこ山 スクイーズ（大）')).toBe('a037もこ山スクイーズ大')
    expect(normalizeName('A-1 / B・C、D。')).toBe('a-1bcd')
    expect(normalizeName('　全角　空白　')).toBe('全角空白')
  })

  it('normalizeSearchText / matchesQuery：NFKC・小文字・空白区切り AND', () => {
    expect(normalizeSearchText('ＡＢＣ１２３')).toBe('abc123')
    expect(normalizeSearchText('ﾓｺ山')).toBe('モコ山')
    expect(matchesQuery(['もこ山 スクイーズ', null, undefined], ['もこ', 'スクイ'])).toBe(true)
    expect(matchesQuery(['もこ山'], ['もこ', 'ぷに'])).toBe(false)
    // 語ごとに別の項目に当たってもよい
    expect(matchesQuery(['もこ山', 'A037'], ['もこ', 'a037'])).toBe(true)
    expect(matchesQuery([], [])).toBe(true)
    expect(matchesQuery([null], ['x'])).toBe(false)
  })

  it('sortAndSlice：date の新しい順に並べて、上限で切る', () => {
    const hit = (id: string, date: string): SearchHit => ({
      kind: 'sale', id, title: id, model_code: null, status_label: '', amount: 0, date, thumb_url: null,
    })
    const out = sortAndSlice([hit('a', '2026-01-01'), hit('c', '2026-03-01'), hit('b', '2026-02-01')], 2)
    expect(out.map(h => h.id)).toEqual(['c', 'b'])
  })
})

describe('日付（日本時間）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('todayJst：UTC の 15:00〜23:59 は、日本ではもう翌日', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const at = (iso: string) => {
      vi.setSystemTime(new Date(iso))
      return { today: todayJst(), month: thisMonthJst() }
    }
    expect(at('2026-10-12T00:00:00Z')).toEqual({ today: '2026-10-12', month: '2026-10' })
    expect(at('2026-10-12T14:59:59.999Z')).toEqual({ today: '2026-10-12', month: '2026-10' })
    expect(at('2026-10-12T15:00:00Z')).toEqual({ today: '2026-10-13', month: '2026-10' })
    expect(at('2026-10-12T23:59:59Z')).toEqual({ today: '2026-10-13', month: '2026-10' })
    // 月末・年末をまたぐ
    expect(at('2026-10-31T15:00:00Z')).toEqual({ today: '2026-11-01', month: '2026-11' })
    expect(at('2026-12-31T14:59:00Z')).toEqual({ today: '2026-12-31', month: '2026-12' })
    expect(at('2026-12-31T15:00:00Z')).toEqual({ today: '2027-01-01', month: '2027-01' })
    // うるう日
    expect(at('2028-02-28T15:00:00Z')).toEqual({ today: '2028-02-29', month: '2028-02' })
    expect(at('2027-02-28T15:00:00Z')).toEqual({ today: '2027-03-01', month: '2027-03' })
  })

  it('todayJst は時計を渡せる。プロセスのタイムゾーン（TZ）に依らない', () => {
    const instant = new Date('2026-10-12T15:00:00Z')
    const original = process.env.TZ
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Auckland']) {
        process.env.TZ = tz
        expect(todayJst(instant), tz).toBe('2026-10-13')
        expect(thisMonthJst(instant), tz).toBe('2026-10')
        expect(todayJst(new Date('2026-10-12T14:59:59Z')), tz).toBe('2026-10-12')
      }
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })

  it('nowIso：UTC の ISO 文字列（timestamptz に入れる形）', () => {
    expect(nowIso(new Date('2026-10-12T15:04:05.678Z'))).toBe('2026-10-12T15:04:05.678Z')
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('subtractDaysJst：暦の計算（月・年・うるう年をまたぐ。0 日は同じ日。負の日数は後の日付）', () => {
    expect(subtractDaysJst('2026-10-12', 0)).toBe('2026-10-12')
    expect(subtractDaysJst('2026-10-12', 1)).toBe('2026-10-11')
    expect(subtractDaysJst('2026-10-01', 1)).toBe('2026-09-30')
    expect(subtractDaysJst('2026-01-01', 1)).toBe('2025-12-31')
    expect(subtractDaysJst('2028-03-01', 1)).toBe('2028-02-29')
    expect(subtractDaysJst('2027-03-01', 1)).toBe('2027-02-28')
    expect(subtractDaysJst('2026-10-12', 90)).toBe('2026-07-14')
    expect(subtractDaysJst('2026-10-12', 365)).toBe('2025-10-12')
    expect(subtractDaysJst('2026-10-12', -20)).toBe('2026-11-01')
    userError(() => subtractDaysJst('2026-02-30', 1), 'YYYY-MM-DD')
    userError(() => subtractDaysJst('20261012', 1), 'YYYY-MM-DD')
    userError(() => subtractDaysJst('2026-10-12', 1.5), '整数')
    userError(() => subtractDaysJst('2026-10-12', Number.NaN), '整数')
  })

  it('monthBounds：月の最初と最後の日（2 月・うるう年・31 日の月）', () => {
    expect(monthBounds('2026-10')).toEqual({ start: '2026-10-01', end: '2026-10-31' })
    expect(monthBounds('2026-11')).toEqual({ start: '2026-11-01', end: '2026-11-30' })
    expect(monthBounds('2027-02')).toEqual({ start: '2027-02-01', end: '2027-02-28' })
    expect(monthBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' })
    expect(monthBounds('2100-02')).toEqual({ start: '2100-02-01', end: '2100-02-28' })
    expect(monthBounds('2000-02')).toEqual({ start: '2000-02-01', end: '2000-02-29' })
    userError(() => monthBounds('2026-13'), 'YYYY-MM')
  })
})

describe('入力・金額', () => {
  it('yenText：桁区切り（Intl に頼らない）', () => {
    expect(yenText(0)).toBe('¥0')
    expect(yenText(999)).toBe('¥999')
    expect(yenText(1000)).toBe('¥1,000')
    expect(yenText(2699)).toBe('¥2,699')
    expect(yenText(161505)).toBe('¥161,505')
    expect(yenText(1234567890)).toBe('¥1,234,567,890')
    // デスクトップ版の toLocaleString('ja-JP') と同じ並び
    expect(yenText(-1000)).toBe('¥-1,000')
    for (const n of [0, 7, 100, 1000, 12345, 987654, 1000000, 2147483647, -5, -123456]) {
      expect(yenText(n), String(n)).toBe(`¥${n.toLocaleString('ja-JP')}`)
    }
  })

  it('assertYen：安全な整数で 0 以上（money.ts と同じ文言）。integer 列に入らない大きさは断る', () => {
    expect(() => assertYen('料金', 0)).not.toThrow()
    expect(() => assertYen('料金', MAX_INT4)).not.toThrow()
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '100', null, undefined, {}, [], true]) {
      userError(() => assertYen('料金', bad), '料金は整数で入力してください')
    }
    userError(() => assertYen('料金', MAX_INT4 + 1), '大きすぎます')
    userError(() => assertYen('料金', Number.MAX_SAFE_INTEGER + 2), '整数で入力')
    // money.ts の素の Error と同じ文言（デスクトップ版のテストの期待値）
    expect(() => money.assertYen('料金', 1.5)).toThrow('料金は整数で入力してください')
  })

  it('assertQty：1 以上の整数', () => {
    expect(() => assertQty('数量', 1)).not.toThrow()
    for (const bad of [0, -1, 1.5, '1', null, undefined]) userError(() => assertQty('数量', bad), '数量は1以上の整数で入力してください')
    userError(() => assertQty('数量', MAX_INT4 + 1), '大きすぎます')
  })

  it('assertPositiveYen：1 円以上', () => {
    expect(() => assertPositiveYen('金額', 1)).not.toThrow()
    userError(() => assertPositiveYen('金額', 0), '1円以上')
    userError(() => assertPositiveYen('金額', -5), '整数')
    userError(() => assertPositiveYen('金額', 10.5), '整数')
    userError(() => assertPositiveYen('金額', '10'), '整数')
  })

  it('assertDateText：実在する YYYY-MM-DD だけ', () => {
    for (const ok of ['2026-10-12', '2028-02-29', '2000-02-29', '0100-01-01']) expect(() => assertDateText('日付', ok), ok).not.toThrow()
    for (const bad of ['2026-9-5', '2026-02-30', '2027-02-29', '2100-02-29', '2026-13-01', '2026-00-10', '20261012', '2026-10-12T00:00', ' 2026-10-12', '', 20261012, null, undefined, {}]) {
      userError(() => assertDateText('日付', bad), '日付はYYYY-MM-DDの形式で入力してください')
    }
  })

  it('assertMonthText：YYYY-MM（1900 年以降）', () => {
    for (const ok of ['2026-01', '2026-12', '1900-01']) expect(() => assertMonthText('月', ok), ok).not.toThrow()
    for (const bad of ['2026-13', '2026-00', '2026-1', '202610', '2026-10-01', '0000-05', '1899-12', '', 202610, null, undefined]) {
      userError(() => assertMonthText('月', bad), '月はYYYY-MMの形式で入力してください')
    }
  })

  it('trimOrNull', () => {
    expect(trimOrNull('  メモ ')).toBe('メモ')
    expect(trimOrNull('   ')).toBeNull()
    expect(trimOrNull('')).toBeNull()
    expect(trimOrNull(null)).toBeNull()
    expect(trimOrNull(undefined)).toBeNull()
  })

  it('toolShareAmount：floor(粗利 × 割合 ÷ 10000)', () => {
    expect(toolShareAmount(4737, 3000)).toBe(1421)
    expect(toolShareAmount(10000, 3000)).toBe(3000)
    expect(toolShareAmount(1, 3000)).toBe(0)
    expect(toolShareAmount(-300, 3000)).toBe(-90)
    expect(toolShareAmount(4737, 10000)).toBe(4737)
  })

  it('純粋な計算はデスクトップ版と同じ関数（写していない）', () => {
    expect(allocate).toBe(money.allocate)
    expect(splitEvenly).toBe(money.splitEvenly)
    // 端数は最終行に寄って、合計は必ず元の額と一致する
    const lines = [{ id: 'a', unit_price: 1000, quantity: 1 }, { id: 'b', unit_price: 1000, quantity: 1 }, { id: 'c', unit_price: 1000, quantity: 1 }]
    const alloc = allocate(lines, 100, 'by_amount')
    expect([...alloc.values()].map(v => v.allocated)).toEqual([33, 33, 34])
    expect(splitEvenly(1001, 3)).toEqual([333, 334, 334])
  })
})

describe('引数の検査（画面から JSON で来るものを信用しない）', () => {
  it('argText：文字列。無い・null は「入力してください」、型違いは「文字で」、長さ・NUL も断る。空文字は通す', () => {
    expect(argText('名前', 'あ')).toBe('あ')
    expect(argText('名前', '')).toBe('')
    expect(argText('名前', '  前後の空白は残す  ')).toBe('  前後の空白は残す  ')
    userError(() => argText('名前', undefined), '名前を入力してください')
    userError(() => argText('名前', null), '名前を入力してください')
    for (const bad of [1, true, {}, [], ['a']]) userError(() => argText('名前', bad), '名前は文字で入力してください')
    userError(() => argText('名前', 'あ'.repeat(11), { max: 10 }), '名前は10文字以内')
    expect(argText('名前', 'あ'.repeat(10), { max: 10 })).toHaveLength(10)
    userError(() => argText('名前', 'x'.repeat(10001)), '10000文字以内')
    userError(() => argText('名前', 'a\u0000b'), '使えない文字')
  })

  it('argOptText / argNullableText：null と undefined の扱いの違い', () => {
    expect(argOptText('名前', undefined)).toBeUndefined()
    expect(argOptText('名前', null)).toBeUndefined()
    expect(argOptText('名前', 'a')).toBe('a')
    userError(() => argOptText('名前', 1), '文字で')
    expect(argNullableText('メモ', undefined)).toBeUndefined() // 変えない
    expect(argNullableText('メモ', null)).toBeNull() // 消す
    expect(argNullableText('メモ', 'a')).toBe('a')
    userError(() => argNullableText('メモ', 1), '文字で')
  })

  it('argInt：安全な整数で integer 列に入る範囲。範囲は指定できる', () => {
    expect(argInt('数', 0)).toBe(0)
    expect(argInt('数', -5)).toBe(-5)
    expect(argInt('数', MAX_INT4)).toBe(MAX_INT4)
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined, {}, true]) userError(() => argInt('数', bad), '数は整数で入力してください')
    userError(() => argInt('数', MAX_INT4 + 1), '以下')
    userError(() => argInt('数', -MAX_INT4 - 1), '以上')
    expect(argInt('件数', 5, { min: 1, max: 10 })).toBe(5)
    userError(() => argInt('件数', 0, { min: 1, max: 10 }), '件数は1以上10以下')
    userError(() => argInt('件数', 11, { min: 1, max: 10 }), '件数は1以上10以下')
    expect(argOptInt('件数', null)).toBeUndefined()
    expect(argOptInt('件数', undefined)).toBeUndefined()
    expect(argOptInt('件数', 3)).toBe(3)
    userError(() => argOptInt('件数', 'a'))
    expect(argNullableInt('件数', undefined)).toBeUndefined()
    expect(argNullableInt('件数', null)).toBeNull()
    expect(argNullableInt('件数', 3)).toBe(3)
  })

  it('argYen：0 以上の整数（円）。小数・負・文字列・巨大な数は断る', () => {
    expect(argYen('金額', 0)).toBe(0)
    expect(argYen('金額', 161505)).toBe(161505)
    for (const bad of [-1, 10.5, '100', null, undefined]) userError(() => argYen('金額', bad), '金額は整数で入力してください')
    userError(() => argYen('金額', MAX_INT4 + 1), '大きすぎます')
    expect(argOptYen('金額', null)).toBeUndefined()
    expect(argOptYen('金額', 5)).toBe(5)
    expect(argNullableYen('送料', undefined)).toBeUndefined()
    expect(argNullableYen('送料', null)).toBeNull()
    expect(argNullableYen('送料', 0)).toBe(0)
    userError(() => argNullableYen('送料', -1), '送料は整数で入力してください')
  })

  it('argId / argIds：uuid。小文字にして返す。配列は個数の上限つき', () => {
    const id = '0A1B2C3D-0000-4000-8000-00000000ABCD'
    expect(argId('タグ', id)).toBe(id.toLowerCase())
    expect(isUuid(id)).toBe(true)
    for (const bad of ['', 'not-a-uuid', '0a1b2c3d-0000-4000-8000-00000000abc', ` ${id}`, `${id} `, 1, null, undefined, {}, [id]]) {
      userError(() => argId('タグ', bad), 'タグの指定が正しくありません')
      expect(isUuid(bad)).toBe(false)
    }
    expect(argOptId('タグ', null)).toBeUndefined()
    expect(argOptId('タグ', id)).toBe(id.toLowerCase())
    expect(argNullableId('タグ', undefined)).toBeUndefined()
    expect(argNullableId('タグ', null)).toBeNull()
    userError(() => argNullableId('タグ', 'x'))
    expect(argIds('タグ', [id, id])).toEqual([id.toLowerCase(), id.toLowerCase()])
    expect(argIds('タグ', [])).toEqual([])
    userError(() => argIds('タグ', 'x'), 'タグの形')
    userError(() => argIds('タグ', [id, 'bad']), 'タグの指定')
    userError(() => argIds('タグ', [id, id, id], { max: 2 }), '2個以内')
  })

  it('argBool / argFlag / argArray / argObject / argEnum', () => {
    expect(argBool('フラグ', true)).toBe(true)
    expect(argBool('フラグ', false)).toBe(false)
    for (const bad of [0, 1, 'true', null, undefined]) userError(() => argBool('フラグ', bad), 'true か false')
    expect(argOptBool('フラグ', null)).toBeUndefined()
    expect(argOptBool('フラグ', false)).toBe(false)

    expect(argFlag('有効', 1)).toBe(1)
    expect(argFlag('有効', 0)).toBe(0)
    expect(argFlag('有効', true)).toBe(1)
    expect(argFlag('有効', false)).toBe(0)
    for (const bad of [2, -1, '1', null, undefined, 0.5]) userError(() => argFlag('有効', bad), '0 か 1')
    expect(argOptFlag('有効', null)).toBeUndefined()
    expect(argOptFlag('有効', 0)).toBe(0)

    expect(argArray('一覧', [1, 2])).toEqual([1, 2])
    for (const bad of ['a', {}, null, undefined, 1]) userError(() => argArray('一覧', bad), '一覧の形')
    userError(() => argArray('一覧', [1, 2, 3], { max: 2 }), '2個以内')
    expect(argOptArray('一覧', null)).toBeUndefined()
    expect(argOptArray('一覧', [])).toEqual([])

    expect(argObject('入力', { a: 1 })).toEqual({ a: 1 })
    for (const bad of [[], 'a', 1, null, undefined, true]) userError(() => argObject('入力', bad), '入力の形')
    expect(argOptObject('入力', null)).toBeUndefined()
    expect(argOptObject('入力', {})).toEqual({})

    expect(argEnum('種類', 'bank', ['bank', 'cash'] as const)).toBe('bank')
    for (const bad of ['other', '', 'BANK', 1, null, undefined, ['bank']]) userError(() => argEnum('種類', bad, ['bank', 'cash'] as const), '種類の値')
    // 継承されたキー名を通さない
    userError(() => argEnum('種類', 'constructor', ['bank'] as const))
    expect(argOptEnum('種類', null, ['bank'] as const)).toBeUndefined()
    expect(argOptEnum('種類', 'bank', ['bank'] as const)).toBe('bank')
    expect(argNullableEnum('種類', undefined, ['bank'] as const)).toBeUndefined()
    expect(argNullableEnum('種類', null, ['bank'] as const)).toBeNull()
    userError(() => argNullableEnum('種類', 'x', ['bank'] as const))
  })

  it('argDate / argMonth と、その Opt / Nullable', () => {
    expect(argDate('日付', '2026-10-12')).toBe('2026-10-12')
    userError(() => argDate('日付', '2026-02-30'), '日付はYYYY-MM-DD')
    expect(argOptDate('日付', null)).toBeUndefined()
    expect(argNullableDate('期限', undefined)).toBeUndefined()
    expect(argNullableDate('期限', null)).toBeNull()
    expect(argNullableDate('期限', '2026-10-12')).toBe('2026-10-12')
    userError(() => argNullableDate('期限', 'x'))

    expect(argMonth('月', '2026-10')).toBe('2026-10')
    userError(() => argMonth('月', '2026-13'), '月はYYYY-MM')
    expect(argOptMonth('月', null)).toBeUndefined()
    expect(argNullableMonth('月', undefined)).toBeUndefined()
    expect(argNullableMonth('月', null)).toBeNull()
    expect(argNullableMonth('月', '2026-10')).toBe('2026-10')
  })
})

describe('CSV', () => {
  it('rowsToCsv：0 件は空文字。BOM つき・CRLF。カンマ・引用符・改行を含む値は " で囲む', () => {
    expect(rowsToCsv([])).toBe('')
    const csv = rowsToCsv([
      { 商品名: '商品,カンマ入り', 金額: 1000, メモ: null },
      { 商品名: '引用"符"', 金額: 0, メモ: '1行目\n2行目' },
      { 商品名: undefined, 金額: -5, メモ: 'x' },
    ])
    expect(csv.charCodeAt(0)).toBe(0xFEFF)
    expect(csv.slice(1)).toBe(
      '商品名,金額,メモ\r\n"商品,カンマ入り",1000,\r\n"引用""符""",0,"1行目\n2行目"\r\n,-5,x',
    )
  })
})

describe('画像の URL', () => {
  it('mediaUrl：公開バケット media の URL。path が無い・mediaBase が無いなら null', () => {
    const ctx = { mediaBase: MEDIA_BASE }
    expect(mediaUrl(ctx, 'h1/sale/abc.jpg')).toBe(`${MEDIA_BASE}/h1/sale/abc.jpg`)
    expect(mediaUrl(ctx, '/h1/sale/abc.jpg')).toBe(`${MEDIA_BASE}/h1/sale/abc.jpg`)
    expect(mediaUrl(ctx, null)).toBeNull()
    expect(mediaUrl(ctx, undefined)).toBeNull()
    expect(mediaUrl(ctx, '')).toBeNull()
    expect(mediaUrl({ mediaBase: null }, 'h1/sale/abc.jpg')).toBeNull()
    // URL に使えない文字は区切りごとに符号化する（パスの区切りは残す）
    expect(mediaUrl(ctx, 'h 1/種類/a b#c?.jpg')).toBe(`${MEDIA_BASE}/h%201/%E7%A8%AE%E9%A1%9E/a%20b%23c%3F.jpg`)
  })

  it('mediaBaseFromEnv：SUPABASE_URL から作る（末尾のスラッシュは除く）。無ければ null', () => {
    expect(mediaBaseFromEnv({ SUPABASE_URL })).toBe(MEDIA_BASE)
    expect(mediaBaseFromEnv({ SUPABASE_URL: `${SUPABASE_URL}///` })).toBe(MEDIA_BASE)
    expect(mediaBaseFromEnv({ SUPABASE_URL: ` ${SUPABASE_URL} ` })).toBe(MEDIA_BASE)
    expect(mediaBaseFromEnv({})).toBeNull()
    expect(mediaBaseFromEnv({ SUPABASE_URL: '' })).toBeNull()
    expect(mediaBaseFromEnv({ SUPABASE_URL: '   ' })).toBeNull()
  })

  it('ハンドラの ctx.mediaBase は dispatch が env.SUPABASE_URL から作って渡す。env が無ければ null', async () => {
    await newWorld(dom).then(async (world) => {
      const handlers = { getSettings: async (ctx: Ctx) => ({ base: ctx.mediaBase, url: mediaUrl(ctx, 'a/b.png') }) }
      const identity = { householdId: world.a.householdId, userId: world.a.userId }
      const withEnv = await dispatch('getSettings', [], { root: dom.root, identity, env: { SUPABASE_URL: `${SUPABASE_URL}/` }, handlers })
      expect(JSON.parse(await withEnv.text())).toEqual({ result: { base: MEDIA_BASE, url: `${MEDIA_BASE}/a/b.png` } })
      const noUrl = await dispatch('getSettings', [], { root: dom.root, identity, env: {}, handlers })
      expect(JSON.parse(await noUrl.text())).toEqual({ result: { base: null, url: null } })
      const noEnv = await dispatch('getSettings', [], { root: dom.root, identity, handlers })
      expect(JSON.parse(await noEnv.text())).toEqual({ result: { base: null, url: null } })
      const direct = await dispatch('getSettings', [], { root: dom.root, identity, mediaBase: 'https://cdn.test/m', handlers })
      expect(JSON.parse(await direct.text())).toEqual({ result: { base: 'https://cdn.test/m', url: 'https://cdn.test/m/a/b.png' } })
    })
  })
})

describe('キーワード・設定', () => {
  it('parseKeywords：「,」「、」空白・改行で区切る。小文字にして、空は捨てる', () => {
    expect(parseKeywords('メロジョイ, Mellojoy、ジョイ')).toEqual(['メロジョイ', 'mellojoy', 'ジョイ'])
    expect(parseKeywords('  限定\n  コラボ　 ')).toEqual(['限定', 'コラボ'])
    expect(parseKeywords('')).toEqual([])
    expect(parseKeywords(' , 、 ')).toEqual([])
  })

  it('matchesAnyKeyword：どれか 1 つでも含めば true（大小無視）', () => {
    expect(matchesAnyKeyword('限定コラボ MOKO', ['moko'])).toBe(true)
    expect(matchesAnyKeyword('限定コラボ', ['ぷに', '限定'])).toBe(true)
    expect(matchesAnyKeyword('限定コラボ', ['ぷに'])).toBe(false)
    expect(matchesAnyKeyword('なんでも', [])).toBe(false)
  })

  describe('setting / settingStr / keywordsFor', () => {
    beforeEach(async () => {
      w = await newWorld(dom)
    })

    it('新しい世帯の初期値が読める。無いキーは fallback', async () => {
      expect(await A((c) => setting(c, 'fee_rate_bp', 999))).toBe(1000)
      expect(await A((c) => setting(c, 'fee_rate_bp_yahoo', 999))).toBe(500)
      expect(await A((c) => setting(c, 'no_such_key', 42))).toBe(42)
      expect(await A((c) => settingStr(c, 'mercari_keyword', 'x'))).toBe('')
      expect(await A((c) => settingStr(c, 'no_such_key'))).toBe('')
      expect(await A((c) => settingStr(c, 'no_such_key', '既定'))).toBe('既定')
    })

    it('keywordsFor：出品先ごとに独立（mercari_keyword / yahoo_keyword）', async () => {
      await A((c) => c.sql.run(`update setting set value = 'メロジョイ, Mellojoy' where key = 'mercari_keyword'`))
      await A((c) => c.sql.run(`update setting set value = 'ヤフー限定' where key = 'yahoo_keyword'`))
      expect(await A((c) => keywordsFor(c, 'mercari'))).toEqual(['メロジョイ', 'mellojoy'])
      expect(await A((c) => keywordsFor(c, 'yahoo'))).toEqual(['ヤフー限定'])
    })

    it('他の世帯の設定は読めない', async () => {
      await A((c) => c.sql.run(`update setting set value = '1234' where key = 'fee_rate_bp'`))
      expect(await A((c) => setting(c, 'fee_rate_bp', 0))).toBe(1234)
      expect(await w.b.run((c) => setting(c, 'fee_rate_bp', 0))).toBe(1000)
    })
  })
})

describe('タグ', () => {
  beforeEach(async () => {
    w = await newWorld(dom)
  })

  const tagOf = (name: string) => A((c) => createTag(c, name))
  const newSale = (title: string) =>
    A(async (c) => (await c.sql.get<{ id: string }>(
      'insert into sale (title, sold_at, price) values (?, ?, ?) returning id', title, '2026-01-01', 1000,
    ))!.id)

  it('loadTagsFor：対象 id ごとのタグを 1 クエリで引く。並びは sort_order → 名前。持ち主が無ければ空', async () => {
    const t1 = await tagOf('b')
    const t2 = await tagOf('a')
    const t3 = await tagOf('c')
    const s1 = await newSale('販売1')
    const s2 = await newSale('販売2')
    const s3 = await newSale('販売3')
    await A(async (c) => {
      await c.sql.run('insert into sale_tag (sale_id, tag_id) values (?, ?), (?, ?), (?, ?)', s1, t2, s1, t1, s2, t3)
    })
    const map = await A((c) => loadTagsFor(c, 'sale_tag', 'sale_id', [s1, s2, s3]))
    // t1（b）の sort_order=0、t2（a）=1。名前ではなく sort_order が先
    expect(map.get(s1)).toEqual([{ id: t1, name: 'b', sort_order: 0 }, { id: t2, name: 'a', sort_order: 1 }])
    expect(map.get(s2)).toEqual([{ id: t3, name: 'c', sort_order: 2 }])
    expect(map.has(s3)).toBe(false)
    expect((await A((c) => loadTagsFor(c, 'sale_tag', 'sale_id', []))).size).toBe(0)
  })

  it('loadTagsFor：product_tag は持ち主が model_code（文字列）。inventory / purchase / shop_account も引ける', async () => {
    const t1 = await tagOf('型番タグ')
    const t2 = await tagOf('在庫タグ')
    const ids = await A(async (c) => {
      const shop = (await c.sql.get<{ id: string }>(`insert into shop_account (name) values ('口座') returning id`))!.id
      const purchase = (await c.sql.get<{ id: string }>(
        `insert into purchase (shop_account_id, ordered_at) values (?, '2026-01-01') returning id`, shop,
      ))!.id
      const item = (await c.sql.get<{ id: string }>(
        `insert into inventory_item (item_code, name, landed_cost, acquired_at) values ('S-0001', 'x', 100, '2026-01-01') returning id`,
      ))!.id
      await c.sql.run(`insert into product_tag (model_code, tag_id) values ('A037', ?), ('A035-1', ?)`, t1, t1)
      await c.sql.run('insert into inventory_tag (inventory_item_id, tag_id) values (?, ?)', item, t2)
      await c.sql.run('insert into purchase_tag (purchase_id, tag_id) values (?, ?)', purchase, t2)
      await c.sql.run('insert into shop_account_tag (shop_account_id, tag_id) values (?, ?)', shop, t1)
      return { shop, purchase, item }
    })
    const byCode = await A((c) => loadTagsFor(c, 'product_tag', 'model_code', ['A037', 'A035-1', 'ZZZ']))
    expect(byCode.get('A037')!.map(t => t.name)).toEqual(['型番タグ'])
    expect(byCode.get('A035-1')!.map(t => t.name)).toEqual(['型番タグ'])
    expect(byCode.has('ZZZ')).toBe(false)
    expect((await A((c) => loadTagsFor(c, 'inventory_tag', 'inventory_item_id', [ids.item]))).get(ids.item)!.map(t => t.name)).toEqual(['在庫タグ'])
    expect((await A((c) => loadTagsFor(c, 'purchase_tag', 'purchase_id', [ids.purchase]))).get(ids.purchase)!.map(t => t.name)).toEqual(['在庫タグ'])
    expect((await A((c) => loadTagsFor(c, 'shop_account_tag', 'shop_account_id', [ids.shop]))).get(ids.shop)!.map(t => t.name)).toEqual(['型番タグ'])
  })

  it('loadTagsFor：名前の並びはバイト順（SQLite と同じ）。他の世帯のタグ・行は引けない', async () => {
    const lower = await tagOf('a')
    const upper = await tagOf('B')
    await A((c) => c.sql.run('update tag set sort_order = 0'))
    const sale = await newSale('販売')
    await A((c) => c.sql.run('insert into sale_tag (sale_id, tag_id) values (?, ?), (?, ?)', sale, lower, sale, upper))
    expect((await A((c) => loadTagsFor(c, 'sale_tag', 'sale_id', [sale]))).get(sale)!.map(t => t.name)).toEqual(['B', 'a'])
    // 世帯 B からは、A の販売の id を知っていても何も引けない
    expect((await w.b.run((c) => loadTagsFor(c, 'sale_tag', 'sale_id', [sale]))).size).toBe(0)
  })

  it('mergeInheritedTags：優先順（先勝ち）で 1 つにまとめる。直接タグは除く。sort_order → 名前で並べ、from を付ける', () => {
    const tag = (id: string, name: string, sort_order = 0): Tag => ({ id, name, sort_order })
    const merged = mergeInheritedTags(new Set(['direct']), [
      { from: 'purchase', tags: [tag('p1', 'P', 2), tag('direct', 'D'), tag('dup', 'Dup', 1)] },
      { from: 'product', tags: [tag('dup', 'Dup', 1), tag('q1', 'Q', 0)] },
      { from: 'inventory', tags: [tag('i1', 'B', 2), tag('i2', 'a', 2), tag('p1', 'P', 2)] },
    ])
    expect(merged).toEqual([
      { id: 'q1', name: 'Q', sort_order: 0, from: 'product' },
      { id: 'dup', name: 'Dup', sort_order: 1, from: 'purchase' },
      // sort_order が同じ 2 のものは名前順（文字コード順なので大文字の B が先）
      { id: 'i1', name: 'B', sort_order: 2, from: 'inventory' },
      { id: 'p1', name: 'P', sort_order: 2, from: 'purchase' },
      { id: 'i2', name: 'a', sort_order: 2, from: 'inventory' },
    ])
    expect(mergeInheritedTags(new Set(), [])).toEqual([])
  })

  it('assertTagsExist：全部この世帯にあれば通る。1 つでも無ければ 404（外部キー違反の 500 にしない）。他の世帯のタグは無いのと同じ', async () => {
    const mine = await tagOf('自分')
    const theirs = await w.b.run((c) => createTag(c, '相手'))
    await expect(A((c) => assertTagsExist(c, []))).resolves.toBeUndefined()
    await expect(A((c) => assertTagsExist(c, [mine, mine]))).resolves.toBeUndefined()
    await expect(A((c) => assertTagsExist(c, [mine, theirs]))).rejects.toMatchObject({ code: 'not_found', message: 'タグが見つかりません' })
    await expect(A((c) => assertTagsExist(c, ['00000000-0000-4000-8000-0000000000aa']))).rejects.toMatchObject({ code: 'not_found' })
  })
})
