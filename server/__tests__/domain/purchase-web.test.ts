import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Ctx } from '../../context'
import { mapDbError } from '../../errors'
import { handlers } from '../../rpc'
import * as master from '../../domain/master'
import * as purchase from '../../domain/purchase'
import type { AllocMethod, PurchaseInput } from '../../../src/shared/types'
import { newWorld, openDomainDb, type DomainDb, type World } from './helpers'

// 仕入：Postgres で足すもの。
//   * 按分の合計一致（金額按分・数量按分・負の配賦）。仕入は原価の出どころ。1 円でもずれると全販売の粗利がずれる
//   * 世帯の分離（B から A の仕入が見えない・書けない・消せない）
//   * 引数の検査（変な型は UserError。500 にならない）
//   * API として登録されている（dispatch 経由）
//   * Postgres 固有の約束（同着の並び・同時登録の一意制約・integer の範囲）

let dom: DomainDb
let w: World

beforeAll(async () => {
  dom = await openDomainDb()
})

afterAll(async () => {
  await dom.close()
})

const A = <T>(fn: (ctx: Ctx) => Promise<T>) => w.a.run(fn)
const B = <T>(fn: (ctx: Ctx) => Promise<T>) => w.b.run(fn)

type LineIn = PurchaseInput['lines'][number]

async function shopOf(m: 'a' | 'b' = 'a'): Promise<string> {
  return w[m].run((c) => master.createShopAccount(c, `${m}の仕入先`))
}

async function create(shopId: string, input: Partial<PurchaseInput> & { lines: LineIn[] }, m: 'a' | 'b' = 'a'): Promise<string> {
  return w[m].run((c) => purchase.createPurchase(c, { shop_account_id: shopId, ordered_at: '2026-01-01', ...input }))
}

interface Allocated {
  lineAllocated: number[]
  lineUnitCost: number[]
  itemCosts: number[][]
  total: number
}

/** 仕入の明細・在庫を DB から読み、按分の結果を取り出す */
async function allocatedOf(purchaseId: string): Promise<Allocated> {
  return A(async (c) => {
    const lines = await c.sql.all<{ id: string; allocated_cost: number; landed_unit_cost: number }>(
      'select id, allocated_cost, landed_unit_cost from purchase_line where purchase_id = ? order by sort_order', purchaseId,
    )
    const itemCosts: number[][] = []
    for (const l of lines) {
      const items = await c.sql.all<{ landed_cost: number }>(
        'select landed_cost from inventory_item where purchase_line_id = ? order by created_at, item_code', l.id,
      )
      itemCosts.push(items.map(i => i.landed_cost))
    }
    return {
      lineAllocated: lines.map(l => l.allocated_cost),
      lineUnitCost: lines.map(l => l.landed_unit_cost),
      itemCosts,
      total: itemCosts.flat().reduce((s, v) => s + v, 0),
    }
  })
}

const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0)

beforeEach(async () => {
  w = await newWorld(dom)
})

