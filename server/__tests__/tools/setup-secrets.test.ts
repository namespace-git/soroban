import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateSecretKeys, generateVapidKeys } from '../../../tools/gen-keys/generate.mjs'
import {
  SECRET_NAMES,
  normalizeSubject,
  parseArgs,
  parseSecretList,
  planSecrets,
  redact,
} from '../../../tools/setup-web/secrets-plan.mjs'
import { VapidConfigError, loadVapidKeys } from '../../push/vapid'

// 鍵を作って Worker の Secret に入れる道具（tools/setup-web/secrets.mjs）の「判断」の部分。
// wrangler は呼ばない。鍵の値はテストの中で作る（リポジトリにも出力にも鍵を残さない）

const all = [...SECRET_NAMES]
const pathOf = (rel: string): string => fileURLToPath(new URL(`../../../${rel}`, import.meta.url))

describe('どの Secret を入れるか（planSecrets）', () => {
  it('何も入っていない → 4 つとも入れる', () => {
    const plan = planSecrets([])
    expect(plan).toEqual({ ok: true, put: all, skip: [], overwrite: [] })
  })

  it('4 つとも入っている → 何もしない（全部飛ばす）', () => {
    const plan = planSecrets(all)
    expect(plan).toEqual({ ok: true, put: [], skip: all, overwrite: [] })
  })

  it('SECRET_KEYS だけある → VAPID の 3 つだけ入れる（SECRET_KEYS は触らない）', () => {
    const plan = planSecrets(['SECRET_KEYS'])
    expect(plan).toEqual({
      ok: true,
      put: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
      skip: ['SECRET_KEYS'],
      overwrite: [],
    })
  })

  it('VAPID の鍵の組はあるが連絡先が無い → VAPID_SUBJECT だけ入れる（鍵は替えない）', () => {
    const plan = planSecrets(['SECRET_KEYS', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'])
    expect(plan).toEqual({ ok: true, put: ['VAPID_SUBJECT'], skip: ['SECRET_KEYS', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'], overwrite: [] })
  })

  it('4 つ以外の名前が混ざっていても無視する', () => {
    const plan = planSecrets(['OTHER_TOKEN', 'SECRET_KEYS'])
    expect(plan).toMatchObject({ ok: true, put: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'], skip: ['SECRET_KEYS'] })
  })

  it('VAPID の片方だけ → エラー（どちらが入っているかを言う。値は持たない）', () => {
    for (const have of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) {
      const plan = planSecrets([have])
      expect(plan.ok).toBe(false)
      if (plan.ok) continue
      expect(plan.error).toContain('片方だけ入っています')
      expect(plan.error).toContain('両方消してからもう一度')
      expect(plan.error).toContain(have)
    }
  })

  it('--force → ある分も含めて 4 つ全部入れる。上書きになるものを overwrite に出す', () => {
    expect(planSecrets([], { force: true })).toEqual({ ok: true, put: all, skip: [], overwrite: [] })
    expect(planSecrets(all, { force: true })).toEqual({ ok: true, put: all, skip: [], overwrite: all })
    expect(planSecrets(['SECRET_KEYS'], { force: true })).toEqual({ ok: true, put: all, skip: [], overwrite: ['SECRET_KEYS'] })
  })

  it('--force なら VAPID の片方だけでもエラーにしない（両方作り直すので組は揃う）', () => {
    const plan = planSecrets(['VAPID_PUBLIC_KEY'], { force: true })
    expect(plan).toEqual({ ok: true, put: all, skip: [], overwrite: ['VAPID_PUBLIC_KEY'] })
  })
})

describe('連絡先を VAPID_SUBJECT の形にする（normalizeSubject）', () => {
  it('メールアドレスには mailto: を付ける。付いていればそのまま', () => {
    expect(normalizeSubject('foo@example.com')).toBe('mailto:foo@example.com')
    expect(normalizeSubject('mailto:foo@example.com')).toBe('mailto:foo@example.com')
    expect(normalizeSubject('  foo@example.com \n')).toBe('mailto:foo@example.com')
    expect(normalizeSubject('MAILTO:foo@example.com')).toBe('mailto:foo@example.com')
  })

  it('https:// の URL はそのまま', () => {
    expect(normalizeSubject('https://example.com')).toBe('https://example.com')
    expect(normalizeSubject('https://example.com/contact')).toBe('https://example.com/contact')
  })

  it('空・空白入り・mailto: だけ・@ が無い・https 以外の URL は不可', () => {
    for (const bad of ['', '   ', 'mailto:', 'foo bar@example.com', 'foo@example .com', 'foo', 'mailto:foo', 'https://', 'http://example.com', 'ftp://example.com']) {
      expect(normalizeSubject(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('整えた値は、サーバー（loadVapidKeys）の検査を通る。通らなかった値は、サーバーも断る', async () => {
    const keys = await generateVapidKeys()
    const load = (subject: string) => loadVapidKeys({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: subject })
    for (const good of ['foo@example.com', 'mailto:foo@example.com', 'https://example.com', 'https://example.com/contact']) {
      const subject = normalizeSubject(good)
      expect(subject, good).not.toBeNull()
      expect(await load(subject!), good).not.toBeNull()
    }
    // こちらが通さないと決めた値は、mailto: を付けた形でもサーバーが断る（検査が食い違っていない）
    for (const bad of ['mailto:', 'mailto:foo', 'mailto:foo bar@example.com', 'mailto:http://example.com', 'https://']) {
      await expect(load(bad), bad).rejects.toBeInstanceOf(VapidConfigError)
    }
  })
})

describe('コマンドラインの引数（parseArgs）', () => {
  it('引数なし → force なし・連絡先なし', () => {
    expect(parseArgs([])).toEqual({ ok: true, force: false, subject: null })
  })

  it('--force', () => {
    expect(parseArgs(['--force'])).toEqual({ ok: true, force: true, subject: null })
  })

  it('--subject は mailto: を付けて渡す。`--subject=` の形も、pnpm が付ける `--` も読める', () => {
    expect(parseArgs(['--subject', 'foo@example.com'])).toEqual({ ok: true, force: false, subject: 'mailto:foo@example.com' })
    expect(parseArgs(['--subject=https://example.com'])).toEqual({ ok: true, force: false, subject: 'https://example.com' })
    expect(parseArgs(['--', '--force', '--subject', 'mailto:foo@example.com'])).toEqual({ ok: true, force: true, subject: 'mailto:foo@example.com' })
  })

  it('連絡先が読めない・値が無い・知らない引数 → エラー', () => {
    for (const bad of [['--subject', 'foo'], ['--subject='], ['--subject'], ['--force=1'], ['--yes'], ['foo@example.com']]) {
      const r = parseArgs(bad)
      expect(r.ok, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('wrangler secret list の出力（parseSecretList）', () => {
  it('JSON の配列から名前を読む', () => {
    const out = JSON.stringify([{ name: 'SECRET_KEYS', type: 'secret_text' }, { name: 'VAPID_SUBJECT', type: 'secret_text' }], null, '  ')
    expect(parseSecretList(out)).toEqual(['SECRET_KEYS', 'VAPID_SUBJECT'])
  })

  it('何も入っていない `[]` は空の一覧（読めなかったのとは区別する）', () => {
    expect(parseSecretList('[]\n')).toEqual([])
  })

  it('前後に案内の行があっても、配列の部分を拾う', () => {
    const out = ' ⛅️ wrangler 4.0.0\n[\n  { "name": "SECRET_KEYS", "type": "secret_text" }\n]\nUpdate available\n'
    expect(parseSecretList(out)).toEqual(['SECRET_KEYS'])
  })

  it('読めない出力は null（配列でない・名前が無い・空）', () => {
    for (const bad of ['', 'Worker not found', '{"name":"SECRET_KEYS"}', '[{"type":"secret_text"}]', '[1, 2]', '[{"name":']) {
      expect(parseSecretList(bad), bad).toBeNull()
    }
  })
})

describe('出力の伏せ字（redact）', () => {
  it('入れた値すべてを *** に置き換える。同じ値が複数回出ても全部', async () => {
    const vapid = await generateVapidKeys()
    const values = [generateSecretKeys(), vapid.publicKey, vapid.privateKey, 'mailto:foo@example.com']
    const text = [
      `error: ${values[0]} was rejected`,
      `${values[1]} / ${values[1]}`,
      `{"VAPID_PRIVATE_KEY":"${values[2]}","VAPID_SUBJECT":"${values[3]}"}`,
      `again ${values[2]} and ${values[0]}`,
    ].join('\n')
    const out = redact(text, values)
    for (const v of values) expect(out).not.toContain(v)
    expect(out.match(/\*\*\*/g)).toHaveLength(7)
    expect(out).toContain('error: *** was rejected')
  })

  it('JSON の中で escape された形（" や \\ を含む値）も置き換える', () => {
    const value = 'a"b\\c'
    const out = redact(`payload ${JSON.stringify({ k: value })} raw ${value}`, [value])
    expect(out).not.toContain('a"b')
    expect(out).not.toContain('a\\"b')
    expect(out).toBe('payload {"k":"***"} raw ***')
  })

  it('値が空のときは何もしない（空文字で置き換えると全部の文字の間に *** が入る）', () => {
    expect(redact('abc', [''])).toBe('abc')
    expect(redact('abc', [])).toBe('abc')
  })

  it('別の値の一部になっている値があっても、長い方から置き換えて取りこぼさない', () => {
    expect(redact('xx SECRETLONG yy SECRET', ['SECRET', 'SECRETLONG'])).toBe('xx *** yy ***')
  })
})

describe('値の扱い（ファイルにも引数にも出さない）', () => {
  it('ファイルを書く部品を読み込まない（値は標準入力で渡す）', () => {
    for (const rel of ['tools/setup-web/secrets.mjs', 'tools/setup-web/secrets-plan.mjs']) {
      const text = readFileSync(pathOf(rel), 'utf8')
      expect(text, rel).not.toMatch(/node:fs|from\s+['"]fs['"]|writeFile|appendFile|createWriteStream|mkdtemp/)
    }
  })

  it('wrangler secret bulk には JSON を input（標準入力）で渡す。引数は名前だけで、値は入らない', () => {
    const text = readFileSync(pathOf('tools/setup-web/secrets.mjs'), 'utf8')
    expect(text).toContain("['--yes', 'wrangler', 'secret', 'bulk', '--name', worker], { input: ")
  })

  it('package.json に pnpm setup:secrets がある', () => {
    const pkg = JSON.parse(readFileSync(pathOf('package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['setup:secrets']).toBe('node tools/setup-web/secrets.mjs')
  })
})
