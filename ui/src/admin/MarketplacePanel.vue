<script setup lang="ts">
/**
 * The registry, as a panel of its own.
 *
 * It used to be a tab in the 300 px left column, which is the palette used on every visit —
 * what can be dragged onto the canvas. Browsing is a trip made on purpose, and it will carry
 * themes and wallpapers before long, so it lives where Screen and Connections live: a modal
 * opened from the top bar.
 *
 * Three views of one index rather than three requests. **Available** is the shop, **Installed**
 * is what this machine has, **Updates** is the short list somebody came here to act on — and
 * the one the top bar's badge sends you to.
 */
import { computed, onMounted } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCard from '../shared/ui/BaseCard.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import BaseSegmented from '../shared/ui/BaseSegmented.vue'
import ConsentDialog from './ConsentDialog.vue'
import UpdateAllDialog from './UpdateAllDialog.vue'
import { pick, useI18n } from '../shared/i18n'
import { useMarketplaceStore, type MarketView } from './marketplace'
import type { MarketplaceWidget } from '../shared/types'

const store = useMarketplaceStore()
const { t } = useI18n()

/** Opening the panel is the moment to try again after a registry that could not be reached. */
onMounted(() => { void store.load(store.state.offline) })

const VIEWS = computed(() => [
  { value: 'available', label: t('admin.market.view.available') },
  { value: 'installed', label: t('admin.market.view.installed') },
  {
    value: 'updates',
    label: store.updates.value
      ? t('admin.market.view.updatesN', { n: store.updates.value })
      : t('admin.market.view.updates'),
  },
])

/**
 * The kind of thing being listed. One option today.
 *
 * It is here rather than added later because the index already carries themes: when they can be
 * installed this becomes a second entry and a second card, not a second panel.
 */
const KINDS = computed(() => [{ value: 'widget', label: t('admin.market.kind.widgets') }])

/** The one line under the description: author, licence, version and size. */
function meta(w: MarketplaceWidget): string {
  const kb = Math.max(1, Math.round(w.size / 1024))
  return [w.author, w.license, `v${w.version}`, `${kb} kB`].filter(Boolean).join(' · ')
}

function busy(id: string): boolean { return store.state.busy === id }
/** Every button is disabled while anything is in flight; only the working row says so. */
const locked = computed(() => store.state.busy !== null || store.state.updatingAll)

const empty = computed(() => {
  if (store.state.search) return t('admin.market.noMatch')
  if (store.state.view === 'installed') return t('admin.market.noneInstalled')
  if (store.state.view === 'updates') return t('admin.market.noneWaiting')
  return t('admin.market.empty')
})
</script>

