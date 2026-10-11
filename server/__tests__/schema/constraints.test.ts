import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite, Transaction } from '@electric-sql/pglite'
import { createMigratedDb } from '../../test/migrate'
import { asApi, HH_A, HH_B, insertChain, seedHouseholds, sqlstateOf, USER_A, USER_B } from './helpers'

let db: PGlite

beforeAll(async () => {
  db = await createMigratedDb()
  await seedHouseholds(db)
})

afterAll(async () => {
  await db.close()
})

const idOf = async (tx: Transaction, sql: string, params: unknown[] = []): Promise<string> =>
  (await tx.query<{ id: string }>(sql, params)).rows[0].id

const newInventory = (tx: Transaction, code: string, status = 'in_stock') =>
  idOf(
    tx,
    `insert into app.inventory_item (item_code, name, landed_cost, acquired_at, status)
     values ($1, '在庫', 1000, '2026-10-01', $2) returning id`,
    [code, status],
  )

const newSale = (tx: Transaction, title: string, price = 3000, channelItemId: string | null = null) =>
  idOf(
    tx,
    `insert into app.sale (channel_item_id, title, sold_at, price) values ($1, $2, '2026-10-05', $3) returning id`,
    [channelItemId, title, price],
  )

const newListing = (tx: Transaction, channelItemId: string, channel = 'mercari') =>
  idOf(
    tx,
    `insert into app.listing (channel, channel_item_id, title, price, first_seen_at, last_seen_at, listed_at)
     values ($1, $2, '出品', 2000, '2026-10-01', now(), '2026-10-01') returning id`,
    [channel, channelItemId],
  )

describe('ユニーク制約は世帯ごと（世帯 A と B は同じ値を持てる。同じ世帯の中では持てない）', () => {
  const cases: Array<{
    name: string
    insert: (tx: Transaction) => Promise<unknown>
  }> = [
    {
      name: 'sale.channel_item_id',
      insert: (tx) => newSale(tx, '販売', 1000, 'mSAME'),
    },
    {
      name: 'listing（channel, channel_item_id）',
      insert: (tx) => newListing(tx, 'mSAME'),
    },
    {
      name: 'tag.name',
      insert: (tx) => tx.query(`insert into app.tag (name) values ('同じ名前')`),
    },
    {
      name: 'inventory_item.item_code',
      insert: (tx) => newInventory(tx, 'S-SAME'),
    },
    {
      name: 'purchase.import_key',
      insert: async (tx) => {
        const shop = await idOf(tx, `insert into app.shop_account (name) values ('店') returning id`)
        await tx.query(`insert into app.purchase (shop_account_id, ordered_at, import_key) values ($1, '2026-10-01', 'KEY-1')`, [shop])
      },
    },
    {
      name: 'setting（key）',
      insert: (tx) => tx.query(`insert into app.setting (key, value) values ('fee_rate_bp', '1000')`),
    },
    {
      name: 'sale_exclusion（channel_item_id）',
      insert: (tx) => tx.query(`insert into app.sale_exclusion (channel_item_id, title) values ('mSAME', '除外')`),
    },
    {
      name: 'product_name（model_code）',
      insert: (tx) => tx.query(`insert into app.product_name (model_code, name, updated_at) values ('A037', '名', now())`),
    },
    {
      name: 'month_book（month）',
      insert: (tx) => tx.query(`insert into app.month_book (month) values ('2026-09')`),
    },
    {
      name: 'shop_alias（key）',
      insert: (tx) => tx.query(`insert into app.shop_alias (key, shop, updated_at) values ('reg:T1', '店', now())`),
    },
  ]

  for (const c of cases) {
    it(c.name, async () => {
      await asApi(db, HH_A, c.insert)
      await asApi(db, HH_B, c.insert) // 別の世帯なら通る
      expect(await sqlstateOf(() => asApi(db, HH_A, c.insert))).toBe('23505') // 同じ世帯は不可
    })
  }

  it('同じ出品先の id でも、出品先（channel）が違えば別の出品として持てる', async () => {
    await asApi(db, HH_A, async (tx) => {
      await newListing(tx, 'mCH', 'mercari')
      await newListing(tx, 'mCH', 'yahoo')
    })
  })

  it('手入力の販売（channel_item_id が NULL）は何件でも持てる', async () => {
    await asApi(db, HH_A, async (tx) => {
      await newSale(tx, '手入力1')
      await newSale(tx, '手入力2')
    })
  })

  it('purchase の（仕入先, 注文番号）は一意。注文番号が NULL なら何件でも', async () => {
    await asApi(db, HH_A, async (tx) => {
      const shop = await idOf(tx, `insert into app.shop_account (name) values ('店2') returning id`)
      const ins = (no: string | null) =>
        tx.query(`insert into app.purchase (shop_account_id, ordered_at, order_no) values ($1, '2026-10-01', $2)`, [shop, no])
      await ins(null)
      await ins(null)
      await ins('ORD-1')
      await expect(ins('ORD-1')).rejects.toMatchObject({ code: '23505' })
    })
  })

  it('1 つの在庫は 1 回しか売れない（sale_line.inventory_item_id）。世帯をまたいでも別の在庫なので影響しない', async () => {
    await asApi(db, HH_A, async (tx) => {
      const item = await newInventory(tx, 'S-ONCE')
      const s1 = await newSale(tx, '販売1')
      const s2 = await newSale(tx, '販売2')
      await tx.query('insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2)', [s1, item])
      await expect(
        tx.query('insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2)', [s2, item]),
      ).rejects.toMatchObject({ code: '23505' })
    })
  })
})

