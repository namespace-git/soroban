import { randomUUID } from 'node:crypto'
import type { Sql } from '../../server/db/sql'
import { convertSnapshot, type ConvertedData } from './convert'
import {
  planImages, removeUploaded, uploadImages,
  type ImagePlan, type ImageSource, type ImageUploader, type PlannedImage,
} from './images'
import type { MigrationReport } from './report'
import { MIN_SCHEMA_VERSION, SKIPPED_TABLES } from './spec'
import type { SourceSnapshot } from './types'
import { verifyMigration } from './verify'
import { assertHouseholdEmpty, loadColumnInfo, withHouseholdRole, writeAll } from './write'

export interface MigrateInput {
  /** 接続した Sql（トランザクションの外）。本番は createPostgresSql、dry-run とテストは PGlite */
  sql: Sql
  /** 書き込み先の世帯（すでにある。app.create_household で作ったもの） */
  householdId: string
  snapshot: SourceSnapshot
  images: {
    source: ImageSource
    /** null なら画像は置かない（dry-run）。対応表は作る */
    uploader: ImageUploader | null
  }
  dryRun?: boolean
  /** パスと出品の uuid の元。既定は crypto.randomUUID（推測できないこと） */
  newId?: () => string
  log?: (line: string) => void
}

export interface MigrateOutput {
  report: MigrationReport
  /** 元のファイル → 新しいパスの対応表（見つからなかったものを含む） */
  images: PlannedImage[]
}

/** 突き合わせで 1 つでも違った。トランザクションは巻き戻してある（何も書き込んでいない） */
export class MigrationVerifyError extends Error {
  constructor(readonly report: MigrationReport) {
    super('突き合わせで不一致がありました。何も書き込んでいません（ロールバックしました）')
    this.name = 'MigrationVerifyError'
  }
}

export async function migrateToWeb(input: MigrateInput): Promise<MigrateOutput> {
  const log = input.log ?? (() => {})
  const hh = input.householdId.toLowerCase()
  const newId = input.newId ?? randomUUID
  const dryRun = input.dryRun === true
  const { snapshot } = input

  assertSourceUsable(snapshot)

  // 1. 事前の確認（読むだけ）。画像を置く前に、空の世帯か・スキーマが揃っているかを見る
  log('書き込み先の世帯を確かめています…')
  const pre = await withHouseholdRole(input.sql, hh, async (sql) => {
    await assertHouseholdEmpty(sql, hh)
    return { columns: await loadColumnInfo(sql) }
  })

  // 2. 変換（ここで型の合わない値は止まる。画像を置く前に）
  log('画像の対応表を作っています…')
  const plan = await planImages(snapshot, hh, input.images.source, newId)
  log('行を変換しています…')
  const data = convertSnapshot(snapshot, { columns: pre.columns, images: plan, newId })
  assertListingLinesAcceptable(snapshot)

  // 3. 画像を Storage へ（dry-run では置かない）
  let uploaded: PlannedImage[] = []
  let bytes = 0
  const uploader = input.images.uploader
  if (uploader) {
    log(`画像を Storage に置いています（${plan.ready.length} 件）…`)
    const result = await uploadImages(plan, input.images.source, uploader, (done, total) => {
      if (done % 20 === 0 || done === total) log(`  画像 ${done} / ${total}`)
    })
    uploaded = result.uploaded
    bytes = result.bytes
  }

  // 4. 書き込みと突き合わせを 1 つのトランザクションで。1 つでも違えば投げて、全部巻き戻す
  try {
    log('書き込んでいます（1 つのトランザクション）…')
    const report = await withHouseholdRole(input.sql, hh, async (sql) => {
      // 同じ世帯への移行が同時に 2 本走らないように
      await sql.get('select pg_advisory_xact_lock(hashtext(?))', `soroban-migrate:${hh}`)
      await assertHouseholdEmpty(sql, hh)
      const written = await writeAll(sql, hh, data, pre.columns)
      log('書いた値を読み戻して、SQLite と突き合わせています…')
      const checks = await verifyMigration({
        sql, householdId: hh, snapshot, data, columns: pre.columns, images: plan, settingsBefore: written.settingsBefore,
      })
      const result = buildReport({
        dryRun, householdId: hh, snapshot, data, plan, checks, uploaded: uploaded.length, bytes,
        replacedShippingMethods: written.replacedShippingMethods,
      })
      if (!result.ok) throw new MigrationVerifyError(result)
      return result
    })
    return { report, images: plan.entries }
  } catch (e) {
    // DB は巻き戻った。置いてしまった画像は片付ける（できなければ、残っているパスを言う）
    if (uploader && uploaded.length > 0) {
      const left = await removeUploaded(uploader, uploaded)
      if (left.length > 0 && e instanceof Error) {
        e.message += `\n片付けられなかった画像（Storage に残っています）:\n${left.map((p) => `  ${p}`).join('\n')}`
      }
    }
    throw e
  }
}