// ============================================================
// 按分：合計は必ず一致する（端数は最終行・最後の点に寄る）
// ============================================================
describe('仕入：按分の合計一致', () => {
  /** 按分の約束を一式で確かめる（登録した金額と、DB に入った数字を突き合わせる） */
  async function expectConsistent(shopId: string, input: Omit<PurchaseInput, 'shop_account_id' | 'ordered_at'>) {
    const id = await create(shopId, input)
    const a = await allocatedOf(id)
    const subtotal = sum(input.lines.map(l => l.unit_price * l.quantity))
    const pool = (input.shipping_fee ?? 0) + (input.other_cost ?? 0) - (input.discount ?? 0)

    // ① 明細に配った合計 = 配賦対象（送料 + その他 − 割引）。端数で 1 円もずれない
    expect(sum(a.lineAllocated)).toBe(pool)
    // ② 在庫の按分後原価の合計 = 明細合計 + 配賦対象
    expect(a.total).toBe(subtotal + pool)
    // ③ 明細ごとにも、在庫の合計 = 単価 × 数量 + その明細に配った額
    input.lines.forEach((l, i) => {
      expect(a.itemCosts[i]).toHaveLength(l.quantity)
      expect(sum(a.itemCosts[i])).toBe(l.unit_price * l.quantity + a.lineAllocated[i])
      // 基準値 landed_unit_cost は切り捨て
      expect(a.lineUnitCost[i]).toBe(l.unit_price + Math.floor(a.lineAllocated[i] / l.quantity))
    })
    // ④ 画面に出す総原価（listPurchases / getPurchase）も同じ
    const summary = (await A((c) => purchase.listPurchases(c))).find(p => p.id === id)!
    expect(summary.subtotal).toBe(subtotal)
    expect(summary.total_cost).toBe(subtotal + pool)
    expect((await A((c) => purchase.getPurchase(c, id))).total_cost).toBe(subtotal + pool)
    return { id, a, subtotal, pool }
  }

  it('金額按分：送料 100 を 1000×3 の 1 行へ。1033 / 1033 / 1034（端数は最後の 1 点）', async () => {
    const shop = await shopOf()
    const { a } = await expectConsistent(shop, { shipping_fee: 100, lines: [{ name: 'A', unit_price: 1000, quantity: 3 }] })
    expect(a.itemCosts[0]).toEqual([1033, 1033, 1034])
  })

  it('金額按分：3 行で割り切れない。端数は最終行に寄る（合計は 1 円もずれない）', async () => {
    const shop = await shopOf()
    const { a } = await expectConsistent(shop, {
      shipping_fee: 1001,
      lines: [
        { name: 'A', unit_price: 333, quantity: 1 },
        { name: 'B', unit_price: 333, quantity: 1 },
        { name: 'C', unit_price: 334, quantity: 1 },
      ],
    })
    // 1001 × 333 / 1000 = 333.333 → 333（切り捨て）、2 行目も 333、最終行が残り 335
    expect(a.lineAllocated).toEqual([333, 333, 335])
  })

  it('数量按分：金額が違っても点数の比で配る。合計は一致する', async () => {
    const shop = await shopOf()
    const { a } = await expectConsistent(shop, {
      alloc_method: 'by_quantity',
      shipping_fee: 1000,
      other_cost: 7,
      lines: [
        { name: 'A', unit_price: 100, quantity: 1 },
        { name: 'B', unit_price: 9000, quantity: 3 },
        { name: 'C', unit_price: 50, quantity: 3 },
      ],
    })
    // 1007 を 1:3:3 に。1007×1/7=143.857→143、1007×3/7=431.571→431、最終行が残り 433
    expect(a.lineAllocated).toEqual([143, 431, 433])
  })

  it('負の配賦：割引が送料 + その他より大きくても、合計は割引後の金額に一致する（原価が 1 円もずれない）', async () => {
    const shop = await shopOf()
    // pool = 100 + 50 − 700 = −550
    const { a, pool } = await expectConsistent(shop, {
      shipping_fee: 100, other_cost: 50, discount: 700,
      lines: [
        { name: 'A', unit_price: 1000, quantity: 2 },
        { name: 'B', unit_price: 500, quantity: 3 },
        { name: 'C', unit_price: 333, quantity: 1 },
      ],
    })
    expect(pool).toBe(-550)
    expect(sum(a.lineAllocated)).toBe(-550)
    // 値引きは各行の値引きになる（行の符号が逆転して最終行だけが膨らむことはない）
    expect(a.lineAllocated.every(v => v <= 0)).toBe(true)
  })

  it('負の配賦：割引が商品合計より大きいと在庫の原価は負になる（デスクトップ版と同じ。合計は一致する）', async () => {
    const shop = await shopOf()
    await expectConsistent(shop, { discount: 500, lines: [{ name: 'A', unit_price: 100, quantity: 2 }] })
  })

  it('負の配賦・数量按分：pool = −2 を同額 4 行へ（四捨五入だと 1/1/1/−1 になる例）', async () => {
    const shop = await shopOf()
    const { a } = await expectConsistent(shop, {
      alloc_method: 'by_quantity', discount: 2,
      lines: [1, 2, 3, 4].map(n => ({ name: `L${n}`, unit_price: 100, quantity: 1 })),
    })
    // 0 方向に切り捨て → 0 / 0 / 0 / −2。符号は pool と同じ（最終行も正に転じない）
    expect(a.lineAllocated).toEqual([0, 0, 0, -2])
  })

  it('金額按分で全行 0 円なら、数量按分に切り替えて送料を配る（原価から抜け落ちない）', async () => {
    const shop = await shopOf()
    const { a } = await expectConsistent(shop, {
      shipping_fee: 90,
      lines: [{ name: 'A', unit_price: 0, quantity: 1 }, { name: 'B', unit_price: 0, quantity: 2 }],
    })
    expect(a.lineAllocated).toEqual([30, 60])
  })

  it('配賦対象が 0 なら全部 0。割引と送料が同額でも合計は商品合計', async () => {
    const shop = await shopOf()
    const { a } = await expectConsistent(shop, {
      shipping_fee: 300, discount: 300, lines: [{ name: 'A', unit_price: 1000, quantity: 3 }],
    })
    expect(a.lineAllocated).toEqual([0])
    expect(a.itemCosts[0]).toEqual([1000, 1000, 1000])
  })

  it('数量が多い行：1,001 円を 3 点へ。333 / 334 / 334（余りは末尾から 1 円ずつ）', async () => {
    const shop = await shopOf()
    const { a } = await expectConsistent(shop, { shipping_fee: 1001, lines: [{ name: 'A', unit_price: 0, quantity: 3 }] })
    expect(a.itemCosts[0]).toEqual([333, 334, 334])
  })

  it('金額が大きくても合計は一致する（単価 × 数量・明細合計が integer の 21 億を超えても一覧が壊れない）', async () => {
    const shop = await shopOf()
    // 10 億円 × 3 点 = 30 億（integer を超える）。1 点あたりの原価は integer に収まる。bigint で掛けないと一覧が溢れる
    const { subtotal } = await expectConsistent(shop, {
      shipping_fee: 999_999, other_cost: 1,
      lines: [{ name: 'A', unit_price: 1_000_000_000, quantity: 3 }, { name: 'B', unit_price: 1_500_000_000, quantity: 2 }],
    })
    expect(subtotal).toBe(6_000_000_000)
  })

  it.each<[string, AllocMethod]>([['金額按分', 'by_amount'], ['数量按分', 'by_quantity']])(
    '%s：乱数で 200 通り（行数・数量・単価・送料・その他・割引）。毎回、合計が 1 円も違わない', async (_name, method) => {
      const shop = await shopOf()
      // 毎回同じ並びになる疑似乱数（失敗したとき再現できるように）
      let seed = method === 'by_amount' ? 12345 : 67890
      const rnd = (max: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        return seed % (max + 1)
      }
      for (let n = 0; n < 200; n++) {
        const lineCount = 1 + rnd(4)
        const lines: LineIn[] = Array.from({ length: lineCount }, (_, i) => ({
          name: `L${i}`, unit_price: rnd(5) === 0 ? 0 : rnd(20_000), quantity: 1 + rnd(5),
        }))
        await expectConsistent(shop, {
          alloc_method: method, shipping_fee: rnd(3000), other_cost: rnd(500), discount: rnd(4000), lines,
        })
      }
      // 全体を並べて回すと 27 秒台（単独なら 7 秒）で、既定の 30 秒の上限にぎりぎりだった。ファイルが増えて負荷が少し増えると落ちるので、
      // このテストだけ上限を広げる（中身は変えていない）
    }, 120_000)

  it('確定済みの在庫の landed_cost は、仕入のメモを直しても・もう一度確定しようとしても動かない', async () => {
    const shop = await shopOf()
    const id = await create(shop, { shipping_fee: 101, lines: [{ name: 'A', unit_price: 1000, quantity: 3 }] })
    const before = await allocatedOf(id)
    await A((c) => purchase.updatePurchaseNote(c, id, '後からメモ'))
    await A((c) => purchase.setPurchaseFulfillment(c, id, 'delivered'))
    await expect(A((c) => purchase.confirmPurchase(c, id, {
      shop_account_id: shop, ordered_at: '2026-01-01', shipping_fee: 9999, lines: [{ name: 'A', unit_price: 1, quantity: 1 }],
    }))).rejects.toMatchObject({ code: 'conflict' })
    expect(await allocatedOf(id)).toEqual(before)
  })

  it('在庫コードは仕入ごとにまとめて連番で振られ、重ならない。在庫の並びは作った順', async () => {
    const shop = await shopOf()
    const id1 = await create(shop, { lines: [{ name: 'A', unit_price: 100, quantity: 3 }, { name: 'B', unit_price: 100, quantity: 2 }] })
    const id2 = await create(shop, { lines: [{ name: 'C', unit_price: 100, quantity: 2 }] })
    const codes = async (id: string) => A(async (c) => (await c.sql.all<{ item_code: string; name: string }>(
      `select i.item_code, i.name from inventory_item i join purchase_line pl on pl.id = i.purchase_line_id
        where pl.purchase_id = ? order by i.created_at`, id)).map(r => `${r.name}:${r.item_code}`))
    expect(await codes(id1)).toEqual(['A:S-0001', 'A:S-0002', 'A:S-0003', 'B:S-0004', 'B:S-0005'])
    expect(await codes(id2)).toEqual(['C:S-0006', 'C:S-0007'])
  })

  it('同じ日の仕入は、登録が新しい方が一覧の先頭（同じトランザクションで入れても同着にならない）', async () => {
    const shop = await shopOf()
    const [first, second] = await A(async (c) => {
      const a = await purchase.createPurchase(c, { shop_account_id: shop, ordered_at: '2026-01-01', lines: [{ name: '先', unit_price: 1, quantity: 1 }] })
      const b = await purchase.createPurchase(c, { shop_account_id: shop, ordered_at: '2026-01-01', lines: [{ name: '後', unit_price: 1, quantity: 1 }] })
      return [a, b]
    })
    expect((await A((c) => purchase.listPurchases(c))).map(p => p.id)).toEqual([second, first])
  })
})

