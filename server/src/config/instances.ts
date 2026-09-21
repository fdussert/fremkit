import type { Config } from './schema.js'

/** One widget instance as a provider needs to see it: what it is, and what the user saved on it. */
export interface InstanceView {
  widgetId: string
  settings: Record<string, unknown>
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
 * Both places an instance can live are searched: a page, and the navigation bar.
 */
export function findInstance(config: Config, instanceId: string): InstanceView | null {
  for (const page of config.pages) {
    for (const widget of page.widgets) {
      if (widget.instanceId === instanceId) return { widgetId: widget.widgetId, settings: widget.settings }
    }
  }
  for (const widget of config.display.navWidgets ?? []) {
    if (widget.instanceId === instanceId) return { widgetId: widget.widgetId, settings: widget.settings }
  }
  return null
}

/**
 * Every placed instance of one widget, in the order the dashboard holds them.
 *
 * The other question a provider asks: not "what did *this* tile save" but "does any tile of mine
 * want something". A setting that configures the core rather than the tile — a sound played while
 * the dashboard is not even in front of you — has nowhere else to live, and the first tile that
 * expressed an opinion is the one that gets it.
 */
export function findInstances(config: Config, widgetId: string): InstanceView[] {
  const out: InstanceView[] = []
  for (const page of config.pages) {
    for (const widget of page.widgets) {
      if (widget.widgetId === widgetId) out.push({ widgetId, settings: widget.settings })
    }
  }
  for (const widget of config.display.navWidgets ?? []) {
    if (widget.widgetId === widgetId) out.push({ widgetId, settings: widget.settings })
  }
  return out
}

/**
 * How a provider reads the dashboard: one instance at a time, by id.
 *
 * A function rather than the store itself, so a provider can be built in a test with a literal
 * and never has to know that a config store exists.
 */
export type InstanceLookup = (instanceId: string) => InstanceView | null

/** The lookup a provider gets when nothing wired one up: every instance is unknown. */
export const noInstances: InstanceLookup = () => null
