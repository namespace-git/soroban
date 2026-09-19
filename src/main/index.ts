import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join } from 'node:path'
import { writeFileSync, copyFileSync } from 'node:fs'
import * as db from './db'
import * as collector from './collector'
import * as collectorMellojoy from './collector-mellojoy'
import type { SorobanApi } from '../shared/types'

// ============================================================
// そろばん — メインプロセス
//
// 単一Electronアプリ。DBはローカルSQLite、外部サービスなし。
// 収集は起動時（間隔が空いていれば）と手動ボタンで走る。
// ============================================================

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
// IPC
//
// ハンドラ名は shared/types.ts の SorobanApi と1対1で対応させる。
// ここに増やしたら preload とインターフェースも直すこと。
// ------------------------------------------------------------

function registerIpc(): void {
  const handle = <K extends keyof SorobanApi>(
    name: K,
    fn: (...args: Parameters<SorobanApi[K]>) => unknown,
  ) => {
    ipcMain.handle(name, (_e, ...args) => fn(...(args as Parameters<SorobanApi[K]>)))
  }

  handle('getDashboard', () => db.getDashboard())

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
  handle('confirmPurchase', (id, input) => db.confirmPurchase(id, input))
  handle('updatePurchaseNote', (id, note) => db.updatePurchaseNote(id, note))
  handle('deletePurchase', (id) => db.deletePurchase(id))

  handle('listInventory', (status) => db.listInventory(status))
  handle('updateInventory', (id, patch) => db.updateInventory(id, patch))
  handle('splitInventory', (id, count) => db.splitInventory(id, count))
  handle('disposeInventory', (id, note, status) => db.disposeInventory(id, note, status))

  handle('listMonthly', () => db.listMonthly())

  handle('listTags', () => db.listTags())
  handle('createTag', (name) => db.createTag(name))
  handle('renameTag', (id, name) => db.renameTag(id, name))
  handle('deleteTag', (id) => db.deleteTag(id))
  handle('setSaleTags', (saleId, tagIds) => db.setSaleTags(saleId, tagIds))
  handle('setInventoryTags', (itemId, tagIds) => db.setInventoryTags(itemId, tagIds))
  handle('listVariantSummary', (sort) => db.listVariantSummary(sort))

  handle('listShopAccounts', () => db.listShopAccounts())
  handle('createShopAccount', (name, kind) => db.createShopAccount(name, kind))
  handle('listShippingMethods', () => db.listShippingMethods())
  handle('saveShippingMethod', (m) => db.saveShippingMethod(m))
  handle('deleteShippingMethod', (id) => db.deleteShippingMethod(id))
  handle('getSettings', () => db.getSettings())
  handle('setSetting', (k, v) => db.setSetting(k, v))

  handle('collect', () => collector.collect(false))
  handle('openLogin', () => collector.openLoginWindow())
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

  handle('backupDb', async () => {
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'データベースをバックアップ',
      defaultPath: `soroban-backup-${new Date().toISOString().slice(0, 10)}.db`,
      filters: [{ name: 'SQLite', extensions: ['db'] }],
    })
    if (canceled || !filePath) return null
    // WALを取り込んだ一貫したコピーを作る
    db.getDb().pragma('wal_checkpoint(TRUNCATE)')
    copyFileSync(db.getDbPath(), filePath)
    return filePath
  })

  handle('revealDbFolder', () => {
    shell.showItemInFolder(db.getDbPath())
  })

  handle('resetData', () => db.resetData())
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
  collector.ensureSession()
  registerIpc()
  createMainWindow()

  // 起動時に、前回から間隔が空いていれば裏で収集する。
  // OSのスケジューラは使わない（アプリを開いたときに追いつけばよい）
  collectInBackground()
})

async function collectInBackground(): Promise<void> {
  try {
    const run = await collector.collectIfDue()
    if (run && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('collect:done', run)
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
