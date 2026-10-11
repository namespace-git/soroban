// Web 版の起動。main.ts が VITE_TARGET === 'web' のときだけ動的 import する
// （Electron 版のビルドには supabase-js も HTTP クライアントも入れない）。
//
//   1. Supabase の設定があれば window.soroban を HTTP クライアントにする
//      （トークンは呼ぶたびに supabase-js のセッションから取る。ログイン前に差しても、呼ばれるまで何も起きない）
//   2. service worker を登録する（本番ビルドのときだけ）
//   3. いちばん外側の画面（WebRoot）を返す。ログインしていればそのままアプリ、していなければログイン画面、
//      設定が足りなければ「何が足りないか」の画面
import type { Component } from 'vue'
import { createHttpApi } from '../api/http'
import { registerServiceWorker } from '../api/service-worker'
import { configProblems } from './supabase'
import { getAccessToken, signOut } from './session'
import WebRoot from './WebRoot.vue'

export function setupWeb(): Component {
  if (configProblems().length === 0) {
    const api = createHttpApi({
      base: import.meta.env.VITE_API_BASE || '/api',
      getToken: getAccessToken,
      onUnauthorized: () => { void signOut() },
    })
    // Electron 版の包み（main.ts）と同じく、あとから差し替えられないようにする
    Object.defineProperty(window, 'soroban', { value: api, configurable: false, writable: false })
  }
  registerServiceWorker()
  return WebRoot
}
