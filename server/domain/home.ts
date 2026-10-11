import type { Ctx } from '../context'
import { registerHandler } from '../rpc'
import type {
  CollectorRun, DashboardStats, ExportKind, HealthCheck, SearchHit,
} from '../../src/shared/types'
import { SALE_KIND_LABEL } from '../../src/shared/types'
import {
  argOptEnum, argOptInt, argOptMonth, argText, monthBounds, normalizeSearchText, rowsToCsv, setting,
  subtractDaysJst, thisMonthJst, todayJst,
} from './_shared'
import { RESERVED_BY_ACTIVE_LISTING, exportInventoryRows, searchInventoryHits } from './inventory'
import { searchListingHits } from './listing'
import { listRuns } from './master'
import { exportExpenseRows, listMonthly } from './monthly'
import { exportPurchaseRows, searchPurchaseHits } from './purchase'
import { searchSaleHits } from './sale'

// ============================================================
// ホーム（要対応の数字）・データの健康診断・横断検索・CSV 書き出し
//
// src/main/db.ts の getDashboard / getHealthChecks / searchAll / exportRows / exportCsvRows の移植。
// 毎日いちばん最初に見る画面の数字と、帳簿のずれを見つける最後の砦。
// 利益はビュー（sale_profit / monthly_summary）から読む。ここで利益を再集計しない。
// 日付：サーバー（Workers）は UTC。「今月」「30 日前」は todayJst() / thisMonthJst() で決める。
// ============================================================

const EXPORT_KINDS: readonly ExportKind[] = ['sales', 'purchases', 'expenses', 'inventory']
const SEARCH_QUERY_MAX = 500

// ------------------------------------------------------------
// ホーム
// ------------------------------------------------------------

/** collector_run に shop_account_name を付けて返す select（master.ts の RUN_SELECT と同じ列。取り込み元ごとの直近 1 件を引くのに使う） */
const RUN_SELECT = `
  select r.id, r.started_at, r.finished_at, r.status, r.fetched, r.inserted, r.message, r.source,
         r.shop_account_id, sa.name as shop_account_name
    from collector_run r
    left join shop_account sa on sa.household_id = r.household_id and sa.id = r.shop_account_id
`

async function count(ctx: Ctx, text: string, ...params: unknown[]): Promise<number> {
  return (await ctx.sql.get<{ c: number }>(text, ...params))!.c
}

export async function getDashboard(ctx: Ctx): Promise<DashboardStats> {
  const needsShipping = await count(ctx, 'select count(*) as c from sale where is_shipping_confirmed = 0')

  const needsMatch = await count(ctx, `select count(*) as c from sale_profit where unmatched = 1 and kind = 'resale'`)

  const needsPurchaseConfirm = await count(ctx, `select count(*) as c from purchase where status = 'draft'`)

  const needsListingAllocation = await count(ctx, `
    select count(*) as c from listing l
     where l.status = 'active' and not exists (
       select 1 from listing_line ll where ll.household_id = l.household_id and ll.listing_id = l.id
     )
  `)

  // 発送が必要な販売（取引中タブで「発送してください」の段階）。放置すると評価が下がるので
  // ホームの要対応の上位に出す
  const needsShipment = await count(ctx, `select count(*) as c from sale where status = 'waiting_shipment'`)

  const stock = (await ctx.sql.get<{ c: number; v: number }>(
    `select count(*) as c, coalesce(sum(landed_cost), 0)::bigint as v
       from inventory_item where status = 'in_stock'`,
  ))!

  // 設定が数でなければ（手で壊れた値）既定の 90 日にする。ホームが開けなくなるのを避ける
  const warn = await setting(ctx, 'aging_warn_days', 90)
  const warnDays = Number.isSafeInteger(warn) ? warn : 90
  const aging = await count(ctx, `
    select count(*) as c from inventory_view where status = 'in_stock' and aging_days >= ?
  `, warnDays)

  // monthly_summary ビューには unconfirmed_shipping / expense_total / net_profit が無い
  // （listMonthly() が期間費用を通した上で後付けしている）ため、直接ビューを読まず
  // listMonthly() の結果から今月の resale 行を拾う
  const month = thisMonthJst()
  const thisMonth = (await listMonthly(ctx)).find(r => r.month === month && r.kind === 'resale')

  const lastRun = (await listRuns(ctx, 1))[0]

  // 取り込み元ごとの直近1件（mercari + 有効なメロジョイ口座ごとに1件）。
  // 最後の1回だけ見ていると、別の取り込み元の成功で他の失敗が隠れるため、
  // 元ごとに直近の状態をホームの要対応で拾えるようにする
  const mercariRun = await ctx.sql.get<CollectorRun>(
    `${RUN_SELECT} where r.source = 'mercari' order by r.started_at desc, r.id desc limit 1`,
  )

  const accounts = await ctx.sql.all<{ account_id: string }>(`
    select sa.id as account_id
      from shop_account sa
     where sa.is_active = 1 and sa.kind = 'mellojoy'
     order by sa.name collate "C", sa.id
  `)

  const recentRuns: CollectorRun[] = []
  if (mercariRun) recentRuns.push(mercariRun)
  for (const { account_id } of accounts) {
    const run = await ctx.sql.get<CollectorRun>(
      `${RUN_SELECT} where r.shop_account_id = ? order by r.started_at desc, r.id desc limit 1`, account_id,
    )
    if (run) recentRuns.push(run)
  }

  return {
    needsShipping,
    needsMatch,
    needsPurchaseConfirm,
    needsListingAllocation,
    needsShipment,
    stockCount: stock.c,
    stockValue: stock.v,
    agingCount: aging,
    thisMonth: thisMonth ?? null,
    lastRun: lastRun ?? null,
    recentRuns,
  }
}

