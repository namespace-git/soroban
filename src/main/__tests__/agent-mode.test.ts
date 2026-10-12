import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_WINDOW_TITLE, EXTERNAL_HOSTS, SettingError, denyPermissionCheck, denyPermissionRequest, externalUrlToOpen,
  isAllowedNavigation, isTrustedSender, lockDownPermissions, resolveAgentMode, resolveDeviceName, validateAgentSetting,
} from '../agent/mode'
import { channelPageUrl } from '../../shared/channel-url'

// 取り込み担当モードの判定・設定の検査・窓の出入りの規則（electron に依存しない純粋な関数）

const ORIGIN = 'https://soroban.pages.dev'

describe('resolveAgentMode：ローカルの設定からモードを決める', () => {
  it('web_agent_enabled が 1 で URL が https なら取り込み担当モード。端末名は設定、無ければホスト名', () => {
    expect(resolveAgentMode(
      { web_agent_enabled: '1', web_agent_url: `${ORIGIN}/login`, web_agent_name: ' リビングの PC ' }, 'DESKTOP-1',
    )).toEqual({ agent: true, origin: ORIGIN, deviceName: 'リビングの PC' })
    expect(resolveAgentMode(
      { web_agent_enabled: '1', web_agent_url: ORIGIN, web_agent_name: '' }, 'DESKTOP-1',
    )).toEqual({ agent: true, origin: ORIGIN, deviceName: 'DESKTOP-1' })
    expect(resolveAgentMode({ web_agent_enabled: '1', web_agent_url: ORIGIN }, 'DESKTOP-1'))
      .toMatchObject({ deviceName: 'DESKTOP-1' })
  })

  it('1 でない・未設定ならローカルモード（今まで通り）', () => {
    expect(resolveAgentMode({}, 'PC')).toEqual({ agent: false })
    expect(resolveAgentMode({ web_agent_url: ORIGIN }, 'PC')).toEqual({ agent: false })
    expect(resolveAgentMode({ web_agent_enabled: '0', web_agent_url: ORIGIN }, 'PC')).toEqual({ agent: false })
    expect(resolveAgentMode({ web_agent_enabled: 'true', web_agent_url: ORIGIN }, 'PC')).toEqual({ agent: false })
  })

  it('有効でも URL が無い・https でないなら、アプリが開けなくならないようローカルモードで起動する', () => {
    expect(resolveAgentMode({ web_agent_enabled: '1' }, 'PC')).toEqual({ agent: false })
    expect(resolveAgentMode({ web_agent_enabled: '1', web_agent_url: '' }, 'PC')).toEqual({ agent: false })
    expect(resolveAgentMode({ web_agent_enabled: '1', web_agent_url: 'http://soroban.pages.dev' }, 'PC')).toEqual({ agent: false })
    expect(resolveAgentMode({ web_agent_enabled: '1', web_agent_url: 'javascript:alert(1)' }, 'PC')).toEqual({ agent: false })
  })

  it('端末名は 200 文字まで。ホスト名も空なら「この PC」', () => {
    expect(resolveDeviceName('あ'.repeat(300), 'PC')).toHaveLength(200)
    expect(resolveDeviceName('  ', '  ')).toBe('この PC')
  })
})

describe('isAllowedNavigation：取り込み担当の窓がたどってよい先は Web 版の origin だけ', () => {
  it('同じ origin のパス・クエリ・ハッシュはよい', () => {
    expect(isAllowedNavigation(`${ORIGIN}/`, ORIGIN)).toBe(true)
    expect(isAllowedNavigation(`${ORIGIN}/api/rpc/x?y=1#z`, ORIGIN)).toBe(true)
  })

  it('別の origin・http・別のポート・サブドメイン・メルカリなどの外部サイトは止める', () => {
    for (const url of [
      'https://jp.mercari.com/item/m1', 'https://t.17track.net/#nums=1', 'http://soroban.pages.dev/', 'https://soroban.pages.dev:8443/',
      'https://x.soroban.pages.dev/', 'https://soroban.pages.dev.evil.com/', 'javascript:alert(1)', 'file:///C:/Windows/win.ini',
      'data:text/html,hi', 'about:blank', 'not a url', '',
    ]) {
      expect(isAllowedNavigation(url, ORIGIN), url).toBe(false)
    }
  })
})