// ============================================================
// 登録の細かい約束
// ============================================================
describe('仕入：登録の約束', () => {
  it('不正な入力は何も作らない（途中まで書いて残さない）。1 行目が正しくても 2 行目が不正なら全部断る', async () => {
    const shop = await shopOf()
    await expect(create(shop, {
      lines: [{ name: 'OK', unit_price: 100, quantity: 1 }, { name: 'NG', unit_price: 100, quantity: 0 }],
    })).rejects.toThrow('2行目の数量は1以上の整数で入力してください')
    expect(await A((c) => purchase.listPurchases(c))).toEqual([])
    expect(await A((c) => c.sql.all('select id from inventory_item'))).toEqual([])
  })

  it('型番は商品名から自動抽出する。手で指定した値（null を含む）が勝つ', async () => {
    const shop = await shopOf()
    const id = await create(shop, {
      lines: [
        { name: 'クリームわん【Z080-1】', unit_price: 100, quantity: 1 },
        { name: 'いちご【Z072-8】', unit_price: 100, quantity: 1, model_code: 'X1', series_code: 'X' },
        { name: 'シーソルト【Z001-4】', unit_price: 100, quantity: 1, model_code: null, series_code: null },
      ],
    })
    const d = await A((c) => purchase.getPurchase(c, id))
    expect(d.lines.map(l => [l.model_code, l.series_code])).toEqual([['Z080-1', 'Z080'], ['X1', 'X'], [null, null]])
    // 在庫にも同じ型番が入る
    const items = await A((c) => c.sql.all<{ model_code: string | null }>('select model_code from inventory_item order by created_at'))
    expect(items.map(i => i.model_code)).toEqual(['Z080-1', 'X1', null])
  })

  it('ordered_at は在庫の仕入日（acquired_at）になる。実在しない日付は断る', async () => {
    const shop = await shopOf()
    const id = await create(shop, { ordered_at: '2026-02-03', lines: [{ name: 'A', unit_price: 100, quantity: 1 }] })
    expect((await A((c) => purchase.getPurchase(c, id))).lines[0].items).toHaveLength(1)
    expect((await A((c) => c.sql.get<{ acquired_at: string }>('select acquired_at from inventory_item')))!.acquired_at).toBe('2026-02-03')
    await expect(create(shop, { ordered_at: '2026-02-30', lines: [{ name: 'A', unit_price: 100, quantity: 1 }] }))
      .rejects.toThrow('注文日はYYYY-MM-DDの形式で入力してください')
  })

  it('注文番号は前後の空白を除いて保存する。空白違いの重複も断る', async () => {
    const shop = await shopOf()
    const id = await create(shop, { order_no: '  ORD-9  ', lines: [{ name: 'A', unit_price: 100, quantity: 1 }] })
    expect((await A((c) => purchase.getPurchase(c, id))).order_no).toBe('ORD-9')
    await expect(create(shop, { order_no: 'ORD-9', lines: [{ name: 'B', unit_price: 100, quantity: 1 }] }))
      .rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('注文番号「ORD-9」') })
  })

  it('下書きの確定で、自分自身の注文番号とは重複しない。別の仕入と同じ注文番号なら断る', async () => {
    const shop = await shopOf()
    await create(shop, { order_no: 'TAKEN', lines: [{ name: 'X', unit_price: 100, quantity: 1 }] })
    const draft = await A((c) => purchase.createPurchaseDraft(c, {
      import_key: 'k1', shop_account_id: shop, ordered_at: '2026-01-01', order_no: 'MINE', lines: [{ name: 'D', quantity: 1 }],
    }))
    await expect(A((c) => purchase.confirmPurchase(c, draft, {
      shop_account_id: shop, ordered_at: '2026-01-01', order_no: 'TAKEN', lines: [{ name: 'D', unit_price: 100, quantity: 1 }],
    }))).rejects.toThrow('この仕入先には注文番号「TAKEN」の仕入が既にあります')
    // 失敗したので下書きのまま・在庫なし
    expect((await A((c) => purchase.getPurchase(c, draft))).status).toBe('draft')
    await A((c) => purchase.confirmPurchase(c, draft, {
      shop_account_id: shop, ordered_at: '2026-01-01', order_no: 'MINE', lines: [{ name: 'D', unit_price: 100, quantity: 1 }],
    }))
    expect((await A((c) => purchase.getPurchase(c, draft))).status).toBe('confirmed')
  })

  it('同時に同じ注文番号・同じ注文キーを入れた 2 本目（一意制約違反 23505）も、分かる日本語になる', async () => {
    const shop = await shopOf()
    await create(shop, { order_no: 'DUP', import_key: 'IK', lines: [{ name: 'A', unit_price: 100, quantity: 1 }] })
    const insert = (cols: string, vals: unknown[]) => A((c) => c.sql.run(
      `insert into purchase (shop_account_id, ordered_at, ${cols}) values (?, '2026-01-02', ${vals.map(() => '?').join(', ')})`, shop, ...vals,
    )).then(() => undefined, (e: unknown) => e)
    expect(mapDbError(await insert('order_no', ['DUP']))).toMatchObject({
      code: 'conflict', message: 'この仕入先には同じ注文番号の仕入が既にあります',
    })
    expect(mapDbError(await insert('import_key', ['IK']))).toMatchObject({
      code: 'conflict', message: '同じ注文が既に取り込まれています',
    })
  })

  it('上限：数量 1,000 点まで・1 回の仕入で合計 1,000 点まで・明細 200 行まで（桁違いの数量で DB を止めない）', async () => {
    const shop = await shopOf()
    await expect(create(shop, { lines: [{ name: 'A', unit_price: 1, quantity: 1001 }] })).rejects.toThrow('数量は1000以下')
    await expect(create(shop, { lines: [{ name: 'A', unit_price: 1, quantity: 2_000_000_000 }] })).rejects.toThrow('数量は1000以下')
    await expect(create(shop, { lines: [
      { name: 'A', unit_price: 1, quantity: 1000 }, { name: 'B', unit_price: 1, quantity: 1 },
    ] })).rejects.toThrow('合計1000点まで')
    await expect(create(shop, { lines: Array.from({ length: 201 }, (_, i) => ({ name: `L${i}`, unit_price: 1, quantity: 1 })) }))
      .rejects.toThrow('明細は200個以内')
    // ちょうど 1,000 点は通る
    const id = await create(shop, { lines: [{ name: 'A', unit_price: 1, quantity: 1000 }] })
    expect((await A((c) => purchase.getPurchase(c, id))).lines[0].items).toHaveLength(1000)
  })

  it('integer の範囲を超える原価は、半端に書かず「金額が大きすぎます」で断る', async () => {
    const shop = await shopOf()
    await expect(create(shop, { shipping_fee: 2_000_000_000, other_cost: 2_000_000_000, lines: [{ name: 'A', unit_price: 1, quantity: 1 }] }))
      .rejects.toThrow('金額が大きすぎます')
    await expect(create(shop, { shipping_fee: 3_000_000_000, lines: [{ name: 'A', unit_price: 1, quantity: 1 }] }))
      .rejects.toThrow()
    expect(await A((c) => purchase.listPurchases(c))).toEqual([])
  })

  it('画像の URL は http(s) だけ（後で PC が取りに行くため。file:// などは受けない）', async () => {
    const shop = await shopOf()
    await expect(create(shop, { lines: [{ name: 'A', unit_price: 1, quantity: 1, image_url: 'file:///etc/passwd' }] }))
      .rejects.toThrow('http か https')
    await expect(create(shop, { lines: [{ name: 'A', unit_price: 1, quantity: 1, image_url: 'javascript:alert(1)' }] }))
      .rejects.toThrow('http か https')
    await expect(create(shop, { lines: [{ name: 'A', unit_price: 1, quantity: 1, image_url: 'https://cdn.example/a.jpg' }] })).resolves.toBeTruthy()
  })

  it('importPurchases：失敗した 1 件は何も残さず巻き戻り、他の件は登録される。SQL のエラー文は理由に出ない', async () => {
    const shop = await shopOf()
    const ok = { shop_account_id: shop, ordered_at: '2026-01-01', lines: [{ name: 'OK', unit_price: 100, quantity: 2 }] }
    const result = await A((c) => purchase.importPurchases(c, [
      ok,
      // 2 行目で断られる（1 行目の分も残らない）
      { ...ok, lines: [{ name: 'A', unit_price: 100, quantity: 1 }, { name: 'B', unit_price: 100, quantity: 0 }] },
      { ...ok, shop_account_id: '00000000-0000-4000-8000-000000000001' },
      { ...ok, lines: 'x' as unknown as LineIn[] },
      null as unknown as PurchaseInput,
      { ...ok, ordered_at: '2026-01-02' },
    ]))
    expect(result.created).toBe(2)
    expect(result.skipped.map(s => s.index)).toEqual([1, 2, 3, 4])
    for (const s of result.skipped) {
      expect(s.reason).toBeTruthy()
      expect(s.reason).not.toMatch(/select|insert|violates|constraint/i)
    }
    expect(await A((c) => purchase.listPurchases(c))).toHaveLength(2)
    expect(await A((c) => c.sql.all('select id from inventory_item'))).toHaveLength(4)
    // 在庫コードは欠番なく続く（巻き戻った分の番号は戻る）
    const codes = (await A((c) => c.sql.all<{ item_code: string }>('select item_code from inventory_item order by item_code'))).map(r => r.item_code)
    expect(codes).toEqual(['S-0001', 'S-0002', 'S-0003', 'S-0004'])
  })

  it('importPurchases：同じ注文番号は仕入先ごとに見る（別の仕入先なら通る）。空の注文番号は見ない', async () => {
    const s1 = await shopOf()
    const s2 = await A((c) => master.createShopAccount(c, '別の仕入先'))
    const mk = (shop: string, orderNo: string | null): PurchaseInput => ({
      shop_account_id: shop, ordered_at: '2026-01-01', order_no: orderNo, lines: [{ name: 'A', unit_price: 1, quantity: 1 }],
    })
    const r = await A((c) => purchase.importPurchases(c, [mk(s1, 'X'), mk(s2, 'X'), mk(s1, 'X'), mk(s1, null), mk(s1, ''), mk(s1, '  ')]))
    expect(r.created).toBe(5)
    expect(r.skipped).toEqual([{ index: 2, reason: '同じCSVの中で注文番号「X」が重複しています' }])
  })

  it('importPurchases：1,000 件まで。空配列は 0 件', async () => {
    expect(await A((c) => purchase.importPurchases(c, []))).toEqual({ created: 0, skipped: [] })
    await expect(A((c) => purchase.importPurchases(c, new Array(1001).fill({})))).rejects.toThrow('1000個以内')
  })
})

