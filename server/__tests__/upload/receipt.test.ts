import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { attachReceiptPath, getMonthDetail, listExpenses } from '../../domain/monthly'
import { handlers } from '../../rpc'
import { subtractDaysJst, todayJst } from '../../domain/_shared'
import { spyConsole } from '../integrations/helpers'
import { openDomainDb, type DomainDb } from '../domain/helpers'
import {
  addExpense, ANON_KEY, expectedDraft, geminiError, geminiOk, json, newUploadWorld, readyDraft, receiptPath,
  saveGeminiKey, upload, type UploadMember, type UploadWorld,
} from './helpers'

// レシート（非公開バケット receipts）：付ける・付け替える・外す・経費を消す・一覧の receipt_url・AI で読む。
// 偽の Storage・Gemini の上で確かめる（本物には出ない）。

let db: DomainDb
let world: UploadWorld

beforeAll(async () => {
  db = await openDomainDb()
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  world = await newUploadWorld(db)
})

const pathOf = (id: string, who: UploadMember = world.a): Promise<string | null | undefined> =>
  world.run(who, async ctx => (await ctx.sql.get<{ receipt_path: string | null }>('select receipt_path from expense where id = ?', id))?.receipt_path)

const SIGNED = /^https:\/\/abcdefgh\.supabase\.test\/storage\/v1\/object\/sign\/receipts\/.+\?token=signed-\d+$/

