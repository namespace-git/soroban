// Web 版（Cloudflare Pages に載せる PWA）のビルド設定。
//
//   pnpm dev:web     開発サーバー
//   pnpm build:web   dist-web/ に出力（Cloudflare Pages の出力ディレクトリ）
//
// デスクトップ版の electron.vite.config.ts とは別物で、そちらには触れない。
// 画面のソース（src/renderer）は両方で共用し、Web のときだけ次の 3 つが加わる。
//   1. import.meta.env.VITE_TARGET === 'web'（main.ts が起動の順番を切り替える）
//   2. index.html への PWA のタグ・Web 用の CSP の差し込み（src/renderer/index.html は Electron と共用なので書き換えない）
//   3. service worker（web/sw.ts → dist-web/sw.js）
//
// 環境変数は web/.env.web.local（リポジトリ直下に置いても読む。web/ が優先）と、プロセスの環境変数
// （Cloudflare Pages の「環境変数」）から読む。雛形は web/.env.web.example。
//
// 鍵の扱い：VITE_SUPABASE_ANON_KEY は**公開してよい値**（ブラウザに出る前提の鍵。権限は RLS と API 側で絞る）。
// **service_role（secret）キーは絶対に画面側に置かない。**ビルドの成果物は誰でも読めるので、入っていたらビルドを止める。
import { defineConfig, loadEnv, transformWithEsbuild } from 'vite'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const webDir = resolve(here, 'web')

// style.css の --canvas（画面の地。上のバーと同じ色）。Android の上端（ステータスバー）がこの色になるので、
// ブランドの黄ではなく地の色にする（黄はアイコンにだけ残す）。manifest.webmanifest の theme_color にも同じ値が書いてある
const THEME_COLOR = '#f6f6f3'

/** 画面（ブラウザ）に渡す環境変数。VITE_ で始まるものだけ。**秘密の値を足さないこと** */
const WEB_ENV_KEYS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_API_BASE'] as const

function readWebEnv(): Record<string, string> {
  // mode='web' で読むと .env / .env.local / .env.web / .env.web.local が対象。プロセスの環境変数が最優先
  return { ...loadEnv('web', here, 'VITE_'), ...loadEnv('web', webDir, 'VITE_') }
}

/** サービスロール（secret）の鍵が画面側に入っていたらビルドを止める */
function assertNotSecretKey(key: string): void {
  const secret = key.startsWith('sb_secret_')
  let role = ''
  const parts = key.split('.')
  if (parts.length === 3) {
    try {
      role = (JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { role?: string }).role ?? ''
    } catch {
      // JWT として読めなければ role は見ない
    }
  }
  if (secret || role === 'service_role') {
    throw new Error(
      'VITE_SUPABASE_ANON_KEY に service_role（secret）キーが入っています。画面側（ブラウザ）には anon（publishable）キーだけを置いてください。'
      + 'この鍵は漏れたものとして Supabase で作り直してください。',
    )
  }
}

function origins(...urls: Array<string | undefined>): string[] {
  const out: string[] = []
  for (const u of urls) {
    if (!u) continue
    try {
      const url = new URL(u)
      // http(s) 以外は origin が "null" になる。許可リストに入れない
      if (url.protocol === 'https:' || url.protocol === 'http:') out.push(url.origin)
    } catch {
      // 相対パス（/api）や不正な値は許可リストに入れない
    }
  }
  return out
}

/**
 * Web 用の CSP。Electron 版（index.html の既定）に、通信先（Supabase・API）と画像の署名 URL を足したもの。
 * base-uri 'none'（<base> による相対 URL の乗っ取りを防ぐ）・form-action 'self'（フォームの送信先を自分に限る）・
 * object-src 'none'（プラグインを使わない）は、default-src に引き継がれない指示なので明示する。
 * 埋め込みの禁止（frame-ancestors）は meta では効かないので web/public/_headers のヘッダーで行う
 */
export function webCsp(env: Record<string, string>): string {
  const supabase = origins(env.VITE_SUPABASE_URL) // 認証と、Storage の署名 URL（画像）
  const api = origins(env.VITE_API_BASE) // 同じ Pages の中（/api）なら空
  return [
    "default-src 'self'",
    ['img-src', "'self'", 'data:', 'blob:', ...supabase].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "font-src 'self' data:",
    ['connect-src', "'self'", ...supabase, ...api].join(' '),
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

const HEAD_TAGS = `
    <meta name="theme-color" content="${THEME_COLOR}" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" type="image/svg+xml" href="/icon.svg" />
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="そろばん" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="format-detection" content="telephone=no" />
  `

function replaceOnce(html: string, pattern: RegExp, replace: (m: RegExpMatchArray) => string, what: string): string {
  const m = html.match(pattern)
  if (!m) {
    // 共用の index.html が変わって差し込めなくなったら、黙って欠けた HTML を出さずに止める
    throw new Error(`index.html の ${what} が見つかりません。vite.config.web.ts の差し込みを直してください`)
  }
  return html.replace(pattern, () => replace(m))
}

/** Web のときだけ index.html に PWA のタグ・viewport-fit・Web 用 CSP を差し込み、service worker を出力する */
function webShell(env: Record<string, string>): Plugin {
  // service worker のキャッシュ名に入れる。ビルドごとに変わるので、古い版のキャッシュが activate で消える
  const buildId = Date.now().toString(36)
  return {
    name: 'soroban-web-shell',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        let out = html
        // ノッチ・ホームバーまで本文を広げる（env(safe-area-inset-*) で避ける）
        out = replaceOnce(
          out,
          /(<meta\s+name="viewport"\s+content=")([^"]*)(")/,
          (m) => `${m[1]}${m[2]}, viewport-fit=cover${m[3]}`,
          'viewport の meta',
        )
        out = replaceOnce(
          out,
          /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/,
          (m) => `${m[1]}${webCsp(env)}${m[2]}`,
          'Content-Security-Policy の meta',
        )
        return replaceOnce(out, /<\/head>/, () => `${HEAD_TAGS}</head>`, '</head>')
      },
    },
    async generateBundle() {
      const source = await readFile(resolve(webDir, 'sw.ts'), 'utf8')
      // 依存の無い 1 ファイル。クラシックスクリプトとして動くよう iife に包む
      const { code } = await transformWithEsbuild(source, 'sw.ts', {
        loader: 'ts',
        format: 'iife',
        target: 'es2020',
        minify: true,
      })
      if (!code.includes('__BUILD_ID__')) throw new Error('web/sw.ts の __BUILD_ID__ が見つかりません')
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: code.replaceAll('__BUILD_ID__', buildId) })
    },
  }
}

export default defineConfig(() => {
  const env = readWebEnv()
  if (env.VITE_SUPABASE_ANON_KEY) assertNotSecretKey(env.VITE_SUPABASE_ANON_KEY)

  return {
    root: resolve(here, 'src/renderer'),
    publicDir: resolve(webDir, 'public'),
    plugins: [vue(), webShell(env)],
    resolve: {
      alias: { '@shared': resolve(here, 'src/shared') },
    },
    // 値は無くても空文字で埋める（画面側が「何が足りないか」を日本語で出す）
    define: {
      'import.meta.env.VITE_TARGET': JSON.stringify('web'),
      ...Object.fromEntries(WEB_ENV_KEYS.map((k) => [`import.meta.env.${k}`, JSON.stringify(env[k] ?? '')])),
    },
    build: {
      outDir: resolve(here, 'dist-web'),
      emptyOutDir: true,
    },
  }
})
