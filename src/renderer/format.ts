/**
 * 画面に数字と日付を出すときの書式。**画面ごとに書かない**（同じものが違って見えると、
 * 利用者は「どちらが正しいのか」を毎回考えることになる）。
 *
 * 金額は main が integer（円）で返したものをそのまま出すだけ。ここで計算はしない。
 */

/** 「¥1,234」「−¥268」。マイナスは全角の − を頭に付ける（¥-268 と書かない） */
export function yen(n: number): string {
  return (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')
}

/** 「+¥1,234」「−¥268」。増減を見せる欄だけで使う */
export function yenSigned(n: number): string {
  return (n < 0 ? '−' : '+') + '¥' + Math.abs(n).toLocaleString('ja-JP')
}

/** 「1,234」。点数・件数など単位を別に書く欄で使う */
export function num(n: number): string {
  return n.toLocaleString('ja-JP')
}

/** 「40%」。null はそのまま「—」 */
export function percent(n: number | null): string {
  return n == null ? '—' : `${n}%`
}

/** 「09/24」。同じ年の中で日付を並べる一覧で使う。null は「—」 */
export function shortDate(d: string | null): string {
  if (!d) return '—'
  return d.slice(5, 10).replace('-', '/')
}

/** 「2026-09-24」。YYYY-MM-DD をそのまま。null は「—」 */
export function isoDate(d: string | null): string {
  return d ? d.slice(0, 10) : '—'
}

/** 「2026-09」。月のラベル。null は「—」 */
export function monthLabel(m: string | null): string {
  return m ? m.slice(0, 7) : '—'
}

/**
 * 「09/24 21:34」。ISO（`2026-09-24T21:34` / 末尾 Z 付き）と `YYYY-MM-DD HH:mm` の両方を受ける。
 * 時刻が無ければ日付だけ。null は「—」
 */
export function dateTime(d: string | null): string {
  if (!d) return '—'
  const iso = d.includes('T') || d.includes(' ')
  if (!iso) return shortDate(d)
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return shortDate(d)
  const p2 = (v: number) => String(v).padStart(2, '0')
  return `${p2(dt.getMonth() + 1)}/${p2(dt.getDate())} ${p2(dt.getHours())}:${p2(dt.getMinutes())}`
}

/**
 * 「3日前」「2時間前」「たった今」。最終取り込みなど、正確な時刻より
 * 「どれくらい前か」が知りたい欄だけで使う。null は「—」
 */
export function sinceText(d: string | null): string {
  if (!d) return '—'
  const t = new Date(d).getTime()
  if (Number.isNaN(t)) return '—'
  const min = Math.floor((Date.now() - t) / 60000)
  if (min < 1) return 'たった今'
  if (min < 60) return `${min}分前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}時間前`
  return `${Math.floor(hour / 24)}日前`
}

/** 「2026/09/24 21:34」。年まで見せたい欄（購入日時など）。時刻が無ければ日付だけ。null は「—」 */
export function dateTimeWithYear(d: string | null): string {
  if (!d) return '—'
  const dt = new Date(d.includes('T') || d.includes(' ') ? d : `${d}T00:00`)
  if (Number.isNaN(dt.getTime())) return d
  const p2 = (v: number) => String(v).padStart(2, '0')
  const date = `${dt.getFullYear()}/${p2(dt.getMonth() + 1)}/${p2(dt.getDate())}`
  return d.includes('T') || d.includes(' ') ? `${date} ${p2(dt.getHours())}:${p2(dt.getMinutes())}` : date
}

/**
 * 今年なら「09/24」、去年より前なら「2025/09/24」。履歴のように年をまたぐ一覧で使う。
 * null のときは `empty`（既定は「—」）を返す
 */
export function smartDate(d: string | null, empty = '—'): string {
  if (!d) return empty
  const year = d.slice(0, 4)
  return year === String(new Date().getFullYear()) ? shortDate(d) : d.slice(0, 10).replace(/-/g, '/')
}
