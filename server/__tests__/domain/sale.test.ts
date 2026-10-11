import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../context'
import { mapDbError } from '../../errors'
import * as sale from '../../domain/sale'
import { thisMonthJst, todayJst } from '../../domain/_shared'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'
import { bindDb } from './core-helpers'

// src/main/__tests__/db.test.ts の db（:memory:）の中の、販売（作成・更新・手数料・実額・取引状態・出品先・
// 除外記録・購入日時・サムネイル・粗利の見積もり・タグの絞り込み・合計）のテストを移したもの。
// 期待値は変えていない。書き換えたのは「呼び方」だけ：
//   * 同期の db.xxx(...) → await db.xxx(...)（db は core-helpers の薄い包み。1 回の呼び出し＝1 リクエスト＝1 トランザクション）
//   * expect(() => …).toThrow(x) → await expect(…).rejects.toThrow(x)
//   * db.createPurchase は仕入のドメインが無くても在庫が作れる SQL の直接投入（core-helpers の seedPurchase）
//   * getDb().prepare(…) の直接 SQL は db.sql / sqlGet / sqlRun（Postgres の列名・型）に読み替えた
//   * todayLocal() → todayJst()（サーバーは UTC。日本時間の暦日）
//   * soroban-thumb://<file> → ${MEDIA_BASE}/<path>（画像は Storage の公開バケット media。mediaUrl）
//   * 仕入・商品（getItemTimeline / getProduct / getDashboard）は別のドメイン（2c）なので、ビュー（monthly_summary）を直接読んで確かめた
// SQLite だけの話（migrate / PRAGMA / schema_version）は移していない

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const db = bindDb(() => w.a)
const MEDIA = 'https://abcdefgh.supabase.test/storage/v1/object/public/media'

