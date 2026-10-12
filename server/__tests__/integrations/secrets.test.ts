import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  decryptSecret, encryptSecret, fromHex, parseSecretKeys, putSecret, readSecret, readSecretAndRefresh, rewriteIfStale,
  SecretKeysError, secretAad, toHex, deleteSecret, hasSecret, SECRET_TRACK17,
} from '../../secrets'
import { newWorld, openDomainDb, type DomainDb, type World } from '../domain/helpers'
import { fakeApiKey, keyRing, newKey, spyConsole } from './helpers'

// 秘密の値（server/secrets）：往復・AAD・鍵の版・壊れた暗号文・ログに鍵や平文が出ないこと

let db: DomainDb
let world: World

beforeAll(async () => {
  db = await openDomainDb()
})
afterAll(async () => {
  await db.close()
})

const H = '00000000-0000-4000-8000-0000000000a1'

describe('SECRET_KEYS の読み込み', () => {
  it('版:鍵 のカンマ区切り。先頭が今の鍵。鍵は 32 バイトの base64', () => {
    const k1 = newKey()
    const k2 = newKey()
    const ring = parseSecretKeys(` 2:${k2} , 1:${k1} `)
    expect(ring.current).toBe(2)
    expect([...ring.keys.keys()].sort()).toEqual([1, 2])
    expect(ring.keys.get(2)).toHaveLength(32)
  })

  it('形が違えば SecretKeysError。メッセージに鍵の中身を入れない', () => {
    const good = newKey()
    const bads: Array<[string | null | undefined, RegExp]> = [
      [undefined, /設定されていません/],
      [null, /設定されていません/],
      ['', /設定されていません/],
      ['   ', /設定されていません/],
      [good, /1 番目の形/], // 版が無い
      [`x:${good}`, /1 番目の形/],
      [`0:${good}`, /1 以上/],
      [`1:${good},1:${newKey()}`, /重複/],
      [`1:${good},`, /2 番目の形/], // 末尾のカンマ
      [`1:${randomBytes(16).toString('base64')}`, /32 バイト/],
      [`1:${randomBytes(33).toString('base64')}`, /32 バイト/],
      ['1:ここは日本語', /1 番目の形|32 バイト/],
      ['1:***not-base64***', /1 番目の形|32 バイト/],
    ]
    for (const [raw, message] of bads) {
      let error: unknown
      try {
        parseSecretKeys(raw)
      } catch (e) {
        error = e
      }
      expect(error, String(raw)).toBeInstanceOf(SecretKeysError)
      expect((error as Error).message).toMatch(message)
      if (raw) for (const piece of String(raw).split(/[,:]/)) if (piece.length >= 20) expect((error as Error).message).not.toContain(piece)
    }
  })

  it('padding の無い base64 でも読める', () => {
    const bytes = randomBytes(32)
    const noPad = bytes.toString('base64').replace(/=+$/, '')
    expect(parseSecretKeys(`1:${noPad}`).keys.get(1)).toEqual(new Uint8Array(bytes))
  })
})

