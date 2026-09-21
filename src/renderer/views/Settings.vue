<script setup lang="ts">
import { ref, computed, onMounted, inject, watch, type Ref } from 'vue'
import type { ShippingMethod, CollectorRun, ShopAccount, ShopAccountKind, Tag, UpdateStatus, ShopAccountStats, AiStatus } from '../../shared/types'

type SaleExclusion = { mercari_item_id: string; title: string; excluded_at: string }
import Icon from '../components/Icon.vue'
import StatusChip from '../components/StatusChip.vue'
import Skeleton from '../components/Skeleton.vue'
import TagPicker from '../components/TagPicker.vue'
import type { PromptOptions } from '../components/InputDialog.vue'
import type { ConfirmChoice } from '../components/ConfirmDialog.vue'

const ask = inject<(title: string, opts?: PromptOptions) => Promise<string | null>>('prompt')!
const confirmDialog = inject<(title: string, opts?: { message?: string; okLabel?: string; danger?: boolean }) => Promise<boolean>>('confirm')!
const choose = inject<(title: string, choices: ConfirmChoice[], opts?: { message?: string }) => Promise<string | null>>('choose')!
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!
const revision = inject<Ref<number>>('revision')!
const changed = inject<() => void>('changed', () => {})

const yen = (n: number) => '¥' + n.toLocaleString('ja-JP')

const methods = ref<ShippingMethod[]>([])
const settings = ref<Record<string, string>>({})
const runs = ref<CollectorRun[]>([])
const accounts = ref<ShopAccount[]>([])
const tags = ref<Tag[]>([])
const shopStats = ref<ShopAccountStats[]>([])
const saved = ref('')
const loaded = ref(false)
const updateStatus = ref<UpdateStatus | null>(null)
const checkingUpdate = ref(false)
const installingUpdate = ref(false)
const saleExclusions = ref<SaleExclusion[]>([])
const aiStatus = ref<AiStatus | null>(null)
const aiApiKeyInput = ref('')
const aiModel = ref('gemini-flash-latest')
const savingAiKey = ref(false)
const testingAi = ref(false)
const geminiModels = ref<Array<{ name: string; display_name: string; description: string }>>([])
const loadingModels = ref(false)
const customModelInput = ref('')

/**
 * モデルのセレクトの選択肢。読み込み前は現在の値＋既定だけ、読み込み後は listGeminiModels の結果
 * （display_name（name）で表示、description を title に）
 */
const modelOptions = computed(() => {
  if (geminiModels.value.length) {
    return geminiModels.value.map(m => ({ name: m.name, label: `${m.display_name}（${m.name}）`, title: m.description }))
  }
  const opts: Array<{ name: string; label: string; title: string }> = []
  const seen = new Set<string>()
  if (aiModel.value) {
    opts.push({ name: aiModel.value, label: aiModel.value, title: '' })
    seen.add(aiModel.value)
  }
  if (!seen.has('gemini-flash-latest')) {
    opts.push({ name: 'gemini-flash-latest', label: 'gemini-flash-latest（既定）', title: '' })
  }
  return opts
})

async function load() {
  const [methodsRes, settingsRes, runsRes, accountsRes, tagsRes, updateRes, shopStatsRes, exclusionsRes, aiStatusRes] = await Promise.all([
    window.soroban.listShippingMethods(),
    window.soroban.getSettings(),
    window.soroban.listRuns(10),
    window.soroban.listShopAccounts(),
    window.soroban.listTags(),
    window.soroban.checkForUpdate(),
    window.soroban.listShopAccountStats(),
    window.soroban.listSaleExclusions(),
    window.soroban.getAiStatus(),
  ])
  methods.value = methodsRes
  settings.value = settingsRes
  runs.value = runsRes
  accounts.value = accountsRes
  tags.value = tagsRes
  updateStatus.value = updateRes
  shopStats.value = shopStatsRes
  saleExclusions.value = exclusionsRes
  aiStatus.value = aiStatusRes
  aiModel.value = aiStatusRes.model
  loaded.value = true
}
onMounted(load)

function statsFor(accountId: string): ShopAccountStats | null {
  return shopStats.value.find(s => s.shop_account_id === accountId) ?? null
}

// --- アプリの更新（GitHub Releases） ---

