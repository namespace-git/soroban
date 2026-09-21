/// <reference types="vite/client" />
import { createApp } from 'vue'
import App from './App.vue'
import type { SorobanApi } from '../shared/types'
// M PLUS 2（可変ウェイト）。CSP が default-src 'self' なので同梱して自前配信する。
// unicode-range で分割されているので、実際に使う字形の分だけ読まれる
import '@fontsource-variable/m-plus-2'
import './style.css'

async function boot() {
  if (window.sorobanBridge) {
    // contextBridge の境界に Vue のリアクティブ（Proxy）を渡すと Electron 42 以降は
    // 「An object could not be cloned」で落ちる。全メソッドの引数を JSON で素の値に戻す
    // （IPC の値は金額 integer・日付文字列・配列だけなので情報は落ちない）
    const bridge = window.sorobanBridge
    const plain = (v: unknown) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
    const wrapped = Object.fromEntries(
      Object.keys(bridge).map(k => [k, (...args: unknown[]) => (bridge as unknown as Record<string, (...a: unknown[]) => unknown>)[k](...args.map(plain))]),
    ) as unknown as SorobanApi
    Object.defineProperty(window, 'soroban', { value: wrapped, configurable: false, writable: false })
  } else if (import.meta.env.DEV) {
    // Electron 外（素のブラウザ）で開いたときだけモックを差す。
    // import.meta.env.DEV が false の本番ビルドではツリーシェイクされて含まれない
    const { installMock } = await import('./mock/soroban-mock')
    installMock()
  }
  const app = createApp(App)
  // 画面の処理で例外が出たら握りつぶさず、コンソールと画面（App.vue の通知）に出す
  app.config.errorHandler = (err) => {
    console.error(err)
    window.dispatchEvent(new CustomEvent('soroban:error', { detail: err instanceof Error ? err.message : String(err) }))
  }
  app.mount('#app')
}
boot()