describe('CHECK 制約', () => {
  const bad: Array<[string, string, unknown[]]> = [
    ['sale.status', `insert into app.sale (title, sold_at, price, status) values ('x', '2026-10-01', 1, 'bogus')`, []],
    ['sale.channel', `insert into app.sale (title, sold_at, price, channel) values ('x', '2026-10-01', 1, 'ebay')`, []],
    ['sale.kind', `insert into app.sale (title, sold_at, price, kind) values ('x', '2026-10-01', 1, 'gift')`, []],
    ['sale.fee_source', `insert into app.sale (title, sold_at, price, fee_source) values ('x', '2026-10-01', 1, 'guess')`, []],
    ['sale.shipping_source', `insert into app.sale (title, sold_at, price, shipping_source) values ('x', '2026-10-01', 1, 'guess')`, []],
    ['sale.source', `insert into app.sale (title, sold_at, price, source) values ('x', '2026-10-01', 1, 'import')`, []],
    ['inventory_item.status', `insert into app.inventory_item (item_code, name, landed_cost, acquired_at, status) values ('S-BAD', 'x', 1, '2026-10-01', 'lost')`, []],
    ['sale_line.link_source', `insert into app.sale_line (sale_id, inventory_item_id, link_source) values (gen_random_uuid(), gen_random_uuid(), 'x')`, []],
    ['listing.status', `insert into app.listing (channel_item_id, title, price, first_seen_at, last_seen_at, listed_at, status) values ('m', 'x', 1, '2026-10-01', now(), '2026-10-01', 'gone')`, []],
    ['shop_account.kind', `insert into app.shop_account (name, kind) values ('x', 'amazon')`, []],
    ['collector_run.status', `insert into app.collector_run (started_at, status) values (now(), 'x')`, []],
    ['collector_run.source', `insert into app.collector_run (started_at, source) values (now(), 'foo')`, []],
    ['cash_account.opening_balance >= 0', `insert into app.cash_account (name, opening_balance, opening_date) values ('x', -1, '2026-10-01')`, []],
    ['liability.amount > 0', `insert into app.liability (kind, counterparty, occurred_at, amount) values ('loan', 'x', '2026-10-01', 0)`, []],
    ['liability.kind', `insert into app.liability (kind, counterparty, occurred_at, amount) values ('x', 'x', '2026-10-01', 1)`, []],
    ['liability.month', `insert into app.liability (kind, counterparty, occurred_at, amount, month) values ('purchase', 'x', '2026-10-01', 1, '2026/10')`, []],
    ['expense.month', `insert into app.expense (occurred_at, month, category, amount) values ('2026-10-01', '2026-1', 'other', 1)`, []],
    ['month_book.month', `insert into app.month_book (month) values ('202610')`, []],
    ['month_book.alloc_method', `insert into app.month_book (month, alloc_method) values ('2026-10', 'x')`, []],
    ['notification_outbox.status', `insert into app.notification_outbox (kind, title, status) values ('k', 't', 'done')`, []],
    ['collect_job.status', `insert into app.collect_job (status) values ('paused')`, []],
    ['collect_job: running なら lease が要る', `insert into app.collect_job (status) values ('running')`, []],
  ]
  for (const [name, sql, params] of bad) {
    it(`${name} に反する値は入らない`, async () => {
      expect(await sqlstateOf(() => asApi(db, HH_A, (tx) => tx.query(sql, params)))).toBe('23514')
    })
  }

  it('purchase_line.quantity > 0、cash_entry.amount > 0、direction / category、expense の月の形式', async () => {
    await asApi(db, HH_A, async (tx) => {
      const chain = await insertChain(tx, 'CHK')
      const q = (sql: string, params: unknown[]) => sqlstateOf(async () => {
        await tx.query('savepoint s')
        try {
          await tx.query(sql, params)
        } finally {
          await tx.query('rollback to savepoint s')
        }
      })
      expect(await q(`insert into app.purchase_line (purchase_id, name, unit_price, quantity) values ($1, 'x', 1, 0)`, [chain.purchaseId])).toBe('23514')
      const account = await idOf(tx, `insert into app.cash_account (name, opening_date) values ('銀行', '2026-10-01') returning id`)
      expect(await q(`insert into app.cash_entry (account_id, occurred_at, direction, amount, category) values ($1, '2026-10-01', 'in', 0, 'other')`, [account])).toBe('23514')
      expect(await q(`insert into app.cash_entry (account_id, occurred_at, direction, amount, category) values ($1, '2026-10-01', 'sideways', 1, 'other')`, [account])).toBe('23514')
      expect(await q(`insert into app.cash_entry (account_id, occurred_at, direction, amount, category) values ($1, '2026-10-01', 'in', 1, 'gift')`, [account])).toBe('23514')
    })
  })

  it('household_member.role は owner / member だけ', async () => {
    expect(
      await sqlstateOf(() =>
        db.query(`insert into app.household_member (household_id, user_id, role) values ($1, $2, 'admin')`, [HH_A, USER_B]),
      ),
    ).toBe('23514')
  })
})

