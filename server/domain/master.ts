import type { Ctx } from '../context'
import { UserError, describeError, registerDbErrorRule } from '../errors'
import { registerHandler } from '../rpc'
import type {
  CollectorRun, CollectorSource, RunStatus, ShippingMethod, ShopAccount, ShopAccountKind, ShopAccountStats, Tag,
} from '../../src/shared/types'
import {
  argEnum, argId, argIds, argInt, argNullableText, argNullableYen, argObject, argOptEnum, argOptFlag, argOptId,
  argOptInt, argOptText, argText, assertTagsExist, assertYen, loadTagsFor,
} from './_shared'

// ============================================================
// マスタ（タグ・仕入先アカウント・発送方法・設定）・収集の実行記録・画面の例外のログ
//
// src/main/db.ts の同名の関数の移植。
// 並びの `order by 名前 collate "C"` は、SQLite の既定（バイト順）と同じ並びにするため。
// ============================================================

// 同時に同じ名前のタグを作った 2 本目（上の存在確認をすり抜けたとき）も、同じ文言で断る
registerDbErrorRule({ code: '23505', constraint: 'tag_household_id_name_key', message: '同じ名前のタグがあります', as: 'conflict' })

const TAG_NAME_MAX = 100
const NAME_MAX = 100

// ------------------------------------------------------------
// タグ
//
// 仕入・販売・在庫に複数付けられる。名前は一意。消すと CASCADE で付いていた仕入・販売・在庫からも外れる。
// 仕入・在庫のタグは下流（在庫・販売）へ「派生」で見える（コピーしない）。
// ------------------------------------------------------------

export async function listTags(ctx: Ctx): Promise<Tag[]> {
  return ctx.sql.all<Tag>('select id, name, sort_order from tag order by sort_order, name collate "C"')
}

export async function createTag(ctx: Ctx, name: string): Promise<string> {
  const trimmed = argText('タグ名', name, { max: TAG_NAME_MAX }).trim()
  if (!trimmed) throw new UserError('タグ名を入力してください')

  const exists = await ctx.sql.get<{ id: string }>('select id from tag where name = ?', trimmed)
  if (exists) throw new UserError('同じ名前のタグがあります', 'conflict')

  const maxOrder = await ctx.sql.get<{ m: number }>('select coalesce(max(sort_order), -1) as m from tag')
  const row = await ctx.sql.get<{ id: string }>(
    'insert into tag (name, sort_order) values (?, ?) returning id', trimmed, (maxOrder?.m ?? -1) + 1,
  )
  return row!.id
}

export async function renameTag(ctx: Ctx, id: string, name: string): Promise<void> {
  const tagId = argId('タグ', id)
  const trimmed = argText('タグ名', name, { max: TAG_NAME_MAX }).trim()
  if (!trimmed) throw new UserError('タグ名を入力してください')

  const exists = await ctx.sql.get<{ id: string }>('select id from tag where name = ? and id <> ?', trimmed, tagId)
  if (exists) throw new UserError('同じ名前のタグがあります', 'conflict')

  const result = await ctx.sql.run('update tag set name = ? where id = ?', trimmed, tagId)
  if (result.changes === 0) throw new UserError('タグが見つかりません', 'not_found')
}

/** タグを消すと、付いていた仕入・販売・在庫からも CASCADE で外れる */
export async function deleteTag(ctx: Ctx, id: string): Promise<void> {
  await ctx.sql.run('delete from tag where id = ?', argId('タグ', id))
}

// ------------------------------------------------------------
// 仕入先アカウント
// ------------------------------------------------------------

const SHOP_ACCOUNT_KINDS: readonly ShopAccountKind[] = ['mellojoy', 'tiktok', 'other']
const KEYWORDS_MAX = 5000

// household_id・created_at は契約（ShopAccount）に無いので、列を選んで返す
const SHOP_ACCOUNT_COLUMNS = 'id, name, kind, note, is_active, import_keywords, default_shipping_fee'

export async function listShopAccounts(ctx: Ctx): Promise<ShopAccount[]> {
  const rows = await ctx.sql.all<Omit<ShopAccount, 'auto_tags'>>(
    `select ${SHOP_ACCOUNT_COLUMNS} from shop_account order by name collate "C", created_at, id`,
  )
  const tagMap = await loadTagsFor(ctx, 'shop_account_tag', 'shop_account_id', rows.map(r => r.id))
  return rows.map(r => ({ ...r, auto_tags: tagMap.get(r.id) ?? [] }))
}

