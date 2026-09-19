<script setup lang="ts">
import { ref, onMounted, inject, watch, type Ref } from 'vue'
import type { ShippingMethod, CollectorRun, ShopAccount, ShopAccountKind, Tag } from '../../shared/types'
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import Skeleton from '../components/Skeleton.vue'
import type { PromptOptions } from '../components/InputDialog.vue'
import type { ConfirmChoice } from '../components/ConfirmDialog.vue'

const ask = inject<(title: string, opts?: PromptOptions) => Promise<string | null>>('prompt')!
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const choose = inject<(title: string, choices: ConfirmChoice[], opts?: { message?: string }) => Promise<string | null>>('choose')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!
const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})

const methods = ref<ShippingMethod[]>([])
const settings = ref<Record<string, string>>({})
const runs = ref<CollectorRun[]>([])
const accounts = ref<ShopAccount[]>([])
const tags = ref<Tag[]>([])
const saved = ref('')
const loaded = ref(false)

async function load() {
  const [methodsRes, settingsRes, runsRes, accountsRes, tagsRes] = await Promise.all([
    window.soroban.listShippingMethods(),
    window.soroban.getSettings(),
    window.soroban.listRuns(10),
    window.soroban.listShopAccounts(),
    window.soroban.listTags(),
  ])
  methods.value = methodsRes
  settings.value = settingsRes
  runs.value = runsRes
  accounts.value = accountsRes
  tags.value = tagsRes
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
    toast('送料は数字で入力してください', 'warn')
    return
  }
  await window.soroban.saveShippingMethod({ name, fee, sort_order: 50 })
  await load()
}

async function removeMethod(m: ShippingMethod) {
  if (!await confirmDialog(`「${m.name}」を一覧から外しますか？`, { okLabel: '外す', danger: true })) return
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
  const kind = await choose('種別', [
    { label: 'その他', value: 'other', tone: 'ghost' },
    { label: 'TikTok Shop', value: 'tiktok', tone: 'ghost' },
    { label: 'メロジョイ', value: 'mellojoy' },
  ])
  if (!kind) return
  await window.soroban.createShopAccount(name, kind as ShopAccountKind)
  accounts.value = await window.soroban.listShopAccounts()
  changed()
}

async function renameAccount(a: ShopAccount) {
  const name = await ask('仕入先の名前', { initial: a.name })
  if (!name) return
  await window.soroban.updateShopAccount(a.id, { name })
  accounts.value = await window.soroban.listShopAccounts()
  changed()
}

async function updateAccountKind(a: ShopAccount, kind: ShopAccountKind) {
  await window.soroban.updateShopAccount(a.id, { kind })
  accounts.value = await window.soroban.listShopAccounts()
  changed()
}

async function toggleAccountActive(a: ShopAccount) {
  await window.soroban.updateShopAccount(a.id, { is_active: a.is_active ? 0 : 1 })
  accounts.value = await window.soroban.listShopAccounts()
  changed()
}

async function removeAccount(a: ShopAccount) {
  if (!await confirmDialog(`「${a.name}」を削除しますか？`, {
    message: 'ログイン状態も消えます',
    okLabel: '削除する',
    danger: true,
  })) return
  try {
    await window.soroban.deleteShopAccount(a.id)
    accounts.value = await window.soroban.listShopAccounts()
    changed()
  } catch (e) {
    toast((e as Error).message, 'warn')
  }
}

async function addTag() {
  const name = await ask('タグの名前', { placeholder: '例：セール' })
  if (!name) return
  try {
    await window.soroban.createTag(name)
    tags.value = await window.soroban.listTags()
    changed()
  } catch (e) {
    toast((e as Error).message, 'warn')
  }
}

async function renameTag(t: Tag) {
  const name = await ask('タグの名前', { initial: t.name })
  if (!name) return
  try {
    await window.soroban.renameTag(t.id, name)
    tags.value = await window.soroban.listTags()
    changed()
  } catch (e) {
    toast((e as Error).message, 'warn')
  }
}

async function deleteTag(t: Tag) {
  if (!await confirmDialog(`「${t.name}」を消しますか？`, {
    message: '付いている販売・在庫からも外れます',
    okLabel: '削除する',
    danger: true,
  })) return
  await window.soroban.deleteTag(t.id)
  tags.value = await window.soroban.listTags()
  changed()
}

async function resetData() {
  const input = await ask('確認のため「初期化」と入力してください', { placeholder: '初期化' })
  if (input !== '初期化') return
  await window.soroban.resetData()
  toast('取引データを消しました', 'ok')
  changed()
}

const runLabel: Record<string, string> = {
  ok: '正常', empty: '0件', auth_required: '要ログイン', failed: '失敗',
}
</script>

