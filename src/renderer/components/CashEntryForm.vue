<script setup lang="ts">
// 月次タブの「お金を記録する」。入ってきた／出ていったお金を 1 件入れる。
// いちばん大事なのは出金：「何の支払いか」を選ぶと、残っている支払い待ち（仕入・借りたお金）が出てきて、
// 行を選ぶだけで全額、金額を直せば一部だけ消し込める（1 回の振込で複数の行も消せる）。
// 消し込みの合計が入出金の額を超える入力・残りを超える入力は、押す前にここで止める（main も同じ検査をする）。
// 金額は円の整数。表記ゆれ（¥・円・桁区切り・全角）は parseYen（Sales.vue の normalizeYenInput と同じ規則）で受ける。
import { ref, computed, watch, inject } from 'vue'
import type { CashAccount, CashCategory, Liability, LiabilityKind } from '../../shared/types'
import { todayLocal } from '../../shared/date'
import { yen, shortDate } from '../format'
import Icon from './Icon.vue'
import { parsePositiveYen, errorText, lastDayOfMonth } from './cash-util'

const props = defineProps<{
  month: string
  accounts: CashAccount[]
  /** 残りのある債務（全種類）。種類は区分ごとにここで絞る */
  liabilities: Liability[]
  /** 設定の「毎月いくら返すか」。0＝未設定 */
  monthlyRepay: number
  /** この月に注文した仕入の合計（月次の計算書の値）。支払い待ちを足すときの金額の初期値に使うだけ */
  purchaseOfMonth: number | null
}>()
const emit = defineEmits<{ saved: [] }>()

const toast = inject<(text: string, kind: 'ok' | 'warn') => void>('toast')!
const goto = inject<(t: string) => void>('goto')!

type Direction = 'in' | 'out'
const CATEGORIES: Record<Direction, Array<{ key: CashCategory; label: string; settle?: LiabilityKind }>> = {
  out: [
    { key: 'purchase_payment', label: '仕入の支払い', settle: 'purchase' },
    { key: 'loan_repay', label: '借りたお金を返す', settle: 'loan' },
    { key: 'tool_share', label: 'ツール分', settle: 'tool_share' },
    { key: 'allowance', label: 'お小遣い' },
    { key: 'expense', label: '経費' },
    { key: 'other', label: 'その他' },
  ],
  in: [
    { key: 'sale_payout', label: 'フリマの売上金' },
    { key: 'loan_in', label: '借りた' },
    { key: 'other', label: 'その他' },
  ],
}

const direction = ref<Direction>('out')
const category = ref<CashCategory>('purchase_payment')
const amountText = ref('')
// 人が金額を直接触ったか（触ったあとは、消す分の合計に自動で合わせない）
let amountTouched = false
const note = ref('')
const accountId = ref('')
const saving = ref(false)
const alsoLoan = ref(true)

function defaultDate(month: string): string {
  const today = todayLocal()
  return today.slice(0, 7) === month ? today : lastDayOfMonth(month)
}
const date = ref(defaultDate(props.month))
watch(() => props.month, (m) => { date.value = defaultDate(m) })

// ツール分は、残っているものがあるときだけ選択肢に出す（無いのに出すと「これは何？」になる）
const hasOpenToolShare = computed(() => props.liabilities.some(l => l.kind === 'tool_share' && l.remaining > 0))
const categories = computed(() =>
  CATEGORIES[direction.value].filter(c => c.key !== 'tool_share' || hasOpenToolShare.value || category.value === 'tool_share'),
)
const currentCategory = computed(() => CATEGORIES[direction.value].find(c => c.key === category.value)!)
const settleKind = computed(() => currentCategory.value.settle ?? null)

const activeAccounts = computed(() => props.accounts.filter(a => a.is_active))
watch(activeAccounts, (list) => {
  if (!list.some(a => a.id === accountId.value)) accountId.value = list[0]?.id ?? ''
}, { immediate: true })
const account = computed(() => activeAccounts.value.find(a => a.id === accountId.value) ?? null)

