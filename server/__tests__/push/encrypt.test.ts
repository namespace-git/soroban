import { describe, expect, it } from 'vitest'
import { b64urlDecode, b64urlEncode } from '../../push/base64url'
import { encryptPayload, importEcdhKeyPair, MAX_PLAINTEXT_BYTES } from '../../push/encrypt'

// RFC 8291 の付録 A の試験ベクトル（公開値）。乱数（サーバー側の鍵・salt）を固定して、
// 暗号文が RFC のものと 1 バイトも違わないことを確かめる
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

const bytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b = b64urlDecode(s)
  if (!b) throw new Error('base64url ではありません')
  return b
}

describe('base64url', () => {
  it('往復できる。詰め物（=）あり・なしの両方を読む。base64url でない文字は null', () => {
    const raw = new Uint8Array([0xfb, 0xff, 0xfe, 0x01, 0x02])
    const text = b64urlEncode(raw)
    expect(text).toBe('-__-AQI')
    expect(text).not.toMatch(/[+/=]/)
    expect([...b64urlDecode(text)!]).toEqual([...raw])
    expect([...b64urlDecode('-__-AQI=')!]).toEqual([...raw])
    expect(b64urlDecode('')).toEqual(new Uint8Array(0))
    for (const bad of ['a+b/', 'ab cd', 'a', 'abcde', '日本語', 'ab=c']) expect(b64urlDecode(bad)).toBeNull()
    expect(b64urlDecode(42 as never)).toBeNull()
  })
})

describe('encryptPayload（RFC 8291 付録 A の試験ベクトル）', () => {
  it('固定の鍵ペア・salt で、RFC の本文と完全に一致する', async () => {
    const serverKeys = await importEcdhKeyPair(bytes(RFC.asPublic), bytes(RFC.asPrivate))
    const body = await encryptPayload(bytes(RFC.plaintext), bytes(RFC.uaPublic), bytes(RFC.authSecret), {
      serverKeys,
      salt: bytes(RFC.salt),
    })
    expect(b64urlEncode(body)).toBe(RFC.body)
  })

  it('平文は "When I grow up, I want to be a watermelon"（試験ベクトルの平文の確認）', () => {
    expect(new TextDecoder().decode(bytes(RFC.plaintext))).toBe('When I grow up, I want to be a watermelon')
  })

  it('本文の見出し：salt(16) ・ rs=4096 ・ 鍵の長さ 65 ・ 公開鍵。レコードは 1 つで、長さは 平文＋1＋16', async () => {
    const plain = new TextEncoder().encode('こんにちは')
    const body = await encryptPayload(plain, bytes(RFC.uaPublic), bytes(RFC.authSecret))
    expect(body.length).toBe(86 + plain.length + 1 + 16)
    expect(new DataView(body.buffer).getUint32(16, false)).toBe(4096)
    expect(body[20]).toBe(65)
    expect(body[21]).toBe(0x04)
  })

  it('毎回違う salt・鍵で暗号化する（同じ平文でも本文は同じにならない）', async () => {
    const plain = new TextEncoder().encode('same')
    const a = await encryptPayload(plain, bytes(RFC.uaPublic), bytes(RFC.authSecret))
    const b = await encryptPayload(plain, bytes(RFC.uaPublic), bytes(RFC.authSecret))
    expect(b64urlEncode(a)).not.toBe(b64urlEncode(b))
    expect(b64urlEncode(a.slice(0, 16))).not.toBe(b64urlEncode(b.slice(0, 16)))
  })

  it('受け取る側（ブラウザ）の秘密鍵で復号して平文に戻る（往復）', async () => {
    const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))
    const auth = crypto.getRandomValues(new Uint8Array(16))
    const plain = new TextEncoder().encode(JSON.stringify({ title: '売れました', body: '【A040】もこ山 ¥5,750', url: '/', tag: 'x' }))
    const body = await encryptPayload(plain, uaPublic, auth)

    // 受け取る側：見出しから salt・サーバーの公開鍵を取り出し、同じ手順で鍵を作って復号する
    const salt = body.slice(0, 16)
    const asPublic = body.slice(21, 86)
    const cipher = body.slice(86)
    const asKey = await crypto.subtle.importKey(
      'raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
    )
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256))
    const te = new TextEncoder()
    const cat = (...p: Uint8Array<ArrayBuffer>[]) => Uint8Array.from(p.flatMap((x) => [...x]))
    const derive = async (s: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, n: number) =>
      new Uint8Array(await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: s, info },
        await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8,
      ))
    const ikm = await derive(auth, shared, cat(te.encode('WebPush: info\0'), uaPublic, asPublic), 32)
    const cek = await derive(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16)
    const nonce = await derive(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12)
    const decrypted = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), cipher,
    ))
    expect(decrypted[decrypted.length - 1]).toBe(0x02)
    expect(new TextDecoder().decode(decrypted.slice(0, -1))).toBe(new TextDecoder().decode(plain))
  })

  it('壊れた入力は Error：大きすぎる平文・公開鍵の形・auth の長さ・salt の長さ', async () => {
    const ua = bytes(RFC.uaPublic)
    const auth = bytes(RFC.authSecret)
    await expect(encryptPayload(new Uint8Array(MAX_PLAINTEXT_BYTES + 1), ua, auth)).rejects.toThrow('大きすぎ')
    await expect(encryptPayload(new Uint8Array(MAX_PLAINTEXT_BYTES), ua, auth)).resolves.toBeInstanceOf(Uint8Array)
    await expect(encryptPayload(new Uint8Array(1), ua.slice(0, 64), auth)).rejects.toThrow('65 バイト')
    const compressed = ua.slice(0, 65)
    compressed[0] = 0x02
    await expect(encryptPayload(new Uint8Array(1), compressed, auth)).rejects.toThrow('非圧縮')
    await expect(encryptPayload(new Uint8Array(1), ua, auth.slice(0, 15))).rejects.toThrow('16 バイト')
    await expect(encryptPayload(new Uint8Array(1), ua, auth, { salt: new Uint8Array(15) })).rejects.toThrow('16 バイト')
  })
})
