<script setup lang="ts">
/**
 * One row of the registry panel: what the entry says, and the one thing to do about it.
 *
 * Its own component because the Available view draws these on shelves and the other two draw
 * them flat, and a card written twice is a card that ends up different in one of the two places.
 * It reads the store directly rather than taking ten props — the store is a singleton, and the
 * row's buttons act on it anyway.
 */
import { computed } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCard from '../shared/ui/BaseCard.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { pick, useI18n } from '../shared/i18n'
import { useMarketplaceStore } from './marketplace'
import type { MarketplaceWidget } from '../shared/types'

const props = defineProps<{ widget: MarketplaceWidget }>()
const store = useMarketplaceStore()
const { t } = useI18n()

/** The one line under the description: author, licence, version and size. */
const meta = computed(() => {
  const w = props.widget
  const kb = Math.max(1, Math.round(w.size / 1024))
  return [w.author, w.license, `v${w.version}`, `${kb} kB`].filter(Boolean).join(' · ')
})

const busy = computed(() => store.state.busy === props.widget.id)
/** Every button is disabled while anything is in flight; only the working row says so. */
const locked = computed(() => store.state.busy !== null || store.state.updatingAll)
const result = computed(() => store.state.results[props.widget.id])

/** The series stopped on this widget because it asks for something the dialog never showed. */
const asksMore = computed(() => {
  const p = result.value?.newPermissions
  return Boolean(p && (p.subscriptions.length || p.commands.length || p.network.length))
})
const noPermissions = computed(() => {
  const p = props.widget.permissions
  return !p.subscriptions.length && !p.commands.length && !p.network.length
})
</script>

<template>
  <BaseCard class="row" :data-widget="widget.id">
    <BaseIcon :name="widget.icon" :size="20" />
    <div class="txt">
      <strong>
        {{ pick(widget.name) }}
        <!-- A dot in the "ok" colour, so "this one is here" reads before the text does. -->
        <span v-if="widget.installed" class="state"><i class="dot ok"></i>{{ t('admin.market.installedAt', { version: widget.installedVersion ?? '' }) }}</span>
        <span v-if="widget.updateAvailable" class="chip up">{{ t('admin.market.updateTo', { version: widget.version }) }}</span>
      </strong>
      <small>{{ pick(widget.description) }}</small>
      <small class="meta">{{ meta }}</small>
      <small v-if="widget.connections.length" class="meta">
        {{ t('admin.market.needsConnection', { types: widget.connections.join(', ') }) }}
      </small>
      <p class="perm">
        <template v-if="noPermissions">{{ t('admin.permissions.none') }}</template>
        <template v-else>
          <span v-if="widget.permissions.subscriptions.length">{{ t('admin.permissions.reads.short', { n: widget.permissions.subscriptions.length }) }}</span>
          <span v-if="widget.permissions.commands.length">{{ t('admin.permissions.controls.short', { n: widget.permissions.commands.length }) }}</span>
          <span v-if="widget.permissions.network.length">{{ t('admin.permissions.network.short', { n: widget.permissions.network.length }) }}</span>
        </template>
      </p>
      <p v-if="result" class="note" :class="result.ok ? 'ok' : 'warn'">
        {{ result.ok
          ? t(store.state.resultsAre === 'install' ? 'admin.market.installedTo' : 'admin.market.updatedTo',
              { version: result.version ?? '' })
          : result.error }}
        <!-- A refusal on consent is the one failure the user can answer: the series could not
             grant what it never listed, so this hands that widget to the single dialog. -->
        <button v-if="asksMore" class="review" type="button" :disabled="locked"
          @click="store.review(widget)">{{ t('admin.market.reviewAsk') }}</button>
      </p>
    </div>
    <div class="act">
      <span v-if="widget.shadowsBuiltin" class="why">{{ t('admin.market.builtin') }}</span>
      <span v-else-if="widget.sdkTooNew" class="why">{{ t('admin.market.sdkTooNew') }}</span>
      <template v-else-if="busy">
        <span class="why working">{{ t('admin.market.working') }}</span>
      </template>
      <template v-else>
        <BaseButton v-if="widget.updateAvailable" :disabled="locked" @click="store.start(widget, true)">
          {{ t('admin.market.update') }}
        </BaseButton>
        <BaseButton v-else-if="!widget.installed" :disabled="locked" @click="store.start(widget)">
          {{ t('admin.market.install') }}
        </BaseButton>
        <!-- `danger` is the outline, not the filled red: it sits beside Install and must
             read as the destructive one, not as the primary action. -->
        <BaseButton v-if="widget.installed" variant="danger" :disabled="locked" @click="store.uninstall(widget.id)">
          {{ t('admin.market.uninstall') }}
        </BaseButton>
      </template>
    </div>
  </BaseCard>
</template>

<style scoped>
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
.review { font: inherit; color: var(--accent); background: none; border: 0; padding: 0 0 0 var(--space-1);
  cursor: pointer; text-decoration: underline; }
.review:disabled { color: var(--text-dim); cursor: default; }
</style>
