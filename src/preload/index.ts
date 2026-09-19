import { contextBridge, ipcRenderer } from 'electron'
import type { SorobanApi, CollectorRun } from '../shared/types'

// ============================================================
// レンダラーへ公開するAPI
//
// SorobanApi（shared/types.ts）と1対1で対応させる。
// ここで生の ipcRenderer を渡さないこと。
// ============================================================

const invoke = (name: string) => (...args: unknown[]) => ipcRenderer.invoke(name, ...args)

const api: SorobanApi = {
  getDashboard: invoke('getDashboard'),

  listSales: invoke('listSales'),
  createSale: invoke('createSale'),
  updateSale: invoke('updateSale'),
  deleteSale: invoke('deleteSale'),

  linkInventory: invoke('linkInventory'),
  autoLinkPending: invoke('autoLinkPending'),
  unlinkInventory: invoke('unlinkInventory'),
  suggestInventory: invoke('suggestInventory'),
  listSaleLines: invoke('listSaleLines'),

  listPurchases: invoke('listPurchases'),
  getPurchase: invoke('getPurchase'),
  createPurchase: invoke('createPurchase'),
  confirmPurchase: invoke('confirmPurchase'),
  updatePurchaseNote: invoke('updatePurchaseNote'),
  deletePurchase: invoke('deletePurchase'),
  importPurchaseDrafts: invoke('importPurchaseDrafts'),

  listInventory: invoke('listInventory'),
  updateInventory: invoke('updateInventory'),
  splitInventory: invoke('splitInventory'),
  disposeInventory: invoke('disposeInventory'),

  listMonthly: invoke('listMonthly'),
  listVariantSummary: invoke('listVariantSummary'),

  listShopAccounts: invoke('listShopAccounts'),
  createShopAccount: invoke('createShopAccount'),
  listShippingMethods: invoke('listShippingMethods'),
  saveShippingMethod: invoke('saveShippingMethod'),
  deleteShippingMethod: invoke('deleteShippingMethod'),
  getSettings: invoke('getSettings'),
  setSetting: invoke('setSetting'),

  collect: invoke('collect'),
  openLogin: invoke('openLogin'),
  listRuns: invoke('listRuns'),

  exportCsv: invoke('exportCsv'),
  backupDb: invoke('backupDb'),
  revealDbFolder: invoke('revealDbFolder'),
} as SorobanApi

contextBridge.exposeInMainWorld('soroban', api)

// 起動時の自動収集が終わったら知らせる
contextBridge.exposeInMainWorld('sorobanEvents', {
  onCollectDone(cb: (run: CollectorRun) => void) {
    ipcRenderer.on('collect:done', (_e, run: CollectorRun) => cb(run))
  },
})
