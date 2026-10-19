<script setup lang="ts">
/**
 * "About this widget": what it is and where it came from — version, built in or installed from
 * the Sietch, author, licence, sizes — and what it may do. An installed widget with a newer
 * version waiting offers the update, which opens the marketplace on its Updates view.
 */
import { computed } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import WidgetPermissions from './WidgetPermissions.vue'
import { pick, useI18n } from '../shared/i18n'
import { useAdminStore } from './store'
import { useMarketplaceStore } from './marketplace'

const props = defineProps<{ instanceId: string }>()
const s = useAdminStore()
const market = useMarketplaceStore()
const { t } = useI18n()

const widget = computed(() => s.state.config?.widgets[props.instanceId])
const manifest = computed(() => (widget.value ? s.state.manifests[widget.value.widgetId] : undefined))
const source = computed(() => (widget.value ? s.state.sources[widget.value.widgetId] : undefined))
const update = computed(() => market.state.widgets.find((w) => w.id === widget.value?.widgetId && w.updateAvailable)?.version ?? null)
/** Only a URL is ever made a link: the manifest is the author's text, and `javascript:` is text too. */
const homepage = computed(() => {
  const url = manifest.value?.homepage
  return url && /^https?:\/\//i.test(url) ? url : null
})

function openUpdates(): void {
  market.setView('updates')
  s.openModal('marketplace')
}
</script>

<template>
  <div v-if="widget" class="about">
    <div class="head">
      <BaseIcon :name="manifest?.icon ?? 'layout-grid'" :size="32" />
      <div>
        <strong>{{ manifest ? pick(manifest.name) : widget.widgetId }}</strong>
        <small v-if="widget.title?.trim()">{{ widget.title }}</small>
      </div>
    </div>
    <p v-if="manifest" class="desc">{{ pick(manifest.description) }}</p>
    <p v-else class="desc bad">{{ t('admin.about.missing') }}</p>

    <dl v-if="manifest">
      <dt>{{ t('admin.about.version') }}</dt><dd>{{ manifest.version }}</dd>
      <dt>{{ t('admin.about.source') }}</dt>
      <dd>{{ source === 'installed' ? t('admin.about.installed') : t('admin.about.builtin') }}</dd>
      <template v-if="manifest.author"><dt>{{ t('admin.about.author') }}</dt><dd>{{ manifest.author }}</dd></template>
      <template v-if="manifest.license"><dt>{{ t('admin.about.license') }}</dt><dd>{{ manifest.license }}</dd></template>
      <template v-if="manifest.homepage">
        <dt>{{ t('admin.about.homepage') }}</dt>
        <dd><a v-if="homepage" :href="homepage" target="_blank" rel="noopener noreferrer">{{ homepage }}</a><span v-else>{{ manifest.homepage }}</span></dd>
      </template>
      <dt>{{ t('admin.about.size') }}</dt>
      <dd>{{ t('admin.about.sizeValue', { dw: manifest.defaultSize[0], dh: manifest.defaultSize[1], mw: manifest.minSize[0], mh: manifest.minSize[1] }) }}</dd>
    </dl>

    <WidgetPermissions v-if="manifest" :manifest="manifest" :asks="s.state.asks[widget.widgetId]" />

    <div v-if="update" class="actions">
      <BaseButton variant="primary" @click="openUpdates()">{{ t('admin.about.update', { version: update }) }}</BaseButton>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); }
.head div { display: flex; flex-direction: column; }
.head strong { font-size: var(--fs-lg); }
.head small { color: var(--text-muted); font-size: var(--fs-sm); }
.desc { color: var(--text-muted); font-size: var(--fs-sm); margin: 0 0 var(--space-3); }
.desc.bad { color: var(--danger); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-1) var(--space-3); margin: 0 0 var(--space-4);
  font-size: var(--fs-sm); }
dt { color: var(--text-muted); }
dd { margin: 0; overflow-wrap: anywhere; }
a { color: var(--accent); }
.actions { margin-top: var(--space-4); }
</style>
