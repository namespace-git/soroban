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
  // 画面から来た値が uuid・数値・日付などの形になっていない。SQL まで届いてしまった分を 500 にしない
  { code: '22P02', message: '値の形が正しくありません', as: 'bad_request' },
  // integer 列に入らない大きさの数、NUL 文字（text に入れられない）
  { code: '22003', message: '数値が大きすぎます', as: 'bad_request' },
  { code: '22021', message: '使えない文字が含まれています', as: 'bad_request' },
  // 同じ画像を 2 つの経費・型番に結ぼうとした（アプリの検査を同時に通り抜けた分を、DB の部分ユニーク索引が止める。20261012001900）
  { code: '23505', constraint: 'expense_receipt_path_unique', message: 'このレシートはすでに別の経費に付いています', as: 'conflict' },
  { code: '23505', constraint: 'product_image_product_path_unique', message: 'この画像はすでに別の商品に使われています', as: 'conflict' },
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
 *
 * SB004（取り消せない：始まっている・もう終わっている）は 409 `conflict`、
 * SB005（取り込みの要求が見つからない。他の世帯の要求も RLS で見えない）と
 * SB007（取り込み担当の PC が見つからない。同じく他の世帯の PC も見えない）は 404 `not_found`。
 * SB006（取り消し済みの PC に鍵を出そうとした）は 409 `conflict` のまま。
 * SB008（同じ名前の PC が、ほかの人のログインで使われている）・SB009（取り込み担当の PC が多すぎる）も 409 `conflict`。
 * SB003（取り込みの権限の失効）も 409 だが、取り込み担当の API（server/agent/）は `lease_lost` として区別して返す。
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
    return new UserError(info.detail ? `${info.message}（${info.detail}）` : info.message, SB_CODE_AS[info.code] ?? 'conflict')
  }
  return undefined
}

/**
 * 想定外のエラーを、ログに出してよい形にする：名前・コード・メッセージ・スタックだけ。
 * **エラーのオブジェクトをそのまま `console.error` に渡さない。** postgres.js などのエラーは SQL の引数
 * （個人データ・API キー）や接続の情報を持っていて、オブジェクトごと出すとログに載る。
 * 呼び出し側は `console.error('[rpc] …', describeError(e))` の形で使う
 */
export function describeError(e: unknown): Record<string, unknown> {
  if (e instanceof Error) return { name: e.name, code: (e as { code?: unknown }).code, message: e.message, stack: e.stack }
  return { value: String(e) }
}

/** SB で始まる SQLSTATE のうち、409 `conflict` 以外にするもの */
const SB_CODE_AS: Record<string, 'not_found'> = {
  SB005: 'not_found',
  // 取り込み担当の PC が見つからない（取り消し・一覧の対象。他の世帯の PC も RLS で見えない）
  SB007: 'not_found',
}
