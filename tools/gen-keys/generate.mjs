// Web 版の鍵を作る（VAPID の鍵の組と SECRET_KEYS）。作った値は返すだけで、どこにも保存しない。
// 型は generate.d.mts。使うのは index.mjs（pnpm gen-keys）と、形を確かめるテスト。
//
// 素の Node で動くよう .mjs で書いてある（TypeScript の読み込みに Node の新しさを要求しない）。
import { randomBytes, webcrypto } from 'node:crypto'

/**
 * Web Push（VAPID）の鍵の組。P-256 の ECDSA 鍵で、
 *   publicKey  … 非圧縮の点（0x04 ‖ X ‖ Y）65 バイトの base64url。ブラウザの購読にも渡す
 *   privateKey … 秘密の値 d の 32 バイトの base64url
 * server/push/vapid.ts の loadVapidKeys が、この形を読む。
 */
export async function generateVapidKeys() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicRaw = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey))
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey)
  return {
    publicKey: publicRaw.toString('base64url'),
    // JWK の d は、P-256 では常に 32 バイトの base64url（詰め物なし）
    privateKey: jwk.d,
  }
}

/**
 * SECRET_KEYS（API キーを暗号化する鍵の束）。`版:鍵`。鍵は 32 バイトの乱数の base64。
 * 最初は版 1 だけ。鍵を替えるときは、新しい版を先頭に足してカンマでつなぐ（古い鍵は読むために残す）。
 * server/secrets/crypto.ts の parseSecretKeys が、この形を読む。
 */
export function generateSecretKeys() {
  return `1:${randomBytes(32).toString('base64')}`
}
