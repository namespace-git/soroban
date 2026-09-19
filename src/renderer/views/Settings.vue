<script setup lang="ts">
import { ref, onMounted, inject, watch, type Ref } from 'vue'
import type { ShippingMethod, CollectorRun, ShopAccount, ShopAccountKind } from '../../shared/types'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import Skeleton from '../components/Skeleton.vue'
import type { PromptOptions } from '../components/InputDialog.vue'

const ask = inject<(title: string, opts?: PromptOptions) => Promise<string | null>>('prompt')!
const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})

const methods = ref<ShippingMethod[]>([])
const settings = ref<Record<string, string>>({})
const runs = ref<CollectorRun[]>([])
const accounts = ref<ShopAccount[]>([])
const saved = ref('')
const loaded = ref(false)

const kindLabel: Record<ShopAccountKind, string> = {
  mellojoy: 'メロジョイ',
  tiktok: 'TikTok Shop',
  other: 'その他',
}

async function load() {
  const [methodsRes, settingsRes, runsRes, accountsRes] = await Promise.all([
    window.soroban.listShippingMethods(),
    window.soroban.getSettings(),
    window.soroban.listRuns(10),
    window.soroban.listShopAccounts(),
  ])
  methods.value = methodsRes
  settings.value = settingsRes
  runs.value = runsRes
  accounts.value = accountsRes
  loaded.value = true
}
onMounted(load)

// 仕入タブでアカウントを増やしたら、こちらの一覧も追従させる
watch(revision, async () => {
  accounts.value = await window.soroban.listShopAccounts()
})

function flash(msg: string) {
  saved.value = msg
  setTimeout(() => (saved.value = ''), 2500)
}

async function saveSetting(key: string, value: string) {
  await window.soroban.setSetting(key, value)
  flash('保存しました')
}

async function saveMethod(m: ShippingMethod) {
  await window.soroban.saveShippingMethod(m)
  flash('保存しました')
  await load()
}

async function addMethod() {
  const name = await ask('発送方法の名前')
  if (!name) return
  const feeInput = await ask('送料（円）', { initial: '0', placeholder: '例：210' })
  if (feeInput === null) return
  const fee = Number(feeInput)
  if (!Number.isFinite(fee)) {
    alert('送料は数字で入力してください')
    return
  }
  await window.soroban.saveShippingMethod({ name, fee, sort_order: 50 })
  await load()
}

async function removeMethod(m: ShippingMethod) {
  if (!confirm(`「${m.name}」を一覧から外しますか？`)) return
  await window.soroban.deleteShippingMethod(m.id)
  await load()
}

async function exportCsv() {
  const p = await window.soroban.exportCsv()
  flash(p ? `書き出しました：${p}` : '中止しました')
}

async function backup() {
  const p = await window.soroban.backupDb()
  flash(p ? `バックアップしました：${p}` : '中止しました')
}

// テンプレートから window は参照できないので包む
function revealFolder() {
  return window.soroban.revealDbFolder()
}

function openLogin() {
  return window.soroban.openLogin()
}

function openShopLogin(id: string) {
  return window.soroban.openShopLogin(id)
}

async function addShopAccount() {
  const name = await ask('仕入先の名前', { placeholder: '例：メロジョイA' })
  if (!name) return
  const isMellojoy = confirm('メロジョイのアカウントですか？（いいえ = TikTok Shop など）')
  await window.soroban.createShopAccount(name, isMellojoy ? 'mellojoy' : 'other')
  accounts.value = await window.soroban.listShopAccounts()
  changed()
}

async function resetData() {
  const input = await ask('確認のため「初期化」と入力してください', { placeholder: '初期化' })
  if (input !== '初期化') return
  await window.soroban.resetData()
  alert('取引データを消しました')
  changed()
}

