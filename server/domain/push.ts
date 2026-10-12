import type { PushDevice, PushKinds, PushSubscriptionInput, WebApi } from '../../src/shared/web-types'
import type { Ctx, ServerEnv } from '../context'
import { readDbError, UserError } from '../errors'
import { registerWebHandler } from '../rpc'
import { b64urlDecode, b64urlEncode } from '../push/base64url'
import { completeDelivery, sendClaimed, type ClaimedDelivery } from '../push/deliver'
import { isPushServiceHost } from '../push/hosts'
import { enqueueNotification } from '../push/notify'
import type { SendDeps } from '../push/send'
import { isValidVapidPublicKey, loadVapidKeys, VapidConfigError, type VapidEnv } from '../push/vapid'
import { argBool, argId, argObject, argOptText, argText } from './_shared'

// ============================================================
// Push 通知の画面の口（WebApi の 6 本）と、設定画面の「試しに送る」
//
// 設計：docs/web/03-agent-and-push.md の 4 節。表は supabase/migrations の 0400（push_subscription）・
// 1510（notification_event / notification_delivery）。
//
// * 端末（購読）は人ごと。同じ世帯の配偶者の端末は一覧に出すが、消す・種類を変えるのは自分の端末だけ（user_id で絞る）
// * 通知を積むのは業務の書き込みの側（sale.ts・purchase.ts。push/notify.ts）。送るのは Cron の Worker
//   （push/deliver.ts）。この API が自分で送るのは、画面の「試しに送る」だけ
//
// 環境変数（VAPID_*）は `ctx.env` から読む（入口が渡す）。渡していない（全部 null）ときは「鍵なし」として動く
// ============================================================

/** `ctx.env`（null を含む）を、鍵を読む側（push/vapid.ts）の形にする */
const vapidEnvOf = (env: ServerEnv): VapidEnv => ({
  VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY ?? undefined,
  VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY ?? undefined,
  VAPID_SUBJECT: env.VAPID_SUBJECT ?? undefined,
})

const ENDPOINT_MAX = 2000
const LABEL_MAX = 200
/** 試しの通知で一度に送る端末の数の上限（Workers の 1 回の外部通信の上限に対して十分に小さく） */
const TEST_SEND_LIMIT = 20

// ------------------------------------------------------------
// 引数の検査
// ------------------------------------------------------------

// 購読の宛先（endpoint）はブラウザの Push サービスのホストに限る。許可リストは push/hosts.ts にある
// （送る直前の検査 push/send.ts と同じ判定を使うため。ここは従来の import 先として再公開する）
export { isPushServiceHost }

/**
 * https の URL だけ。資格情報つき・自分自身（localhost）・IP アドレス直指定は、通知サービスの宛先ではないので断る。
 * `pushServiceOnly` なら、さらにホストを許可した Push サービス（`isPushServiceHost`）に限り、ポートは既定（443）だけ。
 * 登録（savePushSubscription）はこちら。消す側（deletePushSubscription）は形だけ見る（許可の外の宛先が昔入っていても消せるように）
 */
function argEndpoint(v: unknown, pushServiceOnly = false): string {
  const raw = argText('通知の宛先（endpoint）', v, { max: ENDPOINT_MAX })
  const bad = () => new UserError('通知の宛先（endpoint）は https:// の URL にしてください')
  if (!raw.startsWith('https://') || /\s/.test(raw)) throw bad()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw bad()
  }
  const host = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:' || url.username || url.password || !host ||
    host === 'localhost' || host.endsWith('.localhost') || host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)
  ) throw bad()
  if (pushServiceOnly && (url.port !== '' || !isPushServiceHost(host))) {
    throw new UserError('この通知の宛先には対応していません。ブラウザの通知サービス（Chrome・Firefox・Safari・Edge）の宛先だけ登録できます')
  }
  return raw
}

/** base64url の鍵。decoded の長さが合わなければ断る。保存は詰め物なしの形に揃える */
function argKey(name: string, v: unknown, bytes: number, firstByte?: number): string {
  const text = argText(name, v, { max: 200 })
  const raw = b64urlDecode(text)
  if (!raw || raw.length !== bytes || (firstByte !== undefined && raw[0] !== firstByte)) {
    throw new UserError(`${name}の形が正しくありません（base64url の ${bytes} バイト）`)
  }
  return b64urlEncode(raw)
}

function argKinds(v: unknown): PushKinds {
  const o = argObject('通知の種類', v)
  return {
    sale: argBool('「売れた」の通知', o.sale),
    shipping: argBool('「発送」の通知', o.shipping),
    collect: argBool('「取り込み」の通知', o.collect),
    arrival: argBool('「仕入が届いた」の通知', o.arrival),
  }
}

// ------------------------------------------------------------
// WebApi
// ------------------------------------------------------------

