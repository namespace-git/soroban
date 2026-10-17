import type { Sql } from './db/sql'

/**
 * 業務ロジックが読む環境変数（Cloudflare の環境変数。入口が `serverEnvFrom` で整えて `Ctx.env` に載せる）。
 * 無い・空のものは null。
 *
 * **VAPID_PRIVATE_KEY と SECRET_KEYS は秘密。** ログ・エラー文・応答に出さない（読むのは `server/push`・`server/secrets` だけ）。
 * `Ctx` を丸ごと JSON にしたり console に出したりしないこと
 */
export interface ServerEnv {
  /** 例 https://xxxx.supabase.co 。公開してよい値 */
  SUPABASE_URL: string | null
  /**
   * Supabase の anon キー（公開してよい値。ブラウザにも入っている）。Storage の REST を、要求した人の JWT で呼ぶときの
   * `apikey` ヘッダーに付ける（server/storage.ts）。無ければ画像の署名・削除・読み出しはできない（帳簿の読み書きは動く）
   */
  SUPABASE_ANON_KEY: string | null
  /** Web Push の公開鍵（base64url の 65 バイト）。公開してよい値（画面の購読に渡す） */
  VAPID_PUBLIC_KEY: string | null
  /** 秘密。Web Push の署名鍵（base64url の 32 バイト） */
  VAPID_PRIVATE_KEY: string | null
  /** Web Push の連絡先（`mailto:` か `https://`） */
  VAPID_SUBJECT: string | null
  /** 秘密。API キーを暗号化する鍵の束（`版:鍵` のカンマ区切り） */
  SECRET_KEYS: string | null
}

/** 入口が受け取る生の環境変数（Cloudflare の `env` のうち、ここで読むもの）。値が無ければ undefined */
export type RawServerEnv = { [K in keyof ServerEnv]?: string }

/** 何も設定されていない環境。テストと、環境を渡していない呼び出しの既定 */
export const EMPTY_SERVER_ENV: ServerEnv = Object.freeze({
  SUPABASE_URL: null,
  SUPABASE_ANON_KEY: null,
  VAPID_PUBLIC_KEY: null,
  VAPID_PRIVATE_KEY: null,
  VAPID_SUBJECT: null,
  SECRET_KEYS: null,
})

/** 生の環境変数を `ServerEnv` にする。前後の空白を落とし、空・文字でないものは null */
export function serverEnvFrom(raw: RawServerEnv | null | undefined): ServerEnv {
  const pick = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
  return {
    SUPABASE_URL: pick(raw?.SUPABASE_URL),
    SUPABASE_ANON_KEY: pick(raw?.SUPABASE_ANON_KEY),
    VAPID_PUBLIC_KEY: pick(raw?.VAPID_PUBLIC_KEY),
    VAPID_PRIVATE_KEY: pick(raw?.VAPID_PRIVATE_KEY),
    VAPID_SUBJECT: pick(raw?.VAPID_SUBJECT),
    SECRET_KEYS: pick(raw?.SECRET_KEYS),
  }
}