const runLabel: Record<string, string> = {
  ok: '正常', empty: '0件', auth_required: '要ログイン', failed: '失敗',
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">設定</h1>
      <span class="grow" />
      <StatusChip v-if="saved" tone="ok" :label="saved" />
    </div>

    <div v-if="!loaded" class="panel">
      <Skeleton kind="stats" />
    </div>

    <template v-else>
      <!-- 手数料 -->
      <div class="panel">
        <p class="panel-title">手数料</p>
        <div class="fields">
          <label class="field">
            <span>メルカリ販売手数料（%）</span>
            <input
              type="number" step="0.1" style="width:120px"
              :value="Number(settings.fee_rate_bp ?? 1000) / 100"
              @change="saveSetting('fee_rate_bp',
                String(Math.round(Number(($event.target as HTMLInputElement).value) * 100)))"
            />
          </label>
          <label class="field">
            <span>振込手数料（円）</span>
            <input
              type="number" style="width:120px"
              :value="settings.transfer_fee ?? 200"
              @change="saveSetting('transfer_fee', ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
        <p class="faint hint">
          月1回の振込として、月次の費用に計上します。
        </p>
        <p class="faint hint">
          手数料率を変えても、登録済みの販売は再計算されません。
          過去の利益を動かさないためです。
        </p>
      </div>

      <!-- 発送方法 -->
      <div class="panel table-panel">
        <p class="panel-title">発送方法</p>
        <table class="compact">
          <thead>
            <tr><th>名前</th><th>配送サービス</th><th class="num">送料</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="m in methods" :key="m.id">
              <td><input v-model="m.name" @change="saveMethod(m)" /></td>
              <td><input v-model="m.carrier" @change="saveMethod(m)" placeholder="—" /></td>
              <td class="num">
                <span class="num money-cell">
                  <span class="yen">¥</span>
                  <input type="number" v-model.number="m.fee" @change="saveMethod(m)" style="width:72px" />
                </span>
              </td>
              <td class="actions">
                <button class="icon ghost" @click="removeMethod(m)" aria-label="削除">
                  <Icon name="trash" :size="16" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="panel-foot">
          <button class="ghost sm" @click="addMethod"><Icon name="plus" :size="14" /> 発送方法を追加</button>
          <p class="faint hint">
            送料は改定されます。出品画面の表示と食い違ったらここで直してください。
          </p>
        </div>
      </div>

      <!-- 在庫 -->
      <div class="panel">
        <p class="panel-title">在庫</p>
        <div class="fields">
          <label class="field">
            <span>長期滞留とみなす日数</span>
            <input
              type="number" style="width:120px"
              :value="settings.aging_warn_days ?? 90"
              @change="saveSetting('aging_warn_days', ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
      </div>

      <!-- 取り込み -->
      <div class="panel">
        <p class="panel-title">取り込み</p>
        <div class="fields">
          <label class="field">
            <span>自動取り込みの間隔（時間）</span>
            <input
              type="number" style="width:120px"
              :value="settings.collect_interval_h ?? 1"
              @change="saveSetting('collect_interval_h', ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
        <p class="faint hint">
          アプリ起動時、前回から指定時間が空いていれば裏で取り込みます。
          頻度を上げすぎないでください。
        </p>
        <p class="faint hint">
          収集は人間と同じ速度で数ページだけ読みます。本人確認が出たら止まるので、
          「メルカリにログイン」から手で進めてください。
        </p>

        <p class="panel-title runs-title">実行履歴</p>
        <table class="compact">
          <thead>
            <tr><th>日時</th><th>結果</th><th class="num">取得</th><th class="num">追加</th><th>メモ</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in runs" :key="r.id">
              <td class="faint">{{ new Date(r.started_at).toLocaleString('ja-JP') }}</td>
              <td>
                <StatusChip
                  :tone="r.status === 'ok' ? 'ok' : 'warn'"
                  :label="runLabel[r.status] ?? r.status"
                />
              </td>
              <td class="num">{{ r.fetched }}</td>
              <td class="num">{{ r.inserted }}</td>
              <td class="faint small">{{ r.message ?? '' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!runs.length" class="dim">まだ実行していません</p>
      </div>

      <!-- メルカリ -->
      <div class="panel">
        <p class="panel-title">メルカリ</p>
        <div class="row">
          <button @click="openLogin"><Icon name="login" :size="16" /> メルカリにログイン</button>
          <p class="faint">初回だけ。以後はセッションを再利用します</p>
        </div>
        <div class="fields">
          <label class="field">
            <span>転売と判定するキーワード（カンマ区切りで複数可）</span>
            <input
              style="width:320px"
              placeholder="例：メロジョイ, Mellojoy"
              :value="settings.mercari_keyword ?? ''"
              @change="saveSetting('mercari_keyword', ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
      </div>

      <!-- 仕入先 -->
      <div class="panel">
        <p class="panel-title">仕入先</p>
        <table class="compact">
          <thead>
            <tr><th>名前</th><th>種別</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="a in accounts" :key="a.id">
              <td>{{ a.name }}</td>
              <td><StatusChip tone="neutral" :label="kindLabel[a.kind]" /></td>
              <td class="actions">
                <button v-if="a.kind === 'mellojoy'" class="sm" @click="openShopLogin(a.id)">
                  <Icon name="login" :size="14" /> ログイン
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!accounts.length" class="faint hint">「仕入先を追加」から登録してください</p>
        <p class="add-account">
          <button class="ghost sm" @click="addShopAccount"><Icon name="plus" :size="14" /> 仕入先を追加</button>
        </p>
        <p class="faint hint">
          メロジョイはアカウントごとに別のブラウザプロファイルでログインします。ログイン状態は保存され、次回から入力は不要です。
          パスワードはアプリに保存しません。注文履歴の取り込みは準備中です。
        </p>
      </div>

      <!-- データ -->
      <div class="panel">
        <p class="panel-title">データ</p>
        <p class="faint hint">
          データはこのPCの中だけにあります。壊れたら戻せないので、
          月に1回はバックアップを取ってください。
        </p>
        <div class="row">
          <button @click="exportCsv"><Icon name="download" :size="16" /> 売上をCSVで書き出す</button>
          <button @click="backup"><Icon name="download" :size="16" /> データベースをバックアップ</button>
          <button class="ghost" @click="revealFolder"><Icon name="folder" :size="16" /> 保存フォルダを開く</button>
        </div>
        <div class="danger-zone">
          <p class="faint hint">
            販売・仕入・在庫・取り込み履歴をすべて消します。設定・仕入先・発送方法は残ります。
            元に戻せないので、先にバックアップを取ってください。
          </p>
          <button class="danger" @click="resetData">取引データを初期化</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.hint { margin: 10px 0 0; font-size: var(--fs-12); }

.table-panel { padding: 0; overflow: hidden; }
.table-panel .panel-title { padding: 16px 20px 0; margin: 0 0 12px; }
.table-panel table { margin: 0; }

.table-panel td input {
  border-color: transparent;
  background: transparent;
}
.table-panel td input:hover,
.table-panel td input:focus {
  border-color: var(--line);
  background: var(--surface);
}

.panel-foot {
  padding: 12px 20px 16px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.panel-foot button, .row button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.runs-title { margin-top: 16px; }
.small { font-size: var(--fs-12); }

.danger-zone {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--line-soft);
}

.add-account { margin: 12px 0 0; }
.add-account button { display: inline-flex; align-items: center; gap: 6px; }

.money-cell { display: inline-flex; align-items: center; justify-content: flex-end; gap: 4px; width: auto; }
.money-cell .yen { color: var(--text-dim); font-size: var(--fs-12); }
</style>
