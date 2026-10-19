<script setup lang="ts">
/**
 * The inspector's note for a widget with a newer version in the registry. An update is news, not
 * a problem: it is tinted with the accent, like the library card's "↑ version" chip, rather than
 * drawn as a warning, and it sits apart from the health banner.
 */
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { useI18n } from '../shared/i18n'
import { actionLabel, type HealthAction, type HealthUpdate } from './health'

const props = defineProps<{ update: HealthUpdate }>()
const emit = defineEmits<{ action: [action: HealthAction] }>()
const { t } = useI18n()

const action = (): HealthAction => ({ kind: 'update', widgetId: props.update.widgetId })
</script>

<template>
  <div class="note" role="status" data-update-note>
    <BaseIcon name="arrow-up" :size="16" class="icon" />
    <p class="text">
      {{ update.version ? t('admin.health.update.available', { version: update.version }) : t('admin.health.update.availableAny') }}
    </p>
    <BaseButton @click="emit('action', action())">{{ actionLabel(action()) }}</BaseButton>
  </div>
</template>

<style scoped>
.note { display: flex; gap: var(--space-2); align-items: center; margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, transparent); }
.icon { flex: 0 0 auto; display: inline-flex; padding: 3px; border-radius: 50%; color: var(--on-accent); background: var(--accent); }
.text { flex: 1; min-width: 0; margin: 0; font-size: var(--fs-sm); color: var(--text); }
</style>