// ============================================================
// 到着状態・追跡
// ============================================================
describe('仕入：到着状態・追跡の約束', () => {
  it('JST の日付で刻む：UTC 15:30（日本ではもう翌日）に shipped にすると、発送日は日本の翌日', () => {
    const now = new Date(Date.UTC(2026, 0, 31, 15, 30, 0))
    expect(purchase.initialFulfillmentDates('shipped', now)).toEqual({ shipped_at: '2026-02-01', delivered_at: null })
    expect(purchase.initialFulfillmentDates('delivered', now)).toEqual({ shipped_at: '2026-02-01', delivered_at: '2026-02-01' })
    expect(purchase.initialFulfillmentDates('pending', now)).toEqual({ shipped_at: null, delivered_at: null })
    expect(purchase.initialFulfillmentDates(null, now)).toEqual({ shipped_at: null, delivered_at: null })
  })

  it('applyTrackingResult：知らない状態・読めない日付は捨てる（推測で埋めない）。見た言葉と時刻だけ進む', async () => {
    const shop = await shopOf()
    const id = await create(shop, { fulfillment: 'shipped', lines: [{ name: 'A', unit_price: 1, quantity: 1 }] })
    const changed = await A((c) => purchase.applyTrackingResult(c, id, {
      status_text: '謎', fulfillment: 'teleported' as never, delivered_at: '2026-13-45',
    }))
    expect(changed).toBe(false)
    const d = await A((c) => purchase.getPurchase(c, id))
    expect(d.fulfillment).toBe('shipped')
    expect(d.delivered_at).toBeNull()
    expect(d.tracking_status).toBe('謎')
    expect(d.tracking_checked_at).not.toBeNull()
  })

  it('applyTrackingResult：到着日は配送会社の実際の日（気づいた日ではない）。すでに入っている日を null で消さない', async () => {
    const shop = await shopOf()
    const id = await create(shop, { fulfillment: 'shipped', lines: [{ name: 'A', unit_price: 1, quantity: 1 }] })
    await A((c) => purchase.applyTrackingResult(c, id, { status_text: '配達完了', fulfillment: 'delivered', delivered_at: '2026-03-03' }))
    await A((c) => purchase.applyTrackingResult(c, id, { status_text: '配達完了', fulfillment: 'delivered', delivered_at: null }))
    expect((await A((c) => purchase.getPurchase(c, id))).delivered_at).toBe('2026-03-03')
    // 配送会社が日付を訂正してきたら上書きする
    expect(await A((c) => purchase.applyTrackingResult(c, id, { status_text: '配達完了', fulfillment: 'delivered', delivered_at: '2026-03-02' }))).toBe(true)
    expect((await A((c) => purchase.getPurchase(c, id))).delivered_at).toBe('2026-03-02')
  })

  it('markTrackingRegistered：登録した最初の日時を保つ（二度目に付け直さない）。他の世帯の仕入には効かない', async () => {
    const shop = await shopOf()
    const id = await create(shop, { fulfillment: 'shipped', lines: [{ name: 'A', unit_price: 1, quantity: 1 }] })
    await A((c) => purchase.applyFulfillmentFromShop(c, id, { status: null, shipped_at: null, delivered_at: null, carrier: null, tracking_number: 'TRK' }))
    await A((c) => purchase.markTrackingRegistered(c, [id]))
    const first = (await A((c) => purchase.getPurchaseTracking(c, id)))!.tracking_registered_at
    await A((c) => c.sql.run(`update purchase set tracking_registered_at = tracking_registered_at - interval '1 day' where id = ?`, id))
    const backdated = (await A((c) => purchase.getPurchaseTracking(c, id)))!.tracking_registered_at
    await A((c) => purchase.markTrackingRegistered(c, [id]))
    expect((await A((c) => purchase.getPurchaseTracking(c, id)))!.tracking_registered_at).toBe(backdated)
    expect(first).not.toBe(backdated)
    // B が A の id で印を付けても何も起きない
    await A((c) => c.sql.run('update purchase set tracking_registered_at = null where id = ?', id))
    await B((c) => purchase.markTrackingRegistered(c, [id]))
    expect((await A((c) => purchase.getPurchaseTracking(c, id)))!.tracking_registered_at).toBeNull()
  })

  it('手動の到着状態は何にでも戻せるが、自動（一覧・注文詳細・17TRACK）は前に進む方向だけ', async () => {
    const shop = await shopOf()
    const id = await create(shop, { import_key: 'IK-1', lines: [{ name: 'A', unit_price: 1, quantity: 1 }] })
    await A((c) => purchase.setPurchaseFulfillment(c, id, 'delivered'))
    // 注文詳細（applyFulfillmentFromShop）の「配送中」で戻らない
    await A((c) => purchase.applyFulfillmentFromShop(c, id, { status: 'shipped', shipped_at: null, delivered_at: null, carrier: null, tracking_number: null }))
    expect((await A((c) => purchase.getPurchase(c, id))).fulfillment).toBe('delivered')
    // 注文一覧（updatePurchaseFulfillment）の「配送中」でも戻らない
    expect(await A((c) => purchase.updatePurchaseFulfillment(c, 'IK-1', 'shipped'))).toBe(false)
    // 17TRACK の「輸送中」でも戻らない
    await A((c) => purchase.applyTrackingResult(c, id, { status_text: '輸送中', fulfillment: 'shipped', delivered_at: null }))
    expect((await A((c) => purchase.getPurchase(c, id))).fulfillment).toBe('delivered')
    // 人は戻せる
    await A((c) => purchase.setPurchaseFulfillment(c, id, 'shipped'))
    expect((await A((c) => purchase.getPurchase(c, id))).fulfillment).toBe('shipped')
    await A((c) => purchase.setPurchaseFulfillment(c, id, null))
    expect((await A((c) => purchase.getPurchase(c, id))).fulfillment).toBeNull()
  })

  it('画像の保存先は、この世帯のフォルダの中だけ（他の世帯の画像・上位フォルダを指させない）', async () => {
    const shop = await shopOf()
    const id = await create(shop, { lines: [{ name: 'A', unit_price: 1, quantity: 1 }] })
    const lineId = (await A((c) => purchase.getPurchase(c, id))).lines[0].id
    const bad = [
      `${w.b.householdId}/purchase/x.jpg`, 'purchase/x.jpg', `${w.a.householdId}/../${w.b.householdId}/x.jpg`,
      `${w.a.householdId}//x.jpg`, `${w.a.householdId}/`, '',
    ]
    for (const path of bad) {
      await expect(A((c) => purchase.setPurchaseLineImage(c, lineId, path)), path).rejects.toMatchObject({ code: 'bad_request' })
    }
    await A((c) => purchase.setPurchaseLineImage(c, lineId, `${w.a.householdId}/purchase/x.jpg`))
  })
})