/**
 * 仕入先ごとの累計（確定済みの仕入だけ。下書きは含めない）。
 * total_cost は listPurchases の total_cost（商品計＋送料＋その他−割引）の合計と一致する。
 * 仕入が0件の仕入先も0件・null で返す（LEFT JOIN）
 */
export async function listShopAccountStats(ctx: Ctx): Promise<ShopAccountStats[]> {
  // sum(bigint) は numeric（文字列）で返るので ::bigint に戻す。単価×数量は integer の範囲を超えうるので bigint で掛ける
  return ctx.sql.all<ShopAccountStats>(`
    select
      sa.id as shop_account_id,
      count(distinct p.id) as orders,
      coalesce(sum(pl.quantity), 0)::bigint as items,
      coalesce(sum(pl.unit_price::bigint * pl.quantity + pl.allocated_cost), 0)::bigint as total_cost,
      max(p.ordered_at) as last_ordered_at
    from shop_account sa
    left join purchase p on p.household_id = sa.household_id and p.shop_account_id = sa.id and p.status = 'confirmed'
    left join purchase_line pl on pl.household_id = p.household_id and pl.purchase_id = p.id
    group by sa.id
    order by sa.name collate "C", sa.created_at, sa.id
  `)
}

export async function createShopAccount(ctx: Ctx, name: string, kind: ShopAccountKind = 'other'): Promise<string> {
  const trimmed = argText('仕入先の名前', name, { max: NAME_MAX }).trim()
  if (!trimmed) throw new UserError('仕入先の名前を入力してください')
  const k = argOptEnum('仕入先の種類', kind, SHOP_ACCOUNT_KINDS) ?? 'other'
  const row = await ctx.sql.get<{ id: string }>('insert into shop_account (name, kind) values (?, ?) returning id', trimmed, k)
  return row!.id
}

/** 内部用（取り込みが仕入先のキーワード・自動タグを読む）。API には出さない */
export async function getShopAccount(ctx: Ctx, id: string): Promise<ShopAccount | undefined> {
  const accountId = argId('仕入先', id)
  const row = await ctx.sql.get<Omit<ShopAccount, 'auto_tags'>>(
    `select ${SHOP_ACCOUNT_COLUMNS} from shop_account where id = ?`, accountId,
  )
  if (!row) return undefined
  const tagMap = await loadTagsFor(ctx, 'shop_account_tag', 'shop_account_id', [accountId])
  return { ...row, auto_tags: tagMap.get(accountId) ?? [] }
}

export async function updateShopAccount(
  ctx: Ctx,
  id: string,
  patch: {
    name?: string; kind?: ShopAccountKind; is_active?: number; import_keywords?: string | null
    /** 置き換え（丸ごと入れ替え）。この口座の以後の仕入作成時にだけ効く（過去の仕入は変わらない） */
    auto_tag_ids?: string[]
    /** 手入力の仕入フォームで、この仕入先を選んだときに入る送料の既定値（円）。null で未設定に戻す */
    default_shipping_fee?: number | null
  },
): Promise<void> {
  const accountId = argId('仕入先', id)
  const p = argObject('仕入先の変更内容', patch)

  const sets: string[] = []
  const vals: unknown[] = []
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v) }

  const name = argOptText('仕入先の名前', p.name, { max: NAME_MAX })
  if (name !== undefined) {
    if (!name.trim()) throw new UserError('仕入先の名前を入力してください')
    put('name', name.trim())
  }
  const kind = argOptEnum('仕入先の種類', p.kind, SHOP_ACCOUNT_KINDS)
  if (kind !== undefined) put('kind', kind)
  const isActive = argOptFlag('有効', p.is_active)
  if (isActive !== undefined) put('is_active', isActive)
  const keywords = argNullableText('取り込みキーワード', p.import_keywords, { max: KEYWORDS_MAX })
  // 空・空白だけは null に丸める。中身があるときは入力のまま（前後の空白も）保存する
  if (keywords !== undefined) put('import_keywords', keywords !== null && keywords.trim() ? keywords : null)
  const fee = argNullableYen('送料', p.default_shipping_fee)
  if (fee !== undefined) put('default_shipping_fee', fee)
  const tagIds = p.auto_tag_ids === undefined || p.auto_tag_ids === null
    ? undefined
    : [...new Set(argIds('自動タグ', p.auto_tag_ids))]

  const exists = await ctx.sql.get<{ id: string }>('select id from shop_account where id = ?', accountId)
  if (!exists) throw new UserError('仕入先が見つかりません', 'not_found')
  if (tagIds) await assertTagsExist(ctx, tagIds)

  if (sets.length > 0) {
    await ctx.sql.run(`update shop_account set ${sets.join(', ')} where id = ?`, ...vals, accountId)
  }
  if (tagIds !== undefined) {
    await ctx.sql.run('delete from shop_account_tag where shop_account_id = ?', accountId)
    if (tagIds.length > 0) {
      await ctx.sql.run(
        'insert into shop_account_tag (shop_account_id, tag_id) select ?::uuid, t.tag_id from unnest(?::uuid[]) as t(tag_id)',
        accountId, tagIds,
      )
    }
  }
}