async function checkUpdate() {
  checkingUpdate.value = true
  try {
    updateStatus.value = await window.soroban.checkForUpdate()
  } finally {
    checkingUpdate.value = false
  }
}

async function installUpdateNow() {
  installingUpdate.value = true
  try {
    await window.soroban.installUpdate()
    toast(
      updateStatus.value?.canAutoInstall
        ? 'ダウンロードを始めました。終了時に自動で入れ替わります'
        : 'ダウンロードページを開きました',
      'ok',
    )
  } finally {
    installingUpdate.value = false
  }
}

const updateResultText = computed(() => {
  const s = updateStatus.value
  if (!s) return ''
  if (s.state === 'none') return s.message ?? '最新です'
  if (s.state === 'error') return `確認できません${s.message ? `（${s.message}）` : ''}`
  const firstLine = s.notes?.split('\n').map(l => l.trim()).find(l => l) ?? ''
  return `v${s.latest} があります${firstLine ? `（${firstLine}）` : ''}`
})

// --- AI 読み取り（Gemini） ---

async function saveAiKey() {
  const key = aiApiKeyInput.value.trim()
  if (!key) return
  savingAiKey.value = true
  try {
    await window.soroban.setGeminiApiKey(key)
    aiApiKeyInput.value = ''
    aiStatus.value = await window.soroban.getAiStatus()
    aiModel.value = aiStatus.value.model
    toast('保存しました', 'ok')
    // キーを保存した直後は、そのキーで使えるモデルがまだ分からないので自動で一覧を読み込む
    await loadGeminiModels(true)
  } finally {
    savingAiKey.value = false
  }
}

async function deleteAiKey() {
  if (!await confirmDialog('API キーを削除しますか？', { okLabel: '削除する', danger: true })) return
  await window.soroban.setGeminiApiKey(null)
  aiApiKeyInput.value = ''
  aiStatus.value = await window.soroban.getAiStatus()
  geminiModels.value = []
  toast('削除しました', 'ok')
}

async function changeAiModel(model: string, opts?: { silent?: boolean }) {
  aiModel.value = model
  await window.soroban.setAiModel(model)
  if (!opts?.silent) toast('保存しました', 'ok')
}

/** キーで使えるモデルの一覧を読み込み、選択肢を作る。既定が一覧に無ければ先頭の -latest を選んで保存する */
async function loadGeminiModels(auto = false) {
  loadingModels.value = true
  try {
    geminiModels.value = await window.soroban.listGeminiModels()
    if (!geminiModels.value.some(m => m.name === aiModel.value)) {
      const fallback = geminiModels.value.find(m => m.name.endsWith('-latest')) ?? geminiModels.value[0]
      if (fallback) await changeAiModel(fallback.name, { silent: true })
    }
    if (!auto) toast('読み込みました', 'ok')
  } catch (e) {
    toast((e as Error).message, 'warn')
  } finally {
    loadingModels.value = false
  }
}

async function applyCustomModel() {
  const model = customModelInput.value.trim()
  if (!model) return
  await changeAiModel(model)
  customModelInput.value = ''
}

async function testAiConnection() {
  testingAi.value = true
  try {
    const r = await window.soroban.testGemini()
    toast(r.ok ? '接続できました' : r.message, r.ok ? 'ok' : 'warn')
  } finally {
    testingAi.value = false
  }
}

// 仕入タブでアカウントを増やしたら、こちらの一覧も追従させる
watch(revision, async () => {
  accounts.value = await window.soroban.listShopAccounts()
  shopStats.value = await window.soroban.listShopAccountStats()
})

function flash(msg: string) {
  saved.value = msg
  setTimeout(() => (saved.value = ''), 2500)
}

async function saveSetting(key: string, value: string) {
  await window.soroban.setSetting(key, value)
  flash('保存しました')
}

