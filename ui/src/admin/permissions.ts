import type { WidgetManifest, WidgetPermissionSet } from '../shared/types'

/**
 * What a widget's manifest asks for, in a shape the admin can show.
 *
 * A widget is third-party code: a folder dropped into `widgets/` declares which channels it
 * reads, which it may send commands on, and which hosts it may reach through the proxy, and
 * until now nothing in the admin said so. Nobody consents to what they cannot see, so the
 * library and the inspector spell it out.
 *
 * This is presentation only — the host enforces the manifest whatever the admin shows.
 */
export interface WidgetPermissions {
  /** Channels it may subscribe to. */
  reads: string[]
  /** Channels it may send commands on. */
  controls: string[]
  /** Hosts it may reach through the proxy. */
  network: string[]
  /** True when the manifest asks for nothing at all. */
  none: boolean
  /** How many distinct things it asks for, for a one-line badge. */
  count: number
}

/** A channel pattern as a person reads it: `azure-devops:*` is the family, not a literal name. */
export function channelFamily(channel: string): string {
  return channel.endsWith(':*') ? channel.slice(0, -2) : channel.split(':')[0]
}

/**
 * The families a list of channel patterns covers, deduplicated and sorted.
 *
 * A widget declaring `synology:*` and `synology:abc` is asking for one thing — the Synology family — and
 * showing it twice would only make the list harder to read.
 */
export function channelFamilies(channels: string[]): string[] {
  return [...new Set(channels.map(channelFamily))].sort()
}

export function widgetPermissions(manifest: WidgetManifest | undefined): WidgetPermissions {
  const reads = channelFamilies(manifest?.subscriptions ?? [])
  const controls = channelFamilies(manifest?.commands ?? [])
  const network = [...new Set(manifest?.permissions?.network ?? [])].sort()
  const count = reads.length + controls.length + network.length
  return { reads, controls, network, none: count === 0, count }
}

/**
 * The part of a widget's ask that was **not** granted.
 *
 * Only ever non-empty for a widget installed from the marketplace: its manifest is the ask and
 * the consent record is the grant, and an update can widen the first without touching the
 * second. Showing the difference is the only way a user can tell a widget that is quietly
 * missing a permission from one that never wanted it — the widget itself just looks broken.
 */
export function notGranted(manifest: WidgetManifest | undefined, asks: WidgetPermissionSet | undefined): WidgetPermissions {
  if (!manifest || !asks) return { reads: [], controls: [], network: [], none: true, count: 0 }
  const missing = (asked: string[], granted: string[]): string[] => {
    const have = new Set(granted)
    return asked.filter((a) => !have.has(a))
  }
  const reads = channelFamilies(missing(asks.subscriptions, manifest.subscriptions))
  const controls = channelFamilies(missing(asks.commands, manifest.commands))
  const network = [...new Set(missing(asks.network, manifest.permissions?.network ?? []))].sort()
  const count = reads.length + controls.length + network.length
  return { reads, controls, network, none: count === 0, count }
}
