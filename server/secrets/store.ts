import type { Ctx } from '../context'
import { decryptSecret, encryptSecret, fromHex, SECRET_ALG, toHex, type KeyRing } from './crypto'

// ============================================================
// setting_secret（秘密の値の暗号文）の読み書き。
//
// 暗号文・iv は SQL の encode / decode（16 進）で受け渡す（ドライバごとの bytea の扱いの違いを避ける）。
// 世帯は RLS（app.household_id）で絞られる。AAD にも ctx.householdId を入れるので、
// 暗号文を別の世帯の行に移しても復号できない。
// ============================================================

export const SECRET_GEMINI = 'gemini_api_key'
export const SECRET_TRACK17 = 'track17_api_key'

export type SecretScope = Pick<Ctx, 'sql' | 'householdId'>

export type SecretRead =
  /** 保存されていない */
  | { status: 'missing' }
  /** 保存されているが復号できない（鍵の束に無い版・壊れた暗号文・別の行から移されたもの）。入れ直してもらう */
  | { status: 'unreadable' }
  | { status: 'ok'; value: string; keyVersion: number; stale: boolean }

interface Row {
  ciphertext: string
  iv: string
  key_version: number
  alg: string
}

async function loadRow(ctx: SecretScope, key: string): Promise<Row | undefined> {
  return ctx.sql.get<Row>(
    `select encode(ciphertext, 'hex') as ciphertext, encode(iv, 'hex') as iv, key_version, alg
       from setting_secret where key = ?`,
    key,
  )
}

/** 暗号化して保存する（同じキーがあれば置き換える）。保存するのは暗号文だけ */
export async function putSecret(ctx: SecretScope, ring: KeyRing, key: string, plaintext: string): Promise<void> {
  const sealed = await encryptSecret(ring, { householdId: ctx.householdId, key, plaintext })
  await ctx.sql.run(
    `insert into setting_secret (key, ciphertext, iv, key_version, alg, updated_at)
     values (?, decode(?, 'hex'), decode(?, 'hex'), ?, ?, now())
     on conflict (household_id, key) do update
        set ciphertext = excluded.ciphertext, iv = excluded.iv, key_version = excluded.key_version,
            alg = excluded.alg, updated_at = excluded.updated_at`,
    key, toHex(sealed.ciphertext), toHex(sealed.iv), sealed.keyVersion, SECRET_ALG,
  )
}

export async function deleteSecret(ctx: SecretScope, key: string): Promise<void> {
  await ctx.sql.run('delete from setting_secret where key = ?', key)
}

/** 保存されているか（復号はしない） */
export async function hasSecret(ctx: SecretScope, key: string): Promise<boolean> {
  return (await ctx.sql.get<{ n: number }>('select 1 as n from setting_secret where key = ?', key)) !== undefined
}

/**
 * 読んで復号する。復号できなければ unreadable（平文に逃げない）。
 * stale＝今の版（SECRET_KEYS の先頭）より古い鍵で書かれている。rewriteIfStale で今の鍵に書き直せる
 */
export async function readSecret(ctx: SecretScope, ring: KeyRing, key: string): Promise<SecretRead> {
  const row = await loadRow(ctx, key)
  if (!row) return { status: 'missing' }
  const ciphertext = fromHex(row.ciphertext)
  const iv = fromHex(row.iv)
  if (row.alg !== SECRET_ALG || !ciphertext || !iv) return { status: 'unreadable' }
  const value = await decryptSecret(ring, { householdId: ctx.householdId, key, keyVersion: row.key_version, ciphertext, iv })
  if (value === null) return { status: 'unreadable' }
  return { status: 'ok', value, keyVersion: row.key_version, stale: row.key_version !== ring.current }
}

/**
 * 古い版の鍵で書かれた値を、今の版で書き直す（読んだついでに呼ぶ）。書き直したら true。
 * 同じ版のまま誰かが書き換えていたら（並行して入れ直された）何もしない。updated_at は触らない（値は変わらないため）。
 * 書き込めない役割（定期実行の soroban_cron は読むだけ）や失敗は握りつぶす（読めた事実は変わらない）
 */
export async function rewriteIfStale(
  ctx: SecretScope, ring: KeyRing, key: string, read: SecretRead,
): Promise<boolean> {
  if (read.status !== 'ok' || !read.stale) return false
  try {
    const sealed = await encryptSecret(ring, { householdId: ctx.householdId, key, plaintext: read.value })
    return await ctx.sql.tx(async (sql) => {
      const r = await sql.run(
        `update setting_secret
            set ciphertext = decode(?, 'hex'), iv = decode(?, 'hex'), key_version = ?, alg = ?
          where key = ? and key_version = ?`,
        toHex(sealed.ciphertext), toHex(sealed.iv), sealed.keyVersion, SECRET_ALG, key, read.keyVersion,
      )
      return r.changes > 0
    })
  } catch {
    // 鍵・平文を含みうるので、例外の中身は出さない
    console.warn('秘密の値を今の鍵で書き直せませんでした（読み出しはできています）')
    return false
  }
}

/** 読んで、古い版なら今の鍵で書き直す。画面の API とサーバーの定期実行が使う入口 */
export async function readSecretAndRefresh(ctx: SecretScope, ring: KeyRing, key: string): Promise<SecretRead> {
  const read = await readSecret(ctx, ring, key)
  if (read.status === 'ok' && read.stale) await rewriteIfStale(ctx, ring, key, read)
  if (read.status === 'unreadable') {
    console.error('秘密の値を復号できませんでした（入れ直してもらう）', { key })
  }
  return read
}