describe('暗号化・復号', () => {
  const ring = parseSecretKeys(`1:${newKey()}`)
  const scope = { householdId: H, key: 'track17_api_key' }

  it('往復できる。iv は 12 バイトで毎回違い、暗号文に平文は含まれず、長さは平文＋認証タグ 16 バイト', async () => {
    const plain = fakeApiKey()
    const a = await encryptSecret(ring, { ...scope, plaintext: plain })
    const b = await encryptSecret(ring, { ...scope, plaintext: plain })
    expect(a.iv).toHaveLength(12)
    expect(toHex(a.iv)).not.toBe(toHex(b.iv))
    expect(toHex(a.ciphertext)).not.toBe(toHex(b.ciphertext))
    expect(a.ciphertext).toHaveLength(Buffer.byteLength(plain) + 16)
    expect(Buffer.from(a.ciphertext).includes(Buffer.from(plain))).toBe(false)
    expect(a.keyVersion).toBe(1)
    expect(await decryptSecret(ring, { ...scope, keyVersion: 1, ciphertext: a.ciphertext, iv: a.iv })).toBe(plain)
  })

  it('日本語・長い値も往復できる', async () => {
    for (const plain of ['あいうえお🍣', 'x'.repeat(300)]) {
      const sealed = await encryptSecret(ring, { ...scope, plaintext: plain })
      expect(await decryptSecret(ring, { ...scope, keyVersion: 1, ciphertext: sealed.ciphertext, iv: sealed.iv })).toBe(plain)
    }
  })

  it('AAD が違えば読めない：別の世帯・別のキー・別の版', async () => {
    const sealed = await encryptSecret(ring, { ...scope, plaintext: fakeApiKey() })
    const open = (over: Partial<{ householdId: string; key: string; keyVersion: number }>) =>
      decryptSecret(ring, { ...scope, keyVersion: 1, ciphertext: sealed.ciphertext, iv: sealed.iv, ...over })
    expect(await open({})).not.toBeNull()
    expect(await open({ householdId: '00000000-0000-4000-8000-0000000000b2' })).toBeNull()
    expect(await open({ key: 'gemini_api_key' })).toBeNull()
    expect(await open({ keyVersion: 2 })).toBeNull() // 束に無い版
    // 版の番号だけを書き換えた束（同じ鍵を別の版の名前で持つ）でも、AAD に版が入っているので読めない
    const renumbered = { current: 2, keys: new Map([[2, ring.keys.get(1)!]]) }
    expect(await decryptSecret(renumbered, { ...scope, keyVersion: 2, ciphertext: sealed.ciphertext, iv: sealed.iv })).toBeNull()
    expect(toHex(secretAad(H, 'k', 1))).not.toBe(toHex(secretAad(H, 'k', 2)))
  })

  it('壊れた暗号文・iv・別の鍵は例外にせず null（平文に逃げない）', async () => {
    const sealed = await encryptSecret(ring, { ...scope, plaintext: fakeApiKey() })
    const flipped = new Uint8Array(sealed.ciphertext)
    flipped[0] ^= 1
    const base = { ...scope, keyVersion: 1, ciphertext: sealed.ciphertext, iv: sealed.iv }
    expect(await decryptSecret(ring, { ...base, ciphertext: flipped })).toBeNull()
    expect(await decryptSecret(ring, { ...base, ciphertext: sealed.ciphertext.slice(0, 5) })).toBeNull()
    expect(await decryptSecret(ring, { ...base, ciphertext: new Uint8Array(0) })).toBeNull()
    expect(await decryptSecret(ring, { ...base, iv: sealed.iv.slice(0, 11) })).toBeNull()
    expect(await decryptSecret(ring, { ...base, iv: new Uint8Array(12) })).toBeNull()
    const other = parseSecretKeys(`1:${newKey()}`)
    expect(await decryptSecret(other, base)).toBeNull()
  })

  it('16 進の往復。壊れた 16 進は null', () => {
    const bytes = randomBytes(20)
    expect(toHex(fromHex(toHex(bytes))!)).toBe(bytes.toString('hex'))
    expect(fromHex('abc')).toBeNull()
    expect(fromHex('zz')).toBeNull()
  })
})