// --- 消し込む相手（支払い待ち） ---

const rows = computed(() => {
  const kind = settleKind.value
  if (!kind) return []
  return props.liabilities
    .filter(l => l.kind === kind && l.remaining > 0)
    .sort((a, b) =>
      (a.due_at === null ? 1 : 0) - (b.due_at === null ? 1 : 0)
      || (a.due_at ?? '').localeCompare(b.due_at ?? '')
      || a.occurred_at.localeCompare(b.occurred_at))
})

// 行ごとの「消すか・いくら消すか」。on の行だけが消し込みになる
const picks = ref<Record<string, { on: boolean; text: string }>>({})
// 人が行を触ったあとは、裏の読み直しで勝手に選び直さない
let picksTouched = false
let justAddedId: string | null = null

function rowName(l: Liability): string {
  if (l.kind === 'purchase') return `${l.month ?? l.occurred_at.slice(0, 7)} ぶんの仕入（${l.counterparty}）`
  if (l.kind === 'loan') return `${shortDate(l.occurred_at)} に借りた分（${l.counterparty}）${l.note ? `　${l.note}` : ''}`
  return `ツール分（${shortDate(l.occurred_at)}）`
}
function rowSub(l: Liability): string {
  const parts = [`残り ${yen(l.remaining)}`]
  if (l.settled > 0) parts.push(`${yen(l.amount)} のうち ${yen(l.settled)} は払い済み`)
  if (l.due_at) parts.push(`期限 ${shortDate(l.due_at)}`)
  return parts.join(' ・ ')
}

/** 区分に合わせた初期の選び方。仕入＝いちばん古い 1 件を全額、借りたお金＝毎月の返済額を古い順に（無ければ選ばない） */
function applyDefaults() {
  const next: Record<string, { on: boolean; text: string }> = {}
  const list = rows.value
  if (justAddedId && list.some(l => l.id === justAddedId)) {
    const l = list.find(x => x.id === justAddedId)!
    next[l.id] = { on: true, text: String(l.remaining) }
  } else if (settleKind.value === 'purchase' && list.length) {
    next[list[0].id] = { on: true, text: String(list[0].remaining) }
  } else if (settleKind.value === 'loan' && props.monthlyRepay > 0) {
    let budget = props.monthlyRepay
    for (const l of list) {
      if (budget <= 0) break
      const a = Math.min(budget, l.remaining)
      next[l.id] = { on: true, text: String(a) }
      budget -= a
    }
  }
  justAddedId = null
  picks.value = next
  picksTouched = false
  amountTouched = false
  syncAmount()
}

function pickedAmount(id: string): number | null {
  const p = picks.value[id]
  if (!p?.on) return null
  const parsed = parsePositiveYen(p.text, '')
  return parsed.ok ? parsed.value : null
}

const settleSum = computed(() =>
  rows.value.reduce((s, l) => s + (pickedAmount(l.id) ?? 0), 0),
)
const anyPicked = computed(() => rows.value.some(l => picks.value[l.id]?.on))

/** 金額は、消す分の合計に自動で合わせる（人が金額を直接触ったあとは触らない） */
function syncAmount() {
  if (amountTouched) return
  amountText.value = settleSum.value > 0 ? String(settleSum.value) : ''
}

function togglePick(l: Liability) {
  picksTouched = true
  const cur = picks.value[l.id]
  picks.value = { ...picks.value, [l.id]: cur?.on ? { on: false, text: cur.text } : { on: true, text: String(l.remaining) } }
  syncAmount()
}
function onPickText(l: Liability, text: string) {
  picksTouched = true
  picks.value = { ...picks.value, [l.id]: { on: true, text } }
  syncAmount()
}
function fillFull(l: Liability) {
  onPickText(l, String(l.remaining))
}
function onAmountInput(text: string) {
  amountText.value = text
  // 空に戻したら、また自動で合わせる
  amountTouched = text.trim() !== ''
  if (!amountTouched) syncAmount()
}

