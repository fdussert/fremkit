import { tr } from '../i18n.js'
import type { Config, Page, Screen } from './schema.js'
import type { CommandContext } from '../providers/types.js'

/** One widget instance as a provider needs to see it: what it is, and what the user saved on it. */
export interface InstanceView {
  widgetId: string
  settings: Record<string, unknown>
}

/** One place an instance is shown: a page of a screen, or that screen's bar (`page: null`). */
export interface Place {
  screen: Screen
  page: Page | null
}

/**
 * The saved settings of one widget instance, by id.
 *
 * This is what lets a command resolve its own target instead of believing the caller. A widget
 * that asks the host to act on its behalf sends its `instanceId` and, at most, which of its own
 * buttons to use; the host looks up what that button actually points at here. Without it, any
 * widget declaring the `shortcuts` channel could ask for any application, URL or Shortcut on the
 * Mac — the manifest said *which channel*, never *which target*.
 *
 * Every instance lives in `widgets`, whichever screens, pages or bars show it. The own-property
 * check keeps `constructor` and its kin from resolving to something no user ever saved.
 */
export function findInstance(config: Config, instanceId: string): InstanceView | null {
  if (!Object.hasOwn(config.widgets, instanceId)) return null
  const widget = config.widgets[instanceId]
  return { widgetId: widget.widgetId, settings: widget.settings }
}

/**
 * Every place one instance is shown, in the order the screens hold them: screens in order, for
 * each its pages in order, then its bar.
 */
export function whereShown(config: Config, instanceId: string): Place[] {
  const out: Place[] = []
  for (const screen of config.screens) {
    for (const page of screen.pages) {
      if (page.items.some((p) => p.instanceId === instanceId)) out.push({ screen, page })
    }
    if (screen.nav.some((n) => n.instanceId === instanceId)) out.push({ screen, page: null })
  }
  return out
}

/**
 * How a place is named to the user: the page's name, or the bar. The screen's name goes in front
 * only when there is more than one screen — with one, it would be noise on every message.
 */
export function placeLabel(config: Config, place: Place): string {
  const where = place.page ? place.page.name : tr(config.locale, 'marketplace.navBar')
  return config.screens.length > 1 ? `${place.screen.name} › ${where}` : where
}

/**
 * Every shown instance of one widget, in the order the screens hold them.
 *
 * The other question a provider asks: not "what did *this* tile save" but "does any tile of mine
 * want something". A setting that configures the core rather than the tile — a sound played while
 * the dashboard is not even in front of you — has nowhere else to live, and the first tile that
 * expressed an opinion is the one that gets it.
 *
 * The order is deterministic and is the one the Edge alone always had: screens in order, for each
 * its pages in order then its bar. An instance shown on two screens is one widget with one set of
 * settings, so it is reported once, at its first appearance.
 */
export function findInstances(config: Config, widgetId: string): InstanceView[] {
  const out: InstanceView[] = []
  const seen = new Set<string>()
  const visit = (instanceId: string): void => {
    if (seen.has(instanceId) || !Object.hasOwn(config.widgets, instanceId)) return
    seen.add(instanceId)
    const widget = config.widgets[instanceId]
    if (widget.widgetId === widgetId) out.push({ widgetId, settings: widget.settings })
  }
  for (const screen of config.screens) {
    for (const page of screen.pages) for (const item of page.items) visit(item.instanceId)
    for (const item of screen.nav) visit(item.instanceId)
  }
  return out
}

/**
 * How a provider reads the dashboard: one instance at a time, by id.
 *
 * A function rather than the store itself, so a provider can be built in a test with a literal
 * and never has to know that a config store exists.
 *
 * `ctx` is the command's caller. The lookup production wires (app.ts) answers a paired device
 * only for an instance on that device's own screen (`devices/scope.ts`): a device names the
 * instance, and one placed elsewhere is not its to press.
 */
export type InstanceLookup = (instanceId: string, ctx?: CommandContext) => InstanceView | null

/** The lookup a provider gets when nothing wired one up: every instance is unknown. */
export const noInstances: InstanceLookup = () => null
