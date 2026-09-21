// ============================================================
// CSV の読み書き（RFC 4180 相当）。ライブラリは使わない。
//
// 対応：`"` で囲った値・`""` エスケープ・フィールド内の改行・CRLF / LF どちらの改行も可。
// 文字コードの判定（UTF-8 / Shift_JIS）はここでは扱わない（呼び出し側でファイルを読む時点で行う）。
// ============================================================

/** CSV テキストを行×列の文字列配列にする。すべて空文字の行は読み飛ばす */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const len = src.length

  while (i < len) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false
        i += 1
        continue
      }
      field += c
      i += 1
      continue
    }
    if (c === '"') { inQuotes = true; i += 1; continue }
    if (c === ',') { row.push(field); field = ''; i += 1; continue }
    if (c === '\r') { i += 1; continue } // CRLF は \n 側で改行を確定させる
    if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      continue
    }
    field += c
    i += 1
  }
  // 末尾に改行が無いファイルの最終フィールド・最終行
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }

  return rows.filter(r => r.some(v => v.trim() !== ''))
}

function escapeField(v: string): string {
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
}

/** 行×列の文字列配列を CSV テキストにする（Excel が扱いやすいよう CRLF 区切り） */
export function toCsv(rows: string[][]): string {
  return rows.map(r => r.map(escapeField).join(',')).join('\r\n')
}