// ============================================================
// 世帯の分離
// ============================================================
describe('仕入：世帯の分離（B から A の仕入が見えない・書けない・消せない）', () => {
  it('B の一覧・検索・CSV・追跡の候補に A の仕入が出ない。id を知っていても読めない', async () => {
    const shopA = await shopOf('a')
    const id = await create(shopA, {
      order_no: 'A-ONLY', import_key: 'A-KEY', fulfillment: 'shipped', lines: [{ name: 'Aだけの商品【Z111】', unit_price: 1000, quantity: 2 }],
    })
    await A((c) => purchase.applyFulfillmentFromShop(c, id, { status: null, shipped_at: null, delivered_at: null, carrier: null, tracking_number: 'TRK-A' }))

    expect(await B((c) => purchase.listPurchases(c))).toEqual([])
    await expect(B((c) => purchase.getPurchase(c, id))).rejects.toMatchObject({ code: 'not_found' })
    expect(await B((c) => purchase.getPurchaseSummary(c, id))).toBeUndefined()
    expect(await B((c) => purchase.searchPurchaseHits(c, ['z111'], 15))).toEqual([])
    expect(await B((c) => purchase.exportPurchaseRows(c))).toBe('')
    expect(await B((c) => purchase.trackingRegisterCandidates(c))).toEqual([])
    expect(await B((c) => purchase.trackingCheckCandidates(c))).toEqual([])
    expect(await B((c) => purchase.trackingCounts(c))).toEqual({ unregistered: 0, watching: 0 })
    expect(await B((c) => purchase.getPurchaseTracking(c, id))).toBeNull()
    expect(await B((c) => purchase.getPurchaseTrackingNumber(c, id))).toBeNull()
    expect(await B((c) => purchase.existingImportKeys(c, ['A-KEY']))).toEqual(new Set())
    expect(await B((c) => purchase.purchaseLinesNeedingImage(c, id))).toEqual([])
    expect(await B((c) => purchase.loadPurchaseLineTexts(c, [id]))).toEqual(new Map())
    // A には見える
    expect(await A((c) => purchase.listPurchases(c))).toHaveLength(1)
  })

  it('B から A の仕入を変えられない：メモ・到着状態・タグ・確定・削除・追跡・画像のどれも A の行は動かない', async () => {
    const shopA = await shopOf('a')
    const id = await create(shopA, { import_key: 'A-KEY', lines: [{ name: 'A の商品', unit_price: 1000, quantity: 2 }] })
    const draft = await A((c) => purchase.createPurchaseDraft(c, { import_key: 'A-DRAFT', shop_account_id: shopA, ordered_at: '2026-01-01', lines: [{ name: 'D', quantity: 1 }] }))
    const tagA = await A((c) => master.createTag(c, 'Aのタグ'))
    const before = await A((c) => purchase.getPurchase(c, id))
    const lineId = before.lines[0].id
    const rows = () => A((c) => c.sql.all('select * from purchase order by id'))
    const snapshot = await rows()

    await expect(B((c) => purchase.updatePurchaseNote(c, id, '乗っ取り'))).rejects.toMatchObject({ code: 'not_found' })
    await expect(B((c) => purchase.setPurchaseFulfillment(c, id, 'delivered'))).rejects.toMatchObject({ code: 'not_found' })
    await expect(B((c) => purchase.setPurchaseTags(c, id, []))).rejects.toMatchObject({ code: 'not_found' })
    await expect(B((c) => purchase.confirmPurchase(c, draft, {
      shop_account_id: shopA, ordered_at: '2026-01-01', lines: [{ name: 'D', unit_price: 1, quantity: 1 }],
    }))).rejects.toMatchObject({ code: 'not_found' })
    await B((c) => purchase.deletePurchase(c, id)) // 何も消えない
    expect(await B((c) => purchase.updatePurchaseFulfillment(c, 'A-KEY', 'delivered'))).toBe(false)
    expect(await B((c) => purchase.applyFulfillmentFromShop(c, id, { status: 'delivered', shipped_at: '2026-01-01', delivered_at: '2026-01-02', carrier: 'X', tracking_number: 'Y' }))).toBe(false)
    expect(await B((c) => purchase.applyTrackingResult(c, id, { status_text: '配達完了', fulfillment: 'delivered', delivered_at: '2026-01-02' }))).toBe(false)
    await B((c) => purchase.setPurchaseImageChecked(c, id))
    await B((c) => purchase.setPurchaseLineImage(c, lineId, `${w.b.householdId}/purchase/x.jpg`))
    expect(await B((c) => purchase.setPurchaseLineImageUrls(c, id, [{ name: 'A の商品', image_url: 'https://x/y.jpg' }]))).toBe(0)

    // 自分の仕入に A のタグ・A の仕入先は結べない
    const shopB = await shopOf('b')
    const mine = await create(shopB, { lines: [{ name: 'B の商品', unit_price: 1, quantity: 1 }] }, 'b')
    await expect(B((c) => purchase.setPurchaseTags(c, mine, [tagA]))).rejects.toMatchObject({ code: 'not_found', message: 'タグが見つかりません' })
    await expect(create(shopA, { lines: [{ name: 'B から A の仕入先へ', unit_price: 1, quantity: 1 }] }, 'b'))
      .rejects.toMatchObject({ code: 'not_found', message: '仕入先が見つかりません' })
    await expect(B((c) => purchase.createPurchaseDraft(c, { import_key: 'X', shop_account_id: shopA, ordered_at: '2026-01-01', lines: [] })))
      .rejects.toMatchObject({ code: 'not_found' })
    await expect(B((c) => purchase.markMellojoyOrderExcluded(c, shopA, 'order', 'hash'))).rejects.toMatchObject({ code: 'not_found' })

    // A の行は 1 列も変わっていない
    expect(await rows()).toEqual(snapshot)
    expect(await A((c) => purchase.getPurchase(c, id))).toEqual(before)
    expect(await A((c) => c.sql.all('select order_key from mellojoy_excluded_order'))).toEqual([])
  })

  it('同じ注文番号・同じ注文キー・同じ店名の学習を A と B が別々に持てる（一意性は世帯の中だけ）', async () => {
    const shopA = await shopOf('a')
    const shopB = await shopOf('b')
    const input = { order_no: 'SAME', import_key: 'SAME-KEY', lines: [{ name: '商品', unit_price: 100, quantity: 1 }] }
    await create(shopA, input)
    await create(shopB, input, 'b')
    await A((c) => purchase.learnShopAlias(c, 'T1234567890123', 'A店'))
    await B((c) => purchase.learnShopAlias(c, 'T1234567890123', 'B店'))
    expect(await A((c) => purchase.lookupShopAlias(c, 'T1234567890123'))).toBe('A店')
    expect(await B((c) => purchase.lookupShopAlias(c, 'T1234567890123'))).toBe('B店')
    await A((c) => purchase.markMellojoyOrderExcluded(c, shopA, 'o', 'h'))
    expect(await B((c) => purchase.isMellojoyOrderExcluded(c, shopB, 'o', 'h'))).toBe(false)
    expect(await B((c) => purchase.isMellojoyOrderExcluded(c, shopA, 'o', 'h'))).toBe(false)
  })

  it('在庫コードの採番も世帯ごと：A と B の最初の仕入は、どちらも S-0001 から', async () => {
    const shopA = await shopOf('a')
    const shopB = await shopOf('b')
    await create(shopA, { lines: [{ name: 'A', unit_price: 1, quantity: 2 }] })
    await create(shopB, { lines: [{ name: 'B', unit_price: 1, quantity: 2 }] }, 'b')
    const codes = (m: 'a' | 'b') => w[m].run(async (c) => (await c.sql.all<{ item_code: string }>('select item_code from inventory_item order by item_code')).map(r => r.item_code))
    expect(await codes('a')).toEqual(['S-0001', 'S-0002'])
    expect(await codes('b')).toEqual(['S-0001', 'S-0002'])
  })

  it('仕入を消すと、明細・在庫・タグ・引き当ても消え、B の仕入は無事', async () => {
    const shopA = await shopOf('a')
    const shopB = await shopOf('b')
    const tag = await A((c) => master.createTag(c, 'T'))
    const id = await create(shopA, { lines: [{ name: 'A', unit_price: 1, quantity: 2 }] })
    await A((c) => purchase.setPurchaseTags(c, id, [tag]))
    const mine = await create(shopB, { lines: [{ name: 'B', unit_price: 1, quantity: 2 }] }, 'b')
    await A((c) => purchase.deletePurchase(c, id))
    for (const table of ['purchase', 'purchase_line', 'inventory_item', 'purchase_tag']) {
      expect(await A((c) => c.sql.all(`select 1 from ${table}`)), table).toEqual([])
    }
    expect((await B((c) => purchase.getPurchase(c, mine))).lines[0].items).toHaveLength(2)
  })
})

