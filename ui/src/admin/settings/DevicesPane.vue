<script setup lang="ts">
/**
 * The iPads paired with this Mac, and the screen each one shows. Moved out of the former
 * ScreenInspector.vue: pairing belongs to the Mac, not to the screen being edited.
 */
import BaseSection from '../../shared/ui/BaseSection.vue'
import DevicesSection from '../DevicesSection.vue'
import { useI18n } from '../../shared/i18n'

const { t } = useI18n()
</script>

<template>
  <BaseSection id="screen.devices" :title="t('admin.inspector.screen.devices')">
    <DevicesSection />
  </BaseSection>
</template>

