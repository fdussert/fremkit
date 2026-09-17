<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseField from '../shared/ui/BaseField.vue'
import BaseInput from '../shared/ui/BaseInput.vue'
import { useI18n } from '../shared/i18n'
import { boundSecretsToReveal, buildSecretsPayload, useConnectionsStore } from './connections'
import { nextConnectionColor, type ConnectionSummary, type ConnectionTypeInfo } from '../shared/types'

const props = defineProps<{ type: ConnectionTypeInfo; connection: ConnectionSummary | null; id: string }>()
const emit = defineEmits<{ done: []; cancel: [] }>()

const s = useConnectionsStore()
const { t } = useI18n()
const name = ref(props.connection?.name ?? props.type.name)
const fields = reactive<Record<string, string>>({})
/** What the secret inputs currently show. Meaningless on its own — see `touched`. */
const secrets = reactive<Record<string, string>>({})
/**
 * Which secret keys the user actually typed into. Revealing a field is not typing, so an
 * untouched key stays out of every payload and the server keeps the secret it stored.
 */
const touched = reactive<Record<string, boolean>>({})
/** Which secret fields show an input instead of the masked placeholder. */
const editing = reactive<Record<string, boolean>>({})
const result = ref<{ ok: boolean; text: string } | null>(null)

/**
 * Reset on every change of target — including type-to-type when both are new connections, where
 * `connection` stays null and only the id and the type tell the forms apart.
 */
watch(() => [props.connection, props.type.id, props.id], () => {
  const c = props.connection
  name.value = c?.name ?? props.type.name
  result.value = null
  for (const key of Object.keys(fields)) delete fields[key]
  for (const key of Object.keys(secrets)) delete secrets[key]
  for (const key of Object.keys(touched)) delete touched[key]
  for (const key of Object.keys(editing)) delete editing[key]
  for (const f of props.type.fields) {
    // A type whose secret is not stored yet opens straight on an input: there is nothing to mask.
    if (f.secret) editing[f.key] = !c?.secrets[f.key]
    // A new connection's colour starts on the next one of the palette, so two calendars made
    // one after the other are told apart before the user touches anything.
    else fields[f.key] = c?.fields[f.key] ?? (f.color ? nextConnectionColor(s.state.connections.length) : '')
  }
}, { immediate: true })

const payload = computed(() => ({
  type: props.type.id,
  name: name.value.trim() || props.type.name,
  fields: { ...fields },
  secrets: buildSecretsPayload(secrets, touched),
}))

/** Any edit invalidates the result of the previous test, which was run on other values. */
function stale(): void {
  result.value = null
  s.clearError()
}

function setName(value: string): void { name.value = value; stale() }

/**
 * Editing a field a stored secret is tied to opens that secret for re-entry.
 *
 * The server refuses to send a stored token to a host the user just changed, so the form asks
 * for it up front instead of letting them save and be told no.
 */
function setField(key: string, value: string): void {
  fields[key] = value
  for (const secretKey of boundSecretsToReveal(props.type, props.connection, key, value)) {
    if (!editing[secretKey]) reveal(secretKey)
  }
  stale()
}
function setSecret(key: string, value: string): void {
  secrets[key] = value
  touched[key] = true
  stale()
}

/** A stored secret can be revealed to replace it, and the reveal can be taken back. */
const replaceable = (key: string): boolean => Boolean(props.connection?.secrets[key])

function reveal(key: string): void {
  editing[key] = true
  secrets[key] = ''
  stale()
}

function cancelReveal(key: string): void {
  editing[key] = false
  delete secrets[key]
  delete touched[key]
  stale()
}

/** Only a field that was typed into and left empty deletes the stored secret; say so. */
function secretHint(key: string, help?: string): string | undefined {
  if (!editing[key] || !replaceable(key)) return help
  const warn = t('admin.connections.form.secretWarning')
  return help ? `${help} ${warn}` : warn
}

async function onTest(): Promise<void> {
  const r = await s.test(props.id, payload.value).catch((e: Error) => ({ ok: false as const, error: e.message }))
  result.value = r.ok ? { ok: true, text: r.detail } : { ok: false, text: r.error }
}

async function onSave(): Promise<void> {
  // The save's own outcome is what the banner must show, not a stale test result.
  result.value = null
  try {
    await s.save(props.id, payload.value)
    emit('done')
  } catch {
    // The store already put the message in state.error; the banner below shows it.
  }
}
</script>

<template>
  <form class="form" @submit.prevent="onSave">
    <BaseField :label="t('admin.connections.form.name')">
      <BaseInput lazy :model-value="name" :placeholder="type.name" @update:model-value="setName(String($event))" />
    </BaseField>

    <template v-for="f in type.fields" :key="f.key">
      <BaseField v-if="!f.secret" :label="f.label" :hint="f.help">
        <select v-if="f.options" :value="fields[f.key] ?? ''"
          @change="setField(f.key, ($event.target as HTMLSelectElement).value)">
          <option value="">—</option>
          <option v-for="o in f.options" :key="o" :value="o">{{ o }}</option>
        </select>
        <input v-else-if="f.color" class="color" type="color" :value="fields[f.key] || '#000000'"
          @change="setField(f.key, ($event.target as HTMLInputElement).value)" />
        <BaseInput v-else lazy :model-value="fields[f.key] ?? ''" :placeholder="f.placeholder"
          @update:model-value="setField(f.key, String($event))" />
      </BaseField>

      <BaseField v-else :label="f.label" :hint="secretHint(f.key, f.help)">
        <div v-if="!editing[f.key]" class="masked">
          <span>•••••</span>
          <BaseButton @click="reveal(f.key)">{{ t('admin.connections.form.replace') }}</BaseButton>
        </div>
        <div v-else class="masked">
          <BaseInput lazy :model-value="secrets[f.key] ?? ''" :placeholder="f.placeholder"
            @update:model-value="setSecret(f.key, String($event))" />
          <BaseButton v-if="replaceable(f.key)" :title="t('admin.connections.form.keepSecret')"
            @click="cancelReveal(f.key)">{{ t('common.cancel') }}</BaseButton>
        </div>
      </BaseField>
    </template>

    <!-- One message at a time: the test result if there is one, the store's error otherwise. -->
    <p v-if="result" class="result" :class="{ ok: result.ok }">{{ result.text }}</p>
    <p v-else-if="s.state.error" class="result">{{ s.state.error }}</p>

    <div class="actions">
      <BaseButton :disabled="s.state.busy" @click="onTest">{{ t('admin.connections.form.test') }}</BaseButton>
      <span class="spacer" />
      <BaseButton @click="emit('cancel')">{{ t('common.cancel') }}</BaseButton>
      <BaseButton variant="primary" :disabled="s.state.busy" @click="onSave">{{ t('admin.connections.form.save') }}</BaseButton>
    </div>
  </form>
</template>

<style scoped>
.form { display: flex; flex-direction: column; }
select, .color { width: 100%; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
.color { padding: 2px; height: 32px; }
.masked { display: flex; align-items: center; gap: var(--space-2); }
.masked span { flex: 1; letter-spacing: .2em; color: var(--text-muted); font-size: var(--fs-sm); }
.result { margin: 0 0 var(--space-3); font-size: var(--fs-sm); color: var(--danger); white-space: pre-wrap; }
.result.ok { color: var(--ok); }
.actions { display: flex; align-items: center; gap: var(--space-2); }
.spacer { flex: 1; }
</style>
