// service worker（web/sw.ts → dist-web/sw.js）の登録。Web 版のときだけ main.ts（auth/boot.ts）から呼ぶ。
//
// 開発サーバー（pnpm dev:web）では登録しない。キャッシュが HMR と食い違うのと、sw.js はビルドのときに作るため。
// Push の購読（PushManager.subscribe）は次の段。ここでは SW を入れるところまで。

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  const register = () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => {
      // 登録できなくても画面は使える（立ち上がりが少し遅いだけ）。握りつぶさずコンソールには残す
      console.warn('service worker を登録できませんでした', e)
    })
  }
  // 起動の順番（動的 import）のあとで呼ばれるので、load はもう済んでいることがある
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
