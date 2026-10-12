// Web 版の起動。main.ts が VITE_TARGET === 'web' のときだけ動的 import する
// （Electron 版のビルドには supabase-js も HTTP クライアントも入れない）。
//
//   1. Supabase の設定があれば window.soroban を HTTP クライアントにする
//      （トークンは呼ぶたびに supabase-js のセッションから取る。ログイン前に差しても、呼ばれるまで何も起きない）
//      中身が変わるもの（CSV・出品先のページ・追跡・取り込み）とデスクトップ専用の呼び出しは api/web.ts が包む。
//      Web 版だけの API（取り込みの要求・Push 通知・取り込み担当の PC）は window.sorobanWeb
//   2. service worker を登録する（本番ビルドのときだけ）
//   3. いちばん外側の画面（WebRoot）を返す。ログインしていればそのままアプリ、していなければログイン画面、
//      設定が足りなければ「何が足りないか」の画面
import type { Component } from 'vue'
import { createHttpApi } from '../api/http'
import { createWebApi, createWebSoroban } from '../api/web'
import { registerServiceWorker } from '../api/service-worker'
import { configProblems } from './supabase'
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
  }
  registerServiceWorker()
  return WebRoot
}