// ============================================================
// データの健康診断（読むだけ。直しはしない）
//
// 「この数字を信用してよいか」を自分で確かめられるように、合計の不一致や
// 抜けを SQL で数える（重い全件走査はしない）。landed_cost・按分の再計算は
// 一切行わない。直すのは常に人が画面から
// ============================================================

export async function getHealthChecks(ctx: Ctx): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = []

  // 1. 確定した仕入ごとに Σpurchase_line.allocated_cost と配賦対象
  //    （送料 + その他費用 − 割引）が一致しない注文の数。
  //    足し算は bigint で行う（送料・その他費用が大きいと integer の範囲を超えて、この診断自体が落ちるため）
  const allocMismatch = await count(ctx, `
    select count(*) as c from purchase p
     where p.status = 'confirmed'
       and (select coalesce(sum(pl.allocated_cost), 0)::bigint
              from purchase_line pl where pl.household_id = p.household_id and pl.purchase_id = p.id)
           != (p.shipping_fee::bigint + p.other_cost - p.discount)
  `)
  if (allocMismatch > 0) {
    checks.push({
      id: 'alloc-mismatch', level: 'warn', title: '仕入の按分が合っていない',
      count: allocMismatch,
      detail: '送料などの配賦後の合計が注文の金額と合いません。仕入を開いて保存し直すと直ります',
    })
  }

  // 2. sale_line があって Σlanded_cost = 0 の販売（転売のみ）
  const zeroCostLink = await count(ctx, `
    select count(*) as c from (
      select s.id
        from sale s
        join sale_line sl on sl.household_id = s.household_id and sl.sale_id = s.id
        join inventory_item i on i.household_id = sl.household_id and i.id = sl.inventory_item_id
       where s.kind = 'resale'
       group by s.id
      having sum(i.landed_cost) = 0
    ) t
  `)
  if (zeroCostLink > 0) {
    checks.push({
      id: 'zero-cost-link', level: 'warn', title: '原価が0円のまま紐付いている販売',
      count: zeroCostLink,
      detail: '分割した在庫の原価が0のままかもしれません',
      goto: { tab: 'sales', stage: 'all' },
    })
  }

  // 3. sale_line があるのに status != 'sold'、または status = 'sold' なのに
  //    sale_line が無い在庫（トリガーで起きないはずの食い違い）
  const statusMismatch = await count(ctx, `
    select
      (select count(*) from inventory_item i
        where i.status != 'sold'
          and exists (select 1 from sale_line sl where sl.household_id = i.household_id and sl.inventory_item_id = i.id))
      +
      (select count(*) from inventory_item i
        where i.status = 'sold'
          and not exists (select 1 from sale_line sl where sl.household_id = i.household_id and sl.inventory_item_id = i.id))
      as c
  `)
  if (statusMismatch > 0) {
    checks.push({
      id: 'status-mismatch', level: 'warn', title: '在庫の状態と紐付けが食い違っている',
      count: statusMismatch,
      detail: 'トリガーで起きないはずの食い違いです。バックアップを取ってから相談してください',
    })
  }

  // 4. item_code が2件以上ある数（本来UNIQUE。Web 版は DB の制約でも守られているので、通常は 0）
  const dupItemCode = await count(ctx, `
    select count(*) as c from (
      select item_code from inventory_item group by item_code having count(*) > 1
    ) t
  `)
  if (dupItemCode > 0) {
    checks.push({
      id: 'dup-item-code', level: 'warn', title: '在庫コードが重複している',
      count: dupItemCode,
      detail: '本来重複しないはずの在庫コードが重複しています。手入力や取り込みの不具合の可能性があります',
    })
  }

  // 5. is_shipping_confirmed = 0 かつ sold_at が30日以上前の販売
  // 経過日数は日本時間の暦日で数える（サーバーは UTC なので、時計の「今日」をそのまま使うと
  // 日本の 0〜9 時に 1 日ずれる）。しきい値の日付を JS 側で作って渡す
  const threshold30 = subtractDaysJst(todayJst(), 30)
  const shippingOld = await count(ctx, `
    select count(*) as c from sale
     where is_shipping_confirmed = 0
       and sold_at <= ?::date
  `, threshold30)
  if (shippingOld > 0) {
    checks.push({
      id: 'shipping-old', level: 'info', title: '送料が未入力のまま 30 日たった販売',
      count: shippingOld,
      detail: '送料が入っていないと粗利が実際より大きく出ます',
      goto: { tab: 'sales', stage: 'all' },
    })
  }

  // 6. kind='resale' で sale_line が無く sold_at が30日以上前の販売
  const unmatchedOld = await count(ctx, `
    select count(*) as c from sale s
     where s.kind = 'resale'
       and s.sold_at <= ?::date
       and not exists (select 1 from sale_line sl where sl.household_id = s.household_id and sl.sale_id = s.id)
  `, threshold30)
  if (unmatchedOld > 0) {
    checks.push({
      id: 'unmatched-old', level: 'info', title: '紐付けないまま 30 日たった販売',
      count: unmatchedOld,
      detail: '原価が入らないため粗利が実際より大きく出ています',
      goto: { tab: 'sales', stage: 'all' },
    })
  }

  // 7. purchase.status = 'draft' で ordered_at が14日以上前
  const threshold14 = subtractDaysJst(todayJst(), 14)
  const draftOld = await count(ctx, `
    select count(*) as c from purchase
     where status = 'draft'
       and ordered_at <= ?::date
  `, threshold14)
  if (draftOld > 0) {
    checks.push({
      id: 'draft-old', level: 'info', title: '下書きのまま 14 日たった仕入',
      count: draftOld,
      detail: '確定するまで在庫が作られません',
      goto: { tab: 'purchases' },
    })
  }

  // 8. model_code IS NULL の in_stock 在庫
  const noModelCode = await count(ctx, `
    select count(*) as c from inventory_item
     where model_code is null and status = 'in_stock'
  `)
  if (noModelCode > 0) {
    checks.push({
      id: 'no-model-code', level: 'info', title: '型番が付いていない在庫',
      count: noModelCode,
      detail: '型番があると、売れたときに自動で紐付けの対象になります',
      goto: { tab: 'inventory' },
    })
  }

  // 9. collector_run の最新3件（sourceごと）が全部 empty の source の数
  const collectEmpty = await count(ctx, `
    select count(*) as c from (
      select source from (
        select source, status,
               row_number() over (partition by source order by started_at desc, id desc) as rn
          from collector_run
      ) recent
      where rn <= 3
      group by source
      having count(*) = 3 and sum(case when status = 'empty' then 1 else 0 end) = 3
    ) t
  `)
  if (collectEmpty > 0) {
    checks.push({
      id: 'collect-empty', level: 'info', title: '取り込みが続けて0件',
      count: collectEmpty,
      detail: '画面構造が変わって取れなくなっているかもしれません',
    })
  }

  // 10. 型番が1つに絞れる未紐付けの転売のうち、その型番の在庫が active/suspended な出品に
  //     取られていて自動紐付けの対象から外れているもの（＝いま原価が入らず止まっている販売）。
  //     findInventoryIdsByModelCodeFifo／getAutoLinkBlockers と同じ RESERVED_BY_ACTIVE_LISTING を
  //     そのまま使い、条件を書き分けない。FIFOで選べる在庫が他に1点でもあれば数えない
  const listingBlocksSale = await count(ctx, `
    select count(*) as c from sale s
     where s.kind = 'resale'
       and not exists (select 1 from sale_line sl where sl.household_id = s.household_id and sl.sale_id = s.id)
       and cardinality(s.model_codes) = 1
       and exists (
         select 1 from inventory_item i
          where i.household_id = s.household_id
            and i.model_code = s.model_codes[1]
            and i.status = 'in_stock'
            and ${RESERVED_BY_ACTIVE_LISTING}
       )
       and not exists (
         select 1 from inventory_item i
          where i.household_id = s.household_id
            and i.model_code = s.model_codes[1]
            and i.status = 'in_stock'
            and not ${RESERVED_BY_ACTIVE_LISTING}
       )
  `)
  if (listingBlocksSale > 0) {
    checks.push({
      id: 'listing-blocks-sale', level: 'warn', title: '出品に取ってある在庫のせいで紐付けられない販売',
      count: listingBlocksSale,
      detail: '売れた商品の在庫が、別の出品に取ってあります。その出品から外すと紐付けられます',
      goto: { tab: 'sales', stage: 'all' },
    })
  }

  // 11. status='suspended' の出品が in_stock の在庫を押さえている件数（出品の件数）。
  //     active（出品中）は在庫を押さえているのが正常なので数えない
  const suspendedReserved = await count(ctx, `
    select count(distinct l.id) as c
      from listing l
      join listing_line ll on ll.household_id = l.household_id and ll.listing_id = l.id
      join inventory_item i on i.household_id = ll.household_id and i.id = ll.inventory_item_id
     where l.status = 'suspended' and i.status = 'in_stock'
  `)
  if (suspendedReserved > 0) {
    checks.push({
      id: 'suspended-listing-reserved', level: 'info', title: '出品を止めたまま在庫を押さえている出品',
      count: suspendedReserved,
      detail: '止めた出品に在庫が取ってあります。取ってあるあいだ、その在庫は他の販売に紐付けられません',
      goto: { tab: 'sales', stage: 'listed', listingStatus: 'suspended' },
    })
  }

  return checks.sort((a, b) =>
    (a.level === b.level ? 0 : a.level === 'warn' ? -1 : 1) || b.count - a.count)
}

