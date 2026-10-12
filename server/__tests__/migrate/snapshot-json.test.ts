import { describe, expect, it } from 'vitest'
import { SnapshotJsonError, snapshotFromJson, snapshotToJson } from '../../../tools/migrate-to-web/snapshot-json'
import type { SourceSnapshot } from '../../../tools/migrate-to-web/types'
import { loadFixture, snapshotFromFixture } from './helpers'

// SQLite の読み込み結果を、Electron の子プロセスから JSON で受け取る。形が変わりうる値は、黙って変えずに断る

const fx = loadFixture()

describe('SourceSnapshot の JSON での受け渡し', () => {
  it('見本の全部（表・ビュー・件数・スキーマ版）が、1 つも変わらずに往復する', () => {
    const snapshot = snapshotFromFixture(fx, {
      skippedTables: { app_log: 3890 },
      tables: { setting: [{ key: 'item_code_seq', value: '99' }, { key: 'note', value: '日本語 "quote" \\ \n' }] },
    })
    const back = snapshotFromJson(snapshotToJson(snapshot))
    expect(back).toEqual(snapshot)
    expect(back.schemaVersion).toBe(snapshot.schemaVersion)
    // 金額は整数のまま（小数に化けない）
    for (const row of back.tables.sale) expect(Number.isInteger(row.price)).toBe(true)
  })

  it('schemaVersion が null でも往復する。null の列も null のまま', () => {
    const snapshot = snapshotFromFixture(fx, { schemaVersion: null })
    const back = snapshotFromJson(snapshotToJson(snapshot))
    expect(back.schemaVersion).toBeNull()
    expect(back).toEqual(snapshot)
  })

  const withRow = (value: unknown): SourceSnapshot => snapshotFromFixture(fx, { tables: { sale: [{ id: 'x', price: value }] } })

  it('BLOB・BigInt・NaN・Infinity・Date は、黙って別の値にせず断る', () => {
    expect(() => snapshotToJson(withRow(Buffer.from([1, 2, 3])))).toThrow(SnapshotJsonError)
    expect(() => snapshotToJson(withRow(new Uint8Array([1])))).toThrow(/BLOB/)
    expect(() => snapshotToJson(withRow(10n))).toThrow(/BigInt/)
    expect(() => snapshotToJson(withRow(Number.NaN))).toThrow(/NaN/)
    expect(() => snapshotToJson(withRow(Number.POSITIVE_INFINITY))).toThrow(/Infinity/)
    expect(() => snapshotToJson(withRow(new Date()))).toThrow(/Date/)
  })

  it('形の違う JSON は断る', () => {
    expect(() => snapshotFromJson('null')).toThrow(SnapshotJsonError)
    expect(() => snapshotFromJson('{"tables": {}}')).toThrow(/形が違います/)
    expect(() => snapshotFromJson('{ broken')).toThrow()
  })
})
