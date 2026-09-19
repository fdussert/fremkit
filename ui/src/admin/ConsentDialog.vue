<script setup lang="ts">
/**
 * "This widget wants to…", before anything is downloaded.
 *
 * On a first install the whole list is new, so the two sections collapse into one. On an update
 * the difference is what matters — a version that asks for one more channel should not make the
 * user re-read six they already agreed to — so what is new is shown first and on its own, and
 * the rest is there underneath as context.
 *
 * Answering it sends **the permission set this dialog rendered**, and that is the security
 * property rather than a detail of the protocol. The card is drawn from the registry's index,
 * which is text the registry writes; the permissions that end up granted are read from the
 * manifest inside the downloaded package, which is the thing whose hash was verified. The server
 * grants only what the package asks for *and* what was shown here — so a registry advertising
 * one permission and shipping three is refused, and the dialog opens again on the real ask.
 *
 * A boolean could not have said any of that: it meant "a dialog was answered", which is not a
 * claim about what was in it.
 */
import { computed } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import BaseModal from '../shared/ui/BaseModal.vue'
import { pick, useI18n } from '../shared/i18n'
import { channelFamilies } from './permissions'
import type { ConsentPrompt } from './marketplace'
import type { WidgetPermissionSet } from '../shared/types'

const props = defineProps<{ prompt: ConsentPrompt }>()
const emit = defineEmits<{ accept: []; cancel: [] }>()
const { t } = useI18n()

/** The three groups of one permission set, in the order they matter, empty ones dropped. */
function groups(set: WidgetPermissionSet): { key: string; icon: string; items: string[] }[] {
  return [
    { key: 'reads', icon: 'eye', items: channelFamilies(set.subscriptions) },
    { key: 'controls', icon: 'zap', items: channelFamilies(set.commands) },
    { key: 'network', icon: 'globe', items: [...new Set(set.network)].sort() },
  ].filter((g) => g.items.length)
}

/**
 * How the secret will be presented, in words rather than in the kind's name.
 *
 * "as Authorization: Bearer" tells somebody who has seen an API key before exactly what will
 * happen; `http-bearer` tells them nothing. The host is deliberately *not* named: there is none
 * yet — the user types it in the admin afterwards, and saying so is the point.
 */
const carriage = computed(() => {
  const c = props.prompt.added.connection ?? props.prompt.all.connection
  if (!c) return ''
  if (c.kind === 'http-bearer') return 'Authorization: Bearer'
  if (c.kind === 'http-basic') return 'Authorization: Basic'
  if (c.kind === 'api-key-header') return `${c.headerName ?? ''}`
  if (c.kind === 'api-key-query') return `?${c.queryName ?? ''}=`
  return ''
})

/** The declaration this dialog is about, new or already granted. */
const connection = computed(() => props.prompt.added.connection ?? props.prompt.all.connection)
/** The field whose value is the credential, so the dialog can name it as the user will see it. */
const secretLabel = computed(() => {
  const field = connection.value?.fields.find((f) => f.secret)
  return field ? pick(field.label) : ''
})
/** The declaration is new to this dialog; an unchanged one is context, not an ask. */
const connectionIsNew = computed(() => props.prompt.added.connection !== undefined)

const added = computed(() => groups(props.prompt.added))
const all = computed(() => groups(props.prompt.all))
/** On a first install the difference *is* everything, so showing both lists would repeat it. */
const alsoShowAll = computed(() => props.prompt.update && all.value.length > 0)
const title = computed(() => t(props.prompt.update ? 'admin.market.consentUpdate' : 'admin.market.consentInstall',
  { name: pick(props.prompt.widget.name) }))
</script>