// ============================================================
// 横断検索（「あの商品どうなった？」を1か所で。全期間・全状態が対象）
//
// 候補は各ドメインの一覧をそのまま使って取り、絞り込みは JS 側
// （normalize('NFKC').toLowerCase() + 空白区切り AND。renderer の SearchBox.vue の matchesSearch と同じ規則）で行う。
// SQL の LIKE は大文字小文字・全角半角を無視できないため。
// ============================================================

/**
 * 空白区切りAND、NFKC正規化。種類ごと（inventory→listing→sale→purchase）に新しい順、
 * 種類ごとの上限は ceil(limit/4)。空文字なら []
 */
export async function searchAll(ctx: Ctx, query: string, limit = 60): Promise<SearchHit[]> {
  const q = argText('検索語', query, { max: SEARCH_QUERY_MAX })
  const max = argOptInt('件数', limit, { min: 1, max: 1000 }) ?? 60
  const terms = normalizeSearchText(q).trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []

  const perKind = Math.ceil(max / 4)

  return [
    ...await searchInventoryHits(ctx, terms, perKind),
    ...await searchListingHits(ctx, terms, perKind),
    ...await searchSaleHits(ctx, terms, perKind),
    ...await searchPurchaseHits(ctx, terms, perKind),
  ]
}

