// Web 版の起動。main.ts が VITE_TARGET === 'web' のときだけ動的 import する
// （Electron 版のビルドには supabase-js も HTTP クライアントも入れない）。
//
//   1. Supabase の設定があれば window.soroban を HTTP クライアントにする
//      （トークンは呼ぶたびに supabase-js のセッションから取る。ログイン前に差しても、呼ばれるまで何も起きない）
//      中身が変わるもの（CSV・出品先のページ・追跡・取り込み）とデスクトップ専用の呼び出しは api/web.ts が包む。
//      Web 版だけの API（取り込みの要求・Push 通知・取り込み担当の PC）は window.sorobanWeb
//   2. 取り込み担当の PC の窓（preload が window.sorobanAgentBridge を出す）なら、ログインの変化を本体に渡す
//      （トークンの更新も。ログアウトで捨てさせる。橋が無ければ何もしない）
//   3. service worker を登録する（本番ビルドのときだけ）
//   4. いちばん外側の画面（WebRoot）を返す。ログインしていればそのままアプリ、していなければログイン画面、
//      設定が足りなければ「何が足りないか」の画面
import type { Component } from 'vue'
import { createHttpApi } from '../api/http'
import { createWebApi, createWebSoroban } from '../api/web'
import { registerServiceWorker } from '../api/service-worker'
import { connectAgentBridge } from './agent-bridge'
import { configProblems, getSupabase } from './supabase'
import { getAccessToken, signOut } from './session'
import WebRoot from './WebRoot.vue'

export function setupWeb(): Component {
  if (configProblems().length === 0) {
    const options = {
      base: import.meta.env.VITE_API_BASE || '/api',
      getToken: getAccessToken,
      onUnauthorized: () => { void signOut() },
    }
    const web = createWebApi(options)
    const api = createWebSoroban(createHttpApi(options), web)
    // Electron 版の包み（main.ts）と同じく、あとから差し替えられないようにする
    Object.defineProperty(window, 'soroban', { value: api, configurable: false, writable: false })
    Object.defineProperty(window, 'sorobanWeb', { value: web, configurable: false, writable: false })
    // 取り込み担当の PC（Electron の取り込み担当モードの窓）で開いているときだけ、ログインを本体に渡す。
    // 橋が無い（ブラウザ・スマホ・デスクトップ版）なら何もしない
    const bridge = window.sorobanAgentBridge
    if (bridge) {
      connectAgentBridge(bridge, getSupabase().auth, {
        supabaseUrl: (import.meta.env.VITE_SUPABASE_URL ?? '').trim(),
        anonKey: (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim(),
      })
    }
  }
  registerServiceWorker()
  return WebRoot
}
