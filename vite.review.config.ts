// レビュー用の設定。electron-vite dev は Electron 本体を起動して実 DB で収集が走るため、
// プレーンな vite でレンダラーだけを mock データでブラウザ確認する（pnpm exec vite --config vite.review.config.ts）。
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: `${here}src/renderer`,
  plugins: [vue()],
  resolve: {
    alias: { '@shared': `${here}src/shared` },
  },
  server: { port: 5199, strictPort: true },
})
