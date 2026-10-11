import type { Ctx } from '../context'
import { UserError, registerDbErrorRule } from '../errors'
import { registerHandler } from '../rpc'
import type {
  InventoryItem, InventoryPatch, InventoryStatus, LinkSource, SearchHit,
} from '../../src/shared/types'
import {
  argEnum, argId, argIds, argInt, argNullableText, argObject, argOptBool, argOptEnum, argOptInt, argOptObject,
  argText, assertTagsExist, extractItemCodes, matchesQuery, normalizeName, rowsToCsv, sortAndSlice, splitEvenly,
  todayJst,
} from './_shared'
import {
  attachInventoryTags, inventoryViewColumns, type InventoryRow,
} from './derive'

// ============================================================
// 在庫・紐付け（販売との sale_line）・候補
//
// src/main/db.ts の在庫まわりの移植。
// **紐付けを自動確定しない**（例外は sale.ts の autoLinkSale の 3 つだけ）。ここは「人が決めた」紐付けと候補の提示。
// 在庫の status は sale_line のトリガー（trg_sline_sold / trg_sline_unsold）が sold / in_stock に動かす。
// 出品の引き当て（listing_line）は在庫の状態を変えない（listing.ts）。
// ============================================================

// 同じ在庫を同時に 2 つの販売へ紐付けた 2 本目（確認をすり抜けたとき）も、日本語で断る
registerDbErrorRule({
  code: '23505', constraint: 'sale_line_household_id_inventory_item_id_key',
  message: 'その在庫はすでに別の販売に紐付いています', as: 'conflict',
})
// 在庫コードの採番が同時に重なった 2 本目（nextItemCode は行ロックで直列にするが、念のため）
registerDbErrorRule({
  code: '23505', constraint: 'inventory_item_household_id_item_code_key',
  message: '在庫コードが重なりました。もう一度お試しください', as: 'conflict',
})

const INVENTORY_STATUSES: readonly InventoryStatus[] = ['in_stock', 'sold', 'disposed', 'personal_use', 'split']
const LINK_SOURCES: readonly LinkSource[] = ['auto', 'manual', 'listing']
const NAME_MAX = 500
const NOTE_MAX = 5000
/** ばらして売る分割数の上限（1 点を 100 点超に割る使い方は想定しない。入力ミスで大量に作らせない） */
const SPLIT_MAX = 100

// ------------------------------------------------------------
// 在庫コード
// ------------------------------------------------------------

/**
 * 在庫コードを count 個まとめて発行する（setting.item_code_seq を +count）。形式は `S-0001`
 * （4桁ゼロ埋め。9999を超えたら桁が増える）。
 *
 * 開始番号は max(カウンタ, 既存コードの最大番号) から。カウンタが既存の item_code より
 * 後ろにずれている（手動でのDB編集・移行の取り込み等）場合でも、採番が既存コードと衝突しないようにするため。
 *
 * **採番は 1 本の UPDATE**（カウンタの行をロックする）。2 つの要求が同時に採番しても、後の方が前の
 * コミットを待ってから続きを取るので、同じ番号は出ない。呼び出し元のトランザクションの中で使うこと
 */
export async function nextItemCodes(ctx: Ctx, count: number): Promise<string[]> {
  if (!Number.isSafeInteger(count) || count < 1) throw new UserError('採番する数は1以上の整数にしてください')

  const bump = () => ctx.sql.get<{ value: string }>(`
    update setting
       set value = (
         greatest(
           case when value ~ '^[0-9]{1,15}$' then value::bigint else 0 end,
           coalesce((select max(substr(item_code, 3)::bigint) from inventory_item where item_code ~ '^S-[0-9]{1,15}$'), 0)
         ) + ?
       )::text
     where key = 'item_code_seq'
    returning value
  `, count)

  let row = await bump()
  if (!row) {
    // 世帯の初期データ（app.create_household）には入っているが、無ければここで作る
    await ctx.sql.run(`insert into setting (key, value) values ('item_code_seq', '0') on conflict (household_id, key) do nothing`)
    row = await bump()
  }
  const last = Number(row!.value)
  return Array.from({ length: count }, (_, i) => `S-${String(last - count + 1 + i).padStart(4, '0')}`)
}

