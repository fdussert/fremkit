import type { Config } from './schema.js'

/** One city of the clock widget's `cities` list setting, as its manifest declares the item. */
export interface ClockCity { label: string; timezone: string; hour12: boolean; seconds: boolean }

/**
 * The clock widget used to take its cities as one string, `"NYC=America/New_York, Tokyo=Asia/Tokyo"`.
 * They are a `list` setting now, so an instance written before that is converted here rather than
 * in the widget: every reader — the dashboard, the admin form — then sees the one shape.
 * An entry without a zone is dropped, exactly as the old widget dropped it when rendering.
 */
export function parseCityString(raw: string): ClockCity[] {
  return raw.split(',').flatMap((entry) => {
    const [label, timezone] = entry.split('=')
    if (timezone === undefined || !timezone.trim()) return []
    return [{ label: label.trim(), timezone: timezone.trim(), hour12: false, seconds: false }]
  })
}

/**
 * Converts a clock's `cities` written as a string, in place. Any other widget, and a clock whose
 * cities are already a list, is left alone. Shared with the v3 normalisation in `migrate.ts`.
 */
export function convertClockCities(widget: { widgetId: string; settings: Record<string, unknown> }): void {
  if (widget.widgetId === 'clock' && typeof widget.settings.cities === 'string') {
    widget.settings.cities = parseCityString(widget.settings.cities)
  }
}

/**
 * Bring widget settings written against an older manifest up to the shape the current one
 * declares, and drop every widget nothing shows. Runs on load and on every save, so a config
 * never has to be rewritten on disk just to be readable, and mutates the config it is given —
 * always a fresh parse, never shared state.
 *
 * A widget referenced by no placement and no nav item, on any screen, is unreachable: nothing
 * draws it and the admin has no tile to open it from. Removing the last placement is how the
 * admin deletes a widget, so this is where it actually goes away.
 */
export function normalizeInstances(config: Config): Config {
  const shown = new Set<string>()
  for (const screen of config.screens) {
    for (const item of screen.nav) shown.add(item.instanceId)
    for (const page of screen.pages) for (const placement of page.items) shown.add(placement.instanceId)
  }
  for (const [instanceId, widget] of Object.entries(config.widgets)) {
    if (!shown.has(instanceId)) delete config.widgets[instanceId]
    else convertClockCities(widget)
  }
  return config
}