watch([direction, category], () => {
  note.value = ''
  amountText.value = ''
  amountTouched = false
  applyDefaults()
})
watch(() => props.monthlyRepay, () => { if (!picksTouched) applyDefaults() })

// 裏で債務の一覧が変わったとき（記録した直後・入出金を消したとき・支払い待ちを足したとき）
const liabilitySignature = computed(() => props.liabilities.map(l => `${l.id}:${l.remaining}`).join(','))
watch(liabilitySignature, () => {
  if (justAddedId || !picksTouched) { applyDefaults(); return }
  // 触っている最中：もう無い行・残りが減った行だけ直す
  const next: Record<string, { on: boolean; text: string }> = {}
  for (const l of rows.value) {
    const p = picks.value[l.id]
    if (!p) continue
    next[l.id] = p
  }
  picks.value = next
  syncAmount()
})
applyDefaults()

function setDirection(d: Direction) {
  if (direction.value === d) return
  direction.value = d
  category.value = CATEGORIES[d][0].key
}

// --- 入力の検査（押す前に画面で止める） ---

const amountParsed = computed(() => parsePositiveYen(amountText.value))

/** 選んだ行の金額が読めない・残りを超えているときの理由（無ければ null） */
function rowProblem(l: Liability): string | null {
  const p = picks.value[l.id]
  if (!p?.on) return null
  const parsed = parsePositiveYen(p.text)
  if (!parsed.ok) return `${rowName(l)}：${parsed.error}`
  if (parsed.value > l.remaining) return `${rowName(l)}：残りは ${yen(l.remaining)} です。それより多くは消せません`
  return null
}
const rowProblems = computed(() => rows.value.map(rowProblem).filter((m): m is string => m !== null))

const problem = computed<string | null>(() => {
  if (rowProblems.value.length) return rowProblems.value[0]
  if (amountText.value.trim() !== '' && !amountParsed.value.ok) return amountParsed.value.error
  if (amountParsed.value.ok && settleSum.value > amountParsed.value.value) {
    return `消す分の合計（${yen(settleSum.value)}）が、金額（${yen(amountParsed.value.value)}）を超えています`
  }
  if (date.value && date.value.slice(0, 7) !== props.month) {
    return `${props.month} の日付を入れてください（別の月は、その月を開いて記録します）`
  }
  if (date.value && account.value && date.value < account.value.opening_date) {
    return `「${account.value.name}」は ${account.value.opening_date} から数えています。それより前の日付は入れられません`
  }
  return null
})

const canSubmit = computed(() =>
  !saving.value && !problem.value && amountParsed.value.ok && !!date.value && !!account.value,
)

const submitLabel = computed(() => amountParsed.value.ok ? `${yen(amountParsed.value.value)} を記録する` : '記録する')

// 一部だけ払ったときの見え方（金額が消す分より多い＝その差は支払い待ちに充てない）
const extraAmount = computed(() =>
  amountParsed.value.ok && anyPicked.value ? Math.max(0, amountParsed.value.value - settleSum.value) : 0,
)