describe('setting_secret への保存', () => {
  const k1 = newKey()
  const k2 = newKey()
  const ring1 = parseSecretKeys(keyRing([1, k1]))
  const ring2 = parseSecretKeys(keyRing([2, k2], [1, k1]))
  let spy: ReturnType<typeof spyConsole> | null = null

  afterEach(async () => {
    spy?.restore()
    spy = null
    await db.pg.exec('delete from app.setting_secret')
  })

  const rowOf = (m: World['a']) =>
    m.run(ctx => ctx.sql.get<{ ciphertext: string; iv: string; key_version: number; alg: string }>(
      `select encode(ciphertext, 'hex') as ciphertext, encode(iv, 'hex') as iv, key_version, alg from setting_secret where key = 'track17_api_key'`))

  it('暗号文だけを持つ（平文は DB のどこにも入らない）。版と方式が入る。保存・読み・削除', async () => {
    world = await newWorld(db)
    const plain = fakeApiKey()
    expect(await world.a.run(ctx => hasSecret(ctx, SECRET_TRACK17))).toBe(false)
    expect(await world.a.run(ctx => readSecret(ctx, ring1, SECRET_TRACK17))).toEqual({ status: 'missing' })

    await world.a.run(ctx => putSecret(ctx, ring1, SECRET_TRACK17, plain))
    const row = (await rowOf(world.a))!
    expect(row.key_version).toBe(1)
    expect(row.alg).toBe('aes-256-gcm')
    expect(row.iv).toHaveLength(24)
    expect(row.ciphertext).not.toContain(Buffer.from(plain).toString('hex'))
    // 表のどの列にも平文が無い
    const dump = await db.pg.query<{ t: string }>(`select row_to_json(s)::text as t from app.setting_secret s`)
    expect(dump.rows.map(r => r.t).join('\n')).not.toContain(plain)

    expect(await world.a.run(ctx => readSecret(ctx, ring1, SECRET_TRACK17))).toEqual({ status: 'ok', value: plain, keyVersion: 1, stale: false })

    // 上書き
    const next = fakeApiKey()
    await world.a.run(ctx => putSecret(ctx, ring1, SECRET_TRACK17, next))
    expect((await world.a.run(ctx => readSecret(ctx, ring1, SECRET_TRACK17)) as { value: string }).value).toBe(next)

    await world.a.run(ctx => deleteSecret(ctx, SECRET_TRACK17))
    expect(await world.a.run(ctx => hasSecret(ctx, SECRET_TRACK17))).toBe(false)
  })

  it('世帯 B からは世帯 A の値が読めない。暗号文を B の行にコピーしても復号できない', async () => {
    world = await newWorld(db)
    const plain = fakeApiKey()
    await world.a.run(ctx => putSecret(ctx, ring1, SECRET_TRACK17, plain))
    expect(await world.b.run(ctx => readSecret(ctx, ring1, SECRET_TRACK17))).toEqual({ status: 'missing' })
    expect(await world.b.run(ctx => hasSecret(ctx, SECRET_TRACK17))).toBe(false)

    // 悪意のある（または取り違えた）コピー：A の暗号文をそのまま B の行に入れる
    const a = (await rowOf(world.a))!
    await world.b.run(ctx => ctx.sql.run(
      `insert into setting_secret (key, ciphertext, iv, key_version, alg) values ('track17_api_key', decode(?, 'hex'), decode(?, 'hex'), ?, ?)`,
      a.ciphertext, a.iv, a.key_version, a.alg))
    expect(await world.b.run(ctx => readSecret(ctx, ring1, SECRET_TRACK17))).toEqual({ status: 'unreadable' })
    // A の側は無傷
    expect(await world.a.run(ctx => readSecret(ctx, ring1, SECRET_TRACK17))).toMatchObject({ status: 'ok', value: plain })
  })

  it('別のキーの行に移しても・版の数字を書き換えても復号できない', async () => {
    world = await newWorld(db)
    await world.a.run(ctx => putSecret(ctx, ring2, SECRET_TRACK17, fakeApiKey()))
    const a = (await rowOf(world.a))!
    await world.a.run(ctx => ctx.sql.run(
      `insert into setting_secret (key, ciphertext, iv, key_version, alg) values ('gemini_api_key', decode(?, 'hex'), decode(?, 'hex'), ?, ?)`,
      a.ciphertext, a.iv, a.key_version, a.alg))
    expect(await world.a.run(ctx => readSecret(ctx, ring2, 'gemini_api_key'))).toEqual({ status: 'unreadable' })

    await world.a.run(ctx => ctx.sql.run(`update setting_secret set key_version = 1 where key = 'track17_api_key'`))
    expect(await world.a.run(ctx => readSecret(ctx, ring2, SECRET_TRACK17))).toEqual({ status: 'unreadable' })
  })

  it('古い版の鍵で書いた値が読め（stale）、読んだときに今の版で書き直せる', async () => {
    world = await newWorld(db)
    const plain = fakeApiKey()
    await world.a.run(ctx => putSecret(ctx, ring1, SECRET_TRACK17, plain)) // 版 1 で書く
    const before = (await rowOf(world.a))!

    // 鍵を回した（先頭が 2、1 は読むだけ）
    const read = await world.a.run(ctx => readSecret(ctx, ring2, SECRET_TRACK17))
    expect(read).toEqual({ status: 'ok', value: plain, keyVersion: 1, stale: true })
    expect((await rowOf(world.a))!.key_version).toBe(1) // readSecret 自体は書き換えない

    expect(await world.a.run(ctx => rewriteIfStale(ctx, ring2, SECRET_TRACK17, read))).toBe(true)
    const after = (await rowOf(world.a))!
    expect(after.key_version).toBe(2)
    expect(after.ciphertext).not.toBe(before.ciphertext)
    expect(after.iv).not.toBe(before.iv)
    expect(await world.a.run(ctx => readSecret(ctx, ring2, SECRET_TRACK17))).toEqual({ status: 'ok', value: plain, keyVersion: 2, stale: false })

    // 版 1 の鍵を束から外しても読める（書き直し済み）
    const only2 = parseSecretKeys(keyRing([2, k2]))
    expect(await world.a.run(ctx => readSecret(ctx, only2, SECRET_TRACK17))).toMatchObject({ status: 'ok', value: plain })
    // 書き直す必要の無いもの・読めなかったものは何もしない
    const fresh = await world.a.run(ctx => readSecret(ctx, ring2, SECRET_TRACK17))
    expect(await world.a.run(ctx => rewriteIfStale(ctx, ring2, SECRET_TRACK17, fresh))).toBe(false)
    expect(await world.a.run(ctx => rewriteIfStale(ctx, ring2, SECRET_TRACK17, { status: 'unreadable' }))).toBe(false)
  })

  it('readSecretAndRefresh：古い版なら読んだついでに書き直す', async () => {
    world = await newWorld(db)
    const plain = fakeApiKey()
    await world.a.run(ctx => putSecret(ctx, ring1, SECRET_TRACK17, plain))
    const read = await world.a.run(ctx => readSecretAndRefresh(ctx, ring2, SECRET_TRACK17))
    expect(read).toMatchObject({ status: 'ok', value: plain, stale: true })
    expect((await rowOf(world.a))!.key_version).toBe(2)
  })

  it('書き換え中に別の値が入れ直されていたら、古い値で上書きしない', async () => {
    world = await newWorld(db)
    await world.a.run(ctx => putSecret(ctx, ring1, SECRET_TRACK17, fakeApiKey()))
    const stale = await world.a.run(ctx => readSecret(ctx, ring2, SECRET_TRACK17))
    const fresh = fakeApiKey()
    await world.a.run(ctx => putSecret(ctx, ring2, SECRET_TRACK17, fresh)) // 先に入れ直された（版 2）
    expect(await world.a.run(ctx => rewriteIfStale(ctx, ring2, SECRET_TRACK17, stale))).toBe(false)
    expect(await world.a.run(ctx => readSecret(ctx, ring2, SECRET_TRACK17))).toMatchObject({ status: 'ok', value: fresh })
  })

  it('壊れた暗号文は unreadable（例外にしない）。方式が違う行も', async () => {
    world = await newWorld(db)
    await world.a.run(ctx => putSecret(ctx, ring1, SECRET_TRACK17, fakeApiKey()))
    await world.a.run(ctx => ctx.sql.run(`update setting_secret set ciphertext = decode('0102030405060708090a0b0c0d0e0f1011121314', 'hex')`))
    expect(await world.a.run(ctx => readSecret(ctx, ring1, SECRET_TRACK17))).toEqual({ status: 'unreadable' })
    await world.a.run(ctx => ctx.sql.run(`update setting_secret set ciphertext = decode('00', 'hex')`))
    expect(await world.a.run(ctx => readSecret(ctx, ring1, SECRET_TRACK17))).toEqual({ status: 'unreadable' })
  })

  it('定期実行のロール（soroban_cron）は暗号文を読めて復号できる。書けないので書き直しは黙って諦める', async () => {
    world = await newWorld(db)
    const plain = fakeApiKey()
    await world.a.run(ctx => putSecret(ctx, ring1, SECRET_TRACK17, plain))
    const result = await db.root.tx(async (sql) => {
      await sql.run('set local search_path = app, public')
      await sql.run('set local role soroban_cron')
      await sql.get("select set_config('app.household_id', ?, true)", world.a.householdId)
      const scope = { sql, householdId: world.a.householdId }
      const read = await readSecret(scope, ring2, SECRET_TRACK17)
      const rewritten = await rewriteIfStale(scope, ring2, SECRET_TRACK17, read)
      return { read, rewritten }
    })
    expect(result.read).toMatchObject({ status: 'ok', value: plain, stale: true })
    expect(result.rewritten).toBe(false)
    expect((await rowOf(world.a))!.key_version).toBe(1)
  })

  it('ログにも例外にも、鍵（SECRET_KEYS）と平文が出ない（成功・復号できない・書き直せない、どの経路でも）', async () => {
    world = await newWorld(db)
    spy = spyConsole()
    const plain = fakeApiKey()
    const errors: string[] = []
    await world.a.run(ctx => putSecret(ctx, ring1, SECRET_TRACK17, plain))
    await world.a.run(ctx => readSecretAndRefresh(ctx, ring2, SECRET_TRACK17)) // 古い版 → 書き直し
    await world.a.run(ctx => ctx.sql.run(`update setting_secret set ciphertext = decode('0102030405060708090a0b0c0d0e0f1011121314', 'hex')`))
    await world.a.run(ctx => readSecretAndRefresh(ctx, ring2, SECRET_TRACK17)) // 復号できない → ログ
    try {
      parseSecretKeys(`1:${k1.slice(0, 20)}`)
    } catch (e) {
      errors.push(String(e instanceof Error ? e.message : e))
    }
    const everything = `${spy.text()}\n${errors.join('\n')}`
    for (const secret of [plain, k1, k2, Buffer.from(k1, 'base64').toString('hex'), k1.slice(0, 20)]) {
      expect(everything).not.toContain(secret)
    }
    expect(spy.text()).toContain('復号できませんでした') // ログは出ている（中身は伏せたまま）
  })
})
