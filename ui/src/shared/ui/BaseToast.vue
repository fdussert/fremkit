<script setup lang="ts">
import BaseIcon from './BaseIcon.vue'
import { useI18n } from '../i18n'

const { t } = useI18n()
withDefaults(defineProps<{ message: string; tone?: 'error' | 'info'; icon?: string; action?: string }>(), { tone: 'error' })
const emit = defineEmits<{ close: []; action: [] }>()
</script>

<template>
  <div class="toast" :class="tone" role="alert">
    <BaseIcon :name="icon ?? (tone === 'error' ? 'alert-triangle' : 'check')" :size="18" />
    <span class="msg">{{ message }}</span>
    <button v-if="action" type="button" class="act" @click="emit('action')">{{ action }}</button>
    <button type="button" :aria-label="t('common.close')" @click="emit('close')"><BaseIcon name="x" :size="16" /></button>
  </div>
</template>

<style scoped>
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 50;
  display: flex; align-items: center; gap: var(--space-2); max-width: 70vw;
  padding: 10px 12px; border-radius: var(--radius-sm); box-shadow: var(--shadow);
  background: var(--surface-3); color: var(--text); font-size: var(--fs-sm); }
.toast.error { background: var(--danger); color: var(--on-accent); }
.msg { white-space: pre-line; }
.act { padding: 2px 8px; border-radius: 6px; background: var(--surface-2); font: inherit; font-weight: 600; color: var(--accent); }
.act:hover { background: var(--surface); }
button { border: 0; background: transparent; color: inherit; cursor: pointer; padding: 0; display: flex; }
</style>
