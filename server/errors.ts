/**
 * API が返すエラー。通信の形（画面側と合わせた契約）：
 *   `{"error": {"code": "<code>", "message": "<日本語>"}}`
 */
export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'not_implemented'
  | 'bad_request'
  | 'conflict'
  | 'internal'

export const HTTP_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  not_implemented: 501,
  bad_request: 400,
  conflict: 409,
  internal: 500,
}

/** `internal` のメッセージ。SQL・スタック・内部の名前は**絶対に入れない**（原因はサーバーのログに出す） */
export const INTERNAL_MESSAGE = 'サーバーでエラーが起きました。しばらくしてからもう一度お試しください'

/** 利用者に message をそのまま見せるエラー（code と HTTP ステータスを持つ） */
export class ApiError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/**
 * **業務ロジックが投げる、利用者に見せてよい日本語のエラー。**
 * いまの db.ts の `throw new Error('販売が見つかりません')` は、移植するとき `throw new UserError(…)` にする。
 *
 * これ以外の例外（素の `Error`・SQL のエラー）は `internal` に丸めて、メッセージを利用者に出さない。
 * 日本語の文言を持つ `Error` を投げても**画面には出ない**ので、必ず `UserError` にすること。
 *
 * code の既定は `bad_request`（入力や状態が合わない）。見つからないなら `not_found`、
 * 取り込み中・重複など他の操作とぶつかるなら `conflict`。
 */
export class UserError extends ApiError {
  constructor(message: string, code: 'bad_request' | 'not_found' | 'conflict' = 'bad_request') {
    super(code, message)
    this.name = 'UserError'
  }
}

// ---- Postgres の例外を UserError に写す ----

/** ドライバが違っても同じ形で読む（postgres.js は `constraint_name`、PGlite は `constraint`） */
export interface DbErrorInfo {
  /** SQLSTATE（例 '23505'） */
  code: string
  message: string
  detail?: string
  constraint?: string
  table?: string
}

export interface DbErrorRule {
  /** 指定した項目がすべて一致したとき（先に登録したものが優先） */
  code?: string
  constraint?: string
  table?: string
  message: string
  as?: 'bad_request' | 'not_found' | 'conflict'
}

const dbErrorRules: DbErrorRule[] = [
  // 取り込み要求は世帯ごとに 1 本だけ（collect_job の部分ユニーク索引）。2 本目を断る
  { code: '23505', constraint: 'collect_job_one_active', message: '取り込み中です。終わってからもう一度お試しください', as: 'conflict' },
  // 同時に同じ行を触った
  { code: '40001', message: '他の操作と重なりました。もう一度お試しください', as: 'conflict' },
  { code: '40P01', message: '他の操作と重なりました。もう一度お試しください', as: 'conflict' },
]

/** 制約名などから、利用者向けの日本語に写す規則を足す（業務ロジック側が起動時に呼ぶ） */
export function registerDbErrorRule(rule: DbErrorRule): void {
  // 条件が 1 つも無い規則は「どの DB エラーも利用者向けの文言にする」ことになる（SQL の不具合を隠す）
  if (rule.code === undefined && rule.constraint === undefined && rule.table === undefined) {
    throw new Error('registerDbErrorRule: code・constraint・table のどれかが必要です')
  }
  dbErrorRules.push(rule)
}

export function readDbError(e: unknown): DbErrorInfo | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const r = e as Record<string, unknown>
  // SQLSTATE は 5 桁の英数字。それ以外（Node のエラーコード ECONNRESET など）は DB の例外ではない
  if (typeof r.code !== 'string' || !/^[0-9A-Z]{5}$/.test(r.code)) return undefined
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return {
    code: r.code,
    message: str(r.message) ?? '',
    detail: str(r.detail),
    constraint: str(r.constraint_name) ?? str(r.constraint),
    table: str(r.table_name) ?? str(r.table),
  }
}

/**
 * 登録した規則に当たれば UserError、当たらなければ undefined（呼び出し側が `internal` にする）。
 *
 * **SQLSTATE が `SB` で始まる例外は、DB の関数が利用者向けの日本語で投げたもの**（supabase/migrations の
 * 取り込みの排他：SB001 取り込み中・SB002 連続の取り込み・SB003 権限の失効）。メッセージ（と detail）を
 * そのまま見せて、409 `conflict` にする。DB 関数に利用者向けの文言を足すときは `SB` で始まる errcode を使うこと
 * （それ以外の SQLSTATE のメッセージは英語の内部用なので、見せない）。
 */
export function mapDbError(e: unknown): UserError | undefined {
  const info = readDbError(e)
  if (!info) return undefined
  for (const rule of dbErrorRules) {
    if (rule.code !== undefined && rule.code !== info.code) continue
    if (rule.constraint !== undefined && rule.constraint !== info.constraint) continue
    if (rule.table !== undefined && rule.table !== info.table) continue
    return new UserError(rule.message, rule.as ?? 'bad_request')
  }
  if (info.code.startsWith('SB') && info.message) {
    return new UserError(info.detail ? `${info.message}（${info.detail}）` : info.message, 'conflict')
  }
  return undefined
}
