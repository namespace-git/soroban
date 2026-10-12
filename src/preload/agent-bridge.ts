// ============================================================
// 取り込み担当モードの「橋」の、electron に依存しない部分（preload と main と画面のテストが共有する純粋な関数）
//
// 取り込み担当モードの窓（Web 版を開く）にだけ、preload（agent.ts）が window.sorobanAgentBridge を出す。
// 橋は Web 版のログイン（Supabase のアクセストークン）を main に渡すだけ。**main はメモリにだけ持つ**
// （ファイル・DB・ログには書かない）。設計：docs/web/03-agent-and-push.md の 1 節
//
// 橋を出す条件は「いま開いているページの origin が、設定した Web 版の origin と一致するとき」だけ。
// 設定した origin は main が additionalArguments（`--soroban-agent-origin=…`）で渡す。
// 渡されていない・読めないときは出さない（閉じる側に倒す）。
// ============================================================

/** main が preload に渡す引数の頭（additionalArguments）。`process.argv` に入る */
export const AGENT_ORIGIN_ARG = '--soroban-agent-origin='

/** 橋に渡す・main が受ける、Web 版のログインの内容 */
export interface AgentSessionInput {
  /** Supabase のアクセストークン（JWT）。人のログイン。main はメモリにだけ持つ */
  accessToken: string
  /** アクセストークンの期限（Unix 秒。Supabase の session.expires_at） */
  expiresAt: number
  /** Supabase の Project URL（https の origin）。画像を Storage に上げるのに使う */
  supabaseUrl: string
  /** Supabase の anon キー（公開してよい値） */
  anonKey: string
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Web 版の URL を「https の origin」にそろえる。https 以外・変な形・ユーザー名つきは null。
 * `soroban.pages.dev` のようにスキームを省いたものは https とみなす（`http://` は受けない）。
 * パスや末尾の / は落とす
 */
export function normalizeOrigin(raw: string): string | null {
  const text = raw.trim()
  if (!text || text.length > 2048) return null
  let url: URL
  try {
    url = new URL(HAS_SCHEME.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null
  return url.origin
}

/** `process.argv` から、main が渡した Web 版の origin を取り出す。無い・https の origin でなければ null */
export function originFromArgv(argv: readonly string[]): string | null {
  const arg = argv.find(a => a.startsWith(AGENT_ORIGIN_ARG))
  if (!arg) return null
  const value = arg.slice(AGENT_ORIGIN_ARG.length)
  return HAS_SCHEME.test(value) ? normalizeOrigin(value) : null
}

/**
 * 橋を出してよいか。いまのページの origin（`location.origin`）が、設定した Web 版の origin と**完全に**一致するときだけ。
 * 設定が無い（null）・ページが about:blank / data: / http など（origin が 'null' や https でない）ときは出さない
 */
export function shouldExposeBridge(locationOrigin: string, expectedOrigin: string | null): boolean {
  if (!expectedOrigin || !locationOrigin.startsWith('https://')) return false
  const actual = normalizeOrigin(locationOrigin)
  return actual !== null && actual === normalizeOrigin(expectedOrigin)
}

/**
 * 橋から来た内容を検査して、正規化した形にする（preload と main の両方で通す）。形が合わなければ null。
 * supabaseUrl は `https://` から始まる origin だけ（画像を送る先なので、スキームを補わない）
 */
export function parseSessionInput(v: unknown): AgentSessionInput | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const { accessToken, expiresAt, supabaseUrl, anonKey } = o
  if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 8192 || /\s/.test(accessToken)) return null
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) return null
  if (typeof supabaseUrl !== 'string' || !supabaseUrl.trim().toLowerCase().startsWith('https://')) return null
  const base = normalizeOrigin(supabaseUrl)
  if (base === null) return null
  if (typeof anonKey !== 'string' || anonKey.length < 20 || anonKey.length > 2048 || /\s/.test(anonKey)) return null
  return { accessToken, expiresAt, supabaseUrl: base, anonKey }
}

/** 橋の IPC のチャンネル名（preload と main で同じ文字列を使う） */
export const AGENT_SESSION_CHANNEL = 'agent:session'
export const AGENT_SESSION_CLEAR_CHANNEL = 'agent:session-clear'
