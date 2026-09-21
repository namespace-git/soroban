<script setup lang="ts">
// 横一列の段階カード（売上タブの進捗など）。docs/mocks/mock-sales.html の .progress。
// レイアウト（列数・間隔）は style.css の .stage-strip、カードの見た目はここのスコープ。
export interface StageStripStage {
  key: string
  label: string
  count: number
  /** 件数の横に出す金額。null/未指定なら出さない */
  money?: number | null
  /** カード下段の薄い注記 */
  sub?: string
  tone?: 'brand' | 'warn' | 'ok' | 'neutral'
}

defineProps<{ stages: StageStripStage[]; active: string | null }>()
const emit = defineEmits<{ select: [string] }>()

const yen = (n: number) => (n < 0 ? '−' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP')
</script>

<template>
  <div class="stage-strip">
    <button
      v-for="(s, i) in stages" :key="s.key"
      type="button"
      class="stage-card"
      :class="[s.tone, { active: active === s.key }]"
      @click="emit('select', s.key)"
    >
      <span class="stage-label">{{ s.label }}</span>
      <span class="stage-value">
        {{ s.count }}<span v-if="s.money != null" class="stage-money">{{ yen(s.money) }}</span>
      </span>
      <span v-if="s.sub" class="stage-sub">{{ s.sub }}</span>
      <span v-if="i < stages.length - 1" class="stage-arrow" aria-hidden="true">›</span>
    </button>
  </div>
</template>

<style scoped>
.stage-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  height: auto;
  padding: 10px 14px;
  background: var(--surface);
  border: 2px solid transparent;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-1);
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.stage-card.active { border-color: var(--primary); }

.stage-label {
  font-size: var(--fs-12);
  color: var(--text-dim);
}
.stage-value {
  font-size: var(--fs-20);
  font-weight: 700;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.stage-money {
  margin-left: 6px;
  font-size: var(--fs-13);
  font-weight: 600;
  color: var(--text-dim);
}
.stage-card.warn .stage-value { color: var(--warn); }
.stage-card.ok .stage-value { color: var(--profit); }

.stage-sub {
  font-size: var(--fs-12);
  color: var(--text-faint);
}

.stage-arrow {
  position: absolute;
  right: -9px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-faint);
  font-size: var(--fs-16);
  line-height: 1;
  pointer-events: none;
}
</style>
