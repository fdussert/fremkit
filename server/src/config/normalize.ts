import type { Config, WidgetInstance } from './schema.js'

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
 * A tile used to pick one of three `appearance` values, with `accentStyle` refining the accent
 * one. Those three are now the three independent keys `bgColor`, `opacity` and `accentMode`, so
 * an instance written against the old model is converted here — on load and on save, which is
 * what lets an old file open without the user doing anything.
 *
 * - `transparent` painted no surface at all: that is an opacity of 0 and no colour of its own.
 * - `accent` + `outline` coloured the title bar and the border: `accentMode: 'frame'`.
 * - `accent` alone painted the whole tile: `accentMode: 'fill'`.
 * - `panel` was the plain surface, which is what an instance with none of these keys already is.
 *
 * Both legacy keys go either way, so the converted instance is written back out in the new shape.
 */
export function migrateAppearance(widget: WidgetInstance): void {
  const { appearance, accentStyle } = widget
  if (appearance === 'transparent') {
    widget.opacity = 0
    widget.bgColor = undefined
  } else if (appearance === 'accent') {
    widget.accentMode = accentStyle === 'outline' ? 'frame' : 'fill'
  }
  delete widget.appearance
  delete widget.accentStyle
}

/**
 * Bring widget settings written against an older manifest up to the shape the current one
 * declares. Runs on load and on every save, so a config never has to be rewritten on disk just
 * to be readable, and mutates the config it is given — always a fresh parse, never shared state.
 */
export function normalizeInstances(config: Config): Config {
  // An empty navigation bar is stored as a missing key, never as an empty array: a file written
  // before that rule — or one the user emptied — is folded back here rather than left half-way.
  if (config.display.navWidgets && config.display.navWidgets.length === 0) config.display.navWidgets = undefined
  for (const page of config.pages) {
    for (const widget of page.widgets) {
      migrateAppearance(widget)
      if (widget.widgetId === 'clock' && typeof widget.settings.cities === 'string') {
        widget.settings.cities = parseCityString(widget.settings.cities)
      }
    }
  }
  return config
}
