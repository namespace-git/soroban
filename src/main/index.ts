import { app, BrowserWindow, ipcMain, dialog, shell, net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'
import * as db from './db'
import * as collector from './collector'
import * as collectorMellojoy from './collector-mellojoy'
import * as updater from './updater'
import * as receipts from './receipts'
import * as ai from './ai-receipt'
import * as backup from './backup'
import * as inbox from './inbox'
import * as views from './views'
import * as applog from './applog'
import type { CollectorRun, SorobanApi } from '../shared/types'

// ============================================================
// そろばん — メインプロセス
//
// 単一Electronアプリ。DBはローカルSQLite、外部サービスなし。
// 収集は起動時（間隔が空いていれば）と手動ボタンで走る。
// ============================================================

// 保存したサムネイルを画面（<img src>）から読ませるための独自スキーム。
// app.whenReady() より前（トップレベル）で登録しないと反映されない。
// standard: true にするとホスト部が小文字化されるが、ファイル名は
// `m` + 数字 + `.jpg`（collector.ts が生成）なので影響しない
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'soroban-thumb',
    privileges: { standard: true, secure: true, supportFetchAPI: false, bypassCSP: false },
  },
])

let mainWindow: BrowserWindow | null = null

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'そろばん',
    backgroundColor: '#f3f5f8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

// ------------------------------------------------------------
// 収集：メルカリ→有効な仕入先アカウント（メロジョイ）の順に直列で走る。
// 1つが失敗しても次へ進む（例外は畳んで返す設計だが、念のためここでも囲う）。
// ------------------------------------------------------------

// 起動時収集（collectInBackground）と手動収集（IPC 'collect'）が同時に走ると、メルカリ・
// メロジョイのウィンドウが並行して開いてしまう。実行中の Promise を共有し、同時には1つだけに絞る
let collectAllRunning: Promise<CollectorRun[]> | null = null

export function collectAll(silent: boolean): Promise<CollectorRun[]> {
  if (collectAllRunning) return collectAllRunning
  collectAllRunning = runCollectAll(silent).finally(() => { collectAllRunning = null })
  return collectAllRunning
}

