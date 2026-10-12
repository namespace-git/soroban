<script setup lang="ts">
// 設定の「通知」の節（Web 版だけ。Settings.vue が isWeb のときに出す）。
// この端末に Push 通知（売れた・発送・取り込み・届いた）を届けるかを決める。
//   - 許可の確認は「この端末で通知を受け取る」を押したときだけ出す（iPhone はボタンからでないと出せない）
//   - iPhone はホーム画面に追加した PWA でだけ受け取れる。判定は機能の有無で、使えなければ案内を出す
//   - サーバーに VAPID の公開鍵が無ければ（getPushConfig）、節ごと出さない
import { ref, computed, onMounted, inject } from 'vue'
import type { PushDevice, PushKinds } from '../../shared/web-types'
import Icon from './Icon.vue'
import StatusChip from './StatusChip.vue'
import { errorText } from './cash-util'
import { allPushKinds, defaultDeviceLabel, PUSH_KIND_ROWS, pushSupport, urlBase64ToUint8Array } from './web-glue'
import { dateTime } from '../format'

const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!
const web = window.sorobanWeb!

const loaded = ref(false)
const vapidKey = ref<string | null>(null)
const devices = ref<PushDevice[]>([])
const busy = ref(false)
const testing = ref(false)
const label = ref(defaultDeviceLabel(navigator.userAgent, navigator.maxTouchPoints))
const permission = ref<NotificationPermission>('Notification' in window ? Notification.permission : 'default')

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

const support = pushSupport({
  hasServiceWorker: 'serviceWorker' in navigator,
  hasPushManager: 'PushManager' in window,
  hasNotification: 'Notification' in window,
  standalone: isStandalone(),
  ua: navigator.userAgent,
  maxTouchPoints: navigator.maxTouchPoints ?? 0,
})

/** このブラウザが今持っている購読。service worker が無い（開発サーバー等）・使えない端末では null */
async function currentSubscription(): Promise<PushSubscription | null> {
  if (support !== 'ready') return null
  const reg = await navigator.serviceWorker.getRegistration()
  return reg ? await reg.pushManager.getSubscription() : null
}

const thisDevice = computed(() => devices.value.find(d => d.is_this_device) ?? null)

async function load() {
  try {
    const config = await web.getPushConfig()
    vapidKey.value = config.vapid_public_key
    if (!config.vapid_public_key) return
    const sub = await currentSubscription().catch(() => null)
    devices.value = await web.listPushDevices(sub?.endpoint ?? null)
  } catch (e) {
    toast(errorText(e), 'warn')
  } finally {
    loaded.value = true
  }
}
onMounted(load)

async function reloadDevices() {
  const sub = await currentSubscription().catch(() => null)
  devices.value = await web.listPushDevices(sub?.endpoint ?? null)
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  // 開発サーバーでは service worker を登録しない。ready は待ち続けるので、先に有無を確かめる
  if (!await navigator.serviceWorker.getRegistration()) {
    throw new Error('この画面では通知を使えません（service worker が動いていません）。ページを開き直してください')
  }
  return navigator.serviceWorker.ready
}

async function enable() {
  const key = vapidKey.value
  if (busy.value || !key) return
  busy.value = true
  let sub = null as PushSubscription | null
  try {
    // 許可の確認は、このボタンを押したときだけ（最初の await）
    const result = await Notification.requestPermission()
    permission.value = result
    if (result !== 'granted') {
      toast(result === 'denied' ? '通知が許可されませんでした。ブラウザの設定から許可に戻してください' : '通知は許可されませんでした', 'warn')
      return
    }
    const reg = await readyRegistration()
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) })
    const json = sub.toJSON()
    const p256dh = json.keys?.p256dh
    const auth = json.keys?.auth
    if (!json.endpoint || !p256dh || !auth) throw new Error('この端末の通知の登録情報を読み取れませんでした')
    await web.savePushSubscription({
      endpoint: json.endpoint,
      p256dh,
      auth,
      label: label.value.trim() || defaultDeviceLabel(navigator.userAgent, navigator.maxTouchPoints),
      kinds: allPushKinds(true),
    })
    sub = null // 保存できた。もう外さない
    await reloadDevices()
    toast('この端末で通知を受け取るようにしました', 'ok')
  } catch (e) {
    // 登録の途中で失敗したら、ブラウザ側だけ購読が残って食い違わないように外す
    if (sub) await sub.unsubscribe().catch(() => false)
    toast(errorText(e), 'warn')
  } finally {
    busy.value = false
  }
}

async function disable() {
  if (busy.value) return
  busy.value = true
  try {
    const sub = await currentSubscription()
    if (sub) {
      // サーバーを先に。失敗したらブラウザの購読は残して、もう一度やり直せるようにする
      await web.deletePushSubscription(sub.endpoint)
      await sub.unsubscribe().catch(() => false)
    }
    await reloadDevices()
    toast('この端末で受け取るのをやめました', 'ok')
  } catch (e) {
    toast(errorText(e), 'warn')
  } finally {
    busy.value = false
  }
}