describe('付ける・付け替える（attachReceiptPath）', () => {
  it('署名つき URL を返し、帳簿に結ぶ。付け替えたら前のレシートを Storage から消す（消すのは最後）', async () => {
    const id = await addExpense(world, world.a)
    const p1 = await upload(world, world.a, 'receipt')
    world.backend.calls.length = 0

    const r1 = await world.call(world.a, 'attachReceiptPath', id, p1)
    expect(r1.status).toBe(200)
    expect(r1.body.result).toMatch(SIGNED)
    expect(await pathOf(id)).toBe(p1)
    expect(world.backend.of('remove')).toEqual([]) // 前のレシートが無いので消すものは無い
    // 人の JWT と anon キーで呼んでいる
    expect(world.backend.calls[0]).toMatchObject({ kind: 'sign', bucket: 'receipts', apikey: ANON_KEY, authorization: `Bearer ${world.a.jwt}` })

    const p2 = await upload(world, world.a, 'receipt', 'png')
    world.backend.calls.length = 0
    const r2 = await world.call(world.a, 'attachReceiptPath', id, p2)
    expect(r2.status).toBe(200)
    expect(r2.body.result).toMatch(SIGNED)
    expect(await pathOf(id)).toBe(p2)
    expect(world.backend.calls.map(c => c.kind)).toEqual(['sign', 'remove']) // 署名（存在の確認）→ コミット → 消す
    expect(world.backend.of('remove')[0]).toMatchObject({ bucket: 'receipts', paths: [p1], authorization: `Bearer ${world.a.jwt}` })
    expect(world.backend.has('receipts', p1)).toBe(false)
    expect(world.backend.has('receipts', p2)).toBe(true)
  })

  it('同じパスをもう一度付けても、何も消えない', async () => {
    const id = await addExpense(world, world.a)
    const p = await upload(world, world.a, 'receipt')
    await world.call(world.a, 'attachReceiptPath', id, p)
    world.backend.calls.length = 0
    const again = await world.call(world.a, 'attachReceiptPath', id, p)
    expect(again.status).toBe(200)
    expect(again.body.result).toMatch(SIGNED)
    expect(world.backend.of('remove')).toEqual([])
    expect(world.backend.has('receipts', p)).toBe(true)
  })

  it('上げていない（Storage に無い）パスは付けない：404。帳簿は変わらず、前のレシートも消えない', async () => {
    const id = await addExpense(world, world.a)
    const p1 = await upload(world, world.a, 'receipt')
    await world.call(world.a, 'attachReceiptPath', id, p1)
    world.backend.calls.length = 0

    const spy = spyConsole()
    let r
    try {
      r = await world.call(world.a, 'attachReceiptPath', id, receiptPath(world.a)) // 形は正しいが上がっていない
    } finally {
      spy.restore()
    }
    expect(r.status).toBe(404)
    expect(r.body.error?.message).toBe('アップロードした画像が見つかりません。もう一度アップロードしてください')
    expect(await pathOf(id)).toBe(p1)
    expect(world.backend.of('remove')).toEqual([])
    expect(world.backend.has('receipts', p1)).toBe(true)
  })

  it('同じファイルを別の経費には付けられない（409）。付け替えようとした経費の前のレシートはそのまま', async () => {
    const e1 = await addExpense(world, world.a)
    const e2 = await addExpense(world, world.a)
    const p = await upload(world, world.a, 'receipt')
    await world.call(world.a, 'attachReceiptPath', e1, p)
    const r = await world.call(world.a, 'attachReceiptPath', e2, p)
    expect(r.status).toBe(409)
    expect(r.body.error?.message).toBe('このレシートはすでに別の経費に付いています')
    expect(await pathOf(e2)).toBeNull()
    expect(await pathOf(e1)).toBe(p)
  })

  it('経費が無ければ 404（Storage には触れない）。経費の id の形が違えば 400', async () => {
    const p = await upload(world, world.a, 'receipt')
    world.backend.calls.length = 0
    expect((await world.call(world.a, 'attachReceiptPath', randomUUID(), p)).status).toBe(404)
    expect((await world.call(world.a, 'attachReceiptPath', 'x', p)).status).toBe(400)
    expect((await world.call(world.a, 'attachReceiptPath', null, p)).status).toBe(400)
    expect(world.backend.calls).toEqual([])
  })

  it('保存先の設定（SUPABASE_ANON_KEY）やログインの JWT が無ければ付けない（日本語で断る。帳簿は変わらない）', async () => {
    const id = await addExpense(world, world.a)
    const p = await upload(world, world.a, 'receipt')
    for (const opts of [{ noAnon: true }, { noJwt: true }]) {
      await expect(world.run(world.a, ctx => attachReceiptPath(ctx, id, p), opts)).rejects.toMatchObject({
        message: expect.stringContaining('画像の保存先が使えません'),
      })
    }
    expect(await pathOf(id)).toBeNull()
  })

  it('巻き戻ったら前のレシートは消さない', async () => {
    const id = await addExpense(world, world.a)
    const p1 = await upload(world, world.a, 'receipt')
    const p2 = await upload(world, world.a, 'receipt')
    await world.call(world.a, 'attachReceiptPath', id, p1)
    world.backend.calls.length = 0

    await expect(world.run(world.a, async (ctx) => {
      await attachReceiptPath(ctx, id, p2)
      throw new Error('このあとで失敗')
    })).rejects.toThrow('このあとで失敗')
    expect(await pathOf(id)).toBe(p1)
    expect(world.backend.of('remove')).toEqual([])
    expect(world.backend.has('receipts', p1)).toBe(true)
  })

  it('消せなくても帳簿は巻き戻さない（付け替えは成功し、失敗はログだけ）', async () => {
    const id = await addExpense(world, world.a)
    const p1 = await upload(world, world.a, 'receipt')
    const p2 = await upload(world, world.a, 'receipt')
    await world.call(world.a, 'attachReceiptPath', id, p1)
    world.backend.failures.remove = 500
    const spy = spyConsole()
    let r
    try {
      r = await world.call(world.a, 'attachReceiptPath', id, p2)
    } finally {
      spy.restore()
    }
    expect(r.status).toBe(200)
    expect(await pathOf(id)).toBe(p2)
    expect(world.backend.has('receipts', p1)).toBe(true) // 残った（後で回収する）
    expect(spy.text()).toContain('後始末に失敗しました')
    expect(spy.text()).not.toContain(world.a.jwt)
  })
})