async function submit() {
  if (!canSubmit.value || !account.value || !amountParsed.value.ok) return
  const amount = amountParsed.value.value
  const settles = rows.value
    .map(l => ({ liability_id: l.id, amount: pickedAmount(l.id) }))
    .filter((s): s is { liability_id: string; amount: number } => s.amount !== null)
  saving.value = true
  try {
    await window.soroban.createCashEntry({
      account_id: account.value.id,
      occurred_at: date.value,
      direction: direction.value,
      amount,
      category: category.value,
      note: note.value.trim() || null,
      settles: settles.length ? settles : undefined,
    })
    let message = '記録しました'
    if (category.value === 'loan_in' && alsoLoan.value) {
      try {
        await window.soroban.createLiability({
          kind: 'loan', counterparty: '夫', occurred_at: date.value, amount, note: note.value.trim() || null,
        })
        message = '記録しました（借りたお金としても残しました）'
      } catch (e) {
        toast(`入金は記録しましたが、借りたお金としての記録に失敗しました：${errorText(e)}`, 'warn')
      }
    }
    toast(message, 'ok')
    amountText.value = ''
    amountTouched = false
    note.value = ''
    applyDefaults()
    emit('saved')
  } catch (e) {
    toast(errorText(e), 'warn')
  } finally {
    saving.value = false
  }
}

// --- 支払い待ちの仕入を足す（仕入は末締め・翌月払い。月ごとに 1 本） ---

const addDueOpen = ref(false)
const showAddDue = computed(() => addDueOpen.value || (settleKind.value === 'purchase' && rows.value.length === 0))
const dueMonth = ref(props.month)
const dueAmount = ref('')
const dueDate = ref('')
const addingDue = ref(false)

function nextMonthFifteenth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m, 1) // 翌月の 1 日
  return `${todayLocal(d).slice(0, 7)}-15`
}
function resetDueForm() {
  dueMonth.value = props.month
  dueAmount.value = props.purchaseOfMonth ? String(props.purchaseOfMonth) : ''
  dueDate.value = nextMonthFifteenth(props.month)
}
resetDueForm()
watch([() => props.month, () => props.purchaseOfMonth], resetDueForm)

function onDueMonthChange(m: string) {
  dueMonth.value = m
  if (/^\d{4}-\d{2}$/.test(m)) dueDate.value = nextMonthFifteenth(m)
  // 初期値に入れた「この月の仕入の合計」は、見ている月のぶんだけ。別の月に変えたら外す（別の月の額を誤って入れない）
  const hint = props.purchaseOfMonth ? String(props.purchaseOfMonth) : ''
  if (m !== props.month && dueAmount.value === hint) dueAmount.value = ''
  else if (m === props.month && dueAmount.value === '') dueAmount.value = hint
}

async function addDue() {
  if (addingDue.value) return
  if (!/^\d{4}-\d{2}$/.test(dueMonth.value)) { toast('何月ぶんかを入力してください', 'warn'); return }
  const amount = parsePositiveYen(dueAmount.value, '支払う金額を入力してください')
  if (!amount.ok) { toast(amount.error, 'warn'); return }
  addingDue.value = true
  try {
    const id = await window.soroban.createLiability({
      kind: 'purchase',
      counterparty: 'メロジョイ',
      occurred_at: lastDayOfMonth(dueMonth.value),
      due_at: dueDate.value || null,
      amount: amount.value,
      month: dueMonth.value,
    })
    justAddedId = id
    addDueOpen.value = false
    resetDueForm()
    toast('支払い待ちに入れました', 'ok')
    emit('saved')
  } catch (e) {
    toast(errorText(e), 'warn')
  } finally {
    addingDue.value = false
  }
}
</script>