/** VAPID の公開鍵（ブラウザの購読に渡す）。無い・形が正しくなければ null（画面は通知の設定を出さない） */
export async function getPushConfig(ctx: Ctx): Promise<{ vapid_public_key: string | null }> {
  const key = ctx.env.VAPID_PUBLIC_KEY?.trim()
  if (!key) return { vapid_public_key: null }
  if (!isValidVapidPublicKey(key)) {
    console.error('[push] VAPID_PUBLIC_KEY の形が正しくありません（base64url の 65 バイト）')
    return { vapid_public_key: null }
  }
  return { vapid_public_key: b64urlEncode(b64urlDecode(key)!) }
}

/**
 * この端末で通知を受け取る。同じ endpoint があれば上書きする（鍵・名前・種類を差し替える。
 * 同じ世帯の別の人がそのブラウザで入り直したときは、持ち主もいまの人に替わる）
 */
export async function savePushSubscription(ctx: Ctx, input: PushSubscriptionInput): Promise<void> {
  const i = argObject('通知の購読', input)
  const endpoint = argEndpoint(i.endpoint, true)
  const p256dh = argKey('p256dh', i.p256dh, 65, 0x04)
  const auth = argKey('auth', i.auth, 16)
  const label = argText('端末の名前', i.label, { max: LABEL_MAX }).replace(/\s+/g, ' ').trim()
  const kinds = argKinds(i.kinds)

  try {
    // 失敗しても外側のトランザクションを壊さないよう SAVEPOINT の中で
    await ctx.sql.tx((sql) => sql.run(
      `insert into push_subscription
         (user_id, endpoint, p256dh, auth, label, kind_sale, kind_shipping, kind_collect, kind_arrival)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (endpoint) do update
          set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label,
              kind_sale = excluded.kind_sale, kind_shipping = excluded.kind_shipping,
              kind_collect = excluded.kind_collect, kind_arrival = excluded.kind_arrival`,
      ctx.userId, endpoint, p256dh, auth, label, kinds.sale, kinds.shipping, kinds.collect, kinds.arrival,
    ))
  } catch (e) {
    // endpoint は全世帯で一意。同じブラウザが別の世帯に登録済みだと、その行は RLS で見えず上書きもできない
    const code = readDbError(e)?.code
    if (code === '42501' || code === '23505') {
      throw new UserError(
        'この端末は、ほかの世帯の通知にすでに登録されています。そちらで通知をやめてから、もう一度お試しください',
        'conflict',
      )
    }
    throw e
  }
}

/** この端末で受け取るのをやめる。自分の端末だけ（ほかの人の端末・無い endpoint は何もしない） */
export async function deletePushSubscription(ctx: Ctx, endpoint: string): Promise<void> {
  await ctx.sql.run('delete from push_subscription where endpoint = ? and user_id = ?', argEndpoint(endpoint), ctx.userId)
}

/** 世帯の通知の端末（配偶者の端末も出す）。`currentEndpoint` と同じものが「この端末」 */
export async function listPushDevices(ctx: Ctx, currentEndpoint: string | null): Promise<PushDevice[]> {
  const current = argOptText('この端末の宛先', currentEndpoint, { max: ENDPOINT_MAX }) ?? null
  const rows = await ctx.sql.all<{
    id: string; label: string; kind_sale: boolean; kind_shipping: boolean; kind_collect: boolean
    kind_arrival: boolean; created_at: string; is_this_device: boolean
  }>(
    `select id, label, kind_sale, kind_shipping, kind_collect, kind_arrival, created_at,
            coalesce(endpoint = ?::text, false) as is_this_device
       from push_subscription
      order by created_at, id`,
    current,
  )
  return rows.map((r) => ({
    id: r.id,
    label: r.label || '端末',
    kinds: { sale: r.kind_sale, shipping: r.kind_shipping, collect: r.kind_collect, arrival: r.kind_arrival },
    created_at: r.created_at,
    is_this_device: r.is_this_device,
  }))
}

/** 端末ごとの受け取る種類を変える。自分の端末だけ */
export async function setPushKinds(ctx: Ctx, deviceId: string, kinds: PushKinds): Promise<void> {
  const id = argId('端末', deviceId)
  const k = argKinds(kinds)
  const r = await ctx.sql.run(
    `update push_subscription
        set kind_sale = ?, kind_shipping = ?, kind_collect = ?, kind_arrival = ?
      where id = ? and user_id = ?`,
    k.sale, k.shipping, k.collect, k.arrival, id, ctx.userId,
  )
  if (r.changes === 0) throw new UserError('端末が見つかりません', 'not_found')
}

