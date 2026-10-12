// pnpm install の後処理。デスクトップ（Electron）用に better-sqlite3 などを作り直す（electron-builder install-app-deps）。
// Cloudflare Pages のビルド（Web 版）では Electron を使わないので飛ばす（Linux で作り直すと失敗するか、とても遅い）。
// Cloudflare Pages はビルドのときに CF_PAGES=1 を入れる
const { spawnSync } = require('node:child_process')

if (process.env.CF_PAGES) {
  console.log('[postinstall] Cloudflare Pages のビルドなので、Electron 用の作り直しを飛ばします')
  process.exit(0)
}

const r = spawnSync('electron-builder', ['install-app-deps'], { stdio: 'inherit', shell: true })
process.exit(r.status ?? 1)
