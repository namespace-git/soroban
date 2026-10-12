import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ログアウト（auth/session.ts の signOut）：
// ログアウトした端末に、売れた商品名・金額の Push 通知が届き続けないように、ログイン中のうちにこの端末の購読を外す。
//   - 購読があれば、サーバーの購読を消し（endpoint を渡す）、ブラウザの購読を外してから、ログアウトする
//   - どこで失敗しても（通信が切れていても）ログアウトは止めない。待つのは 3 秒まで
//   - service worker や PushManager が無い環境（デスクトップ版・古いブラウザ）では何もしない

const h = vi.hoisted(() => ({
  log: [] as string[],
  supabaseSignOut: vi.fn(),
}))

vi.mock('../supabase', () => ({
  AUTH_STORAGE_KEY: 'soroban-auth',
  getSupabase: () => ({ auth: { signOut: h.supabaseSignOut } }),
}))

import { PUSH_RELEASE_TIMEOUT_MS, signOut } from '../session'

const ENDPOINT = 'https://push.example/send/abc'

interface Fakes {
  deletePushSubscription: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
  getSubscription: ReturnType<typeof vi.fn>
  getRegistration: ReturnType<typeof vi.fn>
  removeItem: ReturnType<typeof vi.fn>
}

/** ブラウザの環境を偽物で作る。購読のある端末が既定 */
function stubBrowser(overrides: Partial<{
  deletePushSubscription: () => Promise<void>
  unsubscribe: () => Promise<boolean>
  getSubscription: () => Promise<unknown>
  getRegistration: () => Promise<unknown>
  serviceWorker: boolean
  pushManager: boolean
}> = {}): Fakes {
  const deletePushSubscription = vi.fn(overrides.deletePushSubscription ?? (async () => { h.log.push('server-delete') }))
  const unsubscribe = vi.fn(overrides.unsubscribe ?? (async () => { h.log.push('unsubscribe'); return true }))
  const subscription = { endpoint: ENDPOINT, unsubscribe }
  const getSubscription = vi.fn(overrides.getSubscription ?? (async () => subscription))
  const getRegistration = vi.fn(overrides.getRegistration ?? (async () => ({ pushManager: { getSubscription } })))
  const removeItem = vi.fn()
  vi.stubGlobal('navigator', overrides.serviceWorker === false ? {} : { serviceWorker: { getRegistration } })
  vi.stubGlobal('window', {
    ...(overrides.pushManager === false ? {} : { PushManager: class {} }),
    sorobanWeb: { deletePushSubscription },
  })
  vi.stubGlobal('localStorage', { removeItem })
  return { deletePushSubscription, unsubscribe, getSubscription, getRegistration, removeItem }
}

