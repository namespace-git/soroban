import { createPostgresSql } from '../../server/db/postgres'
import type { Sql } from '../../server/db/sql'
import { runTrackingBatch, type TrackingRunResult } from '../../server/cron/tracking'
import { drainDeliveries, type DrainResult } from '../../server/push/deliver'

// 定期実行の Worker（Cloudflare Cron Trigger・5 分ごと）。Pages Functions には定期実行が無く、waitUntil は応答から
// 30 秒で切られるので、「待っている仕事」はここで片付ける。設計：docs/web/03-agent-and-push.md の 3 節。手順：docs/web/01-setup.md の 2-6。
//
// 1 回の中で、この順に行う（どれかが失敗しても、残りは続ける。失敗は console.error に原因だけ残す）：
//   ① 期限切れの取り込み要求の片付け … app.reap_stale_collect_jobs()（soroban_cron）
//   ② 17TRACK の確認                 … runTrackingBatch（積まれた仕事を少数のバッチで。秒間 3 リクエストは守る）
//   ③ 通知の送信                     … drainDeliveries（送る番が来た配送を Push サービスへ）
// CPU を食う仕事（通知は 1 件ごとに ECDH・ECDSA・AES の計算）を最後に置く＝CPU の上限で呼び出しが打ち切られても、
// ① ② は済んでいる。無料枠の CPU（10ms）は通知の暗号で超えうる。足りなければ Workers Paid にする。
//
// 設定（Cloudflare の Worker の設定。**秘密の値はこのリポジトリに書かない**）：
//   HYPERDRIVE          … Hyperdrive のバインディング（wrangler.toml に id を書く）。DB への接続はこれだけ
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY(秘密) / VAPID_SUBJECT … Web Push の鍵。無ければ ③ は何もしない
//   SECRET_KEYS(秘密)   … API キーの暗号化の鍵。② が 17TRACK の API キーを読むのに要る。無ければ ② は飛ばす
// 互換性フラグ `nodejs_compat` が要る（postgres.js が Node の API を使う）。
//
// @cloudflare/workers-types は入れていない（入口と同じく、使う分だけ自前で書く）。

export interface CronEnv {
  HYPERDRIVE?: { connectionString: string }
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
  SECRET_KEYS?: string
}

// ------------------------------------------------------------
// 外部への通信の割り振り
//
// Workers の無料枠は、1 回の呼び出しで外部への通信（subrequest）が 50 本まで。DB は Hyperdrive 経由のソケットで、ここには数えない。
// 外部へ出るのは ②（17TRACK）と ③（Push サービス）だけなので、合計が 50 を超えないように割り振る：
//
//   ② 17TRACK     15 本まで … runTrackingBatch の maxRequests。5xx の再送も 1 本と数える（上限に達したら送らず、
//                              積んだまま次の実行で続ける）。1 回の register / gettrackinfo は 40 件まで入るので、
//                              15 本あれば数百件の仕入を見られる
//   ③ 通知の送信   10 本まで … drainDeliveries の limit。1 配送＝1 回の POST で、失敗した分はこの中で送り直さず、
//                              complete_delivery が次の実行に回す。控えめなのは CPU のため（上の注意）。
//                              5 分ごとなので 1 時間で 120 件送れる。端末 4 台なら 2 件の出来事を 1 回で送れる
//   予備           25 本    … 数え間違い・想定外の通信のぶん（② ③ の上限の合計は 25 本）
// ------------------------------------------------------------

/** Workers（無料枠）の 1 回の呼び出しで使える外部通信の本数 */
export const SUBREQUEST_LIMIT = 50
/** ③ で取る配送の数（＝Push サービスへの通信の上限）。1 件ごとの暗号の CPU が重いので控えめ */
export const PUSH_LIMIT = 10
/** ② で 17TRACK に送る HTTP の上限（再試行込み） */
export const TRACKING_MAX_REQUESTS = 15

export type CronJobName = 'reap' | 'push' | 'tracking'

export interface CronResult {
  /** 片付けた取り込み要求の数。失敗したら null */
  reaped: number | null
  /** 通知の送信の結果。失敗したら null */
  push: DrainResult | null
  /** 17TRACK の確認の結果。失敗・飛ばした（SECRET_KEYS が無い）ときは null */
  tracking: TrackingRunResult | null
  /** 失敗した仕事。他の仕事は続けた */
  failed: CronJobName[]
}