<template>
  <div class="entry-form">
    <div class="seg" role="group" aria-label="入ったか出たか">
      <button type="button" :class="{ on: direction === 'out' }" @click="setDirection('out')">出ていった</button>
      <button type="button" :class="{ on: direction === 'in' }" @click="setDirection('in')">入ってきた</button>
    </div>

    <div class="chips" role="group" aria-label="何のお金か">
      <button
        v-for="c in categories" :key="c.key" type="button" class="chip-btn"
        :class="{ on: category === c.key }" @click="category = c.key"
      >{{ c.label }}</button>
    </div>

    <!-- 何の支払いか：残っている支払い待ちを選ぶと消し込める -->
    <div v-if="settleKind" class="settle">
      <p class="settle-title">
        {{ settleKind === 'purchase' ? 'どの仕入の支払いですか' : settleKind === 'loan' ? 'どの借りたお金を返しますか' : 'どのツール分ですか' }}
        <span class="faint">（選ぶと残りから引かれます）</span>
      </p>

      <div v-if="rows.length" class="settle-list">
        <div v-for="l in rows" :key="l.id" class="settle-row" :class="{ on: picks[l.id]?.on }">
          <label class="settle-pick">
            <input type="checkbox" :checked="!!picks[l.id]?.on" @change="togglePick(l)" />
            <span class="settle-main">
              <span class="settle-name" :title="rowName(l)">{{ rowName(l) }}</span>
              <span class="settle-sub" :title="rowSub(l)">{{ rowSub(l) }}</span>
            </span>
          </label>
          <span v-if="picks[l.id]?.on" class="settle-amount">
            <span class="yen">¥</span>
            <input
              :value="picks[l.id].text" inputmode="numeric" class="amount"
              :class="{ invalid: rowProblem(l) !== null }"
              :title="`この行で消す金額（残り ${yen(l.remaining)}）。一部だけなら減らします`"
              @input="onPickText(l, ($event.target as HTMLInputElement).value)"
              @keydown.enter="submit"
            />
            <button
              v-if="picks[l.id].text !== String(l.remaining)" type="button" class="sm ghost full-btn"
              title="残りを全部払う" @click="fillFull(l)"
            >全額</button>
          </span>
        </div>
      </div>
      <p v-else-if="settleKind === 'purchase'" class="faint settle-empty">
        支払い待ちの仕入はまだ入っていません。下から入れると、ここで消し込めます。
      </p>
      <p v-else-if="settleKind === 'loan'" class="faint settle-empty">
        返す相手の借りたお金が入っていません。
        <button type="button" class="sm link-btn-plain" @click="goto('settings')">設定の「借りたお金」で入れる →</button>
      </p>
      <p v-else class="faint settle-empty">残っているものはありません。</p>

      <template v-if="settleKind === 'purchase'">
        <button v-if="!showAddDue" type="button" class="sm ghost add-due-btn" @click="addDueOpen = true">
          <Icon name="plus" :size="14" /> 支払い待ちの仕入を足す
        </button>
        <div v-else class="add-due">
          <p class="settle-title">支払い待ちの仕入を入れる <span class="faint">（月末で締めて、翌月に払う分）</span></p>
          <div class="add-due-fields">
            <label class="field">
              <span>何月ぶん</span>
              <input type="month" :value="dueMonth" @change="onDueMonthChange(($event.target as HTMLInputElement).value)" />
            </label>
            <label class="field">
              <span>払う金額</span>
              <span class="money"><span class="yen">¥</span>
                <input v-model="dueAmount" inputmode="numeric" class="amount" placeholder="例：161505" @keydown.enter="addDue" />
              </span>
            </label>
            <label class="field">
              <span>払う期限（なくてもOK）</span>
              <input v-model="dueDate" type="date" />
            </label>
          </div>
          <div class="add-due-actions">
            <button type="button" class="sm" :disabled="addingDue" @click="addDue">支払い待ちに入れる</button>
            <button v-if="rows.length" type="button" class="sm ghost" @click="addDueOpen = false">やめる</button>
          </div>
        </div>
      </template>
    </div>

    <div class="entry-fields">
      <label class="field">
        <span>日付</span>
        <input
          v-model="date" type="date" :min="`${month}-01`" :max="lastDayOfMonth(month)"
          :class="{ invalid: !!date && date.slice(0, 7) !== month }"
        />
      </label>
      <label class="field amount-field">
        <span>金額</span>
        <span class="money"><span class="yen">¥</span>
          <input
            :value="amountText" inputmode="numeric" class="amount" placeholder="例：30000"
            @input="onAmountInput(($event.target as HTMLInputElement).value)" @keydown.enter="submit"
          />
        </span>
      </label>
      <label v-if="activeAccounts.length > 1" class="field">
        <span>口座</span>
        <select v-model="accountId">
          <option v-for="a in activeAccounts" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </label>
      <label class="field note-field">
        <span>メモ（なくてもOK）</span>
        <input v-model="note" placeholder="例：9月15日分" @keydown.enter="submit" />
      </label>
    </div>
    <p v-if="activeAccounts.length === 1" class="faint account-line">口座：{{ activeAccounts[0].name }}</p>

    <label v-if="category === 'loan_in'" class="check-row">
      <input v-model="alsoLoan" type="checkbox" />
      <span>借りたお金（あとで返す分）としても残す</span>
    </label>

    <p v-if="extraAmount > 0" class="faint extra-note">
      うち {{ yen(extraAmount) }} は、選んだ支払い待ちには使いません。
    </p>
    <p v-if="problem" class="problem"><Icon name="alert" :size="14" /> {{ problem }}</p>

    <button type="button" class="primary submit-btn" :disabled="!canSubmit" @click="submit">{{ submitLabel }}</button>
  </div>
