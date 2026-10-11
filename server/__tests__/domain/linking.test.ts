import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Ctx } from '../../context'
import { mapDbError } from '../../errors'
import * as inventory from '../../domain/inventory'
import * as sale from '../../domain/sale'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'
import { bindDb } from './core-helpers'

// src/main/__tests__/db.test.ts の db（:memory:）の中の、紐付け（linkInventory / unlinkInventory / 自動紐付け /
// 候補 / blockers / 付け替え / タグの派生）のテストを移したもの。期待値は変えていない。書き換えたのは「呼び方」だけ：
//   * 同期の db.xxx(...) → await db.xxx(...)、expect(() => …).toThrow → await expect(…).rejects.toThrow
//   * db.createPurchase は SQL の直接投入（core-helpers の seedPurchase）。setPurchaseTags / setProductTags / setProductName も SQL で直接
//   * getDb().prepare(…) の直接 SQL は db.sql / sqlGet / sqlRun（Postgres の列名・型）に読み替えた
//   * 'sale-sold-test' のような uuid でない id は、Postgres の uuid 列に入らないので、本物の uuid を作って使った
//   * getItemTimeline / getProduct / listProducts / getPurchase は別のドメイン（2c・仕入）なので、派生タグの確認は在庫・販売の一覧で行った

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const db = bindDb(() => w.a)

