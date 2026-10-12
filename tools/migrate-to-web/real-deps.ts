import { readFileSync, writeFileSync } from 'node:fs'
import { createPostgresSql } from '../../server/db/postgres'
import { readSqliteViaElectron } from './electron-sqlite'
import type { FlowDeps } from './flow'
import { folderImageSource, SupabaseStorageUploader } from './images'
import { migrateToWeb } from './migrate'
import type { Prompter } from './prompt'
import { extractBackupZip } from './zip'

// zip の形（flow.ts）の、本物の部品。cli.ts だけが使う（PGlite・postgres.js・Electron の子プロセスを使うので、テストは読まない）。
// 全体は普通の Node で動く（Windows の Electron は端末を持たず、パスワードを伏せて聞けない）。SQLite を読むところだけ Electron の子

export function createRealDeps(prompter: Prompter | null): FlowDeps {
  return {
    extractZip: (zipFile) => extractBackupZip(zipFile),
    readSqlite: readSqliteViaElectron,
    imageSource: folderImageSource,
    async dryRun({ snapshot, source, migrationsDir, log }) {
      // 試走：Postgres（PGlite）の上でだけ。本番には何も送らない
      const { openDryRunTarget } = await import('./dry-run-db')
      const target = await openDryRunTarget(migrationsDir)
      try {
        return await migrateToWeb({
          sql: target.sql, householdId: target.householdId, snapshot, images: { source, uploader: null }, dryRun: true, log,
        })
      } finally {
        await target.close()
      }
    },
    migrate: migrateToWeb,
    openDatabase(url) {
      // Direct connection でも Session pooler（5432）でも Transaction pooler（6543）でも動くよう、prepared statement は使わない
      const db = createPostgresSql(url, { prepare: false })
      return { sql: db, end: () => db.end() }
    },
    makeUploader: (options) => new SupabaseStorageUploader(options),
    fetch: globalThis.fetch.bind(globalThis),
    readTextFile(path) {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    writeTextFile: (path, text) => writeFileSync(path, text),
    prompter,
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
    now: () => Date.now(),
    trapSignals(onSignal) {
      // 試走の途中などで Ctrl-C されたとき、帳簿の写しを置いたままにしない
      const handler = (): void => {
        onSignal()
        process.exit(130)
      }
      process.on('SIGINT', handler)
      process.on('SIGTERM', handler)
      return () => {
        process.removeListener('SIGINT', handler)
        process.removeListener('SIGTERM', handler)
      }
    },
  }
}