/**
 * 仕入で使われていたら消させない（無効化を促す）。無ければ物理削除。
 * デスクトップ版は消した後にログイン用のセッションも消していたが、Web ではセッションは PC のエージェント側にあるので、
 * ここは DB の削除だけ
 */
export async function deleteShopAccount(ctx: Ctx, id: string): Promise<void> {
  const accountId = argId('仕入先', id)
  const exists = await ctx.sql.get<{ id: string }>('select id from shop_account where id = ?', accountId)
  if (!exists) throw new UserError('仕入先が見つかりません', 'not_found')
  const used = await ctx.sql.get<{ c: number }>('select count(*) as c from purchase where shop_account_id = ?', accountId)
  if ((used?.c ?? 0) > 0) {
    throw new UserError('この仕入先は仕入で使われています。無効にしてください', 'conflict')
  }
  // 実行記録は残す（外部キーが張ってあるので先に外す）
  await ctx.sql.run('update collector_run set shop_account_id = null where shop_account_id = ?', accountId)
  await ctx.sql.run('delete from shop_account where id = ?', accountId)
}

/**
 * 仕入先アカウントの自動タグを、作成した仕入の purchase_tag に足す（作成時だけ。内部用で、仕入の作成が呼ぶ）。
 * 後から setPurchaseTags で外しても、ここでは再付与しない。
 */
export async function applyShopAccountAutoTags(ctx: Ctx, purchaseId: string, shopAccountId: string): Promise<void> {
  await ctx.sql.run(
    `insert into purchase_tag (purchase_id, tag_id)
     select ?::uuid, x.tag_id from shop_account_tag x where x.shop_account_id = ?::uuid
     on conflict do nothing`,
    argId('仕入', purchaseId), argId('仕入先', shopAccountId),
  )
}

// ------------------------------------------------------------
// 発送方法
// ------------------------------------------------------------

export async function listShippingMethods(ctx: Ctx): Promise<ShippingMethod[]> {
  return ctx.sql.all<ShippingMethod>(
    'select id, name, carrier, fee, sort_order, is_active from shipping_method where is_active = 1 order by sort_order, name collate "C", id',
  )
}

export async function saveShippingMethod(
  ctx: Ctx,
  m: Partial<ShippingMethod> & { name: string; fee: number },
): Promise<void> {
  const o = argObject('発送方法', m)
  assertYen('料金', o.fee)
  const name = argText('発送方法の名前', o.name, { max: NAME_MAX }).trim()
  if (!name) throw new UserError('発送方法の名前を入力してください')
  const id = argOptId('発送方法', o.id)
  const carrier = argNullableText('配送会社', o.carrier, { max: NAME_MAX }) ?? null
  const sortOrder = argOptInt('並び順', o.sort_order) ?? 0

  if (id) {
    const result = await ctx.sql.run(
      'update shipping_method set name = ?, carrier = ?, fee = ?, sort_order = ? where id = ?',
      name, carrier, o.fee, sortOrder, id,
    )
    if (result.changes === 0) throw new UserError('発送方法が見つかりません', 'not_found')
  } else {
    await ctx.sql.run(
      'insert into shipping_method (name, carrier, fee, sort_order) values (?, ?, ?, ?)', name, carrier, o.fee, sortOrder,
    )
  }
}

