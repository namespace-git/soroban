export type Row = Record<string, unknown>

/** 突き合わせる金額のビュー。SQLite（いまの帳簿）と Postgres の両方にある 5 本 */
export const VIEW_NAMES = [
  'sale_profit', 'monthly_summary', 'inventory_view', 'sale_line_share', 'variant_summary',
] as const
export type ViewName = (typeof VIEW_NAMES)[number]

/**
 * SQLite（デスクトップ版の帳簿）を読んだ結果。読み方（better-sqlite3）と、変換・書き込みを分けるための境目。
 * 変換と書き込みは、これを入力にして Node 単体（PGlite）でテストできる
 */
export interface SourceSnapshot {
  /** SQLite の表の中身（`select *`）。sale_line は rowid の昇順＝紐付けた順。順番を入れ替えない */
  tables: Record<string, Row[]>
  /** SQLite 側の 5 本のビューの出力（読んだ時点）。突き合わせの「正」 */
  views: Record<ViewName, Row[]>
  /** 移さない表（名前 → 行数）。app_log など */
  skippedTables: Record<string, number>
  /** 道具が知らない表（名前 → 行数）。行があれば止める（静かな欠損を作らない） */
  unknownTables: Record<string, number>
  /** SQLite の setting.schema_version。読めなければ null */
  schemaVersion: number | null
}

/** 画像の置き場所（Supabase Storage のバケット） */
export type Bucket = 'media' | 'receipts'

/** 画像の種類。パスの `<世帯>/<種類>/<ランダムな uuid>.<拡張子>` の真ん中 */
export type ImageKind = 'sale' | 'listing' | 'purchase-line' | 'product' | 'receipt'
