/**
 * The paired devices, as the admin sees them: the remote listener's state, the live pairing code,
 * and the list of devices.
 *
 * One record for the whole admin, so the Devices section and the screen-removal warning read the
 * same list. It is polled every few seconds while something holds `watch()` (the section), since
 * a device pairs, connects and goes away on its own: nothing in the config says so. Every other
 * reader calls `refresh()` once and reads what is there.
 */
import { ref, type Ref } from 'vue'
import { api, type DeviceStatus, type PairingOffer, type PublicDevice, type PublicIpadDevice } from '../shared/api'

export const DEVICES_POLL_MS = 3000

export type DevicesApi = Pick<typeof api,
  'getDevices' | 'setDevicesEnabled' | 'newPairingCode' | 'patchDevice' | 'refuseCompanion' | 'unlockCompanion' | 'deleteDevice' | 'deleteAllDevices' | 'resetDeviceCertificate'>

export interface Devices {
  /** The last status read; null until the first answer. */
  status: Ref<DeviceStatus | null>
  /** The code on show, or null while pairing is off or none was asked for yet. */
  offer: Ref<PairingOffer | null>
  /**
   * The last action's error, in the server's words. It stays until the next action or `dismiss()`:
   * the poll does not clear it, or a failed removal would vanish within seconds.
   */
  error: Ref<string>
  /** The last status read's error; the next successful read clears it. */
  pollError: Ref<string>
  dismiss(): void
  refresh(): Promise<void>
  setEnabled(on: boolean): Promise<void>
  /** Asks for a fresh code. One request at a time: a second call while one runs joins it. */
  newCode(): Promise<void>
  attach(id: string, screenId: string | null): Promise<void>
  /** Renames a device, an iPad or an extension. */
  rename(id: string, name: string): Promise<void>
  /** Refuses the browser extension's pairing request waiting on the Edge and here. */
  refuseCompanion(request: { requestId: string; code: string }): Promise<void>
  /** Opens extension pairing again after too many wrong codes locked it. */
  unlockCompanion(): Promise<void>
  remove(id: string): Promise<void>
  removeAll(): Promise<void>
  resetCertificate(): Promise<void>
  /** The devices showing `screenId`. */
  showing(screenId: string): PublicIpadDevice[]
  /** Polls while held; the returned function lets go. Polling stops when nobody holds it. */
  watch(): () => void
}

export function createDevices(deviceApi: DevicesApi, pollMs = DEVICES_POLL_MS): Devices {
  const status = ref<DeviceStatus | null>(null)
  const offer = ref<PairingOffer | null>(null)
  const error = ref('')
  const pollError = ref('')
  let holders = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let codeInFlight: Promise<void> | null = null

  /** Runs an action, keeping its error to show; starting one clears the last one's. */
  async function run(request: () => Promise<void>): Promise<void> {
    error.value = ''
    try {
      await request()
    } catch (err) {
      error.value = (err as Error).message
    }
  }

  async function refresh(): Promise<void> {
    try {
      status.value = await deviceApi.getDevices()
      pollError.value = ''
    } catch (err) {
      pollError.value = (err as Error).message
    }
  }

  function newCode(): Promise<void> {
    codeInFlight ??= run(async () => {
      try {
        offer.value = await deviceApi.newPairingCode()
      } catch (err) {
        // Pairing went off under us (409): no code to show, and the status says why.
        offer.value = null
        await refresh()
        throw err
      }
    }).finally(() => { codeInFlight = null })
    return codeInFlight
  }

  return {
    status, offer, error, pollError, refresh, newCode,
    dismiss() { error.value = '' },
    async setEnabled(on) {
      await run(async () => {
        const { message: _message, ...next } = await deviceApi.setDevicesEnabled(on)
        status.value = next
        if (!on) offer.value = null
      })
    },
    async attach(id, screenId) {
      await run(async () => { await deviceApi.patchDevice(id, { screenId }) })
      await refresh()
    },
    async rename(id, name) {
      await run(async () => { await deviceApi.patchDevice(id, { name }) })
      await refresh()
    },
    async refuseCompanion({ requestId, code }) {
      await run(() => deviceApi.refuseCompanion(requestId, code))
      await refresh()
    },
    async unlockCompanion() {
      await run(() => deviceApi.unlockCompanion())
      await refresh()
    },
    async remove(id) {
      await run(() => deviceApi.deleteDevice(id))
      await refresh()
    },
    async removeAll() {
      await run(() => deviceApi.deleteAllDevices())
      await refresh()
    },
    async resetCertificate() {
      await run(async () => {
        status.value = await deviceApi.resetDeviceCertificate()
        // The code on show carries the old key's hash: a device scanning it would pin a dead key.
        offer.value = null
      })
    },
    showing: (screenId) => status.value?.devices.filter((d): d is PublicIpadDevice => d.kind === 'ipad' && d.screenId === screenId) ?? [],
    watch() {
      holders += 1
      if (holders === 1) {
        void refresh()
        timer = setInterval(() => { void refresh() }, pollMs)
      }
      let held = true
      return () => {
        if (!held) return
        held = false
        holders -= 1
        if (holders === 0 && timer !== undefined) { clearInterval(timer); timer = undefined }
      }
    },
  }
}

let shared: Devices | null = null

/** The admin's one record of the paired devices, wired to the real api. */
export function useDevices(): Devices {
  shared ??= createDevices(api)
  return shared
}
