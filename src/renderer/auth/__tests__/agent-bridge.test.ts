import { describe, expect, it, vi } from 'vitest'
import { connectAgentBridge, isAgentWindow, type AgentBridge, type AuthLike } from '../agent-bridge'

// Web 版（boot.ts）から取り込み担当の PC（Electron の取り込み担当モードの窓）へのログインの受け渡し：
// 橋があるときだけ。ログインの変化（トークンの更新も）ごとに provideSession、ログアウトで clearSession

const CONFIG = { supabaseUrl: 'https://abcd.supabase.co', anonKey: `anon-${'k'.repeat(40)}` }

function fakeAuth() {
  let listener: ((event: string, session: { access_token: string; expires_at?: number; expires_in?: number } | null) => void) | null = null
  const auth: AuthLike = {
    onAuthStateChange: vi.fn((cb) => { listener = cb; return { data: { subscription: { unsubscribe() {} } } } }),
  }
  return { auth, emit: (event: string, session: Parameters<NonNullable<typeof listener>>[1]) => listener?.(event, session) }
}

function fakeBridge() {
  const provide = vi.fn<AgentBridge['provideSession']>()
  const clear = vi.fn<AgentBridge['clearSession']>()
  return { bridge: { provideSession: provide, clearSession: clear } satisfies AgentBridge, provide, clear }
}

describe('isAgentWindow（通知の設定を出すかの判定）', () => {
  it('橋が在る窓（取り込み担当の PC）なら true：通知の権限は main が断っているので、通知の設定は出さない', () => {
    const { bridge } = fakeBridge()
    expect(isAgentWindow(bridge)).toBe(true)
  })

  it('橋が無い（ブラウザ・スマホ・デスクトップ版）なら false：今までどおり通知の設定を出す', () => {
    expect(isAgentWindow(undefined)).toBe(false)
  })
})

describe('connectAgentBridge', () => {
  it('橋が無い（ブラウザ・スマホ・デスクトップ版）なら何もしない：ログインの監視すら付けない', () => {
    const { auth } = fakeAuth()
    expect(connectAgentBridge(undefined, auth, CONFIG)).toBe(false)
    expect(auth.onAuthStateChange).not.toHaveBeenCalled()
  })

  it('橋があれば、ログインの変化を監視する', () => {
    const { auth } = fakeAuth()
    const { bridge } = fakeBridge()
    expect(connectAgentBridge(bridge, auth, CONFIG)).toBe(true)
    expect(auth.onAuthStateChange).toHaveBeenCalledTimes(1)
  })

  it('最初のログイン（INITIAL_SESSION）・ログイン・トークンの更新のたびに provideSession。期限は expires_at（秒）', () => {
    const { auth, emit } = fakeAuth()
    const { bridge, provide, clear } = fakeBridge()
    connectAgentBridge(bridge, auth, CONFIG)

    emit('INITIAL_SESSION', { access_token: 'token-1', expires_at: 1_800_000_000 })
    emit('SIGNED_IN', { access_token: 'token-1', expires_at: 1_800_000_000 })
    emit('TOKEN_REFRESHED', { access_token: 'token-2', expires_at: 1_800_003_600 })

    expect(provide).toHaveBeenCalledTimes(3)
    expect(provide).toHaveBeenNthCalledWith(1, { accessToken: 'token-1', expiresAt: 1_800_000_000, ...CONFIG })
    expect(provide).toHaveBeenNthCalledWith(3, { accessToken: 'token-2', expiresAt: 1_800_003_600, ...CONFIG })
    expect(clear).not.toHaveBeenCalled()
  })

  it('expires_at が無ければ expires_in（秒）から数える', () => {
    const { auth, emit } = fakeAuth()
    const { bridge, provide } = fakeBridge()
    connectAgentBridge(bridge, auth, CONFIG, () => 1_000_000_000_000)
    emit('SIGNED_IN', { access_token: 'token-1', expires_in: 3600 })
    expect(provide).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: 1_000_000_000 + 3600 }))
  })

  it('ログアウト（セッションが null）で clearSession。ログインしていない最初の状態でも clearSession', () => {
    const { auth, emit } = fakeAuth()
    const { bridge, provide, clear } = fakeBridge()
    connectAgentBridge(bridge, auth, CONFIG)
    emit('INITIAL_SESSION', null)
    emit('SIGNED_IN', { access_token: 'token-1', expires_at: 1_800_000_000 })
    emit('SIGNED_OUT', null)
    expect(provide).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(2)
  })

  it('橋が例外を投げても、ログインの処理を壊さない', () => {
    const { auth, emit } = fakeAuth()
    const bridge: AgentBridge = {
      provideSession: () => { throw new Error('窓の作り直しの最中') },
      clearSession: () => { throw new Error('窓の作り直しの最中') },
    }
    connectAgentBridge(bridge, auth, CONFIG)
    expect(() => emit('SIGNED_IN', { access_token: 'token-1', expires_at: 1_800_000_000 })).not.toThrow()
    expect(() => emit('SIGNED_OUT', null)).not.toThrow()
  })
})
