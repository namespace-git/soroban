// 日付・日時の変換。process の TZ には一切頼らない（日本時間は +09:00 の固定オフセットで扱う）。
// `pnpm test:server` は TZ=UTC、デスクトップ版の利用者の PC は日本時間。どちらでも同じ値になること

const JST_OFFSET_MS = 9 * 3_600_000

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
// 日本時間の素の文字列（zone なしの T 区切り）。sale.purchased_at ('2026-09-29T15:30') や Yahoo の listed_at
const LOCAL_T = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/
// datetime('now')。UTC の素の文字列
const SQLITE_UTC = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/
// new Date().toISOString() など。zone つき
const ISO_ZONED = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/

/** 値の形を 9 に置き換えた文字列（エラー表示用。値そのもの＝商品名などを出さない） */
export function shapeOf(value: unknown): string {
  if (typeof value !== 'string') return typeof value
  return value.length > 40 ? `${value.slice(0, 40).replace(/\d/g, '9')}…` : value.replace(/\d/g, '9')
}

function isCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

function ymd(ms: number): string {
  const t = new Date(ms)
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

function fractionMs(frac: string | undefined): number {
  return frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0
}

function offsetMs(zone: string): number {
  if (zone === 'Z') return 0
  const sign = zone[0] === '-' ? -1 : 1
  const digits = zone.slice(1).replace(':', '')
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000
}

/** 年月日時分秒（その zone の壁時計）→ UTC のミリ秒。実在しない日時は null */
function wallToUtcMs(m: RegExpExecArray, zoneOffset: number): number | null {
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number)
  if (!isCalendarDate(y, mo, d) || h > 23 || mi > 59 || s > 59) return null
  return Date.UTC(y, mo - 1, d, h, mi, s, fractionMs(m[7])) - zoneOffset
}

/** 日付（'YYYY-MM-DD'）を返す。coerced = 日付そのものではない形から作ったか（件数をレポートに出す） */
export function toDateString(raw: string): { value: string; coerced: boolean } | null {
  let m = DATE_ONLY.exec(raw)
  if (m) return isCalendarDate(+m[1], +m[2], +m[3]) ? { value: raw, coerced: false } : null

  // 日本時間の壁時計（T 区切り）: その日付がそのまま日本の日付
  m = LOCAL_T.exec(raw)
  if (m) return wallToUtcMs(m, JST_OFFSET_MS) === null ? null : { value: raw.slice(0, 10), coerced: true }

  // UTC の datetime('now') / zone つきの ISO: 日本時間に直した日付（UTC の日付をそのまま使うと 0〜9 時で 1 日ずれる）
  m = SQLITE_UTC.exec(raw)
  if (m) {
    const ms = wallToUtcMs(m, 0)
    return ms === null ? null : { value: ymd(ms + JST_OFFSET_MS), coerced: true }
  }
  m = ISO_ZONED.exec(raw)
  if (m) {
    const ms = wallToUtcMs(m, offsetMs(m[8]))
    return ms === null ? null : { value: ymd(ms + JST_OFFSET_MS), coerced: true }
  }
  return null
}

/**
 * timestamptz に渡せる UTC の ISO 文字列を返す。
 * * zone つきの ISO / datetime('now')（UTC）… そのまま。想定どおりの形なので coerced = false
 * * zone なしの T 区切り・日付だけ … 日本時間（日付だけならその日の 0:00）。purchased_at がこの形。coerced = true
 */
export function toInstant(raw: string): { value: string; coerced: boolean } | null {
  let m = ISO_ZONED.exec(raw)
  if (m) {
    const ms = wallToUtcMs(m, offsetMs(m[8]))
    return ms === null ? null : { value: new Date(ms).toISOString(), coerced: false }
  }
  m = SQLITE_UTC.exec(raw)
  if (m) {
    const ms = wallToUtcMs(m, 0)
    return ms === null ? null : { value: new Date(ms).toISOString(), coerced: false }
  }
  m = LOCAL_T.exec(raw)
  if (m) {
    const ms = wallToUtcMs(m, JST_OFFSET_MS)
    return ms === null ? null : { value: new Date(ms).toISOString(), coerced: true }
  }
  m = DATE_ONLY.exec(raw)
  if (m) {
    if (!isCalendarDate(+m[1], +m[2], +m[3])) return null
    return { value: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - JST_OFFSET_MS).toISOString(), coerced: true }
  }
  return null
}

/**
 * Postgres が返す timestamptz の文字列（to_jsonb の '2026-10-12T03:04:05.123456+00:00' など）→ UTC の ISO。
 * 突き合わせで、書いた値と読み戻した値を同じ形にするために使う。読めなければ null
 */
export function readInstant(text: string): string | null {
  return toInstant(text)?.value ?? null
}

/** 2 つの 'YYYY-MM-DD' の日数差（a - b） */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000)
}