async function runCollectAll(silent: boolean): Promise<CollectorRun[]> {
  const runs: CollectorRun[] = []
  applog.log('collector', 'collect_start', `収集を開始（silent=${silent}）`)

  try {
    const run = await collector.collect(silent)
    runs.push(run)
    applog.log('collector', 'mercari', `メルカリ: ${run.status}`, {
      fetched: run.fetched, inserted: run.inserted, message: run.message,
    })
  } catch (e) {
    console.error('メルカリの収集に失敗しました', e)
    applog.log('collector', 'mercari', 'メルカリの収集に失敗しました', undefined, {
      error: e instanceof Error ? e.message : String(e),
    })
  }

  const shopAccounts = db.listShopAccounts()
    .filter(a => a.is_active && a.kind === 'mellojoy')

  for (const account of shopAccounts) {
    try {
      const run = await collectorMellojoy.collectShopOrders(account.id, silent)
      runs.push(run)
      applog.log('collector', 'mellojoy', `仕入先「${account.name}」: ${run.status}`, {
        fetched: run.fetched, inserted: run.inserted, message: run.message,
      })
    } catch (e) {
      console.error(`仕入先「${account.name}」の収集に失敗しました`, e)
      applog.log('collector', 'mellojoy', `仕入先「${account.name}」の収集に失敗しました`, undefined, {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return runs
}

// ------------------------------------------------------------
// IPC
//
// ハンドラ名は shared/types.ts の SorobanApi と1対1で対応させる。
// ここに増やしたら preload とインターフェースも直すこと。
// ------------------------------------------------------------

/**
 * 読み取りだけのハンドラは記録しない（呼び出し頻度が高く、ログが読み取り操作で埋まってしまう）。
 * logClient 自身も対象外（記録用の呼び出しを記録すると無限に増える）。
 */
const UNLOGGED_HANDLERS = new Set<keyof SorobanApi>([
  'logClient', 'getDashboard', 'listSales', 'listListings', 'listInventory',
  'listPurchases', 'listMonthly', 'listExpenses', 'searchAll', 'getSettings',
  'getMonthDetail', 'listProducts', 'listTags', 'listShopAccounts', 'listShippingMethods',
  // 引数に API キーが載るので記録しない（summarize はキー名でしか伏せられない）
  'setGeminiApiKey',
])

function registerIpc(): void {
  const handle = <K extends keyof SorobanApi>(
    name: K,
    fn: (...args: Parameters<SorobanApi[K]>) => unknown,
  ) => {
    ipcMain.handle(name, async (_e, ...args) => {
      const typedArgs = args as Parameters<SorobanApi[K]>
      if (UNLOGGED_HANDLERS.has(name)) return fn(...typedArgs)

      const startedAt = Date.now()
      try {
        const result = await fn(...typedArgs)
        applog.log('ipc', name, name, typedArgs, { duration_ms: Date.now() - startedAt })
        return result
      } catch (e) {
        applog.log('ipc', name, name, typedArgs, {
          duration_ms: Date.now() - startedAt,
          error: e instanceof Error ? e.message : String(e),
        })
        throw e
      }
    })
  }

  handle('getDashboard', () => db.getDashboard())
  handle('getInbox', () => inbox.getInbox())
  handle('snoozeReminder', (type, id) => inbox.snoozeReminder(type, id ?? null))
  handle('getSalesProgress', () => views.getSalesProgress())
  handle('getInventoryOverview', () => views.getInventoryOverview())
  handle('listInventoryGroups', (f) => views.listInventoryGroups(f))
  handle('getProductKarte', (code) => views.getProductKarte(code))
  handle('getMonthStatement', (m) => views.getMonthStatement(m))
  handle('listPurchaseAccountCards', (from, to) => views.listPurchaseAccountCards(from, to))

  handle('listSales', (filter) => db.listSales(filter))
  handle('saleTotals', (filter) => db.saleTotals(filter))
  handle('createSale', (input) => db.createSale(input))
  handle('updateSale', (id, patch) => db.updateSale(id, patch))
  handle('deleteSale', (id) => db.deleteSale(id))

  handle('linkInventory', (saleId, ids) => db.linkInventory(saleId, ids))
  handle('autoLinkPending', () => db.autoLinkPending())
  handle('unlinkInventory', (saleId, id) => db.unlinkInventory(saleId, id))
  handle('suggestInventory', (saleId, limit) => db.suggestInventory(saleId, limit))
  handle('listSaleLines', (saleId) => db.listSaleLines(saleId))

  handle('listPurchases', () => db.listPurchases())
  handle('getPurchase', (id) => db.getPurchase(id))
  handle('createPurchase', (input) => db.createPurchase(input))
  handle('importPurchases', (inputs) => db.importPurchases(inputs))
  handle('confirmPurchase', (id, input) => db.confirmPurchase(id, input))
  handle('updatePurchaseNote', (id, note) => db.updatePurchaseNote(id, note))
  handle('updatePurchaseFulfillment', (id, f) => db.setPurchaseFulfillment(id, f))
  handle('deletePurchase', (id) => db.deletePurchase(id))

  handle('listInventory', (status) => db.listInventory(status))
  handle('updateInventory', (id, patch) => db.updateInventory(id, patch))
  handle('splitInventory', (id, count) => db.splitInventory(id, count))
  handle('mergeSplitInventory', (id) => db.mergeSplitInventory(id))
  handle('disposeInventory', (id, note, status) => db.disposeInventory(id, note, status))

  handle('listMonthly', () => db.listMonthly())

  handle('listExpenses', (month) => db.listExpenses(month))
  handle('createExpense', (input) => db.createExpense(input))
  handle('deleteExpense', (id) => db.deleteExpense(id))
  handle('updateExpense', (id, input) => db.updateExpense(id, input))
  handle('attachReceipt', (id) => receipts.attachReceipt(id, mainWindow))
  handle('removeReceipt', (id) => receipts.removeReceipt(id))
  handle('readReceiptImage', () => receipts.readReceiptImage(mainWindow))
  handle('readReceipt', (id) => receipts.readReceipt(id))
  handle('getAiStatus', () => ai.getAiStatus())
  handle('setGeminiApiKey', (key) => ai.setGeminiApiKey(key))
  handle('setAiModel', (model) => ai.setAiModel(model))
  handle('testGemini', () => ai.testGemini())
  handle('getMonthDetail', (month, opts) => db.getMonthDetail(month, opts))
  handle('setMonthAllocMethod', (month, method) => db.setMonthAllocMethod(month, method))
  handle('closeMonth', (month) => db.closeMonth(month))
  handle('reopenMonth', (month) => db.reopenMonth(month))

  handle('listTags', () => db.listTags())
  handle('createTag', (name) => db.createTag(name))
  handle('renameTag', (id, name) => db.renameTag(id, name))
  handle('deleteTag', (id) => db.deleteTag(id))
  handle('setSaleTags', (saleId, tagIds) => db.setSaleTags(saleId, tagIds))
  handle('setInventoryTags', (itemId, tagIds) => db.setInventoryTags(itemId, tagIds))
  handle('setPurchaseTags', (purchaseId, tagIds) => db.setPurchaseTags(purchaseId, tagIds))
  handle('setProductTags', (modelCode, tagIds) => db.setProductTags(modelCode, tagIds))
  handle('setProductName', (code, name) => db.setProductName(code, name))
  handle('listShopAccountStats', () => db.listShopAccountStats())
  handle('listVariantSummary', (sort) => db.listVariantSummary(sort))

  handle('listProducts', (sort) => db.listProducts(sort))
  handle('getProduct', (modelCode) => db.getProduct(modelCode))
  handle('getItemTimeline', (id) => db.getItemTimeline(id))

  handle('listListings', (filter) => db.listListings(filter))
  handle('reserveInventory', (mercariItemId, ids) => db.reserveInventory(mercariItemId, ids))
  handle('unreserveInventory', (mercariItemId, id) => db.unreserveInventory(mercariItemId, id))
  handle('suggestForListing', (mercariItemId, limit) => db.suggestForListing(mercariItemId, limit))
  handle('endListing', (mercariItemId) => db.endListing(mercariItemId))
  handle('autoReserveListings', () => db.autoReserveListings())
  handle('setListingShipping', (mercariItemId, shippingMethodId) =>
    db.setListingShipping(mercariItemId, shippingMethodId))

  handle('searchAll', (query, limit) => db.searchAll(query, limit))

  handle('listShopAccounts', () => db.listShopAccounts())
  handle('createShopAccount', (name, kind) => db.createShopAccount(name, kind))
  handle('updateShopAccount', (id, patch) => db.updateShopAccount(id, patch))
  handle('deleteShopAccount', async (id) => {
    db.deleteShopAccount(id)
    await collectorMellojoy.clearShopSession(id)
  })
  handle('listShippingMethods', () => db.listShippingMethods())
  handle('saveShippingMethod', (m) => db.saveShippingMethod(m))
  handle('deleteShippingMethod', (id) => db.deleteShippingMethod(id))
  // 暗号化済みの API キーは画面に出さない（getAiStatus で有無だけ返す）
  handle('getSettings', () => { const { gemini_api_key_enc: _k, ...rest } = db.getSettings() as Record<string, string>; return rest })
  handle('setSetting', (k, v) => db.setSetting(k, v))

  handle('collect', () => collectAll(db.getSettings().collect_show_window !== '1'))
  handle('openLogin', () => collector.openLoginWindow())
  handle('estimateSaleProfit', (input) => db.estimateSaleProfit(input))
  handle('listSaleExclusions', () => db.listSaleExclusions())
  handle('removeSaleExclusion', (id) => db.removeSaleExclusion(id))
  handle('openShopLogin', (id) => collectorMellojoy.openShopLoginWindow(id))
  handle('listRuns', (limit) => db.listRuns(limit))

  // --- バックアップ ---
  // DBがローカル1ファイルなので、退避手段は必ず用意しておく

  handle('exportCsv', async () => {
    const csv = db.exportRows()
    if (!csv) return null
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: '売上をCSVで書き出す',
      defaultPath: `soroban-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (canceled || !filePath) return null
    writeFileSync(filePath, csv, 'utf-8')
    return filePath
  })

  handle('backupDb', () => backup.backupToZip(mainWindow))
  handle('restoreBackup', () => backup.restoreFromZip(mainWindow))

  handle('revealDbFolder', () => {
    shell.showItemInFolder(db.getDbPath())
  })

  handle('resetData', () => db.resetData())

  handle('openMercari', async (kind, mercariItemId) => {
    if (!/^m\d{9,}$/.test(mercariItemId)) {
      throw new Error(`不正な商品IDです: ${mercariItemId}`)
    }
    const path = kind === 'item' ? 'item' : 'transaction'
    await shell.openExternal(`https://jp.mercari.com/${path}/${mercariItemId}`)
  })

  handle('logClient', (kind, message, payload) => applog.log('renderer', kind, message, payload))

  handle('checkForUpdate', () => updater.checkForUpdate())
  handle('installUpdate', () => updater.installUpdate())
}

/**
 * soroban-thumb://<file> を userData/thumbs/<file> に対応させる（collector.ts が保存した画像を読む）。
 *
 * ファイル名の取り出しは `new URL(req.url).hostname` ではなく文字列操作でやる。
 * standard スキームは Web の URL パーサに則って解釈されるため、ホスト部は
 * 仕様上小文字化される（テストでは確かめられない部分）。ファイル名は
 * collector.ts が `m` + 数字 + `.jpg` の形でしか作らないので実害は無いが、
 * `req.url.slice(...).split(/[/?#]/)[0]` の方が「大文字小文字化されるURLパーサの癖」に
 * 依存しない分だけ安全と判断した。
 */
function registerThumbProtocol(): void {
  protocol.handle('soroban-thumb', async (req) => {
    const file = req.url.slice('soroban-thumb://'.length).split(/[/?#]/)[0]
    // 親ディレクトリへの脱出やパス区切りを含む名前は拒否する
    if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
      return new Response(null, { status: 404 })
    }
    const filePath = join(app.getPath('userData'), 'thumbs', file)
    try {
      return await net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

// ------------------------------------------------------------
// 起動
// ------------------------------------------------------------

app.whenReady().then(async () => {
  try {
    db.initDb()
  } catch (e) {
    // DB が開けない・マイグレーションに失敗したら黙って止まらず、理由を出して終了する
    dialog.showErrorBox(
      'そろばんを起動できません',
      `データベースの初期化に失敗しました。\n${e instanceof Error ? e.message : String(e)}\n\n${db.getDbPath()}`,
    )
    app.quit()
    return
  }
  applog.initAppLog()
  collector.ensureSession()
  registerThumbProtocol()
  registerIpc()
  createMainWindow()

  // 起動時に、前回から間隔が空いていれば裏で収集する。
  // OSのスケジューラは使わない（アプリを開いたときに追いつけばよい）
  collectInBackground()

  // 起動10秒後・以後6時間ごとにアプリの更新を裏で確認する（dev では走らない）
  updater.scheduleAutoCheck(() => mainWindow)
})

async function collectInBackground(): Promise<void> {
  if (process.env.SOROBAN_NO_COLLECT) return // 検証用：自動収集を止める
  try {
    const intervalH = Number(db.getSettings().collect_interval_h ?? 1)
    if (db.hoursSinceLastOk() < intervalH) return

    const runs = await collectAll(true)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('collect:done', runs)
    }
  } catch {
    // 起動を妨げない。失敗は collector_run に残る
  }
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
})

app.on('window-all-closed', () => {
  // 常駐しない。macOSでも終了させる
  app.quit()
})
