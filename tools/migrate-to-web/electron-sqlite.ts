import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSqlite } from './read-sqlite'
import { snapshotFromJson, snapshotToJson } from './snapshot-json'
import type { SourceSnapshot } from './types'

// SQLite を読む部分だけを Electron の子プロセスでやる（better-sqlite3 が Electron 向けのため）。
// 全体は普通の Node で動かす：Windows の Electron は端末を持たず、パスワードを伏せて聞けないから（snapshot-json.ts）。
//   親（普通の Node） … readSqliteViaElectron：子を起動して、JSON を受け取る
//   子（Electron）    … dumpSqliteToJson   ：readSqlite して JSON にする（cli.ts の --dump-sqlite）

export const DUMP_FLAG = '--dump-sqlite'

/** Electron の実行ファイル。run.mjs が環境変数で渡す。無ければ electron パッケージから引く */
function electronPath(): string {
  return process.env.SOROBAN_MIGRATE_ELECTRON || (createRequire(import.meta.url)('electron') as string)
}

/** 子（Electron）の側：SQLite を読み、JSON にして outFile に書く */
export function dumpSqliteToJson(sqliteFile: string, outFile: string): void {
  writeFileSync(outFile, snapshotToJson(readSqlite(sqliteFile)), { mode: 0o600 })
}

/**
 * 親（普通の Node）の側：Electron の子に SQLite を読ませる。結果の JSON は SQLite のコピーと同じ一時フォルダに置く
 * （そのフォルダごと消える）。2 回目からは、置いた JSON を読み直すだけ
 */
export function readSqliteViaElectron(sqliteFile: string): SourceSnapshot {
  const jsonFile = join(dirname(sqliteFile), 'snapshot.json')
  if (!existsSync(jsonFile)) {
    // 接続の秘密を子に渡さない（SQLite を読むだけの子には要らない）
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    for (const name of ['SOROBAN_DATABASE_URL', 'SUPABASE_USER_JWT', 'SUPABASE_ANON_KEY']) delete env[name]
    // bundle は 1 つのファイル（cli.mjs）なので、import.meta.url は bundle 自身を指す。子も同じ bundle を --dump-sqlite で動かす
    const result = spawnSync(electronPath(), [fileURLToPath(import.meta.url), DUMP_FLAG, sqliteFile, jsonFile], {
      env, encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000,
    })
    if (result.error) throw new Error(`Electron を起動できません（SQLite を読むのに要ります）: ${result.error.message}`)
    if (result.status !== 0) {
      const detail = `${result.stderr ?? ''}`.trim().split('\n').slice(-3).join(' ').slice(0, 300)
      throw new Error(`SQLite を読めませんでした（終了コード ${String(result.status)}）${detail ? `: ${detail}` : ''}`)
    }
  }
  return snapshotFromJson(readFileSync(jsonFile, 'utf8'))
}
