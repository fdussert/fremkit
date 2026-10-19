<script setup lang="ts">
/**
 * The page being edited, shown in the inspector while no widget is selected: for now, its own
 * background. A page without one shows the screen's, and the controls start empty; the first
 * colour or image chosen gives the page its own, and "Use the screen's background" drops it.
 */
import { computed } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseColor from '../shared/ui/BaseColor.vue'
import BaseField from '../shared/ui/BaseField.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseSection from '../shared/ui/BaseSection.vue'
import BackgroundPicker from './BackgroundPicker.vue'
import { useI18n } from '../shared/i18n'
import type { Background } from '../shared/types'
import { useAdminStore } from './store'
import { PAGE_BACKGROUND_SECTION } from './canvasMenu'

const s = useAdminStore()
const { t } = useI18n()

const page = computed(() => s.page.value)
const own = computed(() => !!page.value?.background)
const bg = computed<Background>(() => page.value?.background ?? {})

function set(patch: Partial<Background> | null): void {
  s.setPageBackground(s.state.pageIndex, patch)
}
</script>

<template>
  <BaseSection v-if="page" :id="PAGE_BACKGROUND_SECTION" :title="t('admin.inspector.page.background', { name: page.name })" default-open>
    <p class="hint">{{ t(own ? 'admin.inspector.page.background.own' : 'admin.inspector.page.background.inherited') }}</p>
    <BaseField :label="t('admin.inspector.screen.color')">
      <BaseColor :model-value="bg.color ?? ''" fallback="#0b0d10" :reset-label="t('common.reset')"
        :aria-label="t('admin.inspector.page.background.color.aria')"
        @update:model-value="set({ color: $event })" @reset="set({ color: undefined })" />
    </BaseField>
    <BackgroundPicker :model-value="bg" @update="set($event)" />
    <BaseButton v-if="own" @click="set(null)">
      <BaseIcon name="undo-2" :size="16" />{{ t('admin.inspector.page.background.useScreen') }}
    </BaseButton>
  </BaseSection>
</template>

<style scoped>
.hint { margin: 0 0 var(--space-3); font-size: var(--fs-sm); color: var(--text-muted); }
</style>
