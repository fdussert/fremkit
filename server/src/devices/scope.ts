/**
 * Which screen a caller may act on: the one rule the proxy, the commands that resolve an instance
 * and the config a device reads all apply.
 *
 * A caller on this Mac acts on every screen, as it always has. A paired device acts on the one
 * device screen it is attached to and on nothing else: an instance id it names is not a capability,
 * and an instance placed only on the Edge, or on another device's screen, is not its to use. A
 * device with no screen acts on nothing.
 */

import type { FastifyRequest } from 'fastify'
import type { Config } from '../config/schema.js'
import type { CommandContext } from '../providers/types.js'
import { isRemoteRequest, pairedDeviceOf } from '../net/remote.js'

export type ScreenScope =
  | { kind: 'all' }
  | { kind: 'screen'; screenId: string }
  | { kind: 'none' }

/**
 * The device screen a paired device is attached to, or null when it has none (or no longer
 * exists). Production passes `DeviceService.deviceScreenOf`, read at call time, so a device moved
 * to another screen or unpaired is judged as it is now.
 */
export type ScreenOfDevice = (deviceId: string) => string | null

const ALL: ScreenScope = { kind: 'all' }
const NONE: ScreenScope = { kind: 'none' }

function deviceScope(deviceId: string | null | undefined, screenOf: ScreenOfDevice): ScreenScope {
  if (deviceId === null || deviceId === undefined) return NONE
  let screenId: string | null
  try { screenId = screenOf(deviceId) } catch { return NONE }
  return screenId === null ? NONE : { kind: 'screen', screenId }
}

/**
 * The scope of an HTTP request. Local or remote is the socket's answer (`net/remote.ts`); a remote
 * request the devices gate did not tie to a device acts on nothing.
 */
export function requestScope(req: FastifyRequest, screenOf: ScreenOfDevice): ScreenScope {
  if (!isRemoteRequest(req)) return ALL
  return deviceScope(pairedDeviceOf(req), screenOf)
}

/**
 * The scope of a WebSocket command. A paired socket is scoped to its device; a socket on this
 * machine acts on everything. Fails closed: no context, or a context that is neither, is nothing.
 */
export function commandScope(ctx: CommandContext | undefined, screenOf: ScreenOfDevice): ScreenScope {
  if (ctx?.paired === true) return deviceScope(ctx.deviceId, screenOf)
  if (ctx?.loopback === true) return ALL
  return NONE
}

/** The instance ids one screen shows: on any of its pages, and in its bar. */
export function screenInstanceIds(config: Config, screenId: string): Set<string> {
  const screen = config.screens.find((s) => s.id === screenId)
  if (!screen) return new Set()
  return new Set([
    ...screen.pages.flatMap((page) => page.items.map((item) => item.instanceId)),
    ...screen.nav.map((item) => item.instanceId),
  ])
}

/** Whether `instanceId` may be acted on within `scope`. */
export function instanceInScope(config: Config, scope: ScreenScope, instanceId: string): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'none') return false
  return screenInstanceIds(config, scope.screenId).has(instanceId)
}

/** Whether some instance of `widgetId` is shown within `scope`. */
export function widgetInScope(config: Config, scope: ScreenScope, widgetId: string): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'none') return false
  for (const instanceId of screenInstanceIds(config, scope.screenId)) {
    if (Object.hasOwn(config.widgets, instanceId) && config.widgets[instanceId].widgetId === widgetId) return true
  }
  return false
}

/**
 * The config as a paired device reads it: what its dashboard page needs to draw its own screen
 * and nothing more. The theme and the language, that one screen, and the instances it shows.
 * Of the night theme, only its id: the page paints it when the `theme` channel says it is night,
 * and that phase is worked out on this Mac. The schedule's coordinates (where the Mac is) and its
 * switch times stay here.
 *
 * Never the connections (their non-secret fields name hosts and accounts), the secrets backend,
 * the marketplace records, the privacy switches, or any other screen and its widgets' settings.
 * A device with no screen gets no screen at all, which is what its page needs to say so.
 *
 * Of the experimental switches, `labs.companion` alone: off is Fremplay off on every screen, so a
 * device's page leaves its Fremplay tiles out the way the Edge does (`ui/src/shared/companionGate.ts`),
 * and shows them, saying they only play on the Edge, when it is on. One boolean, nothing else of
 * `labs`.
 */
export type DeviceConfigView = Pick<Config, 'version' | 'theme' | 'locale' | 'widgets' | 'screens'> & {
  themeSchedule?: { night: string }
  labs: { companion: boolean }
}

export function deviceConfigView(config: Config, screenId: string | null): DeviceConfigView {
  const screen = screenId === null ? undefined : config.screens.find((s) => s.id === screenId)
  // `fromEntries` defines own properties: no instance id can reach a prototype here.
  const widgets: Config['widgets'] = screen
    ? Object.fromEntries([...screenInstanceIds(config, screen.id)]
      .filter((id) => Object.hasOwn(config.widgets, id))
      .map((id) => [id, config.widgets[id]]))
    : {}
  return {
    version: config.version,
    theme: config.theme,
    ...(config.themeSchedule ? { themeSchedule: { night: config.themeSchedule.night } } : {}),
    locale: config.locale,
    labs: { companion: config.labs?.companion === true },
    widgets,
    screens: screen ? [screen] : [],
  }
}

/** The config a caller in `scope` reads: all of it on this Mac, a device's view otherwise. */
export function configForScope(config: Config, scope: ScreenScope): Config | DeviceConfigView {
  if (scope.kind === 'all') return config
  return deviceConfigView(config, scope.kind === 'screen' ? scope.screenId : null)
}

/** Every string the settings of one screen's instances hold, trimmed, at any depth. */
export function screenSettingStrings(config: Config, screenId: string): string[] {
  const out: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value.trim())
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  for (const id of screenInstanceIds(config, screenId)) {
    if (Object.hasOwn(config.widgets, id)) walk(config.widgets[id].settings)
  }
  return out
}

/**
 * Whether a caller in `scope` may have the Mac fetch this icon: on this Mac, any; for a device,
 * only one its own screen's settings point at — the exact image address a setting holds
 * (`?image=`), or the origin of a link a setting holds (`?url=`, which is how the shortcuts widget
 * asks for a site's icon). A device with no screen, none. Without this the route is a way to make
 * the Mac fetch any public URL on a device's say-so.
 */
export function iconInScope(config: Config, scope: ScreenScope, target: URL, raw: string, exact: boolean): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'none') return false
  const wanted = raw.trim()
  return screenSettingStrings(config, scope.screenId).some((s) => {
    if (exact) return s === wanted
    let url: URL
    try { url = new URL(s) } catch { return false }
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === target.origin
  })
}
