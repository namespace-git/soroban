<script setup lang="ts">
// v0.2 の状態ピル。意味の強い状態（発送してください・取引完了・未着・下書きなど）は
// solid-* で塗り、それ以外（私物・自動取得・タグなど）は薄い地。
// 見た目は style.css の .pill-base / .pill-<tone> にまとめてある（StatusChip とは別トーン体系）。
// 既存画面が使う StatusChip はそのまま残す（このコンポーネントに置き換えない）。
defineProps<{
  label: string
  tone: 'solid-ok' | 'solid-loss' | 'solid-warn' | 'solid-info' | 'neutral' | 'ok' | 'warn' | 'info' | 'brand'
}>()
</script>

<template>
  <span class="pill-base" :class="'pill-' + tone">{{ label }}</span>
</template>
