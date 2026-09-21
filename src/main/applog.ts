import { app } from 'electron'
import * as db from './db'

// ============================================================
// 操作ログ（デバッグ用）
//
// 不具合報告は「データベースをバックアップ」1本で済ませたい。バックアップに
// 含まれる app_log テーブルへ、IPC呼び出し・収集・画面のエラーを記録する。
// 14日より古い行は initAppLog() のたびに掃除する（溜め込まない）。
//
// 認証情報は元々扱わないが、念のため summarize() でキー名から password / token /
// cookie を含む値は伏せる。
//
// 書き込みに失敗してもアプリ本体を止めない（try/catch で握りつぶし、例外を投げない）。
// ============================================================

export type AppLogSource = 'main' | 'renderer' | 'ipc' | 'collector'

const RETENTION_DAYS = 14
const SUMMARY_MAX_LEN = 2000
/** これを超える配列は中身を展開せず、件数だけ記す（ログが肥大化・重くなるのを防ぐ） */
const LARGE_ARRAY_THRESHOLD = 50
const SECRET_KEY_RE = /password|token|cookie/i

/** getDb() は未初期化だと例外を投げるので、起動順序に関わらず安全に呼べるようにする */
function safeDb(): ReturnType<typeof db.getDb> | null {
  try {
    return db.getDb()
  } catch {
    return null
  }
}

/**
 * app_log テーブルを用意し、14日より古い行を消してから、起動を1行記録する。
 * db.initDb() の後に呼ぶ想定だが、DBが未初期化でも例外を投げずに何もしない。
 */
export function initAppLog(): void {
  const conn = safeDb()
  if (!conn) return
  try {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS app_log (
        id          INTEGER PRIMARY KEY,
        ts          TEXT NOT NULL,
        source      TEXT NOT NULL,
        kind        TEXT NOT NULL,
        message     TEXT NOT NULL,
        payload     TEXT,
        duration_ms INTEGER,
        error       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_app_log_ts ON app_log(ts);
    `)
    purgeOld(conn)

    const version = safeAppVersion()
    log('main', 'startup', `そろばん起動 v${version}`, {
      version,
      platform: process.platform,
      electron: process.versions.electron,
      node: process.versions.node,
    })
  } catch (e) {
    // ログ基盤の初期化失敗でアプリ起動を止めない
    console.error('操作ログの初期化に失敗しました', e)
  }
}

function purgeOld(conn: ReturnType<typeof db.getDb>): void {
  const threshold = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString()
  conn.prepare('DELETE FROM app_log WHERE ts < ?').run(threshold)
}

function safeAppVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return 'unknown'
  }
}

/**
 * 1行記録する。DBが未初期化・書き込み失敗のどちらでも例外は投げない
 * （デバッグ用のログで本体の処理を止めないため）。
 */
export function log(
  source: AppLogSource,
  kind: string,
  message: string,
  payload?: unknown,
  extra?: { duration_ms?: number; error?: string },
): void {
  const conn = safeDb()
  if (!conn) return
  try {
    conn.prepare(
      `INSERT INTO app_log (ts, source, kind, message, payload, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      source,
      kind,
      message,
      payload === undefined ? null : summarize(payload),
      extra?.duration_ms ?? null,
      extra?.error ?? null,
    )
  } catch (e) {
    console.error('操作ログの書き込みに失敗しました', e)
  }
}

/**
 * 値をJSONにして2,000文字で切る。循環参照は '[Circular]' に、Buffer・巨大配列は
 * 中身を展開せず長さだけにする。password/token/cookie を含むキーの値は '***' に伏せる。
 */
export function summarize(v: unknown): string {
  if (v === undefined) return ''
  let text: string
  try {
    if (isBuffer(v)) {
      text = `<Buffer ${v.length} bytes>`
    } else {
      text = JSON.stringify(redact(v, [])) ?? String(v)
    }
  } catch (e) {
    text = `[summarize失敗: ${e instanceof Error ? e.message : String(e)}]`
  }
  return text.length > SUMMARY_MAX_LEN ? `${text.slice(0, SUMMARY_MAX_LEN)}…(省略)` : text
}

function isBuffer(v: unknown): v is Buffer {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(v)
}

/** stack は現在たどっている祖先（配列・オブジェクト）。循環参照の検出だけに使う */
function redact(value: unknown, stack: unknown[]): unknown {
  if (isBuffer(value)) return `<Buffer ${value.length} bytes>`

  if (Array.isArray(value)) {
    if (stack.includes(value)) return '[Circular]'
    if (value.length > LARGE_ARRAY_THRESHOLD) return `<Array ${value.length}件>`
    stack.push(value)
    const out = value.map(item => redact(item, stack))
    stack.pop()
    return out
  }

  if (value && typeof value === 'object') {
    if (stack.includes(value)) return '[Circular]'
    stack.push(value)
    const out: Record<string, unknown> = {}
    for (const [k, v2] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '***' : redact(v2, stack)
    }
    stack.pop()
    return out
  }

  return value
}
