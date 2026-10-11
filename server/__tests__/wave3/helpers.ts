import { createHash, randomUUID } from 'node:crypto'
import type { PGlite, Transaction } from '@electric-sql/pglite'
import { asApi, HH_A } from '../schema/helpers'

export { asApi, asRole, HH_A, HH_B, seedHouseholds, sqlstateOf, USER_A, USER_B } from '../schema/helpers'

// 世帯 A のもう 1 人（通知を「自分の端末だけ」に絞る確認用）
export const USER_A2 = '00000000-0000-4000-8000-0000000000a2'

/** 鍵（平文）→ agent_device.token_hash（SHA-256 の 16 進、小文字 64 文字） */
export const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex')

/** 世帯 A に 2 人目を入れる（auth.users とメンバー）。接続したロールで書く */
export async function addSecondMemberToA(db: PGlite): Promise<void> {
  await db.query(`insert into auth.users (id, email) values ($1, 'a2@example.test') on conflict do nothing`, [USER_A2])
  await db.query(
    `insert into app.household_member (household_id, user_id) values ($1, $2) on conflict do nothing`,
    [HH_A, USER_A2],
  )
}

/**
 * Cron の Worker と同じ入り方：1 トランザクションの中で `set local role soroban_cron` する。
 * householdId を渡すと app.household_id も渡す（世帯の文脈の中で書く場合）。渡さなければ世帯をまたぐ
 */
export async function asCron<T>(
  db: PGlite,
  householdId: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('set local role soroban_cron')
    if (householdId) await tx.query("select set_config('app.household_id', $1, true)", [householdId])
    return fn(tx)
  })
}

/** Supabase の Storage と同じ入り方：authenticated ＋ JWT の sub（userId が null なら JWT なし） */
export async function asAuthenticated<T>(
  db: PGlite,
  userId: string | null,
  fn: (tx: Transaction) => Promise<T>,
  role: 'authenticated' | 'anon' = 'authenticated',
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${role}`)
    if (userId) await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId])
    return fn(tx)
  })
}

export interface Sub {
  id: string
  endpoint: string
}

/** 購読を 1 つ積む（asApi の中で呼ぶ）。kinds を渡すと受け取る種類を指定する */
export async function insertSub(
  tx: Transaction,
  userId: string,
  opts: { label?: string; kinds?: Partial<Record<'sale' | 'shipping' | 'collect' | 'arrival', boolean>> } = {},
): Promise<Sub> {
  const endpoint = `https://push.example.test/${randomUUID()}`
  const k = { sale: true, shipping: true, collect: true, arrival: true, ...opts.kinds }
  const r = await tx.query<{ id: string }>(
    `insert into app.push_subscription (user_id, endpoint, p256dh, auth, label, kind_sale, kind_shipping, kind_collect, kind_arrival)
     values ($1, $2, 'p', 'a', $3, $4, $5, $6, $7) returning id`,
    [userId, endpoint, opts.label ?? '', k.sale, k.shipping, k.collect, k.arrival],
  )
  return { id: r.rows[0].id, endpoint }
}

/** 世帯の中で通知を 1 つ積む。積んだ event の id（重複なら null） */
export const enqueue = (
  db: PGlite,
  hh: string,
  kind: string,
  dedupe: string,
  opts: { userId?: string | null; title?: string } = {},
): Promise<string | null> =>
  asApi(db, hh, async (tx) =>
    (await tx.query<{ id: string | null }>(
      'select app.enqueue_notification($1, $2, $3, $4, $5, $6) as id',
      [kind, opts.title ?? `題名 ${dedupe}`, '本文', '/sales', dedupe, opts.userId ?? null],
    )).rows[0].id,
  )
