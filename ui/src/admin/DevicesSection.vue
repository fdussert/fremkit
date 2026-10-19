<script setup lang="ts">
/**
 * The Devices section: the switch that opens the remote listener, the pairing code while it is
 * open, one row per paired device, and the two ways to start over.
 *
 * A code is asked for whenever pairing is on and none is on show — on turning it on, on opening
 * the admin while it is on, when the shown one runs out — so the code on screen is always one the
 * server will take. `keyHash` itself is never shown: a partial hash is no help to
 * compare. What is shown, under the code, is the fingerprint: four words derived from it, to
 * compare with the device's screen.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { renderSVG } from 'uqr'
import BaseButton from '../shared/ui/BaseButton.vue'
import BaseCheckbox from '../shared/ui/BaseCheckbox.vue'
import BaseIcon from '../shared/ui/BaseIcon.vue'
import { useI18n } from '../shared/i18n'
import { useConfirm } from '../shared/useConfirm'
import { shortExtensionId, type PublicExtensionDevice, type PublicIpadDevice } from '../shared/api'
import type { Screen } from '../shared/types'
import AddScreenDialog from './AddScreenDialog.vue'
import { useDevices } from './devices'
import { labsCompanion, labsDevices, showsExtensions, showsIpads } from './labs'
import { useAdminStore } from './store'

const s = useAdminStore()
const { t, locale } = useI18n()
const devices = useDevices()
const confirm = useConfirm()
const { status, offer, error, pollError } = devices

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
let release: (() => void) | undefined
onMounted(() => {
  release = devices.watch()
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
})
onUnmounted(() => {
  release?.()
  if (ticker !== undefined) clearInterval(ticker)
})

const enabled = computed(() => status.value?.enabled ?? false)
/** Pairing is open only once the listener actually runs: the switch alone says nothing yet. */
const live = computed(() => enabled.value && (status.value?.listening ?? false))
const portInUse = computed(() => status.value?.error === 'portInUse')

watch([live, offer], ([isLive, shown]) => {
  if (isLive && !shown) void devices.newCode()
  else if (!isLive && shown) offer.value = null
}, { immediate: true })
/** A code that ran out is replaced, so the one on screen always pairs. */
watch(now, (at) => {
  if (live.value && offer.value && at >= offer.value.expiresAt) void devices.newCode()
})

const qr = computed(() => (offer.value ? renderSVG(offer.value.url, { ecc: 'M', pixelSize: 1 }) : ''))
const countdown = computed(() => {
  if (!offer.value) return ''
  const left = Math.max(0, Math.ceil((offer.value.expiresAt - now.value) / 1000))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
})

const deviceScreens = computed<Screen[]>(() => (s.state.config?.screens ?? []).filter((x) => x.kind === 'device'))
const list = computed<PublicIpadDevice[]>(() => (status.value?.devices ?? []).filter((d): d is PublicIpadDevice => d.kind === 'ipad'))
const extensions = computed<PublicExtensionDevice[]>(() => (status.value?.devices ?? []).filter((d): d is PublicExtensionDevice => d.kind === 'extension'))
/**
 * Two parts, each with its own rule (`labs.ts`): the iPad one follows `labs.devices` or iPad
 * pairing in use, the browser extension one `labs.companion` or a paired extension, so a paired
 * device of either kind can always be renamed or removed. Once shown, a part stays while the pane
 * is open, so removing the last device does not pull it from under the pointer; turning its flag
 * off reads the rule again. The request card follows `labs.companion` alone: with it off, no
 * request can be allowed here.
 */
const companionOn = computed(() => labsCompanion(s.state.config))
const ipadsShown = ref(false)
const extensionsShown = ref(false)
watch(() => showsIpads(s.state.config, status.value), (on) => { if (on) ipadsShown.value = true }, { immediate: true })
watch(() => showsExtensions(s.state.config, status.value), (on) => { if (on) extensionsShown.value = true }, { immediate: true })
watch(() => labsDevices(s.state.config), (on) => { if (!on) ipadsShown.value = showsIpads(s.state.config, status.value) })
watch(companionOn, (on) => { if (!on) extensionsShown.value = showsExtensions(s.state.config, status.value) })
/**
 * The extension's request, until its expiry even if the next poll is still to come, and never
 * while the last poll failed: a server that restarted has dropped it, and a code left on show
 * could be typed for a program that took the port meanwhile.
 */
const request = computed(() => {
  if (pollError.value) return null
  const r = companionOn.value ? status.value?.companionRequest ?? null : null
  return r && now.value < r.expiresAt ? r : null
})

/** Keeps the name when it is emptied or unchanged: the server refuses an empty one anyway. */
function rename(device: PublicExtensionDevice, event: Event): void {
  const input = event.target as HTMLInputElement
  const name = input.value.trim()
  if (name === '' || name === device.name) { input.value = device.name; return }
  void devices.rename(device.id, name)
}

