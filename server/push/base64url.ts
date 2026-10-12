// base64url（RFC 4648 の 5 節。= の詰め物なし）。Web Push の鍵・認証の秘密・VAPID の JWT が使う。
// Workers には Buffer が無い前提で、btoa / atob だけで書く

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** base64url（詰め物あり・なしの両方）を読む。base64url でなければ null（例外にしない＝呼ぶ側が日本語で断る） */
export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null
  const body = text.replace(/=+$/, '')
  // 4 文字で 3 バイト。余りが 1 文字になる長さは base64 として成り立たない
  if (body.length % 4 === 1) return null
  try {
    const bin = atob(body.replace(/-/g, '+').replace(/_/g, '/'))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