describe('外す（removeReceipt）・経費を消す（deleteExpense）', () => {
  it('外す：帳簿から外し、コミットの後に Storage から消す。付いていなければ何もしない', async () => {
    const id = await addExpense(world, world.a)
    const p = await upload(world, world.a, 'receipt')
    await world.call(world.a, 'attachReceiptPath', id, p)
    world.backend.calls.length = 0

    expect((await world.call(world.a, 'removeReceipt', id)).status).toBe(200)
    expect(await pathOf(id)).toBeNull()
    expect(world.backend.of('remove')).toHaveLength(1)
    expect(world.backend.has('receipts', p)).toBe(false)

    world.backend.calls.length = 0
    expect((await world.call(world.a, 'removeReceipt', id)).status).toBe(200)
    expect(world.backend.calls).toEqual([])
    expect((await world.call(world.a, 'removeReceipt', randomUUID())).status).toBe(404)
    expect((await world.call(world.a, 'removeReceipt', 'x')).status).toBe(400)
  })

  it('経費を消す：レシートがあれば Storage からも消す。無ければ Storage には触れない', async () => {
    const withReceipt = await addExpense(world, world.a)
    const without = await addExpense(world, world.a)
    const p = await upload(world, world.a, 'receipt')
    await world.call(world.a, 'attachReceiptPath', withReceipt, p)
    world.backend.calls.length = 0

    expect((await world.call(world.a, 'deleteExpense', without)).status).toBe(200)
    expect(world.backend.calls).toEqual([])
    expect((await world.call(world.a, 'deleteExpense', withReceipt)).status).toBe(200)
    expect(world.backend.of('remove')).toHaveLength(1)
    expect(world.backend.has('receipts', p)).toBe(false)
    expect(await pathOf(withReceipt)).toBeUndefined()
    // 無い経費を消しても失敗しない（デスクトップと同じ）
    expect((await world.call(world.a, 'deleteExpense', randomUUID())).status).toBe(200)
  })

  it('経費を消した後に Storage から消せなくても、経費は消えたまま（200）', async () => {
    const id = await addExpense(world, world.a)
    const p = await upload(world, world.a, 'receipt')
    await world.call(world.a, 'attachReceiptPath', id, p)
    world.backend.failures.remove = 'network'
    const spy = spyConsole()
    let r
    try {
      r = await world.call(world.a, 'deleteExpense', id)
    } finally {
      spy.restore()
    }
    expect(r.status).toBe(200)
    expect(await pathOf(id)).toBeUndefined()
    expect(world.backend.has('receipts', p)).toBe(true)
  })

  it('経費を消す処理が巻き戻ったら Storage のレシートは消さない', async () => {
    const id = await addExpense(world, world.a)
    const p = await upload(world, world.a, 'receipt')
    await world.call(world.a, 'attachReceiptPath', id, p)
    world.backend.calls.length = 0
    await expect(world.run(world.a, async (ctx) => {
      await handlers.deleteExpense!(ctx, id)
      throw new Error('巻き戻す')
    })).rejects.toThrow('巻き戻す')
    expect(await pathOf(id)).toBe(p)
    expect(world.backend.calls).toEqual([])
    expect(world.backend.has('receipts', p)).toBe(true)
  })
})

describe('createExpense / updateExpense の receipt_temp_file', () => {
  it('登録と同時に付く。同じファイルを 2 つの経費には付けられない', async () => {
    const p = await upload(world, world.a, 'receipt')
    const id = await addExpense(world, world.a, { receipt_temp_file: p })
    expect(await pathOf(id)).toBe(p)
    const dup = await world.call(world.a, 'createExpense', { occurred_at: '2026-09-10', category: 'other', amount: 1, receipt_temp_file: p })
    expect(dup.status).toBe(409)
    // 断られた経費は作られていない
    const n = await world.run(world.a, ctx => ctx.sql.get<{ c: number }>('select count(*) as c from expense'))
    expect(n?.c).toBe(1)
    // 空・null は「レシート無し」
    for (const empty of [null, '']) {
      const e = await addExpense(world, world.a, { receipt_temp_file: empty })
      expect(await pathOf(e)).toBeNull()
    }
  })

  it('更新：付け替えたら前のレシートを消す。receipt_temp_file が無い・同じ・検査で落ちたときは何も消さない', async () => {
    const p1 = await upload(world, world.a, 'receipt')
    const p2 = await upload(world, world.a, 'receipt')
    const id = await addExpense(world, world.a, { receipt_temp_file: p1 })
    const base = { occurred_at: '2026-09-10', category: 'packaging', amount: 880 }
    world.backend.calls.length = 0

    expect((await world.call(world.a, 'updateExpense', id, { ...base, note: 'メモだけ変える' })).status).toBe(200)
    expect((await world.call(world.a, 'updateExpense', id, { ...base, receipt_temp_file: p1 })).status).toBe(200)
    expect((await world.call(world.a, 'updateExpense', id, { ...base, amount: -1, receipt_temp_file: p2 })).status).toBe(400)
    expect(await pathOf(id)).toBe(p1)
    expect(world.backend.calls).toEqual([])

    expect((await world.call(world.a, 'updateExpense', id, { ...base, receipt_temp_file: p2 })).status).toBe(200)
    expect(await pathOf(id)).toBe(p2)
    expect(world.backend.of('remove').map(c => c.paths)).toEqual([[p1]])
    expect(world.backend.has('receipts', p1)).toBe(false)
    expect(world.backend.has('receipts', p2)).toBe(true)
  })
})