export interface CronDeps {
  /** 外部（Push サービス・17TRACK）への通信。省略時はグローバルの fetch */
  fetch?: typeof fetch
  /** 17TRACK の待ち（再試行・秒間 3 の間隔）。省略時は setTimeout */
  sleep?: (ms: number) => Promise<void>
  /** 17TRACK の時計（ミリ秒）。省略時は Date.now */
  now?: () => number
  /** 以下の 3 つの仕事は、テストが差し替える。省略時は本物 */
  reap?: typeof reapStaleCollectJobs
  drain?: typeof drainDeliveries
  track?: typeof runTrackingBatch
}

/** ① 期限切れの取り込み要求を片付ける。片付けた数を返す（soroban_cron は世帯をまたいで、この関数だけを呼べる） */
export async function reapStaleCollectJobs(root: Sql): Promise<number> {
  return root.tx(async (sql) => {
    await sql.run('set local role soroban_cron')
    const row = await sql.get<{ n: number }>('select app.reap_stale_collect_jobs() as n')
    return row?.n ?? 0
  })
}

/**
 * 1 回分の仕事。root は接続ロールの Sql（トランザクションの外）。例外は投げない（失敗は result.failed に入れて続ける）。
 * 接続は呼び出し側が閉じる。
 */
export async function runCron(root: Sql, env: CronEnv, deps: CronDeps = {}): Promise<CronResult> {
  const reap = deps.reap ?? reapStaleCollectJobs
  const drain = deps.drain ?? drainDeliveries
  const track = deps.track ?? runTrackingBatch
  const result: CronResult = { reaped: null, push: null, tracking: null, failed: [] }

  // 失敗の原因だけを残す。秘密（VAPID_PRIVATE_KEY・SECRET_KEYS・API キー）はエラーの文に入っていない
  // （鍵の読み取りの例外は値を含めない作り）が、念のため文だけ（スタック・引数・オブジェクトは出さない）
  const fail = (job: CronJobName, e: unknown) => {
    result.failed.push(job)
    console.error(`[cron] ${job} に失敗しました`, e instanceof Error ? `${e.name}: ${e.message}` : 'error')
  }

  try {
    result.reaped = await reap(root)
  } catch (e) {
    fail('reap', e)
  }

  if (env.SECRET_KEYS === undefined || env.SECRET_KEYS.trim() === '') {
    // 17TRACK の API キーは SECRET_KEYS で暗号化してある。鍵が無いと読めないので、飛ばす（毎回の失敗にしない）
    console.warn('[cron] SECRET_KEYS が設定されていないので、17TRACK の確認を飛ばしました')
  } else {
    try {
      result.tracking = await track(root, {
        secretKeys: env.SECRET_KEYS,
        maxRequests: TRACKING_MAX_REQUESTS,
        fetch: deps.fetch,
        sleep: deps.sleep,
        now: deps.now,
      })
    } catch (e) {
      fail('tracking', e)
    }
  }

  // 通知は最後（1 件ごとの暗号で CPU を食う。上限で打ち切られても、上の仕事は済んでいる）
  try {
    // 鍵が無ければ何もしない。形が違えば drainDeliveries が理由（鍵の値は含めない）をログに出して何もしない
    result.push = await drain(root, env, { limit: PUSH_LIMIT, fetch: deps.fetch })
  } catch (e) {
    fail('push', e)
  }
  return result
}

interface ScheduledEventLike {
  cron: string
  scheduledTime: number
}

export default {
  async scheduled(_event: ScheduledEventLike, env: CronEnv): Promise<void> {
    const url = env.HYPERDRIVE?.connectionString
    if (!url) {
      console.error('[cron] HYPERDRIVE が設定されていません（wrangler.toml の [[hyperdrive]] の id を確認してください）')
      return
    }
    // Workers は接続を呼び出しをまたいで使えない。1 回の実行で 1 接続（Hyperdrive 前提なので prepare ありのまま）
    const db = createPostgresSql(url, { prepare: true })
    try {
      await runCron(db, env)
    } finally {
      await db.end().catch(() => {})
    }
  },
}
