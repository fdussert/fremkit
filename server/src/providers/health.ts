import type { ChannelStatus, ProviderRegistry } from './registry.js'

/**
 * The channel the editor reads every provider's last poll from, to paint a widget whose data
 * source is failing.
 *
 * Under the `config` family on purpose: the manifest schema refuses that family to every widget
 * (`RESERVED_CHANNELS` in `widgets/manifest.ts`), and a paired device is only ever handed the
 * literal `config` (`HOST_CHANNELS`), so the only sockets that can hear it are the Mac's own
 * pages. Nothing here is secret — channel names and error *codes*, already reduced by
 * `errorCode()` so a thrown message quoting a host or a path never reaches it — but which
 * connections exist and which of them fail is the editor's business, not a widget's.
 */
export const HEALTH_CHANNEL = 'config:health'

/** What the channel carries: each polled channel's last outcome, `null` for a clean poll. */
export interface HealthSnapshot {
  channels: Record<string, string | null>
}

/** Channels never polled since the server started say nothing, rather than "fine". */
export function healthSnapshot(status: ChannelStatus[]): HealthSnapshot {
  const channels: Record<string, string | null> = {}
  for (const s of status) if (s.lastError !== undefined) channels[s.channel] = s.lastError
  return { channels }
}

/**
 * Broadcasts the snapshot now, then again whenever the registry's status changes. Coalesced:
 * a connection sync registers a dozen providers in a row, and the editor needs the last of them,
 * not twelve messages. Returns the function that stops it.
 */
export function publishHealth(
  registry: ProviderRegistry,
  broadcast: (channel: string, data: HealthSnapshot) => void,
  delayMs = 200,
): () => void {
  let timer: NodeJS.Timeout | null = null
  let last = ''
  const send = (): void => {
    timer = null
    const snapshot = healthSnapshot(registry.status())
    const json = JSON.stringify(snapshot)
    if (json === last) return
    last = json
    broadcast(HEALTH_CHANNEL, snapshot)
  }
  send()
  const off = registry.onStatus(() => {
    if (timer) return
    timer = setTimeout(send, delayMs)
    timer.unref?.()
  })
  return () => {
    off()
    if (timer) clearTimeout(timer)
    timer = null
  }
}