async function toggleShowWindow(checked: boolean) {
  const value = checked ? '1' : '0'
  settings.value = { ...settings.value, collect_show_window: value }
  await saveSetting('collect_show_window', value)
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

async function restore() {
  const result = await window.soroban.restoreBackup()
  // restarting: true ならアプリがそのまま再起動する。null はダイアログのキャンセル（選択・確認どちらも）
  if (!result) flash('中止しました')
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

async function saveAccountKeywords(a: ShopAccount, value: string) {
  await window.soroban.updateShopAccount(a.id, { import_keywords: value })
  accounts.value = await window.soroban.listShopAccounts()
  toast('保存しました', 'ok')
}

async function saveAccountShippingFee(a: ShopAccount, value: string) {
  const fee = value === '' ? null : Number(value)
  if (fee !== null && (!Number.isFinite(fee) || fee < 0)) {
    toast('送料は 0 以上の整数で入力してください', 'warn')
    accounts.value = await window.soroban.listShopAccounts()
    return
  }
  await window.soroban.updateShopAccount(a.id, { default_shipping_fee: fee })
  accounts.value = await window.soroban.listShopAccounts()
  toast('保存しました', 'ok')
}

// --- 仕入先の自動タグ：作成する仕入・その在庫・販売にそのまま引き継がれる（後から外せる） ---

const tagPickerAccount = ref<ShopAccount | null>(null)
const tagPickerAccountAnchor = ref<HTMLElement | null>(null)

function openAccountTagPicker(a: ShopAccount, e: MouseEvent) {
  tagPickerAccount.value = a
  tagPickerAccountAnchor.value = e.currentTarget as HTMLElement
}

function closeAccountTagPicker() {
  tagPickerAccount.value = null
  tagPickerAccountAnchor.value = null
}

async function onAccountTagChange(tagIds: string[]) {
  if (!tagPickerAccount.value) return
  const id = tagPickerAccount.value.id
  await window.soroban.updateShopAccount(id, { auto_tag_ids: tagIds })
  accounts.value = await window.soroban.listShopAccounts()
  tagPickerAccount.value = accounts.value.find(a => a.id === id) ?? null
}

async function onAccountTagCreate(name: string) {
  if (!tagPickerAccount.value) return
  const id = tagPickerAccount.value.id
  const newTagId = await window.soroban.createTag(name)
  tags.value = await window.soroban.listTags()
  const tagIds = [...tagPickerAccount.value.auto_tags.map(t => t.id), newTagId]
  await window.soroban.updateShopAccount(id, { auto_tag_ids: tagIds })
  accounts.value = await window.soroban.listShopAccounts()
  tagPickerAccount.value = accounts.value.find(a => a.id === id) ?? null
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

async function restoreSaleExclusion(e: SaleExclusion) {
  await window.soroban.removeSaleExclusion(e.mercari_item_id)
  saleExclusions.value = await window.soroban.listSaleExclusions()
  toast('戻しました。次の取り込みで復活します', 'ok')
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
        </div>
        <p class="faint hint">
          メルカリの販売手数料は税込価格に対する率（既定 10%）です。
        </p>
        <p class="faint hint">
          振込手数料などの経費は経費タブで登録します。
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
                  <input type="number" v-model.number="m.fee" @change="saveMethod(m)" style="width:72px" title="税込の実費" />
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
        <label class="row hint">
          <input
            type="checkbox"
            :checked="settings.collect_show_window === '1'"
            @change="toggleShowWindow(($event.target as HTMLInputElement).checked)"
          />
          取り込み中にブラウザのウィンドウを表示する（動きを確認したいときだけ）
        </label>
        <p class="faint hint">
          アプリ起動時、前回から指定時間が空いていれば裏で取り込みます。
          頻度を上げすぎないでください。
        </p>
        <p class="faint hint">
          収集は人間と同じ速度で数ページだけ読みます。普段はオフで大丈夫です。
          本人確認（CAPTCHA）が出たときはウィンドウが自動で表示されるので、
          そこで手で進めてください。
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
        <div class="accounts-table-wrap">
        <table class="compact accounts-table">
          <thead>
            <tr><th>名前</th><th>種別</th><th>取り込みキーワード</th><th>自動タグ</th><th class="num">送料の既定値</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="a in accounts" :key="a.id">
              <td class="name-cell">
                <div>
                  <span :class="{ faint: !a.is_active }">{{ a.name }}</span>
                  <StatusChip v-if="!a.is_active" tone="neutral" label="無効" />
                </div>
                <p class="faint stats-line">
                  <template v-if="statsFor(a.id)">
                    累計：注文 {{ statsFor(a.id)!.orders }}・点数 {{ statsFor(a.id)!.items }}・支払 {{ yen(statsFor(a.id)!.total_cost) }}・最終 {{ statsFor(a.id)!.last_ordered_at ?? '—' }}
                  </template>
                  <template v-else>累計：なし</template>
                </p>
              </td>
              <td>
                <select :value="a.kind" @change="updateAccountKind(a, ($event.target as HTMLSelectElement).value as ShopAccountKind)">
                  <option value="mellojoy">メロジョイ</option>
                  <option value="tiktok">TikTok Shop</option>
                  <option value="other">その他</option>
                </select>
              </td>
              <td class="keywords-cell">
                <textarea
                  v-if="a.kind !== 'other'"
                  rows="1"
                  :value="a.import_keywords ?? ''"
                  placeholder="例：Mellojoy, メロジョイ（空なら全部取り込む）"
                  @change="saveAccountKeywords(a, ($event.target as HTMLTextAreaElement).value)"
                />
                <span v-else class="faint">—</span>
              </td>
              <td class="auto-tags-cell">
                <div class="chip-row">
                  <StatusChip v-for="t in a.auto_tags" :key="t.id" tone="info" :label="t.name" />
                  <button class="sm ghost" @click="openAccountTagPicker(a, $event)" title="自動タグを編集する">タグ</button>
                </div>
              </td>
              <td class="num">
                <span class="num money-cell">
                  <span class="yen">¥</span>
                  <input
                    type="number" min="0" step="1" style="width:90px"
                    :value="a.default_shipping_fee ?? ''"
                    title="手入力の仕入でこの仕入先を選んだとき送料に入る（税込）"
                    @change="saveAccountShippingFee(a, ($event.target as HTMLInputElement).value)"
                  />
                </span>
              </td>
              <td class="actions">
                <div class="actions-row">
                  <button class="sm ghost" @click="renameAccount(a)">改名</button>
                  <button v-if="a.kind === 'mellojoy' && a.is_active" class="sm" @click="openShopLogin(a.id)">
                    <Icon name="login" :size="14" /> ログイン
                  </button>
                  <button class="sm ghost" @click="toggleAccountActive(a)">{{ a.is_active ? '無効にする' : '有効にする' }}</button>
                  <button class="icon ghost" @click="removeAccount(a)" aria-label="削除">
                    <Icon name="trash" :size="16" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <p v-if="!accounts.length" class="faint hint">「仕入先を追加」から登録してください</p>
        <p class="add-row">
          <button class="ghost sm" @click="addShopAccount"><Icon name="plus" :size="14" /> 仕入先を追加</button>
        </p>
        <p class="faint hint">
          メロジョイはアカウントごとに別のブラウザプロファイルでログインします。ログイン状態は保存され、次回から入力は不要です。
          パスワードはアプリに保存しません。「取り込む」でメルカリのあとに注文履歴を読み、合計が合う注文はそのまま仕入に入ります。
        </p>
        <p class="faint hint">
          商品名がどれかに一致する明細だけを取り込みます。一致しない明細の分の送料は原価に入りません。
        </p>
        <p class="faint hint">
          自動タグは、この仕入先の仕入に、登録時に自動で付きます（後から外せます）。在庫・販売まで引き継がれます。
        </p>
        <p class="faint hint">
          送料の既定値は、手入力の仕入でこの仕入先を選んだときに入ります（TikTok Shop なら 399 など）。
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
        <p class="faint hint">
          データベース・レシート画像・サムネ・操作ログ（14 日分）が 1 つの zip に入ります。
          不具合の報告はこのファイルを送ってください。別のパソコンへの引っ越しにも。
        </p>
        <div class="row">
          <button @click="exportCsv"><Icon name="download" :size="16" /> 売上をCSVで書き出す</button>
          <button @click="backup"><Icon name="download" :size="16" /> バックアップを保存（zip）</button>
          <button class="ghost" @click="revealFolder"><Icon name="folder" :size="16" /> 保存フォルダを開く</button>
        </div>
        <div class="danger-zone">
          <p class="faint hint">
            zip（または以前の .db）を選ぶと、今のデータを退避してから置き換え、再起動します。
          </p>
          <button class="danger" @click="restore"><Icon name="refresh" :size="16" /> バックアップから復元</button>
        </div>
        <div class="danger-zone">
          <p class="faint hint">
            販売・仕入・在庫・取り込み履歴をすべて消します。設定・仕入先・発送方法は残ります。
            元に戻せないので、先にバックアップを取ってください。
          </p>
          <button class="danger" @click="resetData">取引データを初期化</button>
        </div>

        <div v-if="saleExclusions.length" class="exclusions-zone">
          <p class="panel-title">取り込まない販売</p>
          <table class="compact">
            <thead>
              <tr><th>商品名</th><th>出品ID</th><th>除外日</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="e in saleExclusions" :key="e.mercari_item_id">
                <td>{{ e.title }}</td>
                <td class="faint">{{ e.mercari_item_id }}</td>
                <td class="faint nowrap">{{ e.excluded_at }}</td>
                <td class="actions">
                  <button class="sm ghost" @click="restoreSaleExclusion(e)">戻す</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="faint hint">
            取り込んだ販売を削除すると、次の取り込みで戻らないようにここに記録されます。
          </p>
        </div>
      </div>

      <!-- AI 読み取り（Gemini） -->
      <div class="panel">
        <div class="section-head">
          <span class="section-head-icon"><Icon name="receipt" :size="16" /></span>
          <h2 class="section-head-title">AI 読み取り（Gemini）</h2>
        </div>
        <p class="faint hint">
          レシートの画像を Google の Gemini に送って、店名・日付・明細・項目を読み取ります（利用者の API キー。無料枠あり）。
        </p>
        <p class="faint hint">
          画像は Google に送られます。無料枠ではデータが Google の改善に使われる規約です。
        </p>
        <p class="faint hint">
          キーは OS の安全な保存（キーチェーン／資格情報マネージャー）で暗号化して保存し、DB には入れません。
        </p>

        <div class="fields">
          <label class="field">
            <span>API キー</span>
            <input
              type="password" style="width:260px"
              v-model="aiApiKeyInput"
              :disabled="!aiStatus?.safe_storage"
              placeholder="新しいキーを入力"
            />
            <span v-if="aiStatus?.configured" class="faint">保存済み（••••）</span>
          </label>
        </div>
        <div class="row">
          <button class="sm" :disabled="!aiStatus?.safe_storage || !aiApiKeyInput.trim() || savingAiKey" @click="saveAiKey">
            {{ savingAiKey ? '保存中…' : '保存' }}
          </button>
          <button v-if="aiStatus?.configured" class="sm ghost" @click="deleteAiKey">削除</button>
        </div>
        <p v-if="aiStatus && !aiStatus.safe_storage" class="faint hint">
          このPCでは OS の安全な保存が使えないため、API キーを保存できません。
        </p>

        <div class="row">
          <button class="ghost sm" :disabled="!aiStatus?.configured || loadingModels" @click="loadGeminiModels()">
            <Icon name="refresh" :size="14" /> {{ loadingModels ? '読み込み中…' : '使えるモデルを読み込む' }}
          </button>
        </div>
        <div class="fields">
          <label class="field">
            <span>モデル</span>
            <select :value="aiModel" style="width:260px" @change="changeAiModel(($event.target as HTMLSelectElement).value)">
              <option v-for="m in modelOptions" :key="m.name" :value="m.name" :title="m.title">{{ m.label }}</option>
            </select>
          </label>
          <label class="field">
            <span>手で入力</span>
            <span class="row model-manual">
              <input
                style="width:200px" v-model="customModelInput"
                placeholder="例：gemini-2.0-flash-exp"
                @keyup.enter="applyCustomModel"
              />
              <button class="sm ghost" :disabled="!customModelInput.trim()" @click="applyCustomModel">使う</button>
            </span>
          </label>
        </div>
        <p class="faint hint">
          キーによって使えるモデルが違います。まず「使えるモデルを読み込む」で一覧を出し、
          gemini-flash-latest（速い）か gemini-pro-latest（精度重視）を選んでください。
        </p>

        <div class="row">
          <button class="ghost sm" :disabled="!aiStatus?.configured || testingAi" @click="testAiConnection">
            <Icon name="refresh" :size="14" /> {{ testingAi ? '確認中…' : '接続を確認' }}
          </button>
        </div>

        <p class="faint hint">
          キーの取得：Google AI Studio で作成 ↗　<code class="ai-key-url">https://aistudio.google.com/apikey</code>
        </p>
      </div>

      <!-- アプリの更新 -->
      <div class="panel">
        <div class="section-head">
          <span class="section-head-icon"><Icon name="refresh" :size="16" /></span>
          <h2 class="section-head-title">アプリの更新</h2>
        </div>
        <p class="faint">現在のバージョン：v{{ updateStatus?.current ?? '—' }}</p>
        <div class="row update-row">
          <button class="ghost" :disabled="checkingUpdate" @click="checkUpdate">
            <Icon name="refresh" :size="16" /> {{ checkingUpdate ? '確認中…' : '更新を確認' }}
          </button>
          <span v-if="updateStatus" class="faint update-result" :title="updateStatus.message ?? undefined">{{ updateResultText }}</span>
        </div>
        <div v-if="updateStatus && (updateStatus.state === 'available' || updateStatus.state === 'downloaded')" class="row">
          <button :disabled="installingUpdate" @click="installUpdateNow">
            <Icon name="download" :size="16" />
            {{ updateStatus.canAutoInstall ? '更新する' : 'ダウンロードページを開く' }}
          </button>
        </div>
        <p class="faint hint">
          Windows は終了時に自動で入れ替わります。macOS は dmg を開いて Applications に上書きしてください（データはそのまま）。
        </p>
      </div>
    </template>

    <TagPicker
      :open="!!tagPickerAccount"
      :anchor="tagPickerAccountAnchor"
      :all-tags="tags"
      :selected="tagPickerAccount?.auto_tags.map(t => t.id) ?? []"
      @change="onAccountTagChange"
      @create="onAccountTagCreate"
      @close="closeAccountTagPicker"
    />
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

.exclusions-zone {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--line-soft);
}
.exclusions-zone .panel-title { margin: 0 0 8px; }

.add-row { margin: 12px 0 0; }
.add-row button { display: inline-flex; align-items: center; gap: 6px; }

/* td は table-cell のまま（display:flex にするとセルとして計算されなくなり、
   名前セルの位置がずれる）。中身側で縦位置と間隔を合わせる */
.name-cell > * { vertical-align: middle; }
.name-cell > * + * { margin-left: 8px; }
.stats-line { margin: 4px 0 0; font-size: var(--fs-12); }

.accounts-table select {
  border-color: transparent;
  background: transparent;
}
.accounts-table select:hover,
.accounts-table select:focus {
  border-color: var(--line);
  background: var(--surface);
}

/* 1024px 幅だと名前や操作ボタンが折り返って崩れるため、テーブルごと横スクロールにする
   （td を display:flex にすると上の .name-cell と同じ理由でセル計算がずれるので、
   操作ボタンは中の .actions-row で横並びにする） */
.accounts-table-wrap { overflow-x: auto; }
.accounts-table { min-width: 900px; }
.accounts-table .name-cell { white-space: nowrap; }
.accounts-table td.actions { white-space: nowrap; }
.actions-row {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
}

.auto-tags-cell { min-width: 180px; }
.auto-tags-cell .chip-row { margin-top: 0; }

.keywords-cell { min-width: 160px; }
.keywords-cell textarea {
  width: 100%;
  min-width: 160px;
  min-height: 36px;
  resize: vertical;
  border-color: transparent;
  background: transparent;
  font-size: var(--fs-13);
}
.keywords-cell textarea:hover,
.keywords-cell textarea:focus {
  border-color: var(--line);
  background: var(--surface);
}

.ai-key-url { user-select: all; font-size: var(--fs-12); background: var(--surface-hi); padding: 1px 6px; border-radius: var(--radius-sm); }
.model-manual { gap: 6px; align-items: center; }

.money-cell { display: inline-flex; align-items: center; justify-content: flex-end; gap: 4px; width: auto; }
.money-cell .yen { color: var(--text-dim); font-size: var(--fs-12); }
.update-row { align-items: center; }
.update-row > button { flex-shrink: 0; white-space: nowrap; }
.update-result { min-width: 0; overflow-wrap: anywhere; }
</style>
