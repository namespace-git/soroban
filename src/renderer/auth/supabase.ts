// Supabase Auth のクライアント（Web 版だけ。Electron 版は読み込まない）。
//
// ここに置いてよいのは anon（publishable）キーだけ。anon キーは**公開してよい値**
// （ブラウザに出る前提の鍵。データは RLS と API 側の世帯チェックで守る）。
// **service_role（secret）キーは絶対に画面側に置かない。**入っていたら使わずに止める。
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

const url = (import.meta.env.VITE_SUPABASE_URL ?? '').trim()
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()

/** セッションの保存先（localStorage のキー）。ログアウトが通信で失敗したときに自分で消すため、名前を固定する */
export const AUTH_STORAGE_KEY = 'soroban-auth'

function isSecretKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true
  const parts = key.split('.')
  if (parts.length !== 3) return false
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as { role?: string }
    return payload.role === 'service_role'
  } catch {
    return false
  }
}

/** 設定の足りないところ・おかしいところ。日本語で人に見せる。空なら使える */
export function configProblems(): string[] {
  const problems: string[] = []
  if (!url) {
    problems.push('VITE_SUPABASE_URL（Supabase の Project URL）が入っていません')
  } else if (!/^https?:\/\//.test(url)) {
    problems.push('VITE_SUPABASE_URL が URL の形ではありません（https:// から始まる Project URL を入れてください）')
  }
  if (!anonKey) {
    problems.push('VITE_SUPABASE_ANON_KEY（Supabase の anon キー）が入っていません')
  } else if (isSecretKey(anonKey)) {
    problems.push('VITE_SUPABASE_ANON_KEY に service_role（secret）キーが入っています。画面側には anon（publishable）キーだけを置いてください')
  }
  return problems
}

let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!client) {
    const problems = configProblems()
    if (problems.length) throw new Error(problems[0])
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // メールのリンクからの復帰は使わない（アカウントは事前に登録されたものだけ）
        detectSessionInUrl: false,
        storageKey: AUTH_STORAGE_KEY,
      },
    })
  }
  return client
}
