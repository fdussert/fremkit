<script setup lang="ts">
/**
 * What the inspector says about a tile whose widget is not installed.
 *
 * It used to say "Widget folder not found." and stop there, which is true and useless. Since the
 * product-specific widgets moved to the registry, this is the ordinary state of any dashboard
 * that predates the move — so the sentence has to end in a button when the registry has the
 * widget, and say plainly that nobody has it when it does not.
 *
 * Installing from here does not leave the inspector: the consent dialog is rendered by this
 * component, and the store's rescan replaces the missing notice with the settings form as soon
 * as the files land. Nothing to reload, nothing to go and find in another panel.
 */
import { computed, onMounted } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import ConsentDialog from './ConsentDialog.vue'
import { pick, useI18n } from '../shared/i18n'
import { useMarketplaceStore } from './marketplace'

const props = defineProps<{ widgetId: string }>()
const market = useMarketplaceStore()
const { t } = useI18n()

/** Idempotent: the widget column loads the index when the admin opens, this only covers the rest. */
onMounted(() => { void market.load() })

const entry = computed(() => market.state.widgets.find((w) => w.id === props.widgetId))
/** Only an entry that could actually be installed is offered; a built-in id never can. */
const offered = computed(() => {
  const w = entry.value
  return w && !w.installed && !w.sdkTooNew && !w.shadowsBuiltin ? w : undefined
})
const busy = computed(() => market.state.busy === props.widgetId)
/** The dialog this component opened, never one another panel is showing. */
const prompt = computed(() =>
  market.state.consent?.widget.id === props.widgetId ? market.state.consent : null)
</script>

<template>
  <div class="missing">
    <p class="err">{{ t('admin.inspector.widget.missing') }}</p>
    <template v-if="offered">
      <p class="on-sietch">{{ t('admin.inspector.widget.onSietch', { name: pick(offered.name) }) }}</p>
      <BaseButton variant="primary" :disabled="market.state.busy !== null" @click="market.start(offered)">
        {{ busy ? t('admin.market.working') : t('admin.market.install') }}
      </BaseButton>
    </template>
    <!-- Offline is not "nobody has it": the index simply could not be read, and saying the
         widget does not exist would send the user looking for a replacement that is not needed. -->
    <p v-else-if="market.state.offline" class="hint">{{ t('admin.market.offline') }}</p>
    <p v-else-if="market.state.loaded && !entry" class="hint">{{ t('admin.inspector.widget.notOnSietch') }}</p>
    <p v-if="market.state.error" class="err">{{ market.state.error }}</p>

    <ConsentDialog v-if="prompt" :prompt="prompt" @accept="market.accept()" @cancel="market.cancel()" />
  </div>
</template>

<style scoped>
.missing { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2);
  margin-bottom: var(--space-3); }
.err { color: var(--danger); font-size: var(--fs-sm); margin: 0; }
.on-sietch { font-size: var(--fs-sm); margin: 0; }
.hint { font-size: var(--fs-xs); color: var(--text-dim); margin: 0; }
</style>
