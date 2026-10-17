// Web 版の Worker「soroban」の実行時 Secret（SECRET_KEYS・VAPID_*）を、鍵を作ってそのまま入れる（手順書 2-4・2-5）。
//
//   pnpm setup:secrets                              … ない Secret だけ作って入れる（すでにある分は触らない）
//   pnpm setup:secrets --subject foo@example.com    … 通知の連絡先を聞かずに渡す
//   pnpm setup:secrets --force                      … ある分も作り直して上書きする（影響は実行時に画面に出す）
//
// 前提：`npx wrangler login` 済み。
// 鍵はここで乱数で作り、**画面・ログ・履歴・ファイルに残さない**。wrangler secret bulk には標準入力で渡す
// （コマンドラインの引数に入れるとプロセス一覧に出る）。人が覚える必要は無い（Worker の中にだけある）。
// 何を入れて何を飛ばすかの判断は secrets-plan.mjs（テストがある）。
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { generateSecretKeys, generateVapidKeys } from '../gen-keys/generate.mjs'
import { normalizeSubject, parseArgs, parseSecretList, planSecrets, redact } from './secrets-plan.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const worker = 'soroban'

function run(cmd, args, opts = {}) {
  // Windows の npx は .cmd なので shell 経由。引数はダブルクォートで包む（中にダブルクォートは入らない値だけ渡す）
  const quoted = args.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `"${a}"`))
  return spawnSync(cmd, quoted, { cwd: root, shell: true, encoding: 'utf8', ...opts })
}

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

/** Worker にいま入っている Secret の名前（値は wrangler も返さない） */
function listSecretNames() {
  const r = run('npx', ['--yes', 'wrangler', 'secret', 'list', '--name', worker, '--format', 'json'])
  if (r.status !== 0) fail(`Secret の一覧を読めませんでした（wrangler secret list）：\n${r.stderr || r.stdout}`)
  const names = parseSecretList(r.stdout)
  if (!names) fail(`Secret の一覧の出力を読めませんでした：\n${r.stdout}`)
  return names
}

/** 通知の連絡先を聞く。形が合わなければ聞き直す（3 回まで）。秘密ではないので伏せ字にしない */
async function askSubject() {
  if (!process.stdin.isTTY) {
    fail('連絡先を聞けません（対話できない場所です）。`--subject foo@example.com` で渡してください')
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const closed = new Promise((resolveClosed) => rl.once('close', () => resolveClosed(null)))
  try {
    for (let i = 0; i < 3; i++) {
      const answer = await Promise.race([
        new Promise((resolveAnswer) => rl.question('通知の送り主の連絡先（メールアドレス）：', resolveAnswer)),
        closed,
      ])
      if (answer === null) fail('入力が途中で閉じられました。何も入れていません')
      const subject = normalizeSubject(answer)
      if (subject) return subject
      console.log('  メールアドレスとして読めません（例：foo@example.com。空白は入れられません）。もう一度')
    }
  } finally {
    rl.close()
  }
  fail('連絡先を 3 回続けて読めませんでした。何も入れていません')
}

const args = parseArgs(process.argv.slice(2))
if (!args.ok) fail(args.error)

// --- 前提の確認 ---
const who = run('npx', ['--yes', 'wrangler', 'whoami'])
if (who.status !== 0 || /not authenticated|You are not logged in/i.test(`${who.stdout}${who.stderr}`)) {
  fail('Cloudflare にログインしていません。先に `npx wrangler login` をしてください（ブラウザが開きます）')
}

// --- 1. どれを入れるか決める ---
console.log(`1/3 Worker「${worker}」にある Secret を確かめています…`)
const plan = planSecrets(listSecretNames(), { force: args.force })
if (!plan.ok) fail(plan.error)
if (plan.put.length === 0) {
  console.log('\n4 つとも入っています。何もしません')
  process.exit(0)
}

if (plan.overwrite.length > 0) {
  console.log('\n⚠ --force：すでにある Secret を作り直して上書きします。')
  if (plan.overwrite.includes('SECRET_KEYS')) {
    console.log('  ・SECRET_KEYS … 保存済みの Gemini・17TRACK の API キーが読めなくなります（設定で入れ直し）')
  }
  if (plan.overwrite.includes('VAPID_PUBLIC_KEY')) {
    console.log('  ・VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY … 通知の登録がやり直しになります（各端末で通知をもう一度オンにする）')
  }
}

// --- 2. 鍵を作る ---
let subject = null
if (plan.put.includes('VAPID_SUBJECT')) subject = args.subject ?? (await askSubject())
else if (args.subject) console.log('\nVAPID_SUBJECT はすでに入っているので、--subject は使いません')

console.log('2/3 鍵を作っています…')
const values = {}
if (plan.put.includes('SECRET_KEYS')) values.SECRET_KEYS = generateSecretKeys()
if (plan.put.includes('VAPID_PUBLIC_KEY')) {
  const vapid = await generateVapidKeys()
  values.VAPID_PUBLIC_KEY = vapid.publicKey
  values.VAPID_PRIVATE_KEY = vapid.privateKey
}
if (subject) values.VAPID_SUBJECT = subject
if (Object.keys(values).sort().join() !== [...plan.put].sort().join()) {
  fail('作った鍵と入れる予定が合いません（このスクリプトの不具合です）。何も入れていません')
}

// --- 3. Worker の Secret に入れる ---
// JSON は標準入力で渡す。wrangler はファイルの指定が無ければ標準入力を読む。引数にもファイルにも値は載らない
console.log(`3/3 Worker「${worker}」の Secret に入れています…`)
const secretValues = Object.values(values)
const bulk = run('npx', ['--yes', 'wrangler', 'secret', 'bulk', '--name', worker], { input: `${JSON.stringify(values)}\n` })
const bulkOut = redact(`${bulk.stdout ?? ''}${bulk.stderr ?? ''}${bulk.error?.message ?? ''}`, secretValues)
if (bulk.status !== 0) fail(`Secret を入れられませんでした（wrangler secret bulk）：\n${bulkOut}`)

// wrangler が 0 で終わっても何も入っていない（標準入力が空だった等）ことがあるので、一覧で確かめる
const after = listSecretNames()
const missing = plan.put.filter((name) => !after.includes(name))
if (missing.length > 0) fail(`wrangler は終わりましたが、Secret の一覧に ${missing.join('・')} が出ていません：\n${bulkOut}`)

console.log('\n✓ Cloudflare の Worker に入れました（値はここには出しません）。数十秒で反映されます。')
console.log(`\n入れたもの：${plan.put.join('、')}`)
if (plan.skip.length > 0) console.log(`飛ばしたもの（すでに入っているので触っていません）：${plan.skip.join('、')}`)