/** 在庫コードを 1 つ発行する。まとめて要るなら nextItemCodes */
export async function nextItemCode(ctx: Ctx): Promise<string> {
  return (await nextItemCodes(ctx, 1))[0]
}

// ------------------------------------------------------------
// 紐付け
//
// 自動確定しない。誤紐付けは原価を壊し、しかも気づきにくい。
// 例外は sale.ts の autoLinkSale（型番の完全一致・在庫コードの名指し・出品の引き継ぎ）だけ。
// それ以外は suggestInventory が候補を返すだけで、確定は人間が行う。
// ------------------------------------------------------------

/**
 * 販売に在庫を紐付ける。タグはコピーしない（派生で見える。SaleProfit.inherited_tags）。
 * in_stock でない在庫（売却済み・廃棄済み・自家消費・分割済み）が混ざっていれば例外。
 * 出品に引き当て中（listing_line）の在庫は紐付けてよい。人が「この販売に使う」と
 * 決めたのでその引き当ては優先して外す（出品自体の status は変えない）。
 *
 * opts.takeFromSale: true なら、既に別の販売に紐付いている（status='sold'）在庫も、
 * 同じトランザクションの中でその sale_line を先に外してからこちらへ付け替える
 * （メンテ用。画面で警告してから呼ぶ）。それ以外の非 in_stock（廃棄・自家消費・分割済み）は
 * takeFromSale を付けても例外。既にこの販売自身に紐付いている在庫は無視する（例外にしない）。
 */
export async function linkInventory(
  ctx: Ctx, saleId: string, itemIds: string[], source: LinkSource = 'manual',
  opts?: { takeFromSale?: boolean },
): Promise<void> {
  const sale = argId('販売', saleId)
  const ids = [...new Set(argIds('在庫', itemIds))]
  const src = argEnum('紐付けの種類', source, LINK_SOURCES)
  const takeFromSale = opts?.takeFromSale === true
  if (ids.length === 0) return

  // 親（販売）が無い・他の世帯のものなら、外部キー違反（500）にせず日本語で断る
  const saleRow = await ctx.sql.get<{ id: string }>('select id from sale where id = ?', sale)
  if (!saleRow) throw new UserError('販売が見つかりません', 'not_found')

  const rows = await ctx.sql.all<{ id: string; status: InventoryStatus; sold_sale_id: string | null }>(`
    select i.id, i.status, sl.sale_id as sold_sale_id
      from inventory_item i
      left join sale_line sl on sl.household_id = i.household_id and sl.inventory_item_id = i.id
     where i.id = any(?::uuid[])
  `, ids)
  const byId = new Map(rows.map(r => [r.id, r]))

  for (const id of ids) {
    if (!byId.has(id)) throw new UserError('在庫が見つかりません', 'not_found')
  }

  // 既にこの販売自身に紐付いている在庫は対象から外す（例外にしない）
  const targets = ids.filter(id => byId.get(id)!.sold_sale_id !== sale)
  if (targets.length === 0) return

  for (const id of targets) {
    const row = byId.get(id)!
    const ok = row.status === 'in_stock' || (row.status === 'sold' && takeFromSale)
    if (!ok) throw new UserError('販売済み・廃棄済みの在庫は紐付けられません')
  }

  for (const itemId of targets) {
    // takeFromSale で付け替える対象（status='sold'）は、先に元の sale_line を外す
    // （trg_sline_unsold で in_stock に戻ってから、この販売へ insert し直す）。in_stock の在庫には該当する行が無い
    await ctx.sql.run('delete from sale_line where inventory_item_id = ?', itemId)
    await ctx.sql.run(
      'insert into sale_line (sale_id, inventory_item_id, link_source) values (?, ?, ?)', sale, itemId, src,
    )
    await ctx.sql.run('delete from listing_line where inventory_item_id = ?', itemId)
  }
}