/** 消さずに無効にする（過去の販売が料金を引き続けられるように） */
export async function deleteShippingMethod(ctx: Ctx, id: string): Promise<void> {
  await ctx.sql.run('update shipping_method set is_active = 0 where id = ?', argId('発送方法', id))
}

// ------------------------------------------------------------
// 設定
//
// API キーは setting ではなく setting_secret に暗号化して持つ。万一 `*_enc` のキーが setting に入っていても、
// 画面には出さず、画面から書くこともさせない（デスクトップ版の handle('getSettings') と同じ）。
// ------------------------------------------------------------

const isSecretKey = (key: string) => /_enc$/i.test(key)

export async function getSettings(ctx: Ctx): Promise<Record<string, string>> {
  const rows = await ctx.sql.all<{ key: string; value: string }>('select key, value from setting')
  return Object.fromEntries(rows.filter(r => !isSecretKey(r.key)).map(r => [r.key, r.value]))
}

export async function setSetting(ctx: Ctx, key: string, value: string): Promise<void> {
  const k = argText('設定の名前', key, { max: 200 })
  if (!k.trim()) throw new UserError('設定の名前を入力してください')
  if (isSecretKey(k)) throw new UserError('この設定は画面から変えられません')
  const v = argText('設定の値', value, { max: 20000 })
  await ctx.sql.run(
    'insert into setting (key, value) values (?, ?) on conflict (household_id, key) do update set value = excluded.value',
    k, v,
  )
}

// ------------------------------------------------------------
// 収集の実行記録
// ------------------------------------------------------------

const RUN_SOURCES: readonly CollectorSource[] = ['mercari', 'mellojoy', 'yahoo']
const RUN_STATUSES: readonly RunStatus[] = ['ok', 'auth_required', 'failed', 'empty']
const RUN_MESSAGE_MAX = 2000

/** collector_run に shop_account_name を付けて返す共通の select。listRuns / finishRun で使う */
const RUN_SELECT = `
  select r.id, r.started_at, r.finished_at, r.status, r.fetched, r.inserted, r.message, r.source,
         r.shop_account_id, sa.name as shop_account_name
    from collector_run r
    left join shop_account sa on sa.household_id = r.household_id and sa.id = r.shop_account_id
`

/** 内部用。実行を始めた記録を作って id を返す。時刻は DB の時計（microsecond まで進むので、並びが安定する） */
export async function startRun(ctx: Ctx, source: CollectorSource, shopAccountId: string | null = null): Promise<string> {
  const s = argEnum('取り込み元', source, RUN_SOURCES)
  const accountId = shopAccountId == null ? null : argId('仕入先', shopAccountId)
  const row = await ctx.sql.get<{ id: string }>(
    'insert into collector_run (started_at, source, shop_account_id) values (clock_timestamp(), ?, ?) returning id', s, accountId,
  )
  return row!.id
}

/** 内部用。実行を終えた記録を書いて、仕入先の名前つきで返す */
export async function finishRun(
  ctx: Ctx, id: string, status: RunStatus, fetched: number, inserted: number, message?: string,
): Promise<CollectorRun> {
  const runId = argId('実行記録', id)
  const st = argEnum('状態', status, RUN_STATUSES)
  const f = argInt('取得数', fetched, { min: 0 })
  const i = argInt('登録数', inserted, { min: 0 })
  // 収集のエラーメッセージは長くなりうるので、保存では切り詰める（断らない）
  const text = typeof message === 'string' ? message.replace(/\u0000/g, '').slice(0, RUN_MESSAGE_MAX) : null
  const result = await ctx.sql.run(
    `update collector_run
        set finished_at = clock_timestamp(), status = ?, fetched = ?, inserted = ?, message = ?
      where id = ?`,
    st, f, i, text, runId,
  )
  if (result.changes === 0) throw new UserError('取り込みの記録が見つかりません', 'not_found')
  return (await ctx.sql.get<CollectorRun>(`${RUN_SELECT} where r.id = ?`, runId))!
}

export async function listRuns(ctx: Ctx, limit?: number): Promise<CollectorRun[]> {
  const n = argOptInt('件数', limit, { min: 1, max: 500 }) ?? 20
  return ctx.sql.all<CollectorRun>(`${RUN_SELECT} order by r.started_at desc, r.id desc limit ?`, n)
}