<template>
  <div class="market">
    <BaseSegmented :model-value="store.state.view" :options="VIEWS"
      @update:model-value="store.setView($event as MarketView)" />

    <div class="bar">
      <BaseInput v-model="store.state.search" :placeholder="t('admin.market.search')" />
      <BaseSegmented v-if="KINDS.length > 1" class="kinds" :model-value="store.state.kind" :options="KINDS"
        @update:model-value="store.state.kind = $event as 'widget'" />
      <BaseButton v-if="store.state.view === 'updates' && store.updates.value" :disabled="locked"
        @click="store.askUpdateAll()">
        {{ t('admin.market.updateAll') }}
      </BaseButton>
      <BaseButton variant="icon" :title="t('admin.market.refresh')" :disabled="store.state.loading"
        @click="store.refresh()">
        <BaseIcon name="redo-2" :size="16" />
      </BaseButton>
    </div>

    <p v-if="store.state.offline" class="note warn">{{ t('admin.market.offline') }}</p>
    <p v-else-if="store.state.error" class="note warn">{{ store.state.error }}</p>
    <p v-if="store.state.loading && !store.state.loaded" class="note">{{ t('admin.market.loading') }}</p>
    <p v-else-if="store.state.loaded && !store.state.offline && !store.shown.value.length" class="note">{{ empty }}</p>

    <div class="list">
      <BaseCard v-for="w in store.shown.value" :key="w.id" class="row" :data-widget="w.id">
        <BaseIcon :name="w.icon" :size="20" />
        <div class="txt">
          <strong>
            {{ pick(w.name) }}
            <!-- A dot in the "ok" colour, so "this one is here" reads before the text does. -->
            <span v-if="w.installed" class="state"><i class="dot ok"></i>{{ t('admin.market.installedAt', { version: w.installedVersion ?? '' }) }}</span>
            <span v-if="w.updateAvailable" class="chip up">{{ t('admin.market.updateTo', { version: w.version }) }}</span>
          </strong>
          <small>{{ pick(w.description) }}</small>
          <small class="meta">{{ meta(w) }}</small>
          <small v-if="w.connections.length" class="meta">
            {{ t('admin.market.needsConnection', { types: w.connections.join(', ') }) }}
          </small>
          <p class="perm">
            <template v-if="!w.permissions.subscriptions.length && !w.permissions.commands.length && !w.permissions.network.length">
              {{ t('admin.permissions.none') }}
            </template>
            <template v-else>
              <span v-if="w.permissions.subscriptions.length">{{ t('admin.permissions.reads.short', { n: w.permissions.subscriptions.length }) }}</span>
              <span v-if="w.permissions.commands.length">{{ t('admin.permissions.controls.short', { n: w.permissions.commands.length }) }}</span>
              <span v-if="w.permissions.network.length">{{ t('admin.permissions.network.short', { n: w.permissions.network.length }) }}</span>
            </template>
          </p>
          <p v-if="store.state.results[w.id]" class="note" :class="store.state.results[w.id].ok ? 'ok' : 'warn'">
            {{ store.state.results[w.id].ok
              ? t('admin.market.updatedTo', { version: store.state.results[w.id].version ?? '' })
              : store.state.results[w.id].error }}
          </p>
        </div>
        <div class="act">
          <span v-if="w.shadowsBuiltin" class="why">{{ t('admin.market.builtin') }}</span>
          <span v-else-if="w.sdkTooNew" class="why">{{ t('admin.market.sdkTooNew') }}</span>
          <template v-else-if="busy(w.id)">
            <span class="why working">{{ t('admin.market.working') }}</span>
          </template>
          <template v-else>
            <BaseButton v-if="w.updateAvailable" :disabled="locked" @click="store.start(w, true)">
              {{ t('admin.market.update') }}
            </BaseButton>
            <BaseButton v-else-if="!w.installed" :disabled="locked" @click="store.start(w)">
              {{ t('admin.market.install') }}
            </BaseButton>
            <!-- `danger` is the outline, not the filled red: it sits beside Install and must
                 read as the destructive one, not as the primary action. -->
            <BaseButton v-if="w.installed" variant="danger" :disabled="locked" @click="store.uninstall(w.id)">
              {{ t('admin.market.uninstall') }}
            </BaseButton>
          </template>
        </div>
      </BaseCard>
    </div>

    <ConsentDialog v-if="store.state.consent" :prompt="store.state.consent"
      @accept="store.accept()" @cancel="store.cancel()" />
    <UpdateAllDialog v-else-if="store.state.updateAllOpen" :entries="store.updateAllPrompt.value"
      @accept="store.updateAll()" @cancel="store.cancelUpdateAll()" />
  </div>
</template>

<style scoped>
.market { display: flex; flex-direction: column; gap: var(--space-3); }
.bar { display: flex; align-items: center; gap: var(--space-2); }
.bar > :first-child { flex: 1; min-width: 0; }
.kinds { width: 160px; }
.list { display: flex; flex-direction: column; gap: var(--space-2); }
.row { align-items: flex-start; }
.txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.txt strong { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--fs-sm); font-weight: 600; }
.txt small { font-size: var(--fs-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }
.meta { color: var(--text-dim); }
.perm { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-dim); display: flex; gap: var(--space-2); flex-wrap: wrap; }
.state { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-dim); flex: 0 0 auto; }
.dot.ok { background: var(--ok); }
.chip { font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); padding: 0 5px; }
.chip.up { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.act { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-1); flex: 0 0 auto; }
.why { font-size: var(--fs-xs); color: var(--text-dim); text-align: right; max-width: 10rem; }
.why.working { color: var(--accent); }
.note { margin: 0; font-size: var(--fs-xs); color: var(--text-dim); }
.note.warn { color: var(--danger); }
.note.ok { color: var(--ok); }
</style>
