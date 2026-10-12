// Pages のセキュリティヘッダー（web/public/_headers）と、Web 用の CSP（vite.config.web.ts の webCsp）を固定する。
//   - 埋め込みの禁止（X-Frame-Options・frame-ancestors）は、meta の CSP では効かないのでヘッダーで付ける
//   - /api/* は Cache-Control: no-store（Functions の応答には _headers が効かないので、入口のコードでも付けている）
//   - meta の CSP に base-uri・form-action・object-src を足してある（default-src に引き継がれない指示）
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { webCsp } from '../../vite.config.web'

const HEADERS_FILE = resolve(__dirname, '../public/_headers')

type Rules = Map<string, Map<string, string>>

/** Cloudflare Pages の _headers の書式（インデントなし＝パス、インデントあり＝「名前: 値」、# はコメント）を読む */
function parseHeaders(text: string): Rules {
  const rules: Rules = new Map()
  let current: Map<string, string> | null = null
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    if (/^\s/.test(raw)) {
      if (!current) throw new Error(`パスの前にヘッダーがあります: ${raw}`)
      const m = /^\s+([A-Za-z][A-Za-z0-9-]*):\s*(.+?)\s*$/.exec(raw)
      if (!m) throw new Error(`ヘッダーの書式ではありません: ${raw}`)
      current.set(m[1], m[2])
    } else {
      current = new Map()
      rules.set(raw.trim(), current)
    }
  }
  return rules
}

const text = readFileSync(HEADERS_FILE, 'utf8')
const rules = parseHeaders(text)

describe('web/public/_headers：画面に付けるセキュリティヘッダー', () => {
  const all = rules.get('/*')

  it('全パス（/*）の規則がある', () => {
    expect(all).toBeDefined()
  })

  it('埋め込みを禁止する：X-Frame-Options: DENY と frame-ancestors \'none\'（meta の CSP では効かない）', () => {
    expect(all?.get('X-Frame-Options')).toBe('DENY')
    expect(all?.get('Content-Security-Policy')).toBe("frame-ancestors 'none'")
  })

  it('MIME の推測を禁止し、リファラーは同じ origin 以外には origin だけにする', () => {
    expect(all?.get('X-Content-Type-Options')).toBe('nosniff')
    expect(all?.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
  })

  it('カメラは自分にだけ許し（レシートの撮影）、マイク・位置情報は使わない', () => {
    expect(all?.get('Permissions-Policy')).toBe('camera=(self), microphone=(), geolocation=()')
  })

  it('HTTPS を 1 年固定する（max-age=31536000）', () => {
    expect(all?.get('Strict-Transport-Security')).toBe('max-age=31536000')
  })

  it('/api/* は Cache-Control: no-store（帳簿の数字を端末やプロキシに残さない）', () => {
    expect(rules.get('/api/*')?.get('Cache-Control')).toBe('no-store')
  })

  it('ヘッダーの行は ASCII だけ（応答のヘッダーに日本語は載せられない。説明はコメントに書く）', () => {
    for (const [path, headers] of rules) {
      expect(path, path).toMatch(/^[\x20-\x7e]+$/)
      for (const [name, value] of headers) expect(`${name}: ${value}`, name).toMatch(/^[\x20-\x7e]+$/)
    }
  })
})

describe('webCsp：Web 用の CSP（meta）', () => {
  const env = { VITE_SUPABASE_URL: 'https://abcd.supabase.co', VITE_API_BASE: '' }
  const directives = (csp: string) => new Map(csp.split('; ').map((d) => {
    const [name, ...values] = d.split(' ')
    return [name, values] as const
  }))

  it('base-uri \'none\'・form-action \'self\'・object-src \'none\' が入っている', () => {
    const d = directives(webCsp(env))
    expect(d.get('base-uri')).toEqual(["'none'"])
    expect(d.get('form-action')).toEqual(["'self'"])
    expect(d.get('object-src')).toEqual(["'none'"])
  })

  it('今までの指示（自分と Supabase だけ・スクリプトは自分だけ）は変わらない', () => {
    const d = directives(webCsp(env))
    expect(d.get('default-src')).toEqual(["'self'"])
    expect(d.get('script-src')).toEqual(["'self'"])
    expect(d.get('connect-src')).toEqual(["'self'", 'https://abcd.supabase.co'])
    expect(d.get('img-src')).toEqual(["'self'", 'data:', 'blob:', 'https://abcd.supabase.co'])
    expect(webCsp(env)).not.toContain('unsafe-eval')
  })

  it('設定が空でも（Supabase の URL が無くても）足した指示は入る', () => {
    const d = directives(webCsp({}))
    expect(d.get('base-uri')).toEqual(["'none'"])
    expect(d.get('form-action')).toEqual(["'self'"])
    expect(d.get('object-src')).toEqual(["'none'"])
    expect(d.get('connect-src')).toEqual(["'self'"])
  })
})
