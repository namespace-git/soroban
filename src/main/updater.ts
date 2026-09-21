import { app, shell, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

// ============================================================
// アプリの更新（GitHub Releases）
//
// electron-updater で確認する。Windows は自動ダウンロード→終了時に入れ替え。
// macOS は署名が無いので自動入れ替えできない（Releases ページを開くだけ）。
// dev（未パッケージ）では確認しない。
//
// メルカリへの書き込み・認証情報の保存とは無関係（自分のアプリの配布物を GitHub
// Releases から取得するだけ）。頻度は起動10秒後と6時間ごと。連打・高頻度化はしない
// ============================================================

const REPO_OWNER = 'namespace-git'
const REPO_NAME = 'soroban'
const RELEASES_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`

/** Windows だけ自動ダウンロード→終了時に入れ替えられる */
const canAutoInstall = process.platform === 'win32'

autoUpdater.autoDownload = canAutoInstall
autoUpdater.autoInstallOnAppQuit = true

let downloaded = false

autoUpdater.on('error', (e) => {
  console.error('更新の確認に失敗しました', e)
})
autoUpdater.on('update-downloaded', () => {
  downloaded = true
})

/**
 * バージョン文字列（"1.2.0" 形式。先頭の v・プレリリース識別子は無視する）を比較する。
 * a が b より新しければ正、古ければ負、同じなら0
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(n => Number(n) || 0)
  const pa = parts(a)
  const pb = parts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** UpdateInfo.releaseNotes（string | ReleaseNoteInfo[] | null）を表示用の文字列に均す */
function normalizeNotes(notes: UpdateInfo['releaseNotes']): string | null {
  if (!notes) return null
  if (typeof notes === 'string') return notes
  const joined = notes.map(n => n.note ?? '').filter(Boolean).join('\n\n')
  return joined || null
}

/** electron-updater の確認結果 → 契約（UpdateStatus）。latest が current 以下なら「最新」扱い */
export function toUpdateStatus(params: {
  current: string
  latest: string
  notes: string | null
  downloaded: boolean
  canAutoInstall: boolean
  url: string
}): UpdateStatus {
  if (compareVersions(params.latest, params.current) <= 0) {
    return {
      current: params.current,
      state: 'none',
      latest: null,
      notes: null,
      url: null,
      canAutoInstall: params.canAutoInstall,
      message: null,
    }
  }
  return {
    current: params.current,
    state: params.downloaded ? 'downloaded' : 'available',
    latest: params.latest,
    notes: params.notes,
    url: params.url,
    canAutoInstall: params.canAutoInstall,
    message: null,
  }
}

/** 起動時・6時間ごと・手動ボタンから呼ばれる。dev（未パッケージ）では確認しない */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const current = app.getVersion()

  if (!app.isPackaged) {
    return { current, state: 'none', latest: null, notes: null, url: null, canAutoInstall, message: '開発環境' }
  }

  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) {
      return { current, state: 'none', latest: null, notes: null, url: null, canAutoInstall, message: null }
    }
    return toUpdateStatus({
      current,
      latest: result.updateInfo.version,
      notes: normalizeNotes(result.updateInfo.releaseNotes),
      downloaded,
      canAutoInstall,
      url: RELEASES_URL,
    })
  } catch (e) {
    console.error('更新の確認に失敗しました', e)
    return {
      current,
      state: 'error',
      latest: null,
      notes: null,
      url: null,
      canAutoInstall,
      message: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 更新を入れる。Windows：ダウンロード済みなら再起動して入れ替える（未ダウンロードなら
 * ダウンロードを始める）。macOS：署名が無いので Releases のページをブラウザで開く
 */
export async function installUpdate(): Promise<void> {
  if (canAutoInstall) {
    if (downloaded) {
      autoUpdater.quitAndInstall()
    } else {
      await autoUpdater.downloadUpdate()
    }
    return
  }
  await shell.openExternal(RELEASES_URL)
}

let scheduled = false

/**
 * 起動10秒後と6時間ごとに裏で確認し、新しい版があれば（available／downloaded）
 * renderer に `update:status` イベントで知らせる。dev では走らせない
 */
export function scheduleAutoCheck(getWindow: () => BrowserWindow | null): void {
  if (scheduled || !app.isPackaged) return
  scheduled = true

  const run = async () => {
    const status = await checkForUpdate()
    if (status.state !== 'available' && status.state !== 'downloaded') return
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('update:status', status)
  }

  setTimeout(run, 10_000)
  setInterval(run, 6 * 60 * 60 * 1000)
}