// ============================================================
// 引数の検査
// ============================================================
describe('仕入：引数の検査（変な型は UserError。500 にならない）', () => {
  const OK_ID = '00000000-0000-4000-8000-000000000009'

  it.each([
    ['getPurchase', ['not-a-uuid']],
    ['getPurchase', [null]],
    ['getPurchase', [{}]],
    ['getPurchase', [OK_ID]], // 無い仕入は 404
    ['createPurchase', [null]],
    ['createPurchase', ['x']],
    ['createPurchase', [[]]],
    ['createPurchase', [{}]],
    ['createPurchase', [{ shop_account_id: 5, ordered_at: '2026-01-01', lines: [] }]],
    ['createPurchase', [{ shop_account_id: OK_ID, ordered_at: '2026-01-01', lines: [{ name: 'a', unit_price: 1, quantity: 1 }] }]],
    ['importPurchases', ['x']],
    ['importPurchases', [{}]],
    ['importPurchases', [null]],
    ['confirmPurchase', ['bad', {}]],
    ['confirmPurchase', [OK_ID, null]],
    ['confirmPurchase', [OK_ID, {}]],
    ['updatePurchaseNote', ['bad', 'x']],
    ['updatePurchaseNote', [OK_ID, 5]],
    ['updatePurchaseNote', [OK_ID]],
    ['updatePurchaseFulfillment', ['bad', 'shipped']],
    ['updatePurchaseFulfillment', [OK_ID, 'teleported']],
    ['updatePurchaseFulfillment', [OK_ID, 3]],
    ['updatePurchaseFulfillment', [OK_ID]],
    ['deletePurchase', ['bad']],
    ['deletePurchase', [42]],
    ['setPurchaseTags', ['bad', []]],
    ['setPurchaseTags', [OK_ID, 'x']],
    ['setPurchaseTags', [OK_ID, ['bad']]],
    ['setPurchaseTags', [OK_ID, [OK_ID]]],
  ])('%s %j は 400/404 の日本語（サーバーエラーにならない）', async (method, args) => {
    const r = await w.a.call(method, ...args)
    expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400)
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(500)
    expect(r.body.error?.message).toBeTruthy()
    expect(r.body.error?.message).not.toContain('サーバーでエラー')
  })

  it('メモは 5,000 文字まで（長すぎれば 400）', async () => {
    const shop = await shopOf()
    const id = await create(shop, { lines: [{ name: 'A', unit_price: 1, quantity: 1 }] })
    await A((c) => purchase.updatePurchaseNote(c, id, 'あ'.repeat(5000)))
    const r = await w.a.call('updatePurchaseNote', id, 'あ'.repeat(5001))
    expect(r.status).toBe(400)
    expect(r.body.error?.message).toContain('5000文字以内')
  })

  it('変な値が混ざった仕入の入力：金額・数量・文字・配列の型違い、NaN、巨大な数、長すぎる文字', async () => {
    const shop = await shopOf()
    const line = { name: 'A', unit_price: 100, quantity: 1 }
    const base = { shop_account_id: shop, ordered_at: '2026-01-01', lines: [line] }
    const bad: unknown[] = [
      { ...base, shipping_fee: '100' },
      { ...base, shipping_fee: -1 },
      { ...base, shipping_fee: 1.5 },
      { ...base, shipping_fee: null, discount: 'x' },
      { ...base, other_cost: 3_000_000_000 },
      { ...base, alloc_method: 'by_weight' },
      { ...base, fulfillment: 'lost' },
      { ...base, note: 5 },
      { ...base, note: 'x'.repeat(5001) },
      { ...base, order_no: 'x'.repeat(201) },
      { ...base, order_no: 'a\u0000b' },
      { ...base, import_key: 5 },
      { ...base, lines: [null] },
      { ...base, lines: ['x'] },
      { ...base, lines: [{ ...line, name: 5 }] },
      { ...base, lines: [{ ...line, name: 'x'.repeat(501) }] },
      { ...base, lines: [{ ...line, unit_price: '100' }] },
      { ...base, lines: [{ ...line, unit_price: Number.NaN }] },
      { ...base, lines: [{ ...line, unit_price: Infinity }] },
      { ...base, lines: [{ ...line, unit_price: 3_000_000_000 }] },
      { ...base, lines: [{ ...line, quantity: 1.5 }] },
      { ...base, lines: [{ ...line, quantity: '1' }] },
      { ...base, lines: [{ ...line, model_code: 5 }] },
      { ...base, lines: [{ ...line, material: {} }] },
      { ...base, lines: [{ ...line, image_url: 5 }] },
    ]
    for (const input of bad) {
      const err = await A((c) => purchase.createPurchase(c, input as PurchaseInput)).then(() => undefined, (e: unknown) => e)
      expect(err, JSON.stringify(input)).toMatchObject({ name: 'UserError' })
    }
    expect(await A((c) => purchase.listPurchases(c))).toEqual([])
  })

  it('下書きの入力・追跡・画像の内部用の関数も、変な型で SQL まで届かない', async () => {
    const shop = await shopOf()
    const draft = (extra: Record<string, unknown>) => A((c) =>
      purchase.createPurchaseDraft(c, { import_key: 'k', shop_account_id: shop, ordered_at: '2026-01-01', lines: [], ...extra } as never))
    await expect(draft({ import_key: '' })).rejects.toMatchObject({ name: 'UserError' })
    await expect(draft({ import_key: 5 })).rejects.toMatchObject({ name: 'UserError' })
    await expect(draft({ ordered_at: '2026/01/01' })).rejects.toMatchObject({ name: 'UserError' })
    await expect(draft({ shipping_fee: -1 })).rejects.toMatchObject({ name: 'UserError' })
    await expect(draft({ lines: [{ name: 'a', quantity: 0 }] })).rejects.toMatchObject({ name: 'UserError' })
    await expect(draft({ lines: [{ name: 'a', quantity: 1, unit_price: 1.5 }] })).rejects.toMatchObject({ name: 'UserError' })
    await expect(draft({ fulfillment: 'x' })).rejects.toMatchObject({ name: 'UserError' })
    await expect(A((c) => purchase.updatePurchaseFulfillment(c, 5 as never, 'shipped'))).rejects.toMatchObject({ name: 'UserError' })
    await expect(A((c) => purchase.updatePurchaseFulfillment(c, 'k', 'x' as never))).rejects.toMatchObject({ name: 'UserError' })
    await expect(A((c) => purchase.applyFulfillmentFromShop(c, OK_ID, { status: 'x' } as never))).rejects.toMatchObject({ name: 'UserError' })
    await expect(A((c) => purchase.applyFulfillmentFromShop(c, OK_ID, { status: null, shipped_at: '2026-99-99' } as never))).rejects.toMatchObject({ name: 'UserError' })
    await expect(A((c) => purchase.markTrackingRegistered(c, ['bad']))).rejects.toMatchObject({ name: 'UserError' })
    await expect(A((c) => purchase.trackingCheckCandidates(c, -1))).rejects.toMatchObject({ name: 'UserError' })
    await expect(A((c) => purchase.trackingCheckCandidates(c, 1.5))).rejects.toMatchObject({ name: 'UserError' })
    await expect(A((c) => purchase.setPurchaseLineImageUrls(c, OK_ID, 'x' as never))).rejects.toMatchObject({ name: 'UserError' })
    await expect(A((c) => purchase.setPurchaseLineImageUrls(c, OK_ID, [{ name: 'a', image_url: 'ftp://x' }]))).rejects.toMatchObject({ name: 'UserError' })
    await expect(A((c) => purchase.learnShopAlias(c, 5 as never, 'x'))).rejects.toMatchObject({ name: 'UserError' })
    await expect(A((c) => purchase.existingImportKeys(c, 'x' as never))).rejects.toMatchObject({ name: 'UserError' })
    await expect(A((c) => purchase.exportPurchaseRows(c, '2026-13'))).rejects.toMatchObject({ name: 'UserError' })
    await expect(A((c) => purchase.markMellojoyOrderExcluded(c, 'bad', 'k', 'h'))).rejects.toMatchObject({ name: 'UserError' })
  })

  it('キーワードに一致しない明細の画像・注文詳細は対象にしない（空なら全部）', async () => {
    const shop = await shopOf()
    const id = await create(shop, {
      import_key: 'KW',
      lines: [
        { name: 'かわいいぬいぐるみ', unit_price: 1, quantity: 1, image_url: 'https://x/1.jpg' },
        { name: '関係ない文房具', unit_price: 1, quantity: 1, image_url: 'https://x/2.jpg' },
      ],
    })
    expect(await A((c) => purchase.purchaseLinesNeedingImage(c, id))).toHaveLength(2)
    expect((await A((c) => purchase.purchaseLinesNeedingImage(c, id, ['ぬいぐるみ']))).map(l => l.image_url)).toEqual(['https://x/1.jpg'])
    expect(await A((c) => purchase.purchaseDetailRevisitCandidates(c, shop, ['KW'], ['ぬいぐるみ']))).toHaveLength(1)
    expect(await A((c) => purchase.purchaseDetailRevisitCandidates(c, shop, ['KW'], ['存在しない語']))).toEqual([])
  })
})