/** 外部への通信の差し替え口（テスト用）。入口は渡さない（省略すればグローバルの fetch・setTimeout） */
export interface Net {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

/** 業務ロジックが受け取る文脈。`sql` は世帯のトランザクションの中（RLS が効くロール）の Sql */
export interface Ctx extends Net {
  sql: Sql
  householdId: string
  userId: string
  /**
   * 商品の写真（公開バケット media）の URL の頭。`${SUPABASE_URL}/storage/v1/object/public/media`。
   * SUPABASE_URL が無ければ null（画像の URL は返さない）。URL は `_shared.ts` の `mediaUrl` で作る
   */
  mediaBase: string | null
  /** 環境変数（VAPID_*・SECRET_KEYS など）。入口が渡す。渡していなければ全部 null（鍵なし＝通知も API キーの保存も使えない） */
  env: ServerEnv
  /**
   * 要求した人のアクセストークン（認証で検証済みのもの）。Storage の REST をその人の権限で呼ぶのに使う（server/storage.ts）。
   * 取り込み担当の PC（agent）の要求・定期実行では null。**メモリだけ。ログ・応答・エラー文に出さない**
   */
  userJwt: string | null
  /**
   * コミットの**後**に走らせる後始末を積む（Storage のファイルを消すなど）。
   * ロールバックされたら走らない。後始末が失敗しても帳簿は巻き戻さない（失敗はログだけ。例外は呼び出し元に出ない）。
   * 積んだ順に 1 つずつ実行する
   */
  afterCommit(task: () => Promise<void>): void
}

/** `withHousehold` に渡す、その要求の持ち主と環境 */
export interface HouseholdIds extends Net {
  householdId: string
  userId: string
  /** 要求した人のアクセストークン（認証済みのもの）。agent・定期実行は渡さない（null） */
  userJwt?: string | null
  mediaBase?: string | null
  env?: ServerEnv
}

/**
 * `Ctx.afterCommit` の中身。`add` を ctx に渡し、トランザクションが**コミットされた後**に `run` を呼ぶ。
 * 後始末の失敗は握りつぶしてログに残す（原因の名前とメッセージだけ。トークン・鍵は出さない）
 */
export function newAfterCommit(): { add: Ctx['afterCommit']; run: () => Promise<void> } {
  const tasks: Array<() => Promise<void>> = []
  return {
    add: (task) => { tasks.push(task) },
    async run() {
      for (const task of tasks.splice(0)) {
        try {
          await task()
        } catch (e) {
          console.error('[afterCommit] コミット後の後始末に失敗しました', e instanceof Error ? `${e.name}: ${e.message}` : 'error')
        }
      }
    },
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 環境変数 SUPABASE_URL から、公開バケット media の URL の頭を作る。無ければ null */
export function mediaBaseFromEnv(env: { SUPABASE_URL?: string | null }): string | null {
  const base = env.SUPABASE_URL?.trim().replace(/\/+$/, '')
  return base ? `${base}/storage/v1/object/public/media` : null
}

/**
 * トランザクションに入った直後の設定。**1 本の select** で全部行う（DB との往復を 3 回から 1 回にするため）。
 *
 *   - `search_path` を `app, public` に
 *   - `role` を `soroban_api` に … BYPASSRLS を持たないロールに切り替える（ここから RLS が効く）
 *   - `app.household_id` / `app.user_id` に、その要求の世帯と人を
 *
 * どれも `set_config(名前, 値, true)`。**第 3 引数 true＝`SET LOCAL` と同じ**で、トランザクションが終われば
 * （commit でも rollback でも）元に戻る（PostgREST も `role` をこの形で切り替えている）。
 *
 * set_config は左から順に評価されるが、**この順番には依存しない**：4 つは互いの値を読まず、
 * `soroban_api` に切り替わった後でも `search_path` と `app.*` は誰でも設定できる。
 * （以前の 3 本の文と同じ並びにしてあるが、入れ替えても結果は同じ）
 *
 * 引数は世帯と人の 2 つだけ（`?` は 2 個）。`search_path` と `role` は固定の文字列で、利用者の値を混ぜない。
 */
const ENTER_HOUSEHOLD_SQL =
  "select set_config('search_path', 'app, public', true), set_config('role', 'soroban_api', true), " +
  "set_config('app.household_id', ?, true), set_config('app.user_id', ?, true)"

/**
 * **1 リクエスト＝1 トランザクション**で、その世帯として動く。
 *
 * 入ってすぐ、`ENTER_HOUSEHOLD_SQL`（上）の 1 本で `search_path`・`role`（RLS が効く soroban_api）・
 * `app.household_id`・`app.user_id` を **local で**設定する。
 *
 * **local はトランザクションが終われば（commit でも rollback でも）消える。`set`（local なし）や
 * `set_config` の第 3 引数 false は使わない。** プーラ越しで次の人の接続に世帯が残らないための約束。
 *
 * `root` は接続ロールの Sql で、**トランザクションの外**のもの（入れ子で呼ばない。
 * 呼ぶと role の切り替えが外側のトランザクションの終わりまで残る）。
 * fn が例外を投げればロールバックされ、そのまま再スローされる。
 */
export async function withHousehold<T>(
  root: Sql,
  ids: HouseholdIds,
  fn: (ctx: Ctx) => Promise<T>,
): Promise<T> {
  // set_config に渡る値。uuid 以外は入れない（RLS の policy が ::uuid で読むので、変な値は別のエラーになる前にここで断る）
  const householdId = asUuid(ids.householdId, 'householdId')
  const userId = asUuid(ids.userId, 'userId')
  const env = ids.env ?? EMPTY_SERVER_ENV
  // mediaBase を直接渡したときはそちらが先（テスト用）。渡さなければ env の SUPABASE_URL から作る
  const mediaBase = ids.mediaBase !== undefined ? ids.mediaBase : mediaBaseFromEnv(env)
  const after = newAfterCommit()
  const result = await root.tx(async (sql) => {
    await sql.get(ENTER_HOUSEHOLD_SQL, householdId, userId)
    return fn({
      sql, householdId, userId, mediaBase, env,
      userJwt: ids.userJwt ?? null, afterCommit: after.add, fetch: ids.fetch, sleep: ids.sleep,
    })
  })
  // ここに来た＝コミットされた（ロールバックなら例外でここには来ない）。積んだ後始末を走らせる
  await after.run()
  return result
}

function asUuid(value: string, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`withHousehold: ${name} が uuid ではありません`)
  return value.toLowerCase()
}
