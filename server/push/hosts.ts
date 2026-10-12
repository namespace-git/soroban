// Push の宛先（endpoint）として認めるホスト。WebCrypto も DB も使わない純粋な関数だけ（Cron の Worker にも入る）。
//
// 登録（domain/push.ts の savePushSubscription）と、送る直前（push/send.ts の sendWebPush）の**両方**で同じ判定を使う。
// サーバーは endpoint にそのまま POST するので、許可しないと「この世帯の人が好きな URL を登録 → サーバーがそこへ送る」
// 経路（SSRF）になる。許可リストを足す前に登録された購読も、送るときの検査で止める。

/**
 * ブラウザの Push サービス（通知の配信元）のホスト。
 *   Chrome・Edge・Android・Samsung … fcm.googleapis.com
 *   Firefox                        … *.push.services.mozilla.com（updates.push.services.mozilla.com）
 *   Safari・iPhone の PWA          … *.push.apple.com（web.push.apple.com）
 *   Edge（Windows の通知基盤）     … *.notify.windows.com
 * 新しいブラウザが別のホストを使うようになったら、ここに足す
 */
const PUSH_SERVICE_HOSTS: readonly string[] = ['fcm.googleapis.com']
const PUSH_SERVICE_HOST_SUFFIXES: readonly string[] = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com']

/** 小文字にした hostname が、許可した Push サービスのホストか（`*.` は 1 つ以上のラベル。ドメインそのものは含まない） */
export function isPushServiceHost(host: string): boolean {
  return PUSH_SERVICE_HOSTS.includes(host) ||
    PUSH_SERVICE_HOST_SUFFIXES.some((suffix) => host.length > suffix.length && host.endsWith(suffix))
}

/**
 * 送ってよい宛先か：https・資格情報なし・既定のポート（443）・許可した Push サービスのホスト。
 * 読み取れない URL は許可しない（例外は投げない）
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  return url.protocol === 'https:' && !url.username && !url.password && url.port === '' && isPushServiceHost(url.hostname.toLowerCase())
}
