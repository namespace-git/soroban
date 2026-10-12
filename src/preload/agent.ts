import { contextBridge, ipcRenderer } from 'electron'
import {
  AGENT_SESSION_CHANNEL, AGENT_SESSION_CLEAR_CHANNEL, originFromArgv, parseSessionInput, shouldExposeBridge,
} from './agent-bridge'

// ============================================================
// 取り込み担当モードの窓（Web 版を開く）の preload
//
// 出すのは window.sorobanAgentBridge だけ（SorobanApi は出さない＝この窓から帳簿の IPC には触れない）。
//   provideSession({ accessToken, expiresAt, supabaseUrl, anonKey }) … Web 版のログイン（トークン）を main に渡す
//   clearSession()                                                     … ログアウトを main に知らせる
// **location.origin が設定した Web 版の origin と一致するときだけ**出す（判定は agent-bridge.ts の純粋な関数）。
// トークンはここでも保持しない（受け取ったらそのまま main に送るだけ）。main はメモリにだけ持つ。
// ============================================================

const expected = originFromArgv(process.argv)

if (shouldExposeBridge(location.origin, expected)) {
  contextBridge.exposeInMainWorld('sorobanAgentBridge', {
    provideSession(session: unknown): void {
      const parsed = parseSessionInput(session)
      if (parsed) ipcRenderer.send(AGENT_SESSION_CHANNEL, parsed)
    },
    clearSession(): void {
      ipcRenderer.send(AGENT_SESSION_CLEAR_CHANNEL)
    },
  })
}
