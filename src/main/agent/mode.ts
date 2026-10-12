import { normalizeOrigin } from '../../preload/agent-bridge'

// ============================================================
// 取り込み担当モードの判定・設定の検査・窓の出入りの規則（electron に依存しない純粋な関数）
//
// ローカルの設定（SQLite の setting）
//   web_agent_enabled … '1' のとき取り込み担当モード
//   web_agent_url     … Web 版の origin（https:// のみ）
//   web_agent_name    … 端末名（空ならこの PC のホスト名）
// ============================================================

export const AGENT_WINDOW_TITLE = 'そろばん（取り込み担当）'

/** 取り込み担当の窓がログインを保つ場所（ブラウザと同じ。私たちのコードはファイルに書かない） */
export const AGENT_PARTITION = 'persist:soroban-web'

export type AgentMode =
  | { agent: false }
  | { agent: true; origin: string; deviceName: string }

const NAME_MAX = 200

/** 端末名。空ならホスト名。長すぎれば切る */
export function resolveDeviceName(raw: string | undefined, hostname: string): string {
  const name = (raw ?? '').trim() || hostname.trim() || 'この PC'
  return [...name].slice(0, NAME_MAX).join('')
}

/**
 * ローカルの設定からモードを決める。`web_agent_enabled` が '1' でも、URL が https の origin として読めなければ
 * ローカルモードで起動する（設定の不備でアプリが開かなくならないように）
 */
export function resolveAgentMode(settings: Record<string, string>, hostname: string): AgentMode {
  if (settings.web_agent_enabled !== '1') return { agent: false }
  const origin = normalizeOrigin(settings.web_agent_url ?? '')
  if (!origin) return { agent: false }
  return { agent: true, origin, deviceName: resolveDeviceName(settings.web_agent_name, hostname) }
}

/** 取り込み担当の窓がたどってよい先：Web 版の origin だけ */
export function isAllowedNavigation(url: string, origin: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.origin === origin
  } catch {
    return false
  }
}

/** window.open の外部リンクを OS のブラウザで開いてよいか：https だけ（それ以外は開かない）。開く URL を返す */
export function externalUrlToOpen(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null
    return u.toString()
  } catch {
    return null
  }
}

/** IPC の送り元（橋を出した窓のページ）が、設定した Web 版の origin か */
export function isTrustedSender(senderUrl: string | undefined | null, origin: string): boolean {
  return !!senderUrl && isAllowedNavigation(senderUrl, origin)
}

export class SettingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingError'
  }
}

/**
 * setSetting に来た取り込み担当の設定を検査して、保存する値を返す（それ以外のキーは何もせずそのまま返す）。
 *  - web_agent_url     … https の origin にそろえる。空は消す。読めなければ日本語のエラー
 *  - web_agent_name    … 前後の空白を除く。長すぎれば切る
 *  - web_agent_enabled … '1' / '0' だけ。'1' にできるのは、URL が保存済みのとき
 */
export function validateAgentSetting(key: string, value: string, current: Record<string, string>): string {
  if (key === 'web_agent_url') {
    const text = value.trim()
    if (!text) return ''
    const origin = normalizeOrigin(text)
    if (!origin) throw new SettingError('Web 版の URL は https:// から始まるアドレスを入れてください')
    return origin
  }
  if (key === 'web_agent_name') {
    return [...value.trim()].slice(0, NAME_MAX).join('')
  }
  if (key === 'web_agent_enabled') {
    if (value !== '1' && value !== '0') throw new SettingError('取り込み担当の設定の値が正しくありません')
    if (value === '1' && !normalizeOrigin(current.web_agent_url ?? '')) {
      throw new SettingError('先に Web 版の URL（https:// から始まるアドレス）を入れてください')
    }
    return value
  }
  return value
}