export async function unlinkInventory(ctx: Ctx, saleId: string, itemId: string): Promise<void> {
  await ctx.sql.run(
    'delete from sale_line where sale_id = ? and inventory_item_id = ?',
    argId('販売', saleId), argId('在庫', itemId),
  )
}

/**
 * 「在庫 i が、active/suspended な出品に引き当て済みかどうか」の EXISTS 断片（在庫の別名は i）。
 * findInventoryIdsByModelCodeFifo の除外条件（NOT ${RESERVED_BY_ACTIVE_LISTING}）と
 * getAutoLinkBlockers の抽出条件（${RESERVED_BY_ACTIVE_LISTING}）は表裏の関係。
 * ここを変えたら両方の意味が変わるので、必ずこの断片を共有する。
 */
export const RESERVED_BY_ACTIVE_LISTING = `
  exists (
    select 1 from listing_line ll
    join listing l on l.household_id = ll.household_id and l.id = ll.listing_id
    where ll.household_id = i.household_id and ll.inventory_item_id = i.id and l.status in ('active', 'suspended')
  )
`

/**
 * 在庫コード（そろばん発行）に一致する未販売在庫の id を、渡した順に返す
 * （見つからないコードはスキップする）。他の active/suspended な出品に引き当て済みの在庫は
 * 対象から外す（人が出品に予約した意思を、コード名指しの自動確定でも横取りしない。
 * listing_line は消さず、その分は候補止まりのまま残る）。
 */
export async function findInventoryIdsByItemCodes(ctx: Ctx, itemCodes: string[]): Promise<string[]> {
  const codes = [...new Set(itemCodes)]
  if (codes.length === 0) return []
  const rows = await ctx.sql.all<{ id: string; item_code: string }>(`
    select i.id, i.item_code from inventory_item i
     where i.item_code = any(?::text[]) and i.status = 'in_stock'
       and not ${RESERVED_BY_ACTIVE_LISTING}
  `, codes)
  const byCode = new Map(rows.map(r => [r.item_code, r.id]))
  const ids: string[] = []
  for (const code of codes) {
    const id = byCode.get(code)
    if (id) ids.push(id)
  }
  return ids
}

/**
 * 型番が model_code と文字列として完全一致する未販売在庫を、先入先出（acquired_at 昇順）で
 * 最大 qty 点まで返す（在庫が足りなければある分だけ）。枝番の有無は問わない。
 * 他の active/suspended な出品に引き当て済みの在庫は候補から外す
 * （人が出品に予約した意思を、型番一致の自動確定で横取りしない）。
 *
 * 同じ仕入の在庫は created_at が同着になる（1 リクエスト＝1 トランザクションで now() は同じ）ので、
 * そのときは在庫コードの小さい（先に作った）方から（桁数 → 文字列の順で数の大小になる）。
 */
export async function findInventoryIdsByModelCodeFifo(
  ctx: Ctx, modelCode: string, qty: number, excludeIds: string[] = [],
): Promise<string[]> {
  const rows = await ctx.sql.all<{ id: string }>(`
    select i.id from inventory_item i
     where i.model_code = ? and i.status = 'in_stock'
       and not (i.id = any(?::uuid[]))
       and not ${RESERVED_BY_ACTIVE_LISTING}
     order by i.acquired_at, i.created_at, length(i.item_code), i.item_code collate "C"
     limit ?
  `, modelCode, excludeIds, qty)
  return rows.map(r => r.id)
}

/** 商品を手動で選ぶ画面のプレビュー。自動紐付けと同じFIFOを使い、保存はしない。 */
export async function suggestProductInventory(
  ctx: Ctx, modelCode: string, quantity: number, excludeIds: string[] = [],
): Promise<string[]> {
  const code = argText('商品コード', modelCode, { max: 200 })
  if (!code.trim()) throw new UserError('商品コードを指定してください')
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new UserError('点数は1以上の整数で指定してください')
  if (quantity > 10_000) throw new UserError('点数が多すぎます')
  const exclude = [...new Set(argIds('除外する在庫', excludeIds))]
  return findInventoryIdsByModelCodeFifo(ctx, code, quantity, exclude)
}

