import type { WidgetManifest } from '../widgets/manifest.js'
import type { Platform } from './index.js'

/**
 * Which platforms a channel family runs on. Only the families that are not everywhere are listed;
 * a family that is not listed runs on every platform.
 *
 * A widget that reads a channel the platform does not run is shown greyed out ("Not available on
 * this platform") rather than left to fail, and the provider is never registered there.
 */
export const CHANNEL_PLATFORMS: Readonly<Record<string, readonly Platform[]>> = {
  spotify: ['darwin'],
  shortcuts: ['darwin'],
  dock: ['darwin'],
  cleanshot: ['darwin'],
  mutedeck: ['darwin'],
  'disk-map': ['darwin'],
  // Windows brightness (DDC/CI) comes with the Windows helper.
  brightness: ['darwin'],
}

/** A channel is judged by its family: `github:abc` is `github`. */
export function channelAvailable(channel: string, platform: Platform): boolean {
  const family = channel.split(':')[0]!
  const platforms = Object.hasOwn(CHANNEL_PLATFORMS, family) ? CHANNEL_PLATFORMS[family] : undefined
  return platforms === undefined || platforms.includes(platform)
}

/** True when every channel the widget subscribes to or commands is available on `platform`. */
export function widgetAvailable(manifest: Pick<WidgetManifest, 'subscriptions' | 'commands'>, platform: Platform): boolean {
  return [...(manifest.subscriptions ?? []), ...(manifest.commands ?? [])].every((c) => channelAvailable(c, platform))
}
