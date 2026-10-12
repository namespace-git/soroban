// データ移行ツールの起動。cli.ts を bundle して、**普通の Node** で動かす。
//
//   pnpm migrate:web <バックアップの zip>                                   … ふつう。試走 → 値を聞く → 確認 → 本番（flow.ts）
//   pnpm migrate:web <バックアップの zip> --dry-run                         … 試走だけ
//   pnpm migrate:web <soroban.db> <thumbs のフォルダ> --dry-run             … 展開済みのファイルを渡す従来の形
//   pnpm migrate:web <soroban.db> <thumbs のフォルダ> --household <世帯の id>
//
// なぜ普通の Node か：パスワードを伏せ字で聞くには端末（TTY）の raw モードが要るが、Windows の Electron
// （ELECTRON_RUN_AS_NODE=1 でも）は端末を持たない（stdin/stdout の isTTY が undefined。実機で確認）。
// better-sqlite3 は Electron 向けにビルドされていて素の Node では開けないので、SQLite を読むところだけ Electron の子プロセスに
// 任せる（electron-sqlite.ts）。従来の形は、cli.ts が全体を Electron で動かし直す。
//
// bundle は node_modules/.cache/soroban-migrate/ に作る（git に入らない）。秘密は何も書かない

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(root, 'node_modules', '.cache', 'soroban-migrate')
const entry = join(root, 'tools', 'migrate-to-web', 'cli.ts')

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: entry,
    outDir,
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    rollupOptions: {
      // ネイティブ・WASM を持つものは bundle せず、実行時に node_modules から読む
      external: ['better-sqlite3', '@electric-sql/pglite', 'postgres', 'adm-zip', /^node:/],
      output: { format: 'es', entryFileNames: 'cli.mjs', inlineDynamicImports: true },
    },
  },
})

const electron = createRequire(import.meta.url)('electron')
const args = process.argv.slice(2)
// --migrations を省いたときは、このリポジトリの supabase/migrations を使う（どこから起動しても同じになるように）
if (!args.some((a) => a === '--migrations' || a.startsWith('--migrations='))) {
  args.push('--migrations', join(root, 'supabase', 'migrations'))
}
// wrangler.jsonc と supabase/.temp/pooler-url も、このリポジトリのものを使う
if (!args.some((a) => a === '--repo-root' || a.startsWith('--repo-root='))) {
  args.push('--repo-root', root)
}

// Ctrl-C は子にも届く。子が後片付け（一時フォルダを消す）をする間、こちらは先に終わらない
process.on('SIGINT', () => {})

const child = spawn(process.execPath, [join(outDir, 'cli.mjs'), ...args], {
  stdio: 'inherit',
  env: { ...process.env, SOROBAN_MIGRATE_ELECTRON: electron },
})
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
child.on('error', (e) => {
  console.error(`Node を起動できません: ${e.message}`)
  process.exitCode = 1
})
