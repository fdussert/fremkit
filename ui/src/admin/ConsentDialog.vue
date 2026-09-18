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
.lbl { display: flex; align-items: center; gap: var(--space-1); font-size: var(--fs-xs); color: var(--text-muted);
  text-transform: uppercase; letter-spacing: .06em; }
.items { display: flex; flex-wrap: wrap; gap: var(--space-1); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-xs);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  padding: 1px 5px; word-break: break-all; }
.none, .note { margin: 0 0 var(--space-2); font-size: var(--fs-xs); color: var(--text-dim); }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-4); }
</style>
