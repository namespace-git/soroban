<script setup lang="ts">
// 口座を作る小さなフォーム。設定の「お金の口座」と、月次の「まだ口座が無いとき」の両方で使う。
// 0 円から始められる（はじめの残高の既定は 0）。残高そのものは持たず、「この日にいくらあったか」だけを入れる
import { ref, onMounted, inject } from 'vue'
import type { CashAccountKind } from '../../shared/types'
import { thisMonthLocal } from '../../shared/date'
import Icon from './Icon.vue'
import { ACCOUNT_KINDS, ACCOUNT_KIND_LABEL, parseYen, errorText } from './cash-util'

const emit = defineEmits<{ saved: [] }>()
const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!

const name = ref('')
const kind = ref<CashAccountKind>('bank')
const balance = ref('0')
// 売上がある一番古い月の 1 日（それより前の日付は、この口座には入れられないため）。無ければ今月の 1 日
const openingDate = ref(`${thisMonthLocal()}-01`)
const saving = ref(false)

onMounted(async () => {
  const rows = await window.soroban.listMonthly()
  const months = rows.filter(r => r.kind === 'resale').map(r => r.month).sort()
  if (months.length) openingDate.value = `${months[0]}-01`
})

async function submit() {
  if (saving.value) return
  if (!name.value.trim()) { toast('口座の名前を入力してください', 'warn'); return }
  const b = balance.value.trim() === '' ? { ok: true as const, value: 0 } : parseYen(balance.value)
  if (!b.ok) { toast(b.error, 'warn'); return }
  if (!openingDate.value) { toast('日付を入力してください', 'warn'); return }
  saving.value = true
  try {
    await window.soroban.createCashAccount({
      name: name.value.trim(),
      kind: kind.value,
      opening_balance: b.value,
      opening_date: openingDate.value,
    })
    name.value = ''
    balance.value = '0'
    toast('口座を作りました', 'ok')
    emit('saved')
  } catch (e) {
    toast(errorText(e), 'warn')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="account-form">
    <div class="fields">
      <label class="field">
        <span>口座の名前</span>
        <input v-model="name" style="width:180px" placeholder="例：ゆうちょ銀行" @keydown.enter="submit" />
      </label>
      <label class="field">
        <span>種類</span>
        <select v-model="kind" style="width:150px">
          <option v-for="k in ACCOUNT_KINDS" :key="k" :value="k">{{ ACCOUNT_KIND_LABEL[k] }}</option>
        </select>
      </label>
      <label class="field">
        <span>はじめにあった金額（0円のままでOK）</span>
        <span class="money">
          <span class="yen">¥</span>
          <input v-model="balance" inputmode="numeric" class="amount" style="width:120px" @keydown.enter="submit" />
        </span>
      </label>
      <label class="field">
        <span>いつの時点の金額か</span>
        <input v-model="openingDate" type="date" style="width:150px" />
      </label>
      <button class="primary sm add-btn" :disabled="saving" @click="submit">
        <Icon name="plus" :size="14" /> 口座を作る
      </button>
    </div>
    <p class="faint hint">この日より前の日付は、この口座には記録できません。</p>
  </div>
</template>

<style scoped>
.add-btn { align-self: flex-end; display: inline-flex; align-items: center; gap: 6px; }
.money { display: inline-flex; align-items: center; gap: 4px; }
.money .yen { color: var(--text-dim); font-size: var(--fs-12); }
.amount { text-align: right; font-variant-numeric: tabular-nums; }
.hint { margin: 8px 0 0; font-size: var(--fs-12); }
</style>