describe('externalUrlToOpen：window.open の外部リンクを OS のブラウザで開くのは、許可したホストの https だけ', () => {
  it('許可したホスト（メルカリ・Yahoo!フリマ・17TRACK）の https は開く', () => {
    expect(externalUrlToOpen('https://t.17track.net/#nums=ABC')).toBe('https://t.17track.net/#nums=ABC')
    expect(externalUrlToOpen('https://jp.mercari.com/item/m123')).toBe('https://jp.mercari.com/item/m123')
    expect(externalUrlToOpen('https://paypayfleamarket.yahoo.co.jp/item/z12345678')).toBe('https://paypayfleamarket.yahoo.co.jp/item/z12345678')
    expect(externalUrlToOpen('https://paypayfleamarket-sec.yahoo.co.jp/item/z12345678/trade/seller'))
      .toBe('https://paypayfleamarket-sec.yahoo.co.jp/item/z12345678/trade/seller')
    // ホストは大文字でも同じ（URL が小文字にそろえる）。既定のポート（443）の明示は同じ扱い
    expect(externalUrlToOpen('https://JP.Mercari.com:443/item/m123')).toBe('https://jp.mercari.com/item/m123')
  })

  it('許可するホストは 4 つだけ（増やすときはここと EXTERNAL_HOSTS を揃える）', () => {
    expect([...EXTERNAL_HOSTS].sort()).toEqual([
      'jp.mercari.com', 'paypayfleamarket-sec.yahoo.co.jp', 'paypayfleamarket.yahoo.co.jp', 't.17track.net',
    ])
  })

  it('画面が外へ開く先（channelPageUrl の全部の出品先・取引画面）は、すべて許可したホストに入っている', () => {
    const urls = [
      channelPageUrl('mercari', 'item', 'm123456789'),
      channelPageUrl('mercari', 'transaction', 'm123456789'),
      channelPageUrl('yahoo', 'item', 'z12345678'),
      channelPageUrl('yahoo', 'transaction', 'z12345678'),
    ]
    for (const url of urls) expect(externalUrlToOpen(url), url).toBe(url)
  })

  it('https でも、許可していないホスト・似せたホスト・サブドメイン・別のポートは開かない', () => {
    for (const url of [
      'https://example.com/', 'https://evil.example/item/m123', 'https://jp.mercari.com.evil.example/', 'https://evil.example/jp.mercari.com',
      'https://x.jp.mercari.com/', 'https://mercari.com/', 'https://17track.net/', 'https://t.17track.net.evil.example/',
      'https://jp.mercari.com./item/m1', 'https://yahoo.co.jp/', 'https://jp.mercari.com:8443/item/m1',
      'https://jp-mercari.com/', 'https://jp.mercari.com@evil.example/', 'https://github.com/namespace-git/soroban/releases/latest',
    ]) {
      expect(externalUrlToOpen(url), url).toBeNull()
    }
  })

  it('http・file・javascript・data・about・mailto・ユーザー名つき・壊れた形は開かない（許可したホストでも）', () => {
    for (const url of [
      'http://example.com/', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank',
      'mailto:a@example.com', 'ms-msdt:/id', 'https://user:pw@example.com/', '', 'not a url',
      'http://jp.mercari.com/item/m123', 'http://t.17track.net/', 'https://user:pw@jp.mercari.com/item/m123', 'https://user@t.17track.net/',
      'ftp://jp.mercari.com/', 'file://jp.mercari.com/x',
    ]) {
      expect(externalUrlToOpen(url), url).toBeNull()
    }
  })
})

