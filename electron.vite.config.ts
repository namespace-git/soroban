import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    // better-sqlite3 はネイティブモジュール。バンドルせず外部に出す
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // agent は取り込み担当モードの窓（Web 版を開く）専用。index.ts とは何も共有しない
        // （sandbox の preload は別ファイルを require できないので、共有の塊が出ないようにしておく）
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          agent: resolve(__dirname, 'src/preload/agent.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [vue()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
})
