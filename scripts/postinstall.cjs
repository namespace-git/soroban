// pnpm install の後処理。デスクトップ（Electron）用に better-sqlite3 などを作り直す（electron-builder install-app-deps）。
// Web 版のビルド（Cloudflare）では Electron を使わないので飛ばす（Linux で作り直すと失敗するか、とても遅い）。
//   * Cloudflare Pages のビルドは CF_PAGES=1 を入れる
//   * Cloudflare Workers Builds は WORKERS_CI=1 を入れる（CF_PAGES は入らない）
//   * それ以外（別の CI など）で飛ばしたいときは SOROBAN_SKIP_APP_DEPS=1
// **CI だけでは飛ばさない**：GitHub Actions のリリース（.github/workflows/release.yml）は Electron の作り直しが要る
const { spawnSync } = require('node:child_process')

const SKIP = [
  ['CF_PAGES', 'Cloudflare Pages のビルド'],
  ['WORKERS_CI', 'Cloudflare Workers のビルド'],
  ['SOROBAN_SKIP_APP_DEPS', 'SOROBAN_SKIP_APP_DEPS の指定'],
]

for (const [name, what] of SKIP) {
  // 空文字と "0"・"false" は「指定なし」。Cloudflare は "1" を入れる
  const value = (process.env[name] ?? '').trim().toLowerCase()
  if (value !== '' && value !== '0' && value !== 'false') {
    console.log(`[postinstall] ${what}なので、Electron 用の作り直しを飛ばします`)
    process.exit(0)
  }
}

const r = spawnSync('electron-builder', ['install-app-deps'], { stdio: 'inherit', shell: true })
process.exit(r.status ?? 1)
