<script setup lang="ts">
// 依存なしの SVG チャート。月ごとの仕入・販売本数を棒で、在庫残を折れ線で見せる。
// ツールチップは無し。値はバーの上に小さく数字で出す。
import { computed } from 'vue'
import type { ProductMonthPoint } from '../../shared/types'

const props = defineProps<{ months: ProductMonthPoint[] }>()

const W = 640
const H = 220
const PAD_L = 24
const PAD_R = 12
const PAD_T = 22
const PAD_B = 26

const plotW = W - PAD_L - PAD_R
const plotH = H - PAD_T - PAD_B

const maxCount = computed(() =>
  Math.max(1, ...props.months.flatMap(m => [m.purchased, m.sold, m.in_stock])),
)

const groupW = computed(() => (props.months.length ? plotW / props.months.length : 0))
const barW = computed(() => Math.max(4, Math.min(16, groupW.value * 0.28)))

function x(i: number): number {
  return PAD_L + groupW.value * i + groupW.value / 2
}
function barHeight(v: number): number {
  return maxCount.value ? (v / maxCount.value) * plotH : 0
}
function barY(v: number): number {
  return PAD_T + plotH - barHeight(v)
}

const linePoints = computed(() =>
  props.months.map((m, i) => `${x(i)},${barY(m.in_stock)}`).join(' '),
)

// 月ラベルは MM だけ。年が変わる所（先頭含む）だけ YYYY/MM にする
function monthLabel(month: string, i: number): string {
  const [y, m] = month.split('-')
  const prevYear = i > 0 ? props.months[i - 1].month.split('-')[0] : null
  return i === 0 || prevYear !== y ? `${y}/${m}` : m
}
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${H}`" class="mini-chart" preserveAspectRatio="xMidYMid meet">
    <line :x1="PAD_L" :y1="PAD_T + plotH" :x2="W - PAD_R" :y2="PAD_T + plotH" class="axis" />

    <g v-for="(m, i) in months" :key="m.month">
      <rect
        :x="x(i) - barW - 1" :y="barY(m.purchased)"
        :width="barW" :height="barHeight(m.purchased)"
        class="bar bar-purchase"
      />
      <text v-if="m.purchased" :x="x(i) - barW / 2 - 1" :y="barY(m.purchased) - 3" class="bar-label">{{ m.purchased }}</text>

      <rect
        :x="x(i) + 1" :y="barY(m.sold)"
        :width="barW" :height="barHeight(m.sold)"
        class="bar bar-sold"
      />
      <text v-if="m.sold" :x="x(i) + barW / 2 + 1" :y="barY(m.sold) - 3" class="bar-label">{{ m.sold }}</text>

      <text :x="x(i)" :y="H - 8" class="axis-label">{{ monthLabel(m.month, i) }}</text>
    </g>

    <polyline :points="linePoints" class="stock-line" />
    <circle v-for="(m, i) in months" :key="'d' + m.month" :cx="x(i)" :cy="barY(m.in_stock)" r="2.5" class="stock-dot" />
  </svg>
</template>

<style scoped>
.mini-chart {
  display: block;
  width: 100%;
  height: auto;
}
.axis { stroke: var(--line); stroke-width: 1; }
.bar-purchase { fill: var(--brand); }
.bar-sold { fill: var(--profit-solid); }
.bar-label {
  font-size: 9px;
  fill: var(--text-dim);
  text-anchor: middle;
}
.axis-label {
  font-size: 10px;
  fill: var(--text-faint);
  text-anchor: middle;
}
.stock-line {
  fill: none;
  stroke: var(--text);
  stroke-width: 1.5;
}
.stock-dot { fill: var(--text); }
</style>
