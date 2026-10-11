import type { PlannedImage } from './images'
import type { ViewName } from './types'

// 移行の結果（突き合わせの表）。CLI が画面に出し、テストが中身を確かめる

export interface TableCheck {
  table: string
  sqlite: number
  postgres: number
  /** 読み戻した行の中身が、書いたものと違う行の数（行の欠け・余りを含む） */
  mismatched: number
  ok: boolean
  /** 補足（画像が見つからず移さなかった行、初期データとの合算など） */
  note: string
}

export interface SumCheck {
  view: ViewName
  name: string
  sqlite: number
  postgres: number
  ok: boolean
}

export interface MonthlyCheck {
  month: string
  kind: string
  sqlite: number | null
  postgres: number | null
  ok: boolean
}

export interface Mismatch {
  key: string
  problem: 'missing_in_postgres' | 'extra_in_postgres' | 'different'
  columns: Array<{ column: string; sqlite: string; postgres: string }>
}

export interface ViewCheck {
  view: ViewName
  sqliteRows: number
  postgresRows: number
  columns: number
  mismatchCount: number
  /** 先頭の数件だけ（全部は出さない） */
  mismatches: Mismatch[]
  ok: boolean
}

export interface InvariantCheck {
  name: string
  ok: boolean
  detail: string
}

export interface ImageSummary {
  /** 参照の数（画像のファイル名が入っていた行） */
  total: number
  /** 置いた（dry-run では置く予定の）数 */
  ready: number
  uploaded: number
  bytes: number
  /** 見つからなかった・名前が不正・空だった（参照を null にした） */
  missing: Array<Pick<PlannedImage, 'table' | 'column' | 'rowKey' | 'sourceFile' | 'status'>>
}

export interface MigrationReport {
  dryRun: boolean
  householdId: string
  tables: TableCheck[]
  sums: SumCheck[]
  monthly: MonthlyCheck[]
  views: ViewCheck[]
  invariants: InvariantCheck[]
  images: ImageSummary
  /** 値を直した件数（'表.列: 内容' → 件数） */
  notes: Array<{ text: string; count: number }>
  /** 移さなかったもの（理由つき） */
  notMigrated: Array<{ name: string; detail: string }>
  settings: { migrated: number; skipped: Array<{ key: string; reason: string }> }
  /** 初期の発送方法を SQLite の行で置き換えた数 */
  replacedShippingMethods: number
  ok: boolean
}

const yen = (n: number | null): string => (n === null ? '—' : n.toLocaleString('en-US'))

function renderTable(header: string[], rows: string[][], align: Array<'l' | 'r'>): string[] {
  const widths = header.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))))
  const line = (cells: string[]): string =>
    cells.map((c, i) => (align[i] === 'r' ? ' '.repeat(widths[i] - width(c)) + c : c + ' '.repeat(widths[i] - width(c)))).join('  ').trimEnd()
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)]
}

// 全角を 2 桁に数える（日本語の表をずらさないため）
function width(s: string): number {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1
  return w
}

const mark = (ok: boolean): string => (ok ? 'OK' : '不一致')

export function formatReport(r: MigrationReport): string {
  const out: string[] = []
  const h = (title: string): void => void out.push('', `■ ${title}`)

  h('表ごとの行数（SQLite → Postgres）。内容の不一致は、書いた値を読み戻して比べた結果')
  out.push(...renderTable(
    ['表', 'SQLite', 'Postgres', '内容の不一致', '結果', '補足'],
    r.tables.map((t) => [t.table, String(t.sqlite), String(t.postgres), String(t.mismatched), mark(t.ok), t.note]),
    ['l', 'r', 'r', 'r', 'l', 'l'],
  ))

  h('sale_profit の合計（円）')
  out.push(...renderTable(
    ['項目', 'SQLite', 'Postgres', '結果'],
    r.sums.filter((s) => s.view === 'sale_profit').map((s) => [s.name, yen(s.sqlite), yen(s.postgres), mark(s.ok)]),
    ['l', 'r', 'r', 'l'],
  ))

  h('monthly_summary の粗利（月・種別ごと、円）')
  out.push(...renderTable(
    ['月', '種別', 'SQLite', 'Postgres', '結果'],
    r.monthly.map((m) => [m.month, m.kind, yen(m.sqlite), yen(m.postgres), mark(m.ok)]),
    ['l', 'l', 'r', 'r', 'l'],
  ))

  h('金額のビュー 5 本の全行・全列の突き合わせ')
  out.push(...renderTable(
    ['ビュー', 'SQLite の行', 'Postgres の行', '列', '不一致', '結果'],
    r.views.map((v) => [v.view, String(v.sqliteRows), String(v.postgresRows), String(v.columns), String(v.mismatchCount), mark(v.ok)]),
    ['l', 'r', 'r', 'r', 'r', 'l'],
  ))
  for (const v of r.views) {
    if (v.ok) continue
    out.push('', `  ${v.view} の不一致（先頭 ${v.mismatches.length} 件 / 全 ${v.mismatchCount} 件）`)
    for (const m of v.mismatches) {
      const label = m.problem === 'missing_in_postgres' ? 'Postgres に無い' : m.problem === 'extra_in_postgres' ? 'Postgres にだけある' : '値が違う'
      out.push(`    [${m.key}] ${label}`)
      for (const c of m.columns) out.push(`      ${c.column}: SQLite = ${c.sqlite} / Postgres = ${c.postgres}`)
    }
  }

  h('その他の確認')
  out.push(...r.invariants.map((i) => `  ${mark(i.ok)}  ${i.name}${i.detail ? `（${i.detail}）` : ''}`))

  h('画像')
  out.push(`  参照 ${r.images.total} 件 / ${r.dryRun ? '置く予定' : '置いた'} ${r.dryRun ? r.images.ready : r.images.uploaded} 件` +
    (r.dryRun ? '（dry-run なので Storage には送っていません）' : ` / ${(r.images.bytes / 1024 / 1024).toFixed(1)} MB`))
  if (r.images.missing.length > 0) {
    out.push(`  見つからなかった画像 ${r.images.missing.length} 件（行の参照を null にしました）`)
    for (const m of r.images.missing.slice(0, 20)) out.push(`    ${m.table}.${m.column} [${m.rowKey}] ${m.sourceFile}（${m.status === 'missing' ? 'ファイルが無い' : m.status === 'empty' ? '空のファイル' : '名前が不正'}）`)
    if (r.images.missing.length > 20) out.push(`    …ほか ${r.images.missing.length - 20} 件`)
  } else {
    out.push('  見つからなかった画像: 0 件')
  }

  if (r.notes.length > 0) {
    h('値を直した件数（形が違うものを、決まりに沿って直した）')
    out.push(...r.notes.map((n) => `  ${n.text}: ${n.count} 件`))
  }

  h('設定')
  out.push(`  移した設定: ${r.settings.migrated} 件（世帯の初期値は同じキーを上書き）`)
  for (const s of r.settings.skipped) out.push(`  移さなかった: ${s.key} … ${s.reason}`)
  if (r.replacedShippingMethods > 0) out.push(`  初期の発送方法 ${r.replacedShippingMethods} 行を、SQLite の行（同じ id）で置き換えました`)

  h('移さなかったもの')
  out.push(...r.notMigrated.map((n) => `  ${n.name} … ${n.detail}`))

  out.push('', r.ok ? '■ 結果: すべて一致しました' : '■ 結果: 不一致があります（失敗。何も書き込んでいません）')
  return out.join('\n')
}
