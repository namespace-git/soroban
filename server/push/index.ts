// Push 通知の送信（Cron の Worker と API が使う入口）。WebCrypto と fetch だけで書いてあり、Workers で動く。
// 設計：docs/web/03-agent-and-push.md の 4 節
export { drainDeliveries, sendClaimed, completeDelivery, DEFAULT_DRAIN_LIMIT, MAX_DRAIN_LIMIT } from './deliver'
export type { ClaimedDelivery, DrainOptions, DrainResult } from './deliver'
export { sendWebPush, payloadBytes } from './send'
export type { PushOutcome, PushPayload, PushTarget, SendDeps } from './send'
export { loadVapidKeys, isValidVapidPublicKey, signVapidJwt, vapidAuthorization, VapidConfigError, VAPID_JWT_TTL_SECONDS } from './vapid'
export type { VapidEnv, VapidKeys } from './vapid'
export { encryptPayload, MAX_PLAINTEXT_BYTES } from './encrypt'
export {
  arrivalMessage, clip, enqueueNotification, enqueueSafely, formatYen, notifyArrival, notifyNewSale, notifyShipping,
  saleMessage, shippingMessage,
} from './notify'
export type { NotificationInput, NotificationKind } from './notify'