describe('一覧の receipt_url（署名つき URL・期限 1 時間）', () => {
  it('1 回の一覧で、署名は 1 回のまとめ。レシートの無い経費は null。DB のパスは画面に出さない', async () => {
    const p1 = await upload(world, world.a, 'receipt')
    const p2 = await upload(world, world.a, 'receipt')
    const e1 = await addExpense(world, world.a, { receipt_temp_file: p1 })
    const e2 = await addExpense(world, world.a, { receipt_temp_file: p2 })
    const e3 = await addExpense(world, world.a)
    world.backend.calls.length = 0

    const r = await world.call(world.a, 'listExpenses')
    expect(r.status).toBe(200)
    const byId = new Map((r.body.result as Array<Record<string, unknown>>).map(e => [e.id, e]))
    expect(byId.get(e1)!.receipt_url).toMatch(SIGNED)
    expect(byId.get(e2)!.receipt_url).toMatch(SIGNED)
    expect(byId.get(e3)!.receipt_url).toBeNull()
    expect(String(byId.get(e1)!.receipt_url)).toContain(p1)
    for (const e of byId.values()) expect(Object.keys(e)).not.toContain('receipt_path')

    expect(world.backend.calls.map(c => c.kind)).toEqual(['signMany'])
    const call = world.backend.calls[0]
    expect(new Set(call.paths)).toEqual(new Set([p1, p2]))
    expect(call.body).toMatchObject({ expiresIn: 3600 })
    expect(call).toMatchObject({ bucket: 'receipts', apikey: ANON_KEY, authorization: `Bearer ${world.a.jwt}` })
  })

  it('レシートが 1 つも無ければ通信しない。月の明細（getMonthDetail）の経費も同じ作り（まとめて 1 回）', async () => {
    await addExpense(world, world.a)
    world.backend.calls.length = 0
    await world.run(world.a, ctx => listExpenses(ctx))
    expect(world.backend.calls).toEqual([])

    const p = await upload(world, world.a, 'receipt')
    await addExpense(world, world.a, { receipt_temp_file: p })
    world.backend.calls.length = 0
    const detail = await world.run(world.a, ctx => getMonthDetail(ctx, '2026-09'))
    expect(detail.expenses.map(e => e.receipt_url).filter(Boolean)).toHaveLength(1)
    expect(world.backend.calls.map(c => c.kind)).toEqual(['signMany'])
  })

  it('署名できなくても一覧は返る：Storage の不調・保存先の設定なし・ログインの JWT なし・上がっていないファイル → その経費の receipt_url が null', async () => {
    const p = await upload(world, world.a, 'receipt')
    const gone = receiptPath(world.a) // 帳簿には結んだが Storage に無い
    const e1 = await addExpense(world, world.a, { receipt_temp_file: p })
    const e2 = await addExpense(world, world.a, { receipt_temp_file: gone })
    const urls = async (run: () => Promise<Array<{ id: string; receipt_url: string | null }>>) => new Map((await run()).map(e => [e.id, e.receipt_url]))
    const list = (opts?: { noJwt?: boolean; noAnon?: boolean }) => () => world.run(world.a, ctx => listExpenses(ctx), opts)

    const ok = await urls(list())
    expect(ok.get(e1)).toMatch(SIGNED)
    expect(ok.get(e2)).toBeNull() // 上がっていない 1 本だけ null

    const spy = spyConsole()
    try {
      world.backend.failures.signMany = 500
      const failed = await urls(list())
      expect([...failed.values()]).toEqual([null, null])
      world.backend.failures.signMany = 'network'
      expect([...(await urls(list())).values()]).toEqual([null, null])
      delete world.backend.failures.signMany
    } finally {
      spy.restore()
    }
    world.backend.calls.length = 0
    expect([...(await urls(list({ noAnon: true }))).values()]).toEqual([null, null])
    expect([...(await urls(list({ noJwt: true }))).values()]).toEqual([null, null])
    expect(world.backend.calls).toEqual([])
  })

  it('DB のパスが想定外の形でも（自分の世帯の receipt フォルダの外）署名しない。ほかの経費の署名は巻き込まない', async () => {
    const p = await upload(world, world.a, 'receipt')
    const good = await addExpense(world, world.a, { receipt_temp_file: p })
    const bad = await addExpense(world, world.a)
    await world.run(world.a, ctx => ctx.sql.run('update expense set receipt_path = ? where id = ?', `${world.b.householdId}/receipt/${randomUUID()}.jpg`, bad))
    world.backend.calls.length = 0
    const rows = await world.run(world.a, ctx => listExpenses(ctx))
    expect(rows.find(e => e.id === good)!.receipt_url).toMatch(SIGNED)
    expect(rows.find(e => e.id === bad)!.receipt_url).toBeNull()
    expect(world.backend.of('signMany')[0].paths).toEqual([p])
  })
})

