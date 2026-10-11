import type { PGlite, Transaction } from '@electric-sql/pglite'

// 世帯 A / B と、それぞれのユーザー。固定の uuid にしておくと失敗時に読みやすい
export const HH_A = '00000000-0000-4000-8000-00000000000a'
export const HH_B = '00000000-0000-4000-8000-00000000000b'
export const USER_A = '00000000-0000-4000-8000-0000000000a1'
export const USER_B = '00000000-0000-4000-8000-0000000000b1'

/** 世帯 A / B とそのメンバーを作る。接続したロール（テーブルの持ち主）で書く */
export async function seedHouseholds(db: PGlite): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'a@example.test'),
      ('${USER_B}', 'b@example.test');
    insert into app.household (id, name) values
      ('${HH_A}', '世帯A'),
      ('${HH_B}', '世帯B');
    insert into app.household_member (household_id, user_id, role) values
      ('${HH_A}', '${USER_A}', 'owner'),
      ('${HH_B}', '${USER_B}', 'owner');
  `)
}

/**
 * API と同じ入り方：1 トランザクションの中で `set local role soroban_api` し、
 * app.household_id（と任意で app.user_id）を渡してから fn を実行する。
 * fn が投げたらロールバックされ、そのまま投げ直される
 */
export async function asApi<T>(
  db: PGlite,
  householdId: string,
  fn: (tx: Transaction) => Promise<T>,
  opts: { userId?: string } = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('set local role soroban_api')
    await tx.query("select set_config('app.household_id', $1, true)", [householdId])
    if (opts.userId) await tx.query("select set_config('app.user_id', $1, true)", [opts.userId])
    return fn(tx)
  })
}

/** 世帯を渡さずに soroban_api になる（渡し忘れのときの挙動を見る用） */
export async function asApiWithoutHousehold<T>(
  db: PGlite,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('set local role soroban_api')
    return fn(tx)
  })
}

/** 指定したロール（anon など）で実行する */
export async function asRole<T>(
  db: PGlite,
  role: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${role}`)
    return fn(tx)
  })
}

/** 投げられたエラーの SQLSTATE を返す。投げられなければ null */
export async function sqlstateOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (e) {
    const code = (e as { code?: unknown }).code
    return typeof code === 'string' ? code : 'unknown'
  }
}

/** 世帯の中に、仕入 → 在庫 → 販売 の最小の鎖を作る（asApi の中で呼ぶ。household_id は既定値） */
export interface Chain {
  shopAccountId: string
  purchaseId: string
  purchaseLineId: string
  inventoryItemId: string
  saleId: string
}

export async function insertChain(tx: Transaction, suffix: string): Promise<Chain> {
  const one = async (sql: string, params: unknown[]): Promise<string> =>
    (await tx.query<{ id: string }>(sql, params)).rows[0].id

  const shopAccountId = await one(
    `insert into app.shop_account (name, kind) values ($1, 'mellojoy') returning id`,
    [`メロジョイ${suffix}`],
  )
  const purchaseId = await one(
    `insert into app.purchase (shop_account_id, ordered_at, shipping_fee, order_no)
     values ($1, '2026-10-01', 500, $2) returning id`,
    [shopAccountId, `ORD-${suffix}`],
  )
  const purchaseLineId = await one(
    `insert into app.purchase_line (purchase_id, name, unit_price, quantity, model_code)
     values ($1, '商品', 1000, 1, 'A037') returning id`,
    [purchaseId],
  )
  const inventoryItemId = await one(
    `insert into app.inventory_item (item_code, purchase_line_id, name, landed_cost, acquired_at, model_code)
     values ($1, $2, '商品', 1500, '2026-10-01', 'A037') returning id`,
    [`S-${suffix}`, purchaseLineId],
  )
  const saleId = await one(
    `insert into app.sale (channel_item_id, title, sold_at, price, fee)
     values ($1, '【A037】商品', '2026-10-05', 3000, 300) returning id`,
    [`m${suffix}`],
  )
  return { shopAccountId, purchaseId, purchaseLineId, inventoryItemId, saleId }
}
