import { safeStorage } from 'electron'
import * as db from './db'
import { getTrackInfo, registerNumbers, track17Fulfillment, track17Label, Track17Error } from './track17'
import type { TrackingApiStatus } from '../shared/types'

// ============================================================
// 17TRACK 公式 API（track17.ts）で仕入の配送状況を読む「段取り役」。
//
// メロジョイの注文詳細は「確認済み（発送準備中）」→「配達中」までしか出さず、
// 「配達済み」を出さない。追跡番号（tracking_number）は既に purchase に保存済みなので、
// それを 17TRACK の API に渡して「配達完了」と到着日を読み、到着状態に反映する。
//
// 経緯：最初は 17TRACK の画面（DOM）を BrowserWindow で読む実装だったが、実物で
// 試したところ URL のハッシュ（#nums=...）では問い合わせが走らず、ページに最初から
// 入っている無関係な見本データが返ってきた（読めたつもりで別の番号のデータを書き込む
// 事故になりかねない）。そのため公式 API（track17.ts）に切り替えた。
// このファイルは DB と track17.ts をつなぐだけで、URL 組み立てや JSON 解析はしない。
//
// 約束：
//   * BrowserWindow は使わない・作らない
//   * 無料枠を守る（register は「未登録のものだけ」。登録できた分だけ印を付ける）
//   * 収集頻度を上げない（取り込みは起動時と手動ボタンのときだけ。setInterval は持たない）
//   * API キーは safeStorage で暗号化して保存する（平文で持たない）。ログ・例外に出さない
//   * 応答に無かった番号には一切触らない（別の番号の結果を書き込む事故を防ぐ最終防波堤）
// ============================================================

const SETTING_KEY_ENC = 'track17_api_key_enc'

export interface TrackingBatchResult {
  /** 今回 17TRACK に新しく登録できた追跡番号の数（無料枠を使うのはここだけ） */
  registered: number
  /** 状況を読めた件数 */
  checked: number
  /** 到着済にした件数 */
  delivered: number
  /** 読めなかった件数（まだデータが来ていない等） */
  failed: number
  /** これ以上続けられない理由（日本語）。無ければ null */
  stopped: string | null
}

// ------------------------------------------------------------
// キーの保管（ai-receipt.ts の getEncodedKey / decryptStoredKey / setGeminiApiKey /
// getAiStatus / requireApiKey と同じ構造。設定キーの名前だけ違う）
// ------------------------------------------------------------

/** setting から暗号化済みのキー（base64）を取る。未設定・削除後は null */
function getEncodedKey(): string | null {
  const encoded = db.getSettings()[SETTING_KEY_ENC]
  return encoded ? encoded : null
}

/** 復号したAPIキー。復号できなければ null（呼び出し側で「設定がありません」に丸める） */
function decryptStoredKey(encoded: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch (e) {
    console.error('17TRACK API キーの復号に失敗しました', e)
    return null
  }
}

/**
 * API キーを暗号化して保存する（null・空文字で削除）。安全な保存（safeStorage）が
 * 使えない環境では保存を断る（平文で持たない）
 */
export function setTrack17ApiKey(apiKey: string | null): void {
  if (apiKey === null || apiKey === '') {
    db.setSetting(SETTING_KEY_ENC, '')
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('この環境では安全に保存できません')
  }
  const encrypted = safeStorage.encryptString(apiKey)
  db.setSetting(SETTING_KEY_ENC, encrypted.toString('base64'))
}

/** 設定画面に出す状態。キーそのものは返さない */
export function getTrackingApiStatus(): TrackingApiStatus {
  const counts = db.trackingCounts()
  return {
    configured: getEncodedKey() !== null,
    safe_storage: safeStorage.isEncryptionAvailable(),
    unregistered: counts.unregistered,
    watching: counts.watching,
  }
}

/** 保存済みキーを復号して返す。無ければ null（呼び出し側で分岐する） */
function readApiKey(): string | null {
  const encoded = getEncodedKey()
  return encoded ? decryptStoredKey(encoded) : null
}

// ------------------------------------------------------------
// 同時実行の直列化（画面のボタン連打と裏の取り込みが同時に無料枠を使わないよう、
// 「同時には1つだけ」のキューにする）
// ------------------------------------------------------------

let trackingChain: Promise<unknown> = Promise.resolve()

function withTrackingLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = trackingChain.then(fn, fn)
  trackingChain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 裏の取り込みから呼ばれる。キーが無ければ何もしない（正常な状態。エラーにしない）。
 * ① 未登録の追跡番号を登録（無料枠を使うのはここだけ。accepted の分だけ印を付ける）
 * ② 登録済みで未到着のものを問い合わせ、1件ずつ反映する。
 * Track17Error（止められた・キー不正等）はその場で打ち切り、それ以外の例外も飲み込んで
 * stopped に丸める（取り込み全体を落とさない）
 */
