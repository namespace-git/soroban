import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWatchRecords, toDraft } from '../mellojoy-watch'

// mellojoy-watch.ts は defaultWatchDir/importPurchaseDrafts で electron・db に依存するが、
// readWatchRecords / toDraft は純粋関数なのでファイルシステムだけで検証する。

function makeRecord(dir: string, importKey: string, meta: unknown): void {
  const folder = join(dir, importKey)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'meta.json'), JSON.stringify(meta), 'utf-8')
}

describe('mellojoy-watch', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'soroban-watch-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('readWatchRecords', () => {
    it('実データ相当のmeta.jsonから1レコードを読む', () => {
      makeRecord(dir, '2026-09-19_120346_50490503725296', {
        capturedAt: '2026-09-19T03:03:46.981Z',
        variantId: 50490503725296,
        purchaseItems: [
          { variantId: 50490503725296, productTitle: 'Mellojoy - クリーミークリーム——ミディアムサイズ(中号)メロジョイいちごスフレ【Z072-8】【【 ブラインドボックスのおもちゃ】】', variantTitle: '1 * ボックス' },
          { variantId: 50490509820144, productTitle: 'Mellojoy - ねっとりヨーグルト- クリームわん【Z080】【【 ブラインドボックスのおもちゃ】】', variantTitle: '【Z080-1】ねっとりヨーグルト-クリームわん' },
          { variantId: 50490491896048, productTitle: 'Mellojoy- メロージョイ ミニランド【A035】【【 開封後のキャンセルができません】】【ブラインドボックスのおもちゃ】', variantTitle: '2 * ボックス' },
        ],
        productTitle: '9商品を一括購入',
        simulated: false,
      })

      const { records, errors } = readWatchRecords(dir)
      expect(errors).toEqual([])
      expect(records).toHaveLength(1)
      expect(records[0].importKey).toBe('2026-09-19_120346_50490503725296')
      expect(records[0].items).toHaveLength(3)
    })

    it('simulated: true のフォルダは黙ってスキップする', () => {
      makeRecord(dir, 'sim-1', {
        capturedAt: '2026-09-19T03:03:46.981Z',
        purchaseItems: [{ productTitle: 'Mellojoy - なにか【Z001】', variantTitle: '1 * ボックス' }],
        simulated: true,
      })

      const { records, errors } = readWatchRecords(dir)
      expect(records).toEqual([])
      expect(errors).toEqual([])
    })

    it('meta.jsonが無いフォルダはerrorsに積んでスキップする', () => {
      mkdirSync(join(dir, 'no-meta'), { recursive: true })

      const { records, errors } = readWatchRecords(dir)
      expect(records).toEqual([])
      expect(errors).toEqual(['no-meta: meta.jsonがありません'])
    })

    it('JSON不正のmeta.jsonはerrorsに積んでスキップする', () => {
      const folder = join(dir, 'broken')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'meta.json'), '{not json', 'utf-8')

      const { records, errors } = readWatchRecords(dir)
      expect(records).toEqual([])
      expect(errors).toEqual(['broken: meta.jsonの形式が不正です'])
    })

    it('purchaseItemsが空のフォルダはerrorsに積んでスキップする', () => {
      makeRecord(dir, 'empty-items', {
        capturedAt: '2026-09-19T03:03:46.981Z',
        purchaseItems: [],
      })

      const { records, errors } = readWatchRecords(dir)
      expect(records).toEqual([])
      expect(errors).toEqual(['empty-items: purchaseItemsが空です'])
    })

    it('ディレクトリが存在しなければerrorsに1行入れて空配列を返す', () => {
      const { records, errors } = readWatchRecords(join(dir, 'does-not-exist'))
      expect(records).toEqual([])
      expect(errors).toHaveLength(1)
    })
  })

  describe('toDraft', () => {
    it('実データ相当の3明細を型番・素材・数量で変換する', () => {
      makeRecord(dir, '2026-09-19_120346_50490503725296', {
        capturedAt: '2026-09-19T03:03:46.981Z',
        purchaseItems: [
          { productTitle: 'Mellojoy - クリーミークリーム——ミディアムサイズ(中号)メロジョイいちごスフレ【Z072-8】【【 ブラインドボックスのおもちゃ】】', variantTitle: '1 * ボックス' },
          { productTitle: 'Mellojoy - ねっとりヨーグルト- クリームわん【Z080】【【 ブラインドボックスのおもちゃ】】', variantTitle: '【Z080-1】ねっとりヨーグルト-クリームわん' },
          { productTitle: 'Mellojoy- メロージョイ ミニランド【A035】【【 開封後のキャンセルができません】】【ブラインドボックスのおもちゃ】', variantTitle: '2 * ボックス' },
        ],
        productTitle: '9商品を一括購入',
        simulated: false,
      })

      const { records: recs } = readWatchRecords(dir)
      expect(recs).toHaveLength(1)

      const draft = toDraft(recs[0], 'shop-1')
      expect(draft.import_key).toBe('2026-09-19_120346_50490503725296')
      expect(draft.shop_account_id).toBe('shop-1')
      expect(draft.note).toBe('mellojoy-watch 2026-09-19_120346_50490503725296')
      expect(draft.lines).toHaveLength(3)

      const byCode = Object.fromEntries(draft.lines.map(l => [l.model_code, l]))
      expect(byCode['Z072-8'].quantity).toBe(1)
      expect(byCode['Z080-1'].quantity).toBe(1)
      expect(byCode['Z080-1'].material).toBe('ねっとりヨーグルト')
      expect(byCode['A035'].quantity).toBe(2)
    })

    it('同じmodel_codeの明細は数量を合算して1明細にする', () => {
      const rec = {
        importKey: 'merge-1',
        capturedAt: '2026-09-19T03:03:46.981Z',
        items: [
          { productTitle: 'Mellojoy - なにか【Z001】', variantTitle: '2 * ボックス' },
          { productTitle: 'Mellojoy - なにか【Z001】', variantTitle: '3 * ボックス' },
        ],
      }

      const draft = toDraft(rec, 'shop-1')
      expect(draft.lines).toHaveLength(1)
      expect(draft.lines[0].model_code).toBe('Z001')
      expect(draft.lines[0].quantity).toBe(5)
    })

    it('capturedAt（UTC）をローカル日付のordered_atに変換する', () => {
      const rec = {
        importKey: 'date-1',
        capturedAt: '2026-09-19T03:03:46.981Z',
        items: [{ productTitle: 'Mellojoy - なにか【Z001】', variantTitle: '1 * ボックス' }],
      }
      const draft = toDraft(rec, 'shop-1')
      // ローカルタイムゾーンによらず YYYY-MM-DD の形になっていること
      expect(draft.ordered_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  })
})