describe('AI で読む（readReceiptAt・readReceipt）', () => {
  it('上げたレシートを読む：デスクトップと同じ下書き。temp_file は path のまま、receipt_url は署名つき。経費にはまだ付けない', async () => {
    const key = await saveGeminiKey(world, world.a)
    const payload = readyDraft()
    world.backend.gemini = () => geminiOk(payload)
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const p = await upload(world, world.a, 'receipt', 'jpg', bytes)
    world.backend.calls.length = 0

    const spy = spyConsole()
    let r
    try {
      r = await world.call(world.a, 'readReceiptAt', p)
    } finally {
      spy.restore()
    }
    expect(r.status).toBe(200)
    expect(r.body.result.temp_file).toBe(p)
    expect(r.body.result.receipt_url).toMatch(SIGNED)
    expect(r.body.result.draft).toEqual({ ...expectedDraft(), raw_text: JSON.stringify(payload) })

    // Storage → Gemini → 署名（人の JWT・anon キー）。Gemini は 1 回だけ。画像は Storage の中身そのまま（image/jpeg）
    expect(world.backend.calls.map(c => c.kind)).toEqual(['download', 'gemini', 'sign'])
    expect(world.backend.calls[0]).toMatchObject({ bucket: 'receipts', paths: [p], apikey: ANON_KEY, authorization: `Bearer ${world.a.jwt}` })
    const gemini = world.backend.calls[1]
    expect(gemini.model).toBe('gemini-flash-latest')
    expect(gemini.geminiKey).toBe(key) // DB に暗号化して持つ鍵を復号して使う
    const part = (gemini.body as { contents: Array<{ parts: Array<Record<string, any>> }> }).contents[0].parts
    expect(part[0].inline_data).toEqual({ mime_type: 'image/jpeg', data: Buffer.from(bytes).toString('base64') })
    expect(part[1].text).toContain('box_2d')

    // 読んだだけ：経費は増えない・何も付かない
    const n = await world.run(world.a, ctx => ctx.sql.get<{ c: number; r: number }>('select count(*) as c, count(receipt_path) as r from expense'))
    expect(n).toEqual({ c: 0, r: 0 })

    // 鍵・JWT・anon キーは応答にもログにも出ない
    for (const secret of [key, world.a.jwt, ANON_KEY]) {
      expect(r.text).not.toContain(secret)
      expect(spy.text()).not.toContain(secret)
    }
  })

  it('png・webp は MIME をそれぞれ送る。DB の ai_model があればそのモデルを使う', async () => {
    await saveGeminiKey(world, world.a)
    await world.call(world.a, 'setAiModel', 'gemini-2.5-pro')
    for (const [ext, mime] of [['png', 'image/png'], ['webp', 'image/webp']] as const) {
      const p = await upload(world, world.a, 'receipt', ext)
      world.backend.calls.length = 0
      const r = await world.call(world.a, 'readReceiptAt', p)
      expect(r.status).toBe(200)
      const gemini = world.backend.of('gemini')[0]
      expect(gemini.model).toBe('gemini-2.5-pro')
      expect((gemini.body as any).contents[0].parts[0].inline_data.mime_type).toBe(mime)
    }
  })

  it('Gemini と通信している間、DB のトランザクションを握らない（その間も別の問い合わせが通る）', async () => {
    await saveGeminiKey(world, world.a)
    const p = await upload(world, world.a, 'receipt')
    let during: string | undefined
    world.backend.gemini = async () => {
      // トランザクションが開いたままなら、PGlite は他の問い合わせを待たせて固まる（stuck になる）
      during = await Promise.race([
        db.root.get('select 1 as x').then(() => 'free'),
        new Promise<string>(resolve => setTimeout(() => resolve('stuck'), 1500)),
      ])
      return geminiOk(readyDraft())
    }
    const r = await world.call(world.a, 'readReceiptAt', p)
    expect(r.status).toBe(200)
    expect(during).toBe('free')
  })

  it('直接呼んでも（1 つの ctx の中で 3 段を続けて走らせる）同じ結果になる', async () => {
    await saveGeminiKey(world, world.a)
    const p = await upload(world, world.a, 'receipt')
    const read = await world.run(world.a, ctx => handlers.readReceiptAt!(ctx, p)) as { draft: unknown; temp_file: string }
    expect(read.temp_file).toBe(p)
    expect(read.draft).toEqual({ ...expectedDraft(), raw_text: JSON.stringify(readyDraft()) })
  })

  it('店名の学習（shop_alias）：登録番号が学習済みなら店名が入れ替わる。AI が番号を抜けなかったときは本文から拾う。学習は世帯ごと', async () => {
    await saveGeminiKey(world, world.a)
    const p = await upload(world, world.a, 'receipt')
    // A が「この登録番号＝この店名」を覚える
    await addExpense(world, world.a, { shop: '覚えた店 本店', receipt_registration_no: 'T1234567890123' })

    let r = await world.call(world.a, 'readReceiptAt', p)
    expect(r.body.result.draft).toMatchObject({ shop: '覚えた店 本店', shop_learned: true, registration_no: 'T1234567890123' })

    // 世帯 B には学習が見えない
    await saveGeminiKey(world, world.b)
    const pb = await upload(world, world.b, 'receipt')
    r = await world.call(world.b, 'readReceiptAt', pb)
    expect(r.body.result.draft).toMatchObject({ shop: 'ダイソー 川崎駅前店', shop_learned: false })

    // 番号が構造化された項目に無く、本文（応答のテキスト）にだけある
    world.backend.gemini = () => geminiOk(readyDraft({ registration_no: null, warnings: ['登録番号 T1234567890123 らしき記載'] }))
    r = await world.call(world.a, 'readReceiptAt', p)
    expect(r.body.result.draft).toMatchObject({ shop: '覚えた店 本店', shop_learned: true, registration_no: 'T1234567890123' })
    world.backend.gemini = () => geminiOk(readyDraft({ registration_no: null, warnings: ['T9876543210987 らしき記載'] }))
    r = await world.call(world.a, 'readReceiptAt', p)
    expect(r.body.result.draft).toMatchObject({ shop: 'ダイソー 川崎駅前店', shop_learned: false, registration_no: 'T9876543210987' })
    // 番号がどこにも無ければ、下書きはそのまま
    world.backend.gemini = () => geminiOk(readyDraft({ registration_no: null }))
    r = await world.call(world.a, 'readReceiptAt', p)
    expect(r.body.result.draft).toMatchObject({ registration_no: null, shop_learned: false })
  })

  it('日付は日本時間の今日まで（未来日・2020 年より前は null）', async () => {
    await saveGeminiKey(world, world.a)
    const p = await upload(world, world.a, 'receipt')
    const today = todayJst()
    const cases: Array<[string, string | null]> = [
      [today, today], [subtractDaysJst(today, 1), subtractDaysJst(today, 1)],
      [subtractDaysJst(today, -1), null], ['2019-12-31', null], ['2020-01-01', '2020-01-01'], ['令和7年9月1日', null],
    ]
    for (const [date, expected] of cases) {
      world.backend.gemini = () => geminiOk(readyDraft({ date }))
      const r = await world.call(world.a, 'readReceiptAt', p)
      expect(r.body.result.draft.occurred_at, date).toBe(expected)
    }
  })

  it('キーが無ければ「AI 読み取りの設定がありません」（デスクトップと同じ文）。Storage にも Gemini にも触れない', async () => {
    const p = await upload(world, world.a, 'receipt')
    world.backend.calls.length = 0
    const r = await world.call(world.a, 'readReceiptAt', p)
    expect(r.status).toBe(400)
    expect(r.body.error?.message).toBe('AI 読み取りの設定がありません（設定 → AI 読み取り）')
    expect(world.backend.calls).toEqual([])
    // 世帯 A のキーは B には使えない
    await saveGeminiKey(world, world.a)
    const pb = await upload(world, world.b, 'receipt')
    world.backend.calls.length = 0
    const rb = await world.call(world.b, 'readReceiptAt', pb)
    expect(rb.body.error?.message).toBe('AI 読み取りの設定がありません（設定 → AI 読み取り）')
    expect(world.backend.calls).toEqual([])
  })

  it('Gemini の失敗はデスクトップと同じ日本語（401・429・503 は 3 回試して諦める・壊れた応答）。キーは出ない', async () => {
    const key = await saveGeminiKey(world, world.a)
    const p = await upload(world, world.a, 'receipt')
    const spy = spyConsole()
    const messages: string[] = []
    try {
      const say = async (): Promise<string> => (await world.call(world.a, 'readReceiptAt', p)).body.error!.message

      world.backend.gemini = () => geminiError(401, 'Request had invalid authentication credentials.')
      messages.push(await say())
      expect(messages[0]).toContain('API キーが無効か、権限がありません')

      world.backend.gemini = () => geminiError(429, 'quota')
      messages.push(await say())
      expect(messages[1]).toContain('無料枠の上限に達しました')

      world.backend.sleeps.length = 0
      world.backend.calls.length = 0
      world.backend.gemini = () => geminiError(503, 'overloaded')
      messages.push(await say())
      expect(messages[2]).toContain('Gemini が混み合っています（503）')
      expect(world.backend.of('gemini')).toHaveLength(3)
      expect(world.backend.sleeps).toEqual([3000, 8000]) // 待ちはテストの sleep に渡る（本当には待たない）

      world.backend.gemini = () => json({ candidates: [{ content: { parts: [{ text: 'JSONではない' }] } }] })
      messages.push(await say())
      expect(messages[3]).toContain('AI の応答を読めませんでした')

      world.backend.gemini = () => json({ candidates: [{ content: {}, finishReason: 'MAX_TOKENS' }] })
      messages.push(await say())
      expect(messages[4]).toContain('モデルが考えすぎて本文が空でした')
    } finally {
      spy.restore()
    }
    for (const text of [...messages, spy.text()]) {
      expect(text).not.toContain(key)
      expect(text).not.toContain(world.a.jwt)
    }
  })

  it('Storage に無い・読めない形式・大きすぎる画像は、Gemini に送る前に日本語で断る', async () => {
    await saveGeminiKey(world, world.a)
    const missing = receiptPath(world.a)
    const spy = spyConsole()
    try {
      const r = await world.call(world.a, 'readReceiptAt', missing)
      expect(r.status).toBe(404)
      expect(r.body.error?.message).toBe('画像が見つかりません')

      const p = await upload(world, world.a, 'receipt')
      world.backend.put('receipts', p, new Uint8Array(10 * 1024 * 1024 + 1))
      const big = await world.call(world.a, 'readReceiptAt', p)
      expect(big.status).toBe(400)
      expect(big.body.error?.message).toBe('画像は 10MB までにしてください')
    } finally {
      spy.restore()
    }
    expect(world.backend.of('gemini')).toEqual([])
  })

  it('readReceipt：付いているレシートを読む（ReceiptDraft）。付いていなければデスクトップと同じ文。他の世帯の経費は 404 で何にも触れない', async () => {
    await saveGeminiKey(world, world.a)
    const p = await upload(world, world.a, 'receipt')
    const id = await addExpense(world, world.a, { receipt_temp_file: p })
    const none = await addExpense(world, world.a)

    const r = await world.call(world.a, 'readReceipt', id)
    expect(r.status).toBe(200)
    expect(r.body.result).toEqual({ ...expectedDraft(), raw_text: JSON.stringify(readyDraft()) })

    const noReceipt = await world.call(world.a, 'readReceipt', none)
    expect(noReceipt.status).toBe(400)
    expect(noReceipt.body.error?.message).toBe('レシートが添付されていません')

    await saveGeminiKey(world, world.b)
    world.backend.calls.length = 0
    const theirs = await world.call(world.b, 'readReceipt', id)
    expect(theirs.status).toBe(404)
    expect(world.backend.calls).toEqual([])
    expect((await world.call(world.a, 'readReceipt', randomUUID())).status).toBe(404)
    expect((await world.call(world.a, 'readReceipt', 'x')).status).toBe(400)
  })

  it('読めない形式（移行で入った HEIC など）は、デスクトップと同じ文で断る', async () => {
    await saveGeminiKey(world, world.a)
    const id = await addExpense(world, world.a)
    for (const [ext, message] of [
      ['heic', 'HEIC は読めません。JPEG か PNG にしてください'],
      ['gif', 'この画像の形式は読めません（JPEG・PNG・WebP のみ）'],
      ['bin', 'この画像の形式は読めません（JPEG・PNG・WebP のみ）'],
    ] as const) {
      const p = receiptPath(world.a, randomUUID(), ext)
      world.backend.put('receipts', p)
      await world.run(world.a, ctx => ctx.sql.run('update expense set receipt_path = ? where id = ?', p, id))
      const r = await world.call(world.a, 'readReceipt', id)
      expect(r.status, ext).toBe(400)
      expect(r.body.error?.message).toBe(message)
    }
    expect(world.backend.of('gemini')).toEqual([])
  })
})