describe('トリガー', () => {
  it('紐付けたら在庫が sold に、外したら in_stock に戻る（販売ごと消しても戻る）', async () => {
    await asApi(db, HH_A, async (tx) => {
      const item = await newInventory(tx, 'S-TRG1')
      const item2 = await newInventory(tx, 'S-TRG2')
      const sale = await newSale(tx, '販売')
      const status = async (id: string) =>
        (await tx.query<{ status: string }>('select status from app.inventory_item where id = $1', [id])).rows[0].status

      const line = await idOf(tx, 'insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2) returning id', [sale, item])
      await tx.query('insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2)', [sale, item2])
      expect(await status(item)).toBe('sold')
      expect(await status(item2)).toBe('sold')

      await tx.query('delete from app.sale_line where id = $1', [line])
      expect(await status(item)).toBe('in_stock')
      expect(await status(item2)).toBe('sold')

      await tx.query('delete from app.sale where id = $1', [sale]) // sale_line が cascade で消える
      expect(await status(item2)).toBe('in_stock')
    })
  })

  it('他の世帯の在庫の状態は動かさない', async () => {
    const itemB = await asApi(db, HH_B, (tx) => newInventory(tx, 'S-ISO'))
    await asApi(db, HH_A, async (tx) => {
      const item = await newInventory(tx, 'S-ISO')
      const sale = await newSale(tx, '販売')
      await tx.query('insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2)', [sale, item])
    })
    const { rows } = await db.query<{ status: string }>('select status from app.inventory_item where id = $1', [itemB])
    expect(rows[0].status).toBe('in_stock')
  })

  describe('listing_line のガード', () => {
    it('未販売の在庫を active な出品に引き当てられる', async () => {
      await asApi(db, HH_A, async (tx) => {
        const item = await newInventory(tx, 'S-G1')
        const listing = await newListing(tx, 'mG1')
        await tx.query('insert into app.listing_line (listing_id, inventory_item_id) values ($1, $2)', [listing, item])
        // 出品は在庫の状態を変えない
        expect((await tx.query<{ status: string }>('select status from app.inventory_item where id = $1', [item])).rows[0].status).toBe('in_stock')
      })
    })

    it('同じ在庫を別の active / suspended な出品に二重に引き当てられない', async () => {
      await asApi(db, HH_A, async (tx) => {
        const item = await newInventory(tx, 'S-G2')
        const l1 = await newListing(tx, 'mG2a')
        const l2 = await newListing(tx, 'mG2b')
        await tx.query('insert into app.listing_line (listing_id, inventory_item_id) values ($1, $2)', [l1, item])
        await expect(
          tx.query('insert into app.listing_line (listing_id, inventory_item_id) values ($1, $2)', [l2, item]),
        ).rejects.toMatchObject({ message: '既に別の出品に引き当て済み' })
      })
    })

    it('最初の出品が終わって（ended）いれば、別の出品に引き当て直せる', async () => {
      await asApi(db, HH_A, async (tx) => {
        const item = await newInventory(tx, 'S-G3')
        const l1 = await newListing(tx, 'mG3a')
        const l2 = await newListing(tx, 'mG3b')
        await tx.query('insert into app.listing_line (listing_id, inventory_item_id) values ($1, $2)', [l1, item])
        await tx.query(`update app.listing set status = 'ended' where id = $1`, [l1])
        await tx.query('insert into app.listing_line (listing_id, inventory_item_id) values ($1, $2)', [l2, item])
      })
    })

    it('未販売でない在庫（sold / disposed など）は引き当てられない', async () => {
      await asApi(db, HH_A, async (tx) => {
        const listing = await newListing(tx, 'mG4')
        for (const [i, status] of ['sold', 'disposed', 'personal_use', 'split'].entries()) {
          const item = await newInventory(tx, `S-G4-${i}`, status)
          await tx.query('savepoint s')
          await expect(
            tx.query('insert into app.listing_line (listing_id, inventory_item_id) values ($1, $2)', [listing, item]),
          ).rejects.toMatchObject({ message: '未販売の在庫だけ引き当てられます' })
          await tx.query('rollback to savepoint s')
        }
      })
    })

    it('終了した（sold / ended）出品には引き当てられない', async () => {
      await asApi(db, HH_A, async (tx) => {
        for (const [i, status] of ['sold', 'ended'].entries()) {
          const item = await newInventory(tx, `S-G5-${i}`)
          const listing = await newListing(tx, `mG5-${i}`)
          await tx.query('update app.listing set status = $2 where id = $1', [listing, status])
          await tx.query('savepoint s')
          await expect(
            tx.query('insert into app.listing_line (listing_id, inventory_item_id) values ($1, $2)', [listing, item]),
          ).rejects.toMatchObject({ message: '終了した出品には引き当てられません' })
          await tx.query('rollback to savepoint s')
        }
      })
    })

    it('suspended の出品には引き当てられる', async () => {
      await asApi(db, HH_A, async (tx) => {
        const item = await newInventory(tx, 'S-G6')
        const listing = await newListing(tx, 'mG6')
        await tx.query(`update app.listing set status = 'suspended' where id = $1`, [listing])
        await tx.query('insert into app.listing_line (listing_id, inventory_item_id) values ($1, $2)', [listing, item])
      })
    })
  })
})