// ------------------------------------------------------------
// 候補
// ------------------------------------------------------------

/**
 * 在庫候補の並び順：在庫コード一致 → 型番完全一致 → シリーズ一致 → 商品名の類似度
 * （完全一致 → 前方一致 → 部分一致 → 残り）。suggestInventory / suggestForListing で共通。
 */
export function rankInventoryMatch(
  item: InventoryRow, itemCodeSet: Set<string>, codeSet: Set<string>, seriesCodes: Set<string>,
  target: string, head: string,
): number {
  if (itemCodeSet.has(item.item_code)) return 0
  if (item.model_code && codeSet.has(item.model_code)) return 1
  if (item.series_code && seriesCodes.has(item.series_code)) return 2
  const n = normalizeName(item.name)
  if (n === target) return 3
  if (head && n.startsWith(head)) return 4
  if (head && n.includes(head)) return 5
  return 6
}

/** 候補の取り出す前の並び（滞留日数の長い順。同着は古く作った方＝在庫コードの小さい方）。JS 側の並べ替えは安定なので、この順が同順位の中で残る */
export const INVENTORY_VIEW_ORDER = 'aging_days desc, acquired_at, length(item_code), item_code collate "C"'

/**
 * 在庫候補を返す。並びは 在庫コード一致 → 型番完全一致 → シリーズ一致 → 商品名の類似度
 * （完全一致 → 前方一致 → 部分一致 → 残り）。同順位は滞留日数が長い方を先に
 * （型番一致の中では先入先出と同じ順になる）。
 * SQL側では正規化できないため、in_stock（＋includeSoldならsold）を全件取ってJS側で並べ替える
 * （規模は月20〜50件程度の想定）。他の出品に引き当て済みの在庫は候補から除く。
 *
 * opts.includeSold: 販売済み（他の販売に紐付いた）在庫も候補に含める（sold_to 付き。付け替え用）。
 * 自分自身（saleId）の販売に既に付いている在庫は除く。同順位では in_stock を sold より先に出す。
 */
export async function suggestInventory(
  ctx: Ctx, saleId: string, limit = 20, opts?: { includeSold?: boolean },
): Promise<InventoryItem[]> {
  const id = argId('販売', saleId)
  const max = argInt('件数', limit, { min: 1, max: 1000 })
  const sale = await ctx.sql.get<{ title: string; model_codes: string[] }>(
    'select title, model_codes from sale where id = ?', id,
  )
  if (!sale) return []

  const codes = sale.model_codes ?? []
  const codeSet = new Set(codes)
  const seriesCodes = new Set(codes.map(c => c.split('-')[0]))
  const itemCodeSet = new Set(extractItemCodes(sale.title))

  const target = normalizeName(sale.title)
  const head = target.slice(0, 6)

  const statusClause = opts?.includeSold ? `status in ('in_stock', 'sold')` : `status = 'in_stock'`
  const items = await ctx.sql.all<InventoryRow>(`
    select ${inventoryViewColumns()} from inventory_view
     where ${statusClause} and listing_id is null
     order by ${INVENTORY_VIEW_ORDER}
  `)
  // 自分自身の販売に既に紐付いている在庫は候補に出さない（紐付け解除で外せるので不要）
  const candidates = items.filter(item => !(item.status === 'sold' && item.sold_sale_id === id))

  const picked = candidates
    .map(item => ({ item, r: rankInventoryMatch(item, itemCodeSet, codeSet, seriesCodes, target, head) }))
    .sort((a, b) => {
      if (a.r !== b.r) return a.r - b.r
      const aSold = a.item.status === 'sold' ? 1 : 0
      const bSold = b.item.status === 'sold' ? 1 : 0
      if (aSold !== bSold) return aSold - bSold
      return b.item.aging_days - a.item.aging_days
    })
    .slice(0, max)
    .map(({ item }) => item)

  return attachInventoryTags(ctx, picked)
}

// ------------------------------------------------------------
// 在庫の一覧・編集
// ------------------------------------------------------------

