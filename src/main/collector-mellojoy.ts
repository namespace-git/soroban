import { BrowserWindow, session } from 'electron'
import { buildUserAgent } from './collector'

// ============================================================
// メロジョイ（仕入先）のログイン窓
//
// 注文履歴の取得は実DOMを見てから。P-07
//
// 約束：
//   * 認証情報は保存しない。保存するのは persist パーティション（Cookie）だけ
//   * 書き込み操作は一切しない
//   * アカウントごとに別プロファイル（partitionFor）にして混線させない
// ============================================================

const LOGIN_URL = 'https://www.mellojoyjapan.com/account/login'

/** アカウントごとに別プロファイルにする。Cookieを混ぜない */
export function partitionFor(shopAccountId: string): string {
  return `persist:mellojoy-${shopAccountId}`
}

/** UA・Accept-Language を通常の Chrome に合わせる（collector.ts と同じ） */
export function ensureShopSession(shopAccountId: string): void {
  const s = session.fromPartition(partitionFor(shopAccountId))
  const chromeMajor = process.versions.chrome.split('.')[0]
  const ua = buildUserAgent(process.platform, chromeMajor)
  s.setUserAgent(ua, 'ja,en-US;q=0.9,en;q=0.8')
}

/**
 * ログイン用ウィンドウを開く。
 * ユーザーが手でログインし、Cookieがそのアカウントのプロファイルに残る。
 */
export function openShopLoginWindow(shopAccountId: string): Promise<void> {
  ensureShopSession(shopAccountId)

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: true,
      title: 'メロジョイ',
      webPreferences: {
        partition: partitionFor(shopAccountId),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    win.loadURL(LOGIN_URL)
    win.on('closed', () => resolve())
  })
}
