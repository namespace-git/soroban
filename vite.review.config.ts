// レビュー用の一時的な設定。electron-vite dev は Electron GUI を起動してしまうため、
// プレーンな vite でレンダラーだけをブラウザ確認する。リポジトリには置かない。
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

const root = 'C:/Users/suito/Projects/soroban/src/renderer'

export default defineConfig({
  root,
  plugins: [vue()],
  resolve: {
    alias: { '@shared': resolve('C:/Users/suito/Projects/soroban/src/shared') },
  },
  server: { port: 5199, strictPort: true },
})
