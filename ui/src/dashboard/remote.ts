import { onUnmounted, ref, type Ref } from 'vue'
import { useSocket } from '../shared/socket'
import { deviceUnauthorized, isRemotePage } from '../shared/remote'

export { isRemotePage }

/** What the server says about the paired device showing this page. */
export interface DeviceInfo {
  id: string
  name: string
  /** The screen the admin assigned to the device, or null when none is. */
  screenId: string | null
  /** What the app should do with its screen's brightness; null when the screen has none. */
  brightness: { target: number | null; seq: number } | null
}

function isBrightness(v: unknown): v is DeviceInfo['brightness'] {
  if (v === null) return true
  if (!v || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  return (b.target === null || typeof b.target === 'number') && typeof b.seq === 'number'
}

function isDeviceInfo(v: unknown): v is DeviceInfo {
  if (!v || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  return typeof d.id === 'string' && typeof d.name === 'string'
    && (d.screenId === null || typeof d.screenId === 'string')
    && isBrightness(d.brightness)
}

/**
 * The paired device this page runs on, and whether the server still accepts it. Asks
 * `/api/devices/me` once, then follows the `device` channel, which the server replays on subscribe
 * and pushes again whenever the device's screen or the config changes. A 401 means the device was
 * revoked; the socket reaches the same conclusion when its connection drops, through the same flag.
 */
export function useDeviceScreen(): { device: Ref<DeviceInfo | null>; unauthorized: Ref<boolean> } {
  const device = ref<DeviceInfo | null>(null)
  // A push is newer than the answer to a request sent before it: the answer must not undo it.
  let pushed = false

  const off = useSocket().subscribe('device', (data) => {
    if (!isDeviceInfo(data)) return
    pushed = true
    device.value = { id: data.id, name: data.name, screenId: data.screenId, brightness: data.brightness }
  })
  onUnmounted(off)

  fetch('/api/devices/me', { cache: 'no-store' })
    .then(async (res) => {
      if (res.status === 401) { deviceUnauthorized.value = true; return }
      if (!res.ok) return
      const data: unknown = await res.json()
      if (!pushed && isDeviceInfo(data)) device.value = { id: data.id, name: data.name, screenId: data.screenId, brightness: data.brightness }
    })
    .catch(() => { /* the server is down: the socket's push brings the device when it is back */ })

  return { device, unauthorized: deviceUnauthorized }
}
