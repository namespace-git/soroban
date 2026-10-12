import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseJsonc, readRepoFile, REPO_ROOT, relativeFiles, walkImports } from './helpers'

// Workers の設定（wrangler.jsonc）・バンドルの中身・ビルドの後処理（postinstall）。Cloudflare には出ない。

interface WranglerConfig {
  name?: string
  main?: string
  compatibility_date?: string
  compatibility_flags?: string[]
  assets?: { directory?: string; binding?: string; not_found_handling?: string; run_worker_first?: unknown }
  triggers?: { crons?: string[] }
  keep_vars?: boolean
  vars?: Record<string, unknown>
  hyperdrive?: Array<Record<string, unknown>>
}

const configText = readRepoFile('wrangler.jsonc')
const config = parseJsonc(configText) as WranglerConfig

describe('wrangler.jsonc', () => {
  it('Worker の名前・入口・互換性', () => {
    expect(config.name).toBe('soroban')
    expect(config.main).toBe('worker/index.ts')
    expect(existsSync(join(REPO_ROOT, config.main as string))).toBe(true)
    expect(config.compatibility_date).toMatch(/^2025-\d{2}-\d{2}$/)
    // postgres.js が Node の API を使う
    expect(config.compatibility_flags).toContain('nodejs_compat')
  })

  it('静的アセット：Web 版のビルドの出力を、ASSETS で。画面の遷移は index.html に落とす。/api/* は必ず Worker へ', () => {
    expect(config.assets?.directory).toBe('./dist-web')
    // vite.config.web.ts の出力先と同じ
    expect(readRepoFile('vite.config.web.ts')).toMatch(/outDir:\s*resolve\(here,\s*'dist-web'\)/)
    expect(config.assets?.binding).toBe('ASSETS')
    expect(config.assets?.not_found_handling).toBe('single-page-application')
    expect(config.assets?.run_worker_first).toEqual(['/api/*'])
  })

  it('定期実行は 5 分ごと（同じ Worker の scheduled）', () => {
    expect(config.triggers?.crons).toEqual(['*/5 * * * *'])
    expect(readRepoFile('worker', 'index.ts')).toMatch(/async scheduled\(/)
  })

  it('画面で入れたプレーンテキストの変数をデプロイで消さない（keep_vars）', () => {
    expect(config.keep_vars).toBe(true)
  })

  it('vars は公開してよい値だけ：Supabase の URL と publishable キー（VAPID_SUBJECT・秘密は入れない）', () => {
    expect(Object.keys(config.vars ?? {}).sort()).toEqual(['SUPABASE_ANON_KEY', 'SUPABASE_URL'])
    expect(config.vars?.SUPABASE_URL).toMatch(/^https:\/\/[a-z0-9]{20}\.supabase\.co$/)
    expect(config.vars?.SUPABASE_ANON_KEY).toMatch(/^sb_publishable_[A-Za-z0-9_-]+$/)
  })

  it('秘密らしい値・名前が無い（このリポジトリは Public）', () => {
    // 値（設定のどこにあっても）
    const values: string[] = []
    const keys: string[] = []
    const collect = (v: unknown): void => {
      if (typeof v === 'string') values.push(v)
      else if (Array.isArray(v)) v.forEach(collect)
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          keys.push(k)
          collect(x)
        }
      }
    }
    collect(config)
    const SECRETISH_VALUE = [
      /sb_secret_/, /service_role/i, /postgres(ql)?:\/\//i, /mailto:/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/, // JWT（anon でも直書きしない。publishable キーを使う）
    ]
    for (const v of values) {
      for (const re of SECRETISH_VALUE) expect(v, `値 ${re}`).not.toMatch(re)
    }
    for (const k of keys) {
      expect(k, `キー ${k}`).not.toMatch(/VAPID|SECRET|PASSWORD|PRIVATE|TOKEN|DATABASE_URL|SERVICE_ROLE|localConnectionString/i)
    }
    // ファイル全体（コメントも）に、接続文字列・secret キーの現物が無い
    for (const re of [/sb_secret_[A-Za-z0-9]/, /postgres(ql)?:\/\/\S+@/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/]) {
      expect(configText, `${re}`).not.toMatch(re)
    }
  })

  it('hyperdrive を書くなら、HYPERDRIVE という名前と本物の id だけ（存在しない id はデプロイが失敗する／接続文字列は書かない）', () => {
    for (const h of config.hyperdrive ?? []) {
      expect(Object.keys(h).sort()).toEqual(['binding', 'id'])
      expect(h.binding).toBe('HYPERDRIVE')
      expect(h.id).toMatch(/^[0-9a-f]{32}$/)
    }
    // 書き方の案内がコメントにある（Hyperdrive を作ったあとの手順）
    expect(configText).toContain('"hyperdrive": [{ "binding": "HYPERDRIVE"')
  })
})