// ============================================================
// API として登録されている（dispatch 経由）
// ============================================================
describe('仕入：API として登録されている（dispatch 経由）', () => {
  it('登録されているのは 9 本。収集・追跡の内部用（createPurchaseDraft ほか）・openTracking・checkTracking は登録しない', () => {
    for (const name of ['listPurchases', 'getPurchase', 'createPurchase', 'importPurchases', 'confirmPurchase',
      'updatePurchaseNote', 'updatePurchaseFulfillment', 'deletePurchase', 'setPurchaseTags'] as const) {
      expect(handlers[name], name).toBeTypeOf('function')
    }
    for (const name of ['openTracking', 'checkTracking', 'createPurchaseDraft', 'refetchPurchaseImages'] as const) {
      expect((handlers as Record<string, unknown>)[name], name).toBeUndefined()
    }
  })

  it('一通り呼べて、JSON の応答が返る。省略した引数は null で届いても動く', async () => {
    const shop = (await w.a.call('createShopAccount', 'API の仕入先', 'mellojoy')).body.result as string
    const created = await w.a.call('createPurchase', {
      shop_account_id: shop, ordered_at: '2026-05-01', shipping_fee: 100, order_no: null, note: null, import_key: null,
      lines: [{ name: 'API の商品【A001】', unit_price: 1000, quantity: 3, image_url: null, model_code: undefined }],
    })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const id = created.body.result as string
    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    const detail = (await w.a.call('getPurchase', id)).body.result as { total_cost: number; lines: Array<{ items: unknown[]; model_code: string }> }
    expect(detail.total_cost).toBe(3100)
    expect(detail.lines[0].items).toHaveLength(3)
    expect(detail.lines[0].model_code).toBe('A001')

    expect(((await w.a.call('listPurchases')).body.result as unknown[])).toHaveLength(1)
    expect((await w.a.call('updatePurchaseNote', id, 'メモ')).body).toEqual({ result: null })
    expect((await w.a.call('updatePurchaseNote', id, null)).body).toEqual({ result: null })
    expect((await w.a.call('updatePurchaseFulfillment', id, 'shipped')).body).toEqual({ result: null })
    expect((await w.a.call('updatePurchaseFulfillment', id, null)).body).toEqual({ result: null })
    const tag = (await w.a.call('createTag', 'API タグ')).body.result as string
    expect((await w.a.call('setPurchaseTags', id, [tag])).body).toEqual({ result: null })
    expect(((await w.a.call('getPurchase', id)).body.result as { tags: unknown[] }).tags).toHaveLength(1)

    const imported = await w.a.call('importPurchases', [
      { shop_account_id: shop, ordered_at: '2026-05-02', lines: [{ name: 'B', unit_price: 1, quantity: 1 }] },
      { shop_account_id: shop, ordered_at: '2026-05-02', lines: [] },
    ])
    expect(imported.body.result).toEqual({ created: 1, skipped: [{ index: 1, reason: '明細がありません' }] })

    // 確定済みの再確定は 409
    const again = await w.a.call('confirmPurchase', id, { shop_account_id: shop, ordered_at: '2026-05-01', lines: [{ name: 'x', unit_price: 1, quantity: 1 }] })
    expect(again.status).toBe(409)

    expect((await w.a.call('deletePurchase', id)).body).toEqual({ result: null })
    expect((await w.a.call('getPurchase', id)).status).toBe(404)
  })

  it('世帯が違えば別の帳簿（B の dispatch に A の仕入は出ない）', async () => {
    const shop = (await w.a.call('createShopAccount', 'A の仕入先')).body.result as string
    const id = (await w.a.call('createPurchase', { shop_account_id: shop, ordered_at: '2026-01-01', lines: [{ name: 'A', unit_price: 1, quantity: 1 }] })).body.result as string
    expect((await w.b.call('listPurchases')).body.result).toEqual([])
    expect((await w.b.call('getPurchase', id)).status).toBe(404)
    expect((await w.b.call('deletePurchase', id)).status).toBe(200) // 何も消えない
    expect(((await w.a.call('listPurchases')).body.result as unknown[])).toHaveLength(1)
  })

  it('下書き→確定が API 経由でも通り、仕入先のキーワード・自動タグが効く', async () => {
    const shop = (await w.a.call('createShopAccount', '自動タグの口座')).body.result as string
    const tag = (await w.a.call('createTag', '自動')).body.result as string
    await w.a.call('updateShopAccount', shop, { auto_tag_ids: [tag] })
    const draft = await A((c) => purchase.createPurchaseDraft(c, {
      import_key: 'api-draft', shop_account_id: shop, ordered_at: '2026-01-01', lines: [{ name: '下書き【Q123】', quantity: 2 }],
    }))
    const confirm = await w.a.call('confirmPurchase', draft, {
      shop_account_id: shop, ordered_at: '2026-01-01', shipping_fee: 5, lines: [{ name: '下書き【Q123】', unit_price: 100, quantity: 2 }],
    })
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200)
    const d = (await w.a.call('getPurchase', draft)).body.result as { status: string; total_cost: number; tags: Array<{ id: string }> }
    expect(d.status).toBe('confirmed')
    expect(d.total_cost).toBe(205)
    expect(d.tags.map(t => t.id)).toEqual([tag])
  })
})