</template>

<style scoped>
.entry-form { display: flex; flex-direction: column; gap: 12px; }

/* 出た／入った。2 つのうち 1 つ */
.seg { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.seg button {
  height: 34px;
  border: 2px solid transparent;
  background: var(--surface-hi);
  font-weight: 600;
}
.seg button.on { border-color: var(--primary); background: var(--brand-soft); }

.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-btn {
  height: 28px;
  padding: 0 12px;
  font-size: var(--fs-13);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text-dim);
}
.chip-btn.on { border-color: var(--primary); background: var(--brand-soft); color: var(--text); font-weight: 600; }

.settle { display: flex; flex-direction: column; gap: 8px; }
.settle-title { margin: 0; font-size: var(--fs-13); font-weight: 600; color: var(--text-dim); }
.settle-title .faint { font-weight: 400; font-size: var(--fs-12); }
.settle-list { display: flex; flex-direction: column; gap: 6px; }
.settle-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
}
.settle-row.on { border-color: var(--primary); background: var(--brand-soft); }
.settle-pick { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; min-width: 0; }
.settle-pick input { margin-top: 3px; }
.settle-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.settle-name { font-size: var(--fs-14); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settle-sub { font-size: var(--fs-12); color: var(--text-dim); }
.settle-amount { display: flex; align-items: center; gap: 4px; padding-left: 22px; }
.settle-amount .amount { flex: 1; min-width: 0; }
.full-btn { flex-shrink: 0; }
.settle-empty { margin: 0; font-size: var(--fs-13); }
.link-btn-plain { background: transparent; color: var(--info); padding: 0 4px; }

.add-due-btn { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; }
.add-due {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-md);
}
.add-due-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.add-due-fields .field:last-child { grid-column: 1 / -1; }
.add-due-actions { display: flex; gap: 8px; }

.entry-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.entry-fields .field { min-width: 0; }
.entry-fields .field input,
.entry-fields .field select,
.add-due-fields .field input { width: 100%; min-width: 0; }
.note-field { grid-column: 1 / -1; }
.money { display: flex; align-items: center; gap: 4px; }
.money .yen, .settle-amount .yen { color: var(--text-dim); font-size: var(--fs-12); }
.amount { text-align: right; font-variant-numeric: tabular-nums; }
.account-line { margin: -4px 0 0; font-size: var(--fs-12); }

.check-row { display: flex; align-items: center; gap: 8px; font-size: var(--fs-13); }
.extra-note { margin: 0; font-size: var(--fs-12); }
.problem {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  color: var(--warn);
  background: var(--warn-bg);
  border: 1px solid var(--warn-line);
  font-size: var(--fs-12);
}
.submit-btn { height: 40px; font-size: var(--fs-14); font-weight: 600; }
</style>