<template>
  <BaseModal :title="title" :width="520" :close-label="t('admin.market.cancel')" @close="emit('cancel')">
    <p class="lead">
      {{ t(prompt.update ? 'admin.market.consentUpdateLead' : 'admin.market.consentInstallLead',
           { version: prompt.widget.version }) }}
    </p>

    <p v-if="!added.length" class="none">{{ t('admin.permissions.none') }}</p>
    <div v-for="g in added" :key="g.key" class="group">
      <span class="lbl"><BaseIcon :name="g.icon" :size="14" />{{ t(`admin.permissions.${g.key}`) }}</span>
      <span class="items"><code v-for="i in g.items" :key="i">{{ i }}</code></span>
    </div>

    <template v-if="alsoShowAll">
      <h3>{{ t('admin.market.consentAlready') }}</h3>
      <div v-for="g in all" :key="'all-' + g.key" class="group dim">
        <span class="lbl"><BaseIcon :name="g.icon" :size="14" />{{ t(`admin.permissions.${g.key}`) }}</span>
        <span class="items"><code v-for="i in g.items" :key="i">{{ i }}</code></span>
      </div>
    </template>

    <!-- A connection is the one permission that is not a list of channels, and the one that
         costs the user a credential. It gets its own block, in words. -->
    <section v-if="connection" class="conn" :class="{ dim: !connectionIsNew }">
      <h3>{{ t('admin.market.consentConnection') }}</h3>
      <p class="says">{{ t('admin.market.consentConnectionLead', { name: pick(connection.name) }) }}</p>
      <p v-if="carriage" class="says">
        {{ t('admin.market.consentConnectionSecret', { field: secretLabel, carriage }) }}
      </p>
      <p v-else class="says">{{ t('admin.market.consentConnectionNoSecret') }}</p>
      <p v-if="connection.scheme === 'http'" class="says warn">{{ t('admin.market.consentConnectionHttp') }}</p>
      <span class="items">
        <code v-for="r in connection.requests" :key="r.method + r.path">{{ r.method }} {{ r.path }}</code>
      </span>
      <!-- The author's own setup instructions, as text: newlines kept, nothing rendered, no
           link followed. It is a manifest from the network in a dialog about trusting it. -->
      <p v-if="connection.hint" class="hint">{{ pick(connection.hint) }}</p>
    </section>

    <p v-if="prompt.widget.connections.length" class="note">
      {{ t('admin.market.needsConnection', { types: prompt.widget.connections.join(', ') }) }}
    </p>
    <p class="note">{{ t('admin.permissions.note') }}</p>

    <div class="actions">
      <BaseButton variant="secondary" @click="emit('cancel')">{{ t('admin.market.cancel') }}</BaseButton>
      <BaseButton @click="emit('accept')">
        {{ t(prompt.update ? 'admin.market.acceptUpdate' : 'admin.market.acceptInstall') }}
      </BaseButton>
    </div>
  </BaseModal>
</template>

<style scoped>
.lead { margin: 0 0 var(--space-3); font-size: var(--fs-sm); }
h3 { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted);
  margin: var(--space-4) 0 var(--space-2); }
.group { display: flex; flex-direction: column; gap: var(--space-1); margin-bottom: var(--space-2); }
.group.dim { opacity: .65; }
.conn { border: 1px solid var(--accent); border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3); margin: var(--space-3) 0; }
.conn.dim { border-color: var(--border-strong); opacity: .65; }
.conn h3 { margin-top: 0; }
.says { margin: 0 0 var(--space-1); font-size: var(--fs-sm); }
.says.warn { color: var(--danger); }
.hint { margin: var(--space-2) 0 0; font-size: var(--fs-xs); color: var(--text-muted);
  white-space: pre-wrap; word-break: break-word; }
.lbl { display: flex; align-items: center; gap: var(--space-1); font-size: var(--fs-xs); color: var(--text-muted);
  text-transform: uppercase; letter-spacing: .06em; }
.items { display: flex; flex-wrap: wrap; gap: var(--space-1); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-xs);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  padding: 1px 5px; word-break: break-all; }
.none, .note { margin: 0 0 var(--space-2); font-size: var(--fs-xs); color: var(--text-dim); }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-4); }
</style>
