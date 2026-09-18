<script setup lang="ts">
/**
 * "Update all", once, before any of it happens.
 *
 * One dialog rather than one per widget, because five dialogs in a row is not consent, it is a
 * thing to click through. Every waiting widget is named — including the ones asking for nothing
 * new, which say so — so the list answers "what am I agreeing to" rather than leaving the user
 * to guess which of the five it was about.
 *
 * Accepting sends the set listed here, per widget. The server checks each package against its
 * own entry and refuses the ones it was not given, so a bulk update cannot grant in bulk what
 * was never shown; a widget refused that way comes back in the results, untouched.
 */
import { computed } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseModal from '../shared/ui/BaseModal.vue'
import { pick, useI18n } from '../shared/i18n'
import { channelFamilies } from './permissions'
import type { MarketplaceWidget, WidgetPermissionSet } from '../shared/types'

const props = defineProps<{ entries: { widget: MarketplaceWidget; added: WidgetPermissionSet }[] }>()
const emit = defineEmits<{ accept: []; cancel: [] }>()
const { t } = useI18n()

/** The three groups of one set, in the order they matter, empty ones dropped. */
function groups(set: WidgetPermissionSet): { key: string; icon: string; items: string[] }[] {
  return [
    { key: 'reads', icon: 'eye', items: channelFamilies(set.subscriptions) },
    { key: 'controls', icon: 'zap', items: channelFamilies(set.commands) },
    { key: 'network', icon: 'globe', items: [...new Set(set.network)].sort() },
  ].filter((g) => g.items.length)
}

const rows = computed(() => props.entries.map((e) => ({
  id: e.widget.id,
  name: pick(e.widget.name),
  version: e.widget.version,
  groups: groups(e.added),
})))
</script>

<template>
  <BaseModal :title="t('admin.market.updateAllTitle', { n: rows.length })" :width="560"
    :close-label="t('admin.market.cancel')" @close="emit('cancel')">
    <p class="lead">{{ t('admin.market.updateAllLead') }}</p>

    <div v-for="row in rows" :key="row.id" class="entry">
      <strong>{{ row.name }} <span class="v">v{{ row.version }}</span></strong>
      <p v-if="!row.groups.length" class="none">{{ t('admin.market.noNewPermission') }}</p>
      <div v-for="g in row.groups" :key="g.key" class="group">
        <span class="lbl"><BaseIcon :name="g.icon" :size="14" />{{ t(`admin.permissions.${g.key}`) }}</span>
        <span class="items"><code v-for="i in g.items" :key="i">{{ i }}</code></span>
      </div>
    </div>

    <p class="note">{{ t('admin.permissions.note') }}</p>

    <div class="actions">
      <BaseButton variant="secondary" @click="emit('cancel')">{{ t('admin.market.cancel') }}</BaseButton>
      <BaseButton @click="emit('accept')">{{ t('admin.market.updateAll') }}</BaseButton>
    </div>
  </BaseModal>
</template>

<style scoped>
.lead { margin: 0 0 var(--space-3); font-size: var(--fs-sm); }
.entry { padding: var(--space-2) 0; border-top: 1px solid var(--border); }
.entry strong { display: block; font-size: var(--fs-sm); margin-bottom: var(--space-1); }
.v { color: var(--text-dim); font-weight: 400; font-size: var(--fs-xs); }
.group { display: flex; flex-direction: column; gap: var(--space-1); margin-bottom: var(--space-1); }
.lbl { display: flex; align-items: center; gap: var(--space-1); font-size: var(--fs-xs); color: var(--text-muted);
  text-transform: uppercase; letter-spacing: .06em; }
.items { display: flex; flex-wrap: wrap; gap: var(--space-1); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-xs);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  padding: 1px 5px; word-break: break-all; }
.none, .note { margin: 0; font-size: var(--fs-xs); color: var(--text-dim); }
.note { margin-top: var(--space-3); }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-4); }
</style>
