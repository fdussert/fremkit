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
import type { ConnectionDecl, MarketplaceWidget, WidgetPermissionSet } from '../shared/types'

/**
 * `title`, `lead` and `confirm` are passed by the caller because the same dialog covers two series: the
 * updates waiting, and the widgets a screen places that are not installed. The list, the
 * per-widget permissions and the rule that nothing is downloaded before an answer are identical,
 * and writing that twice is how the two would drift.
 */
const props = defineProps<{
  entries: { widget: MarketplaceWidget; added: WidgetPermissionSet }[]
  title?: string
  lead?: string
  confirm?: string
}>()
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

/**
 * How the secret will be presented, in words. Same wording as the single-widget dialog: a bulk
 * run is not a reason to say less about the one permission that costs a credential.
 */
function carriage(c: ConnectionDecl): string {
  if (c.kind === 'http-bearer') return 'Authorization: Bearer'
  if (c.kind === 'http-basic') return 'Authorization: Basic'
  if (c.kind === 'api-key-header') return c.headerName ?? ''
  if (c.kind === 'api-key-query') return `?${c.queryName ?? ''}=`
  return ''
}

const rows = computed(() => props.entries.map((e) => ({
  id: e.widget.id,
  name: pick(e.widget.name),
  version: e.widget.version,
  groups: groups(e.added),
  // A declaration that is new or changed. It is the reason this dialog cannot be a list of
  // channel names: agreeing here is agreeing that the server will hold a credential.
  connection: e.added.connection,
})))

const secretLabel = (c: ConnectionDecl): string => {
  const field = c.fields.find((f) => f.secret)
  return field ? pick(field.label) : ''
}
</script>

<template>
  <BaseModal :title="props.title ?? t('admin.market.updateAllTitle', { n: rows.length })" :width="560"
    :close-label="t('admin.market.cancel')" @close="emit('cancel')">
    <p class="lead">{{ props.lead ?? t('admin.market.updateAllLead') }}</p>

    <div v-for="row in rows" :key="row.id" class="entry">
      <strong>{{ row.name }} <span class="v">v{{ row.version }}</span></strong>
      <p v-if="!row.groups.length && !row.connection" class="none">{{ t('admin.market.noNewPermission') }}</p>
      <div v-for="g in row.groups" :key="g.key" class="group">
        <span class="lbl"><BaseIcon :name="g.icon" :size="14" />{{ t(`admin.permissions.${g.key}`) }}</span>
        <span class="items"><code v-for="i in g.items" :key="i">{{ i }}</code></span>
      </div>

      <!-- The same block the single-widget dialog draws. A bulk run is where a changed
           declaration would otherwise slip through, so it says at least as much here. -->
      <section v-if="row.connection" class="conn">
        <span class="lbl"><BaseIcon name="plug" :size="14" />{{ t('admin.market.consentConnection') }}</span>
        <p class="says">{{ t('admin.market.consentConnectionLead', { name: pick(row.connection.name) }) }}</p>
        <p v-if="carriage(row.connection)" class="says">
          {{ t('admin.market.consentConnectionSecret', {
            field: secretLabel(row.connection), carriage: carriage(row.connection) }) }}
        </p>
        <p v-else class="says">{{ t('admin.market.consentConnectionNoSecret') }}</p>
        <p v-if="row.connection.scheme === 'http'" class="says warn">{{ t('admin.market.consentConnectionHttp') }}</p>
        <span class="items">
          <code v-for="r in row.connection.requests" :key="r.method + r.path">{{ r.method }} {{ r.path }}</code>
        </span>
      </section>
    </div>

    <p class="note">{{ t('admin.permissions.note') }}</p>

    <div class="actions">
      <BaseButton variant="secondary" @click="emit('cancel')">{{ t('admin.market.cancel') }}</BaseButton>
      <BaseButton @click="emit('accept')">{{ props.confirm ?? t('admin.market.updateAll') }}</BaseButton>
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
.conn { display: block; border-left: 2px solid var(--accent); padding-left: var(--space-2);
  margin: var(--space-1) 0 var(--space-2); }
.says { margin: 0 0 var(--space-1); font-size: var(--fs-xs); }
.says.warn { color: var(--danger); }
.none, .note { margin: 0; font-size: var(--fs-xs); color: var(--text-dim); }
.note { margin-top: var(--space-3); }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-4); }
</style>
