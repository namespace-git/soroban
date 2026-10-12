export interface VapidKeyPair {
  /** base64url の 65 バイト（非圧縮の点）。VAPID_PUBLIC_KEY */
  publicKey: string
  /** base64url の 32 バイト。VAPID_PRIVATE_KEY（秘密） */
  privateKey: string
}

export function generateVapidKeys(): Promise<VapidKeyPair>

/** `1:<32 バイトの乱数の base64>`。SECRET_KEYS（秘密） */
export function generateSecretKeys(): string
