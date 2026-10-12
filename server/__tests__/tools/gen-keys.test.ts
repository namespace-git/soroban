import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateSecretKeys, generateVapidKeys } from '../../../tools/gen-keys/generate.mjs'
import { b64urlDecode } from '../../push/base64url'
import { isValidVapidPublicKey, loadVapidKeys, signVapidJwt } from '../../push/vapid'
import { decryptSecret, encryptSecret, parseSecretKeys } from '../../secrets'

// 鍵を作る道具（tools/gen-keys）。作った値が、サーバーの読み取り（push/vapid.ts・secrets/crypto.ts）を通ること。
// 値はテストの中で作る（リポジトリにも出力にも鍵を残さない）

const SUBJECT = 'mailto:owner@example.test'
const indexPath = fileURLToPath(new URL('../../../tools/gen-keys/index.mjs', import.meta.url))
const generatePath = fileURLToPath(new URL('../../../tools/gen-keys/generate.mjs', import.meta.url))

describe('VAPID の鍵の組', () => {
  it('公開鍵は base64url の 65 バイト（0x04 から）、秘密鍵は base64url の 32 バイト。毎回違う', async () => {
    const a = await generateVapidKeys()
    const b = await generateVapidKeys()
    const pub = b64urlDecode(a.publicKey)
    const priv = b64urlDecode(a.privateKey)
    expect(pub).toHaveLength(65)
    expect(pub?.[0]).toBe(0x04)
    expect(priv).toHaveLength(32)
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.privateKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(isValidVapidPublicKey(a.publicKey)).toBe(true)
    expect(a.publicKey).not.toBe(b.publicKey)
    expect(a.privateKey).not.toBe(b.privateKey)
  })

  it('loadVapidKeys が読めて、その鍵で署名した JWT は、公開鍵で検証できる（組が合っている）', async () => {
    const k = await generateVapidKeys()
    const keys = await loadVapidKeys({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: SUBJECT })
    expect(keys).not.toBeNull()
    const jwt = await signVapidJwt(keys!, 'https://push.example.test', 1_800_000_000)
    const [header, claims, signature] = jwt.split('.')
    const publicKey = await crypto.subtle.importKey(
      'raw', b64urlDecode(k.publicKey)!, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    )
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, publicKey, b64urlDecode(signature)!, new TextEncoder().encode(`${header}.${claims}`),
    )
    expect(ok).toBe(true)
  })
})

describe('SECRET_KEYS', () => {
  it('`1:<32 バイトの base64>`。parseSecretKeys が読めて、暗号化・復号できる。毎回違う', async () => {
    const raw = generateSecretKeys()
    expect(raw).toMatch(/^1:[A-Za-z0-9+/]{43}=$/)
    expect(generateSecretKeys()).not.toBe(raw)

    const ring = parseSecretKeys(raw)
    expect(ring.current).toBe(1)
    expect(ring.keys.get(1)).toHaveLength(32)
    const scope = { householdId: 'h', key: 'gemini_api_key' }
    const sealed = await encryptSecret(ring, { ...scope, plaintext: 'テストの値' })
    expect(await decryptSecret(ring, { ...scope, keyVersion: sealed.keyVersion, ciphertext: sealed.ciphertext, iv: sealed.iv })).toBe('テストの値')
  })
})

describe('pnpm gen-keys（node tools/gen-keys/index.mjs）', () => {
  it('画面に 3 つの値を出す。出た値がサーバーの読み取りを通る', async () => {
    const out = execFileSync(process.execPath, [indexPath], { encoding: 'utf8' })
    const pick = (name: string): string => {
      const m = new RegExp(`^${name}=(\\S+)$`, 'm').exec(out)
      expect(m, `${name} の行が出ていません`).not.toBeNull()
      return m![1]
    }
    const publicKey = pick('VAPID_PUBLIC_KEY')
    const privateKey = pick('VAPID_PRIVATE_KEY')
    const secretKeys = pick('SECRET_KEYS')

    expect(isValidVapidPublicKey(publicKey)).toBe(true)
    expect(await loadVapidKeys({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: SUBJECT })).not.toBeNull()
    expect(parseSecretKeys(secretKeys).current).toBe(1)
    // VAPID_SUBJECT は自分で決める（雛形の行だけ出す）
    expect(out).toMatch(/^VAPID_SUBJECT=mailto:</m)
  })

  it('出力を画面に出すだけ。ファイルには書かない（fs を読み込まない）', () => {
    for (const path of [indexPath, generatePath]) {
      const text = readFileSync(path, 'utf8')
      expect(text, path).not.toMatch(/node:fs|from\s+['"]fs['"]|writeFile|appendFile|createWriteStream/)
    }
  })
})
