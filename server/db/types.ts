/**
 * 値の型の変換。PGlite（テスト）と postgres.js（本番）で**同じ値**が返るよう、ここに一本化する。
 *
 * デスクトップ版（SQLite）の db.ts は「金額は number、日付は文字列」の前提で書かれている。
 * Postgres のドライバは何もしないと次のようになり、移植した業務ロジックが静かに壊れる（契約は number / string）。
 *
 * - `bigint`（`count(*)` や `sum(integer)` の戻り）が、postgres.js では**文字列**で返る。`total + 1` が `"57501"` になる
 * - `date` / `timestamptz` が JS の Date になる（JSON にすると `2026-10-12T00:00:00.000Z` で、日付が 1 日ずれて見える）
 *
 * なので、読み出しは次の形に揃える。PGlite と postgres.js の**両方**で同じ。
 *
 * | Postgres | JS |
 * |---|---|
 * | int8 | number（`Number.isSafeInteger` を超えたら**例外**。黙って丸めない） |
 * | date / timestamp | `YYYY-MM-DD` / `YYYY-MM-DD HH:MM:SS` の文字列（そのまま。タイムゾーンで動かさない） |
 * | timestamptz | ISO 8601 の UTC 文字列（`2026-10-12T03:04:05.123Z`）。接続の TimeZone に依らない |
 *
 * **numeric は扱わない**（ドライバの既定のまま＝文字列）。金額は integer（円）で持つ方針なので使わない。
 * `avg()` や `sum(bigint)` は numeric を返すので、SQL 側で `round(avg(x))::int` / `sum(x)::bigint` のように
 * キャストして整数で受ける。配列（`int8[]` など）の要素にも効かない。
 */
export const OID = {
  int8: 20,
  date: 1082,
  timestamp: 1114,
  timestamptz: 1184,
} as const

export function parseInt8(text: string): number {
  const n = Number(text)
  if (!Number.isSafeInteger(n)) throw new Error(`int8 の値が JavaScript の整数で表せません: ${text}`)
  return n
}

export function parseRaw(text: string): string {
  return text
}

// Postgres の ISO 出力：2026-10-12 12:04:05.123456+09 / 2026-10-12 03:04:05+00 / …+05:30
const TIMESTAMPTZ = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([+-])(\d{2})(?::(\d{2}))?$/

/** timestamptz を UTC の ISO 文字列にする。読めない形（infinity・紀元前）はそのまま返す */
export function parseTimestamptz(text: string): string {
  const m = TIMESTAMPTZ.exec(text)
  if (!m) return text
  const [, y, mo, d, h, mi, s, frac = '', sign, oh, om = '00'] = m
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}.${frac.padEnd(3, '0').slice(0, 3)}${sign}${oh}:${om}`)
  return Number.isNaN(t) ? text : new Date(t).toISOString()
}

/** OID ごとの読み出し（PGlite の `parsers`、postgres.js の `types` の元） */
export const PARSERS: Record<number, (text: string) => unknown> = {
  [OID.int8]: parseInt8,
  [OID.date]: parseRaw,
  [OID.timestamp]: parseRaw,
  [OID.timestamptz]: parseTimestamptz,
}

/**
 * 引数を Postgres に渡せる形にする（両方のドライバで同じ結果にするため、ここで揃える）。
 *
 * - `undefined` は**例外**。ドライバごとに null になったり落ちたりするので、黙って通さない
 * - 配列は Postgres の配列リテラル文字列（`{"a","b"}`）にする。postgres.js は型を問い合わせないと
 *   配列を文字列結合してしまうので、リテラルにしておけば `= any(?)` も `text[]` 列への代入もどちらでも通る
 * - 素のオブジェクトは**例外**。jsonb は呼び出し側で `JSON.stringify` する（`"[object Object]"` を保存しない）
 * - NaN・Infinity は**例外**（金額に紛れ込ませない）
 */
export function normalizeParam(value: unknown, index: number): unknown {
  if (value === undefined) throw new Error(`引数 ${index + 1} 番目が undefined です（空にしたいときは null を渡してください）`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`引数 ${index + 1} 番目が有限の数ではありません: ${value}`)
  if (Array.isArray(value)) return toArrayLiteral(value, index)
  if (typeof value === 'object' && value !== null && !(value instanceof Date) && !ArrayBuffer.isView(value)) {
    throw new Error(`引数 ${index + 1} 番目がオブジェクトです（jsonb は JSON.stringify して文字列で渡してください）`)
  }
  return value
}

function toArrayLiteral(items: unknown[], index: number): string {
  const parts = items.map((item) => {
    if (item === null) return 'NULL'
    if (Array.isArray(item)) return toArrayLiteral(item, index)
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error(`引数 ${index + 1} 番目の配列に有限でない数があります`)
      return String(item)
    }
    if (typeof item === 'boolean') return item ? 'true' : 'false'
    if (typeof item === 'bigint') return String(item)
    if (item instanceof Date) return quoteArrayElement(item.toISOString())
    if (typeof item === 'string') return quoteArrayElement(item)
    throw new Error(`引数 ${index + 1} 番目の配列に渡せない値があります`)
  })
  return `{${parts.join(',')}}`
}

// 要素は常に引用符で囲む（空文字・NULL という文字列・カンマや波括弧を含む文字列を安全に渡すため）
function quoteArrayElement(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
