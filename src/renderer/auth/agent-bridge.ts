// 取り込み担当の PC（Electron の取り込み担当モードの窓）への、ログインの受け渡し。Web 版だけ。
//
// 取り込み担当モードの窓には、preload（src/preload/agent.ts）が `window.sorobanAgentBridge` を出す
// （Web 版の origin のときだけ）。ブラウザ・スマホ・デスクトップ版（ローカル）には無いので、そのときは何もしない。
// 渡すのは Supabase のアクセストークンなど。受け取った本体（main）はメモリにだけ持つ（保存しない）。
// ログインの状態が変わるたびに（トークンの更新も）渡し、ログアウトで捨てさせる。
import type { AgentSessionInput } from '../../preload/agent-bridge'

export interface AgentBridge {
  provideSession(session: AgentSessionInput): void
  clearSession(): void
}

declare global {
  interface Window {
    /** 取り込み担当モードの窓にだけ在る（preload が出す）。ブラウザ・デスクトップ版（ローカル）では undefined */
    sorobanAgentBridge?: AgentBridge
  }
}

/** supabase-js の Session のうち、渡すのに使う分 */
interface SessionLike {
  access_token: string
  expires_at?: number
  expires_in?: number
}

/** supabase.auth のうち、使う分（テストでは偽物を渡す） */
export interface AuthLike {
  onAuthStateChange(callback: (event: string, session: SessionLike | null) => void): unknown
}

/**
 * 橋があるときだけ、ログインの変化を渡す。橋が無ければ何もせず false。
 * コールバックの中では supabase の別の呼び出しをしない（デッドロックする）ので、状態を写して渡すだけ。
 * 橋の失敗でログインの処理を壊さない。
 */
export function connectAgentBridge(
  bridge: AgentBridge | undefined,
  auth: AuthLike,
  config: { supabaseUrl: string; anonKey: string },
  now: () => number = Date.now,
): boolean {
  if (!bridge) return false
  auth.onAuthStateChange((_event, session) => {
    try {
      if (session?.access_token) {
        bridge.provideSession({
          accessToken: session.access_token,
          // expires_at は Unix 秒。無ければ expires_in（秒）から数える
          expiresAt: session.expires_at ?? Math.floor(now() / 1000) + (session.expires_in ?? 3000),
          supabaseUrl: config.supabaseUrl,
          anonKey: config.anonKey,
        })
      } else {
        bridge.clearSession()
      }
    } catch {
      // 橋の失敗（窓の作り直しの最中など）で、画面のログインを壊さない
    }
  })
  return true
}
