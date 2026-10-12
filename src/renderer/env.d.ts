/// <reference types="vite/client" />

// Web 版のときだけ vite.config.web.ts が埋める値（Electron 版・画面確認用の設定では未定義）
interface ImportMetaEnv {
  /** 'web' なら Web 版（Cloudflare Pages）。main.ts が起動の順番を切り替える */
  readonly VITE_TARGET?: 'web'
  /** Supabase の Project URL（公開してよい） */
  readonly VITE_SUPABASE_URL?: string
  /** Supabase の anon キー（公開してよい鍵。service_role は絶対に置かない） */
  readonly VITE_SUPABASE_ANON_KEY?: string
  /** API の入口。既定は /api */
  readonly VITE_API_BASE?: string
}

interface Window {
  /**
   * Web 版だけの API（取り込みの要求・Push 通知・取り込み担当の PC）。
   * auth/boot.ts が差す。デスクトップ版（Electron）・画面確認用のモックでは undefined
   */
  sorobanWeb?: import('../shared/web-types').WebApi
}
