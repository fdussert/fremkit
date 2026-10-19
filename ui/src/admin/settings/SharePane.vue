<script setup lang="ts">
/**
 * Export and import of layouts. Moved out of the former ScreenInspector.vue.
 */
import BaseButton from '../../shared/ui/BaseButton.vue'
import BaseIcon from '../../shared/ui/BaseIcon.vue'
import BaseSection from '../../shared/ui/BaseSection.vue'
import { useI18n } from '../../shared/i18n'
import { useAdminStore } from '../store'
import { openExport, pickLayoutFile } from '../share'

const s = useAdminStore()
const { t } = useI18n()
</script>

<template>
  <BaseSection id="screen.share" :title="t('admin.share.section')">
  <div class="row">
    <BaseButton @click="openExport(s, { scope: 'setup' })">
      <BaseIcon name="download" :size="16" />{{ t('admin.share.exportSetup') }}
    </BaseButton>
    <BaseButton @click="openExport(s, { scope: 'screen', screen: s.screen.value?.id })">
      <BaseIcon name="download" :size="16" />{{ t('admin.share.exportScreen') }}
    </BaseButton>
    <BaseButton @click="pickLayoutFile(s)">
      <BaseIcon name="upload" :size="16" />{{ t('admin.share.import') }}
    </BaseButton>
  </div>
  <p class="ro">{{ t('admin.share.hint') }}</p>
  </BaseSection>
</template>

<style scoped>
.ro { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-2); }
</style>
