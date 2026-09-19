import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ImportResult, PurchaseDraftInput } from '../shared/types'
import { displayName, extractCode, extractMaterial, extractQuantity } from './code'
import { todayLocal } from '../shared/date'
import * as db from './db'

// ============================================================
// mellojoy-watch の購入記録を取り込む
//
// mellojoy-watch（別アプリ）が書き出す購入記録フォルダを読んで仕入の下書きを積む。
// ここでは読むだけ。書かない・消さない・メロジョイへは触らない。
// ============================================================

export interface WatchRecord {
  /** フォルダ名。同じものを二度積まないためのキー */
  importKey: string
  capturedAt: string
  items: Array<{ productTitle: string; variantTitle: string }>
}

/** mellojoy-watch が書き出す meta.json の形（読む範囲だけ） */
interface WatchMeta {
  capturedAt?: string
  simulated?: boolean
  purchaseItems?: Array<{ productTitle?: string; variantTitle?: string }>
}

export function defaultWatchDir(): string {
  return join(app.getPath('appData'), 'mellojoy-watch', 'debug')
}

/**
 * dir 直下のサブフォルダ（例 2026-09-19_120346_50490503725296）ごとに meta.json を読む。
 * purchaseItems が空・meta.json なし・JSON不正のフォルダは errors に積んでスキップする。
 * simulated: true（テスト購入）のフォルダは黙ってスキップする（エラーではない）。
 */
export function readWatchRecords(dir: string): { records: WatchRecord[]; errors: string[] } {
  const records: WatchRecord[] = []
  const errors: string[] = []

  if (!existsSync(dir)) {
    errors.push(`${dir}: フォルダが見つかりません`)
    return { records, errors }
  }

  const entries = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory())

  for (const entry of entries) {
    const importKey = entry.name
    const metaPath = join(dir, importKey, 'meta.json')

    if (!existsSync(metaPath)) {
      errors.push(`${importKey}: meta.jsonがありません`)
      continue
    }

    let meta: WatchMeta
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as WatchMeta
    } catch {
      errors.push(`${importKey}: meta.jsonの形式が不正です`)
      continue
    }

    if (meta.simulated === true) continue

    const purchaseItems = meta.purchaseItems
    if (!Array.isArray(purchaseItems) || purchaseItems.length === 0) {
      errors.push(`${importKey}: purchaseItemsが空です`)
      continue
    }

    records.push({
      importKey,
      capturedAt: meta.capturedAt ?? new Date().toISOString(),
      items: purchaseItems.map(it => ({
        productTitle: it.productTitle ?? '',
        variantTitle: it.variantTitle ?? '',
      })),
    })
  }

  return { records, errors }
}

/**
 * 購入記録1件を仕入の下書きに変換する。価格はまだ無いので unit_price は持たない。
 * 同じ model_code の item が複数あれば数量を合算して1明細にする。
 */
export function toDraft(rec: WatchRecord, shopAccountId: string): PurchaseDraftInput {
  const ordered_at = todayLocal(new Date(rec.capturedAt))

  const lines: PurchaseDraftInput['lines'] = []
  const byModelCode = new Map<string, PurchaseDraftInput['lines'][number]>()

  for (const item of rec.items) {
    const code = extractCode(item.productTitle, item.variantTitle)
    const material = extractMaterial(`${item.variantTitle} ${item.productTitle}`)
    const quantity = extractQuantity(item.variantTitle)
    const name = displayName(item.productTitle, item.variantTitle)

    const existing = code ? byModelCode.get(code.model_code) : undefined
    if (existing) {
      existing.quantity += quantity
      continue
    }

    const line = {
      name,
      quantity,
      model_code: code?.model_code ?? null,
      series_code: code?.series_code ?? null,
      material,
    }
    if (code) byModelCode.set(code.model_code, line)
    lines.push(line)
  }

  return {
    import_key: rec.importKey,
    shop_account_id: shopAccountId,
    ordered_at,
    lines,
    note: `mellojoy-watch ${rec.importKey}`,
  }
}

/**
 * mellojoy-watch の購入記録を読んで下書きを積む。既知の import_key は飛ばす。
 * ディレクトリが無い・仕入先アカウントが無い場合も例外にせず errors で返す。
 */
export function importPurchaseDrafts(): ImportResult {
  const settings = db.getSettings()
  const dir = settings.mellojoy_watch_dir || defaultWatchDir()

  const result: ImportResult = { scanned: 0, created: 0, skipped: 0, errors: [] }

  if (!existsSync(dir)) {
    result.errors.push(`${dir}: フォルダが見つかりません`)
    return result
  }

  let shopAccountId = settings.mellojoy_default_account_id
  if (!shopAccountId) {
    const mellojoy = db.listShopAccounts().find(a => a.kind === 'mellojoy')
    if (!mellojoy) {
      result.errors.push('メロジョイの仕入先アカウントがありません。仕入タブで追加してください')
      return result
    }
    shopAccountId = mellojoy.id
  }

  const { records, errors } = readWatchRecords(dir)
  result.errors.push(...errors)
  // 記録として成立した/しなかったフォルダの数（simulatedの黙ったスキップは含まない）
  result.scanned = records.length + errors.length

  for (const rec of records) {
    const id = db.createPurchaseDraft(toDraft(rec, shopAccountId))
    if (id) result.created++
    else result.skipped++
  }

  return result
}