describe('入口の処理は 1 か所（server/entry.ts）', () => {
  it('Pages Functions と Worker の両方が server/entry.ts を呼び、自分では接続も通知も扱わない', () => {
    const rpc = readRepoFile('functions', 'api', 'rpc', '[method].ts')
    const agent = readRepoFile('functions', 'api', 'agent', '[method].ts')
    const worker = readRepoFile('worker', 'index.ts')
    expect(rpc).toContain('handleRpcEntry')
    expect(agent).toContain('handleAgentEntry')
    expect(worker).toContain('handleRpcEntry')
    expect(worker).toContain('handleAgentEntry')
    for (const [name, text] of [['functions/api/rpc', rpc], ['functions/api/agent', agent], ['worker/index.ts', worker]] as const) {
      expect(text, name).not.toMatch(/handleRpc\(|handleAgent\(|closeAfterResponse|mayQueueNotification/)
    }
    // 接続を作るのは、入口（entry.ts）と、定期実行（Worker の scheduled）だけ
    expect(rpc).not.toContain('createPostgresSql')
    expect(agent).not.toContain('createPostgresSql')
  })
})

describe('バンドルに electron・better-sqlite3 が入らない（import の鎖を辿る）', () => {
  it('worker/index.ts から届くファイルに、デスクトップ専用のものが無い', () => {
    const { files, bare } = walkImports(join(REPO_ROOT, 'worker', 'index.ts'))
    const rel = relativeFiles(files)
    // 辿れていること（数え間違いで空振りしていない）
    for (const expected of [
      'server/entry.ts', 'server/rpc.ts', 'server/agent/handler.ts', 'server/domain/index.ts', 'server/db/postgres.ts',
      'workers/cron/index.ts', 'server/cron/tracking.ts', 'server/push/deliver.ts', 'src/main/track17.ts',
    ]) {
      expect(rel, expected).toContain(expected)
    }

    for (const forbidden of ['electron', 'better-sqlite3', '@electric-sql/pglite', 'vue', 'vite', 'adm-zip', 'electron-updater']) {
      expect([...bare].filter((b) => b === forbidden || b.startsWith(`${forbidden}/`)), forbidden).toEqual([])
    }
    expect(rel.filter((f) => f.startsWith('src/renderer/') || f.startsWith('src/preload/'))).toEqual([])
    // デスクトップのメインプロセスから届くのは、Electron を読まない純粋なものだけ
    for (const f of rel.filter((x) => x.startsWith('src/main/'))) {
      expect(readRepoFile(f), f).not.toMatch(/from\s*['"](electron|better-sqlite3)['"]/)
    }
    // テスト用の部品（PGlite・テスト）は本番に入らない
    expect(rel.filter((f) => f.includes('__tests__') || f.includes('server/db/pglite') || f.includes('server/test/'))).toEqual([])
  })
})

describe('scripts/postinstall.cjs（Electron 用の作り直しを飛ばす条件）', () => {
  const script = join(REPO_ROOT, 'scripts', 'postinstall.cjs')
  const SKIP_VARS = ['CF_PAGES', 'WORKERS_CI', 'SOROBAN_SKIP_APP_DEPS']

  // 飛ばす側だけを実行する（飛ばさない側は electron-builder install-app-deps を実際に走らせてしまうので、ここでは動かさない）
  function run(env: Record<string, string>) {
    const base: Record<string, string | undefined> = { ...process.env }
    for (const name of SKIP_VARS) delete base[name]
    return spawnSync(process.execPath, [script], { env: { ...base, ...env }, encoding: 'utf8' })
  }

  it.each([
    ['CF_PAGES', 'Cloudflare Pages'],
    ['WORKERS_CI', 'Cloudflare Workers'],
    ['SOROBAN_SKIP_APP_DEPS', 'SOROBAN_SKIP_APP_DEPS'],
  ])('%s=1 なら飛ばして、成功で終わる', (name, what) => {
    const r = run({ [name]: '1' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('飛ばします')
    expect(r.stdout).toContain(what)
  })

  it('CI だけでは飛ばさない（GitHub Actions のリリースは Electron の作り直しが要る）', () => {
    const text = readRepoFile('scripts', 'postinstall.cjs')
    // コードに CI の判定が無い（コメントでの言及は除く）
    const code = text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/process\.env\.CI\b|\[\s*['"]CI['"]/)
    expect(code).not.toMatch(/['"]CI['"]/)
    // リリースのワークフローは、飛ばす指定を入れていない
    const release = readRepoFile('.github', 'workflows', 'release.yml')
    for (const name of SKIP_VARS) expect(release, name).not.toContain(name)
  })
})
