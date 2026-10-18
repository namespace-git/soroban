<script setup lang="ts">
import CodeChip from './CodeChip.vue'
import StatusChip from './StatusChip.vue'
import Icon from './Icon.vue'
import { yen } from '../format'

defineProps<{ linked: boolean; cost: number; codes: string[]; automatic?: boolean; hint?: string | null; readonly?: boolean }>()
defineEmits<{ open: [] }>()
</script>

<template>
  <div class="allocation-cell">
    <!-- 原価・在庫コード・ひとこと。デスクトップ幅では入れ物は無いのと同じ（display: contents）で、上から 状態 → ボタン → コード → ひとこと の並び。
         スマホ幅では売上タブ（Sales.vue）がこの入れ物を 1 行にまとめ、ボタンは別の場所に置く -->
    <div class="allocation-info">
      <div class="allocation-state">
        <span v-if="linked" class="num"><span class="allocation-cost-label">原価 </span>{{ yen(cost) }}</span>
        <!-- スマホ幅では、同じ「未紐付け」が状態ラベルにも出る（Sales.vue）。そちらを残し、ここは .allocation-unlinked ごと隠す -->
        <StatusChip v-else class="allocation-unlinked" tone="warn" label="未紐付け" />
      </div>
      <div v-if="codes.length" class="allocation-codes">
        <CodeChip v-for="code in codes" :key="code" kind="item" :code="code" />
      </div>
      <span v-if="automatic" class="faint">自動紐付け</span>
      <span v-if="hint" class="faint allocation-hint" :title="hint">{{ hint }}</span>
    </div>
    <!-- 橙（link-btn）は「まだ紐付いていない」ときだけ。紐付け済み・確認だけのときは中立のボタン -->
    <button type="button" class="sm allocation-btn" :class="{ 'link-btn': !linked && !readonly }" @click="$emit('open')">
      <Icon name="link" :size="14" />
      {{ readonly ? '紐付けを確認' : linked ? '紐付けを編集' : '在庫を選ぶ' }}
    </button>
  </div>
</template>

<style scoped>
.allocation-cell { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; }
/* デスクトップ幅：入れ物は無いのと同じ。並びは order で（状態 → ボタン → コード・ひとこと） */
.allocation-info { display: contents; }
.allocation-state { order: 0; min-height: 22px; display: flex; align-items: center; }
.allocation-btn { order: 1; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.allocation-codes { order: 2; display: flex; flex-wrap: wrap; gap: 4px; }
.allocation-info > .faint { order: 2; }
.allocation-cost-label { display: none; }
.faint { font-size: var(--fs-12); }
</style>
