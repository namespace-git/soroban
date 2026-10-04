// お金の出入りの入力欄（設定の口座・借入／月次の入出金）で共通に使うもの。
// 金額の読み取りは Sales.vue の normalizeYenInput と同じ規則（¥・円・桁区切り・全角数字は受ける、
// 小数・マイナス・壊れた表記は弾く）。Number('294円') が NaN → 0 円で保存された事故を繰り返さないため、
// 「黙って 0 にする」経路を作らない。
import type { CashAccountKind, CashCategory } from '../../shared/types'

export type YenParsed = { ok: true; value: number } | { ok: false; error: string }

/** 空欄は呼び出し側で扱う（ここに渡さない）。0 は通す（はじめの残高が 0 円のため） */
export function parseYen(raw: string): YenParsed {
  const trimmed = raw.trim()
  const halfWidth = trimmed.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  if (halfWidth.startsWith('-')) return { ok: false, error: '金額はマイナスにできません' }
  if (halfWidth.includes('.')) return { ok: false, error: '金額は整数（円）で入力してください（小数は使えません）' }
  const m = /^([¥￥])?(\d{1,3}(?:[,，]\d{3})+|\d+)(円)?$/.exec(halfWidth)
  if (!m) return { ok: false, error: `「${trimmed}」は金額として読み取れません。数字だけにしてください` }
  return { ok: true, value: Number(m[2].replace(/[,，]/g, '')) }
}

/** 1 円以上の金額。空欄・0 円・読めない表記は error を返す（画面の注意書きにそのまま出せる） */
export function parsePositiveYen(raw: string, empty = '金額を入力してください'): YenParsed {
  if (raw.trim() === '') return { ok: false, error: empty }
  const p = parseYen(raw)
  if (!p.ok) return p
  if (p.value < 1) return { ok: false, error: '1円以上で入力してください' }
  return p
}

export const ACCOUNT_KIND_LABEL: Record<CashAccountKind, string> = {
  bank: '銀行',
  flea: 'フリマの売上金',
  cash: '現金',
  other: 'その他',
}
export const ACCOUNT_KINDS: CashAccountKind[] = ['bank', 'flea', 'cash', 'other']

/** 入出金の区分の呼び方（main の CASH_CATEGORY_LABEL と同じ。履歴の 1 行ずつに出す） */
export const CASH_CATEGORY_LABEL: Record<CashCategory, string> = {
  sale_payout: 'フリマの売上金',
  purchase_payment: '仕入の支払い',
  loan_in: '借りた',
  loan_repay: '借りたお金を返した',
  tool_share: 'ツール分',
  allowance: 'お小遣い',
  expense: '経費',
  transfer: '口座間の移動',
  other: 'その他',
}

/** Electron の IPC が付ける "Error invoking remote method 'x': Error: " は人には要らない（App.vue と同じ） */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^Error invoking remote method '[^']+': /, '').replace(/^(Sqlite)?Error: /, '')
}

/** 月の末日（YYYY-MM-DD）。月を見ているときの日付の既定に使う */
export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
}
