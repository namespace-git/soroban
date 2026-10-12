import type { Ctx } from '../context'
import { UserError } from '../errors'
import { registerHandler } from '../rpc'
import type { AiStatus, TrackingApiStatus, TrackingCheckSummary } from '../../src/shared/types'
import {
  buildPingBody, callGemini, DEFAULT_MODEL, extractResponseText, fetchGeminiModels, isValidModelName, logAiError,
  toAiErrorMessage,
} from '../../src/main/gemini-core'
import { enqueueTracking } from '../cron/tracking-queue'
import { readLastTrackingSummary } from '../cron/tracking-summary'
import {
  deleteSecret, parseSecretKeys, putSecret, readSecretAndRefresh, SECRET_GEMINI, SECRET_TRACK17, SecretKeysError,
  type KeyRing,
} from '../secrets'
import { setSetting } from './master'
import { getPurchaseTracking, trackingCounts } from './purchase'

// ============================================================
// 外部サービスの設定（17TRACK・Gemini）。画面の API の口。
//
// API キーは setting_secret に AES-256-GCM で暗号化して持つ（server/secrets。鍵は環境変数 SECRET_KEYS）。
// **キーを getSettings に出さない・ログに出さない・エラー文に出さない。** 復号できなければ「入れ直してください」。
// SECRET_KEYS が無い／形が違う環境では保存を断る（平文で持たない。画面には safe_storage: false で伝わる）。
//
// 17TRACK：実際に聞くのは定期実行（server/cron/tracking.ts）だけ。ここの checkTracking は「確認する番」を積むだけ。
// 取り込みの終わりが未到着の分をまとめて積むときは enqueueAllTracking を呼ぶ（下で再エクスポート）。
// ============================================================

/**
 * この領域がテストで差し替える外部とのやりとり。入口は渡さない（省略時はグローバルの fetch・setTimeout）。
 * SECRET_KEYS（版:鍵 のカンマ区切り。先頭が今の鍵）は `ctx.env.SECRET_KEYS` から読む（生の文字列。形の検査はここで行う）
 */
export interface IntegrationDeps {
  /** 外部（Gemini）への通信。省略時はグローバルの fetch（テストが差し替える） */
  fetch?: typeof fetch
  /** 再試行の待ち。省略時は setTimeout（テストが差し替える） */
  sleep?: (ms: number) => Promise<void>
}

export type IntegrationCtx = Ctx & IntegrationDeps

export { enqueueAllTracking, enqueueTracking } from '../cron/tracking-queue'

/** 保存・復号に使う鍵の束。SECRET_KEYS が無い／形が違うなら null（原因は鍵の中身を含まずにログへ） */
function keyRingOf(ctx: IntegrationCtx): KeyRing | null {
  try {
    return parseSecretKeys(ctx.env.SECRET_KEYS)
  } catch (e) {
    if (e instanceof SecretKeysError) {
      console.error(e.message)
      return null
    }
    throw e
  }
}

const NO_SAFE_STORAGE = 'この環境では安全に保存できません（サーバーの SECRET_KEYS の設定を確認してください）'

/** API キーとして受け付ける形：印字できる ASCII だけ（ヘッダーに入れるので、空白・改行・日本語は入れない） */
const API_KEY_FORM = /^[\x21-\x7e]{1,300}$/

/** 保存する（null・空文字で削除）。入力のキーはエラー文にも出さない */
async function saveApiKey(ctx: IntegrationCtx, name: string, key: unknown): Promise<void> {
  if (key !== null && key !== undefined && typeof key !== 'string') throw new UserError('API キーは文字で入力してください')
  const value = typeof key === 'string' ? key.trim() : ''
  if (value === '') {
    await deleteSecret(ctx, name)
    return
  }
  if (!API_KEY_FORM.test(value)) {
    throw new UserError('API キーの形が正しくありません（英数字と記号だけ。空白や改行は入れられません）')
  }
  const ring = keyRingOf(ctx)
  if (!ring) throw new UserError(NO_SAFE_STORAGE)
  await putSecret(ctx, ring, name, value)
}

