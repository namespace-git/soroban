<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { ShippingMethod, CollectorRun } from '../../shared/types'

const methods = ref<ShippingMethod[]>([])
const settings = ref<Record<string, string>>({})
const runs = ref<CollectorRun[]>([])
const saved = ref('')

async function load() {
  methods.value = await window.soroban.listShippingMethods()
  settings.value = await window.soroban.getSettings()
  runs.value = await window.soroban.listRuns(10)
}
onMounted(load)

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
  const name = prompt('発送方法の名前')
  if (!name) return
  const fee = Number(prompt('送料（円）', '0') ?? 0)
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

const runLabel: Record<string, string> = {
  ok: '正常', empty: '0件', auth_required: '要ログイン', failed: '失敗',
}
</script>

<template>
  <div class="wrap">
    <p v-if="saved" class="saved">{{ saved }}</p>

    <!-- 手数料 -->
    <section>
      <h2>手数料</h2>
      <div class="fields">
        <label>
          <span>メルカリ販売手数料（%）</span>
          <input
            type="number" step="0.1"
            :value="Number(settings.fee_rate_bp ?? 1000) / 100"
            @change="saveSetting('fee_rate_bp',
              String(Math.round(Number(($event.target as HTMLInputElement).value) * 100)))"
          />
        </label>
        <label>
          <span>振込手数料（円）</span>
          <input
            type="number"
            :value="settings.transfer_fee ?? 200"
            @change="saveSetting('transfer_fee', ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
      <p class="faint hint">
        手数料率を変えても、登録済みの販売は再計算されません。
        過去の利益を動かさないためです。
      </p>
    </section>

    <!-- 発送方法 -->
    <section>
      <h2>発送方法</h2>
      <table>
        <thead>
          <tr><th>名前</th><th>配送サービス</th><th class="num">送料</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="m in methods" :key="m.id">
            <td><input v-model="m.name" @change="saveMethod(m)" /></td>
            <td><input v-model="m.carrier" @change="saveMethod(m)" placeholder="—" /></td>
            <td class="num">
              <input type="number" v-model.number="m.fee" @change="saveMethod(m)" style="width:90px" />
            </td>
            <td><button class="ghost" @click="removeMethod(m)">✕</button></td>
          </tr>
        </tbody>
      </table>
      <button class="ghost add" @click="addMethod">＋ 発送方法を追加</button>
      <p class="faint hint">
        送料は改定されます。出品画面の表示と食い違ったらここで直してください。
      </p>
    </section>

    <!-- 取り込み -->
    <section>
      <h2>取り込み</h2>
      <div class="fields">
        <label>
          <span>自動取り込みの間隔（時間）</span>
          <input
            type="number"
            :value="settings.collect_interval_h ?? 6"
            @change="saveSetting('collect_interval_h', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label>
          <span>長期滞留とみなす日数</span>
          <input
            type="number"
            :value="settings.aging_warn_days ?? 90"
            @change="saveSetting('aging_warn_days', ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
      <p class="faint hint">
        アプリ起動時、前回から指定時間が空いていれば裏で取り込みます。
        頻度を上げすぎないでください。
      </p>

      <table class="runs">
        <thead>
          <tr><th>日時</th><th>結果</th><th class="num">取得</th><th class="num">追加</th><th>メモ</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in runs" :key="r.id">
            <td class="faint">{{ new Date(r.started_at).toLocaleString('ja-JP') }}</td>
            <td>
              <span class="badge" :class="{ warn: r.status !== 'ok' }">
                {{ runLabel[r.status] ?? r.status }}
              </span>
            </td>
            <td class="num">{{ r.fetched }}</td>
            <td class="num">{{ r.inserted }}</td>
            <td class="faint small">{{ r.message ?? '' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!runs.length" class="dim">まだ実行していません</p>
    </section>

    <!-- データ -->
    <section>
      <h2>データ</h2>
      <p class="faint hint">
        データはこのPCの中だけにあります。壊れたら戻せないので、
        月に1回はバックアップを取ってください。
      </p>
      <div class="row">
        <button @click="exportCsv">売上をCSVで書き出す</button>
        <button @click="backup">データベースをバックアップ</button>
        <button class="ghost" @click="revealFolder">保存フォルダを開く</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wrap { max-width: 800px; display: flex; flex-direction: column; gap: 32px; }

h2 {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
  margin: 0 0 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line-soft);
}

.saved {
  position: sticky;
  top: 0;
  background: #1e2a20;
  color: var(--profit);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  margin: 0;
}

.fields { display: flex; gap: 20px; flex-wrap: wrap; }
.fields label { display: flex; flex-direction: column; gap: 4px; }
.fields span { font-size: 12px; color: var(--text-dim); }

.hint { font-size: 12px; margin: 10px 0 0; }
.add { margin-top: 8px; font-size: 13px; }

.runs { margin-top: 16px; }
.runs .small { font-size: 11px; }
</style>
