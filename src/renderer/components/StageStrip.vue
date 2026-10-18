<script setup lang="ts">
// 横一列の段階カード（売上タブの進捗など）。docs/mocks/mock-sales.html の .progress。
// レイアウト（列数・間隔）は style.css の .stage-strip、カードの見た目はここのスコープ。
import { ref, watch, onMounted, nextTick } from 'vue'
import { yen } from '../format'

export interface StageStripStage {
  key: string
  label: string
  /** チップ表示（chips）のスマホ幅で使う短い名前。無ければ label のまま */
  short?: string
  count: number
  /** 件数の横に出す金額。null/未指定なら出さない */
  money?: number | null
  /** カード下段の薄い注記 */
  sub?: string
  tone?: 'brand' | 'warn' | 'ok' | 'neutral'
}

const props = defineProps<{
  stages: StageStripStage[]
  active: string | null
  /** スマホ幅（767px 以下）で、カードの代わりに高さ 44px の 1 行の横に動くチップ列にする。デスクトップ幅では何も変わらない */
  chips?: boolean
}>()
const emit = defineEmits<{ select: [string] }>()

// スマホ幅では段階カードを横に並べて動かすので、選ばれたカードが見える位置まで寄せる（デスクトップ幅では動かさない）
const root = ref<HTMLElement | null>(null)
function revealActive() {
  if (!window.matchMedia('(max-width: 767px)').matches) return
  root.value?.querySelector('.stage-card.active')?.scrollIntoView({ block: 'nearest', inline: 'center' })
}
onMounted(revealActive)
watch(() => props.active, async () => { await nextTick(); revealActive() })
</script>

<template>
  <div ref="root" class="stage-strip" :class="{ 'as-chips': chips }">
    <button
      v-for="(s, i) in stages" :key="s.key"
      type="button"
      class="stage-card"
      :class="[s.tone, { active: active === s.key }]"
      :aria-pressed="active === s.key"
      @click="emit('select', s.key)"
    >
      <span class="stage-label">
        <span :class="{ 'stage-label-full': chips && s.short }">{{ s.label }}</span>
        <span v-if="chips && s.short" class="stage-label-short">{{ s.short }}</span>
      </span>
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
.stage-label-short { display: none; }
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

/* スマホ幅（768px 未満）。段階カードは折り返さず 1 行に並べて横に動かす（売上タブと在庫タブで同じ形）。
   左右の -12px / 12px は style.css の .page のスマホ幅の余白に合わせて、画面の端まで動かせるようにしたもの。
   768px 以上には一切効かせない */
@media (max-width: 767px) {
  .stage-strip {
    display: flex;
    gap: 8px;
    margin: 0 -12px 4px;
    padding: 2px 12px 8px;
    overflow-x: auto;
    scroll-snap-type: x proximity;
    scroll-padding: 0 12px;
    scrollbar-width: none;
  }
  .stage-strip::-webkit-scrollbar { display: none; }
  .stage-card {
    flex: 0 0 148px;
    min-height: 44px;
    scroll-snap-align: start;
  }

  /* チップ（chips）：高さ 44px の 1 行。段階名と件数を横に並べ、金額・注記・矢印は出さない。選んだものは塗る。
     押す範囲は 44px 高（見た目の丸は 36px、上下の余白が押せる範囲） */
  .stage-strip.as-chips {
    margin-bottom: 0;
    padding: 4px 12px;
    gap: 6px;
  }
  .as-chips .stage-card {
    flex: 0 0 auto;
    flex-direction: row;
    align-items: center;
    gap: 6px;
    height: 36px;
    min-height: 0;
    padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: 999px;
    box-shadow: none;
    white-space: nowrap;
  }
  .as-chips .stage-card::after { content: ''; position: absolute; inset: -4px 0; }
  .as-chips .stage-label { font-size: var(--fs-13); color: var(--text); }
  .as-chips .stage-label-full { display: none; }
  .as-chips .stage-label-short { display: inline; }
  .as-chips .stage-value { font-size: var(--fs-14); line-height: 1.2; }
  .as-chips .stage-money,
  .as-chips .stage-sub,
  .as-chips .stage-arrow { display: none; }
  .as-chips .stage-card.active { background: var(--primary); border-color: var(--primary); }
  .as-chips .stage-card.active .stage-label,
  .as-chips .stage-card.active .stage-value { color: var(--surface); }
}
</style>