describe('外部キーの動き（SQLite と同じ）', () => {
  it('発送方法を消すと、出品の発送方法だけが NULL になる（世帯は消えない）。販売が使っていれば消せない', async () => {
    await asApi(db, HH_A, async (tx) => {
      const ship = await idOf(tx, `insert into app.shipping_method (name, fee) values ('ネコポス', 210) returning id`)
      const listing = await idOf(
        tx,
        `insert into app.listing (channel_item_id, title, price, first_seen_at, last_seen_at, listed_at, shipping_method_id)
         values ('mFKS', '出品', 2000, '2026-10-01', now(), '2026-10-01', $1) returning id`,
        [ship],
      )
      await tx.query('savepoint s')
      await tx.query(`insert into app.sale (title, sold_at, price, shipping_method_id) values ('販売', '2026-10-01', 1, $1)`, [ship])
      await expect(tx.query('delete from app.shipping_method where id = $1', [ship])).rejects.toMatchObject({ code: '23503' })
      await tx.query('rollback to savepoint s')

      await tx.query('delete from app.shipping_method where id = $1', [ship])
      const { rows } = await tx.query<{ household_id: string; shipping_method_id: string | null }>(
        'select household_id, shipping_method_id from app.listing where id = $1', [listing],
      )
      expect(rows).toEqual([{ household_id: HH_A, shipping_method_id: null }])
    })
  })

  it('仕入を消すと明細と在庫も消える。ただし販売に紐付いた在庫があれば消せない', async () => {
    await asApi(db, HH_A, async (tx) => {
      const gone = await insertChain(tx, 'FKP1')
      await tx.query('delete from app.purchase where id = $1', [gone.purchaseId])
      const left = await tx.query('select 1 from app.inventory_item where id = $1', [gone.inventoryItemId])
      expect(left.rows).toHaveLength(0)

      const kept = await insertChain(tx, 'FKP2')
      await tx.query('insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2)', [kept.saleId, kept.inventoryItemId])
      await tx.query('savepoint s')
      await expect(tx.query('delete from app.purchase where id = $1', [kept.purchaseId])).rejects.toMatchObject({ code: '23503' })
      await tx.query('rollback to savepoint s')
    })
  })

  it('タグを消すと、販売・在庫・仕入・型番・仕入先からの付け外しも消える', async () => {
    await asApi(db, HH_A, async (tx) => {
      const chain = await insertChain(tx, 'FKT')
      const tag = await idOf(tx, `insert into app.tag (name) values ('消すタグ') returning id`)
      await tx.query('insert into app.sale_tag (sale_id, tag_id) values ($1, $2)', [chain.saleId, tag])
      await tx.query('insert into app.inventory_tag (inventory_item_id, tag_id) values ($1, $2)', [chain.inventoryItemId, tag])
      await tx.query('insert into app.purchase_tag (purchase_id, tag_id) values ($1, $2)', [chain.purchaseId, tag])
      await tx.query(`insert into app.product_tag (model_code, tag_id) values ('A037', $1)`, [tag])
      await tx.query('insert into app.shop_account_tag (shop_account_id, tag_id) values ($1, $2)', [chain.shopAccountId, tag])
      await tx.query('delete from app.tag where id = $1', [tag])
      for (const t of ['sale_tag', 'inventory_tag', 'purchase_tag', 'product_tag', 'shop_account_tag']) {
        const { rows } = await tx.query(`select 1 from app.${t} where tag_id = $1`, [tag])
        expect(rows, t).toHaveLength(0)
      }
    })
  })
})