/** 保存したキーが使える状態か（保存されていて、復号できる）。古い版の鍵で書かれていれば今の鍵に書き直す */
async function isUsable(ctx: IntegrationCtx, name: string): Promise<boolean> {
  const ring = keyRingOf(ctx)
  if (!ring) return false
  return (await readSecretAndRefresh(ctx, ring, name)).status === 'ok'
}

// ------------------------------------------------------------
// 17TRACK
// ------------------------------------------------------------

/** checkTracking が返す status_text。定期実行で確かめるので、いま分かる状態ではない */
export const TRACKING_QUEUED_TEXT = '確認待ち（次の定期実行で確かめます）'

/** 設定画面に出す状態。キーそのものは返さない */
export async function getTrackingApiStatus(ctx: IntegrationCtx): Promise<TrackingApiStatus> {
  const counts = await trackingCounts(ctx)
  return {
    configured: await isUsable(ctx, SECRET_TRACK17),
    safe_storage: keyRingOf(ctx) !== null,
    unregistered: counts.unregistered,
    watching: counts.watching,
  }
}

/** 17TRACK の API キーを暗号化して保存する（null・空文字で削除）。getSettings には出ない */
export async function setTrack17ApiKey(ctx: IntegrationCtx, key: string | null): Promise<void> {
  await saveApiKey(ctx, SECRET_TRACK17, key)
}

/**
 * この仕入の配送状況の確認を**予約する**（すぐには 17TRACK に聞かない。次の定期実行で確かめる）。
 * - 追跡番号が無い・無い仕入は null
 * - 到着済みは二度と聞かない（保存済みの状態をそのまま返す）
 * - API キーが無い／読み出せないときは、人に読める日本語で断る（積んでも確かめられないため）
 */
export async function checkTracking(
  ctx: IntegrationCtx, purchaseId: string,
): Promise<{ status_text: string | null; delivered_at: string | null } | null> {
  const tracking = await getPurchaseTracking(ctx, purchaseId)
  if (!tracking || !tracking.tracking_number || tracking.tracking_number.trim() === '') return null
  if (tracking.fulfillment === 'delivered') return { status_text: tracking.tracking_status, delivered_at: null }

  const ring = keyRingOf(ctx)
  if (!ring) throw new UserError(NO_SAFE_STORAGE)
  const read = await readSecretAndRefresh(ctx, ring, SECRET_TRACK17)
  if (read.status === 'missing') throw new UserError('17TRACK の設定がありません（設定 → 配送状況）')
  if (read.status === 'unreadable') {
    throw new UserError('17TRACK の API キーを読み出せません。設定 → 配送状況 でキーを入れ直してください')
  }
  await enqueueTracking(ctx, purchaseId)
  return { status_text: TRACKING_QUEUED_TEXT, delivered_at: null }
}

/** 直近の確認結果（定期実行が残したもの）。まだ確認していなければ null */
export async function getLastTrackingSummary(ctx: IntegrationCtx): Promise<TrackingCheckSummary | null> {
  return readLastTrackingSummary(ctx)
}

// ------------------------------------------------------------
// Gemini
// ------------------------------------------------------------

async function readModel(ctx: IntegrationCtx): Promise<string> {
  const row = await ctx.sql.get<{ value: string }>(`select value from setting where key = 'ai_model'`)
  return row?.value && isValidModelName(row.value) ? row.value : DEFAULT_MODEL
}

export async function getAiStatus(ctx: IntegrationCtx): Promise<AiStatus> {
  return {
    configured: await isUsable(ctx, SECRET_GEMINI),
    model: await readModel(ctx),
    safe_storage: keyRingOf(ctx) !== null,
  }
}

/** Gemini の API キーを暗号化して保存する（null・空文字で削除）。getSettings には出ない */
export async function setGeminiApiKey(ctx: IntegrationCtx, key: string | null): Promise<void> {
  await saveApiKey(ctx, SECRET_GEMINI, key)
}

