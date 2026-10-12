import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 収集のコード（collector*.ts）と store/ の書き方の約束を、ソースを読んで確かめる。
// 呼び出しの鎖を async にしたとき、`forEach(async …)` は待たれずに次へ進んで静かに壊れる。
// 順に await するなら `for … of` を使う。
const mainDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const storeDir = join(mainDir, 'store')

const collectorFiles = ['collector.ts', 'collector-yahoo.ts', 'collector-mellojoy.ts'].map(f => join(mainDir, f))
const storeFiles = readdirSync(storeDir).filter(f => f.endsWith('.ts')).map(f => join(storeDir, f))

describe('収集のコードの書き込みは store の段を通す', () => {
  it('store/ にファイルがある（types.ts・local.ts・rules.ts）', () => {
    expect(readdirSync(storeDir).sort()).toEqual(expect.arrayContaining(['local.ts', 'rules.ts', 'types.ts']))
  })

  it.each([...collectorFiles, ...storeFiles])('forEach(async … ) を使っていない：%s', (file) => {
    expect(readFileSync(file, 'utf-8')).not.toMatch(/forEach\s*\(\s*async/)
  })

  it.each(collectorFiles)('実行記録を db.startRun / db.finishRun で直接書いていない（store.recordRun を通す）：%s', (file) => {
    expect(readFileSync(file, 'utf-8')).not.toMatch(/\bdb\.(startRun|finishRun)\b/)
  })

  it.each(collectorFiles)('収集の段の書き込みを db に直接していない：%s', (file) => {
    const source = readFileSync(file, 'utf-8')
    for (const name of [
      'insertCollected', 'updateCollectedActuals', 'updateYahooActuals', 'updateSaleStatus', 'upsertListings',
      'setSaleThumb', 'setListingThumb', 'appendModelCodes', 'createPurchase', 'createPurchaseDraft',
      'markMellojoyOrderExcluded', 'updatePurchaseFulfillment', 'setPurchaseLineImage',
    ]) {
      expect(source, `${name} を db から直接呼んでいる`).not.toMatch(new RegExp(`\\bdb\\.${name}\\(`))
    }
  })

  it('store/ は electron に依存しない（収集のコードより下の層）', () => {
    for (const file of storeFiles) {
      expect(readFileSync(file, 'utf-8'), file).not.toMatch(/from 'electron'/)
    }
  })
})