describe('販売（sale）', () => {
  let shopId: string

  beforeEach(async () => {
    w = await newWorld(dom)
    shopId = await db.createShopAccount('メロジョイA')
  })

  it('createSale → linkInventory → listSaleLines / listSales の cost・gross_profit が正しい', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '売る商品', unit_price: 1000, quantity: 1 }],
    })
    const item = (await db.listInventory('in_stock'))[0]

    const saleId = await db.createSale({ title: '売る商品', sold_at: '2026-01-05', price: 2000 })
    await db.linkInventory(saleId, [item.id])

    const lines = await db.listSaleLines(saleId)
    expect(lines).toHaveLength(1)
    expect(lines[0].id).toBe(item.id)

    const s = (await db.listSales()).find(x => x.id === saleId)!
    expect(s.cost).toBe(1000)
    // fee_rate_bp 既定1000(10%) → fee = floor(2000*1000/10000) = 200
    expect(s.fee).toBe(200)
    expect(s.gross_profit).toBe(2000 - 200 - 0 - 0 - 1000)
    expect(s.unmatched).toBe(0)

    // 紐付けた在庫は sold になるので in_stock からは消える
    expect(await db.listInventory('in_stock')).toHaveLength(0)
  })

  it('disposeInventory：sold在庫は外せない', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '在庫X', unit_price: 500, quantity: 2 }],
    })
    const [, item2] = await db.listInventory('in_stock')
    const saleId = await db.createSale({ title: '在庫X', sold_at: '2026-01-06', price: 1000 })
    await db.linkInventory(saleId, [item2.id])
    await expect(db.disposeInventory(item2.id, 'テスト')).rejects.toThrow('販売済みの在庫は外せません')
  })

  it('restoreInventory：売却済みは戻せない', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '在庫Y', unit_price: 500, quantity: 1 }],
    })
    const [item] = await db.listInventory('in_stock')
    const saleId = await db.createSale({ title: '在庫Y', sold_at: '2026-01-06', price: 1000 })
    await db.linkInventory(saleId, [item.id])
    await expect(db.restoreInventory(item.id)).rejects.toThrow('この在庫は戻せません')
  })

  describe('mergeSplitInventory：販売・出品に絡む拒否', () => {
    it('子が1点でも販売済みならErrorにitem_codeを含み、何も変わらない', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '一部売れた分割', unit_price: 900, quantity: 1 }],
      })
      const parent = (await db.listInventory('in_stock'))[0]
      const childIds = await db.splitInventory(parent.id, 3)
      const soldChild = (await db.listInventory('in_stock')).find(i => i.id === childIds[0])!

      const saleId = await db.createSale({ title: '一部売れた分割', sold_at: '2026-01-06', price: 500 })
      await db.linkInventory(saleId, [soldChild.id])

      await expect(db.mergeSplitInventory(parent.id)).rejects.toThrow(soldChild.item_code)

      // 何も変わっていない
      expect((await db.listInventory('split')).some(i => i.id === parent.id)).toBe(true)
      expect((await db.listInventory('in_stock')).filter(i => childIds.includes(i.id))).toHaveLength(2)
    })

    it('子が出品に引き当て中ならError', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '引き当て中の分割', unit_price: 900, quantity: 1 }],
      })
      const parent = (await db.listInventory('in_stock'))[0]
      const childIds = await db.splitInventory(parent.id, 2)
      await db.upsertListings([
        { mercariItemId: 'LMERGE', title: '引き当て中の分割', price: 1500, suspended: false, thumbUrl: null },
      ])
      await db.reserveInventory('LMERGE', [childIds[0]])

      await expect(db.mergeSplitInventory(parent.id)).rejects.toThrow('引き当て中')
    })
  })

  it('私物判定：キーワード未設定なら型番の有無、設定していればキーワードの有無で判定する', async () => {
    await db.insertCollected([
      { mercariItemId: 'm1', title: '私物の売却です', price: 1000, soldAt: '2026-01-01' },
      { mercariItemId: 'm2', title: 'クリームわん【Z080-1】', price: 2000, soldAt: '2026-01-02' },
    ])
    const salesNoKeyword = await db.listSales()
    expect(salesNoKeyword.find(s => s.mercari_item_id === 'm1')!.kind).toBe('personal')
    expect(salesNoKeyword.find(s => s.mercari_item_id === 'm2')!.kind).toBe('resale')

    await db.setSetting('mercari_keyword', '限定')
    await db.insertCollected([
      { mercariItemId: 'm3', title: '限定コラボ【Z080-1】', price: 2000, soldAt: '2026-01-03' },
      { mercariItemId: 'm4', title: 'クリームわん【Z080-1】', price: 2000, soldAt: '2026-01-04' },
    ])
    const salesWithKeyword = await db.listSales()
    expect(salesWithKeyword.find(s => s.mercari_item_id === 'm3')!.kind).toBe('resale')
    // 型番はあるがキーワードを含まないので私物扱い
    expect(salesWithKeyword.find(s => s.mercari_item_id === 'm4')!.kind).toBe('personal')
  })

  it('私物判定：mercari_keywordは , 、 空白 改行区切りの複数語として扱い、どれか1つ含めばresale', async () => {
    await db.setSetting('mercari_keyword', 'メロジョイ, Mellojoy、ジョイ')
    await db.insertCollected([
      { mercariItemId: 'k1', title: 'メロジョイ限定コラボ', price: 1000, soldAt: '2026-01-01' },
      { mercariItemId: 'k2', title: 'Mellojoyのグッズ', price: 1000, soldAt: '2026-01-02' },
      { mercariItemId: 'k3', title: 'かわいいジョイちゃん', price: 1000, soldAt: '2026-01-03' },
      { mercariItemId: 'k4', title: 'ぜんぜん関係ない商品', price: 1000, soldAt: '2026-01-04' },
    ])
    const sales = await db.listSales()
    expect(sales.find(s => s.mercari_item_id === 'k1')!.kind).toBe('resale')
    expect(sales.find(s => s.mercari_item_id === 'k2')!.kind).toBe('resale')
    expect(sales.find(s => s.mercari_item_id === 'k3')!.kind).toBe('resale')
    expect(sales.find(s => s.mercari_item_id === 'k4')!.kind).toBe('personal')
  })

  it('appendModelCodes：説明文から拾った型番を追記し、resaleに戻して自動紐付けする', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 }],
    })

    // タイトルに型番が無いので私物扱いで取り込まれる
    await db.insertCollected([
      { mercariItemId: 'm10', title: '素敵な商品です', price: 2000, soldAt: '2026-01-05' },
    ])
    const saleId = (await db.listSales()).find(s => s.mercari_item_id === 'm10')!.id
    expect((await db.listSales()).find(s => s.id === saleId)!.kind).toBe('personal')

    const changed = await db.appendModelCodes(saleId, ['Z080-1'])
    expect(changed).toBe(true)

    const s = (await db.listSales()).find(x => x.id === saleId)!
    expect(s.kind).toBe('resale')
    expect(s.model_codes).toEqual(['Z080-1'])
    expect(s.auto_linked).toBe(1)
    expect(s.cost).toBe(1000)
    expect(s.unmatched).toBe(0)
  })

  it('appendModelCodes：同じ型番を足しても変化なしなら false', async () => {
    const saleId = await db.createSale({ title: '【Z080-1】クリームわん', sold_at: '2026-01-05', price: 2000 })
    expect(await db.appendModelCodes(saleId, ['Z080-1'])).toBe(false)
  })

  it('appendModelCodes：人が手でpersonalにした販売はresaleに戻さない', async () => {
    // タイトルに型番があるので取り込み時点ではresale
    await db.insertCollected([
      { mercariItemId: 'm11', title: '【Z080-1】掘り出し物', price: 2000, soldAt: '2026-01-05' },
    ])
    const saleId = (await db.listSales()).find(s => s.mercari_item_id === 'm11')!.id

    // 人が手でpersonalに変更した状態を模す（updated_atがcreated_atから進む）
    await db.sqlRun(`update sale set kind = 'personal', updated_at = now() + interval '1 minute' where id = ?`, saleId)

    const changed = await db.appendModelCodes(saleId, ['Z088-2'])
    expect(changed).toBe(true)

    const s = (await db.listSales()).find(x => x.id === saleId)!
    expect(s.kind).toBe('personal')
    expect([...s.model_codes].sort()).toEqual(['Z080-1', 'Z088-2'])
  })

  it('appendModelCodes：updateSale で人が personal にしたものも戻さない（updated_at は実際の時刻で進む）', async () => {
    await db.insertCollected([
      { mercariItemId: 'm12', title: '【Z080-1】掘り出し物', price: 2000, soldAt: '2026-01-05' },
    ])
    const saleId = (await db.listSales()).find(s => s.mercari_item_id === 'm12')!.id
    await db.updateSale(saleId, { kind: 'personal' })
    expect(await db.appendModelCodes(saleId, ['Z088-2'])).toBe(true)
    expect(await db.saleKindOf(saleId)).toBe('personal')
  })

  describe('updateSale：タイトルを書き換えたときの model_codes 列', () => {
    it('画面の値（listSales）と自動紐付けが使う値が食い違っていたことの再現：' +
      'タイトルを直しても列が古いままだと在庫があるのに自動紐付けが失敗する', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'クリームわん【A040】', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]

      // Yahoo!フリマの売上金管理のように、型番が読めない途中で切れたタイトルで取り込まれる
      const saleId = await db.createSale({ title: '素敵な商品です', sold_at: '2026-01-05', price: 2000 })
      expect((await db.listSales()).find(s => s.id === saleId)!.model_codes).toEqual([])

      // 修正前の挙動を裏から再現する：title だけ書き換え、model_codes 列は触らない
      await db.sqlRun(`update sale set title = ? where id = ?`, '【A040】素敵な商品です', saleId)

      // 「画面の値」（listSales＝保存された列）は古いまま＝空
      const staleView = (await db.listSales()).find(s => s.id === saleId)!
      expect(staleView.model_codes).toEqual([])
      // 自動紐付けも同じ古い列を読むので、型番が読めず失敗する（在庫はあるのに、である）
      expect(await db.autoLinkSale(saleId)).toBe(false)
      expect((await db.listInventory('in_stock')).find(i => i.id === item.id)).toBeDefined() // 在庫は在る

      // ここからが本来の直し方：updateSale 経由でタイトルを書き換えると、列も作り直される
      await db.updateSale(saleId, { title: '【A040】素敵な商品です' })
      const fixedView = (await db.listSales()).find(s => s.id === saleId)!
      expect(fixedView.model_codes).toEqual(['A040'])
      // 画面の値とautoLinkSaleが使う値は同じ列を見ているので、以後は一致して自動紐付けが効く
      expect(await db.autoLinkSale(saleId)).toBe(true)
      expect((await db.listSales()).find(s => s.id === saleId)!.cost).toBe(item.landed_cost)
    })

    it('タイトルを直すと model_codes 列が追随する（型番の無いタイトル→【A040】付きに直す）', async () => {
      const saleId = await db.createSale({ title: 'タイトルにはまだ型番が無い', sold_at: '2026-01-05', price: 1000 })
      expect((await db.listSales()).find(s => s.id === saleId)!.model_codes).toEqual([])

      await db.updateSale(saleId, { title: '【A040】タイトルを直した' })

      expect((await db.listSales()).find(s => s.id === saleId)!.model_codes).toEqual(['A040'])
    })

    it('説明文由来（appendModelCodesで足した型番）はタイトル編集で消えない', async () => {
      const saleId = await db.createSale({ title: '【A040】本体', sold_at: '2026-01-05', price: 1000 })
      // 説明文から後追いで見つかった型番（付属品など）を追記
      await db.appendModelCodes(saleId, ['A099'])
      expect([...(await db.listSales()).find(s => s.id === saleId)!.model_codes].sort()).toEqual(['A040', 'A099'])

      // タイトル自体は型番はそのままに、他の文言だけ直す
      await db.updateSale(saleId, { title: '【A040】本体（説明追記）' })

      expect([...(await db.listSales()).find(s => s.id === saleId)!.model_codes].sort()).toEqual(['A040', 'A099'])
    })

    it('古いタイトルにしか無かった型番は落ちる（【A040】→【A039】に直したらA040が消える）', async () => {
      const saleId = await db.createSale({ title: '【A040】本体', sold_at: '2026-01-05', price: 1000 })
      expect((await db.listSales()).find(s => s.id === saleId)!.model_codes).toEqual(['A040'])

      await db.updateSale(saleId, { title: '【A039】本体' })

      expect((await db.listSales()).find(s => s.id === saleId)!.model_codes).toEqual(['A039'])
    })

    it('タイトルを直しても、説明文由来は残しつつ古いタイトル由来だけを落とす（複合ケース）', async () => {
      const saleId = await db.createSale({ title: '【A040】本体', sold_at: '2026-01-05', price: 1000 })
      await db.appendModelCodes(saleId, ['A099']) // 説明文由来
      await db.updateSale(saleId, { title: '【A041】本体（説明追記）' }) // タイトルをA040→A041に直す

      const after = (await db.listSales()).find(s => s.id === saleId)!
      // A040（古いタイトル由来）は消え、A041（新しいタイトル）とA099（説明文由来）は残る
      expect([...after.model_codes].sort()).toEqual(['A041', 'A099'])
    })

    it('title以外のpatch（kind等）ではmodel_codesは変わらない', async () => {
      const saleId = await db.createSale({ title: '【A040】本体', sold_at: '2026-01-05', price: 1000 })
      await db.updateSale(saleId, { kind: 'personal' })
      expect((await db.listSales()).find(s => s.id === saleId)!.model_codes).toEqual(['A040'])
    })
  })

  it('applySaleActuals：実額を反映してshipping_source=actual・is_shipping_confirmed=1になる', async () => {
    const saleId = await db.createSale({ title: '実額テスト', sold_at: '2026-01-01', price: 2000 })
    await db.applySaleActuals(saleId, { fee: 180, shipping_fee: 300 })

    const s = (await db.listSales()).find(x => x.id === saleId)!
    expect(s.shipping_source).toBe('actual')
    expect(s.is_shipping_confirmed).toBe(1)
    expect(s.fee).toBe(180)
    expect(s.shipping_fee).toBe(300)
    expect(s.gross_profit).toBe(2000 - 180 - 300 - 0 - 0)
  })

  it('insertCollected：販売履歴ページの実額（fee/shippingFee/soldAt）をそのまま確定値として保存する', async () => {
    await db.insertCollected([{
      mercariItemId: 'h1',
      title: '実額つきの商品',
      price: 8999,
      soldAt: '2026-09-19', // collector側で '2026/09/19' 形式から変換済みという想定
      fee: 899,
      shippingFee: 215,
    }])

    const s = (await db.listSales()).find(x => x.mercari_item_id === 'h1')!
    expect(s.fee).toBe(899)
    expect(s.shipping_fee).toBe(215)
    expect(s.is_shipping_confirmed).toBe(1)
    expect(s.shipping_source).toBe('actual')
    expect(s.sold_at).toBe('2026-09-19')
    expect(s.gross_profit).toBe(8999 - 899 - 215 - 0 - s.cost)
  })

  it('insertCollected：shippingFeeが0は送料未入力のまま（メルカリ便を使っていない可能性が高い）', async () => {
    await db.insertCollected([{
      mercariItemId: 'h2', title: '着払いの商品', price: 1000, soldAt: '2026-09-19', shippingFee: 0,
    }])
    const s = (await db.listSales()).find(x => x.mercari_item_id === 'h2')!
    expect(s.shipping_fee).toBe(0)
    expect(s.is_shipping_confirmed).toBe(0)
    expect(s.shipping_source).toBe('actual')
  })

  describe('fee_source：手数料が実額か見込みか（価格変更で実額を上書きしない）', () => {
    it('createSale：fee_sourceは常にrate（率から計算した見込み）', async () => {
      const saleId = await db.createSale({ title: '手入力の販売', sold_at: '2026-01-05', price: 1000 })
      expect((await db.listSales()).find(s => s.id === saleId)!.fee_source).toBe('rate')
    })

    it('createSale：feeに実額を渡すとそのまま保存されfee_source=actualになる。0円（キャンペーン）も実額', async () => {
      // 実測：5,200円→0円（キャンペーン適用）
      const zeroId = await db.createSale({
        title: 'キャンペーン販売', sold_at: '2026-01-05', price: 5200, channel: 'yahoo', fee: 0,
      })
      const zero = (await db.listSales()).find(s => s.id === zeroId)!
      expect(zero.fee).toBe(0)
      expect(zero.fee_source).toBe('actual')

      // 実測：4,280円→213円（5%なら214円になるはずが合わない＝率で計算できない）
      const oddId = await db.createSale({
        title: '端数が合わない販売', sold_at: '2026-01-05', price: 4280, channel: 'yahoo', fee: 213,
      })
      const odd = (await db.listSales()).find(s => s.id === oddId)!
      expect(odd.fee).toBe(213)
      expect(odd.fee_source).toBe('actual')
    })

    it('createSale：feeを省略すると率で計算されfee_source=rateになる（メルカリ10%・Yahoo5%の両方）', async () => {
      const mercariId = await db.createSale({ title: 'メルカリ手入力', sold_at: '2026-01-05', price: 3000 })
      const mercari = (await db.listSales()).find(s => s.id === mercariId)!
      expect(mercari.fee).toBe(300) // floor(3000*1000/10000)
      expect(mercari.fee_source).toBe('rate')

      const yahooId = await db.createSale({
        title: 'Yahoo手入力', sold_at: '2026-01-05', price: 6400, channel: 'yahoo',
      })
      const yahoo = (await db.listSales()).find(s => s.id === yahooId)!
      expect(yahoo.fee).toBe(320) // floor(6400*500/10000)
      expect(yahoo.fee_source).toBe('rate')
    })

    it('createSale：feeに負の額を渡すとthrow', async () => {
      await expect(db.createSale({
        title: '不正な手数料', sold_at: '2026-01-05', price: 1000, fee: -1,
      })).rejects.toThrow('手数料は整数で入力してください')
    })

    it('insertCollected：feeを渡さなければrate、渡せば0でもactualになる（Yahooのキャンペーンは実額0円）', async () => {
      await db.insertCollected([{ mercariItemId: 'fs-1', title: '見込みのまま', price: 1000, soldAt: '2026-09-01' }])
      await db.insertCollected([{ mercariItemId: 'fs-2', title: '実額0円', price: 5200, soldAt: '2026-09-01', fee: 0 }])
      await db.insertCollected([{ mercariItemId: 'fs-3', title: '実額あり', price: 6400, soldAt: '2026-09-01', fee: 320 }])

      const sales = await db.listSales()
      expect(sales.find(s => s.mercari_item_id === 'fs-1')!.fee_source).toBe('rate')
      const zeroFee = sales.find(s => s.mercari_item_id === 'fs-2')!
      expect(zeroFee.fee).toBe(0)
      expect(zeroFee.fee_source).toBe('actual')
      expect(sales.find(s => s.mercari_item_id === 'fs-3')!.fee_source).toBe('actual')
    })

    it('applySaleActuals：feeに0を渡してもfee_source=actualになる（0は「未取得」ではなく実額）', async () => {
      const saleId = await db.createSale({
        title: 'キャンペーン販売', sold_at: '2026-01-05', price: 5200, channel: 'yahoo',
      })
      expect((await db.listSales()).find(s => s.id === saleId)!.fee_source).toBe('rate')

      await db.applySaleActuals(saleId, { fee: 0 })
      const s = (await db.listSales()).find(x => x.id === saleId)!
      expect(s.fee).toBe(0)
      expect(s.fee_source).toBe('actual')
    })

    it('updateSale：実額（fee=0）が入った販売は価格を変えてもfeeが0のまま。rateの販売は今までどおり再計算される', async () => {
      // 実額0円（Yahoo!フリマのキャンペーン適用。実測：5,200円→0円）
      const actualId = await db.createSale({
        title: 'キャンペーン販売', sold_at: '2026-01-05', price: 5200, channel: 'yahoo',
      })
      await db.applySaleActuals(actualId, { fee: 0 })

      await db.updateSale(actualId, { price: 6000 })
      const actualSale = (await db.listSales()).find(s => s.id === actualId)!
      expect(actualSale.price).toBe(6000)
      expect(actualSale.fee).toBe(0) // 率で上書きされていない
      expect(actualSale.fee_source).toBe('actual')

      // 率のまま（手入力）の販売は今までどおり価格変更で再計算される
      const rateId = await db.createSale({ title: '手入力の販売', sold_at: '2026-01-05', price: 1000 })
      await db.updateSale(rateId, { price: 2000 })
      const rateSale = (await db.listSales()).find(s => s.id === rateId)!
      expect(rateSale.fee).toBe(200) // floor(2000*1000/10000)
      expect(rateSale.fee_source).toBe('rate')
    })

    it('updateSale：patch.feeで実額に直す／nullで率に戻す。価格と同時に渡しても実額が勝つ', async () => {
      // createSale の時点でfee: 0の実額（キャンペーン）にしておく
      const saleId = await db.createSale({
        title: 'patch.feeテスト', sold_at: '2026-01-05', price: 5200, channel: 'yahoo', fee: 0,
      })
      expect((await db.listSales()).find(s => s.id === saleId)!.fee_source).toBe('actual')

      // 価格だけ変える → 実額0円のまま動かない
      await db.updateSale(saleId, { price: 6000 })
      const afterPrice = (await db.listSales()).find(s => s.id === saleId)!
      expect(afterPrice.price).toBe(6000)
      expect(afterPrice.fee).toBe(0)
      expect(afterPrice.fee_source).toBe('actual')

      // patch.feeで実額300円に直す
      await db.updateSale(saleId, { fee: 300 })
      const afterFee = (await db.listSales()).find(s => s.id === saleId)!
      expect(afterFee.fee).toBe(300)
      expect(afterFee.fee_source).toBe('actual')

      // 価格と手数料を同時に渡す → 実額が勝つ（率の700にも、手数料単独の300にもならない）
      await db.updateSale(saleId, { price: 7000, fee: 999 })
      const afterBoth = (await db.listSales()).find(s => s.id === saleId)!
      expect(afterBoth.price).toBe(7000)
      expect(afterBoth.fee).toBe(999)
      expect(afterBoth.fee_source).toBe('actual')

      // fee: null で率の計算に戻す。fee_rate_bpはchannel=yahoo既定500 → floor(7000*500/10000)=350
      // （実額999とは異なる＝ちゃんと率で計算し直していることが分かる）
      await db.updateSale(saleId, { fee: null })
      const afterNull = (await db.listSales()).find(s => s.id === saleId)!
      expect(afterNull.fee_source).toBe('rate')
      expect(afterNull.fee).toBe(350)

      const raw = (await db.sqlGet<{ fee_rate_bp: number }>('select fee_rate_bp from sale where id = ?', saleId))!
      expect(afterNull.fee).toBe(Math.floor((afterNull.price * raw.fee_rate_bp) / 10000))
    })

    it('updateSale：patch.feeに負の額を渡すとthrow', async () => {
      const saleId = await db.createSale({ title: '不正な手数料パッチ', sold_at: '2026-01-05', price: 1000 })
      await expect(db.updateSale(saleId, { fee: -1 })).rejects.toThrow('手数料は整数で入力してください')
    })

    it('粗利の検算：実額0円のYahoo販売の価格を変えたあとも、粗利が「新価格−0−送料−梱包材費−原価」と数字で一致する', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'fee_source検算用', unit_price: 1500, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]

      const saleId = await db.createSale({
        title: 'fee_source検算用の販売', sold_at: '2026-01-10', price: 5200, channel: 'yahoo',
      })
      await db.linkInventory(saleId, [item.id])
      await db.applySaleActuals(saleId, { fee: 0 })
      await db.updateSale(saleId, { price: 6000, packaging_cost: 50, shipping_fee: 300 })

      const s = (await db.listSales()).find(x => x.id === saleId)!
      expect(s.price).toBe(6000)
      expect(s.fee).toBe(0)
      expect(s.fee_source).toBe('actual')
      expect(s.shipping_fee).toBe(300)
      expect(s.packaging_cost).toBe(50)
      expect(s.cost).toBe(1500)
      expect(s.gross_profit).toBe(6000 - 0 - 300 - 50 - 1500)
      expect(s.gross_profit).toBe(4150)
    })

    it('monthly_summary：createSaleでfee:0（実額）のYahoo販売を入れると、その月の手数料合計・粗利に0円が反映される（260円ずれない）', async () => {
      await db.createSale({
        title: 'キャンペーン販売（月次検算）', sold_at: todayJst(), price: 5200, channel: 'yahoo', fee: 0,
      })

      // ホーム（getDashboard）は別のドメイン。同じ数字の元になるビューを直接読む
      const month = (await db.sql<{
        month: string; revenue: number; total_fee: number; gross_profit: number
      }>(`select month, revenue, total_fee, gross_profit from monthly_summary where month = ? and kind = 'resale'`, thisMonthJst()))[0]
      expect(month.revenue).toBe(5200)
      expect(month.total_fee).toBe(0) // 率(5%)なら260円になるところ、実額0円で入っている
      expect(month.gross_profit).toBe(5200) // 5200 - 0(fee) - 0(shipping) - 0(packaging) - 0(cost)
    })
  })

  it('updateCollectedActuals：既存の（料率計算・未確定・仮日付の）販売を実額と本当の日付に置き換える。手入力の日付は変えない', async () => {
    // collector が仮の取得日で先に積んだ販売（料率計算・未確定）
    await db.insertCollected([{ mercariItemId: 'u1', title: '後で実額が来る商品', price: 3000, soldAt: '2026-09-01' }])
    const before = (await db.listSales()).find(s => s.mercari_item_id === 'u1')!
    expect(before.shipping_source).toBeNull()
    expect(before.is_shipping_confirmed).toBe(0)
    expect(before.fee).toBe(300) // 料率10%で計算された仮の値

    // 手入力の販売（同じ mercari_item_id を持つケースを模す）
    const manualId = await db.createSale({
      title: '手入力の商品', sold_at: '2026-01-01', price: 1000, mercari_item_id: 'u2',
    })

    const updated = await db.updateCollectedActuals([
      { mercariItemId: 'u1', soldAt: '2026-08-15', fee: 250, shippingFee: 0 },
      { mercariItemId: 'u2', soldAt: '2026-08-20', fee: 90, shippingFee: 0 },
      { mercariItemId: 'does-not-exist', soldAt: '2026-08-20' },
    ])
    expect(updated).toBe(2)

    const after = (await db.listSales()).find(s => s.mercari_item_id === 'u1')!
    expect(after.sold_at).toBe('2026-08-15')
    expect(after.fee).toBe(250)
    expect(after.shipping_fee).toBe(0)
    expect(after.shipping_source).toBe('actual')
    expect(after.is_shipping_confirmed).toBe(0) // 送料0はメルカリ便未使用の疑いがあるので未確定のまま

    // 手入力の販売：sold_at は変わらない
    const manual = (await db.listSales()).find(s => s.id === manualId)!
    expect(manual.sold_at).toBe('2026-01-01')

    // 既に actual & 同じ sold_at のものは再適用しても更新0件
    const noop = await db.updateCollectedActuals([
      { mercariItemId: 'u1', soldAt: '2026-08-15', fee: 250, shippingFee: 0 },
    ])
    expect(noop).toBe(0)
  })

  it('updateCollectedActuals：fee_sourceがrateのまま（誤判定を模す）でも、同じ金額のfeeが来ればactualへ自己修復する。feeの値自体は変えない', async () => {
    await db.insertCollected([
      { mercariItemId: 'heal-1', title: '自己修復対象', price: 1000, soldAt: '2026-09-01', fee: 100 },
    ])
    const before = (await db.listSales()).find(s => s.mercari_item_id === 'heal-1')!
    expect(before.fee_source).toBe('actual')
    // 率と偶然一致する実額をrateにしてしまう誤判定を再現する
    await db.sqlRun(`update sale set fee_source = 'rate' where id = ?`, before.id)
    expect((await db.listSales()).find(s => s.id === before.id)!.fee_source).toBe('rate')

    // 同じ金額のfeeが取り込みで返ってきただけでも、fee_sourceをactualへ直す
    const updated = await db.updateCollectedActuals([{ mercariItemId: 'heal-1', soldAt: before.sold_at, fee: 100 }])
    expect(updated).toBe(1)
    const healed = (await db.listSales()).find(s => s.id === before.id)!
    expect(healed.fee_source).toBe('actual')
    expect(healed.fee).toBe(100) // feeの値自体は変わらない

    // 自己修復が効いている＝以後 updateSale で価格を変えても手数料は再計算されない
    await db.updateSale(before.id, { price: 2000 })
    const afterPriceChange = (await db.listSales()).find(s => s.id === before.id)!
    expect(afterPriceChange.fee).toBe(100)
    expect(afterPriceChange.fee_source).toBe('actual')
  })

  it('updateCollectedActuals：r.feeがnullのときはfee_sourceを触らない', async () => {
    const [{ id }] = await db.insertCollected([
      { mercariItemId: 'heal-null', title: 'feeなし取り込み', price: 1000, soldAt: '2026-09-01' },
    ])
    const before = (await db.listSales()).find(s => s.id === id)!
    expect(before.fee_source).toBe('rate')

    // feeはnull（未取得）のまま、status完了だけ観測させても fee_source は変わらない
    const updated = await db.updateCollectedActuals([{ mercariItemId: 'heal-null', soldAt: before.sold_at, fee: null }])
    expect(updated).toBe(1) // status が completed へ進むので更新自体は起きる
    const after = (await db.listSales()).find(s => s.id === id)!
    expect(after.fee_source).toBe('rate')
    expect(after.fee).toBe(before.fee) // feeの値も変わらない
  })

  it('タグ：販売から外れる（deleteTag で CASCADE）', async () => {
    const tagId = await db.createTag('まとめ売り')
    const saleId = await db.createSale({ title: 'タグ付き商品', sold_at: '2026-01-01', price: 1000 })
    await db.setSaleTags(saleId, [tagId])
    expect((await db.listSales()).find(s => s.id === saleId)!.tags.map(t => t.name)).toEqual(['まとめ売り'])

    await db.deleteTag(tagId)
    // CASCADEで販売からも外れる
    expect((await db.listSales()).find(s => s.id === saleId)!.tags).toEqual([])
  })

  it('setSaleTags：タグの置き換え（丸ごと入れ替え）', async () => {
    const tagA = await db.createTag('A')
    const tagB = await db.createTag('B')

    const saleId = await db.createSale({ title: '商品', sold_at: '2026-01-01', price: 1000 })
    await db.setSaleTags(saleId, [tagA, tagB])
    expect((await db.listSales()).find(s => s.id === saleId)!.tags.map(t => t.id).sort())
      .toEqual([tagA, tagB].sort())

    // 置き換え：Bだけになる
    await db.setSaleTags(saleId, [tagB])
    expect((await db.listSales()).find(s => s.id === saleId)!.tags.map(t => t.id)).toEqual([tagB])

    // 空配列で全部外す
    await db.setSaleTags(saleId, [])
    expect((await db.listSales()).find(s => s.id === saleId)!.tags).toEqual([])
  })

  it('listSales({tagId})：タグで絞り込める', async () => {
    const tagId = await db.createTag('絞り込み用')
    const s1 = await db.createSale({ title: 'A', sold_at: '2026-01-01', price: 1000 })
    const s2 = await db.createSale({ title: 'B', sold_at: '2026-01-02', price: 1000 })
    await db.setSaleTags(s1, [tagId])

    const filtered = await db.listSales({ tagId })
    expect(filtered.map(s => s.id)).toEqual([s1])

    const all = await db.listSales()
    expect(all.map(s => s.id).sort()).toEqual([s1, s2].sort())
  })

  it('saleTotals：タグ絞り込みの合計が手計算と一致する。0件なら全部0', async () => {
    const tagId = await db.createTag('集計用')
    // 取引完了を明示した販売（状態未設定の手入力は実績扱い。ここでは取り込みの完了と同じにする）
    const completed = async (input: Parameters<typeof db.createSale>[0]) => {
      const id = await db.createSale(input)
      await db.applySaleActuals(id, { status: 'completed' })
      return id
    }
    const s1 = await completed({ title: 'A', sold_at: '2026-01-01', price: 2000 }) // fee 200
    const s2 = await completed({ title: 'B', sold_at: '2026-01-02', price: 3000 }) // fee 300
    await completed({ title: 'C（タグなし）', sold_at: '2026-01-03', price: 5000 })
    await db.setSaleTags(s1, [tagId])
    await db.setSaleTags(s2, [tagId])

    const totals = await db.saleTotals({ tagId })
    expect(totals).toEqual({
      forecast: { count: 0, revenue: 0, gross_profit: 0 },
      count: 2,
      revenue: 2000 + 3000,
      total_fee: 200 + 300,
      total_shipping: 0,
      total_packaging: 0,
      total_cost: 0,
      gross_profit: (2000 - 200) + (3000 - 300),
    })

    // 存在しないタグ（uuid）で絞ると 0 件
    const empty = await db.saleTotals({ tagId: randomUUID() })
    expect(empty).toEqual({
      forecast: { count: 0, revenue: 0, gross_profit: 0 },
      count: 0, revenue: 0, total_fee: 0, total_shipping: 0,
      total_packaging: 0, total_cost: 0, gross_profit: 0,
    })
  })

  it('source：自動取得(collector)と手入力(manual)がsale_profitに出る', async () => {
    await db.insertCollected([{ mercariItemId: 'src1', title: '自動取得の商品', price: 1000, soldAt: '2026-01-01' }])
    const manualId = await db.createSale({ title: '手入力の商品', sold_at: '2026-01-01', price: 1000 })

    expect((await db.listSales()).find(s => s.mercari_item_id === 'src1')!.source).toBe('collector')
    expect((await db.listSales()).find(s => s.id === manualId)!.source).toBe('manual')
  })

  it('setSaleThumb：保存したパスが listSales / 紐付いた在庫の listInventory に公開URLで出る。未紐付けの在庫はnull', async () => {
    await db.createPurchase({
      shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [
        { name: 'クリームわん【Z080-1】', unit_price: 1000, quantity: 1 },
        { name: 'いちごスフレ【Z088-2】', unit_price: 1200, quantity: 1 },
      ],
    })
    const [linkedItem, otherItem] = await db.listInventory('in_stock')

    const saleId = await db.createSale({ title: 'サムネイルテスト', sold_at: '2026-01-10', price: 2000 })
    await db.linkInventory(saleId, [linkedItem.id])

    expect((await db.listSales()).find(s => s.id === saleId)!.thumb_url).toBeNull()

    await db.setSaleThumb(saleId, 'hh/sale/m8703.jpg')

    expect((await db.listSales()).find(s => s.id === saleId)!.thumb_url).toBe(`${MEDIA}/hh/sale/m8703.jpg`)

    const sold = await db.listInventory('sold')
    expect(sold.find(i => i.id === linkedItem.id)!.thumb_url).toBe(`${MEDIA}/hh/sale/m8703.jpg`)

    // 未紐付けの在庫（in_stockのまま）は当然null
    expect((await db.listInventory('in_stock')).find(i => i.id === otherItem.id)!.thumb_url).toBeNull()
  })

  it('salesWithoutThumb：thumb_pathがNULLの既存販売だけ返す（元からあった分にも後追いでサムネを付けるため）', async () => {
    await db.insertCollected([
      { mercariItemId: 'nt1', title: 'サムネ未保存', price: 1000, soldAt: '2026-01-01' },
      { mercariItemId: 'nt2', title: 'サムネ保存済み', price: 1000, soldAt: '2026-01-02' },
    ])
    const withThumbId = (await db.listSales()).find(s => s.mercari_item_id === 'nt2')!.id
    await db.setSaleThumb(withThumbId, 'nt2.jpg')

    const targets = await db.salesWithoutThumb(['nt1', 'nt2', 'no-such-id'])
    expect(targets.map(t => t.mercariItemId)).toEqual(['nt1'])

    expect(await db.salesWithoutThumb([])).toEqual([])
  })

  describe('メルカリの取引状態（取引中タブ）', () => {
    it('insertCollected：statusを渡すと保存され、shipped/delivered/completedの初期日付も入る', async () => {
      await db.insertCollected([
        { mercariItemId: 'ip-1', title: '発送待ちの商品', price: 1000, soldAt: '2026-08-01', status: 'waiting_shipment' },
        { mercariItemId: 'ip-2', title: '評価待ちの商品', price: 1000, soldAt: '2026-08-02', status: 'delivered' },
        { mercariItemId: 'ip-3', title: '状態不明の商品', price: 1000, soldAt: '2026-08-03' },
      ])

      const sales = await db.listSales()
      const s1 = sales.find(s => s.mercari_item_id === 'ip-1')!
      expect(s1.status).toBe('waiting_shipment')
      expect(s1.shipped_at).toBeNull()
      expect(s1.delivered_at).toBeNull()
      expect(s1.completed_at).toBeNull()

      const s2 = sales.find(s => s.mercari_item_id === 'ip-2')!
      expect(s2.status).toBe('delivered')
      expect(s2.shipped_at).toBe('2026-08-02')
      expect(s2.delivered_at).toBe('2026-08-02')
      expect(s2.completed_at).toBeNull()

      const s3 = sales.find(s => s.mercari_item_id === 'ip-3')!
      expect(s3.status).toBeNull()
    })

    it('updateSaleStatus：状態は前にしか進まない。同じ状態・後戻りはfalseで何もしない', async () => {
      await db.insertCollected([
        { mercariItemId: 'st-1', title: '商品', price: 1000, soldAt: '2026-08-01', status: 'waiting_payment' },
      ])
      const id = (await db.listSales()).find(s => s.mercari_item_id === 'st-1')!.id

      expect(await db.updateSaleStatus('st-1', 'waiting_shipment', '2026-08-02')).toBe(true)
      expect((await db.listSales()).find(s => s.id === id)!.status).toBe('waiting_shipment')

      // 後戻り：無視されfalse
      expect(await db.updateSaleStatus('st-1', 'waiting_payment', '2026-08-03')).toBe(false)
      expect((await db.listSales()).find(s => s.id === id)!.status).toBe('waiting_shipment')

      // 同じ状態：無視されfalse
      expect(await db.updateSaleStatus('st-1', 'waiting_shipment', '2026-08-03')).toBe(false)

      // 未知のmercari_item_idはfalse
      expect(await db.updateSaleStatus('does-not-exist', 'shipped')).toBe(false)
    })

    it('updateSaleStatus：shipped_at・delivered_atは初めて観測した日で固定（後から呼んでも変わらない）', async () => {
      await db.insertCollected([
        { mercariItemId: 'st-2', title: '商品', price: 1000, soldAt: '2026-08-01', status: 'waiting_shipment' },
      ])

      expect(await db.updateSaleStatus('st-2', 'shipped', '2026-08-05')).toBe(true)
      let s = (await db.listSales()).find(x => x.mercari_item_id === 'st-2')!
      expect(s.shipped_at).toBe('2026-08-05')
      expect(s.delivered_at).toBeNull()

      // delivered まで進めても、既に入っているshipped_atは動かない
      expect(await db.updateSaleStatus('st-2', 'delivered', '2026-08-09')).toBe(true)
      s = (await db.listSales()).find(x => x.mercari_item_id === 'st-2')!
      expect(s.shipped_at).toBe('2026-08-05')
      expect(s.delivered_at).toBe('2026-08-09')
    })

    it('updateSaleStatus：観測日を省略すると日本時間の今日（UTC の 15:00〜23:59 は翌日）', async () => {
      await db.insertCollected([
        { mercariItemId: 'st-3', title: '商品', price: 1000, soldAt: '2026-08-01', status: 'waiting_shipment' },
      ])
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 9, 15, 30, 0))) // JST 2026-08-10 00:30
      try {
        expect(await db.updateSaleStatus('st-3', 'shipped')).toBe(true)
      } finally {
        vi.useRealTimers()
      }
      expect((await db.listSales()).find(x => x.mercari_item_id === 'st-3')!.shipped_at).toBe('2026-08-10')
    })

    it('updateCollectedActuals：売却済み一覧で観測したらstatus=completed・completed_atが付き、取引中タブで先に入っていたsold_atも完了日へ動く', async () => {
      // 取引中タブで先に取り込まれた販売（sold_atは「初めて見た日」の仮日付）
      await db.insertCollected([
        { mercariItemId: 'ip-done', title: '取引中から入った商品', price: 2000, soldAt: '2026-08-01', status: 'waiting_shipment' },
      ])
      await db.updateSaleStatus('ip-done', 'shipped', '2026-08-02')

      // 後日、売却済み一覧（販売履歴）で観測。soldAtは本当の購入完了日
      const updated = await db.updateCollectedActuals([
        { mercariItemId: 'ip-done', soldAt: '2026-08-10', fee: 200, shippingFee: 300 },
      ])
      expect(updated).toBe(1)

      const s = (await db.listSales()).find(x => x.mercari_item_id === 'ip-done')!
      expect(s.sold_at).toBe('2026-08-10') // 仮置きから本当の完了日へ動く
      expect(s.status).toBe('completed')
      expect(s.completed_at).toBe('2026-08-10')
      expect(s.fee).toBe(200)
      expect(s.shipping_fee).toBe(300)

      // 2回目に呼んでも completed_at は最初に観測した日のまま
      await db.updateCollectedActuals([
        { mercariItemId: 'ip-done', soldAt: '2026-08-11', fee: 200, shippingFee: 300 },
      ])
      expect((await db.listSales()).find(x => x.mercari_item_id === 'ip-done')!.completed_at).toBe('2026-08-10')
    })

    it('updateCollectedActuals：取引中タブを経由していない販売は、従来どおりsold_atを本当の日付に直す', async () => {
      await db.insertCollected([{ mercariItemId: 'plain-1', title: '商品', price: 1000, soldAt: '2026-08-01' }])

      await db.updateCollectedActuals([{ mercariItemId: 'plain-1', soldAt: '2026-07-20', fee: 100 }])

      const s = (await db.listSales()).find(x => x.mercari_item_id === 'plain-1')!
      expect(s.sold_at).toBe('2026-07-20')
      expect(s.status).toBe('completed')
      expect(s.completed_at).toBe('2026-07-20')
    })

    it('実績と見込み：status が completed の販売だけが saleTotals の実績に入り、未完了は forecast に分かれる', async () => {
      await db.insertCollected([
        { mercariItemId: 'rz-1', title: '完了', price: 2000, soldAt: '2026-08-01', status: 'completed' },
        { mercariItemId: 'rz-2', title: '発送待ち', price: 3000, soldAt: '2026-08-02', status: 'waiting_shipment' },
      ])
      const totals = await db.saleTotals()
      expect(totals.count).toBe(1)
      expect(totals.revenue).toBe(2000)
      expect(totals.forecast).toEqual({ count: 1, revenue: 3000, gross_profit: 3000 - 300 })
      // 月次（ビュー）も実績だけ
      const monthly = await db.sql<{ month: string; revenue: number }>(`select month, revenue from monthly_summary`)
      expect(monthly).toEqual([{ month: '2026-08', revenue: 2000 }])
    })
  })

  describe('出品先（channel）：メルカリ / Yahoo!フリマ', () => {
    it('setting.fee_rate_bp_yahooの既定は500（5.00%）', async () => {
      expect((await db.getSettings()).fee_rate_bp_yahoo).toBe('500')
    })

    it('createSale：channel省略・mercariはfee_rate_bp(既定1000)、yahooはfee_rate_bp_yahoo(既定500)が焼き付く', async () => {
      const idDefault = await db.createSale({ title: '省略', sold_at: '2026-01-05', price: 1000 })
      const idMercari = await db.createSale({ title: 'メルカリ', sold_at: '2026-01-05', price: 1000, channel: 'mercari' })
      const idYahoo = await db.createSale({ title: 'Yahoo', sold_at: '2026-01-05', price: 1000, channel: 'yahoo' })

      const sales = await db.listSales()
      const byId = (id: string) => sales.find(s => s.id === id)!

      expect(byId(idDefault).channel).toBe('mercari')
      expect(byId(idDefault).fee).toBe(100) // floor(1000*1000/10000)

      expect(byId(idMercari).channel).toBe('mercari')
      expect(byId(idMercari).fee).toBe(100)

      expect(byId(idYahoo).channel).toBe('yahoo')
      expect(byId(idYahoo).fee).toBe(50) // floor(1000*500/10000)

      const raw = (await db.sqlGet<{ fee_rate_bp: number }>('select fee_rate_bp from sale where id = ?', idYahoo))!
      expect(raw.fee_rate_bp).toBe(500)
    })

    it('設定のfee_rate_bp_yahooをあとで変えても、既に作った販売のfee_rate_bpは動かない', async () => {
      const saleId = await db.createSale({ title: 'Yahoo旧率', sold_at: '2026-01-05', price: 1000, channel: 'yahoo' })
      const before = await db.sqlGet('select fee_rate_bp, fee from sale where id = ?', saleId)
      expect(before).toEqual({ fee_rate_bp: 500, fee: 50 })

      await db.setSetting('fee_rate_bp_yahoo', '1000')

      const after = await db.sqlGet('select fee_rate_bp, fee from sale where id = ?', saleId)
      expect(after).toEqual({ fee_rate_bp: 500, fee: 50 })

      // 新規に作るYahoo販売は新しい率が使われる
      const newId = await db.createSale({ title: 'Yahoo新率', sold_at: '2026-01-06', price: 1000, channel: 'yahoo' })
      const newRaw = (await db.sqlGet<{ fee_rate_bp: number }>('select fee_rate_bp from sale where id = ?', newId))!
      expect(newRaw.fee_rate_bp).toBe(1000)
    })

    it('Yahoo!フリマの販売の粗利（sale_profit）が「販売価格－手数料－送料－梱包材費－原価」と数字で一致する', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'Yahoo検算用', unit_price: 1200, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]

      const saleId = await db.createSale({
        title: 'Yahoo検算用の販売', sold_at: '2026-01-10', price: 5000, channel: 'yahoo',
      })
      await db.linkInventory(saleId, [item.id])
      await db.updateSale(saleId, { packaging_cost: 50, shipping_fee: 300 })

      const s = (await db.listSales()).find(x => x.id === saleId)!
      // channel='yahoo' → fee_rate_bp_yahoo 既定500(5%) → fee = floor(5000*500/10000) = 250
      expect(s.channel).toBe('yahoo')
      expect(s.price).toBe(5000)
      expect(s.fee).toBe(250)
      expect(s.shipping_fee).toBe(300)
      expect(s.packaging_cost).toBe(50)
      expect(s.cost).toBe(1200)
      expect(s.gross_profit).toBe(5000 - 250 - 300 - 50 - 1200)
      expect(s.gross_profit).toBe(3200)
    })

    it('insertCollected：channelを渡すとsale.channelに乗り、実額が無いときの手数料が出品先の率になる', async () => {
      const [yahoo] = await db.insertCollected(
        [{ mercariItemId: 'YIC-1', title: 'Yahoo取り込み', price: 6000, soldAt: '2026-02-01' }],
        'yahoo',
      )
      const s = (await db.listSales()).find(x => x.id === yahoo.id)!
      expect(s.channel).toBe('yahoo')
      // fee_rate_bp_yahoo 既定500(5%) → fee = floor(6000*500/10000) = 300
      expect(s.fee).toBe(300)
      expect(s.fee_source).toBe('rate')
    })

    it('insertCollected：channelを渡さない既存の呼び出しは今までどおりmercariになる', async () => {
      const [mercari] = await db.insertCollected(
        [{ mercariItemId: 'MIC-1', title: 'メルカリ取り込み', price: 6000, soldAt: '2026-02-01' }],
      )
      const s = (await db.listSales()).find(x => x.id === mercari.id)!
      expect(s.channel).toBe('mercari')
      // fee_rate_bp 既定1000(10%) → fee = floor(6000*1000/10000) = 600
      expect(s.fee).toBe(600)
    })

    it('insertCollected：channel=yahooでも、feeの実額が渡ればfee_source=actual（0円も実額）で率は使わない', async () => {
      const [zero] = await db.insertCollected(
        [{ mercariItemId: 'YIC-2', title: 'Yahooキャンペーン', price: 5200, soldAt: '2026-02-01', fee: 0 }],
        'yahoo',
      )
      const zeroSale = (await db.listSales()).find(s => s.id === zero.id)!
      expect(zeroSale.fee).toBe(0)
      expect(zeroSale.fee_source).toBe('actual')

      const [actual] = await db.insertCollected(
        [{ mercariItemId: 'YIC-3', title: 'Yahoo実額', price: 6400, soldAt: '2026-02-01', fee: 320 }],
        'yahoo',
      )
      const actualSale = (await db.listSales()).find(s => s.id === actual.id)!
      expect(actualSale.fee).toBe(320)
      expect(actualSale.fee_source).toBe('actual')
    })

    it('setting.yahoo_keywordの既定は空文字（新規世帯）。保存して読み戻せる。mercari_keywordとは独立している', async () => {
      expect((await db.getSettings()).yahoo_keyword).toBe('')

      await db.setSetting('mercari_keyword', 'メロジョイ')
      await db.setSetting('yahoo_keyword', 'ヤフー限定')

      expect((await db.getSettings()).yahoo_keyword).toBe('ヤフー限定')
      expect((await db.getSettings()).mercari_keyword).toBe('メロジョイ')

      await db.setSetting('yahoo_keyword', '別のキーワード')
      expect((await db.getSettings()).yahoo_keyword).toBe('別のキーワード')
      // yahoo_keywordを変えてもmercari_keywordは影響を受けない
      expect((await db.getSettings()).mercari_keyword).toBe('メロジョイ')
    })

    it('insertCollected：channel=yahooはyahoo_keywordで判定する（mercari_keywordには引きずられない）', async () => {
      await db.setSetting('mercari_keyword', 'メロジョイ')
      await db.setSetting('yahoo_keyword', 'ヤフー限定')

      const [y1] = await db.insertCollected(
        [{ mercariItemId: 'YK-1', title: 'ヤフー限定コラボ', price: 1000, soldAt: '2026-01-01' }],
        'yahoo',
      )
      // yahoo_keywordに一致 → resale
      expect((await db.listSales()).find(s => s.id === y1.id)!.kind).toBe('resale')

      const [y2] = await db.insertCollected(
        [{ mercariItemId: 'YK-2', title: 'メロジョイ限定コラボ', price: 1000, soldAt: '2026-01-02' }],
        'yahoo',
      )
      // mercari_keywordにだけ一致・yahoo_keywordには不一致 → personal
      expect((await db.listSales()).find(s => s.id === y2.id)!.kind).toBe('personal')
    })

    it('insertCollected：channel省略（mercari）はmercari_keywordで判定する（yahoo_keywordには引きずられない）', async () => {
      await db.setSetting('mercari_keyword', 'メロジョイ')
      await db.setSetting('yahoo_keyword', 'ヤフー限定')

      const [m1] = await db.insertCollected(
        [{ mercariItemId: 'MK-1', title: 'メロジョイ限定コラボ', price: 1000, soldAt: '2026-01-01' }],
      )
      expect((await db.listSales()).find(s => s.id === m1.id)!.kind).toBe('resale')

      const [m2] = await db.insertCollected(
        [{ mercariItemId: 'MK-2', title: 'ヤフー限定コラボ', price: 1000, soldAt: '2026-01-02' }],
      )
      // yahoo_keywordにだけ一致・mercari_keywordには不一致 → personal
      expect((await db.listSales()).find(s => s.id === m2.id)!.kind).toBe('personal')
    })

    it('insertCollected：yahoo_keywordが空なら、channel=yahooでも型番の有無で判定する', async () => {
      const [noCode] = await db.insertCollected(
        [{ mercariItemId: 'YK-3', title: '型番なしYahoo商品', price: 1000, soldAt: '2026-01-01' }],
        'yahoo',
      )
      expect((await db.listSales()).find(s => s.id === noCode.id)!.kind).toBe('personal')

      const [withCode] = await db.insertCollected(
        [{ mercariItemId: 'YK-4', title: '【Z080-1】型番ありYahoo商品', price: 1000, soldAt: '2026-01-02' }],
        'yahoo',
      )
      expect((await db.listSales()).find(s => s.id === withCode.id)!.kind).toBe('resale')
    })

    it('appendModelCodes：出品先(channel)ごとのキーワードで救済判定する（mercari_keywordに固定しない）', async () => {
      // mercari_keywordは設定されているが、yahoo_keywordは空 → yahoo販売の救済は
      // 「型番が付いたか」で判定されるべき（mercari_keywordの設定に引きずられない）
      await db.setSetting('mercari_keyword', 'メロジョイ')

      const [{ id }] = await db.insertCollected(
        [{ mercariItemId: 'YAM-1', title: '型番なしYahoo商品', price: 2000, soldAt: '2026-01-05' }],
        'yahoo',
      )
      expect((await db.listSales()).find(s => s.id === id)!.kind).toBe('personal')

      const changed = await db.appendModelCodes(id, ['Z080-1'])
      expect(changed).toBe(true)
      expect((await db.listSales()).find(s => s.id === id)!.kind).toBe('resale')
    })

    it('updateYahooActuals：statusをそのまま使う（shippedではcompletedにしない・completed_at/sold_atを動かさない）', async () => {
      const [{ id }] = await db.insertCollected(
        [{
          mercariItemId: 'YUA-1', title: 'Yahoo更新対象', price: 6000, soldAt: '2026-03-01',
          status: 'waiting_shipment',
        }],
        'yahoo',
      )

      const updated = await db.updateYahooActuals([
        { mercariItemId: 'YUA-1', soldAt: '2026-03-05', status: 'shipped' },
      ])
      expect(updated).toBe(1)

      const after = (await db.listSales()).find(s => s.id === id)!
      expect(after.status).toBe('shipped')
      expect(after.completed_at).toBeNull()
      expect(after.sold_at).toBe('2026-03-01') // completedを観測するまでsold_atは動かない
    })

    it('updateYahooActuals：status=completedで初めてcompleted_atが入り、sold_atが完了日へ動く', async () => {
      const [{ id }] = await db.insertCollected(
        [{ mercariItemId: 'YUA-2', title: 'Yahoo完了対象', price: 6000, soldAt: '2026-03-01', status: 'shipped' }],
        'yahoo',
      )

      const updated = await db.updateYahooActuals([
        { mercariItemId: 'YUA-2', soldAt: '2026-03-10', status: 'completed' },
      ])
      expect(updated).toBe(1)

      const after = (await db.listSales()).find(s => s.id === id)!
      expect(after.status).toBe('completed')
      expect(after.completed_at).toBe('2026-03-10')
      expect(after.sold_at).toBe('2026-03-10')
    })

    it('updateYahooActuals：実額のfeeが変わったら反映され、fee_sourceがactualになる', async () => {
      const [{ id }] = await db.insertCollected(
        [{
          mercariItemId: 'YUA-3', title: 'Yahoo手数料変化', price: 6000, soldAt: '2026-03-01',
          status: 'completed', fee: 250,
        }],
        'yahoo',
      )
      const before = (await db.listSales()).find(s => s.id === id)!
      expect(before.fee).toBe(250)
      expect(before.fee_source).toBe('actual')

      const updated = await db.updateYahooActuals([
        { mercariItemId: 'YUA-3', soldAt: '2026-03-01', fee: 300, status: 'completed' },
      ])
      expect(updated).toBe(1)

      const after = (await db.listSales()).find(s => s.id === id)!
      expect(after.fee).toBe(300)
      expect(after.fee_source).toBe('actual')
    })

    it('updateYahooActuals：priceの実額も反映できる', async () => {
      const [{ id }] = await db.insertCollected(
        [{ mercariItemId: 'YUA-4', title: 'Yahoo価格変化', price: 6000, soldAt: '2026-03-01', status: 'completed' }],
        'yahoo',
      )
      const updated = await db.updateYahooActuals([
        { mercariItemId: 'YUA-4', soldAt: '2026-03-01', price: 5800, status: 'completed' },
      ])
      expect(updated).toBe(1)
      expect((await db.listSales()).find(s => s.id === id)!.price).toBe(5800)
    })

    it('updateYahooActuals：差分が無ければ更新0件', async () => {
      await db.insertCollected(
        [{
          mercariItemId: 'YUA-5', title: 'Yahoo差分なし', price: 6000, soldAt: '2026-03-01',
          status: 'completed', fee: 300,
        }],
        'yahoo',
      )
      const updated = await db.updateYahooActuals([
        { mercariItemId: 'YUA-5', soldAt: '2026-03-01', fee: 300, status: 'completed' },
      ])
      expect(updated).toBe(0)
    })

    it('updateYahooActuals：知らないmercariItemIdは無視する', async () => {
      const updated = await db.updateYahooActuals([
        { mercariItemId: 'does-not-exist', soldAt: '2026-03-01', status: 'completed' },
      ])
      expect(updated).toBe(0)
    })

    it('updateYahooActuals：切れたタイトルで入った販売に全文のタイトルが来たら直る', async () => {
      const [{ id }] = await db.insertCollected(
        [{
          mercariItemId: 'YTT-1', title: 'クリームわん新品未開封【Z07', price: 6000, soldAt: '2026-03-01',
          status: 'completed',
        }],
        'yahoo',
      )
      expect((await db.listSales()).find(s => s.id === id)!.title).toBe('クリームわん新品未開封【Z07')

      const updated = await db.updateYahooActuals([
        {
          mercariItemId: 'YTT-1', soldAt: '2026-03-01', status: 'completed',
          title: 'クリームわん新品未開封【Z074-4】',
        },
      ])
      expect(updated).toBe(1)
      expect((await db.listSales()).find(s => s.id === id)!.title).toBe('クリームわん新品未開封【Z074-4】')
    })

    it('updateYahooActuals：全文が入っているところに切れたタイトルが来ても上書きされない', async () => {
      const [{ id }] = await db.insertCollected(
        [{
          mercariItemId: 'YTT-2', title: 'クリームわん新品未開封【Z074-4】', price: 6000, soldAt: '2026-03-01',
          status: 'completed',
        }],
        'yahoo',
      )

      // 切れたタイトル（短い・prefix関係が逆）が来ても上書きしない。ただし fee が変わっている
      // ので更新自体は進む（title 以外の列は反映される）
      const updated = await db.updateYahooActuals([
        {
          mercariItemId: 'YTT-2', soldAt: '2026-03-01', status: 'completed', fee: 400,
          title: 'クリームわん新品未開封【Z07',
        },
      ])
      expect(updated).toBe(1)
      const after = (await db.listSales()).find(s => s.id === id)!
      expect(after.title).toBe('クリームわん新品未開封【Z074-4】')
      expect(after.fee).toBe(400)
    })

    it('updateYahooActuals：人が手で直したタイトルは上書きされない', async () => {
      const [{ id }] = await db.insertCollected(
        [{
          mercariItemId: 'YTT-3', title: 'クリームわん新品未開封【Z07', price: 6000, soldAt: '2026-03-01',
          status: 'completed',
        }],
        'yahoo',
      )
      // 人が手でタイトルを直す（updateSale経由）。以後は先頭が食い違うので収集の全文で上書きされない
      await db.updateSale(id, { title: '人が直したタイトル' })

      const updated = await db.updateYahooActuals([
        {
          mercariItemId: 'YTT-3', soldAt: '2026-03-01', status: 'completed', fee: 400,
          title: 'クリームわん新品未開封【Z074-4】',
        },
      ])
      expect(updated).toBe(1) // fee は変わるので更新自体は進む
      const after = (await db.listSales()).find(s => s.id === id)!
      expect(after.title).toBe('人が直したタイトル')
      expect(after.fee).toBe(400)
    })

    it('updateYahooActuals：タイトルが直ると型番が取れて自動紐付けの候補まで進む', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: 'クリームわん【Z074-4】', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]

      const [{ id }] = await db.insertCollected(
        [{
          mercariItemId: 'YTT-4', title: 'クリームわん新品未開封【Z07', price: 2000, soldAt: '2026-03-01',
          status: 'completed',
        }],
        'yahoo',
      )
      const before = (await db.listSales()).find(s => s.id === id)!
      expect(before.model_codes).toEqual([]) // 閉じ括弧が無いのでCODE_REに一致せず型番なし
      expect(before.unmatched).toBe(1)

      await db.updateYahooActuals([
        {
          mercariItemId: 'YTT-4', soldAt: '2026-03-01', status: 'completed',
          title: 'クリームわん新品未開封【Z074-4】',
        },
      ])

      const after = (await db.listSales()).find(s => s.id === id)!
      expect(after.model_codes).toEqual(['Z074-4'])
      expect(after.unmatched).toBe(0)
      expect(after.auto_linked).toBe(1)
      expect(after.cost).toBe(item.landed_cost)
    })

    it('updateCollectedActuals（メルカリ用。titleを渡さない）は今までどおり動く', async () => {
      const [{ id }] = await db.insertCollected(
        [{ mercariItemId: 'YTT-5', title: 'メルカリの取引', price: 3000, soldAt: '2026-03-01' }],
      )
      const updated = await db.updateCollectedActuals([
        { mercariItemId: 'YTT-5', soldAt: '2026-03-05', fee: 300 },
      ])
      expect(updated).toBe(1)
      const after = (await db.listSales()).find(s => s.id === id)!
      expect(after.title).toBe('メルカリの取引') // titleを渡していないので変わらない
      expect(after.fee).toBe(300)
      expect(after.status).toBe('completed')
    })

    describe('Yahoo!フリマの送料・取引完了・まとめ買い（updateYahooActuals / insertCollected）', () => {
      const expectedCount = async (id: string) =>
        (await db.sqlGet<{ expected_item_count: number | null }>('select expected_item_count from sale where id = ?', id))!
          .expected_item_count
      const saleLineCount = async (id: string) =>
        (await db.sqlGet<{ c: number }>('select count(*) as c from sale_line where sale_id = ?', id))!.c
      /** 粗利の式（価格－手数料－送料－梱包材－原価）を行の値から組み直す。sale_profit の gross_profit と一致する */
      const profitOf = async (id: string) => {
        const x = (await db.listSales()).find(v => v.id === id)!
        return x.price - x.fee - x.shipping_fee - x.packaging_cost - x.cost
      }
      const stockOne = async (code: string, qty = 1) => {
        await db.createPurchase({
          shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
          lines: [{ name: `在庫【${code}】`, unit_price: 1000, quantity: qty }],
        })
      }

      it('完了行（送料あり）：送料が実額（actual）で入り確定になり、status/completed_at/sold_atが取扱日になり、粗利が送料のぶん減る', async () => {
        await stockOne('Z074-4')
        const [{ id }] = await db.insertCollected(
          [{
            mercariItemId: 'YSH-1', title: 'クリームわん【Z074-4】', price: 6400, soldAt: '2026-03-01',
            fee: 320, status: 'shipped',
          }],
          'yahoo',
        )
        // 送料を入れる前（未完了・送料なし）
        const before = (await db.listSales()).find(s => s.id === id)!
        expect(before.item_count).toBe(1)
        expect(before.shipping_fee).toBe(0)
        expect(before.is_shipping_confirmed).toBe(0)
        expect(before.gross_profit).toBe(6400 - 320 - 0 - before.packaging_cost - 1000)
        const profitBefore = before.gross_profit

        const updated = await db.updateYahooActuals([
          {
            mercariItemId: 'YSH-1', soldAt: '2026-03-10', fee: 320, price: 6400,
            shippingFee: 490, status: 'completed',
          },
        ])
        expect(updated).toBe(1)

        const after = (await db.listSales()).find(s => s.id === id)!
        expect(after.shipping_fee).toBe(490)
        expect(after.shipping_source).toBe('actual')
        expect(after.is_shipping_confirmed).toBe(1)
        expect(after.status).toBe('completed')
        expect(after.completed_at).toBe('2026-03-10')
        expect(after.sold_at).toBe('2026-03-10')
        // 粗利（sale_profit）が送料のぶんだけ減る
        expect(after.gross_profit).toBe(profitBefore - 490)
        expect(after.gross_profit).toBe(await profitOf(id))
      })

      it('新規で入る完了行（送料あり）も、送料が実額で確定し、completed_at・sold_atが取扱日になる', async () => {
        const [{ id }] = await db.insertCollected(
          [{
            mercariItemId: 'YSH-2', title: '完了の新規【Z080-1】', price: 5000, soldAt: '2026-03-20',
            fee: 250, shippingFee: 700, status: 'completed',
          }],
          'yahoo',
        )
        const s = (await db.listSales()).find(x => x.id === id)!
        expect(s.shipping_fee).toBe(700)
        expect(s.shipping_source).toBe('actual')
        expect(s.is_shipping_confirmed).toBe(1)
        expect(s.completed_at).toBe('2026-03-20')
        expect(s.sold_at).toBe('2026-03-20')
      })

      it('未完了行（送料なし）は今までどおり：送料に触れず未確定のまま・sold_at/completed_atも動かない。送料0円でも確定にしない', async () => {
        const [{ id }] = await db.insertCollected(
          [{
            mercariItemId: 'YSH-3', title: '未完了【Z080-2】', price: 3000, soldAt: '2026-03-01',
            fee: 150, status: 'waiting_shipment',
          }],
          'yahoo',
        )
        // 送料なし（null）：③に送料の行が無い
        await db.updateYahooActuals([
          { mercariItemId: 'YSH-3', soldAt: '2026-03-05', fee: 150, shippingFee: null, status: 'shipped' },
        ])
        const a = (await db.listSales()).find(s => s.id === id)!
        expect(a.shipping_fee).toBe(0)
        expect(a.shipping_source).toBeNull()
        expect(a.is_shipping_confirmed).toBe(0)
        expect(a.status).toBe('shipped')
        expect(a.completed_at).toBeNull()
        expect(a.sold_at).toBe('2026-03-01')

        // 0円の送料は実額として記録するが、確定にはしない（メルカリ側と同じ規則）
        await db.updateYahooActuals([
          { mercariItemId: 'YSH-3', soldAt: '2026-03-05', fee: 150, shippingFee: 0, status: 'shipped' },
        ])
        const b = (await db.listSales()).find(s => s.id === id)!
        expect(b.shipping_fee).toBe(0)
        expect(b.is_shipping_confirmed).toBe(0)
      })

      it('送料の実額は、人が選んだ発送方法（master）を上書きして actual・確定にする（メルカリ側の applySaleActuals と同じ規則）', async () => {
        await db.saveShippingMethod({ name: 'テスト用ネコポス', fee: 210 })
        const method = (await db.listShippingMethods()).find(m => m.name === 'テスト用ネコポス')!
        const [{ id }] = await db.insertCollected(
          [{ mercariItemId: 'YSH-4', title: '発送方法あり【Z080-3】', price: 4000, soldAt: '2026-03-01', fee: 200, status: 'shipped' }],
          'yahoo',
        )
        await db.updateSale(id, { shipping_method_id: method.id })
        const picked = (await db.listSales()).find(s => s.id === id)!
        expect(picked.shipping_source).toBe('master')
        expect(picked.shipping_fee).toBe(210)

        await db.updateYahooActuals([
          { mercariItemId: 'YSH-4', soldAt: '2026-03-12', shippingFee: 490, status: 'completed' },
        ])
        const after = (await db.listSales()).find(s => s.id === id)!
        expect(after.shipping_fee).toBe(490)
        expect(after.shipping_source).toBe('actual')
        expect(after.is_shipping_confirmed).toBe(1)
      })

      it('2回取り込んでも二重にならない：同じ行を渡すと2回目は更新0件で、値も変わらない', async () => {
        const [{ id }] = await db.insertCollected(
          [{ mercariItemId: 'YSH-5', title: '二度目【Z080-4】', price: 6400, soldAt: '2026-03-01', fee: 320, status: 'shipped' }],
          'yahoo',
        )
        const row = {
          mercariItemId: 'YSH-5', soldAt: '2026-03-10', fee: 320, price: 6400,
          shippingFee: 490, status: 'completed' as const,
        }
        expect(await db.updateYahooActuals([row])).toBe(1)
        const first = (await db.listSales()).find(s => s.id === id)!
        expect(await db.updateYahooActuals([row])).toBe(0)
        const second = (await db.listSales()).find(s => s.id === id)!
        expect(second.shipping_fee).toBe(490)
        expect(second.gross_profit).toBe(first.gross_profit)
        expect((await db.listSales()).filter(x => x.mercari_item_id === 'YSH-5')).toHaveLength(1)
      })

      it('まとめ買い（新規）：点数が expected_item_count に入り（2 / 3）、在庫があっても sale_line は作られず未紐付けのまま', async () => {
        await stockOne('A037', 3)
        const [two] = await db.insertCollected(
          [{
            mercariItemId: 'YSB-1', title: '＜まとめ買い＞ Mellojoy 暮らし図鑑 【A037】 計2点', price: 10250, soldAt: '2026-03-01',
            fee: 0, status: 'shipped', bundleCount: 2,
          }],
          'yahoo',
        )
        const [three] = await db.insertCollected(
          [{
            mercariItemId: 'YSB-2', title: '＜まとめ買い＞ Mellojoy 暮らし図鑑 【A037】 計3点', price: 19500, soldAt: '2026-03-01',
            fee: 0, status: 'shipped', bundleCount: 3,
          }],
          'yahoo',
        )
        expect(await expectedCount(two.id)).toBe(2)
        expect(await expectedCount(three.id)).toBe(3)
        const s2 = (await db.listSales()).find(x => x.id === two.id)!
        expect(s2.kind).toBe('resale') // 型番があるので販売用。それでも自動では紐付けない
        expect(s2.model_codes).toEqual(['A037'])
        expect(await saleLineCount(two.id)).toBe(0)
        expect(await saleLineCount(three.id)).toBe(0)
        expect(s2.item_count).toBe(0)
        expect(s2.unmatched).toBe(1)
        expect(await db.sqlGet('select count(*) as c from sale_line')).toEqual({ c: 0 })
        // 一括の自動紐付け・型番の追記でも、まとめ買いは紐付かない
        expect(await db.autoLinkPending()).toBe(0)
        expect(await db.autoLinkSale(two.id)).toBe(false)
        expect(await saleLineCount(two.id)).toBe(0)
      })

      it('まとめ買い（既知）：updateYahooActuals で点数が入る。点数が null なら触らない。紐付け済みの sale_line には触らず、点数が足りなければ未紐付けに出る', async () => {
        await stockOne('A038', 2)
        const [{ id }] = await db.insertCollected(
          [{
            mercariItemId: 'YSB-3', title: '＜まとめ買い＞ 暮らし図鑑 【A038】 計', price: 8000, soldAt: '2026-03-01',
            fee: 0, status: 'shipped',
          }],
          'yahoo',
        )
        expect(await expectedCount(id)).toBeNull()
        expect(await saleLineCount(id)).toBe(0)

        // 点数が読めない（null）ときは触らない
        expect(await db.updateYahooActuals([
          { mercariItemId: 'YSB-3', soldAt: '2026-03-01', fee: 0, status: 'shipped', bundleCount: null },
        ])).toBe(0)
        expect(await expectedCount(id)).toBeNull()

        // 以前の版で 1 点だけ引き当ててしまった行（人の操作で作る）に点数が入る：sale_line は触らない
        const item = (await db.listInventory('in_stock'))[0]
        await db.linkInventoryAs(id, [item.id], 'auto')
        expect((await db.listSales()).find(x => x.id === id)!.unmatched).toBe(0)
        expect(await db.updateYahooActuals([
          { mercariItemId: 'YSB-3', soldAt: '2026-03-01', fee: 0, status: 'shipped', bundleCount: 2 },
        ])).toBe(1)
        expect(await expectedCount(id)).toBe(2)
        expect(await saleLineCount(id)).toBe(1)
        expect((await db.listSales()).find(x => x.id === id)!.unmatched).toBe(1) // 1 < 2 なので揃うまで要対応
        // 同じ点数をもう一度渡しても二重に更新しない
        expect(await db.updateYahooActuals([
          { mercariItemId: 'YSB-3', soldAt: '2026-03-01', fee: 0, status: 'shipped', bundleCount: 2 },
        ])).toBe(0)
      })

      it('まとめ買いでない行は今までどおり自動紐付けが効く（型番が1つで完全一致）', async () => {
        await stockOne('Z090-1')
        const [{ id }] = await db.insertCollected(
          [{
            mercariItemId: 'YSB-4', title: '普通の出品【Z090-1】', price: 3000, soldAt: '2026-03-01',
            fee: 150, status: 'shipped', bundleCount: null,
          }],
          'yahoo',
        )
        const s = (await db.listSales()).find(x => x.id === id)!
        expect(s.item_count).toBe(1)
        expect(s.unmatched).toBe(0)
        expect(s.auto_linked).toBe(1)
        expect(await saleLineCount(id)).toBe(1)
      })

      it('まとめ買いのタイトルが切れた→全文に直っても、型番の追記で自動紐付けまで進まない', async () => {
        await stockOne('A039', 2)
        const [{ id }] = await db.insertCollected(
          [{
            mercariItemId: 'YSB-5', title: '＜まとめ買い＞ 暮らし図鑑 【A039', price: 8000, soldAt: '2026-03-01',
            fee: 0, status: 'completed',
          }],
          'yahoo',
        )
        await db.updateYahooActuals([
          { mercariItemId: 'YSB-5', soldAt: '2026-03-01', status: 'completed', title: '＜まとめ買い＞ 暮らし図鑑 【A039】 計2点', bundleCount: 2 },
        ])
        const after = (await db.listSales()).find(x => x.id === id)!
        expect(after.model_codes).toEqual(['A039'])
        expect(after.item_count).toBe(0)
        expect(after.unmatched).toBe(1)
        expect(await expectedCount(id)).toBe(2)
      })
    })
  })

  describe('deleteSale：取り込んだ販売を削除すると除外記録（sale_exclusion）が残る', () => {
    it('source=collectorで削除するとlistSaleExclusionsに出て、removeSaleExclusionで解除できる', async () => {
      const [inserted] = await db.insertCollected([
        { mercariItemId: 'del-1', title: '削除される商品', price: 1000, soldAt: '2026-01-01' },
      ])
      await db.deleteSale(inserted.id)

      expect(await db.isMercariItemExcluded('del-1')).toBe(true)
      const list = await db.listSaleExclusions()
      expect(list.find(e => e.mercari_item_id === 'del-1')).toMatchObject({ title: '削除される商品' })

      await db.removeSaleExclusion('del-1')
      expect(await db.isMercariItemExcluded('del-1')).toBe(false)
      expect((await db.listSaleExclusions()).find(e => e.mercari_item_id === 'del-1')).toBeUndefined()
    })

    it('手入力（manual）の販売を削除しても除外記録は残らない', async () => {
      const saleId = await db.createSale({ title: '手入力の販売', sold_at: '2026-01-01', price: 1000 })
      await db.deleteSale(saleId)
      expect(await db.listSaleExclusions()).toHaveLength(0)
    })

    it('削除すると紐付いていた在庫は in_stock に戻る。同じ商品IDを2回削除しても除外記録は1件', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '戻る在庫【Z080-1】', unit_price: 1000, quantity: 1 }],
      })
      const [first] = await db.insertCollected([
        { mercariItemId: 'del-3', title: '戻る在庫【Z080-1】', price: 1000, soldAt: '2026-01-01' },
      ])
      expect(await db.listInventory('in_stock')).toHaveLength(0) // 自動確定で sold
      await db.deleteSale(first.id)
      expect(await db.listInventory('in_stock')).toHaveLength(1)

      // 解除せずに同じ商品IDが再び入って消えても、除外記録は 1 件のまま（上書き）
      await db.removeSaleExclusion('del-3')
      const [second] = await db.insertCollected([
        { mercariItemId: 'del-3', title: '戻る在庫【Z080-1】', price: 1000, soldAt: '2026-01-02' },
      ])
      await db.deleteSale(second.id)
      expect(await db.listSaleExclusions()).toHaveLength(1)
    })
  })

  describe('estimateSaleProfit：紐付けパネルの粗利見積もり（画面で再計算しないための共通計算）', () => {
    it('手数料・送料・梱包材費・原価から粗利を計算する。無効化した発送方法でも送料は引く', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '在庫X', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]

      await db.saveShippingMethod({ name: 'テスト送料', fee: 300 })
      const method = (await db.listShippingMethods()).find(m => m.name === 'テスト送料')!
      await db.deleteShippingMethod(method.id) // 無効化（is_active=0）にしても料金を引くことを確かめる

      const result = await db.estimateSaleProfit({
        price: 2000, shipping_method_id: method.id, packaging_cost: 50, inventory_item_ids: [item.id],
      })
      // fee_rate_bp既定1000(10%) → fee = floor(2000*1000/10000) = 200
      expect(result.fee).toBe(200)
      expect(result.shipping_fee).toBe(300)
      expect(result.packaging_cost).toBe(50)
      expect(result.cost).toBe(1000)
      expect(result.gross_profit).toBe(2000 - 200 - 300 - 50 - 1000)
    })

    it('発送方法なし・在庫指定なしなら送料・原価は0', async () => {
      const result = await db.estimateSaleProfit({ price: 1000, shipping_method_id: null, inventory_item_ids: [] })
      expect(result).toEqual({ fee: 100, shipping_fee: 0, packaging_cost: 0, cost: 0, gross_profit: 900 })
    })

    it('channel省略はmercari(10%)、channel:yahooはYahoo率(5%、実測どおり切り捨て)で計算する', async () => {
      const mercari = await db.estimateSaleProfit({ price: 6400, shipping_method_id: null, inventory_item_ids: [] })
      expect(mercari.fee).toBe(640) // floor(6400*1000/10000)

      // 実測：6,400円→320円（5%どおり）
      const yahoo = await db.estimateSaleProfit({
        price: 6400, shipping_method_id: null, inventory_item_ids: [], channel: 'yahoo',
      })
      expect(yahoo.fee).toBe(320)
    })

    it('feeに実額が渡ったら率を使わずそのまま返す（0も実額）', async () => {
      const result = await db.estimateSaleProfit({
        price: 6400, shipping_method_id: null, inventory_item_ids: [], channel: 'yahoo', fee: 320,
      })
      expect(result.fee).toBe(320)
      expect(result.gross_profit).toBe(6400 - 320)

      // 実測：5,200円→0円（キャンペーン）
      const zero = await db.estimateSaleProfit({
        price: 5200, shipping_method_id: null, inventory_item_ids: [], channel: 'yahoo', fee: 0,
      })
      expect(zero.fee).toBe(0)
      expect(zero.gross_profit).toBe(5200)
    })

    it('feeに負の額を渡すとthrow', async () => {
      await expect(db.estimateSaleProfit({
        price: 1000, shipping_method_id: null, inventory_item_ids: [], fee: -1,
      })).rejects.toThrow('手数料は整数で入力してください')
    })

    it('見積もりは保存しない（販売・手数料率を変えない）。同じ在庫を重複して渡しても原価は 1 回ぶん', async () => {
      await db.createPurchase({
        shop_account_id: shopId, ordered_at: '2026-01-01', shipping_fee: 0,
        lines: [{ name: '在庫X', unit_price: 1000, quantity: 1 }],
      })
      const item = (await db.listInventory('in_stock'))[0]
      const r = await db.estimateSaleProfit({ price: 2000, shipping_method_id: null, inventory_item_ids: [item.id, item.id] })
      expect(r.cost).toBe(1000)
      expect(await db.listSales()).toHaveLength(0)
      expect((await db.listInventory('in_stock')).map(i => i.id)).toEqual([item.id])
    })
  })

  describe('入力値チェック（assertYen/assertQty）：画面からの入口で整数以外はエラーになる', () => {
    it('createSale：価格が小数だとthrow', async () => {
      await expect(db.createSale({ title: '商品', sold_at: '2026-01-01', price: 100.5 }))
        .rejects.toThrow('価格は整数で入力してください')
    })

    it('updateSale：送料・梱包材費が小数だとthrow', async () => {
      const saleId = await db.createSale({ title: '商品', sold_at: '2026-01-01', price: 1000 })
      await expect(db.updateSale(saleId, { shipping_fee: 100.5 }))
        .rejects.toThrow('送料は整数で入力してください')
      await expect(db.updateSale(saleId, { packaging_cost: -1 }))
        .rejects.toThrow('梱包材費は整数で入力してください')
    })
  })

  describe('setSalePurchasedAt / salesNeedingPurchasedAt：取引画面の購入日時', () => {
    it('purchased_atを保存し、未完了ならsold_atの仮置きを購入日（日付部分）に直す', async () => {
      const [inserted] = await db.insertCollected([
        { mercariItemId: 'pa-1', title: '購入日時テスト', price: 1000, soldAt: '2026-08-01' },
      ])
      await db.setSalePurchasedAt(inserted.id, '2026-07-30T21:15')

      const s = (await db.listSales()).find(x => x.id === inserted.id)!
      expect(s.purchased_at).toBe('2026-07-30T21:15')
      expect(s.sold_at).toBe('2026-07-30') // 仮置き(2026-08-01)から購入日へ直る

      // 取引完了済みならsold_atは触らない
      await db.updateCollectedActuals([{ mercariItemId: 'pa-1', soldAt: '2026-08-05', fee: 100 }])
      await db.setSalePurchasedAt(inserted.id, '2026-07-29T10:00')
      expect((await db.listSales()).find(x => x.id === inserted.id)!.sold_at).toBe('2026-08-05')
    })

    it('purchased_atがnull（取れなかった）でもchecked扱いになり、salesNeedingPurchasedAtの対象から外れる', async () => {
      const [inserted] = await db.insertCollected([
        { mercariItemId: 'pa-2', title: '取れなかった商品', price: 1000, soldAt: '2026-08-01' },
      ])
      expect((await db.salesNeedingPurchasedAt(10)).map(r => r.mercari_item_id)).toEqual(['pa-2'])

      await db.setSalePurchasedAt(inserted.id, null)
      expect(await db.salesNeedingPurchasedAt(10)).toEqual([])
      expect((await db.listSales()).find(x => x.id === inserted.id)!.purchased_at).toBeNull()
    })

    it('購入日時は日本時間の素の文字列で返る（UTC の 15:00〜23:59 に当たる日本の 0〜9 時でも、日付が 1 日ずれない）', async () => {
      const [a, b, c] = await db.insertCollected([
        { mercariItemId: 'pa-3', title: '日本の朝', price: 1000, soldAt: '2026-08-01' },
        { mercariItemId: 'pa-4', title: '日本の深夜0時台', price: 1000, soldAt: '2026-08-01' },
        { mercariItemId: 'pa-5', title: '日付だけ', price: 1000, soldAt: '2026-08-01' },
      ])
      await db.setSalePurchasedAt(a.id, '2026-07-30T08:05') // UTC では 2026-07-29 23:05
      await db.setSalePurchasedAt(b.id, '2026-07-30T00:30') // UTC では 2026-07-29 15:30
      await db.setSalePurchasedAt(c.id, '2026-07-30') // 日付だけ＝その日の 0:00（日本時間）

      const sales = await db.listSales()
      expect(sales.find(s => s.id === a.id)!.purchased_at).toBe('2026-07-30T08:05')
      expect(sales.find(s => s.id === b.id)!.purchased_at).toBe('2026-07-30T00:30')
      expect(sales.find(s => s.id === c.id)!.purchased_at).toBe('2026-07-30T00:00')
      // 計上日の仮置きも、日本の暦日に直る
      expect(sales.find(s => s.id === a.id)!.sold_at).toBe('2026-07-30')
      expect(sales.find(s => s.id === b.id)!.sold_at).toBe('2026-07-30')
      // DB の中は timestamptz（UTC の絶対時刻）
      const raw = (await db.sqlGet<{ t: string }>(
        `select to_char(purchased_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as t from sale where id = ?`, b.id))!
      expect(raw.t).toBe('2026-07-29 15:30')
    })

    it('形の違う購入日時は断る（UserError）', async () => {
      const [a] = await db.insertCollected([{ mercariItemId: 'pa-6', title: '形が違う', price: 1000, soldAt: '2026-08-01' }])
      await expect(db.setSalePurchasedAt(a.id, '2026/07/30 21:15')).rejects.toThrow('購入日時はYYYY-MM-DDTHH:mmの形式で入力してください')
      await expect(db.setSalePurchasedAt(a.id, '2026-02-30T10:00')).rejects.toThrow('購入日時はYYYY-MM-DDの形式で入力してください')
    })
  })

  describe('収集が使う小さな問い合わせ', () => {
    it('existingMercariIds / saleMercariItemId：既存の商品IDだけ返す。取り込みでない販売の商品IDは null', async () => {
      const [a] = await db.insertCollected([
        { mercariItemId: 'ex-1', title: '既存1', price: 1000, soldAt: '2026-01-01' },
        { mercariItemId: 'ex-2', title: '既存2', price: 1000, soldAt: '2026-01-02' },
      ])
      const manual = await db.createSale({ title: '手入力', sold_at: '2026-01-03', price: 1000 })
      expect([...(await db.existingMercariIds(['ex-1', 'ex-2', 'ex-3']))].sort()).toEqual(['ex-1', 'ex-2'])
      expect((await db.existingMercariIds([])).size).toBe(0)
      expect(await db.saleMercariItemId(a.id)).toBe('ex-1')
      expect(await db.saleMercariItemId(manual)).toBeNull()
    })

    it('hoursSinceLastOk：未実行は Infinity。ok / empty の最新からの経過時間（failed・auth_required は数えない）', async () => {
      expect(await db.hoursSinceLastOk()).toBe(Infinity)
      await db.sqlRun(`insert into collector_run (started_at, status) values ('2026-10-12T08:00:00Z', 'ok')`)
      await db.sqlRun(`insert into collector_run (started_at, status) values ('2026-10-12T10:00:00Z', 'empty')`)
      await db.sqlRun(`insert into collector_run (started_at, status) values ('2026-10-12T11:00:00Z', 'failed')`)
      await db.sqlRun(`insert into collector_run (started_at, status) values ('2026-10-12T11:30:00Z', 'auth_required')`)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-12T12:30:00Z'))
      try {
        expect(await db.hoursSinceLastOk()).toBe(2.5)
      } finally {
        vi.useRealTimers()
      }
    })

    it('salesNeedingPurchasedAt：新しい順。上限で切る。手入力・商品IDなしは対象外', async () => {
      await db.insertCollected([
        { mercariItemId: 'np-1', title: '古い', price: 1000, soldAt: '2026-01-01' },
        { mercariItemId: 'np-2', title: '新しい', price: 1000, soldAt: '2026-03-01' },
        { mercariItemId: 'np-3', title: '真ん中', price: 1000, soldAt: '2026-02-01' },
      ])
      await db.createSale({ title: '手入力', sold_at: '2026-04-01', price: 1000, mercari_item_id: 'np-manual' })
      expect((await db.salesNeedingPurchasedAt(2)).map(r => r.mercari_item_id)).toEqual(['np-2', 'np-3'])
      expect((await db.salesNeedingPurchasedAt(10)).map(r => r.mercari_item_id)).toEqual(['np-2', 'np-3', 'np-1'])
    })
  })

  describe('salesNeedingThumb：サムネイルの差し替え判定', () => {
    it('(a)未保存は対象、(b)旧データ（thumb_srcが無い）はsrcだけ記録して対象外、(c)urlが変われば対象（クエリ違いは対象外）', async () => {
      const [, s2, s3] = await db.insertCollected([
        { mercariItemId: 'th-a', title: '未保存', price: 1000, soldAt: '2026-01-01' },
        { mercariItemId: 'th-b', title: '旧データ', price: 1000, soldAt: '2026-01-02' },
        { mercariItemId: 'th-c', title: '差し替え', price: 1000, soldAt: '2026-01-03' },
      ])
      // (b) 旧データ：thumb_pathはあるがthumb_srcが無い状態を再現
      await db.sqlRun('update sale set thumb_path = ? where id = ?', 'th-b.jpg', s2.id)
      // (c) 差し替え対象：既存のsrcと違うURL
      await db.setSaleThumb(s3.id, 'th-c-old.jpg', 'https://example.com/th-c-old.jpg')

      const targets = await db.salesNeedingThumb([
        { mercariItemId: 'th-a', thumbUrl: 'https://example.com/th-a.jpg' },
        { mercariItemId: 'th-b', thumbUrl: 'https://example.com/th-b.jpg?w=200' },
        { mercariItemId: 'th-c', thumbUrl: 'https://example.com/th-c-new.jpg' },
        { mercariItemId: 'th-none', thumbUrl: null },
      ])

      // (a)が先、(c)が後
      expect(targets.map(t => t.mercariItemId)).toEqual(['th-a', 'th-c'])

      // (b)は対象にせず、srcだけ記録される
      const row = (await db.sqlGet<{ thumb_src: string | null }>('select thumb_src from sale where id = ?', s2.id))!
      expect(row.thumb_src).toBe('https://example.com/th-b.jpg?w=200')

      // クエリは画像の更新時刻なので、クエリが変われば「変わった」（差し替え対象）
      const again = await db.salesNeedingThumb([
        { mercariItemId: 'th-b', thumbUrl: 'https://example.com/th-b.jpg?w=999' },
      ])
      expect(again.map(t => t.mercariItemId)).toEqual(['th-b'])
      // 同じ URL なら対象にならない
      expect(await db.salesNeedingThumb([
        { mercariItemId: 'th-b', thumbUrl: 'https://example.com/th-b.jpg?w=200' },
      ])).toEqual([])
    })

    it('setSaleThumb：対になる出品にも同じ画像を書く（売れる前後で同じ画像を共有）', async () => {
      await db.upsertListings([{ mercariItemId: 'th-l', title: '出品', price: 1000, suspended: false, thumbUrl: null }])
      const [s] = await db.insertCollected([{ mercariItemId: 'th-l', title: '出品', price: 1000, soldAt: '2026-01-01' }])
      await db.setSaleThumb(s.id, 'hh/sale/th-l.jpg', 'https://example.com/th-l.jpg')
      const l = (await db.listListings({ status: ['sold'] })).find(x => x.mercari_item_id === 'th-l')!
      expect(l.thumb_url).toBe(`${MEDIA}/hh/sale/th-l.jpg`)
    })
  })
})

