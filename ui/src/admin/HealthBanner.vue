<script setup lang="ts">
/**
 * The top of the widget inspector when the selected widget is not well: what is wrong, in one
 * sentence, and the button that leads to where it is fixed. Only the first problem gets a
 * button; the others are listed under it, since fixing the first is often what fixes them.
 */
import { computed } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { useI18n } from '../shared/i18n'
import { actionLabel, describeProblem, type InstanceHealth, type HealthAction } from './health'

const props = defineProps<{ health: InstanceHealth }>()
const emit = defineEmits<{ action: [action: HealthAction] }>()
const { t } = useI18n()

const first = computed(() => props.health.problems[0])
const rest = computed(() => props.health.problems.slice(1))
</script>

<template>
  <div v-if="first" class="banner" :class="health.level" role="status" data-health-banner>
    <BaseIcon :name="health.level === 'error' ? 'alert-circle' : 'alert-triangle'" :size="18" class="icon" />
    <div class="body">
      <p class="reason">{{ describeProblem(first) }}</p>
      <ul v-if="rest.length" class="rest">
        <li v-for="(p, i) in rest" :key="i">{{ describeProblem(p) }}</li>
      </ul>
      <BaseButton v-if="first.action" :variant="health.level === 'error' ? 'primary' : undefined"
        @click="emit('action', first.action)">
        {{ actionLabel(first.action) }}
      </BaseButton>
    </div>
    <span class="sr">{{ t(`admin.health.level.${health.level}`) }}</span>
  </div>
</template>

<style scoped>
.banner { display: flex; gap: var(--space-2); align-items: flex-start; margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); border: 1px solid; }
.banner.error { border-color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
.banner.warning { border-color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.icon { flex: 0 0 auto; margin-top: 1px; }
.error .icon { color: var(--danger); }
.warning .icon { color: var(--warn); }
.body { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); min-width: 0; }
.reason { margin: 0; font-size: var(--fs-sm); color: var(--text); }
.rest { margin: 0; padding-left: var(--space-4); font-size: var(--fs-xs); color: var(--text-muted); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