/**
 * 自分の端末すべてに試しの通知を送る（届くかの確認）。戻り値は届いた端末の数と、届かなかった端末の数。
 *
 * この API の中で、すぐ送る。判断：
 *   * 送るのは `test`（この呼び出しが積んだ 1 つの出来事）だけ。ほかの配送は取らない（取り込みや販売の通知は
 *     コミットの後に Cron が送る。コミット前に送って巻き戻ると、存在しない販売を知らせてしまうため）
 *   * トランザクションの中で外部に通信する。ここは業務の書き込みを持たない（積んだ試しの通知だけ）ので、
 *     巻き戻って困るものが無く、通信の間に握るロックも自分の配送の行だけ。通信は 1 件 10 秒まで・同時 5 本
 *   * 失敗しても Cron に再送させない（画面で「届かなかった」と見せたあとに遅れて届くと混乱する）。
 *     404 / 410 は購読ごと消える
 */
export async function sendTestPush(ctx: Ctx, deps: SendDeps = {}): Promise<{ sent: number; failed: number }> {
  let keys
  try {
    keys = await loadVapidKeys(vapidEnvOf(ctx.env))
  } catch (e) {
    if (e instanceof VapidConfigError) throw new UserError(`通知の鍵の設定が正しくありません。${e.message}`)
    throw e
  }
  if (!keys) throw new UserError('通知の鍵がサーバーに設定されていません（VAPID_PUBLIC_KEY・VAPID_PRIVATE_KEY・VAPID_SUBJECT）')

  const eventId = await enqueueNotification(ctx.sql, {
    kind: 'test',
    title: '試しの通知です',
    body: 'この通知が届いていれば、売れたときや荷物が届いたときも、この端末に知らせます',
    url: '/',
    dedupeKey: `test:${crypto.randomUUID()}`,
    userId: ctx.userId,
  })
  if (!eventId) return { sent: 0, failed: 0 }

  // claim_deliveries と同じ取り方を、この出来事の配送だけに絞って行う（自分の世帯の行しか見えない）
  const rows = await ctx.sql.all<ClaimedDelivery>(
    `with picked as (
       select id from notification_delivery
        where event_id = ? and status = 'pending'
        order by id
        limit ?
          for update
     ), claimed as (
       update notification_delivery d
          set status = 'sending', claimed_at = now(), attempts = d.attempts + 1
         from picked
        where d.id = picked.id
       returning d.id, d.household_id, d.event_id, d.subscription_id, d.attempts
     )
     select c.id as delivery_id, c.household_id, c.event_id, c.subscription_id,
            e.kind, e.title, e.body, e.url, s.endpoint, s.p256dh, s.auth, c.attempts
       from claimed c
       join notification_event e on e.household_id = c.household_id and e.id = c.event_id
       join push_subscription s on s.household_id = c.household_id and s.id = c.subscription_id
      order by c.id`,
    eventId, TEST_SEND_LIMIT,
  )

  const results = await sendClaimed(rows, keys, deps)
  let sent = 0
  let failed = 0
  for (const { row, outcome } of results) {
    const state = await completeDelivery(ctx.sql, row.delivery_id, outcome)
    if (state === 'sent') {
      sent++
      continue
    }
    failed++
    // 失敗は再送待ち（pending）になるので、諦めた扱い（failed）に変える。画面に「届かなかった」と返した通知を、
    // あとから Cron が送り直さない
    if (state === 'pending') {
      await ctx.sql.run(`update notification_delivery set status = 'failed' where id = ? and status = 'pending'`, row.delivery_id)
    }
  }
  return { sent, failed }
}

/** 契約（WebApi）の名前とのひも付け。登録は下の registerWebHandler。テストが直接引くこともある */
export const pushHandlers = {
  getPushConfig: (ctx) => getPushConfig(ctx),
  savePushSubscription: (ctx, input) => savePushSubscription(ctx, input),
  deletePushSubscription: (ctx, endpoint) => deletePushSubscription(ctx, endpoint),
  listPushDevices: (ctx, currentEndpoint) => listPushDevices(ctx, currentEndpoint),
  setPushKinds: (ctx, deviceId, kinds) => setPushKinds(ctx, deviceId, kinds),
  sendTestPush: (ctx) => sendTestPush(ctx),
} satisfies {
  [K in 'getPushConfig' | 'savePushSubscription' | 'deletePushSubscription' | 'listPushDevices' | 'setPushKinds' | 'sendTestPush']:
    (ctx: Ctx, ...args: Parameters<WebApi[K]>) => ReturnType<WebApi[K]>
}

registerWebHandler('getPushConfig', pushHandlers.getPushConfig)
registerWebHandler('savePushSubscription', pushHandlers.savePushSubscription)
registerWebHandler('deletePushSubscription', pushHandlers.deletePushSubscription)
registerWebHandler('listPushDevices', pushHandlers.listPushDevices)
registerWebHandler('setPushKinds', pushHandlers.setPushKinds)
registerWebHandler('sendTestPush', pushHandlers.sendTestPush)