describe('sale_line.allocation_order（まとめ売りの端数をどの行に寄せるかを決める並び順）', () => {
  /** sale_line_share と同じ按分：base = floor(合計 / 点数)、余りは「最後の r 行」に +1 */
  const SHARE_SQL = `
    with o as (
      select sl.id, row_number() over (partition by sl.sale_id order by sl.allocation_order) as rn,
             count(*) over (partition by sl.sale_id) as n
        from app.sale_line sl where sl.sale_id = $1
    )
    select o.rn::int as rn,
           (($2::int - rem.r) / o.n + case when o.rn > o.n - rem.r then 1 else 0 end)::int as share
      from o, lateral (select ((($2::int % o.n) + o.n) % o.n) as r) rem
     order by o.rn`

  it('紐付けた順に増える。UUID の大小とは無関係', async () => {
    await asApi(db, HH_A, async (tx) => {
      const sale = await newSale(tx, 'まとめ売り')
      const ids: string[] = []
      for (const code of ['S-O3', 'S-O1', 'S-O2', 'S-O5', 'S-O4']) {
        const item = await newInventory(tx, code)
        ids.push(await idOf(tx, 'insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2) returning id', [sale, item]))
      }
      const { rows } = await tx.query<{ id: string; allocation_order: string }>(
        'select id, allocation_order from app.sale_line where sale_id = $1 order by allocation_order',
        [sale],
      )
      expect(rows.map((r) => r.id)).toEqual(ids)
      const orders = rows.map((r) => Number(r.allocation_order))
      expect([...orders].sort((a, b) => a - b)).toEqual(orders)
      expect(new Set(orders).size).toBe(5)
    })
  })

  it('一度付いたら変わらない：直接の更新・default での振り直しは拒否される。他の列の更新は通る', async () => {
    await asApi(db, HH_A, async (tx) => {
      const sale = await newSale(tx, 'まとめ売り')
      const a = await idOf(tx, 'insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2) returning id', [sale, await newInventory(tx, 'S-IM1')])
      await tx.query('insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2)', [sale, await newInventory(tx, 'S-IM2')])

      await tx.query('savepoint s1')
      await expect(tx.query('update app.sale_line set allocation_order = 9999 where id = $1', [a])).rejects.toThrow()
      await tx.query('rollback to savepoint s1')

      await tx.query('savepoint s2')
      await expect(tx.query('update app.sale_line set allocation_order = default where id = $1', [a])).rejects.toThrow()
      await tx.query('rollback to savepoint s2')

      await tx.query(`update app.sale_line set link_source = 'auto' where id = $1`, [a])
      const { rows } = await tx.query<{ id: string; link_source: string }>(
        'select id, link_source from app.sale_line where sale_id = $1 order by allocation_order', [sale],
      )
      expect(rows[0]).toEqual({ id: a, link_source: 'auto' })
    })
  })

  it('途中の行を外しても、残りの順序は変わらない。外して付け直した行は最後になる', async () => {
    await asApi(db, HH_A, async (tx) => {
      const sale = await newSale(tx, 'まとめ売り')
      const items: string[] = []
      const lines: string[] = []
      for (const code of ['S-RM1', 'S-RM2', 'S-RM3']) {
        const item = await newInventory(tx, code)
        items.push(item)
        lines.push(await idOf(tx, 'insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2) returning id', [sale, item]))
      }
      await tx.query('delete from app.sale_line where id = $1', [lines[1]])
      let order = (await tx.query<{ id: string }>('select id from app.sale_line where sale_id = $1 order by allocation_order', [sale])).rows
      expect(order.map((r) => r.id)).toEqual([lines[0], lines[2]])

      const re = await idOf(tx, 'insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2) returning id', [sale, items[1]])
      order = (await tx.query<{ id: string }>('select id from app.sale_line where sale_id = $1 order by allocation_order', [sale])).rows
      expect(order.map((r) => r.id)).toEqual([lines[0], lines[2], re])
    })
  })

  it('この順で按分すると、端数は最後の行に寄り、合計は必ず一致する（1,001 円÷3 → 333/334/334、-100 円÷3 → -34/-33/-33）', async () => {
    await asApi(db, HH_A, async (tx) => {
      const sale = await newSale(tx, 'まとめ売り', 1001)
      for (const code of ['S-SH1', 'S-SH2', 'S-SH3']) {
        await tx.query('insert into app.sale_line (sale_id, inventory_item_id) values ($1, $2)', [sale, await newInventory(tx, code)])
      }
      const price = (await tx.query<{ share: number }>(SHARE_SQL, [sale, 1001])).rows.map((r) => r.share)
      expect(price).toEqual([333, 334, 334])
      expect(price.reduce((a, b) => a + b, 0)).toBe(1001)

      const loss = (await tx.query<{ share: number }>(SHARE_SQL, [sale, -100])).rows.map((r) => r.share)
      expect(loss).toEqual([-34, -33, -33])
      expect(loss.reduce((a, b) => a + b, 0)).toBe(-100)
    })
  })

  it('並び順の列は一意（販売の中で同じ番号が 2 行に付かない）。世帯をまたいで番号が連続していなくてもよい', async () => {
    const { rows } = await db.query<{ is_identity: string; identity_generation: string; data_type: string }>(
      `select is_identity, identity_generation, data_type from information_schema.columns
        where table_schema = 'app' and table_name = 'sale_line' and column_name = 'allocation_order'`,
    )
    expect(rows).toEqual([{ is_identity: 'YES', identity_generation: 'ALWAYS', data_type: 'bigint' }])
    expect(
      await sqlstateOf(() =>
        asApi(db, HH_A, async (tx) => {
          const sale = await newSale(tx, 'まとめ売り')
          await tx.query('insert into app.sale_line (sale_id, inventory_item_id, allocation_order) values ($1, $2, 1)', [sale, await newInventory(tx, 'S-EX1')])
        }),
      ),
    ).not.toBeNull() // generated always：直接は入れられない
  })
})