function when(iso: string | null): string {
  if (!iso) return t('admin.devices.neverSeen')
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso
    : new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

/**
 * Waits for a pending config save first, as `onCreated` does: a device screen made or turned into
 * one a moment ago exists on the server only once that save lands.
 */
async function pickScreen(device: PublicIpadDevice, value: string): Promise<void> {
  await s.flush()
  await devices.attach(device.id, value === '' ? null : value)
}

/** The device a screen is being made for, while its dialog is open. */
const creatingFor = ref<PublicIpadDevice | null>(null)
/**
 * The server attaches a device only to a device screen it has saved, and `addScreen` saves on a
 * debounce: wait for that save before attaching, or the server answers that no such screen exists.
 */
async function onCreated(screenId: string): Promise<void> {
  const device = creatingFor.value
  if (!device) return
  await s.flush()
  await devices.attach(device.id, screenId)
}
</script>

<template>
  <div class="devices">
    <template v-if="ipadsShown">
      <BaseCheckbox :model-value="enabled" :label="t('admin.devices.enable')"
        @update:model-value="devices.setEnabled($event)" />
      <p class="ro">{{ t('admin.devices.firewall') }}</p>
      <p v-if="portInUse" class="bad" role="alert" data-test="port-in-use">{{ t('admin.devices.portInUse', { port: status?.port ?? '' }) }}</p>

      <div v-if="live && offer" class="pair">
        <!-- The SVG is drawn here from the offer's URL, never taken from the network as markup. -->
        <div class="qr" role="img" :aria-label="t('admin.devices.qr')" v-html="qr" />
        <div class="code">
          <p class="ro">{{ t('admin.devices.scan') }}</p>
          <p class="value mono" data-test="pairing-code">{{ offer.code }}</p>
          <p class="ro">{{ t('admin.devices.expires', { time: countdown }) }}</p>
          <template v-if="status?.fingerprint">
            <p class="fingerprint" data-test="fingerprint">{{ t('admin.devices.fingerprint', { words: status.fingerprint.join(' ') }) }}</p>
            <p class="ro">{{ t('admin.devices.fingerprintHelp') }}</p>
          </template>
          <BaseButton @click="devices.newCode()"><BaseIcon name="refresh-cw" :size="16" />{{ t('admin.devices.newCode') }}</BaseButton>
        </div>
      </div>
      <p v-if="live && status?.guessing" class="warn" role="alert">
        <BaseIcon name="alert-triangle" :size="16" />{{ t('admin.devices.guessing') }}
      </p>
      <ul v-if="list.length" class="list">
        <li v-for="d in list" :key="d.id" class="device" data-test="device">
          <div class="head">
            <BaseIcon name="tablet" :size="16" />
            <strong class="name">{{ d.name }}</strong>
            <span class="ro size">{{ t('admin.inspector.screen.viewport.value', d.viewport) }}</span>
          </div>
          <label class="field">
            <span class="ro">{{ t('admin.devices.screen') }}</span>
            <select :value="d.screenId ?? ''" :aria-label="t('admin.devices.screen')"
              @change="pickScreen(d, ($event.target as HTMLSelectElement).value)">
              <option value="">{{ t('admin.devices.noScreen') }}</option>
              <option v-for="x in deviceScreens" :key="x.id" :value="x.id">{{ x.name }}</option>
            </select>
          </label>
          <div v-if="d.screenId === null" class="prompt">
            <span>{{ t('admin.devices.noScreenPrompt') }}</span>
            <BaseButton variant="primary" data-test="create-screen" @click="creatingFor = d">{{ t('admin.devices.createScreen') }}</BaseButton>
          </div>
          <p class="ro">{{ t('admin.devices.pairedAt', { date: when(d.pairedAt) }) }} · {{ t('admin.devices.lastSeen', { date: when(d.lastSeen) }) }}</p>
          <BaseButton variant="danger" @click="confirm.ask(`device:${d.id}`, () => devices.remove(d.id))">
            <template v-if="confirm.armed(`device:${d.id}`)">{{ t('common.confirm') }}</template>
            <template v-else><BaseIcon name="trash-2" :size="16" />{{ t('admin.devices.remove') }}</template>
          </BaseButton>
        </li>
      </ul>
      <p v-else class="ro" data-test="ipads-none">{{ t('admin.devices.none') }}</p>

      <div class="row">
        <BaseButton variant="danger" :disabled="!list.length" @click="confirm.ask('devices:all', () => devices.removeAll())">
          {{ confirm.armed('devices:all') ? t('common.confirm') : t('admin.devices.removeAll') }}
        </BaseButton>
        <BaseButton variant="danger" @click="confirm.ask('devices:cert', () => devices.resetCertificate())">
          {{ confirm.armed('devices:cert') ? t('common.confirm') : t('admin.devices.resetCertificate') }}
        </BaseButton>
      </div>
      <p class="ro">{{ t('admin.devices.resetCertificate.hint') }}</p>
    </template>

    <section v-if="extensionsShown" class="extensions" data-test="extensions">
      <h4>{{ t('admin.devices.extensions') }}</h4>
      <div v-if="status?.companionLocked" class="request" role="alert" data-test="companion-locked">
        <p class="ask">{{ t('admin.devices.extension.locked') }}</p>
        <div class="row">
          <BaseButton variant="primary" data-test="companion-unlock" @click="devices.unlockCompanion()">{{ t('admin.devices.extension.unlock') }}</BaseButton>
        </div>
      </div>
      <div v-if="request" class="request" role="alertdialog" data-test="companion-request">
        <p class="ask">{{ t('admin.devices.extension.request') }}</p>
        <p class="rname" data-test="request-name">{{ request.name }}</p>
        <p v-if="request.extension" class="ro ext" data-test="request-extension">{{ t('admin.devices.extension.id', { id: request.extension }) }}</p>
        <p class="value mono" data-test="request-code">{{ request.code }}</p>
        <!-- No Allow: typing this code into the browser is the approval, as on the Edge. -->
        <p class="ro" data-test="request-type">{{ t('admin.devices.extension.typeCode') }}</p>
        <div class="row">
          <BaseButton data-test="request-refuse" @click="devices.refuseCompanion(request)">{{ t('admin.devices.extension.refuse') }}</BaseButton>
        </div>
      </div>

      <ul v-if="extensions.length" class="list">
        <li v-for="d in extensions" :key="d.id" class="device" data-test="extension">
          <div class="head">
            <BaseIcon name="globe" :size="16" />
            <input class="rename" :value="d.name" maxlength="60" :aria-label="t('admin.devices.extension.name')"
              data-test="extension-name" @change="rename(d, $event)" @keydown.enter="($event.target as HTMLInputElement).blur()" />
            <span v-if="d.connected" class="ro size on" data-test="extension-connected">{{ t('admin.devices.extension.connected') }}</span>
          </div>
          <p class="ro">{{ t('admin.devices.extension.kind') }} · {{ t('admin.devices.pairedAt', { date: when(d.pairedAt) }) }} · {{ t('admin.devices.lastSeen', { date: when(d.lastSeen) }) }}</p>
          <p class="ro ext" data-test="extension-id">{{ t('admin.devices.extension.id', { id: shortExtensionId(d.origin) }) }}</p>
          <BaseButton variant="danger" data-test="extension-remove" @click="confirm.ask(`device:${d.id}`, () => devices.remove(d.id))">
            <template v-if="confirm.armed(`device:${d.id}`)">{{ t('common.confirm') }}</template>
            <template v-else><BaseIcon name="trash-2" :size="16" />{{ t('admin.devices.remove') }}</template>
          </BaseButton>
        </li>
      </ul>
      <p v-else class="ro" data-test="extensions-none">{{ t('admin.devices.extension.none') }}</p>
    </section>

    <p v-if="error" class="bad action" role="alert" data-test="action-error">
      {{ error }}
      <BaseButton variant="icon" :title="t('common.close')" @click="devices.dismiss()"><BaseIcon name="x" :size="14" /></BaseButton>
    </p>
    <p v-if="pollError" class="bad" data-test="poll-error">{{ pollError }}</p>

    <AddScreenDialog v-if="creatingFor" :device="creatingFor" @created="onCreated" @close="creatingFor = null" />
  </div>
</template>

<style scoped>
.ro { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--text-muted); }
.ro.ext { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-dim); }
.bad { margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--danger); white-space: pre-wrap; }
.bad.action { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.warn { display: flex; gap: var(--space-2); align-items: flex-start; margin: 0 0 var(--space-2); font-size: var(--fs-sm); color: var(--danger); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pair { display: flex; gap: var(--space-3); align-items: center; margin-bottom: var(--space-3); }
/* A white quiet zone whatever the theme: a phone camera reads dark modules on light. */
.qr { flex: none; width: 168px; height: 168px; padding: 8px; background: #fff; border-radius: var(--radius-sm); }
.qr :deep(svg) { display: block; width: 100%; height: 100%; }
.code { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; }
.fingerprint { margin: 0 0 var(--space-1); letter-spacing: .08em; color: var(--text); }
.value { margin: 0 0 var(--space-1); font-size: 1.6em; letter-spacing: .12em; color: var(--text); }
.code :deep(button), .row :deep(button), .device :deep(button), .request :deep(button) { min-height: 44px; }
.list { list-style: none; margin: 0 0 var(--space-3); padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.device { padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.size { margin: 0 0 0 auto; }
.on { color: var(--accent); }
.rename { flex: 1; min-width: 0; min-height: 44px; box-sizing: border-box; font: inherit; font-weight: 600; color: var(--text);
  background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm); padding: 6px 8px; }
.rename:hover, .rename:focus { background: var(--surface); border-color: var(--border-strong); }
.request { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-1); margin-bottom: var(--space-3); padding: var(--space-3);
  border: 1px solid var(--accent); border-radius: var(--radius-sm); }
.request p { margin: 0; }
.rname { color: var(--accent); font-weight: 600; }
.extensions h4 { margin: var(--space-3) 0 var(--space-2); font-size: var(--fs-sm); }
.field { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.field .ro { margin: 0; }
.field select { flex: 1; min-width: 0; min-height: 44px; box-sizing: border-box; font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 6px 8px; }
.prompt { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-2); font-size: var(--fs-sm); }
.row { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-2); }
</style>
