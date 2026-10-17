// setup:secrets の「判断」だけを切り出したもの（どれを入れるか・連絡先の整え方・伏せ字）。
// 外には何も触らない（wrangler も標準入力も呼ばない）ので、そのままテストできる。型は secrets-plan.d.mts。
// 使うのは secrets.mjs（pnpm setup:secrets）と、判断を確かめるテスト。
//
// 素の Node で動くよう .mjs で書いてある。

/** Worker に入れる実行時の Secret。この順で入れる */
export const SECRET_NAMES = ['SECRET_KEYS', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']

/**
 * VAPID_SUBJECT の形。server/push/vapid.ts の loadVapidKeys の検査と同じ（Apple は不正な sub を断る）。
 * そちらを変えたら、ここも揃える（テストが両方を通して確かめる）
 */
const VAPID_SUBJECT_PATTERN = /^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s/]+\S*)$/

/**
 * どの Secret を入れるか。
 *   ・すでにあるものは入れない。SECRET_KEYS を替えると保存済みの API キーが読めなくなり、
 *     VAPID を替えると通知の登録がやり直しになるため
 *   ・VAPID_PUBLIC_KEY と VAPID_PRIVATE_KEY は組。片方だけあるときは、どちらを残してもう片方を作っても組が合わないので止める
 *   ・force のときだけ、ある分も作り直す（overwrite に入れて、呼び出し側が影響を警告する）
 * put … 入れる名前 / skip … 触らない名前（すでにある） / overwrite … put のうち、すでにあって上書きするもの
 */
export function planSecrets(existingNames, { force = false } = {}) {
  const existing = new Set(existingNames)
  const hasPublic = existing.has('VAPID_PUBLIC_KEY')
  const hasPrivate = existing.has('VAPID_PRIVATE_KEY')
  if (!force && hasPublic !== hasPrivate) {
    const have = hasPublic ? 'VAPID_PUBLIC_KEY' : 'VAPID_PRIVATE_KEY'
    return {
      ok: false,
      error: `VAPID_PUBLIC_KEY と VAPID_PRIVATE_KEY は組で使いますが、片方だけ入っています（入っているのは ${have}）。Cloudflare の画面で両方消してからもう一度実行してください`,
    }
  }
  const put = SECRET_NAMES.filter((name) => force || !existing.has(name))
  const skip = SECRET_NAMES.filter((name) => !put.includes(name))
  const overwrite = put.filter((name) => existing.has(name))
  return { ok: true, put, skip, overwrite }
}

/**
 * `wrangler secret list` の出力（JSON の配列 `[{"name":"…","type":"secret_text"}]`）から、Secret の名前を読む。
 * 読めなければ null。wrangler が前後に案内の行を足しても、配列の部分だけを拾う
 */
export function parseSecretList(output) {
  const text = String(output ?? '').trim()
  const start = text.search(/^\[/m)
  const end = text.lastIndexOf(']')
  const candidates = [text]
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  for (const candidate of candidates) {
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue
    if (!parsed.every((item) => item && typeof item === 'object' && typeof item.name === 'string')) continue
    return parsed.map((item) => item.name)
  }
  return null
}

/**
 * 連絡先を VAPID_SUBJECT の形にそろえる。`foo@example.com` → `mailto:foo@example.com`、`https://…` はそのまま。
 * 形が合わなければ null（空・空白が入っている・`mailto:` だけ・@ が無い、など）
 */
export function normalizeSubject(input) {
  const text = String(input ?? '').trim()
  if (!text) return null
  const subject = text.startsWith('https://') ? text : `mailto:${text.replace(/^mailto:/i, '')}`
  return VAPID_SUBJECT_PATTERN.test(subject) ? subject : null
}

/**
 * コマンドラインの引数。`--force`、`--subject <連絡先>`（`--subject=<連絡先>` も可）。
 * `--` だけの引数は読み飛ばす（pnpm が `pnpm setup:secrets -- --force` のように渡すことがあるため）
 */
export function parseArgs(argv) {
  let force = false
  let subject = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--force') {
      force = true
      continue
    }
    let raw
    if (arg === '--subject') {
      raw = argv[++i]
      if (raw === undefined) return { ok: false, error: '--subject の後に連絡先（メールアドレス）を書いてください' }
    } else if (arg.startsWith('--subject=')) {
      raw = arg.slice('--subject='.length)
    } else {
      return { ok: false, error: `知らない引数です：${arg}（使えるのは --force と --subject だけです）` }
    }
    subject = normalizeSubject(raw)
    if (!subject) {
      return { ok: false, error: '--subject の値が連絡先として読めません。メールアドレス（foo@example.com）か、https:// で始まる URL にしてください' }
    }
  }
  return { ok: true, force, subject }
}

/**
 * 出力に入れた値が混ざっていたら `***` に置き換える。wrangler のエラーを画面に出す前に必ず通す。
 * 値そのものと、JSON の中で escape された形の両方を探す。長い値から置き換える（短い値が長い値の一部でも崩れない）
 */
export function redact(text, values) {
  const needles = new Set()
  for (const value of values) {
    if (!value) continue
    needles.add(value)
    needles.add(JSON.stringify(value).slice(1, -1))
  }
  let out = String(text ?? '')
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) out = out.replaceAll(needle, '***')
  return out
}
