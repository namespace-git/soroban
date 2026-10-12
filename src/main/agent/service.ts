import { BrowserWindow, Menu, app, ipcMain, net, session, shell } from 'electron'
import type { IpcMainEvent, MenuItemConstructorOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as applog from '../applog'
import * as collector from '../collector'
import * as collectorMellojoy from '../collector-mellojoy'
import * as collectorYahoo from '../collector-yahoo'
import {
  AGENT_ORIGIN_ARG, AGENT_SESSION_CHANNEL, AGENT_SESSION_CLEAR_CHANNEL, parseSessionInput,
  type AgentSessionInput,
} from '../../preload/agent-bridge'
import type { ShopAccount } from '../../shared/types'
import { errorText } from './errors'
import { createAgentHttp, type FetchFn } from './http'
import { createMediaUploader } from './media'
import {
  AGENT_PARTITION, AGENT_WINDOW_TITLE, externalUrlToOpen, isAllowedNavigation, isTrustedSender, lockDownPermissions,
} from './mode'
import { AgentRunner, type AgentState, type AgentStatus } from './runner'

// ============================================================
// 取り込み担当モードの electron まわり（窓・メニュー・IPC・runner の組み立て）
//
// 判定・検査・状態機械は electron に依存しない別ファイル（mode.ts・runner.ts・http.ts・media.ts…）にあり、
// ここは electron の部品をつなぐだけ。トークン・鍵はここでも保持しない（runner のメモリにだけある）。
// ============================================================

const netFetch: FetchFn = (url, init) => net.fetch(url, init)

const OFFLINE_RETRY_MS = 15_000

// ------------------------------------------------------------
// 窓：Web 版の URL を開くだけ
// ------------------------------------------------------------

function htmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c] as string)
}