beforeEach(() => {
  h.log.length = 0
  h.supabaseSignOut.mockReset()
  h.supabaseSignOut.mockImplementation(async () => { h.log.push('sign-out'); return { error: null } })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('signOut：この端末の Push の購読を外してからログアウトする', () => {
  it('購読があれば、サーバーの購読を消し（endpoint を渡す）、ブラウザの購読を外してから、ログアウトする', async () => {
    const f = stubBrowser()
    await signOut()

    expect(f.deletePushSubscription).toHaveBeenCalledTimes(1)
    expect(f.deletePushSubscription).toHaveBeenCalledWith(ENDPOINT)
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
    expect(h.supabaseSignOut).toHaveBeenCalledTimes(1)
    expect(h.supabaseSignOut).toHaveBeenCalledWith({ scope: 'local' })
    // ログイン中のうちに：ログアウトは最後
    expect(h.log.at(-1)).toBe('sign-out')
    expect(h.log).toContain('server-delete')
    expect(h.log).toContain('unsubscribe')
  })

  it('サーバーの購読を消せなくても（通信が切れていても）、ブラウザの購読は外して、ログアウトする', async () => {
    const f = stubBrowser({ deletePushSubscription: async () => { throw new Error('サーバーにつながりません') } })
    await expect(signOut()).resolves.toBeUndefined()

    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
    expect(h.supabaseSignOut).toHaveBeenCalledTimes(1)
  })

  it('ブラウザの購読を外せなくても、サーバーの購読は消して、ログアウトする', async () => {
    const f = stubBrowser({ unsubscribe: async () => { throw new Error('外せません') } })
    await expect(signOut()).resolves.toBeUndefined()

    expect(f.deletePushSubscription).toHaveBeenCalledWith(ENDPOINT)
    expect(h.supabaseSignOut).toHaveBeenCalledTimes(1)
  })

  it('登録や購読が読めなくても（例外）、ログアウトする', async () => {
    const a = stubBrowser({ getRegistration: async () => { throw new Error('service worker が読めません') } })
    await expect(signOut()).resolves.toBeUndefined()
    expect(a.deletePushSubscription).not.toHaveBeenCalled()
    expect(h.supabaseSignOut).toHaveBeenCalledTimes(1)

    h.supabaseSignOut.mockClear()
    const b = stubBrowser({ getSubscription: async () => { throw new Error('購読が読めません') } })
    await expect(signOut()).resolves.toBeUndefined()
    expect(b.deletePushSubscription).not.toHaveBeenCalled()
    expect(h.supabaseSignOut).toHaveBeenCalledTimes(1)
  })

  it('購読の無い端末・service worker の登録が無い端末（開発サーバー）では何も消さず、ログアウトする', async () => {
    const none = stubBrowser({ getSubscription: async () => null })
    await signOut()
    expect(none.getSubscription).toHaveBeenCalledTimes(1)
    expect(none.deletePushSubscription).not.toHaveBeenCalled()
    expect(none.unsubscribe).not.toHaveBeenCalled()
    expect(h.supabaseSignOut).toHaveBeenCalledTimes(1)

    h.supabaseSignOut.mockClear()
    const noRegistration = stubBrowser({ getRegistration: async () => undefined })
    await signOut()
    expect(noRegistration.deletePushSubscription).not.toHaveBeenCalled()
    expect(h.supabaseSignOut).toHaveBeenCalledTimes(1)
  })

  it('service worker や PushManager が無い環境（デスクトップ版・古いブラウザ）では何もせず、ログアウトする', async () => {
    const noSw = stubBrowser({ serviceWorker: false })
    await signOut()
    expect(noSw.getRegistration).not.toHaveBeenCalled()
    expect(noSw.deletePushSubscription).not.toHaveBeenCalled()
    expect(h.supabaseSignOut).toHaveBeenCalledTimes(1)

    h.supabaseSignOut.mockClear()
    const noPush = stubBrowser({ pushManager: false })
    await signOut()
    expect(noPush.getRegistration).not.toHaveBeenCalled()
    expect(noPush.deletePushSubscription).not.toHaveBeenCalled()
    expect(h.supabaseSignOut).toHaveBeenCalledTimes(1)
  })

  it('window も navigator も無い環境でも、例外にせずログアウトする', async () => {
    vi.stubGlobal('navigator', undefined)
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('localStorage', { removeItem: vi.fn() })
    await expect(signOut()).resolves.toBeUndefined()
    expect(h.supabaseSignOut).toHaveBeenCalledTimes(1)
  })

  it('サーバーが返事をしなくても 3 秒でログアウトする（ブラウザの購読はその前に外してある）', async () => {
    vi.useFakeTimers()
    const f = stubBrowser({ deletePushSubscription: () => new Promise<void>(() => {}) })
    const done = signOut()

    await vi.advanceTimersByTimeAsync(PUSH_RELEASE_TIMEOUT_MS - 1)
    expect(f.deletePushSubscription).toHaveBeenCalledWith(ENDPOINT)
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
    expect(h.supabaseSignOut).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(h.supabaseSignOut).toHaveBeenCalledTimes(1)
  })

  it('購読が読めずに止まっていても 3 秒でログアウトする', async () => {
    vi.useFakeTimers()
    stubBrowser({ getSubscription: () => new Promise(() => {}) })
    const done = signOut()

    await vi.advanceTimersByTimeAsync(PUSH_RELEASE_TIMEOUT_MS - 1)
    expect(h.supabaseSignOut).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(h.supabaseSignOut).toHaveBeenCalledTimes(1)
  })

  it('同時に何度呼ばれても、購読を消す通信もログアウトの通信も 1 回（API が一斉に unauthorized を返しても）', async () => {
    const f = stubBrowser()
    await Promise.all([signOut(), signOut(), signOut()])

    expect(f.deletePushSubscription).toHaveBeenCalledTimes(1)
    expect(h.supabaseSignOut).toHaveBeenCalledTimes(1)
  })

  it('ログアウトの通信が失敗しても、この端末のログインの保存は消す（今までどおり）', async () => {
    const f = stubBrowser()
    h.supabaseSignOut.mockImplementation(async () => ({ error: new Error('通信できません') }))
    await signOut()

    expect(f.removeItem).toHaveBeenCalledWith('soroban-auth')
  })
})