describe('列の型', () => {
  const columnsOf = async (dataTypes: string[]) =>
    (await db.query<{ t: string }>(
      `select table_name || '.' || column_name as t from information_schema.columns
        where table_schema = 'app' and data_type = any($1) order by 1`,
      [dataTypes],
    )).rows.map((r) => r.t)

  const typeOf = async (table: string, column: string) =>
    (await db.query<{ data_type: string; udt_name: string }>(
      `select data_type, udt_name from information_schema.columns
        where table_schema = 'app' and table_name = $1 and column_name = $2`,
      [table, column],
    )).rows[0]

  it('金額の列は integer（円）。小数・浮動小数の列は 1 つも無い', async () => {
    const money: Array<[string, string]> = [
      ['shop_account', 'default_shipping_fee'], ['shipping_method', 'fee'],
      ['purchase', 'shipping_fee'], ['purchase', 'discount'], ['purchase', 'other_cost'],
      ['purchase_line', 'unit_price'], ['purchase_line', 'allocated_cost'], ['purchase_line', 'landed_unit_cost'],
      ['inventory_item', 'landed_cost'],
      ['sale', 'price'], ['sale', 'fee'], ['sale', 'shipping_fee'], ['sale', 'packaging_cost'],
      ['listing', 'price'],
      ['expense', 'amount'], ['expense_line', 'unit_price'], ['expense_line', 'amount'],
      ['month_book', 'revenue'], ['month_book', 'gross_profit'], ['month_book', 'expense_total'], ['month_book', 'net_profit'],
      ['cash_account', 'opening_balance'], ['liability', 'amount'], ['liability', 'basis_amount'],
      ['cash_entry', 'amount'], ['liability_settlement', 'amount'],
    ]
    for (const [table, column] of money) {
      expect((await typeOf(table, column))?.data_type, `${table}.${column}`).toBe('integer')
    }
    expect(await columnsOf(['real', 'double precision', 'numeric', 'money'])).toEqual([])
  })

  it('計上日・仕入日・月の初日など「日」は date', async () => {
    const dates: Array<[string, string]> = [
      ['purchase', 'ordered_at'], ['purchase', 'shipped_at'], ['purchase', 'delivered_at'],
      ['inventory_item', 'acquired_at'], ['inventory_item', 'disposed_at'],
      ['sale', 'sold_at'], ['sale', 'shipped_at'], ['sale', 'delivered_at'], ['sale', 'completed_at'],
      ['listing', 'first_seen_at'], ['listing', 'listed_at'],
      ['expense', 'occurred_at'],
      ['cash_account', 'opening_date'], ['cash_entry', 'occurred_at'],
      ['liability', 'occurred_at'], ['liability', 'due_at'],
    ]
    for (const [table, column] of dates) {
      expect((await typeOf(table, column))?.data_type, `${table}.${column}`).toBe('date')
    }
  })

  it('取り込んだ時刻など「出来事の時刻」は timestamptz', async () => {
    const stamps: Array<[string, string]> = [
      ['purchase', 'fulfillment_updated_at'], ['purchase', 'image_checked_at'],
      ['purchase', 'tracking_checked_at'], ['purchase', 'tracking_registered_at'],
      ['purchase', 'created_at'], ['purchase', 'updated_at'],
      ['sale', 'purchased_at'], ['sale', 'created_at'], ['sale', 'updated_at'],
      ['listing', 'last_seen_at'], ['listing', 'created_at'],
      ['month_book', 'closed_at'], ['collector_run', 'started_at'], ['collector_run', 'finished_at'],
      ['app_log', 'ts'], ['shop_alias', 'updated_at'], ['product_name', 'updated_at'],
      ['collect_job', 'requested_at'], ['collect_job', 'claimed_at'], ['collect_job', 'heartbeat_at'],
      ['collect_job', 'finished_at'], ['collect_job', 'lease_expires_at'],
      ['notification_outbox', 'created_at'], ['notification_outbox', 'sent_at'],
      ['notification_outbox', 'next_attempt_at'], ['notification_outbox', 'claimed_at'],
      ['push_subscription', 'created_at'], ['push_subscription', 'last_used_at'],
      ['setting_secret', 'updated_at'],
    ]
    for (const [table, column] of stamps) {
      expect((await typeOf(table, column))?.data_type, `${table}.${column}`).toBe('timestamp with time zone')
    }
  })

  it('_at / _date で終わる列は、すべて date か timestamptz（日付を text で持たない）', async () => {
    const { rows } = await db.query<{ t: string; data_type: string }>(
      `select table_name || '.' || column_name as t, data_type from information_schema.columns
        where table_schema = 'app' and (column_name like '%\\_at' or column_name like '%\\_date' or column_name = 'ts')
          and data_type not in ('date', 'timestamp with time zone')`,
    )
    expect(rows).toEqual([])
  })

  it('月（YYYY-MM）は text', async () => {
    for (const [table, column] of [['expense', 'month'], ['month_book', 'month'], ['liability', 'month']]) {
      expect((await typeOf(table, column))?.data_type, `${table}.${column}`).toBe('text')
    }
  })

  it('model_codes は text[]、raw / result / payload は jsonb、app_log.payload は text', async () => {
    expect(await typeOf('sale', 'model_codes')).toEqual({ data_type: 'ARRAY', udt_name: '_text' })
    for (const [table, column] of [['sale', 'raw'], ['collect_job', 'result'], ['notification_outbox', 'payload']]) {
      expect((await typeOf(table, column))?.data_type, `${table}.${column}`).toBe('jsonb')
    }
    expect((await typeOf('app_log', 'payload'))?.data_type).toBe('text')
  })

  it('model_codes は配列として入って、既定は空配列', async () => {
    const row = await asApi(db, HH_A, async (tx) => {
      const a = await tx.query<{ model_codes: string[] }>(
        `insert into app.sale (title, sold_at, price, model_codes, raw) values ('x', '2026-10-01', 1, '{A037,A035}', '{"fee": 100}') returning model_codes`,
      )
      const b = await tx.query<{ model_codes: string[] }>(
        `insert into app.sale (title, sold_at, price) values ('y', '2026-10-01', 1) returning model_codes`,
      )
      return { a: a.rows[0].model_codes, b: b.rows[0].model_codes }
    })
    expect(row).toEqual({ a: ['A037', 'A035'], b: [] })
  })

  it('名前の見直し：mercari_item_id と *_file は無く、channel_item_id と *_path がある', async () => {
    const { rows } = await db.query<{ t: string }>(
      `select table_name || '.' || column_name as t from information_schema.columns
        where table_schema = 'app' and (column_name = 'mercari_item_id' or column_name like '%\\_file')`,
    )
    expect(rows).toEqual([])
    for (const [table, column] of [
      ['sale', 'channel_item_id'], ['listing', 'channel_item_id'], ['sale_exclusion', 'channel_item_id'],
      ['sale', 'thumb_path'], ['listing', 'thumb_path'], ['purchase_line', 'image_path'],
      ['expense', 'receipt_path'], ['product_image', 'path'],
    ]) {
      expect(await typeOf(table, column), `${table}.${column}`).toBeDefined()
    }
  })

  it('listing は uuid の id が主キー、listing_line は listing(id) を指す', async () => {
    expect((await typeOf('listing', 'id')).data_type).toBe('uuid')
    expect((await typeOf('listing_line', 'listing_id')).data_type).toBe('uuid')
    const { rows } = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'app.listing'::regclass and contype = 'u' order by 1`,
    )
    expect(rows.map((r) => r.def)).toContain('UNIQUE (household_id, channel, channel_item_id)')
  })
})

describe('Web 版で増えたテーブル', () => {
  it('setting_secret は暗号文だけを持つ（平文の列が無い）', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'app' and table_name = 'setting_secret' order by ordinal_position`,
    )
    expect(rows).toEqual([
      { column_name: 'household_id', data_type: 'uuid' },
      { column_name: 'key', data_type: 'text' },
      { column_name: 'ciphertext', data_type: 'bytea' },
      { column_name: 'iv', data_type: 'bytea' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone' },
    ])
  })

  it('setting_secret は世帯ごとに 1 キー 1 行で、他の世帯からは見えない', async () => {
    const put = (tx: Transaction) =>
      tx.query(`insert into app.setting_secret (key, ciphertext, iv) values ('gemini_api_key', '\\x0102'::bytea, '\\x0a0b'::bytea)`)
    await asApi(db, HH_A, put)
    await asApi(db, HH_B, put)
    expect(await sqlstateOf(() => asApi(db, HH_A, put))).toBe('23505')
    const seenByA = await asApi(db, HH_A, async (tx) => (await tx.query('select * from app.setting_secret')).rows)
    expect(seenByA).toHaveLength(1)
  })

  it('push_subscription：世帯のメンバーだけが購読でき、endpoint は一意、メンバーを外すと消える', async () => {
    const sub = (userId: string, endpoint: string) => (tx: Transaction) =>
      tx.query(
        `insert into app.push_subscription (user_id, endpoint, p256dh, auth) values ($1, $2, 'p', 'a')`,
        [userId, endpoint],
      )
    await asApi(db, HH_A, sub(USER_A, 'https://push.example.test/a1'))
    // 世帯 A に属さない人（B のユーザー）は購読できない
    expect(await sqlstateOf(() => asApi(db, HH_A, sub(USER_B, 'https://push.example.test/b1')))).toBe('23503')
    // endpoint は端末ごとに一意
    expect(await sqlstateOf(() => asApi(db, HH_A, sub(USER_A, 'https://push.example.test/a1')))).toBe('23505')

    // 世帯 B からは見えない
    const seenByB = await asApi(db, HH_B, async (tx) => (await tx.query('select * from app.push_subscription')).rows)
    expect(seenByB).toEqual([])

    // 世帯から抜けると購読も消える
    await db.query(`insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000a2', 'a2@example.test')`)
    await db.query(`insert into app.household_member (household_id, user_id) values ($1, '00000000-0000-4000-8000-0000000000a2')`, [HH_A])
    await asApi(db, HH_A, sub('00000000-0000-4000-8000-0000000000a2', 'https://push.example.test/a2'))
    await db.query(`delete from app.household_member where user_id = '00000000-0000-4000-8000-0000000000a2'`)
    const left = await asApi(db, HH_A, async (tx) => (await tx.query<{ endpoint: string }>('select endpoint from app.push_subscription')).rows)
    expect(left.map((r) => r.endpoint)).toEqual(['https://push.example.test/a1'])
  })

  it('notification_outbox：再送の列（status / attempts / next_attempt_at / claimed_at / last_error / dedupe_key）', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'app' and table_name = 'notification_outbox'
          and column_name in ('status', 'attempts', 'next_attempt_at', 'claimed_at', 'last_error', 'dedupe_key')
        order by column_name`,
    )
    expect(rows).toEqual([
      { column_name: 'attempts', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'claimed_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'dedupe_key', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'last_error', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'next_attempt_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'status', data_type: 'text', is_nullable: 'NO' },
    ])

    const row = await asApi(db, HH_A, async (tx) =>
      (await tx.query<{ status: string; attempts: number; ok: boolean; sent_at: unknown }>(
        `insert into app.notification_outbox (kind, title) values ('sale', '売れました')
         returning status, attempts, next_attempt_at <= now() as ok, sent_at`,
      )).rows[0],
    )
    expect(row).toEqual({ status: 'pending', attempts: 0, ok: true, sent_at: null })
  })

  it('notification_outbox.dedupe_key は世帯の中で一意（同じ出来事を二重に積めない）。NULL は何件でも', async () => {
    const put = (key: string | null) => (tx: Transaction) =>
      tx.query(`insert into app.notification_outbox (kind, title, dedupe_key) values ('sale', 't', $1)`, [key])
    await asApi(db, HH_A, put('sale:1'))
    await asApi(db, HH_B, put('sale:1')) // 別の世帯なら同じ鍵でよい
    expect(await sqlstateOf(() => asApi(db, HH_A, put('sale:1')))).toBe('23505')
    await asApi(db, HH_A, async (tx) => {
      await put(null)(tx)
      await put(null)(tx)
    })
  })
})