/** つながらないときの案内（Web 版は外のページなので、読み込みに失敗するとブラウザのエラー画面になってしまう） */
function showOfflinePage(win: BrowserWindow, origin: string): void {
  if (win.isDestroyed()) return
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>${AGENT_WINDOW_TITLE}</title>`
    + '<body style="font-family:sans-serif;padding:40px;color:#333">'
    + '<h2>Web 版につながりません</h2><p>通信の状態を確かめてください。自動でもう一度つなぎます。</p>'
    + `<p style="color:#888">${htmlEscape(origin)}</p></body></html>`
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  setTimeout(() => {
    if (!win.isDestroyed()) void win.loadURL(`${origin}/`)
  }, OFFLINE_RETRY_MS)
}

/**
 * 取り込み担当モードの主窓：設定した Web 版の URL を開く。
 *  - ログインはブラウザと同じ（専用の partition に残る。私たちのコードはファイルに書かない）
 *  - その origin 以外へのナビゲーションは止める。window.open の外部リンクは https の許可したホスト（mode.ts の EXTERNAL_HOSTS）
 *    だけ OS のブラウザで開く
 *  - 権限の要求（カメラ・マイク・位置情報・通知・クリップボードなど）は全部断る。Electron はハンドラが無いと全部許可するため、
 *    窓を作る前にこの partition へ付ける（mode.ts の lockDownPermissions）
 *  - preload は agent.ts だけ（SorobanApi の IPC は出さない）。origin が一致するときだけ橋が出る
 */
export function createAgentWindow(origin: string): BrowserWindow {
  lockDownPermissions(session.fromPartition(AGENT_PARTITION))
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 600,
    title: AGENT_WINDOW_TITLE,
    backgroundColor: '#f3f5f8',
    webPreferences: {
      partition: AGENT_PARTITION,
      preload: join(__dirname, '../preload/agent.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`${AGENT_ORIGIN_ARG}${origin}`],
    },
  })

  // 窓のタイトルは Web 版のページの <title> に書き換えさせない（取り込み担当だと一目で分かるように）
  win.on('page-title-updated', e => e.preventDefault())

  const wc = win.webContents
  wc.on('will-navigate', (details) => {
    if (!isAllowedNavigation(details.url, origin)) details.preventDefault()
  })
  wc.on('will-redirect', (details) => {
    if (!isAllowedNavigation(details.url, origin)) details.preventDefault()
  })
  wc.setWindowOpenHandler(({ url }) => {
    const external = externalUrlToOpen(url)
    if (external) void shell.openExternal(external)
    return { action: 'deny' }
  })
  wc.on('did-fail-load', (_e, errorCode, _description, validatedUrl, isMainFrame) => {
    // -3 は読み込みの中断（ページ遷移の途中など）。案内ページ自体の読み込みでは出さない
    if (!isMainFrame || errorCode === -3 || validatedUrl.startsWith('data:')) return
    showOfflinePage(win, origin)
  })

  void win.loadURL(`${origin}/`)
  return win
}

// ------------------------------------------------------------
// サービス：runner ＋ 橋からの受け取り ＋ メニューの材料
// ------------------------------------------------------------

export interface AgentServiceOptions {
  origin: string
  deviceName: string
  /** 状態や仕入先の一覧が変わった（メニューを作り直す） */
  onChange(): void
}

export interface AgentMenuState {
  status: AgentStatus
  shopAccounts: Array<{ id: string; name: string }>
}

export class AgentService {
  readonly origin: string
  private readonly runner: AgentRunner
  private shopAccounts: Array<{ id: string; name: string }> = []
  private stopped = false

  constructor(private readonly options: AgentServiceOptions) {
    this.origin = options.origin
    const http = createAgentHttp({ origin: options.origin, fetch: netFetch })
    this.runner = new AgentRunner({
      deviceName: options.deviceName,
      http,
      createMedia: ({ householdId, credentials }) => createMediaUploader({
        householdId,
        credentials,
        fetch: netFetch,
        // 収集が落としたファイル（collector*.ts の userData/thumbs）
        readFile: file => readFile(join(app.getPath('userData'), 'thumbs', file)),
        randomId: randomUUID,
      }),
      collectors: {
        mercari: (silent, store) => collector.collect(silent, store),
        yahoo: (silent, store) => collectorYahoo.collect(silent, store),
        mellojoy: (shopAccountId, silent, store) => collectorMellojoy.collectShopOrders(shopAccountId, silent, store),
      },
      // 鍵・トークン・lease_token は runner がログに渡さない
      log: (kind, message, payload) => applog.log('collector', `agent_${kind}`, message, payload),
      onStatus: () => options.onChange(),
      onRegistered: () => { void this.refreshShopAccounts() },
      onJobFinished: () => { void this.refreshShopAccounts() },
    })
  }

  setSession(session: AgentSessionInput): void {
    if (!this.stopped) this.runner.setSession(session)
  }

  clearSession(): void {
    if (!this.stopped) this.runner.clearSession()
  }

  /** モードを抜ける・アプリを閉じる */
  stop(): void {
    this.stopped = true
    this.runner.dispose()
  }

  menuState(): AgentMenuState {
    return { status: this.runner.getStatus(), shopAccounts: this.shopAccounts }
  }

  /** メロジョイにログインするアカウントの一覧は Web 版の帳簿のもの（収集が使う partition は Web 版のアカウントの id） */
  private async refreshShopAccounts(): Promise<void> {
    try {
      const list = await this.runner.callRpc<ShopAccount[]>('listShopAccounts')
      if (!list || this.stopped) return
      this.shopAccounts = list
        .filter(a => a.kind === 'mellojoy' && a.is_active === 1)
        .map(a => ({ id: a.id, name: a.name }))
      this.options.onChange()
    } catch (e) {
      applog.log('collector', 'agent_shop_accounts_failed', `仕入先の一覧を読めませんでした：${errorText(e)}`)
    }
  }
}

export function startAgent(options: AgentServiceOptions): AgentService {
  return new AgentService(options)
}

// ------------------------------------------------------------
// 橋からの IPC（アプリで 1 度だけ登録する。取り込み担当の窓からのものだけ受ける）
// ------------------------------------------------------------

function isFromAgentWindow(event: IpcMainEvent, origin: string, win: BrowserWindow | null): boolean {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return false
  const frame = event.senderFrame
  if (frame && frame !== event.sender.mainFrame) return false // 子フレームからは受けない
  return isTrustedSender(frame?.url ?? event.sender.getURL(), origin)
}

export function registerAgentIpc(getService: () => AgentService | null, getWindow: () => BrowserWindow | null): void {
  ipcMain.on(AGENT_SESSION_CHANNEL, (event, payload: unknown) => {
    const service = getService()
    if (!service || !isFromAgentWindow(event, service.origin, getWindow())) return
    const session = parseSessionInput(payload)
    if (session) service.setSession(session)
  })
  ipcMain.on(AGENT_SESSION_CLEAR_CHANNEL, (event) => {
    const service = getService()
    if (!service || !isFromAgentWindow(event, service.origin, getWindow())) return
    service.clearSession()
  })
}

// ------------------------------------------------------------
// ネイティブメニュー
// ------------------------------------------------------------

const STATE_TEXT: Record<AgentState, string> = {
  'waiting-login': 'Web 版のログインを待っています',
  registering: '取り込み担当の準備中',
  idle: '待機中',
  running: '取り込み中',
  revoked: 'この PC は取り消されています',
  error: 'Web 版につながりません',
}

export interface AgentMenuActions {
  /** 「取り込み担当をやめる（この PC の帳簿に戻る）」 */
  leave(): void
}

function logLoginError(what: string, e: unknown): void {
  applog.log('collector', 'agent_login_failed', `${what}のログイン窓を開けませんでした：${errorText(e)}`)
}

export function buildAgentMenu(state: AgentMenuState, actions: AgentMenuActions): Menu {
  const statusLabel = `状態：${STATE_TEXT[state.status.state]}${state.status.message ? `（${state.status.message}）` : ''}`
  const shopItems: MenuItemConstructorOptions[] = state.shopAccounts.length > 0
    ? state.shopAccounts.map(a => ({
        label: a.name,
        click: () => { collectorMellojoy.openShopLoginWindow(a.id).catch(e => logLoginError('メロジョイ', e)) },
      }))
    : [{ label: 'Web 版にログインすると、仕入先が選べます', enabled: false }]

  const agentMenu: MenuItemConstructorOptions = {
    label: '取り込み担当',
    submenu: [
      { label: statusLabel, enabled: false },
      { type: 'separator' },
      { label: 'メルカリにログイン', click: () => { collector.openLoginWindow().catch(e => logLoginError('メルカリ', e)) } },
      { label: 'Yahoo!フリマにログイン', click: () => { collectorYahoo.openYahooLogin().catch(e => logLoginError('Yahoo!フリマ', e)) } },
      { label: 'メロジョイにログイン', submenu: shopItems },
      { type: 'separator' },
      { label: '取り込み担当をやめる（この PC の帳簿に戻る）', click: () => actions.leave() },
    ],
  }

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    agentMenu,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  return Menu.buildFromTemplate(template)
}

let agentMenuInstalled = false

export function installAgentMenu(menu: Menu): void {
  agentMenuInstalled = true
  Menu.setApplicationMenu(menu)
}

/** ローカルモードに戻ったときに、取り込み担当のメニューを外す（Electron の標準に近いメニューに戻す） */
export function restoreDefaultMenu(): void {
  if (!agentMenuInstalled) return
  agentMenuInstalled = false
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
