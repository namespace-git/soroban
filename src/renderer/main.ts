/// <reference types="vite/client" />
import { createApp } from 'vue'
import App from './App.vue'
// M PLUS 2（可変ウェイト）。CSP が default-src 'self' なので同梱して自前配信する。
// unicode-range で分割されているので、実際に使う字形の分だけ読まれる
import '@fontsource-variable/m-plus-2'
import './style.css'

async function boot() {
  // 開発時に Electron 外（素のブラウザ）で開いたときだけモックを差す。
  // import.meta.env.DEV が false の本番ビルドではツリーシェイクされて含まれない
  if (import.meta.env.DEV && !window.soroban) {
    const { installMock } = await import('./mock/soroban-mock')
    installMock()
  }
  createApp(App).mount('#app')
}
boot()
