<script setup lang="ts">
/**
 * The Browse tab: the registry, as cards.
 *
 * A card says what the widget is, who wrote it, what it asks for and what installing it would
 * mean — including "needs a Synology connection", which is the thing most likely to make an
 * install pointless and the thing the user can check before spending a download on it.
 *
 * The button is the only thing that changes per row, and every state it can be in is a server
 * answer rather than a guess here: already installed, an update waiting, a built-in owns the id,
 * or the widget needs a newer Fremkit.
 */
import { onMounted } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCard from '../shared/ui/BaseCard.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import ConsentDialog from './ConsentDialog.vue'
import { pick, useI18n } from '../shared/i18n'
import type { MarketplaceStore } from './marketplace'
import type { MarketplaceWidget } from '../shared/types'

const props = defineProps<{ store: MarketplaceStore }>()
const { t } = useI18n()

onMounted(() => { void props.store.load() })

/** True while *this* row is the one working, so the other rows stay usable. */
function busy(id: string): boolean { return props.store.state.busy === id }
/** Every button is disabled while anything is in flight; only the working row says so. */
function locked(): boolean { return props.store.state.busy !== null }

/** The one line under the description: author, licence, version and size. */
function meta(w: MarketplaceWidget): string {
  const kb = Math.max(1, Math.round(w.size / 1024))
  return [w.author, w.license, `v${w.version}`, `${kb} kB`].filter(Boolean).join(' · ')
}
</script>

<template>
  <div class="browse">
    <div class="bar">
      <BaseInput v-model="store.state.search" :placeholder="t('admin.market.search')" />
      <BaseButton variant="icon" :title="t('admin.market.refresh')" :disabled="store.state.loading"
        @click="store.refresh()">
        <BaseIcon name="redo-2" :size="16" />
      </BaseButton>
    </div>

    <p v-if="store.state.offline" class="note warn">{{ t('admin.market.offline') }}</p>
    <p v-else-if="store.state.error" class="note warn">{{ store.state.error }}</p>
    <p v-if="store.state.loading && !store.state.loaded" class="note">{{ t('admin.market.loading') }}</p>
    <!-- Not while offline: "no widget published yet" is a claim about the registry, and an
         unreachable registry has told us nothing. The line above already says what happened. -->
    <p v-else-if="store.state.loaded && !store.state.offline && !store.shown.value.length" class="note">
      {{ store.state.search ? t('admin.market.noMatch') : t('admin.market.empty') }}
    </p>

    <div class="list">
      <BaseCard v-for="w in store.shown.value" :key="w.id" class="row">
        <BaseIcon :name="w.icon" :size="20" />
        <div class="txt">
          <strong>
            {{ pick(w.name) }}
            <span v-if="w.installed" class="chip">{{ t('admin.market.installedAt', { version: w.installedVersion ?? '' }) }}</span>
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
        </div>
        <div class="act">
          <span v-if="w.shadowsBuiltin" class="why">{{ t('admin.market.builtin') }}</span>
          <span v-else-if="w.sdkTooNew" class="why">{{ t('admin.market.sdkTooNew') }}</span>
          <template v-else-if="busy(w.id)">
            <span class="why working">{{ t('admin.market.working') }}</span>
          </template>
          <template v-else>
            <BaseButton v-if="w.updateAvailable" :disabled="locked()" @click="store.start(w, true)">
              {{ t('admin.market.update') }}
            </BaseButton>
            <BaseButton v-else-if="!w.installed" :disabled="locked()" @click="store.start(w)">
              {{ t('admin.market.install') }}
            </BaseButton>
            <BaseButton v-if="w.installed" variant="secondary" :disabled="locked()" @click="store.uninstall(w.id)">
              {{ t('admin.market.uninstall') }}
            </BaseButton>
          </template>
        </div>
      </BaseCard>
    </div>

    <ConsentDialog v-if="store.state.consent" :prompt="store.state.consent"
      @accept="store.accept()" @cancel="store.cancel()" />
  </div>
</template>

<style scoped>
.browse { display: flex; flex-direction: column; gap: var(--space-2); }
.bar { display: flex; align-items: center; gap: var(--space-2); }
.bar > :first-child { flex: 1; min-width: 0; }
.list { display: flex; flex-direction: column; gap: var(--space-2); }
.row { align-items: flex-start; }
.txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.txt strong { display: flex; align-items: center; gap: var(--space-1); flex-wrap: wrap; font-size: var(--fs-sm); font-weight: 600; }
.txt small { font-size: var(--fs-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }
.meta { color: var(--text-dim); }
.perm { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-dim); display: flex; gap: var(--space-2); flex-wrap: wrap; }
.chip { font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); padding: 0 5px; }
.chip.up { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.act { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-1); flex: 0 0 auto; }
.why { font-size: var(--fs-xs); color: var(--text-dim); text-align: right; max-width: 10rem; }
.why.working { color: var(--accent); }
.note { margin: 0; font-size: var(--fs-xs); color: var(--text-dim); }
.note.warn { color: var(--danger); }
</style>
