import { safeStorage } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import * as db from './db'
import { todayLocal } from '../shared/date'
import type { AiStatus, ReceiptDraft } from '../shared/types'
import {
  buildPingBody, callGemini, DEFAULT_MODEL, extractResponseText, fetchGeminiModels, logAiError, RECEIPT_MAX_BYTES,
  receiptImageType, requestReceiptDraft, toAiErrorMessage,
} from './gemini-core'

// ============================================================
// レシート画像の読み取り（Gemini、利用者が自分の API キーで使う）。
//
// キーは safeStorage で暗号化して setting.gemini_api_key_enc に保存する
// （平文では持たない。安全な保存が使えない環境では保存自体を断る）。
// 画像は Google に送られる（CLAUDE.md「外部サービスなし」の唯一の例外。
// メルカリへの書き込み・認証情報の保存はしない方針は変えない）。
// ============================================================

const SETTING_KEY_ENC = 'gemini_api_key_enc'
const SETTING_MODEL = 'ai_model'

// ------------------------------------------------------------
// キー・モデルの設定（setting テーブル）
// ------------------------------------------------------------

function getModel(): string {
  return db.getSettings()[SETTING_MODEL] || DEFAULT_MODEL
}

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
    console.error('API キーの復号に失敗しました', e)
    return null
  }
}

export function getAiStatus(): AiStatus {
  return {
    configured: getEncodedKey() !== null,
    model: getModel(),
    safe_storage: safeStorage.isEncryptionAvailable(),
  }
}

/**
 * API キーを暗号化して保存する（null で削除）。安全な保存（safeStorage）が
 * 使えない環境では保存を断る（平文で持たない）
 */
export function setGeminiApiKey(apiKey: string | null): void {
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

/** モデル名を保存する。空文字なら既定（gemini-flash-latest）に戻す */
export function setAiModel(model: string): void {
  db.setSetting(SETTING_MODEL, model || DEFAULT_MODEL)
}

/** 保存済みキーを復号して返す。無ければ「設定がありません」の日本語エラー */
function requireApiKey(): string {
  const encoded = getEncodedKey()
  const key = encoded ? decryptStoredKey(encoded) : null
  if (!key) throw new Error('AI 読み取りの設定がありません（設定 → AI 読み取り）')
  return key
}

/**
 * 保存したキーで使える Gemini モデルの一覧を取る（generateContent 対応の
 * gemini 系のみ）。キー未設定なら requireApiKey が例外を投げる
 */
export async function listGeminiModels(): Promise<Array<{ name: string; display_name: string; description: string }>> {
  const apiKey = requireApiKey()
  try {
    return await fetchGeminiModels(apiKey)
  } catch (e) {
    logAiError('Gemini のモデル一覧の取得に失敗しました', e)
    throw new Error(toAiErrorMessage(e, getModel()))
  }
}

/** 保存したキーで最小の要求を送って疎通を確かめる */
export async function testGemini(): Promise<{ ok: boolean; message: string }> {
  let apiKey: string
  try {
    apiKey = requireApiKey()
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'AI 読み取りの設定がありません（設定 → AI 読み取り）' }
  }

  const model = getModel()
  try {
    const json = await callGemini(model, apiKey, buildPingBody(model))
    extractResponseText(json)
    return { ok: true, message: '接続できました' }
  } catch (e) {
    logAiError('Gemini への疎通確認に失敗しました', e)
    return { ok: false, message: toAiErrorMessage(e, model) }
  }
}

// ------------------------------------------------------------
// 画像 → ReceiptDraft
//
// プロンプト・応答の型・下書きへの変換は gemini-core.ts（サーバーと共用）。ここはファイルの読み込みと、キー・モデルだけ
// ------------------------------------------------------------

function loadImage(filePath: string): { mimeType: string; base64: string } {
  const type = receiptImageType(extname(filePath))
  if ('error' in type) throw new Error(type.error)
  if (statSync(filePath).size > RECEIPT_MAX_BYTES) throw new Error('画像は 10MB までにしてください')
  const base64 = readFileSync(filePath).toString('base64')
  return { mimeType: type.mimeType, base64 }
}

/** レシート画像を Gemini で読み取り、経費の下書きにする。キー未設定なら Error */
export async function readReceiptWithGemini(filePath: string): Promise<ReceiptDraft> {
  const apiKey = requireApiKey()
  const model = getModel()
  const image = loadImage(filePath)

  try {
    return await requestReceiptDraft(model, apiKey, image, todayLocal())
  } catch (e) {
    logAiError('Gemini でのレシート読み取りに失敗しました', e)
    throw new Error(toAiErrorMessage(e, model))
  }
}