/** モデル名を保存する。空文字なら既定（gemini-flash-latest）に戻す */
export async function setAiModel(ctx: IntegrationCtx, model: string): Promise<void> {
  if (model !== null && model !== undefined && typeof model !== 'string') throw new UserError('モデル名は文字で入力してください')
  const name = typeof model === 'string' ? model.trim() : ''
  if (name !== '' && !isValidModelName(name)) {
    throw new UserError('モデル名は英数字と . _ - だけで入力してください（例：gemini-flash-latest）')
  }
  await setSetting(ctx, 'ai_model', name || DEFAULT_MODEL)
}

/**
 * 保存したキーとモデルを返す。無ければ・読み出せなければ日本語の UserError。
 * レシート読み取り（readReceipt）も、これでキーを取って gemini-core の callGemini を呼ぶ
 */
export async function requireGeminiCredentials(ctx: IntegrationCtx): Promise<{ apiKey: string; model: string }> {
  const ring = keyRingOf(ctx)
  if (!ring) throw new UserError(NO_SAFE_STORAGE)
  const read = await readSecretAndRefresh(ctx, ring, SECRET_GEMINI)
  if (read.status === 'missing') throw new UserError('AI 読み取りの設定がありません（設定 → AI 読み取り）')
  if (read.status === 'unreadable') {
    throw new UserError('AI 読み取りの API キーを読み出せません。設定 → AI 読み取り でキーを入れ直してください')
  }
  return { apiKey: read.value, model: await readModel(ctx) }
}

/** 保存したキーで最小の要求を 1 回だけ送って疎通を確かめる。失敗は例外にせず { ok: false, message } で返す */
export async function testGemini(ctx: IntegrationCtx): Promise<{ ok: boolean; message: string }> {
  let credentials: { apiKey: string; model: string }
  try {
    credentials = await requireGeminiCredentials(ctx)
  } catch (e) {
    if (e instanceof UserError) return { ok: false, message: e.message }
    throw e
  }
  const { apiKey, model } = credentials
  try {
    const json = await callGemini(model, apiKey, buildPingBody(model), { fetch: ctx.fetch, sleep: ctx.sleep })
    extractResponseText(json)
    return { ok: true, message: '接続できました' }
  } catch (e) {
    logAiError('Gemini への疎通確認に失敗しました', e)
    return { ok: false, message: toAiErrorMessage(e, model) }
  }
}

/** このキーで使えるモデルの一覧（generateContent 対応のもの）。キー未設定なら日本語の UserError */
export async function listGeminiModels(
  ctx: IntegrationCtx,
): Promise<Array<{ name: string; display_name: string; description: string }>> {
  const { apiKey, model } = await requireGeminiCredentials(ctx)
  try {
    return await fetchGeminiModels(apiKey, { fetch: ctx.fetch })
  } catch (e) {
    logAiError('Gemini のモデル一覧の取得に失敗しました', e)
    throw new UserError(toAiErrorMessage(e, model))
  }
}

// ------------------------------------------------------------
// 登録
// ------------------------------------------------------------

registerHandler('getTrackingApiStatus', (ctx) => getTrackingApiStatus(ctx))
registerHandler('setTrack17ApiKey', (ctx, key) => setTrack17ApiKey(ctx, key))
registerHandler('checkTracking', (ctx, purchaseId) => checkTracking(ctx, purchaseId))
registerHandler('getLastTrackingSummary', (ctx) => getLastTrackingSummary(ctx))
registerHandler('getAiStatus', (ctx) => getAiStatus(ctx))
registerHandler('setGeminiApiKey', (ctx, key) => setGeminiApiKey(ctx, key))
registerHandler('setAiModel', (ctx, model) => setAiModel(ctx, model))
registerHandler('testGemini', (ctx) => testGemini(ctx))
registerHandler('listGeminiModels', (ctx) => listGeminiModels(ctx))