export async function listInventory(ctx: Ctx, status: InventoryStatus = 'in_stock'): Promise<InventoryItem[]> {
  const st = argEnum('在庫の状態', status, INVENTORY_STATUSES)
  const items = await ctx.sql.all<InventoryRow>(
    `select ${inventoryViewColumns()} from inventory_view where status = ? order by ${INVENTORY_VIEW_ORDER}`, st,
  )
  return attachInventoryTags(ctx, items)
}

/** name/model_code/series_code/material/note のみ変更可能。landed_cost は触らない */
export async function updateInventory(ctx: Ctx, id: string, patch: InventoryPatch): Promise<void> {
  const itemId = argId('在庫', id)
  const p = argObject('在庫の変更内容', patch)

  const sets: string[] = []
  const vals: unknown[] = []
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v) }

  if (p.name !== undefined) {
    const name = argText('商品名', p.name, { max: NAME_MAX })
    if (!name.trim()) throw new UserError('商品名を入力してください')
    put('name', name)
  }
  const modelCode = argNullableText('型番', p.model_code, { max: 200 })
  if (modelCode !== undefined) put('model_code', modelCode)
  const seriesCode = argNullableText('シリーズ', p.series_code, { max: 200 })
  if (seriesCode !== undefined) put('series_code', seriesCode)
  const material = argNullableText('素材', p.material, { max: 200 })
  if (material !== undefined) put('material', material)
  const note = argNullableText('メモ', p.note, { max: NOTE_MAX })
  if (note !== undefined) put('note', note)
  if (sets.length === 0) return

  sets.push('updated_at = now()')
  vals.push(itemId)
  const r = await ctx.sql.run(`update inventory_item set ${sets.join(', ')} where id = ?`, ...vals)
  if (r.changes === 0) throw new UserError('在庫が見つかりません', 'not_found')
}

/**
 * ばらして売る：in_stock の1点を count 点に分割する。
 * landed_cost は等分し（floor(合計/点数) を配って、余りは末尾の子に 1 円ずつ）、合計は親と一致。
 * 親は status='split' で残し、過去の原価（landed_cost）はここでも一切書き換えない。
 */
export async function splitInventory(ctx: Ctx, id: string, count: number): Promise<string[]> {
  const itemId = argId('在庫', id)
  if (typeof count !== 'number' || !Number.isSafeInteger(count)) throw new UserError('分割数は2以上の整数にしてください')
  if (count < 2) throw new UserError('分割数は2以上にしてください')
  if (count > SPLIT_MAX) throw new UserError(`分割数は${SPLIT_MAX}以下にしてください`)

  const item = await ctx.sql.get<{
    id: string
    purchase_line_id: string | null
    name: string
    landed_cost: number
    acquired_at: string
    status: InventoryStatus
    model_code: string | null
    series_code: string | null
    material: string | null
  }>(`
    select id, purchase_line_id, name, landed_cost, acquired_at, status, model_code, series_code, material
      from inventory_item where id = ?
  `, itemId)
  if (!item) throw new UserError('在庫が見つかりません', 'not_found')
  if (item.status !== 'in_stock') throw new UserError('未販売の在庫のみ分割できます')

  const parts = splitEvenly(item.landed_cost, count)
  const codes = await nextItemCodes(ctx, count)
  const childIds: string[] = []

  for (let n = 0; n < count; n++) {
    // 子は新しい在庫コードを持ち、名前は「元の名前（分割 1/2）」
    const child = await ctx.sql.get<{ id: string }>(`
      insert into inventory_item
        (item_code, purchase_line_id, name, landed_cost, acquired_at, status,
         model_code, series_code, material, parent_id)
      values (?, ?, ?, ?, ?, 'in_stock', ?, ?, ?, ?)
      returning id
    `,
      codes[n], item.purchase_line_id, `${item.name}（分割 ${n + 1}/${count}）`, parts[n], item.acquired_at,
      item.model_code, item.series_code, item.material, item.id,
    )
    childIds.push(child!.id)
  }
  // 引き当て中（出品に予約済み）だった場合、分割で親は売れなくなるので引き当ても外す
  await ctx.sql.run('delete from listing_line where inventory_item_id = ?', itemId)
  await ctx.sql.run(`update inventory_item set status = 'split', updated_at = now() where id = ?`, itemId)

  return childIds
}

