// ============================================================
// 秘密の値（Gemini・17TRACK の API キー）の暗号化・復号。AES-256-GCM（WebCrypto）。
//
// 鍵は環境変数 SECRET_KEYS（Cloudflare の環境変数。DB にもリポジトリにも置かない）：
//   SECRET_KEYS="2:<base64>,1:<base64>"     版:鍵 のカンマ区切り。**先頭が今の鍵**（書くときに使う）。
//   鍵は 32 バイトの乱数の base64（`openssl rand -base64 32`）。残りは昔の鍵で、読むときだけ使う。
// 暗号文は DB に「暗号文＋認証タグ」「iv（12 バイト）」「鍵の版」「方式」で持つ（setting_secret）。
//
// AAD（付加データ）＝ household_id + '\n' + 設定のキー + '\n' + 鍵の版。
// 暗号文を別の世帯・別のキーの行に移しても、版を書き換えても、復号できない（認証タグが合わない）。
//
// **鍵・平文をログにもエラー文にも出さない。** 復号できなければ例外ではなく null を返す
// （呼ぶ側は「入れ直してください」と案内する。平文に逃げない）。
// ============================================================

export const SECRET_ALG = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32
const TAG_BYTES = 16

/** SECRET_KEYS の設定の誤り。メッセージに鍵そのものは入れない（位置と版の番号だけ） */
export class SecretKeysError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretKeysError'
  }
}

export interface KeyRing {
  /** 今の版（書くときに使う。SECRET_KEYS の先頭） */
  readonly current: number
  readonly keys: ReadonlyMap<number, Uint8Array<ArrayBuffer>>
}

const FORM_HINT = '版:鍵 をカンマ区切りで並べ、鍵は 32 バイトの乱数の base64 にしてください'

function decodeBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * 環境変数 SECRET_KEYS を読む。形が違えば SecretKeysError（最初に使うときに分かる）。
 * 例外のメッセージには鍵の中身を入れない
 */
export function parseSecretKeys(raw: string | null | undefined): KeyRing {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SecretKeysError(`SECRET_KEYS が設定されていません（${FORM_HINT}）`)
  }
  const keys = new Map<number, Uint8Array<ArrayBuffer>>()
  let current = 0
  raw.split(',').forEach((part, index) => {
    const position = index + 1
    const m = /^\s*(\d{1,9}):(\S+)\s*$/.exec(part)
    if (!m) throw new SecretKeysError(`SECRET_KEYS の ${position} 番目の形が正しくありません（${FORM_HINT}）`)
    const version = Number(m[1])
    if (version < 1) throw new SecretKeysError(`SECRET_KEYS の ${position} 番目の版は 1 以上にしてください`)
    if (keys.has(version)) throw new SecretKeysError(`SECRET_KEYS の版 ${version} が重複しています`)
    const bytes = decodeBase64(m[2])
    if (!bytes || bytes.length !== KEY_BYTES) {
      throw new SecretKeysError(`SECRET_KEYS の版 ${version} の鍵が 32 バイトの base64 ではありません`)
    }
    keys.set(version, bytes)
    if (index === 0) current = version
  })
  return { current, keys }
}

/** AAD：暗号文を別の世帯・別のキー・別の版の行に移しても復号できないようにする */
export function secretAad(householdId: string, key: string, keyVersion: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${householdId}\n${key}\n${keyVersion}`)
}

async function importKey(bytes: Uint8Array<ArrayBuffer>, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [usage])
}

export interface EncryptedSecret {
  /** 暗号文＋認証タグ（16 バイト） */
  ciphertext: Uint8Array<ArrayBuffer>
  /** 初期化ベクトル（12 バイト。毎回ランダム） */
  iv: Uint8Array<ArrayBuffer>
  keyVersion: number
}

/** 今の版の鍵で暗号化する */
export async function encryptSecret(
  ring: KeyRing, scope: { householdId: string; key: string; plaintext: string },
): Promise<EncryptedSecret> {
  const keyVersion = ring.current
  const keyBytes = ring.keys.get(keyVersion)
  if (!keyBytes) throw new SecretKeysError('SECRET_KEYS の先頭の鍵を読めません')
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: secretAad(scope.householdId, scope.key, keyVersion), tagLength: TAG_BYTES * 8 },
    await importKey(keyBytes, 'encrypt'),
    new TextEncoder().encode(scope.plaintext),
  )
  return { ciphertext: new Uint8Array(sealed), iv, keyVersion }
}

/**
 * 復号する。**復号できなければ null**（その版の鍵が束に無い・暗号文が壊れている・別の世帯／キー／版の行から
 * 移されたもの、のどれでも）。例外にしない・理由を詳しく返さない（呼ぶ側は「入れ直してください」と案内する）
 */
export async function decryptSecret(
  ring: KeyRing,
  scope: { householdId: string; key: string; keyVersion: number; ciphertext: Uint8Array; iv: Uint8Array },
): Promise<string | null> {
  const keyBytes = ring.keys.get(scope.keyVersion)
  if (!keyBytes) return null
  if (scope.iv.length !== IV_BYTES || scope.ciphertext.length < TAG_BYTES) return null
  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(scope.iv),
        additionalData: secretAad(scope.householdId, scope.key, scope.keyVersion),
        tagLength: TAG_BYTES * 8,
      },
      await importKey(keyBytes, 'decrypt'),
      new Uint8Array(scope.ciphertext),
    )
    return new TextDecoder('utf-8', { fatal: true }).decode(opened)
  } catch {
    return null
  }
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** 16 進（小文字・大文字どちらも）をバイト列に。読めなければ null */
export function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}