/** 読み込んだ SQLite がこの道具で扱えるか。知らない表に行があれば止める（静かな欠損を作らない） */
export function assertSourceUsable(snapshot: SourceSnapshot): void {
  const unknown = Object.entries(snapshot.unknownTables).filter(([, n]) => n > 0)
  if (unknown.length > 0) {
    throw new Error(
      `移行の対象に入っていない表に、データがあります: ${unknown.map(([name, n]) => `${name}（${n} 行）`).join('、')}。` +
        '黙って落とさないよう止めました（tools/migrate-to-web/spec.ts に追加してください）',
    )
  }
  if (snapshot.schemaVersion === null) {
    throw new Error('SQLite の setting.schema_version が読めません（デスクトップ版で一度開いて、最新にしてから使ってください）')
  }
  if (snapshot.schemaVersion < MIN_SCHEMA_VERSION) {
    throw new Error(
      `SQLite の schema_version が古すぎます（${snapshot.schemaVersion}。この道具は ${MIN_SCHEMA_VERSION} 以上を想定）。` +
        '最新のデスクトップ版で一度開いて、マイグレーションを済ませてから使ってください',
    )
  }
}

/**
 * Postgres のトリガー trg_listing_line_guard と同じ条件を、書き込む前に SQLite の側で確かめる
 * （active / suspended の出品への、未販売の在庫の引き当てで、同じ在庫が 2 つの引き当てに入っていない）。
 * 満たさない行があると、トリガーが挿入を断って移行が止まる。止まる前に、どの行かを言う
 */
export function assertListingLinesAcceptable(snapshot: Pick<SourceSnapshot, 'tables'>): void {
  const listings = new Map((snapshot.tables.listing ?? []).map((l) => [String(l.mercari_item_id), String(l.status)]))
  const items = new Map((snapshot.tables.inventory_item ?? []).map((i) => [String(i.id), String(i.status)]))
  const seen = new Map<string, string>()
  const problems: string[] = []
  for (const line of snapshot.tables.listing_line ?? []) {
    const id = String(line.id)
    const listingStatus = listings.get(String(line.listing_id))
    if (listingStatus !== 'active' && listingStatus !== 'suspended') problems.push(`${id}: 終了した出品への引き当て`)
    else if (items.get(String(line.inventory_item_id)) !== 'in_stock') problems.push(`${id}: 未販売でない在庫への引き当て`)
    else if (seen.has(String(line.inventory_item_id))) problems.push(`${id}: 同じ在庫が ${seen.get(String(line.inventory_item_id))} にも引き当てられている`)
    seen.set(String(line.inventory_item_id), id)
  }
  if (problems.length > 0) {
    throw new Error(
      `出品への引き当て（listing_line）に、Postgres のトリガーが断る行があります（${problems.length} 件）: ${problems.slice(0, 5).join('、')}。` +
        'デスクトップ版で引き当てを整理してから、もう一度バックアップを取ってください',
    )
  }
}

function buildReport(args: {
  dryRun: boolean
  householdId: string
  snapshot: SourceSnapshot
  data: ConvertedData
  plan: ImagePlan
  checks: Awaited<ReturnType<typeof verifyMigration>>
  uploaded: number
  bytes: number
  replacedShippingMethods: number
}): MigrationReport {
  const { snapshot, data, plan, checks } = args
  const notMigrated: MigrationReport['notMigrated'] = []
  for (const [name, rows] of Object.entries(snapshot.skippedTables)) {
    notMigrated.push({ name, detail: `${SKIPPED_TABLES[name] ?? '対象外'}（${rows} 行）` })
  }
  if (data.settings.skipped.some((s) => s.key.endsWith('_enc'))) {
    notMigrated.push({
      name: 'API キー（Gemini・17TRACK）',
      detail: '端末の safeStorage で暗号化されていてサーバーでは読めない。Web 版の設定で入れ直してください',
    })
  }
  notMigrated.push({
    name: 'collect_job・agent_device・push_subscription・notification_event・setting_secret ほか',
    detail: 'Web 版が使う表で、SQLite に無い。空のまま',
  })
  for (const [table, n] of data.droppedRows) {
    notMigrated.push({ name: `${table} の ${n} 行`, detail: '画像のファイルが見つからず、画像が必須の表なので移さなかった' })
  }

  const ok =
    checks.tables.every((t) => t.ok) && checks.sums.every((s) => s.ok) && checks.monthly.every((m) => m.ok) &&
    checks.views.every((v) => v.ok) && checks.invariants.every((i) => i.ok)

  return {
    dryRun: args.dryRun,
    householdId: args.householdId,
    tables: checks.tables,
    sums: checks.sums,
    monthly: checks.monthly,
    views: checks.views,
    invariants: checks.invariants,
    images: {
      total: plan.entries.length,
      ready: plan.ready.length,
      uploaded: args.uploaded,
      bytes: args.bytes,
      missing: plan.missing.map((m) => ({ table: m.table, column: m.column, rowKey: m.rowKey, sourceFile: m.sourceFile, status: m.status })),
    },
    notes: [...data.notes].map(([text, count]) => ({ text, count })),
    notMigrated,
    settings: { migrated: data.settings.migrated.size, skipped: data.settings.skipped },
    replacedShippingMethods: args.replacedShippingMethods,
    ok,
  }
}
