// API の接続用ロール soroban_gateway にパスワードを付け、Cloudflare の Hyperdrive を作る（手順書 1-8 と Hyperdrive）。
//
//   pnpm setup:gateway                 … 新しく作る（パスワードを付ける → Hyperdrive「soroban」を作る → ID を出す）
//   pnpm setup:gateway --update <id>   … パスワードを付け直し、既存の Hyperdrive のパスワードも差し替える
//
// 前提：`supabase link` 済み（supabase/.temp/pooler-url がある）・`npx wrangler login` 済み。
// パスワードはここで乱数で作り、**画面・ログ・履歴・ファイルに残さない**（SQL は一時ファイル経由で渡してすぐ消す）。
// 人が覚える必要は無い（Hyperdrive の中にだけある）。分からなくなったら --update で付け直せばよい。
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function run(cmd, args, opts = {}) {
  // Windows の npx / supabase は .cmd なので shell 経由。引数はダブルクォートで包む（中にダブルクォートは入らない値だけ渡す）
  const quoted = args.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `"${a}"`))
  return spawnSync(cmd, quoted, { cwd: root, shell: true, encoding: 'utf8', ...opts })
}

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

// --- 前提の確認 ---
let pooler
try {
  pooler = readFileSync(join(root, 'supabase/.temp/pooler-url'), 'utf8').trim()
} catch {
  fail('supabase/.temp/pooler-url がありません。先に `supabase link --project-ref <ref>` をしてください')
}
const m = /^postgres(?:ql)?:\/\/postgres\.([a-z0-9]+)@([^/:]+):(\d+)\/(\w+)$/.exec(pooler)
if (!m) fail(`Session pooler の接続先の形が想定と違います：${pooler}`)
const [, ref, host, port, database] = m
if (port !== '5432') fail(`Session pooler（5432）ではありません：ポート ${port}`)

const updateIndex = process.argv.indexOf('--update')
const updateId = updateIndex >= 0 ? process.argv[updateIndex + 1] : null
if (updateIndex >= 0 && !/^[0-9a-f]{32}$/.test(updateId ?? '')) fail('--update の後に Hyperdrive の ID（32 桁の英数字）を書いてください')

const who = run('npx', ['--yes', 'wrangler', 'whoami'])
if (who.status !== 0 || /not authenticated|You are not logged in/i.test(`${who.stdout}${who.stderr}`)) {
  fail('Cloudflare にログインしていません。先に `npx wrangler login` をしてください（ブラウザが開きます）')
}

// --- 1. soroban_gateway にパスワードを付ける ---
// 英数字と - _ だけ（SQL と URL にそのまま入る）。先頭は英字（- で始まるとコマンドの引数で旗に見える）
const password = `g${randomBytes(32).toString('base64url')}`
const dir = mkdtempSync(join(tmpdir(), 'soroban-gw-'))
const sqlFile = join(dir, 'gateway.sql')
try {
  writeFileSync(sqlFile, `alter role soroban_gateway with login password '${password}';\n`, { mode: 0o600 })
  console.log('1/2 soroban_gateway にパスワードを付けています…')
  const r = run('supabase', ['db', 'query', '--linked', '--file', sqlFile])
  if (r.status !== 0) fail(`パスワードを付けられませんでした（supabase db query）：\n${(r.stderr || r.stdout).replaceAll(password, '***')}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// --- 2. Hyperdrive を作る（または差し替える） ---
const user = `soroban_gateway.${ref}`
console.log(updateId ? `2/2 Hyperdrive ${updateId} のパスワードを差し替えています…` : '2/2 Hyperdrive「soroban」を作っています…')
const args = updateId
  ? ['--yes', 'wrangler', 'hyperdrive', 'update', updateId, '--origin-user', user, '--origin-password', password]
  : ['--yes', 'wrangler', 'hyperdrive', 'create', 'soroban',
     '--connection-string', `postgresql://${user}:${password}@${host}:${port}/${database}`]
const h = run('npx', args)
const out = `${h.stdout ?? ''}${h.stderr ?? ''}`.replaceAll(password, '***')
if (h.status !== 0) fail(`Hyperdrive を${updateId ? '差し替え' : '作れ'}ませんでした：\n${out}`)

const id = updateId ?? (/"id"\s*:\s*"([0-9a-f]{32})"/.exec(out) ?? /\bid\s*=\s*"([0-9a-f]{32})"/.exec(out) ?? [])[1]
console.log('\n✓ できました。パスワードは Supabase と Hyperdrive の中にだけあります（ここには出しません）')
if (id) console.log(`\nHyperdrive の ID：${id}\nこの ID を Claude に伝えてください（ID は秘密ではありません）`)
else console.log(`\nHyperdrive の ID を出力から読めませんでした。Cloudflare の画面（Storage & databases → Hyperdrive）で確かめてください。\n${out}`)