/**
 * 分割を戻す：子が全部 in_stock で、どの出品にも引き当てられていない（listing_line にも
 * sale_line にも無い）ときだけ、子を消して親を in_stock に戻す。
 * 親の landed_cost・item_code・acquired_at はここでも一切書き換えない
 * （子の landed_cost の合計は生成時に親と一致しているはず。崩れていたら止める）。
 * 子のタグ・メモは親に寄せる（タグは重複を無視、メモは改行で追記）。子の item_code は欠番のまま。
 */
export async function mergeSplitInventory(ctx: Ctx, parentId: string): Promise<void> {
  const pid = argId('在庫', parentId)
  const parent = await ctx.sql.get<{ id: string; status: InventoryStatus; landed_cost: number; note: string | null }>(
    'select id, status, landed_cost, note from inventory_item where id = ?', pid,
  )
  if (!parent) throw new UserError('在庫が見つかりません', 'not_found')
  if (parent.status !== 'split') throw new UserError('分割した在庫ではありません')

  const children = await ctx.sql.all<{
    id: string; item_code: string; landed_cost: number; status: InventoryStatus; note: string | null
  }>(`
    select id, item_code, landed_cost, status, note from inventory_item
     where parent_id = ?
     order by created_at, length(item_code), item_code collate "C"
  `, pid)
  if (children.length === 0) throw new UserError('分割した子が見つかりません')

  const childIds = children.map(c => c.id)
  const listed = new Set((await ctx.sql.all<{ inventory_item_id: string }>(
    'select distinct inventory_item_id from listing_line where inventory_item_id = any(?::uuid[])', childIds,
  )).map(r => r.inventory_item_id))
  const sold = new Set((await ctx.sql.all<{ inventory_item_id: string }>(
    'select distinct inventory_item_id from sale_line where inventory_item_id = any(?::uuid[])', childIds,
  )).map(r => r.inventory_item_id))

  const reasons: string[] = []
  for (const c of children) {
    if (c.status === 'sold') reasons.push(`${c.item_code} が販売済みです`)
    else if (c.status === 'disposed' || c.status === 'personal_use') {
      reasons.push(`${c.item_code} が廃棄／自家消費済みです`)
    } else if (c.status === 'split') {
      reasons.push(`${c.item_code} がさらに分割されています（先にそちらを戻してください）`)
    }
    if (listed.has(c.id)) reasons.push(`${c.item_code} が出品に引き当て中です`)
    if (sold.has(c.id)) reasons.push(`${c.item_code} が販売に紐付いています`)
  }
  if (reasons.length > 0) throw new UserError(reasons.join('、'))

  const costSum = children.reduce((sum, c) => sum + c.landed_cost, 0)
  if (costSum !== parent.landed_cost) throw new UserError('原価の合計が親と一致しません')

  await ctx.sql.run(`
    insert into inventory_tag (inventory_item_id, tag_id)
    select distinct ?::uuid, tag_id from inventory_tag where inventory_item_id = any(?::uuid[])
    on conflict do nothing
  `, pid, childIds)

  const mergedNote = [parent.note, ...children.map(c => c.note)]
    .filter((n): n is string => !!n && n.trim() !== '')
    .join('\n')
  if (mergedNote !== (parent.note ?? '')) {
    await ctx.sql.run('update inventory_item set note = ? where id = ?', mergedNote || null, pid)
  }

  // 子のタグは inventory_item の削除で CASCADE して消える
  await ctx.sql.run('delete from inventory_item where id = any(?::uuid[])', childIds)
  await ctx.sql.run(`update inventory_item set status = 'in_stock', updated_at = now() where id = ?`, pid)
}

