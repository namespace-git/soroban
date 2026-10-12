import { randomUUID } from 'node:crypto'
import type { PGlite, Transaction } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mapDbError } from '../../errors'
import { createMigratedDb } from '../../test/migrate'
import { asApi, HH_A, HH_B, seedHouseholds, sqlstateOf } from './helpers'

// 20261012001900：Storage のバケットの大きさ・種類の制限と、同じ画像を 2 つの経費・型番に結ばない部分ユニーク索引

let db: PGlite

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
})

afterAll(async () => {
  await db.close()
})

describe('Storage のバケット', () => {
  const IMAGES = ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']

  it('media は 5MB・receipts は 10MB まで。種類は画像（jpeg・png・webp・gif・avif）だけ。公開／非公開は変わらない', async () => {
    const { rows } = await db.query<{ id: string; public: boolean; file_size_limit: string | number; allowed_mime_types: string[] }>(
      `select id, public, file_size_limit, allowed_mime_types from storage.buckets where id in ('media', 'receipts') order by id`)
    expect(rows.map((r) => ({ id: r.id, public: r.public, limit: Number(r.file_size_limit), mime: [...r.allowed_mime_types].sort() }))).toEqual([
      { id: 'media', public: true, limit: 5 * 1024 * 1024, mime: IMAGES },
      { id: 'receipts', public: false, limit: 10 * 1024 * 1024, mime: IMAGES },
    ])
  })

  it('HTML・SVG・PDF・動画は許可の中に無い（公開バケットに HTML を置かれない）', async () => {
    const { rows } = await db.query<{ ok: boolean }>(
      `select bool_or(allowed_mime_types && array['text/html', 'image/svg+xml', 'application/pdf', 'application/octet-stream', 'video/mp4']) as ok
         from storage.buckets where id in ('media', 'receipts')`)
    expect(rows[0].ok).toBe(false)
  })
})

describe('レシートは 1 つの経費にだけ付く（expense.receipt_path）', () => {
  const path = (hh: string): string => `${hh}/receipt/${randomUUID()}.jpg`
  const insert = (receiptPath: string | null) => (tx: Transaction) =>
    tx.query(
      `insert into app.expense (occurred_at, month, category, amount, receipt_path) values ('2026-10-01', '2026-10', 'other', 100, $1)`,
      [receiptPath])

  it('同じ世帯で同じパスを 2 つの経費に付けると 23505（索引 expense_receipt_path_unique）。日本語に写る', async () => {
    const p = path(HH_A)
    await asApi(db, HH_A, insert(p))
    const err = await asApi(db, HH_A, insert(p)).then(() => null, (e: unknown) => e)
    expect(err).toMatchObject({ code: '23505', constraint: 'expense_receipt_path_unique' })
    const mapped = mapDbError(err)
    expect(mapped?.message).toBe('このレシートはすでに別の経費に付いています')
    expect(mapped?.code).toBe('conflict')
  })

  it('付け替えで重なる場合も止まる（update）。レシートの無い経費は何件あってもよい', async () => {
    const p1 = path(HH_A)
    const p2 = path(HH_A)
    await asApi(db, HH_A, insert(p1))
    await asApi(db, HH_A, insert(p2))
    for (let i = 0; i < 3; i++) await asApi(db, HH_A, insert(null))
    expect(await sqlstateOf(() => asApi(db, HH_A, (tx) =>
      tx.query('update app.expense set receipt_path = $1 where receipt_path = $2', [p1, p2])))).toBe('23505')
    // 外して付け直すのは通る
    await asApi(db, HH_A, async (tx) => {
      await tx.query('update app.expense set receipt_path = null where receipt_path = $1', [p2])
      await tx.query('update app.expense set receipt_path = $1 where receipt_path is null and id = (select id from app.expense where receipt_path is null limit 1)', [p2])
    })
  })

  it('世帯が違えば同じ文字列でも別（パスの先頭は世帯の id なので、実際には起きない）', async () => {
    const p = `shared/${randomUUID()}.jpg`
    await asApi(db, HH_A, insert(p))
    await asApi(db, HH_B, insert(p))
  })
})

describe('人が上げた商品画像は 1 つの型番にだけ付く（product_image）', () => {
  const insert = (code: string, p: string) => (tx: Transaction) =>
    tx.query('insert into app.product_image (model_code, path) values ($1, $2)', [code, p])

  it('<世帯>/product/… のパスを 2 つの型番に付けると 23505（索引 product_image_product_path_unique）。日本語に写る', async () => {
    const p = `${HH_A}/product/${randomUUID()}.jpg`
    await asApi(db, HH_A, insert('A001', p))
    const err = await asApi(db, HH_A, insert('A002', p)).then(() => null, (e: unknown) => e)
    expect(err).toMatchObject({ code: '23505', constraint: 'product_image_product_path_unique' })
    expect(mapDbError(err)?.message).toBe('この画像はすでに別の商品に使われています')
    // 同じ型番の置き換え（同じパスのまま更新）は通る
    await asApi(db, HH_A, (tx) => tx.query('update app.product_image set updated_at = now() where model_code = $1', ['A001']))
    // 付け替えで別の型番のパスに重ねると止まる
    const q = `${HH_A}/product/${randomUUID()}.jpg`
    await asApi(db, HH_A, insert('A003', q))
    expect(await sqlstateOf(() => asApi(db, HH_A, (tx) =>
      tx.query('update app.product_image set path = $1 where model_code = $2', [p, 'A003'])))).toBe('23505')
  })

  it('「自動を固定する」は仕入先・出品・販売の画像と同じパスを指す：複数の型番が同じパスを持ってよい（既存の動きを壊さない）', async () => {
    for (const kind of ['sale', 'listing', 'purchase-line']) {
      const p = `${HH_A}/${kind}/${randomUUID()}.jpg`
      await asApi(db, HH_A, insert(`${kind}-1`, p))
      await asApi(db, HH_A, insert(`${kind}-2`, p))
    }
    const n = await db.query<{ n: number }>(
      `select count(*)::int as n from app.product_image where household_id = $1 and model_code like '%-%'`, [HH_A])
    expect(n.rows[0].n).toBe(6)
  })

  it('世帯が違えば別。product の下でも他の世帯のパスは数えない（索引の範囲は自分の世帯のフォルダだけ）', async () => {
    const p = `${HH_B}/product/${randomUUID()}.jpg`
    // 世帯 A の行が世帯 B のフォルダを指す（アプリは通さない形）。<世帯 A>/product/ ではないので索引の外
    await asApi(db, HH_A, insert('X1', p))
    await asApi(db, HH_A, insert('X2', p))
    // 世帯 B の本来の形は 1 つだけ
    await asApi(db, HH_B, insert('X1', p))
    expect(await sqlstateOf(() => asApi(db, HH_B, insert('X2', p)))).toBe('23505')
  })
})
