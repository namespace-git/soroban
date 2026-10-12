// Web 版の画面のつなぎ（components/web-glue.ts）：通知から開く先の読み取り・通知の端末・iPhone の案内の判定。
import { describe, it, expect } from 'vitest'
import { allPushKinds, defaultDeviceLabel, isAppleMobile, parseOpenTarget, pushSupport, urlBase64ToUint8Array } from '../web-glue'
import type { PushEnv } from '../web-glue'

const TABS = ['dashboard', 'sales', 'purchases', 'inventory', 'products', 'expenses', 'monthly', 'settings', 'help'] as const
const ORIGIN = 'https://soroban.example.pages.dev'

describe('parseOpenTarget（通知を押したとき・通知から立ち上げたときの行き先）', () => {
  it('売れた通知：/?tab=sales&sale=<id> → 売上タブを「すべて」で開き、その行を指す', () => {
    expect(parseOpenTarget('/?tab=sales&sale=7b1c2d3e-aaaa-4bbb-8ccc-1234567890ab', ORIGIN, TABS))
      .toEqual({ tab: 'sales', payload: { stage: 'all', focusId: '7b1c2d3e-aaaa-4bbb-8ccc-1234567890ab' } })
  })

  it('届いた通知：/?tab=purchases&purchase=<id> → 仕入タブのその行', () => {
    expect(parseOpenTarget('/?tab=purchases&purchase=p_1', ORIGIN, TABS))
      .toEqual({ tab: 'purchases', payload: { focusId: 'p_1' } })
  })

  it('tab だけならそのタブを開くだけ（取り込みの通知は /?tab=… か / ）', () => {
    expect(parseOpenTarget('/?tab=settings', ORIGIN, TABS)).toEqual({ tab: 'settings', payload: null })
    expect(parseOpenTarget(`${ORIGIN}/?tab=dashboard`, ORIGIN, TABS)).toEqual({ tab: 'dashboard', payload: null })
  })

  it('知らない tab・tab なし・/ だけは無視（null）', () => {
    expect(parseOpenTarget('/?tab=admin', ORIGIN, TABS)).toBeNull()
    expect(parseOpenTarget('/?tab=', ORIGIN, TABS)).toBeNull()
    expect(parseOpenTarget('/', ORIGIN, TABS)).toBeNull()
    expect(parseOpenTarget('/?sale=abc', ORIGIN, TABS)).toBeNull()
    expect(parseOpenTarget('/?tab=constructor', ORIGIN, TABS)).toBeNull()
  })

  it('別のオリジンの URL・URL でない値は無視', () => {
    expect(parseOpenTarget('https://evil.example/?tab=sales&sale=1', ORIGIN, TABS)).toBeNull()
    expect(parseOpenTarget('//evil.example/?tab=sales', ORIGIN, TABS)).toBeNull()
    expect(parseOpenTarget(undefined, ORIGIN, TABS)).toBeNull()
    expect(parseOpenTarget(42, ORIGIN, TABS)).toBeNull()
    expect(parseOpenTarget('', ORIGIN, TABS)).toBeNull()
    expect(parseOpenTarget('/?tab=sales', 'null', TABS)).toBeNull()
  })

  it('id がセレクタに入れて危ない字を含むときは、行は指さずタブだけ開く', () => {
    expect(parseOpenTarget('/?tab=sales&sale=a"]%20x', ORIGIN, TABS)).toEqual({ tab: 'sales', payload: null })
    expect(parseOpenTarget('/?tab=purchases&purchase=', ORIGIN, TABS)).toEqual({ tab: 'purchases', payload: null })
    // 売上以外のタブに付いた sale は使わない
    expect(parseOpenTarget('/?tab=purchases&sale=abc', ORIGIN, TABS)).toEqual({ tab: 'purchases', payload: null })
  })
})

describe('defaultDeviceLabel（通知の端末の名前の初期値）', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  const IPAD_AS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
  const MAC = IPAD_AS_MAC
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
  const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

  it('iPhone・Android・Mac・Windows など', () => {
    expect(defaultDeviceLabel(IPHONE)).toBe('iPhone')
    expect(defaultDeviceLabel(ANDROID)).toBe('Android')
    expect(defaultDeviceLabel(MAC, 0)).toBe('Mac')
    expect(defaultDeviceLabel(WINDOWS)).toBe('Windows')
    expect(defaultDeviceLabel('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)')).toBe('Chromebook')
    expect(defaultDeviceLabel('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux')
    expect(defaultDeviceLabel('')).toBe('この端末')
  })

  it('iPadOS は UA が Mac になるので、タッチがあれば iPad', () => {
    expect(defaultDeviceLabel(IPAD_AS_MAC, 5)).toBe('iPad')
    expect(isAppleMobile(IPAD_AS_MAC, 5)).toBe(true)
    expect(isAppleMobile(MAC, 0)).toBe(false)
    expect(isAppleMobile(IPHONE)).toBe(true)
  })
})

describe('pushSupport（iPhone の案内を出すかは機能の有無で決める）', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
  const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
  const env = (over: Partial<PushEnv>): PushEnv => ({
    hasServiceWorker: true, hasPushManager: true, hasNotification: true, standalone: false, ua: DESKTOP, maxTouchPoints: 0, ...over,
  })

  it('iPhone でホーム画面に追加していない（PushManager が無い）→ 案内', () => {
    expect(pushSupport(env({ ua: IPHONE, hasPushManager: false, hasNotification: false }))).toBe('needs-install')
  })

  it('iPhone で PushManager があってもホーム画面から開いていなければ案内', () => {
    expect(pushSupport(env({ ua: IPHONE, standalone: false }))).toBe('needs-install')
  })

  it('iPhone のホーム画面から開いていて機能が揃っていれば受け取れる', () => {
    expect(pushSupport(env({ ua: IPHONE, standalone: true }))).toBe('ready')
  })

  it('パソコン・Android は standalone でなくても、機能があれば受け取れる', () => {
    expect(pushSupport(env({}))).toBe('ready')
  })

  it('機能が無いブラウザは未対応（iPhone ではない）', () => {
    expect(pushSupport(env({ hasPushManager: false }))).toBe('unsupported')
    expect(pushSupport(env({ hasServiceWorker: false }))).toBe('unsupported')
    expect(pushSupport(env({ hasNotification: false }))).toBe('unsupported')
  })
})

describe('urlBase64ToUint8Array / allPushKinds', () => {
  it('base64url（- と _・= なし）を元のバイト列に戻す', () => {
    // 0xfb 0xff 0xbf は base64 で "+/+/"、base64url で "-_-_"
    expect([...urlBase64ToUint8Array('-_-_')]).toEqual([0xfb, 0xff, 0xbf])
    // = のパディングが無くても読める（"AQID" は 1,2,3、"AQI" は 1,2）
    expect([...urlBase64ToUint8Array('AQID')]).toEqual([1, 2, 3])
    expect([...urlBase64ToUint8Array('AQI')]).toEqual([1, 2])
  })

  it('VAPID 公開鍵の形（65 バイト・先頭 0x04）を読める', () => {
    const key = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'
    const bytes = urlBase64ToUint8Array(key)
    expect(bytes.length).toBe(65)
    expect(bytes[0]).toBe(4)
  })

  it('種類ごとの切り替えの初期値は 4 つとも同じ', () => {
    expect(allPushKinds(true)).toEqual({ sale: true, shipping: true, collect: true, arrival: true })
    expect(allPushKinds(false)).toEqual({ sale: false, shipping: false, collect: false, arrival: false })
  })
})