export async function checkTrackingBatch(): Promise<TrackingBatchResult> {
  return withTrackingLock(async () => {
    const result: TrackingBatchResult = { registered: 0, checked: 0, delivered: 0, failed: 0, stopped: null }

    const apiKey = readApiKey()
    if (!apiKey) return result

    try {
      const registerTargets = db.trackingRegisterCandidates()
      if (registerTargets.length > 0) {
        const { accepted } = await registerNumbers(apiKey, registerTargets.map(t => t.tracking_number))
        if (accepted.length > 0) {
          const acceptedSet = new Set(accepted.map(n => n.toUpperCase()))
          const acceptedIds = registerTargets
            .filter(t => acceptedSet.has(t.tracking_number.toUpperCase()))
            .map(t => t.id)
          db.markTrackingRegistered(acceptedIds)
          result.registered = acceptedIds.length
        }
        result.failed += registerTargets.length - accepted.length
      }

      const checkTargets = db.trackingCheckCandidates()
      if (checkTargets.length > 0) {
        const reads = await getTrackInfo(apiKey, checkTargets.map(t => t.tracking_number))
        const byNumber = new Map(reads.map(r => [r.number.toUpperCase(), r]))

        for (const target of checkTargets) {
          const read = byNumber.get(target.tracking_number.toUpperCase())
          if (!read) continue // 応答に無かった番号には触らない

          if (read.error) {
            result.failed++
            db.applyTrackingResult(target.id, {
              status_text: read.error.message || '17TRACK から状況を読めませんでした',
              fulfillment: null,
              delivered_at: null,
            })
            continue
          }

          const fulfillment = track17Fulfillment(read.status)
          const changed = db.applyTrackingResult(target.id, {
            status_text: track17Label(read.status, read.subStatus),
            fulfillment,
            delivered_at: read.status === 'Delivered' ? read.deliveredAt : null,
          })
          result.checked++
          if (fulfillment === 'delivered' && changed) result.delivered++
        }
      }
    } catch (e) {
      result.stopped = e instanceof Track17Error ? e.message : '17TRACK の確認中に問題が起きました'
    }

    return result
  })
}

/**
 * 1件だけ今すぐ確認する（画面のメンテナンス用ボタンから）。追跡番号が無ければ null。
 * 到着済（fulfillment === 'delivered'）は二度と見に行かない。保存済みの状態をそのまま返す
 * （delivered_at は新しく何も読んでいないので null）。
 * キーが無い・未登録の登録に失敗した・応答にこの番号が無い等は、人に読める日本語の
 * Error を投げる（画面がそのまま出す）
 */
export async function checkTracking(
  purchaseId: string,
): Promise<{ status_text: string | null; delivered_at: string | null } | null> {
  return withTrackingLock(async () => {
    const tracking = db.getPurchaseTracking(purchaseId)
    if (!tracking || !tracking.tracking_number) return null
    if (tracking.fulfillment === 'delivered') {
      return { status_text: tracking.tracking_status, delivered_at: null }
    }

    const apiKey = readApiKey()
    if (!apiKey) throw new Error('17TRACK の設定がありません（設定 → 配送状況）')

    if (tracking.tracking_registered_at === null) {
      const { accepted } = await registerNumbers(apiKey, [tracking.tracking_number])
      if (!accepted.some(n => n.toUpperCase() === tracking.tracking_number!.toUpperCase())) {
        throw new Error('17TRACK にこの追跡番号を登録できませんでした')
      }
      db.markTrackingRegistered([purchaseId])
    }

    const reads = await getTrackInfo(apiKey, [tracking.tracking_number])
    const read = reads.find(r => r.number.toUpperCase() === tracking.tracking_number!.toUpperCase())
    if (!read) {
      throw new Error('まだ配送会社のデータが来ていません。少し待ってからもう一度お試しください')
    }
    if (read.error) {
      throw new Error(read.error.message || 'まだ配送会社のデータが来ていません。少し待ってからもう一度お試しください')
    }

    const fulfillment = track17Fulfillment(read.status)
    const delivered_at = read.status === 'Delivered' ? read.deliveredAt : null
    db.applyTrackingResult(purchaseId, {
      status_text: track17Label(read.status, read.subStatus),
      fulfillment,
      delivered_at,
    })
    return { status_text: track17Label(read.status, read.subStatus), delivered_at }
  })
}