<template>
  <div class="page narrow">
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
        <div class="section-head">
          <span class="section-head-icon"><Icon name="sales" :size="16" /></span>
          <h2 class="section-head-title">手数料</h2>
        </div>
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
        <div class="section-head">
          <span class="section-head-icon"><Icon name="external" :size="16" /></span>
          <h2 class="section-head-title">発送方法</h2>
        </div>
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
        <div class="section-head">
          <span class="section-head-icon"><Icon name="inventory" :size="16" /></span>
          <h2 class="section-head-title">在庫</h2>
        </div>
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
        <div class="section-head">
          <span class="section-head-icon"><Icon name="refresh" :size="16" /></span>
          <h2 class="section-head-title">取り込み</h2>
        </div>
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
            <tr><th>日時</th><th class="col-target">対象</th><th>結果</th><th class="num">取得</th><th class="num">追加</th><th>メモ</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in runs" :key="r.id">
              <td class="faint">{{ new Date(r.started_at).toLocaleString('ja-JP') }}</td>
              <td class="faint col-target">{{ r.source === 'mercari' ? 'メルカリ' : (r.shop_account_name ?? 'メロジョイ') }}</td>
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
        <div class="section-head">
          <span class="section-head-icon"><Icon name="login" :size="16" /></span>
          <h2 class="section-head-title">メルカリ</h2>
        </div>
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
        <div class="section-head">
          <span class="section-head-icon"><Icon name="purchase" :size="16" /></span>
          <h2 class="section-head-title">仕入先</h2>
        </div>
        <table class="compact accounts-table">
          <thead>
            <tr><th>名前</th><th>種別</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="a in accounts" :key="a.id">
              <td class="name-cell">
                <span :class="{ faint: !a.is_active }">{{ a.name }}</span>
                <StatusChip v-if="!a.is_active" tone="neutral" label="無効" />
              </td>
              <td>
                <select :value="a.kind" @change="updateAccountKind(a, ($event.target as HTMLSelectElement).value as ShopAccountKind)">
                  <option value="mellojoy">メロジョイ</option>
                  <option value="tiktok">TikTok Shop</option>
                  <option value="other">その他</option>
                </select>
              </td>
              <td class="actions">
                <button class="sm ghost" @click="renameAccount(a)">改名</button>
                <button v-if="a.kind === 'mellojoy' && a.is_active" class="sm" @click="openShopLogin(a.id)">
                  <Icon name="login" :size="14" /> ログイン
                </button>
                <button class="sm ghost" @click="toggleAccountActive(a)">{{ a.is_active ? '無効にする' : '有効にする' }}</button>
                <button class="icon ghost" @click="removeAccount(a)" aria-label="削除">
                  <Icon name="trash" :size="16" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!accounts.length" class="faint hint">「仕入先を追加」から登録してください</p>
        <p class="add-row">
          <button class="ghost sm" @click="addShopAccount"><Icon name="plus" :size="14" /> 仕入先を追加</button>
        </p>
        <p class="faint hint">
          メロジョイはアカウントごとに別のブラウザプロファイルでログインします。ログイン状態は保存され、次回から入力は不要です。
          パスワードはアプリに保存しません。「取り込む」でメルカリのあとに注文履歴を読み、合計が合う注文はそのまま仕入に入ります。
        </p>
      </div>

      <!-- タグ -->
      <div class="panel">
        <div class="section-head">
          <span class="section-head-icon"><Icon name="note" :size="16" /></span>
          <h2 class="section-head-title">タグ</h2>
        </div>
        <table class="compact">
          <thead>
            <tr><th>名前</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="t in tags" :key="t.id">
              <td><StatusChip tone="info" :label="t.name" /></td>
              <td class="actions">
                <button class="sm ghost" @click="renameTag(t)">改名</button>
                <button class="icon ghost" @click="deleteTag(t)" aria-label="削除">
                  <Icon name="trash" :size="16" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!tags.length" class="faint">タグはまだありません</p>
        <p class="add-row">
          <button class="ghost sm" @click="addTag"><Icon name="plus" :size="14" /> タグを追加</button>
        </p>
        <p class="faint hint">
          販売と在庫に付けて、売上タブで絞り込めます。
        </p>
      </div>

      <!-- データ -->
      <div class="panel">
        <div class="section-head">
          <span class="section-head-icon"><Icon name="folder" :size="16" /></span>
          <h2 class="section-head-title">データ</h2>
        </div>
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
.table-panel .section-head { padding: 16px 20px 0; margin-bottom: 12px; }
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
.col-target { width: 96px; }

.danger-zone {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--line-soft);
}

.add-row { margin: 12px 0 0; }
.add-row button { display: inline-flex; align-items: center; gap: 6px; }

/* td は table-cell のまま（display:flex にするとセルとして計算されなくなり、
   名前セルの位置がずれる）。中身側で縦位置と間隔を合わせる */
.name-cell > * { vertical-align: middle; }
.name-cell > * + * { margin-left: 8px; }

.accounts-table select {
  border-color: transparent;
  background: transparent;
}
.accounts-table select:hover,
.accounts-table select:focus {
  border-color: var(--line);
  background: var(--surface);
}

.money-cell { display: inline-flex; align-items: center; justify-content: flex-end; gap: 4px; width: auto; }
.money-cell .yen { color: var(--text-dim); font-size: var(--fs-12); }
</style>
