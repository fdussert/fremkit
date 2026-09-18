<script setup lang="ts">
/**
 * The widgets a connection feeds, under the form that creates it.
 *
 * A connection on its own shows nothing on a screen: it is credentials for a provider, and the
 * thing that puts them on the dashboard is a widget — which, for every product-specific one,
 * now lives on the registry. Somebody who has just filled in a Homey token has no reason to know
 * that, so the answer is here rather than two panels away.
 *
 * Read from the index the marketplace store already holds; nothing new is asked of the server.
 */
import { computed, onMounted } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import ConsentDialog from './ConsentDialog.vue'
import { pick, useI18n } from '../shared/i18n'
import { useMarketplaceStore } from './marketplace'
import type { MarketplaceWidget } from '../shared/types'

const props = defineProps<{ type: string }>()
const market = useMarketplaceStore()
const { t } = useI18n()

onMounted(() => { void market.load() })

const rows = computed(() => market.state.widgets.filter((w) => w.connections.includes(props.type)))
/** The dialog this component opened, never one another panel is showing. */
const prompt = computed(() => {
  const open = market.state.consent
  return open && rows.value.some((w) => w.id === open.widget.id) ? open : null
})
function installable(w: MarketplaceWidget): boolean {
  return !w.installed && !w.sdkTooNew && !w.shadowsBuiltin
}
</script>

<template>
  <section v-if="rows.length" class="widgets">
    <h4>{{ t('admin.connections.form.widgets') }}</h4>
    <div v-for="w in rows" :key="w.id" class="row" :data-widget="w.id">
      <BaseIcon :name="w.icon" :size="16" />
      <span class="name">
        <i v-if="w.installed" class="dot ok"></i>{{ pick(w.name) }}
      </span>
      <BaseButton v-if="installable(w)" :disabled="market.state.busy !== null" @click="market.start(w)">
        {{ market.state.busy === w.id ? t('admin.market.working') : t('admin.market.install') }}
      </BaseButton>
    </div>

    <ConsentDialog v-if="prompt" :prompt="prompt" @accept="market.accept()" @cancel="market.cancel()" />
  </section>
</template>

<style scoped>
.widgets { margin: 0 0 var(--space-3); }
h4 { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted);
  margin: 0 0 var(--space-2); }
.row { display: flex; align-items: center; gap: var(--space-2); padding: 2px 0; font-size: var(--fs-sm); }
.name { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-dim); flex: 0 0 auto; }
.dot.ok { background: var(--ok); }
</style>