export async function disposeInventory(
  ctx: Ctx, id: string, note: string, status: 'disposed' | 'personal_use' = 'disposed',
): Promise<void> {
  const itemId = argId('在庫', id)
  const text = argText('メモ', note, { max: NOTE_MAX })
  const st = argEnum('在庫の状態', status, ['disposed', 'personal_use'] as const)

  const item = await ctx.sql.get<{ status: InventoryStatus }>('select status from inventory_item where id = ?', itemId)
  if (!item) throw new UserError('在庫が見つかりません', 'not_found')
  if (item.status !== 'in_stock') throw new UserError('販売済みの在庫は外せません')

  // 引き当て中（出品に予約済み）だった場合、廃棄・自家消費で売れなくなるので引き当ても外す
  await ctx.sql.run('delete from listing_line where inventory_item_id = ?', itemId)
  // 廃棄日は日本時間の暦日（サーバーは UTC。UTC の 15:00〜23:59 は日本ではもう翌日）
  await ctx.sql.run(
    `update inventory_item
        set status = ?, disposed_at = ?::date, disposed_note = ?, updated_at = now()
      where id = ?`,
    st, todayJst(), text, itemId,
  )
}

/**
 * 廃棄・自家消費にした在庫を、手元の在庫（in_stock）に戻す。押し間違いの取り消し用。
 * landed_cost はここでも一切書き換えない（生成時のまま）。
 * 出品への引き当ては戻らない（廃棄のときに外れているので、人が出品からやり直す）
 */
export async function restoreInventory(ctx: Ctx, id: string): Promise<void> {
  const itemId = argId('在庫', id)
  const item = await ctx.sql.get<{ status: InventoryStatus }>('select status from inventory_item where id = ?', itemId)
  if (!item) throw new UserError('在庫が見つかりません', 'not_found')
  if (item.status !== 'disposed' && item.status !== 'personal_use') throw new UserError('この在庫は戻せません')

  await ctx.sql.run(
    `update inventory_item
        set status = 'in_stock', disposed_at = null, disposed_note = null, updated_at = now()
      where id = ?`,
    itemId,
  )
}

/** 在庫に直接付けるタグを丸ごと置き換える（空配列で全部外す）。派生分は対象外 */
export async function setInventoryTags(ctx: Ctx, itemId: string, tagIds: string[]): Promise<void> {
  const id = argId('在庫', itemId)
  const unique = [...new Set(argIds('タグ', tagIds))]
  const item = await ctx.sql.get<{ id: string }>('select id from inventory_item where id = ?', id)
  if (!item) throw new UserError('在庫が見つかりません', 'not_found')
  await assertTagsExist(ctx, unique)

  await ctx.sql.run('delete from inventory_tag where inventory_item_id = ?', id)
  for (const tagId of unique) {
    await ctx.sql.run('insert into inventory_tag (inventory_item_id, tag_id) values (?, ?)', id, tagId)
  }
}

// ------------------------------------------------------------
// 横断検索・CSV
// ------------------------------------------------------------

const SEARCH_INVENTORY_STATUSES: InventoryStatus[] = ['in_stock', 'sold', 'disposed', 'personal_use', 'split']

export function inventoryStatusLabel(item: Pick<InventoryItem, 'status' | 'listing'>): string {
  switch (item.status) {
    case 'in_stock': return item.listing ? '出品中' : '未出品'
    case 'sold': return '販売済'
    case 'disposed': return '廃棄'
    case 'personal_use': return '自家消費'
    case 'split': return '分割済'
  }
}

export async function searchInventoryHits(ctx: Ctx, terms: string[], perKind: number): Promise<SearchHit[]> {
  const items: InventoryItem[] = []
  for (const status of SEARCH_INVENTORY_STATUSES) items.push(...await listInventory(ctx, status))

  const hits: SearchHit[] = items
    .filter(i => matchesQuery([
      i.name, i.item_code, i.model_code, i.series_code, i.material, i.note,
      i.order_no, i.shop_account_name,
      ...i.tags.map(t => t.name), ...i.inherited_tags.map(t => t.name),
    ], terms))
    .map(i => ({
      kind: 'inventory' as const,
      id: i.id,
      title: i.name,
      model_code: i.model_code,
      status_label: inventoryStatusLabel(i),
      amount: i.landed_cost,
      date: i.acquired_at,
      thumb_url: i.thumb_url,
    }))

  return sortAndSlice(hits, perKind)
}

