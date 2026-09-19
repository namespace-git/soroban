// ============================================================
// ローカル日付（JST）
//
// new Date().toISOString() は UTC なので、JST の 0〜9 時に日付・月がずれる。
// 日付・月のキーを作るときは必ずこちらを使う。
// ============================================================

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** YYYY-MM-DD（ローカル時刻） */
export function todayLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** YYYY-MM（ローカル時刻） */
export function thisMonthLocal(d: Date = new Date()): string {
  return todayLocal(d).slice(0, 7)
}