describe('販売（sale）の引数の検査と世帯の分離', () => {
  const asA = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)
  const asB = <T>(fn: (ctx: Ctx) => Promise<T>) => w.b.run(fn)
  let saleA: string

  beforeEach(async () => {
    w = await newWorld(dom)
    saleA = await db.createSale({ title: '世帯Aの販売【A001】', sold_at: '2026-01-05', price: 2000 })
  })

  it('世帯 B からは A の販売が見えない・触れない（id を知っていても）', async () => {
    expect(await asB((c) => sale.listSales(c))).toEqual([])
    expect(await asB((c) => sale.saleTotals(c))).toMatchObject({ count: 0, revenue: 0 })
    await expect(asB((c) => sale.updateSale(c, saleA, { price: 1 }))).rejects.toThrow('販売が見つかりません')
    await expect(asB((c) => sale.setSaleTags(c, saleA, []))).rejects.toThrow('販売が見つかりません')
    expect(await asB((c) => sale.listSaleLines(c, saleA))).toEqual([])
    expect(await asB((c) => sale.getAutoLinkBlockers(c, saleA))).toEqual([])
    // 削除は何も起きない（見えない行は消せない）
    await asB((c) => sale.deleteSale(c, saleA))

    const after = (await db.listSales())[0]
    expect(after.id).toBe(saleA)
    expect(after.price).toBe(2000)
  })

  it('B の autoLinkPending は A の未紐付けの販売に触れない。A の在庫は B の販売には紐付かない', async () => {
    const shop = await db.createShopAccount('A')
    await db.createPurchase({
      shop_account_id: shop, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '世帯Aの在庫【A001】', unit_price: 1000, quantity: 1 }],
    })
    // B で同じ型番の販売を作っても、A の在庫は見えない
    const saleB = await asB((c) => sale.createSale(c, { title: '世帯Bの販売【A001】', sold_at: '2026-01-05', price: 2000 }))
    expect((await asB((c) => sale.listSales(c))).find(s => s.id === saleB)!.unmatched).toBe(1)
    expect(await asB((c) => sale.autoLinkPending(c))).toBe(0)
    // A の販売（createSale 時には在庫が無かった）は A の autoLinkPending で紐付く
    expect(await db.autoLinkPending()).toBe(1)
    expect((await db.listSales()).find(s => s.id === saleA)!.unmatched).toBe(0)
    // B の販売は A の在庫を奪っていない
    expect((await asB((c) => sale.listSales(c))).find(s => s.id === saleB)!.unmatched).toBe(1)
  })

  it('変な型の引数は UserError（500 にならない）', async () => {
    await expect(asA((c) => sale.createSale(c, 'x' as never))).rejects.toThrow('販売の形が正しくありません')
    await expect(asA((c) => sale.createSale(c, { title: 123, sold_at: '2026-01-01', price: 1 } as never))).rejects.toThrow('商品名は文字で入力してください')
    await expect(asA((c) => sale.createSale(c, { title: '  ', sold_at: '2026-01-01', price: 1 }))).rejects.toThrow('商品名を入力してください')
    await expect(asA((c) => sale.createSale(c, { title: 'x', sold_at: '2026/01/01', price: 1 }))).rejects.toThrow('販売日はYYYY-MM-DDの形式で入力してください')
    await expect(asA((c) => sale.createSale(c, { title: 'x', sold_at: '2026-02-30', price: 1 }))).rejects.toThrow('販売日はYYYY-MM-DDの形式で入力してください')
    await expect(asA((c) => sale.createSale(c, { title: 'x', sold_at: '2026-01-01', price: '100' as never }))).rejects.toThrow('価格は整数で入力してください')
    await expect(asA((c) => sale.createSale(c, { title: 'x', sold_at: '2026-01-01', price: 3_000_000_000 }))).rejects.toThrow('価格が大きすぎます')
    await expect(asA((c) => sale.createSale(c, { title: 'x', sold_at: '2026-01-01', price: 1, channel: 'amazon' as never }))).rejects.toThrow('出品先の値が正しくありません')
    await expect(asA((c) => sale.createSale(c, { title: 'x', sold_at: '2026-01-01', price: 1, kind: 'gift' as never }))).rejects.toThrow('区分の値が正しくありません')
    await expect(asA((c) => sale.updateSale(c, 'not-a-uuid', { price: 1 }))).rejects.toThrow('販売の指定が正しくありません')
    await expect(asA((c) => sale.updateSale(c, saleA, { sold_at: '昨日' }))).rejects.toThrow('販売日はYYYY-MM-DDの形式で入力してください')
    await expect(asA((c) => sale.updateSale(c, saleA, { shipping_method_id: 'x' }))).rejects.toThrow('発送方法の指定が正しくありません')
    await expect(asA((c) => sale.updateSale(c, saleA, { shipping_method_id: randomUUID() }))).rejects.toThrow('発送方法が見つかりません')
    await expect(asA((c) => sale.listSales(c, { month: '2026-13' }))).rejects.toThrow('月はYYYY-MMの形式で入力してください')
    await expect(asA((c) => sale.listSales(c, { kind: 'x' } as never))).rejects.toThrow('区分の値が正しくありません')
    await expect(asA((c) => sale.listSales(c, { tagId: 'x' }))).rejects.toThrow('タグの指定が正しくありません')
    await expect(asA((c) => sale.estimateSaleProfit(c, { price: 1.5, shipping_method_id: null, inventory_item_ids: [] }))).rejects.toThrow('価格は整数で入力してください')
    await expect(asA((c) => sale.estimateSaleProfit(c, { price: 1, shipping_method_id: null, inventory_item_ids: ['x'] }))).rejects.toThrow('在庫の指定が正しくありません')
    await expect(asA((c) => sale.autoLinkPending(c, ['x']))).rejects.toThrow('販売の指定が正しくありません')
    // 何も変わっていない
    expect(await db.listSales()).toHaveLength(1)
  })

  it('同じ商品IDの販売は 2 件作れない（日本語で断る）', async () => {
    await db.createSale({ title: '一件目', sold_at: '2026-01-05', price: 100, mercari_item_id: 'dup-1' })
    await expect(db.createSale({ title: '二件目', sold_at: '2026-01-05', price: 100, mercari_item_id: 'dup-1' }))
      .rejects.toThrow('その商品IDの販売はすでにあります')
    // 取り込みの方は DB の一意制約（API の入口で日本語に写る）。1 件目は壊れていない
    const err = await db.insertCollected([{ mercariItemId: 'dup-1', title: '三件目', price: 100, soldAt: '2026-01-05' }])
      .then(() => null, (e: unknown) => e)
    expect(err).not.toBeNull()
    expect(mapDbError(err)?.message).toBe('その商品IDの販売はすでにあります')
    expect(mapDbError(err)?.code).toBe('conflict')
    expect((await db.listSales()).filter(s => s.mercari_item_id === 'dup-1')).toHaveLength(1)
  })

  it('絞り込みの値は SQL に埋め込まれない（月・タグに SQL の断片を渡しても形の検査で断られる）', async () => {
    await expect(asA((c) => sale.listSales(c, { month: "2026-01' or '1'='1" }))).rejects.toThrow('月はYYYY-MMの形式で入力してください')
    await expect(asA((c) => sale.listSales(c, { tagId: "x' or '1'='1" }))).rejects.toThrow('タグの指定が正しくありません')
    const { where, vals } = sale.buildSaleFilterWhere({ month: '2026-02', kind: 'resale', onlyPending: true })
    expect(where).not.toContain('2026')
    expect(vals).toEqual(['2026-02-01', '2026-02-28', 'resale'])
    // 別名（SQL にそのまま入る唯一の値）は識別子の形だけ
    expect(() => sale.buildSaleFilterWhere({}, 'sp')).not.toThrow()
    expect(() => sale.buildSaleFilterWhere({}, 'sp; drop table sale')).toThrow('不正な別名です')
    expect(() => sale.saleProfitColumns('x y')).toThrow('不正な別名です')
  })

  it('月で絞る：その月の最後の日まで入る（2 月 28 日・うるう年の 29 日・31 日の月）。翌月の 1 日は入らない', async () => {
    await db.createSale({ title: 'a', sold_at: '2026-02-01', price: 100 })
    await db.createSale({ title: 'b', sold_at: '2026-02-28', price: 100 })
    await db.createSale({ title: 'c', sold_at: '2026-03-01', price: 100 })
    await db.createSale({ title: 'd', sold_at: '2028-02-29', price: 100 })
    await db.createSale({ title: 'e', sold_at: '2026-01-31', price: 100 })
    expect((await db.listSales({ month: '2026-02' })).map(s => s.title).sort()).toEqual(['a', 'b'])
    expect((await db.listSales({ month: '2028-02' })).map(s => s.title)).toEqual(['d'])
    // 1 月は beforeEach の販売（2026-01-05）と e（2026-01-31）。月末の 31 日が入る
    expect((await db.listSales({ month: '2026-01' })).map(s => s.title).sort()).toEqual(['e', '世帯Aの販売【A001】'])
  })

  it('API の入口（dispatch）経由：変な引数は 400 の日本語、他の世帯の販売は 404、正常は 200', async () => {
    const bad = await w.a.call('createSale', { title: 'x', sold_at: 'きのう', price: 1 })
    expect(bad.status).toBe(400)
    expect(bad.body.error?.message).toBe('販売日はYYYY-MM-DDの形式で入力してください')

    const foreign = await w.b.call('updateSale', saleA, { price: 1 })
    expect(foreign.status).toBe(404)
    expect(foreign.body.error?.message).toBe('販売が見つかりません')

    // 画面は filter の省略を null で送ってくる
    const list = await w.a.call('listSales', null)
    expect(list.status).toBe(200)
    expect((list.body.result as Array<{ id: string }>).map(s => s.id)).toEqual([saleA])

    const totals = await w.a.call('saleTotals', null)
    expect(totals.status).toBe(200)

    const created = await w.a.call('createSale', { title: 'API で作る', sold_at: '2026-02-01', price: 1000 })
    expect(created.status).toBe(200)
    expect(typeof created.body.result).toBe('string')

    // autoLinkPending: 省略（null）は全件、空配列は 0 件
    const all = await w.a.call('autoLinkPending', null)
    expect(all.status).toBe(200)
    const none = await w.a.call('autoLinkPending', [])
    expect(none.body.result).toBe(0)

    // 画面からは紐付けの種類（auto）を指定できない。常に manual で入る
    const shop = await db.createShopAccount('A')
    const [item] = await db.createPurchaseItems({
      shop_account_id: shop, ordered_at: '2026-01-01', shipping_fee: 0,
      lines: [{ name: '世帯Aの在庫', unit_price: 1000, quantity: 1 }],
    })
    const linked = await w.a.call('linkInventory', saleA, [item], { takeFromSale: false })
    expect(linked.status).toBe(200)
    expect((await db.sqlGet<{ link_source: string }>('select link_source from sale_line'))!.link_source).toBe('manual')
  })
})