/**
 * 在庫（1行＝在庫1点）のCSV行。在庫は「今」の姿なので month が来ても無視して全件出す。
 * 状態はInventory.vue のピル/チップ表示と同じ優先順位（status !== 'in_stock' を先に見る）で決める
 */
export async function exportInventoryRows(ctx: Ctx): Promise<string> {
  const rows = await ctx.sql.all<Record<string, unknown>>(`
    select
      iv.item_code             as 在庫コード,
      iv.name                  as 商品名,
      iv.model_code            as 型番,
      iv.material              as 素材,
      case
        when iv.status = 'sold'         then '販売済'
        when iv.status = 'disposed'     then '廃棄'
        when iv.status = 'personal_use' then '自家消費'
        when iv.status = 'split'        then '分割前の親'
        when iv.fulfillment = 'pending' or iv.fulfillment = 'shipped' then '未着'
        when iv.listing_id is not null  then '出品中'
        else '届いていて未出品'
      end                      as 状態,
      iv.shop_account_name     as 仕入先,
      iv.order_no              as 注文番号,
      iv.acquired_at           as 仕入日,
      iv.aging_days            as 滞留日数,
      iv.landed_cost           as 按分後原価,
      iv.listing_price         as 出品価格,
      iv.sold_sold_at          as 販売日,
      iv.sold_price            as 販売価格,
      sls.profit_share         as "1点あたりの粗利"
    from inventory_view iv
    left join sale_line_share sls on sls.household_id = iv.household_id and sls.inventory_item_id = iv.id
    order by iv.acquired_at, length(iv.item_code), iv.item_code collate "C"
  `)
  return rowsToCsv(rows)
}

// ------------------------------------------------------------
// API として登録する（引数は信用しない。型が違えば UserError）
// ------------------------------------------------------------

function parseTakeFromSale(opts: unknown): { takeFromSale?: boolean } | undefined {
  const o = argOptObject('オプション', opts)
  if (!o) return undefined
  return { takeFromSale: argOptBool('付け替え', o.takeFromSale) }
}

function parseIncludeSold(opts: unknown): { includeSold?: boolean } | undefined {
  const o = argOptObject('オプション', opts)
  if (!o) return undefined
  return { includeSold: argOptBool('販売済みを含める', o.includeSold) }
}

registerHandler('linkInventory', (ctx, saleId, inventoryItemIds, opts) =>
  // 紐付けの種類（source）は画面から受けない。人の操作は常に manual
  linkInventory(ctx, saleId, inventoryItemIds, 'manual', parseTakeFromSale(opts)))
registerHandler('unlinkInventory', (ctx, saleId, inventoryItemId) => unlinkInventory(ctx, saleId, inventoryItemId))
registerHandler('suggestInventory', (ctx, saleId, limit, opts) =>
  suggestInventory(ctx, saleId, argOptInt('件数', limit, { min: 1, max: 1000 }) ?? 20, parseIncludeSold(opts)))
registerHandler('suggestProductInventory', (ctx, modelCode, quantity, excludeIds) =>
  suggestProductInventory(ctx, modelCode, quantity, excludeIds ?? []))
registerHandler('listInventory', (ctx, status) =>
  listInventory(ctx, argOptEnum('在庫の状態', status, INVENTORY_STATUSES) ?? 'in_stock'))
registerHandler('updateInventory', (ctx, id, patch) => updateInventory(ctx, id, patch))
registerHandler('splitInventory', (ctx, id, count) => splitInventory(ctx, id, count))
registerHandler('mergeSplitInventory', (ctx, parentId) => mergeSplitInventory(ctx, parentId))
registerHandler('disposeInventory', (ctx, id, note, status) =>
  disposeInventory(ctx, id, note, argOptEnum('在庫の状態', status, ['disposed', 'personal_use'] as const) ?? 'disposed'))
registerHandler('restoreInventory', (ctx, id) => restoreInventory(ctx, id))
registerHandler('setInventoryTags', (ctx, inventoryItemId, tagIds) => setInventoryTags(ctx, inventoryItemId, tagIds))
