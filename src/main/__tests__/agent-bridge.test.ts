import { describe, expect, it } from 'vitest'
import {
  AGENT_ORIGIN_ARG, normalizeOrigin, originFromArgv, parseSessionInput, shouldExposeBridge,
} from '../../preload/agent-bridge'

// 取り込み担当モードの窓にだけ出す橋（window.sorobanAgentBridge）の純粋な部分：
// 「いまのページの origin が、設定した Web 版の origin と一致するときだけ出す」の判定と、橋から来た内容の検査

describe('normalizeOrigin：Web 版の URL を https の origin にそろえる', () => {
  it('https の URL は origin だけにする（パス・末尾の / ・既定のポート・大文字は落とす）', () => {
    expect(normalizeOrigin('https://soroban.pages.dev')).toBe('https://soroban.pages.dev')
    expect(normalizeOrigin('https://soroban.pages.dev/')).toBe('https://soroban.pages.dev')
    expect(normalizeOrigin('  HTTPS://Soroban.Pages.Dev:443/login?x=1#top ')).toBe('https://soroban.pages.dev')
    expect(normalizeOrigin('https://example.com:8443/a')).toBe('https://example.com:8443')
  })

  it('スキームを省いたものは https とみなす', () => {
    expect(normalizeOrigin('soroban.pages.dev')).toBe('https://soroban.pages.dev')
  })

  it('http・その他のスキーム・ユーザー名つき・空・壊れた形は null（http:// は受けない）', () => {
    for (const bad of [
      'http://soroban.pages.dev', 'ftp://example.com', 'javascript:alert(1)', 'file:///C:/x', 'data:text/html,hi',
      'https://user:pass@example.com', 'https://user@example.com', '', '   ', 'https://', 'https://exa mple.com', 'ws://example.com',
    ]) {
      expect(normalizeOrigin(bad), bad).toBeNull()
    }
  })

  it('長すぎる入力は断る', () => {
    expect(normalizeOrigin(`https://example.com/${'a'.repeat(3000)}`)).toBeNull()
  })
})

describe('originFromArgv：main が preload に渡した引数から取り出す', () => {
  it('引数があれば https の origin を返す', () => {
    expect(originFromArgv(['electron', '--foo', `${AGENT_ORIGIN_ARG}https://soroban.pages.dev`])).toBe('https://soroban.pages.dev')
    expect(originFromArgv([`${AGENT_ORIGIN_ARG}https://soroban.pages.dev/x/`])).toBe('https://soroban.pages.dev')
  })

  it('引数が無い・値が空・https でない・スキームが無いなら null（橋を出さない側に倒す）', () => {
    expect(originFromArgv([])).toBeNull()
    expect(originFromArgv(['--foo=1'])).toBeNull()
    expect(originFromArgv([AGENT_ORIGIN_ARG])).toBeNull()
    expect(originFromArgv([`${AGENT_ORIGIN_ARG}http://soroban.pages.dev`])).toBeNull()
    expect(originFromArgv([`${AGENT_ORIGIN_ARG}soroban.pages.dev`])).toBeNull()
    expect(originFromArgv([`${AGENT_ORIGIN_ARG}https://user:pw@soroban.pages.dev`])).toBeNull()
  })
})

describe('shouldExposeBridge：location.origin が設定の origin と一致するときだけ橋を出す', () => {
  const expected = 'https://soroban.pages.dev'

  it('一致すれば出す', () => {
    expect(shouldExposeBridge('https://soroban.pages.dev', expected)).toBe(true)
  })

  it('設定が無い（null）なら出さない', () => {
    expect(shouldExposeBridge('https://soroban.pages.dev', null)).toBe(false)
  })

  it('別のホスト・別のポート・サブドメイン・親ドメインは出さない', () => {
    for (const other of [
      'https://evil.example.com', 'https://soroban.pages.dev:8443', 'https://x.soroban.pages.dev',
      'https://pages.dev', 'https://soroban.pages.dev.evil.com', 'https://soroban-pages.dev',
    ]) {
      expect(shouldExposeBridge(other, expected), other).toBe(false)
    }
  })

  it('https でないページ（http・about:blank・data:・file:・origin が "null"）には出さない', () => {
    for (const other of ['http://soroban.pages.dev', 'about:blank', 'null', 'data:text/html,x', 'file://', '']) {
      expect(shouldExposeBridge(other, expected), other).toBe(false)
    }
    // 設定のほうが http でも出さない
    expect(shouldExposeBridge('http://soroban.pages.dev', 'http://soroban.pages.dev')).toBe(false)
  })
})

describe('parseSessionInput：橋から来たログインの内容の検査', () => {
  const ok = {
    accessToken: 'a'.repeat(40),
    expiresAt: 1_800_000_000,
    supabaseUrl: 'https://abcd.supabase.co/',
    anonKey: 'k'.repeat(40),
  }

  it('正しい形は正規化して返す（supabaseUrl は origin だけ）', () => {
    expect(parseSessionInput(ok)).toEqual({ ...ok, supabaseUrl: 'https://abcd.supabase.co' })
  })

  it('余計なキーは落とす（橋に何を足されても main に持ち込まない）', () => {
    const parsed = parseSessionInput({ ...ok, extra: 'x', refresh_token: 'r'.repeat(40) })
    expect(Object.keys(parsed!).sort()).toEqual(['accessToken', 'anonKey', 'expiresAt', 'supabaseUrl'])
  })

  it('形が合わなければ null', () => {
    const bad: unknown[] = [
      null, undefined, 'x', 1, [],
      { ...ok, accessToken: '' }, { ...ok, accessToken: 'short' }, { ...ok, accessToken: 1 },
      { ...ok, accessToken: `${'a'.repeat(30)} ${'b'.repeat(30)}` }, { ...ok, accessToken: 'a'.repeat(9000) },
      { ...ok, expiresAt: 0 }, { ...ok, expiresAt: -1 }, { ...ok, expiresAt: Number.NaN }, { ...ok, expiresAt: '1800000000' },
      { ...ok, supabaseUrl: 'http://abcd.supabase.co' }, { ...ok, supabaseUrl: 'abcd.supabase.co' }, { ...ok, supabaseUrl: '' },
      { ...ok, supabaseUrl: 'https://u:p@abcd.supabase.co' }, { ...ok, supabaseUrl: 1 },
      { ...ok, anonKey: '' }, { ...ok, anonKey: 'short' }, { ...ok, anonKey: 'k'.repeat(3000) }, { ...ok, anonKey: 1 },
    ]
    for (const v of bad) expect(parseSessionInput(v), JSON.stringify(v)?.slice(0, 80)).toBeNull()
  })
})