describe('世帯の分離：世帯 B から A のレシートには触れない', () => {
  it('B は A の経費のレシートを外せない・付け替えられない・読めない・消せない。A の画像は無傷', async () => {
    await saveGeminiKey(world, world.b)
    const pa = await upload(world, world.a, 'receipt')
    const idA = await addExpense(world, world.a, { receipt_temp_file: pa })
    const pb = await upload(world, world.b, 'receipt')
    const idB = await addExpense(world, world.b)
    world.backend.calls.length = 0

    expect((await world.call(world.b, 'removeReceipt', idA)).status).toBe(404)
    expect((await world.call(world.b, 'attachReceiptPath', idA, pb)).status).toBe(404)
    expect((await world.call(world.b, 'readReceipt', idA)).status).toBe(404)
    expect((await world.call(world.b, 'updateExpense', idA, { occurred_at: '2026-09-10', category: 'other', amount: 1, receipt_temp_file: pb })).status).toBe(404)
    expect((await world.call(world.b, 'deleteExpense', idA)).status).toBe(200) // 見えないので何も消えない
    // B の経費に A のパスは結べない（形の検査で 400）。A の画像を読むことも
    expect((await world.call(world.b, 'attachReceiptPath', idB, pa)).status).toBe(400)
    expect((await world.call(world.b, 'readReceiptAt', pa)).status).toBe(400)
    expect((await world.call(world.b, 'createExpense', { occurred_at: '2026-09-10', category: 'other', amount: 1, receipt_temp_file: pa })).status).toBe(400)

    expect(await pathOf(idA, world.a)).toBe(pa)
    expect(world.backend.has('receipts', pa)).toBe(true)
    expect(world.backend.has('receipts', pb)).toBe(true) // B 自身のアップロードも消えていない
    expect(world.backend.of('remove')).toEqual([])
    expect(world.backend.of('gemini')).toEqual([])
    expect(world.backend.of('download').map(c => c.paths).flat()).not.toContain(pa)

    // B の一覧に A のレシートは出ない
    const list = await world.call(world.b, 'listExpenses')
    expect((list.body.result as Array<{ id: string }>).map(e => e.id)).toEqual([idB])
  })
})