// ============================================================
// エクスポート
//
// レンダラーでは利益を再計算しない（CLAUDE.md）ので、CSV もここ（サーバー）で組み立てる。
// 在庫の CSV は inventory.ts、仕入は purchase.ts、経費は monthly.ts。
// ============================================================

/** 販売（sale_profit）のCSV行。month（YYYY-MM）を渡すと計上日（sold_at）で絞る。0件は空文字 */
export async function exportRows(ctx: Ctx, month?: string): Promise<string> {
  const m = argOptMonth('月', month)
  const range = m ? monthBounds(m) : null
  const rows = await ctx.sql.all<Record<string, unknown>>(`
    select
      sp.sold_at         as "販売日",
      case when sp.status = 'completed' or (sp.source = 'manual' and sp.status is null) then '実績' else '見込み' end as "集計区分",
      sp.title           as "商品名",
      case sp.kind when 'resale' then ?::text else ?::text end as "区分",
      case sp.source when 'collector' then '自動取得' else '手入力' end as "取得元",
      sp.price           as "販売価格",
      sp.fee             as "販売手数料",
      sp.shipping_fee    as "送料",
      sp.shipping_source as "送料区分",
      sp.packaging_cost  as "梱包材",
      sp.cost            as "原価",
      sp.gross_profit    as "粗利",
      sp.item_count      as "紐付け点数",
      array_to_string(sp.model_codes, '|') as "型番",
      (select string_agg(t.name, '|' order by t.sort_order, t.name collate "C")
         from sale_tag st
         join tag t on t.household_id = st.household_id and t.id = st.tag_id
        where st.household_id = sp.household_id and st.sale_id = sp.id) as "タグ",
      sp.channel_item_id as "取引ID"
    from sale_profit sp
    ${range ? 'where sp.sold_at >= ?::date and sp.sold_at <= ?::date' : ''}
    order by sp.sold_at, sp.title collate "C", sp.id
  `, SALE_KIND_LABEL.resale, SALE_KIND_LABEL.personal, ...(range ? [range.start, range.end] : []))
  return rowsToCsv(rows)
}