// ------------------------------------------------------------
// 画面の例外のログ（app_log）
//
// 操作ログ。14 日より古い行は書くたびに消す（溜め込まない。デスクトップ版は起動のたびに消していた）。
// 引数に API キーなどが入りうるので、payload は redact してから 2,000 文字で切る。
// 書けなくても画面の操作は止めない（savepoint の中で書き、失敗してもリクエストは成功させる）。
// ------------------------------------------------------------

const LOG_RETENTION_DAYS = 14
const LOG_SUMMARY_MAX_LEN = 2000
const LOG_KIND_MAX_LEN = 100
/** これを超える配列は中身を展開せず、件数だけ記す（ログが肥大化・重くなるのを防ぐ） */
const LARGE_ARRAY_THRESHOLD = 50
const LOG_MAX_DEPTH = 20
const SECRET_KEY_RE = /password|token|cookie|secret|api_?key|authorization/i

export async function logClient(ctx: Ctx, kind: string, message: string, payload?: unknown): Promise<void> {
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v : String(v ?? '')).replace(/\u0000/g, '').slice(0, max)
  try {
    await ctx.sql.tx(async (sql) => {
      await sql.run(`delete from app_log where ts < now() - make_interval(days => ${LOG_RETENTION_DAYS})`)
      await sql.run(
        `insert into app_log (source, kind, message, payload) values ('renderer', ?, ?, ?)`,
        text(kind, LOG_KIND_MAX_LEN), text(message, LOG_SUMMARY_MAX_LEN),
        payload === undefined || payload === null ? null : summarize(payload),
      )
    })
  } catch (e) {
    // エラーのオブジェクトは渡さない（SQL の引数＝画面から届いたログの中身が載る）
    console.error('操作ログの書き込みに失敗しました', describeError(e))
  }
}

/**
 * 値をJSONにして2,000文字で切る。巨大配列は中身を展開せず長さだけにする。
 * password / token / cookie / secret / api key / authorization を含むキーの値は '***' に伏せる。
 */
export function summarize(v: unknown): string {
  let text: string
  try {
    text = JSON.stringify(redact(v, 0)) ?? String(v)
  } catch (e) {
    text = `[summarize失敗: ${e instanceof Error ? e.message : String(e)}]`
  }
  return text.length > LOG_SUMMARY_MAX_LEN ? `${text.slice(0, LOG_SUMMARY_MAX_LEN)}…(省略)` : text
}

function redact(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    if (depth >= LOG_MAX_DEPTH) return '[深すぎます]'
    if (value.length > LARGE_ARRAY_THRESHOLD) return `<Array ${value.length}件>`
    return value.map(item => redact(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    if (depth >= LOG_MAX_DEPTH) return '[深すぎます]'
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '***' : redact(v, depth + 1)
    }
    return out
  }
  return value
}

// ------------------------------------------------------------
// API として出す
// ------------------------------------------------------------

registerHandler('listTags', (ctx) => listTags(ctx))
registerHandler('createTag', (ctx, name) => createTag(ctx, name))
registerHandler('renameTag', (ctx, id, name) => renameTag(ctx, id, name))
registerHandler('deleteTag', (ctx, id) => deleteTag(ctx, id))

registerHandler('listShopAccounts', (ctx) => listShopAccounts(ctx))
registerHandler('listShopAccountStats', (ctx) => listShopAccountStats(ctx))
registerHandler('createShopAccount', (ctx, name, kind) => createShopAccount(ctx, name, kind ?? undefined))
registerHandler('updateShopAccount', (ctx, id, patch) => updateShopAccount(ctx, id, patch))
registerHandler('deleteShopAccount', (ctx, id) => deleteShopAccount(ctx, id))

registerHandler('listShippingMethods', (ctx) => listShippingMethods(ctx))
registerHandler('saveShippingMethod', (ctx, m) => saveShippingMethod(ctx, m))
registerHandler('deleteShippingMethod', (ctx, id) => deleteShippingMethod(ctx, id))

registerHandler('getSettings', (ctx) => getSettings(ctx))
registerHandler('setSetting', (ctx, key, value) => setSetting(ctx, key, value))

registerHandler('listRuns', (ctx, limit) => listRuns(ctx, limit ?? undefined))
registerHandler('logClient', (ctx, kind, message, payload) => logClient(ctx, kind, message, payload))
