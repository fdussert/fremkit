<script setup lang="ts">
/**
 * The top bar's count of widgets that are not well, and the list it opens: every one of them,
 * where it is, what is wrong, and the button that fixes it. A press on a row's name takes the
 * editor to the widget; the button runs the fix, as the inspector's banner does.
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import HealthDot from './HealthDot.vue'
import { pick, useI18n } from '../shared/i18n'
import { actionLabel, describeProblem, worst, type HealthAction, type HealthEntry } from './health'
import { useHealth } from './useHealth'
import { useAdminStore } from './store'

const s = useAdminStore()
const health = useHealth()
const { t } = useI18n()
const open = ref(false)
const root = ref<HTMLElement>()

const entries = computed(() => health.entries.value)
const level = computed(() => worst(entries.value.map((e) => e.health.level)))

function nameOf(e: HealthEntry): string {
  return e.widget.title?.trim() || pick(s.state.manifests[e.widget.widgetId]?.name) || e.widget.widgetId
}
function placeOf(e: HealthEntry): string {
  const where = e.place.pageName ?? t('admin.health.inBar')
  return (s.state.config?.screens.length ?? 0) > 1 ? `${e.place.screenName} · ${where}` : where
}

/** Takes the editor to the widget: its screen, its page, selected. A bar widget opens its screen. */
function go(e: HealthEntry): void {
  open.value = false
  if (e.place.screenId !== s.screen.value?.id) s.selectScreen(e.place.screenId)
  if (e.place.pageIndex === null) return
  s.selectPage(e.place.pageIndex)
  s.select(e.instanceId)
}
function fix(e: HealthEntry, action: HealthAction): void {
  open.value = false
  health.run(e.instanceId, action)
}

function onOutside(e: PointerEvent): void {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') open.value = false
}
watch(open, (on) => {
  if (on) {
    window.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('keydown', onKey)
  } else {
    window.removeEventListener('pointerdown', onOutside, true)
    window.removeEventListener('keydown', onKey)
  }
})
onUnmounted(() => {
  window.removeEventListener('pointerdown', onOutside, true)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div v-if="entries.length" ref="root" class="health-menu">
    <button type="button" class="count" :class="level" :aria-expanded="open" aria-haspopup="dialog"
      :title="t('admin.health.title')" :aria-label="t('admin.health.countAria', { n: entries.length })"
      data-health-count @click="open = !open">
      <BaseIcon :name="level === 'error' ? 'alert-circle' : 'alert-triangle'" :size="16" />
      {{ t('admin.health.count', { n: entries.length }) }}
    </button>
    <div v-if="open" class="list" role="dialog" :aria-label="t('admin.health.title')" data-health-list>
      <h3>{{ t('admin.health.title') }}</h3>
      <ul>
        <li v-for="e in entries" :key="e.instanceId">
          <HealthDot :level="e.health.level" :title="t(`admin.health.level.${e.health.level}`)" class="dot" />
          <div class="text">
            <button type="button" class="name" @click="go(e)">
              <strong>{{ nameOf(e) }}</strong><span class="where">{{ placeOf(e) }}</span>
            </button>
            <p class="reason">{{ describeProblem(e.health.problems[0]) }}</p>
            <p v-if="e.health.problems.length > 1" class="more">{{ t('admin.health.more', { n: e.health.problems.length - 1 }) }}</p>
          </div>
          <BaseButton v-if="e.health.problems[0].action" @click="fix(e, e.health.problems[0].action!)">
            {{ actionLabel(e.health.problems[0].action!) }}
          </BaseButton>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.health-menu { position: relative; }
.count { display: inline-flex; align-items: center; gap: var(--space-2); min-height: 32px; font: inherit;
  font-size: var(--fs-sm); padding: 4px 12px; border-radius: var(--radius-sm); cursor: pointer;
  border: 1px solid; background: transparent; }
.count.error { color: var(--danger); border-color: var(--danger); }
.count.warning { color: var(--warn); border-color: var(--warn); }
.count:hover { background: var(--surface-2); }
.list { position: absolute; z-index: 30; top: calc(100% + 6px); right: 0; width: 420px; max-height: 70vh; overflow: auto;
  padding: var(--space-3); background: var(--surface); border: 1px solid var(--border-strong);
  border-radius: var(--radius-md); box-shadow: var(--shadow); }
h3 { margin: 0 0 var(--space-2); font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted); }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
li { display: flex; align-items: flex-start; gap: var(--space-2); padding: var(--space-2) 0; border-top: 1px solid var(--border); }
li:first-child { border-top: 0; }
.dot { margin-top: 6px; }
.text { flex: 1; min-width: 0; }
.name { display: flex; align-items: baseline; gap: var(--space-2); max-width: 100%; padding: 0; font: inherit; font-size: var(--fs-sm);
  color: var(--text); background: none; border: 0; cursor: pointer; text-align: left; }
.name:hover strong { text-decoration: underline; }
.name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.where { color: var(--text-dim); font-size: var(--fs-xs); white-space: nowrap; }
.reason { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
.more { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-dim); }
</style>