describe('権限の要求：取り込み担当の窓は何も許可しない（Electron はハンドラが無いと全部許可する）', () => {
  const PERMISSIONS = [
    'media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'clipboard-read', 'clipboard-sanitized-write',
    'fullscreen', 'pointerLock', 'openExternal', 'display-capture', 'idle-detection', 'unknown-future-permission',
  ]

  it('denyPermissionRequest は何を求められても callback(false)', () => {
    for (const permission of PERMISSIONS) {
      const callback = vi.fn()
      denyPermissionRequest(null, permission, callback)
      expect(callback, permission).toHaveBeenCalledTimes(1)
      expect(callback, permission).toHaveBeenCalledWith(false)
    }
  })

  it('denyPermissionCheck は何を聞かれても false', () => {
    expect(denyPermissionCheck()).toBe(false)
  })

  it('lockDownPermissions は、request と check の両方のハンドラを付ける', () => {
    const target = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
    lockDownPermissions(target)
    expect(target.setPermissionRequestHandler).toHaveBeenCalledWith(denyPermissionRequest)
    expect(target.setPermissionCheckHandler).toHaveBeenCalledWith(denyPermissionCheck)
  })
})

describe('isTrustedSender：橋の IPC は設定した origin のページからだけ受ける', () => {
  it('同じ origin のページからは受ける', () => {
    expect(isTrustedSender(`${ORIGIN}/settings`, ORIGIN)).toBe(true)
  })
  it('別の origin・about:blank・無い（null / undefined）は受けない', () => {
    expect(isTrustedSender('https://evil.example.com/', ORIGIN)).toBe(false)
    expect(isTrustedSender('about:blank', ORIGIN)).toBe(false)
    expect(isTrustedSender(null, ORIGIN)).toBe(false)
    expect(isTrustedSender(undefined, ORIGIN)).toBe(false)
    expect(isTrustedSender('', ORIGIN)).toBe(false)
  })
})

describe('validateAgentSetting：setSetting に来た取り込み担当の設定の検査', () => {
  it('web_agent_url は https の origin にそろえて保存する。空は消す', () => {
    expect(validateAgentSetting('web_agent_url', ' https://Soroban.pages.dev/x ', {})).toBe(ORIGIN)
    expect(validateAgentSetting('web_agent_url', 'soroban.pages.dev', {})).toBe(ORIGIN)
    expect(validateAgentSetting('web_agent_url', '   ', {})).toBe('')
  })

  it('web_agent_url が https でない・壊れていれば日本語のエラー', () => {
    for (const bad of ['http://soroban.pages.dev', 'javascript:alert(1)', 'https://u:p@x.com', 'ftp://x.com']) {
      expect(() => validateAgentSetting('web_agent_url', bad, {}), bad).toThrow(SettingError)
    }
    expect(() => validateAgentSetting('web_agent_url', 'http://x.com', {})).toThrow('https://')
  })

  it('web_agent_name は前後の空白を除いて 200 文字まで', () => {
    expect(validateAgentSetting('web_agent_name', '  リビングの PC  ', {})).toBe('リビングの PC')
    expect(validateAgentSetting('web_agent_name', 'あ'.repeat(300), {})).toHaveLength(200)
    expect(validateAgentSetting('web_agent_name', '', {})).toBe('')
  })

  it('web_agent_enabled は 1 / 0 だけ。1 にできるのは URL が保存済みのとき', () => {
    expect(validateAgentSetting('web_agent_enabled', '0', {})).toBe('0')
    expect(validateAgentSetting('web_agent_enabled', '1', { web_agent_url: ORIGIN })).toBe('1')
    expect(() => validateAgentSetting('web_agent_enabled', '1', {})).toThrow('URL')
    expect(() => validateAgentSetting('web_agent_enabled', '1', { web_agent_url: 'http://x.com' })).toThrow(SettingError)
    expect(() => validateAgentSetting('web_agent_enabled', 'yes', { web_agent_url: ORIGIN })).toThrow(SettingError)
    expect(() => validateAgentSetting('web_agent_enabled', '', { web_agent_url: ORIGIN })).toThrow(SettingError)
  })

  it('取り込み担当以外のキーは何もせずそのまま（今までの setSetting と同じ）', () => {
    expect(validateAgentSetting('fee_rate_bp', '1000', {})).toBe('1000')
    expect(validateAgentSetting('mercari_keyword', ' メロジョイ, Mellojoy ', {})).toBe(' メロジョイ, Mellojoy ')
    expect(validateAgentSetting('web_agent_enabled_x', 'anything', {})).toBe('anything')
  })

  it('窓のタイトルは「そろばん（取り込み担当）」', () => {
    expect(AGENT_WINDOW_TITLE).toBe('そろばん（取り込み担当）')
  })
})
