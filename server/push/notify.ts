import type { Ctx } from '../context'
import type { Sql } from '../db/sql'
import { subtractDaysJst, todayJst } from '../domain/_shared'

// 通知を積む（業務の書き込みと同じトランザクションの中で呼ぶ）。
// 積むだけで送らない：送るのは Cron の Worker（deliver.ts）。業務が巻き戻れば通知も消える。
//
// 通知を積む失敗で業務を止めない：積む処理は SAVEPOINT の中で行い、失敗したらログに残して続ける
// （販売の取り込みが「通知の文字が長すぎた」で丸ごと巻き戻る、を起こさない）。
//
// 文面の組み立てはここに 1 か所だけ置く（Cron の 17TRACK の入口など、別の経路から積むときも同じ文面にする）

export type NotificationKind = 'sale' | 'shipping' | 'collect' | 'arrival' | 'test'

export interface NotificationInput {
  kind: NotificationKind
  /** 題名。DB の上限は 200 文字（enqueueNotification が収める） */
  title: string
  /** 本文。DB の上限は 1000 文字 */
  body: string
  /** 押したときに開く画面（同じオリジンの中だけ） */
  url: string | null
  /** 同じ出来事を二重に積まない鍵（世帯の中で一意）。例 `sale:<販売の id>` */
  dedupeKey: string
  /** 渡すと、その人の端末だけに配る（試しの通知）。省略は世帯の全員 */
  userId?: string | null
}

const TITLE_MAX = 200
const BODY_MAX = 1000
/** 売れた・発送の通知に入れる商品名の長さ（残りに価格などが入る） */
const NAME_CLIP = 120

/** 「売れた」を通知するのは、この日数以内に売れた販売だけ（昔の販売をまとめて取り込んだときに通知で溢れさせない） */
const FRESH_SALE_DAYS = 3

// ------------------------------------------------------------
// 文面
// ------------------------------------------------------------

/** 改行・連続する空白を 1 つの空白にして、max 文字（コードポイント）に収める。収まらなければ末尾を … にする */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** 3 桁区切りの円（¥5,750）。整数だけを受ける */
export function formatYen(n: number): string {
  return `¥${String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

export function saleMessage(sale: { id: string; title: string; price: number }): NotificationInput {
  return {
    kind: 'sale',
    title: `売れました：${clip(sale.title, NAME_CLIP)} ${formatYen(sale.price)}`,
    body: '',
    url: `/?tab=sales&sale=${sale.id}`,
    dedupeKey: `sale:${sale.id}`,
  }
}

export function shippingMessage(sale: { id: string; title: string }): NotificationInput {
  return {
    kind: 'shipping',
    title: `発送してください：${clip(sale.title, NAME_CLIP)}`,
    body: '',
    url: `/?tab=sales&sale=${sale.id}`,
    dedupeKey: `shipping:${sale.id}`,
  }
}

/** supplier が分からないとき（Cron の soroban_cron は仕入先の名前を読めない）は、仕入先を書かない */
export function arrivalMessage(purchase: { id: string; supplier: string | null; quantity: number }): NotificationInput {
  const count = purchase.quantity > 0 ? `（${purchase.quantity} 点）` : ''
  const from = purchase.supplier?.trim() ? `${clip(purchase.supplier, 60)}の荷物` : '仕入れた荷物'
  return {
    kind: 'arrival',
    title: `${from}が届きました${count}`,
    body: '',
    url: `/?tab=purchases&purchase=${purchase.id}`,
    dedupeKey: `arrival:${purchase.id}`,
  }
}

// ------------------------------------------------------------
// 積む
// ------------------------------------------------------------

/**
 * app.enqueue_notification を呼ぶ。新しく積んだら event の id、同じ dedupe_key が世帯に既にあれば null。
 * 題名・本文は DB の上限に収めてから渡す（上限を超えると DB が断り、呼び出し元の書き込みごと巻き戻るため）。
 * 失敗は投げる（業務の中から呼ぶときは enqueueSafely）
 */
export async function enqueueNotification(sql: Sql, n: NotificationInput): Promise<string | null> {
  const title = clip(n.title, TITLE_MAX) || 'そろばん'
  const row = await sql.get<{ id: string | null }>(
    'select app.enqueue_notification(?, ?, ?, ?, ?, ?::uuid) as id',
    n.kind, title, clip(n.body, BODY_MAX), n.url, n.dedupeKey, n.userId ?? null,
  )
  return row?.id ?? null
}

/** 業務の書き込みの中から積む。SAVEPOINT の中で行い、失敗してもログに残して続ける（業務を巻き戻さない） */
export async function enqueueSafely(ctx: Ctx, n: NotificationInput): Promise<string | null> {
  try {
    return await ctx.sql.tx((sql) => enqueueNotification(sql, n))
  } catch (e) {
    console.error(`[push] 通知を積めませんでした（${n.kind}）。業務の書き込みは続けます`, e instanceof Error ? e.message : String(e))
    return null
  }
}

/**
 * 取り込みで新しく入った販売を通知する。通知しないもの：
 *   * 取引完了（status = completed）… 販売履歴からまとめて入ってくる過去の販売。売れた知らせではない
 *   * 3 日より前に売れたもの … 同上（状態が取れない出品先の過去分）
 */
export async function notifyNewSale(
  ctx: Ctx,
  sale: { id: string; title: string; price: number; soldAt: string; status: string | null },
): Promise<void> {
  if (sale.status === 'completed') return
  if (sale.soldAt < subtractDaysJst(todayJst(), FRESH_SALE_DAYS)) return
  await enqueueSafely(ctx, saleMessage(sale))
}

/** 販売が「発送待ち」になった（発送の番が来た）ことを通知する。販売が無ければ何もしない */
export async function notifyShipping(ctx: Ctx, saleId: string): Promise<void> {
  const sale = await ctx.sql.get<{ title: string }>('select title from sale where id = ?', saleId)
  if (!sale) return
  await enqueueSafely(ctx, shippingMessage({ id: saleId, title: sale.title }))
}

/** 仕入が届いた（到着済になった）ことを通知する。仕入が無ければ何もしない */
export async function notifyArrival(ctx: Ctx, purchaseId: string): Promise<void> {
  const row = await ctx.sql.get<{ supplier: string; quantity: number }>(
    `select s.name as supplier,
            coalesce((select sum(l.quantity) from purchase_line l
                       where l.household_id = p.household_id and l.purchase_id = p.id), 0)::int as quantity
       from purchase p
       join shop_account s on s.household_id = p.household_id and s.id = p.shop_account_id
      where p.id = ?`,
    purchaseId,
  )
  if (!row) return
  await enqueueSafely(ctx, arrivalMessage({ id: purchaseId, supplier: row.supplier, quantity: row.quantity }))
}
