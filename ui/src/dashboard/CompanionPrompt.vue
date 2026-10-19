<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { api } from '../shared/api'
import { useI18n } from '../shared/i18n'

/**
 * A browser extension asked to pair: the code to type into it, and the name it gave. Drawn over
 * everything; it hides at `expiresAt` even before the server's next snapshot says the request is
 * gone, or once the extension has confirmed the code.
 *
 * There is no Allow: typing the code into the browser is the approval, and this screen is the one
 * place it shows (with the helper, only the real Fremkit gets the kiosk to load its page). Refuse
 * carries the code on show, which the server checks against the waiting request, so a request
 * swapped in under the user's finger is not the one refused.
 *
 * While this request waits, any other browser that asks is turned away; how many did is shown, so
 * a request sitting on the slot that the user did not make (a local program holding pairing up)
 * gives itself away.
 */
const props = defineProps<{ pairing: { requestId: string; code: string; name: string; extension?: string; expiresAt: number; turnedAway?: number } }>()
const { t } = useI18n()
const expired = ref(false)
const failed = ref(false)
const busy = ref(false)
/** Set when the server said the request on show changed (409); any other failure is the generic one. */
const reason = ref('')
let timer: number | undefined

watch(() => [props.pairing.requestId, props.pairing.expiresAt], ([id], previous) => {
  window.clearTimeout(timer)
  failed.value = false
  reason.value = ''
  // An answered request stays answered: a new one is the only thing that frees the buttons.
  if (previous === undefined || id !== previous[0]) busy.value = false
  const left = props.pairing.expiresAt - Date.now()
  expired.value = left <= 0
  if (left > 0) timer = window.setTimeout(() => { expired.value = true }, left)
}, { immediate: true })
onUnmounted(() => window.clearTimeout(timer))

/**
 * Sends the answer once. On success the buttons stay disabled until the snapshot takes the prompt
 * away: a second tap would find the request gone (404) and flash "failed" over a pairing that
 * worked. Only a failure frees them again, to try once more.
 */
async function answer(call: (id: string, code: string) => Promise<unknown>) {
  if (busy.value) return
  busy.value = true; failed.value = false; reason.value = ''
  try {
    await call(props.pairing.requestId, props.pairing.code)
  } catch (err) {
    // The screen's own words, in its language: the server's text is for the admin's banner.
    reason.value = (err as { status?: unknown } | null)?.status === 409 ? t('dashboard.companion.changed') : ''
    failed.value = true
    busy.value = false
  }
}
</script>

<template>
  <div v-if="!expired" class="companion-prompt" role="alertdialog" aria-live="assertive">
    <div class="card">
      <p class="ask">{{ t('dashboard.companion.request') }}</p>
      <p class="name">{{ pairing.name }}</p>
      <p v-if="pairing.extension" class="ext" data-test="companion-extension">{{ t('dashboard.companion.extensionId', { id: pairing.extension }) }}</p>
      <p class="code" data-test="companion-code">{{ pairing.code }}</p>
      <p class="type">{{ t('dashboard.companion.typeCode') }}</p>
      <p v-if="(pairing.turnedAway ?? 0) > 0" class="turned" data-test="turned-away">{{ t('dashboard.companion.turnedAway', { n: pairing.turnedAway ?? 0 }) }}</p>
      <p v-if="failed" class="error" role="alert">{{ reason || t('dashboard.companion.failed') }}</p>
      <div class="actions">
        <button type="button" class="refuse" :disabled="busy" @click="answer(api.refuseCompanion)">{{ t('dashboard.companion.refuse') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.companion-prompt {
  position: absolute; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--bg) 80%, transparent); font-family: var(--font); color: var(--text);
}
.card {
  display: flex; flex-direction: column; align-items: center; gap: var(--space-3); padding: var(--space-5);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: 16px; text-align: center;
}
.card p { margin: 0; }
.ask { font-size: var(--fs-lg); }
.name { color: var(--accent); font-size: var(--fs-lg); font-weight: 600; }
.code { font-family: var(--font-mono); font-size: 96px; line-height: 1; letter-spacing: 0.15em; font-weight: 700; }
.ext { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-dim); }
.type { font-size: var(--fs-lg); }
.error { color: var(--danger); font-size: var(--fs-sm); }
.turned { color: var(--warn); font-size: var(--fs-sm); max-width: 32em; }
.actions { display: flex; gap: var(--space-3); }
button {
  min-width: 160px; min-height: 56px; padding: 0 var(--space-5); border-radius: 12px; font: inherit;
  font-size: var(--fs-lg); font-weight: 600; cursor: pointer; border: 1px solid var(--border-strong);
  background: var(--surface-3); color: var(--text);
}
button:disabled { opacity: 0.6; }
</style>