describe('紐付け（linking）', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('自動紐付け：型番が完全一致すれば先入先出で自動確定、在庫が尽きたら未紐付けのまま', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-01', shipping_fee: 100,
      lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
    })
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-09-10', shipping_fee: 150,
      lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
    })

    const items = (await db.listInventory('in_stock')).sort((a, b) => a.acquired_at.localeCompare(b.acquired_at))
    expect(items.map(i => i.landed_cost)).toEqual([1100, 1150])

    const sale1 = await db.createSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-09-15', price: 2000 })
    const p1 = (await db.listSales()).find(s => s.id === sale1)!
    expect(p1.cost).toBe(1100)
    expect(p1.auto_linked).toBe(1)
    expect(p1.unmatched).toBe(0)

    const sale2 = await db.createSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-09-16', price: 2000 })
    const p2 = (await db.listSales()).find(s => s.id === sale2)!
    expect(p2.cost).toBe(1150)
    expect(p2.auto_linked).toBe(1)

    // 在庫が尽きたので3件目は未紐付けのまま
    const sale3 = await db.createSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-09-17', price: 2000 })
    const p3 = (await db.listSales()).find(s => s.id === sale3)!
    expect(p3.unmatched).toBe(1)
    expect(p3.auto_linked).toBe(0)
  })

  it('シリーズ一致だけでは自動確定しない。候補の先頭には出る', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'いちごスフレの箱【Z074】', unit_price: 3000, quantity: 1 }],
    })
    const boxItem = (await db.listInventory('in_stock'))[0]

    const saleId = await db.createSale({ title: 'いちごスフレ【Z074-3】', sold_at: '2026-01-10', price: 1000 })
    const s = (await db.listSales()).find(x => x.id === saleId)!
    expect(s.unmatched).toBe(1)
    expect(s.auto_linked).toBe(0)

    const suggestions = await db.suggestInventory(saleId)
    expect(suggestions[0]?.id).toBe(boxItem.id)
  })

  it('複数型番（まとめ売り）は自動確定せず、両方が候補に出る', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [
        { name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 },
        { name: 'いちごスフレ【Z088-2】', unit_price: 1200, quantity: 1 },
      ],
    })
    const [itemA, itemB] = await db.listInventory('in_stock')

    const saleId = await db.createSale({
      title: '【Z080-1】【Z088-2】まとめ売り', sold_at: '2026-01-10', price: 3000,
    })
    const s = (await db.listSales()).find(x => x.id === saleId)!
    expect(s.unmatched).toBe(1)

    const candidateIds = (await db.suggestInventory(saleId)).slice(0, 2).map(i => i.id).sort()
    expect(candidateIds).toEqual([itemA.id, itemB.id].sort())
  })

  describe('autoLinkPending：saleIds で対象を絞る（画面の絞り込みを無視して全件に走らないこと）', () => {
    it('saleIds を渡すと、その販売だけが紐付く（渡していない未紐付けの販売はそのまま残る）', async () => {
      // タイトルに型番はあるが、この時点では在庫が無いので createSale 内の自動紐付けは失敗し未紐付けのまま残る
      const saleA = await db.createSale({ title: '【A040】りんご', sold_at: '2026-01-05', price: 2000 })
      const saleB = await db.createSale({ title: '【A041】みかん', sold_at: '2026-01-05', price: 2000 })
      expect((await db.listSales()).find(s => s.id === saleA)!.unmatched).toBe(1)
      expect((await db.listSales()).find(s => s.id === saleB)!.unmatched).toBe(1)

      // ここで在庫を作る（両方とも紐付け可能な状態にする）
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'りんご【A040】', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'みかん【A041】', unit_price: 1000, quantity: 1 }],
      })

      const linked = await db.autoLinkPending([saleA])
      expect(linked).toBe(1)
      expect((await db.listSales()).find(s => s.id === saleA)!.unmatched).toBe(0)
      // 渡していないsaleBは在庫があっても紐付かない
      expect((await db.listSales()).find(s => s.id === saleB)!.unmatched).toBe(1)
    })

    it('空配列を渡すと0件で、未紐付けの販売は1件も紐付かない', async () => {
      const saleA = await db.createSale({ title: '【A050】くり', sold_at: '2026-01-05', price: 2000 })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'くり【A050】', unit_price: 1000, quantity: 1 }],
      })

      expect(await db.autoLinkPending([])).toBe(0)
      expect((await db.listSales()).find(s => s.id === saleA)!.unmatched).toBe(1)
    })

    it('省略すると従来どおり全件が対象になる', async () => {
      const saleA = await db.createSale({ title: '【A051】もも', sold_at: '2026-01-05', price: 2000 })
      const saleB = await db.createSale({ title: '【A052】ぶどう', sold_at: '2026-01-05', price: 2000 })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'もも【A051】', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'ぶどう【A052】', unit_price: 1000, quantity: 1 }],
      })

      expect(await db.autoLinkPending()).toBe(2)
      expect((await db.listSales()).find(s => s.id === saleA)!.unmatched).toBe(0)
      expect((await db.listSales()).find(s => s.id === saleB)!.unmatched).toBe(0)
    })

    it('渡した id に、既に紐付いている・私物・型番が2個以上の販売が混ざっていてもエラーにならず、条件を満たすものだけ紐付く', async () => {
      // 在庫が無い状態でsaleを作る（createSale内の自動紐付けを空振りさせ、未紐付けのまま残す）
      const target = await db.createSale({ title: '【A060】たいしょう', sold_at: '2026-01-05', price: 2000 })
      const alreadyLinked = await db.createSale({ title: '【A060】すでに紐付済', sold_at: '2026-01-05', price: 2000 })
      const personal = await db.createSale({
        title: '【A060】私物', sold_at: '2026-01-05', price: 500, kind: 'personal',
      })
      const twoCodesSale = await db.createSale({
        title: '【A060】【A040】ふたつ型番', sold_at: '2026-01-05', price: 3000,
      })

      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '対象【A060】', unit_price: 1000, quantity: 2 }],
      })

      // alreadyLinkedだけ先に確定させ、A060の在庫2点のうち1点を消費しておく
      expect(await db.autoLinkSale(alreadyLinked)).toBe(true)
      expect((await db.listSales()).find(s => s.id === alreadyLinked)!.unmatched).toBe(0)
      expect((await db.listSales()).find(s => s.id === target)!.unmatched).toBe(1)

      const linked = await db.autoLinkPending([target, alreadyLinked, personal, twoCodesSale])
      // targetだけが残り1点のA060で紐付く。alreadyLinked（既にsale_lineあり）・personal（kind不一致）・
      // twoCodesSale（型番2つ）はautoLinkSale内で弾かれ、エラーにならず静かに飛ばされる
      expect(linked).toBe(1)
      expect((await db.listSales()).find(s => s.id === target)!.unmatched).toBe(0)
      expect((await db.listSales()).find(s => s.id === personal)!.kind).toBe('personal')
      expect((await db.listSales()).find(s => s.id === twoCodesSale)!.unmatched).toBe(1)
    })

    it('出品先（channel）が混ざった状態で、片方の出品先の id だけ渡したらもう片方は紐付かない', async () => {
      const saleMercari = await db.createSale({
        title: '【A070】めるかり', sold_at: '2026-01-05', price: 2000, channel: 'mercari',
      })
      const saleYahoo = await db.createSale({
        title: '【A071】やふー', sold_at: '2026-01-05', price: 2000, channel: 'yahoo',
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'めるかり【A070】', unit_price: 1000, quantity: 1 }],
      })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'やふー【A071】', unit_price: 1000, quantity: 1 }],
      })

      const linked = await db.autoLinkPending([saleMercari])
      expect(linked).toBe(1)
      expect((await db.listSales()).find(s => s.id === saleMercari)!.unmatched).toBe(0)
      expect((await db.listSales()).find(s => s.id === saleYahoo)!.unmatched).toBe(1)
    })

    it('古い販売から順に在庫を使う（在庫が足りないとき、先に売れた方が先入先出の在庫を取る）', async () => {
      const newer = await db.createSale({ title: '【A061】新しい販売', sold_at: '2026-01-09', price: 2000 })
      const older = await db.createSale({ title: '【A061】古い販売', sold_at: '2026-01-05', price: 2000 })
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '対象【A061】', unit_price: 1000, quantity: 1 }],
      })
      expect(await db.autoLinkPending()).toBe(1)
      expect((await db.listSales()).find(s => s.id === older)!.unmatched).toBe(0)
      expect((await db.listSales()).find(s => s.id === newer)!.unmatched).toBe(1)
    })
  })

  describe('linkInventory：在庫の状態ガード・出品への引き当ての引き継ぎ', () => {
    it('in_stock でない在庫（廃棄済み）を紐付けようとするとthrow', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '廃棄済み紐付けガード', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      await db.disposeInventory(item.id, 'テスト理由', 'disposed')

      const saleId = await db.createSale({ title: '別の販売', sold_at: '2026-01-05', price: 1000 })
      await expect(db.linkInventory(saleId, [item.id]))
        .rejects.toThrow('販売済み・廃棄済みの在庫は紐付けられません')
    })

    it('出品に引き当て中の在庫は紐付け可。紐付けたらその引き当ては外れる（出品のstatusは変えない）', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '引き当て中の紐付け', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      await db.upsertListings([
        { mercariItemId: 'LMANUAL', title: '引き当て中の紐付け', price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('LMANUAL', [item.id])

      const saleId = await db.createSale({ title: '人が別の販売に決めた', sold_at: '2026-01-05', price: 2000 })
      await expect(db.linkInventory(saleId, [item.id])).resolves.toBeUndefined()

      const s = (await db.listSales()).find(x => x.id === saleId)!
      expect(s.cost).toBe(1000)

      // 出品側の引き当ては外れるが、出品自体は active のまま（未引き当てに戻る）
      const listing = (await db.listListings()).find(l => l.mercari_item_id === 'LMANUAL')!
      expect(listing.status).toBe('active')
      expect(listing.items).toEqual([])
    })

    it('紐付けた種類（link_source）が入る：画面からの紐付けは manual、自動確定は auto、出品の引き継ぎは listing', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [
          { name: '手動【A100】', unit_price: 1000, quantity: 1 },
          { name: '自動【A101】', unit_price: 1000, quantity: 1 },
        ],
      })
      const items = await db.listInventory('in_stock')
      const manualItem = items.find(i => i.model_code === 'A100')!
      const manualSale = await db.createSale({ title: '人が決める', sold_at: '2026-01-05', price: 2000 })
      await db.linkInventory(manualSale, [manualItem.id])
      await db.createSale({ title: '自動【A101】', sold_at: '2026-01-05', price: 2000 })
      const rows = await db.sql<{ link_source: string; model_code: string }>(
        `select sl.link_source, i.model_code from sale_line sl join inventory_item i on i.id = sl.inventory_item_id order by i.model_code`)
      expect(rows).toEqual([{ link_source: 'manual', model_code: 'A100' }, { link_source: 'auto', model_code: 'A101' }])
    })

    it('まとめ売り：複数の在庫を 1 つの販売に紐付けられる。端数は紐付けた順の最後に寄り、1 点あたりの売上・粗利の合計は販売と一致する', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [
          { name: 'まとめ1', unit_price: 500, quantity: 1 },
          { name: 'まとめ2', unit_price: 500, quantity: 1 },
          { name: 'まとめ3', unit_price: 500, quantity: 1 },
        ],
      })
      const items = await db.listInventory('in_stock')
      const byName = (n: string) => items.find(i => i.name === n)!.id
      const saleId = await db.createSale({ title: 'まとめ売り', sold_at: '2026-01-05', price: 1001 })
      // 紐付けた順は渡した順（3 → 1 → 2）
      await db.linkInventory(saleId, [byName('まとめ3'), byName('まとめ1'), byName('まとめ2')])

      const shares = await db.sql<{ name: string; price_share: number; profit_share: number }>(`
        select i.name, sls.price_share, sls.profit_share
          from sale_line_share sls
          join sale_line sl on sl.id = sls.sale_line_id
          join inventory_item i on i.id = sls.inventory_item_id
         where sls.sale_id = ? order by sl.allocation_order`, saleId)
      // 1,001 円 ÷ 3 点 → 333 / 334 / 334（余りは最後の行から 1 円ずつ）
      expect(shares.map(s => s.name)).toEqual(['まとめ3', 'まとめ1', 'まとめ2'])
      expect(shares.map(s => s.price_share)).toEqual([333, 334, 334])
      const s = (await db.listSales()).find(x => x.id === saleId)!
      expect(shares.reduce((a, r) => a + r.price_share, 0)).toBe(s.price)
      expect(shares.reduce((a, r) => a + r.profit_share, 0)).toBe(s.gross_profit)
      expect(s.item_count).toBe(3)
      expect(s.cost).toBe(1500)
    })

    it('解除（unlinkInventory）で在庫は in_stock に戻り、販売は未紐付けになる。解除したものを再び紐付けられる', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '解除対象', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      const saleId = await db.createSale({ title: '解除する販売', sold_at: '2026-01-05', price: 2000 })
      await db.linkInventory(saleId, [item.id])
      expect((await db.listInventory('sold')).map(i => i.id)).toEqual([item.id])

      await db.unlinkInventory(saleId, item.id)
      expect((await db.listInventory('in_stock')).map(i => i.id)).toEqual([item.id])
      expect((await db.listSales()).find(s => s.id === saleId)!.unmatched).toBe(1)
      // もう一度解除しても何も起きない
      await db.unlinkInventory(saleId, item.id)

      await db.linkInventory(saleId, [item.id])
      expect((await db.listSales()).find(s => s.id === saleId)!.unmatched).toBe(0)
    })

    it('同じ在庫を渡しても 1 回しか紐付かない（重複は 1 つにまとめる）', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '重複', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      const saleId = await db.createSale({ title: '販売', sold_at: '2026-01-05', price: 2000 })
      await db.linkInventory(saleId, [item.id, item.id])
      expect((await db.listSales()).find(s => s.id === saleId)!.item_count).toBe(1)
    })

    it('DB の一意制約（1 つの在庫は 1 回しか売れない）が最後の砦：直接 2 回目を入れると、API の入口で日本語になる', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '二重販売', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      const s1 = await db.createSale({ title: '販売1', sold_at: '2026-01-05', price: 2000 })
      const s2 = await db.createSale({ title: '販売2', sold_at: '2026-01-05', price: 2000 })
      await db.linkInventory(s1, [item.id])
      const err = await db.sqlRun('insert into sale_line (sale_id, inventory_item_id) values (?, ?)', s2, item.id)
        .then(() => null, (e: unknown) => e)
      expect(mapDbError(err)?.message).toBe('その在庫はすでに別の販売に紐付いています')
      expect(mapDbError(err)?.code).toBe('conflict')
    })

    it('在庫・販売が存在しない／uuid でない／空配列', async () => {
      const saleId = await db.createSale({ title: '販売', sold_at: '2026-01-05', price: 2000 })
      await expect(db.linkInventory(saleId, [randomUUID()])).rejects.toThrow('在庫が見つかりません')
      await expect(db.linkInventory(randomUUID(), [randomUUID()])).rejects.toThrow('販売が見つかりません')
      await expect(db.linkInventory('x', [])).rejects.toThrow('販売の指定が正しくありません')
      await expect(db.linkInventory(saleId, ['x'])).rejects.toThrow('在庫の指定が正しくありません')
      await expect(db.linkInventory(saleId, 'x' as never)).rejects.toThrow('在庫の形が正しくありません')
      await expect(db.linkInventoryAs(saleId, [], 'bogus' as never)).rejects.toThrow('紐付けの種類の値が正しくありません')
      // 空配列は何もしない
      await expect(db.linkInventory(saleId, [])).resolves.toBeUndefined()
    })
  })

  describe('disposeInventory / splitInventory：出品への引き当てが先に外れる', () => {
    it('disposeInventory：引き当て済み在庫を廃棄すると listListings でその出品が未引き当てに戻る', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '廃棄で引き当て解除', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      await db.upsertListings([
        { mercariItemId: 'LDISPOSE', title: '廃棄で引き当て解除', price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('LDISPOSE', [item.id])

      await db.disposeInventory(item.id, 'テスト理由', 'disposed')

      const listing = (await db.listListings()).find(l => l.mercari_item_id === 'LDISPOSE')!
      expect(listing.items).toEqual([])
      expect((await db.listListings({ onlyUnallocated: true })).some(l => l.mercari_item_id === 'LDISPOSE'))
        .toBe(true)
    })

    it('splitInventory：引き当て済み在庫を分割すると listListings でその出品が未引き当てに戻る', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '分割で引き当て解除', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      await db.upsertListings([
        { mercariItemId: 'LSPLIT', title: '分割で引き当て解除', price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('LSPLIT', [item.id])

      await db.splitInventory(item.id, 2)

      const listing = (await db.listListings()).find(l => l.mercari_item_id === 'LSPLIT')!
      expect(listing.items).toEqual([])
    })
  })

  describe('自動確定は抽出した型番が在庫の model_code と完全一致するときだけ（枝番の有無は問わない）', () => {
    it('枝番なしの在庫と完全一致（A037）・枝番ありの在庫と完全一致（Z078-2）は自動確定、シリーズだけの型番（A035）は候補止まり', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [
          { name: 'いちごスフレ【Z078-2】', unit_price: 1000, quantity: 1 },
          { name: 'メロージョイ ミニランド【A035-1】', unit_price: 1200, quantity: 1 },
          { name: 'メロージョイ ミニランド【A035-2】', unit_price: 1300, quantity: 1 },
          { name: 'メロージョイ Sサイズ【A037】', unit_price: 1400, quantity: 1 },
        ],
      })

      const saleBranch = await db.createSale({ title: '【Z078-2】いちごスフレ', sold_at: '2026-01-10', price: 2000 })
      expect((await db.listSales()).find(s => s.id === saleBranch)!.unmatched).toBe(0)

      // 在庫はA035-1／A035-2の枝番付きだけで、A035と文字列完全一致する在庫が無いので候補止まり
      const saleSeriesOnly = await db.createSale({ title: '【A035】メロージョイ ミニランド', sold_at: '2026-01-10', price: 2000 })
      expect((await db.listSales()).find(s => s.id === saleSeriesOnly)!.unmatched).toBe(1)

      // 在庫が枝番なしのA037で、販売の型番も枝番なしのA037＝文字列完全一致なので自動確定
      const saleExactNoBranch = await db.createSale({ title: '【A037】メロージョイ Sサイズ', sold_at: '2026-01-10', price: 2000 })
      expect((await db.listSales()).find(s => s.id === saleExactNoBranch)!.unmatched).toBe(0)
    })

    it('個数表記（×2）があればその点数、無ければ 1 点。足りなければある分だけ（揃うまで未紐付けのまま）', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '個数【A110】', unit_price: 1000, quantity: 3 }],
      })
      const two = await db.createSale({ title: '個数【A110】×2', sold_at: '2026-01-10', price: 4000 })
      const s2 = (await db.listSales()).find(s => s.id === two)!
      expect(s2.item_count).toBe(2)
      expect(s2.unmatched).toBe(0)

      // 残り 1 点しか無いのに ×2 → 1 点だけ紐付き、点数が足りないので未紐付け（要対応）のまま
      const again = await db.createSale({ title: '個数【A110】×2', sold_at: '2026-01-11', price: 4000 })
      const s3 = (await db.listSales()).find(s => s.id === again)!
      expect(s3.item_count).toBe(1)
      expect(s3.unmatched).toBe(1)
    })
  })

  describe('自動紐付け（在庫コード名指し）は他の出品に引き当て済みの在庫を横取りしない', () => {
    it('タイトルの在庫コードが一致しても、その在庫が別の出品に引き当て済みなら候補止まり（listing_lineは消えない）', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '在庫コード商品', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]

      await db.upsertListings([
        { mercariItemId: 'LCode1', title: `在庫コード商品【${item.item_code}】`, price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('LCode1', [item.id])

      const saleId = await db.createSale({ title: `【${item.item_code}】在庫コード商品`, sold_at: '2026-01-10', price: 3000 })
      const s = (await db.listSales()).find(x => x.id === saleId)!
      expect(s.unmatched).toBe(1) // 奪わず候補止まり
      expect(s.item_count).toBe(0)

      // 出品への引き当ては消えずそのまま残る
      const listing = (await db.listListings()).find(l => l.mercari_item_id === 'LCode1')!
      expect(listing.items.map(i => i.id)).toEqual([item.id])
    })

    it('在庫コードを名指しすると、その 1 点だけが紐付く（同じ型番の他の在庫は使わない）。見つからない分は未紐付けが残る', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '名指し【A120】', unit_price: 1000, quantity: 2 }],
      })
      const second = (await db.listInventory('in_stock')).sort((a, b) => a.item_code.localeCompare(b.item_code))[1]
      const saleId = await db.createSale({ title: `名指し【${second.item_code}】【S-9999】`, sold_at: '2026-01-10', price: 3000 })
      const s = (await db.listSales()).find(x => x.id === saleId)!
      expect(s.item_count).toBe(1) // 在庫コードで名指しした 1 点
      expect(s.unmatched).toBe(1) // S-9999 が無いので 2 点に届かない
      expect((await db.listSaleLines(saleId)).map(i => i.id)).toEqual([second.id])
    })
  })

  describe('getAutoLinkBlockers：在庫はあるのに出品に取ってあるせいで自動紐付けから外れているのを見せる', () => {
    it('実データの再現：Yahooの販売がsuspendedのメルカリ出品に握られた在庫を見つける', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A040】もこ山 スクイーズ 新品未開封', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      expect(item.model_code).toBe('A040')

      await db.upsertListings([
        { mercariItemId: 'm15691073401', title: '【A040】もこ山 スクイーズ 新品未開封', price: 3000, suspended: true, thumbUrl: null },
      ])
      await db.reserveInventory('m15691073401', [item.id])

      const saleId = await db.createSale({
        title: '… もこ山 スクイーズ 新品未開封【A040】', sold_at: '2026-01-10', price: 5750, channel: 'yahoo',
      })
      const s = (await db.listSales()).find(x => x.id === saleId)!
      // FIFOでは0点（在庫はあるのに「型番はあるが在庫が無い」と嘘をついていた）
      expect(s.unmatched).toBe(1)

      const blockers = await db.getAutoLinkBlockers(saleId)
      expect(blockers).toHaveLength(1)
      expect(blockers[0]).toMatchObject({
        inventory_item_id: item.id,
        item_code: item.item_code,
        model_code: 'A040',
        name: item.name, // product_name が無いので仕入明細名にフォールバック
        landed_cost: item.landed_cost,
        listing_id: 'm15691073401',
        listing_channel: 'mercari', // 販売はyahooだが、握っているのはmercariの出品
        listing_status: 'suspended',
        listing_title: '【A040】もこ山 スクイーズ 新品未開封',
      })
    })

    it('setProductName で表示名を付けていれば、在庫の明細名ではなくそちらを返す', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A049】もこ山 スクイーズ 旧パッケージ', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      await db.setProductName('A049', 'もこ山 スクイーズ（表示名）')

      await db.upsertListings([
        { mercariItemId: 'm-name-1', title: '【A049】商品', price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('m-name-1', [item.id])

      const saleId = await db.createSale({ title: '商品【A049】', sold_at: '2026-01-10', price: 3000 })
      const blockers = await db.getAutoLinkBlockers(saleId)
      expect(blockers).toHaveLength(1)
      expect(blockers[0].name).toBe('もこ山 スクイーズ（表示名）')
    })

    it('activeな出品に握られている場合も同じく返る', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A041】商品', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]

      await db.upsertListings([
        { mercariItemId: 'm-active-1', title: '【A041】商品', price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('m-active-1', [item.id])

      const saleId = await db.createSale({ title: '商品【A041】', sold_at: '2026-01-10', price: 3000, channel: 'yahoo' })
      const blockers = await db.getAutoLinkBlockers(saleId)
      expect(blockers).toHaveLength(1)
      expect(blockers[0].listing_status).toBe('active')
      expect(blockers[0].listing_id).toBe('m-active-1')
    })

    it('sold/endedの出品に引き当てられていた在庫は返らない（FIFOが除外しないので理由ではない）', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A042】商品', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]

      await db.upsertListings([
        { mercariItemId: 'm-sold-1', title: '【A042】商品', price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('m-sold-1', [item.id])
      // 通常はtakeOverListingがlisting_lineを先に消してからsoldにする（trg_listing_line_guardは
      // INSERTだけを見ているのでUPDATEは通る）。万一listing_lineが残ったままstatusだけ変わっても、
      // blockersはそれを理由にしないことを確かめる
      await db.sqlRun(`update listing set status = 'sold' where channel_item_id = ?`, 'm-sold-1')

      // autoLinkSaleを経由せず、blockersのSQL条件だけを検証する（未紐付けのsaleを直接作る）
      const saleId = randomUUID()
      await db.sqlRun(
        `insert into sale (id, title, sold_at, price, kind, model_codes) values (?, ?, ?, ?, 'resale', ?)`,
        saleId, '商品【A042】', '2026-01-10', 3000, ['A042'],
      )

      expect(await db.getAutoLinkBlockers(saleId)).toEqual([])
    })

    it('FIFOが選べる在庫がある販売では空配列になる（理由が別なので）', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A043】商品', unit_price: 1000, quantity: 1 }],
      })
      const saleId = await db.createSale({ title: '商品【A043】', sold_at: '2026-01-10', price: 3000 })
      const s = (await db.listSales()).find(x => x.id === saleId)!
      expect(s.unmatched).toBe(0) // 通常どおり自動確定できている

      expect(await db.getAutoLinkBlockers(saleId)).toEqual([])
    })

    it('型番が0個のときは空配列', async () => {
      const saleId = await db.createSale({ title: '型番なしの商品', sold_at: '2026-01-10', price: 1000 })
      expect(await db.getAutoLinkBlockers(saleId)).toEqual([])
    })

    it('型番が2個以上のときは空配列（A044は出品に握られているが対象外）', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A044】商品X', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      await db.upsertListings([
        { mercariItemId: 'm-multi-1', title: '【A044】商品X', price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('m-multi-1', [item.id])

      const saleId = await db.createSale({ title: '【A044】と【A045】のセット', sold_at: '2026-01-10', price: 2000 })
      expect(await db.getAutoLinkBlockers(saleId)).toEqual([])
    })

    it('私物のときは空配列', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A046】商品', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      await db.upsertListings([
        { mercariItemId: 'm-personal-1', title: '【A046】商品', price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('m-personal-1', [item.id])

      const saleId = await db.createSale({ title: '【A046】商品', sold_at: '2026-01-10', price: 1000, kind: 'personal' })
      expect(await db.getAutoLinkBlockers(saleId)).toEqual([])
    })

    it('既に紐付き済みのときは空配列', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A047】商品', unit_price: 1000, quantity: 1 }],
      })
      // 出品には握らせない → FIFOで即自動確定する
      const saleId = await db.createSale({ title: '【A047】商品', sold_at: '2026-01-10', price: 1000 })
      expect((await db.listSales()).find(s => s.id === saleId)!.unmatched).toBe(0)
      expect(await db.getAutoLinkBlockers(saleId)).toEqual([])
    })

    it('除外条件が対になっている：同じ在庫がFIFOで選べないときだけblockersが非空になる', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '【A048】商品1', unit_price: 1000, quantity: 1 }],
      })
      const item1 = (await db.listInventory('in_stock'))[0]

      // 1. まだどこにも引き当てていない → FIFOで選べる（autoLinkSaleが成功）→ blockersは空
      const saleOk = await db.createSale({ title: '商品1【A048】', sold_at: '2026-01-10', price: 3000 })
      expect((await db.listSales()).find(s => s.id === saleOk)!.unmatched).toBe(0)
      expect(await db.getAutoLinkBlockers(saleOk)).toEqual([])

      // 2. 別の在庫を出品へ引き当ててからFIFOを試す → 選べない → blockersが非空（同じ在庫を指す）
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-02', shipping_fee: 0,
        lines: [{ name: '【A048】商品2', unit_price: 1000, quantity: 1 }],
      })
      const item2 = (await db.listInventory('in_stock')).find(i => i.id !== item1.id)!
      await db.upsertListings([
        { mercariItemId: 'm-pair-1', title: '【A048】商品2', price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('m-pair-1', [item2.id])

      const saleBlocked = await db.createSale({ title: '商品2【A048】', sold_at: '2026-01-11', price: 3000 })
      const saleBlockedRow = (await db.listSales()).find(s => s.id === saleBlocked)!
      expect(saleBlockedRow.unmatched).toBe(1) // FIFOで0点
      const blockers = await db.getAutoLinkBlockers(saleBlocked)
      expect(blockers).toHaveLength(1)
      expect(blockers[0].inventory_item_id).toBe(item2.id)
    })
  })

  describe('linkInventory / reserveInventory：takeFromSale（付け替え）', () => {
    it('takeFromSaleで売却済みの在庫を別の販売へ付け替える。元の販売は点数・原価が減り、新しい販売は1行だけ・原価が移る', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [
          { name: '在庫A', unit_price: 1000, quantity: 1 },
          { name: '在庫B', unit_price: 500, quantity: 1 },
        ],
      })
      const [itemA, itemB] = await db.listInventory('in_stock')

      const sale1 = await db.createSale({ title: '販売1', sold_at: '2026-01-05', price: 3000 })
      await db.linkInventory(sale1, [itemA.id, itemB.id])
      expect((await db.listSales()).find(s => s.id === sale1)!.item_count).toBe(2)
      expect((await db.listSales()).find(s => s.id === sale1)!.cost).toBe(1500)

      const sale2 = await db.createSale({ title: '販売2', sold_at: '2026-01-06', price: 2000 })
      await db.linkInventory(sale2, [itemA.id], { takeFromSale: true })

      const s1 = (await db.listSales()).find(s => s.id === sale1)!
      expect(s1.item_count).toBe(1) // 元の販売から1点減る
      expect(s1.cost).toBe(500)

      const s2 = (await db.listSales()).find(s => s.id === sale2)!
      expect(s2.item_count).toBe(1) // 在庫は新しい販売に1行だけ
      expect(s2.cost).toBe(1000)   // 合計原価が新しい販売に移る
      expect((await db.listSaleLines(sale2)).map(i => i.id)).toEqual([itemA.id])
    })

    it('takeFromSale無しで売却済みの在庫を紐付けようとすると例外（元の販売は変わらない）', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '在庫A', unit_price: 1000, quantity: 1 }],
      })
      const [itemA] = await db.listInventory('in_stock')
      const sale1 = await db.createSale({ title: '販売1', sold_at: '2026-01-05', price: 3000 })
      await db.linkInventory(sale1, [itemA.id])

      const sale2 = await db.createSale({ title: '販売2', sold_at: '2026-01-06', price: 2000 })
      await expect(db.linkInventory(sale2, [itemA.id])).rejects.toThrow('販売済み・廃棄済みの在庫は紐付けられません')
      expect((await db.listSales()).find(s => s.id === sale1)!.item_count).toBe(1)
      expect((await db.listSales()).find(s => s.id === sale2)!.item_count).toBe(0)
    })

    it('takeFromSale を付けても、廃棄・自家消費・分割済みの在庫は紐付けられない', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '在庫A', unit_price: 1000, quantity: 3 }],
      })
      const [a, b, c] = await db.listInventory('in_stock')
      await db.disposeInventory(a.id, '捨てた', 'disposed')
      await db.disposeInventory(b.id, '使った', 'personal_use')
      await db.splitInventory(c.id, 2)
      const saleId = await db.createSale({ title: '販売', sold_at: '2026-01-05', price: 3000 })
      for (const id of [a.id, b.id, c.id]) {
        await expect(db.linkInventory(saleId, [id], { takeFromSale: true }))
          .rejects.toThrow('販売済み・廃棄済みの在庫は紐付けられません')
      }
    })

    it('自分自身の販売に既に付いている在庫を渡しても無視される（例外にしない・二重にならない）', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '在庫A', unit_price: 1000, quantity: 1 }],
      })
      const [itemA] = await db.listInventory('in_stock')
      const sale1 = await db.createSale({ title: '販売1', sold_at: '2026-01-05', price: 3000 })
      await db.linkInventory(sale1, [itemA.id])

      await expect(db.linkInventory(sale1, [itemA.id])).resolves.toBeUndefined()
      expect((await db.listSales()).find(s => s.id === sale1)!.item_count).toBe(1)
    })

    it('reserveInventory：takeFromSaleで売却済みの在庫を出品へ付け替えられる。無しなら未販売の在庫だけというエラー', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '在庫A', unit_price: 1000, quantity: 1 }],
      })
      const [itemA] = await db.listInventory('in_stock')
      const sale1 = await db.createSale({ title: '販売1', sold_at: '2026-01-05', price: 3000 })
      await db.linkInventory(sale1, [itemA.id])
      await db.upsertListings([
        { mercariItemId: 'TFS-1', title: '出品', price: 3000, suspended: false, thumbUrl: null },
      ])

      await expect(db.reserveInventory('TFS-1', [itemA.id])).rejects.toThrow('未販売の在庫だけ引き当てられます')

      await db.reserveInventory('TFS-1', [itemA.id], { takeFromSale: true })
      expect((await db.listListings()).find(l => l.mercari_item_id === 'TFS-1')!.items.map(i => i.id))
        .toEqual([itemA.id])
      // 元の販売の紐付けは外れた（在庫が付け替わったので item_count が0）
      expect((await db.listSales()).find(s => s.id === sale1)!.item_count).toBe(0)
    })
  })

  describe('商品単位の手動FIFO選択', () => {
    it('商品選択は自動引き当てと同じFIFO順。枝番違い・予約済み・販売済み・選択済みを除外し、プレビューでは保存しない', async () => {
      const make = async (date: string, code = 'A037') => {
        const [id] = await db.createPurchaseItems({
          shop_account_id: shopId, ordered_at: date,
          lines: [{ name: `商品【${code}】`, unit_price: 1000, quantity: 1 }],
        })
        return id
      }
      const newer = await make('2026-04-04')
      const older = await make('2026-04-03')
      const reserved = await make('2026-04-01')
      const sold = await make('2026-03-01')
      await make('2026-02-01', 'A037-1')
      await db.upsertListings([{ mercariItemId: 'fifo-reserved', title: '予約先', price: 3000, suspended: false, thumbUrl: null }])
      await db.reserveInventory('fifo-reserved', [reserved])
      const saleId = await db.createSale({ title: '販売済み', sold_at: '2026-04-05', price: 2000 })
      await db.linkInventory(saleId, [sold])
      expect(await db.suggestProductInventory('A037', 5)).toEqual([older, newer])
      expect(await db.suggestProductInventory('A037', 2, [older])).toEqual([newer])
      expect(await db.suggestProductInventory('A037', 2, [older, newer])).toEqual([])
      expect((await db.listInventory('in_stock')).find(i => i.id === older)?.listing).toBeNull()
      await db.upsertListings([{ mercariItemId: 'fifo-auto', title: '商品【A037】×2', price: 4000, suspended: false, thumbUrl: null }])
      await db.autoReserveListings()
      expect((await db.listListings()).find(l => l.mercari_item_id === 'fifo-auto')?.items.map(i => i.id).sort()).toEqual([older, newer].sort())
    })

    it('商品選択の不正な点数を拒否する', async () => {
      for (const qty of [0, -1, 1.5, NaN, Infinity]) {
        await expect(db.suggestProductInventory('A037', qty)).rejects.toThrow('点数は1以上の整数')
      }
      await expect(db.suggestProductInventory('', 1)).rejects.toThrow('商品コードを指定')
    })
  })

  describe('タグの派生：仕入→在庫→販売はコピーせず「派生」で見える', () => {
    it('仕入→在庫3点→紐付いた販売、へ派生する。直接タグとは重複せず、上流の付け外しがそのまま効く', async () => {
      const purchaseId = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '派生タグ対象', unit_price: 1000, quantity: 3 }],
      })
      const tagA = await db.createTag('A')
      const tagB = await db.createTag('B')
      await db.setPurchaseTags(purchaseId, [tagA])

      // 仕入のタグ → その在庫3点すべてに派生する
      const items = await db.listInventory('in_stock')
      expect(items).toHaveLength(3)
      for (const item of items) {
        expect(item.tags).toEqual([])
        expect(item.inherited_tags.map(t => t.id)).toEqual([tagA])
      }

      // 1点に直接タグBを付ける（在庫のタグと派生タグは重複しない）
      const [target, other] = items
      await db.setInventoryTags(target.id, [tagB])
      const targetAfter = (await db.listInventory('in_stock')).find(i => i.id === target.id)!
      expect(targetAfter.tags.map(t => t.id)).toEqual([tagB])
      expect(targetAfter.inherited_tags.map(t => t.id)).toEqual([tagA])

      // その在庫が紐付いた販売には、在庫の直接タグ(B)＋仕入のタグ(A)が両方派生する
      const saleId = await db.createSale({ title: '派生タグ対象', sold_at: '2026-01-05', price: 2000 })
      await db.linkInventory(saleId, [target.id])
      const s = (await db.listSales()).find(x => x.id === saleId)!
      expect(s.tags).toEqual([])
      expect(s.inherited_tags.map(t => t.id).sort()).toEqual([tagA, tagB].sort())

      // 販売に直接タグAを付けると、直接タグに出て、派生タグからは除かれる（重複しない）
      await db.setSaleTags(saleId, [tagA])
      const withDirect = (await db.listSales()).find(x => x.id === saleId)!
      expect(withDirect.tags.map(t => t.id)).toEqual([tagA])
      expect(withDirect.inherited_tags.map(t => t.id)).toEqual([tagB])

      // 紐付けを解除すると派生タグは消える（人が付けた直接タグは残る）
      await db.unlinkInventory(saleId, target.id)
      const unlinked = (await db.listSales()).find(x => x.id === saleId)!
      expect(unlinked.tags.map(t => t.id)).toEqual([tagA])
      expect(unlinked.inherited_tags).toEqual([])

      // 仕入のタグを外すと、まだ紐付いていない在庫からも派生タグが消える
      await db.setPurchaseTags(purchaseId, [])
      const afterRemove = (await db.listInventory('in_stock')).find(i => i.id === other.id)!
      expect(afterRemove.inherited_tags).toEqual([])
    })

    it('autoLinkSale（型番の自動確定）でも在庫・仕入のタグが販売へ派生する（コピーはしない）', async () => {
      const tagId = await db.createTag('自動確定タグ')
      const purchaseId = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
      })
      await db.setPurchaseTags(purchaseId, [tagId])

      const saleId = await db.createSale({ title: 'クリームわん【Z080-1】', sold_at: '2026-01-05', price: 2000 })
      const s = (await db.listSales()).find(x => x.id === saleId)!
      expect(s.auto_linked).toBe(1)
      expect(s.tags).toEqual([])
      expect(s.inherited_tags.map(t => t.id)).toEqual([tagId])
      // コピーしていない：sale_tag には何も入っていない
      expect(await db.sql('select * from sale_tag')).toEqual([])
    })

    it('出品からの引き継ぎ（insertCollected）でも在庫のタグが販売へ派生する（コピーはしない）', async () => {
      const tagId = await db.createTag('出品タグ')
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'タグ付き出品商品', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      await db.setInventoryTags(item.id, [tagId])
      await db.upsertListings([
        { mercariItemId: 'LTAG', title: 'タグ付き出品商品', price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('LTAG', [item.id])

      await db.insertCollected([
        { mercariItemId: 'LTAG', title: 'タグ付き出品商品', price: 3000, soldAt: '2026-01-10' },
      ])

      const s = (await db.listSales()).find(x => x.mercari_item_id === 'LTAG')!
      expect(s.tags).toEqual([])
      expect(s.inherited_tags.map(t => t.id)).toEqual([tagId])
    })

    it('型番タグが在庫の inherited_tags（from: product）・販売の inherited_tags に出る。優先順位 purchase > product で 1 つにまとまる', async () => {
      const tagId = await db.createTag('型番タグ')
      const purchaseId = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '型番タグ対象【Z900】', unit_price: 1000, quantity: 1 }],
      })
      await db.setProductTags('Z900', [tagId])

      const item = (await db.listInventory('in_stock'))[0]
      expect(item.tags).toEqual([])
      expect(item.inherited_tags).toEqual([{ id: tagId, name: '型番タグ', sort_order: 0, from: 'product' }])

      const saleId = await db.createSale({ title: '型番タグ対象【Z900】', sold_at: '2026-01-05', price: 2000 })
      const s = (await db.listSales()).find(x => x.id === saleId)!
      expect(s.tags).toEqual([])
      expect(s.inherited_tags).toEqual([{ id: tagId, name: '型番タグ', sort_order: 0, from: 'product' }])

      // 同じタグが仕入(purchase)・商品(product)の両方から来たら purchase を優先して 1 つにまとめる
      await db.setPurchaseTags(purchaseId, [tagId])
      const item2 = (await db.listInventory('sold'))[0] // 上の販売で自動確定されて sold になっている
      expect(item2.inherited_tags).toEqual([{ id: tagId, name: '型番タグ', sort_order: 0, from: 'purchase' }])
      expect((await db.listSales()).find(s => s.id === saleId)!.inherited_tags)
        .toEqual([{ id: tagId, name: '型番タグ', sort_order: 0, from: 'purchase' }])
    })

    it('タグで販売を絞り込むと、派生タグ（在庫・仕入・商品＝型番のタグ）でも一致する', async () => {
      const tagInv = await db.createTag('在庫のタグ')
      const tagPur = await db.createTag('仕入のタグ')
      const tagPro = await db.createTag('型番のタグ')
      const purchaseId = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '絞り込み【A130】', unit_price: 1000, quantity: 1 }],
      })
      await db.setPurchaseTags(purchaseId, [tagPur])
      await db.setProductTags('A130', [tagPro])
      const item = (await db.listInventory('in_stock'))[0]
      await db.setInventoryTags(item.id, [tagInv])
      const linked = await db.createSale({ title: '絞り込み【A130】', sold_at: '2026-01-05', price: 2000 })
      const other = await db.createSale({ title: 'タグなし', sold_at: '2026-01-06', price: 2000 })
      for (const t of [tagInv, tagPur, tagPro]) {
        expect((await db.listSales({ tagId: t })).map(s => s.id)).toEqual([linked])
      }
      expect((await db.listSales()).map(s => s.id).sort()).toEqual([linked, other].sort())
      // 紐付けを解除すると派生が消えるので、絞り込みにも出ない
      await db.unlinkInventory(linked, item.id)
      expect(await db.listSales({ tagId: tagInv })).toEqual([])
    })
  })

  describe('attachInventoryTags：thumb_pathが無い未販売在庫は商品画像で埋める', () => {
    it('出品の画像があれば、未販売の在庫のthumb_urlに出る', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'クリームわん【P200】', unit_price: 1000, quantity: 1 }],
      })
      const [item] = await db.listInventory('in_stock')
      expect(item.thumb_url).toBeNull()

      await db.upsertListings([
        { mercariItemId: 'P200-L', title: 'クリームわん【P200】', price: 2000, suspended: false, thumbUrl: null },
      ])
      await db.setListingThumb('P200-L', 'hh/listing/p200.jpg', null)

      const after = (await db.listInventory('in_stock')).find(i => i.id === item.id)!
      expect(after.thumb_url).toBe('https://abcdefgh.supabase.test/storage/v1/object/public/media/hh/listing/p200.jpg')
    })
  })

  describe('productImageFiles：商品画像の優先順位', () => {
    it('①人がセット ＞ ②最新の出品 ＞ ③最新の販売 の順で選ばれる。無ければMapに入らない', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [
          { name: 'クリームわん【P100】', unit_price: 1000, quantity: 1 },
          { name: 'クリームわん【P101】', unit_price: 1000, quantity: 1 },
          { name: 'クリームわん【P102】', unit_price: 1000, quantity: 1 },
        ],
      })
      const [, item2] = await db.listInventory('in_stock')

      // P102：画像が何も無い → Mapに入らない
      // P101：販売の画像だけ
      const saleId = await db.createSale({ title: 'クリームわん【P101】', sold_at: '2026-01-10', price: 2000 })
      await db.linkInventory(saleId, [item2.id])
      await db.setSaleThumb(saleId, 'sale-p101.jpg', null)

      // P100：出品の画像もあるが、人がセットした画像を優先
      await db.upsertListings([
        { mercariItemId: 'PI-LISTING', title: 'クリームわん【P100】', price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.setListingThumb('PI-LISTING', 'listing-p100.jpg', null)
      await db.upsertProductImage('P100', 'product-p100-manual.jpg')

      const map = await db.productImageFiles(['P100', 'P101', 'P102', 'P199'])
      expect(map.get('P100')).toEqual({ path: 'product-p100-manual.jpg', manual: true })
      expect(map.get('P101')).toEqual({ path: 'sale-p101.jpg', manual: false })
      expect(map.has('P102')).toBe(false)
      expect(map.has('P199')).toBe(false)
    })

    it('②仕入先の商品画像 は ①人がセット の次、③出品より優先。同じ型番で複数明細があれば注文日が新しい方を使う', async () => {
      const firstId = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-02-01', shipping_fee: 0,
        lines: [{ name: 'クリームわん【P300】', unit_price: 1000, quantity: 1 }],
      })
      await db.setFirstLineImage(firstId, 'purchase-p300-old.jpg')

      // 出品の画像もあるが、仕入先の商品画像を優先する
      await db.upsertListings([
        { mercariItemId: 'PI-P300', title: 'クリームわん【P300】', price: 3000, suspended: false, thumbUrl: null },
      ])
      await db.setListingThumb('PI-P300', 'listing-p300.jpg', null)

      expect((await db.productImageFiles(['P300'])).get('P300')).toEqual({ path: 'purchase-p300-old.jpg', manual: false })

      // 同じ型番の後の注文（注文日が新しい）に画像があれば、そちらに差し替わる
      const secondId = await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-02-10', shipping_fee: 0,
        lines: [{ name: 'クリームわん【P300】', unit_price: 1000, quantity: 1 }],
      })
      await db.setFirstLineImage(secondId, 'purchase-p300-new.jpg')

      expect((await db.productImageFiles(['P300'])).get('P300')).toEqual({ path: 'purchase-p300-new.jpg', manual: false })
    })

    it('③出品：listing_line 経由でも、タイトルに型番を含むだけでも拾う。最後に見た出品が新しい方を使う', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '出品画像【P400】', unit_price: 1000, quantity: 1 }],
      })
      await db.upsertListings([{ mercariItemId: 'PI-old', title: '古い出品【P400】', price: 1, suspended: false, thumbUrl: null }])
      await db.setListingThumb('PI-old', 'listing-old.jpg', null)
      await db.sqlRun(`update listing set last_seen_at = '2026-01-01T00:00:00Z' where channel_item_id = 'PI-old'`)
      await db.upsertListings([{ mercariItemId: 'PI-new', title: '新しい出品【P400】', price: 1, suspended: false, thumbUrl: null }])
      await db.setListingThumb('PI-new', 'listing-new.jpg', null)
      expect((await db.productImageFiles(['P400'])).get('P400')).toEqual({ path: 'listing-new.jpg', manual: false })
      // 画像の無い出品は飛ばす
      await db.upsertListings([{ mercariItemId: 'PI-none', title: '画像なし【P400】', price: 1, suspended: false, thumbUrl: null }])
      expect((await db.productImageFiles(['P400'])).get('P400')).toEqual({ path: 'listing-new.jpg', manual: false })
    })

    it('他の世帯の画像は拾わない', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '世帯Aの画像【P500】', unit_price: 1000, quantity: 1 }],
      })
      await db.upsertProductImage('P500', 'a-only.jpg')
      const fromB = await w.b.run((c) => import('../../domain/derive').then(d => d.productImageFiles(c, ['P500'])))
      expect(fromB.size).toBe(0)
    })
  })
})

