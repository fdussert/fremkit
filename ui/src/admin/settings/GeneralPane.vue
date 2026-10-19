<script setup lang="ts">
/**
 * What belongs to the whole app and to no screen: the language. Moved out of the former
 * ScreenInspector.vue.
 */
import { computed } from 'vue'
import BaseField from '../../shared/ui/BaseField.vue'
import BaseSegmented from '../../shared/ui/BaseSegmented.vue'
import SettingsBlock from './SettingsBlock.vue'
import { useI18n, type Locale } from '../../shared/i18n'
import { useAdminStore } from '../store'

const s = useAdminStore()
const { t, locale } = useI18n()
const LANGUAGES = computed(() => (['fr', 'en'] as const).map((value) => ({
  value, label: t(`admin.inspector.screen.language.${value}`),
})))

/**
 * The language goes through `apply` like every other setting, so it is undoable and saved with
 * the rest of the config. The store watches `config.locale`, which is what repaints the admin.
 */
function setLocale(value: string): void {
  const next = (value === 'en' ? 'en' : 'fr') as Locale
  if (next !== s.state.config!.locale) s.apply((c) => { c.locale = next })
}
</script>

<template>
  <SettingsBlock id="general.language">
  <BaseField :label="t('admin.inspector.screen.language')">
    <BaseSegmented :model-value="locale" :options="LANGUAGES" @update:model-value="setLocale($event)" />
  </BaseField>
  </SettingsBlock>
</template>