async function sendTest() {
  if (testing.value) return
  testing.value = true
  try {
    const r = await web.sendTestPush()
    if (r.sent === 0 && r.failed === 0) toast('通知を受け取る端末がありません', 'warn')
    else if (r.failed > 0) toast(`試しの通知を ${r.sent} 台に送りました。送れなかった端末が ${r.failed} 台あります`, 'warn')
    else toast(`試しの通知を ${r.sent} 台に送りました。届いたか確かめてください`, 'ok')
  } catch (e) {
    toast(errorText(e), 'warn')
  } finally {
    testing.value = false
  }
}

async function setKind(d: PushDevice, key: keyof PushKinds, on: boolean) {
  const before = d.kinds
  const kinds: PushKinds = { ...before, [key]: on }
  d.kinds = kinds
  try {
    await web.setPushKinds(d.id, kinds)
  } catch (e) {
    d.kinds = before
    toast(errorText(e), 'warn')
  }
}
</script>

<template>
  <div v-if="vapidKey" class="panel">
    <div class="section-head">
      <span class="section-head-icon"><Icon name="sparkle" :size="16" /></span>
      <h2 class="section-head-title">通知</h2>
    </div>
    <p class="faint hint first">
      売れたとき・発送の番になったとき・取り込みに失敗したとき・仕入が届いたときに、この端末へお知らせします。
    </p>

    <p v-if="support === 'needs-install'" class="push-guide">
      通知を受け取るには、共有ボタンから「ホーム画面に追加」して、ホーム画面のアイコンから開いてください。
    </p>
    <p v-else-if="support === 'unsupported'" class="faint hint">
      このブラウザは通知に対応していません。
    </p>
    <template v-else>
      <p v-if="permission === 'denied'" class="push-denied">
        この端末では通知が拒否されています。ブラウザ（スマホなら設定アプリ）のこのサイトの設定で通知を許可してから、もう一度押してください。
      </p>
      <div v-if="!thisDevice" class="fields push-label">
        <label class="field">
          <span>この端末の名前</span>
          <input v-model="label" maxlength="30" placeholder="例：iPhone" />
        </label>
      </div>
      <div class="row push-actions">
        <button v-if="!thisDevice" class="primary" :disabled="busy" @click="enable">
          {{ busy ? '設定しています…' : 'この端末で通知を受け取る' }}
        </button>
        <button v-else class="ghost" :disabled="busy" @click="disable">この端末で受け取るのをやめる</button>
        <button v-if="devices.length" class="ghost" :disabled="testing" @click="sendTest">
          {{ testing ? '送っています…' : '試しに送る' }}
        </button>
      </div>
    </template>

    <div v-if="devices.length" class="push-devices">
      <div v-for="d in devices" :key="d.id" class="push-device">
        <div class="push-device-head">
          <strong class="push-device-name">{{ d.label }}</strong>
          <StatusChip v-if="d.is_this_device" tone="brand" label="この端末" />
          <span class="faint push-device-date">{{ dateTime(d.created_at) }} に登録</span>
        </div>
        <div class="push-kinds">
          <label v-for="k in PUSH_KIND_ROWS" :key="k.key" class="push-kind" :title="k.example">
            <input
              type="checkbox"
              :checked="d.kinds[k.key]"
              @change="setKind(d, k.key, ($event.target as HTMLInputElement).checked)"
            />
            {{ k.label }}
          </label>
        </div>
      </div>
    </div>
    <p v-else-if="loaded" class="faint hint">通知を受け取る端末はまだありません。</p>
  </div>
</template>

<style scoped>
.hint { margin: 10px 0 0; font-size: var(--fs-12); }
.hint.first { margin-top: 0; }

.push-guide,
.push-denied {
  margin: 12px 0 0;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  font-size: var(--fs-13);
}
.push-guide { background: var(--brand-soft); color: var(--brand-ink); }
.push-denied { background: var(--warn-bg); color: var(--warn); }

.push-label { margin-top: 12px; }
.push-label input { width: 220px; }

.push-actions { margin-top: 12px; flex-wrap: wrap; }
.push-actions button { display: inline-flex; align-items: center; gap: 6px; }

.push-devices { margin-top: 16px; border-top: 1px solid var(--line-soft); }
.push-device { padding: 12px 0; border-bottom: 1px solid var(--line-soft); }
.push-device:last-child { border-bottom: 0; padding-bottom: 0; }
.push-device-head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; }
.push-device-name { font-size: var(--fs-14); }
.push-device-date { font-size: var(--fs-12); }
.push-kinds { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 8px; }
.push-kind { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-13); color: var(--text-dim); }

/* スマホ幅（768px 未満）：入力は全幅 44px、ボタンも 44px 以上、チェックは大きめで押しやすく。
   768px 以上には一切効かせない */
@media (max-width: 767px) {
  .push-label .field { flex: 1 1 100%; }
  .push-label input { width: 100%; height: 44px; }
  .push-actions button { min-height: 44px; flex: 1 1 100%; justify-content: center; }
  .push-actions button.ghost { border-color: var(--line); }
  .push-device-date { flex: 1 1 100%; }
  .push-kinds { flex-direction: column; gap: 0; }
  .push-kind { min-height: 44px; gap: 10px; font-size: var(--fs-14); }
  .push-kind input[type="checkbox"] { width: 20px; height: 20px; }
}
</style>
