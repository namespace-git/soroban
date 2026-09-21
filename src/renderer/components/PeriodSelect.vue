<script lang="ts">
// 期間の絞り込み。仕入タブ・在庫タブ・（次の波で）売上タブ・商品タブで共通に使う。
// 呼び出し側は絞り込みたい日付列（注文日・仕入日・販売日など）に対して inPeriod() を掛ける。
import { todayLocal } from '../../shared/date'

export type Period =
  | 'all'
  | 'this_month'
  | 'last_month'
  | 'last_3_months'
  | 'this_year'
  | { from: string; to: string }

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function fmt(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 期間を [from, to]（両端含む、YYYY-MM-DD）に。'all' は null（絞り込みなし） */
export function periodRange(p: Period, today: string = todayLocal()): { from: string; to: string } | null {
  if (p === 'all') return null
  if (typeof p === 'object') return { from: p.from, to: p.to }
  const [y, m] = today.split('-').map(Number)
  switch (p) {
    case 'this_month':
      return { from: fmt(new Date(y, m - 1, 1)), to: fmt(new Date(y, m, 0)) }
    case 'last_month':
      return { from: fmt(new Date(y, m - 2, 1)), to: fmt(new Date(y, m - 1, 0)) }
    case 'last_3_months':
      return { from: fmt(new Date(y, m - 3, 1)), to: fmt(new Date(y, m, 0)) }
    case 'this_year':
      return { from: fmt(new Date(y, 0, 1)), to: fmt(new Date(y, 11, 31)) }
    default:
      return null
  }
}

/** date（YYYY-MM-DD、先頭10文字を見る）が期間に含まれるか。'all' は常に true。null は 'all' 以外なら false */
export function inPeriod(date: string | null | undefined, p: Period): boolean {
  if (p === 'all') return true
  if (!date) return false
  const range = periodRange(p)
  if (!range) return true
  const d = date.slice(0, 10)
  return d >= range.from && d <= range.to
}
</script>

<script setup lang="ts">
const props = defineProps<{ modelValue: Period }>()
const emit = defineEmits<{ 'update:modelValue': [Period] }>()

type Mode = 'all' | 'this_month' | 'last_month' | 'last_3_months' | 'this_year' | 'custom'

const OPTIONS: Array<{ value: Mode; label: string }> = [
  { value: 'all', label: 'すべて' },
  { value: 'this_month', label: '今月' },
  { value: 'last_month', label: '先月' },
  { value: 'last_3_months', label: '直近3か月' },
  { value: 'this_year', label: '今年' },
  { value: 'custom', label: '期間を指定…' },
]

function modeOf(p: Period): Mode {
  return typeof p === 'object' ? 'custom' : p
}

function onModeChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value as Mode
  if (v === 'custom') {
    const today = todayLocal()
    emit('update:modelValue', typeof props.modelValue === 'object' ? props.modelValue : { from: today, to: today })
  } else {
    emit('update:modelValue', v)
  }
}

function onFromChange(e: Event) {
  const from = (e.target as HTMLInputElement).value
  const to = typeof props.modelValue === 'object' ? props.modelValue.to : from
  emit('update:modelValue', { from, to })
}
function onToChange(e: Event) {
  const to = (e.target as HTMLInputElement).value
  const from = typeof props.modelValue === 'object' ? props.modelValue.from : to
  emit('update:modelValue', { from, to })
}
</script>

<template>
  <span class="period-select">
    <select :value="modeOf(modelValue)" @change="onModeChange">
      <option v-for="o in OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
    <template v-if="typeof modelValue === 'object'">
      <input type="date" :value="modelValue.from" @change="onFromChange" />
      <span class="faint">〜</span>
      <input type="date" :value="modelValue.to" @change="onToChange" />
    </template>
  </span>
</template>

<style scoped>
.period-select {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