describe('紐付け（linking）の引数の検査と世帯の分離', () => {
  const asB = <T>(fn: (ctx: Ctx) => Promise<T>) => w.b.run(fn)

  beforeEach(async () => {
    w = await newWorld(dom)
  })

  it('他の世帯の販売・在庫には紐付けられない。型番 FIFO・自動紐付けも他の世帯の在庫を使わない', async () => {
    const shop = await db.createShopAccount('A')
    const [itemA] = await db.createPurchaseItems({
      shop_account_id: shop, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '世帯Aの在庫【A001】', unit_price: 1000, quantity: 1 }],
    })
    const saleB = await asB((c) => sale.createSale(c, { title: '世帯Bの販売【A001】', sold_at: '2026-01-05', price: 2000 }))
    // B の createSale の自動紐付けは A の在庫を使わない
    expect((await asB((c) => sale.listSales(c)))[0].unmatched).toBe(1)
    await expect(asB((c) => inventory.linkInventory(c, saleB, [itemA]))).rejects.toThrow('在庫が見つかりません')
    expect(await asB((c) => inventory.suggestInventory(c, saleB))).toEqual([])
    expect(await asB((c) => inventory.findInventoryIdsByModelCodeFifo(c, 'A001', 5))).toEqual([])
    expect(await asB((c) => inventory.findInventoryIdsByItemCodes(c, ['S-0001']))).toEqual([])
    // A の在庫は何も変わっていない
    expect((await db.listInventory('in_stock')).map(i => i.id)).toEqual([itemA])
    expect(await db.sql('select * from sale_line')).toHaveLength(0)
  })

  it('他の世帯の在庫コード（S-0001）をタイトルに書いても、自動紐付けされない（在庫コードは世帯ごとに独立）', async () => {
    const shopA = await db.createShopAccount('A')
    await db.createPurchaseItems({
      shop_account_id: shopA, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '世帯Aの在庫', unit_price: 1000, quantity: 1 }],
    })
    const saleB = await asB((c) => sale.createSale(c, { title: '名指し【S-0001】', sold_at: '2026-01-05', price: 2000 }))
    expect((await asB((c) => sale.listSales(c))).find(s => s.id === saleB)!.unmatched).toBe(1)
    expect((await db.listInventory('in_stock'))[0].item_code).toBe('S-0001')
  })

  it('世帯が違えば、同じ在庫コード（S-0001）の在庫を別々に持てる（採番も世帯ごと）', async () => {
    const shopA = await db.createShopAccount('A')
    await db.createPurchaseItems({
      shop_account_id: shopA, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'Aの在庫', unit_price: 1000, quantity: 1 }],
    })
    const bCode = await asB((c) => inventory.nextItemCode(c))
    expect(bCode).toBe('S-0001')
    expect((await db.listInventory('in_stock'))[0].item_code).toBe('S-0001')
  })
})
