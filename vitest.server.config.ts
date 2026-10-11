import { defineConfig } from 'vitest/config'

// Web 版のサーバー（Postgres）のテスト。Docker が無くても本物の Postgres で回すため PGlite を使う。
// 素の node で回す（Electron は要らない）
export default defineConfig({
  test: {
    include: ['server/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
  },
})
