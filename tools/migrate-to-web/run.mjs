// データ移行ツールの起動。cli.ts を bundle して、Electron の Node（ELECTRON_RUN_AS_NODE=1）で動かす。
// better-sqlite3 は Electron 向けにビルドされていて、素の Node では開けないため（pnpm test と同じ事情）。
//
//   pnpm migrate:web <soroban.db> <thumbs のフォルダ> --dry-run
//   pnpm migrate:web <soroban.db> <thumbs のフォルダ> --household <世帯の id>
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
      external: ['better-sqlite3', '@electric-sql/pglite', 'postgres', /^node:/],
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

const child = spawn(electron, [join(outDir, 'cli.mjs'), ...args], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
child.on('error', (e) => {
  console.error(`Electron を起動できません: ${e.message}`)
  process.exitCode = 1
})
