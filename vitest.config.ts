import { defineConfig, configDefaults } from 'vitest/config'

// デスクトップ版（SQLite）のテスト。pnpm test が Electron の node で回す。
// server/ は Web 版（Postgres・PGlite）のテストなので別のコマンド（pnpm test:server）に分ける
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'server/**'],
  },
})