/**
 * 設定・ホームから呼ぶCSV書き出しの入口。kind ごとに列が違う（サーバーで組み立て、レンダラーは再計算しない）。
 * 0件は空文字（呼び出し元はこれを「対象なし」として扱う）
 */
export async function exportCsvRows(ctx: Ctx, kind: ExportKind = 'sales', month?: string): Promise<string> {
  const k = argOptEnum('書き出す対象', kind, EXPORT_KINDS) ?? 'sales'
  switch (k) {
    case 'sales': return exportRows(ctx, month)
    case 'purchases': return exportPurchaseRows(ctx, month)
    case 'expenses': return exportExpenseRows(ctx, month)
    // 在庫は「今」の姿なので month が来ても無視して全件出す
    case 'inventory': return exportInventoryRows(ctx)
  }
}

// ------------------------------------------------------------
// API として登録する（引数は信用しない。型が違えば UserError）
// ------------------------------------------------------------

registerHandler('getDashboard', (ctx) => getDashboard(ctx))
registerHandler('getHealthChecks', (ctx) => getHealthChecks(ctx))
registerHandler('searchAll', (ctx, query, limit) => searchAll(ctx, query, limit ?? undefined))

// 【Web 版】デスクトップ版は保存ダイアログでファイルに書いてパスを返していたが、ブラウザには保存ダイアログが無い。
// 戻り値は **CSV の中身そのもの**（先頭に BOM。対象が 0 件なら null）。ダウンロードさせるのは画面側（次の段）
registerHandler('exportCsv', async (ctx, kind, month) => {
  const csv = await exportCsvRows(ctx, argOptEnum('書き出す対象', kind, EXPORT_KINDS) ?? 'sales', argOptMonth('月', month))
  return csv ? csv : null
})
