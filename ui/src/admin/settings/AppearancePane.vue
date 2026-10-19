<script setup lang="ts">
/**
 * The theme, and the one worn at night: both are the whole app's, on every screen and in this
 * editor. Moved out of the former ScreenInspector.vue.
 */
import { computed } from 'vue'
import BaseButton from '../../shared/ui/BaseButton.vue'
import BaseField from '../../shared/ui/BaseField.vue'
import BaseIcon from '../../shared/ui/BaseIcon.vue'
import SettingsBlock from './SettingsBlock.vue'
import ThemeSchedule from '../ThemeSchedule.vue'
import { pick, useI18n } from '../../shared/i18n'
import { BUILTIN_THEME, useThemes } from '../../shared/theme'
import { useAdminStore } from '../store'

const s = useAdminStore()
const { t } = useI18n()
const { themes, errors: themeErrors, rescan: rescanThemes } = useThemes()
/** The built-in theme first, then the others by name: the list reads as "the default, and yours". */
const themeOptions = computed(() => {
  const list = Object.values(themes.value)
    .sort((a, b) => (a.id === BUILTIN_THEME ? -1 : b.id === BUILTIN_THEME ? 1 : pick(a.name).localeCompare(pick(b.name))))
    .map((theme) => ({ id: theme.id, label: pick(theme.name), description: pick(theme.description ?? '') }))
  // A config naming a theme whose folder is gone still shows it, rather than an empty select.
  const current = s.state.config!.theme ?? BUILTIN_THEME
  if (!list.some((o) => o.id === current)) list.push({ id: current, label: current, description: t('admin.inspector.screen.theme.missing') })
  return list
})
const currentTheme = computed(() => s.state.config!.theme ?? BUILTIN_THEME)
const themeNote = computed(() => themeOptions.value.find((o) => o.id === currentTheme.value)?.description ?? '')
function setTheme(id: string): void {
  if (id !== currentTheme.value) s.apply((c) => { c.theme = id })
}
</script>

<template>
  <SettingsBlock id="appearance.theme">
  <BaseField :label="t('admin.inspector.screen.theme')" :hint="t('admin.inspector.screen.theme.hint')">
    <div class="theme">
      <select :value="currentTheme" :aria-label="t('admin.inspector.screen.theme')"
        @change="setTheme(($event.target as HTMLSelectElement).value)">
        <option v-for="o in themeOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
      </select>
      <BaseButton variant="icon" :title="t('admin.inspector.screen.theme.rescan')" @click="rescanThemes()">
        <BaseIcon name="refresh-cw" :size="16" />
      </BaseButton>
    </div>
  </BaseField>
  <p v-if="themeNote" class="ro note">{{ themeNote }}</p>
  <p v-for="e in themeErrors" :key="e.id" class="err">{{ e.id }} — {{ e.error }}</p>
  <ThemeSchedule />
  </SettingsBlock>
</template>

<style scoped>
.ro { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.theme { display: flex; gap: var(--space-2); align-items: center; }
.theme select { flex: 1; min-width: 0; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
.note { margin: calc(var(--space-2) * -1) 0 var(--space-3); }
.err { color: var(--danger); font-size: var(--fs-xs); margin: 0 0 var(--space-2); }
</style>
