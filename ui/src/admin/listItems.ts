import { optionLabel, optionValue, type ListItemField, type LocalizedText, type SettingField } from '../shared/types'

/** The most columns the editor draws, whatever the widget uses: the settings panel is narrow. */
export const MAX_EDITOR_COLUMNS = 6

/**
 * The words that name one item of a `list` setting in the editor: the first non-empty field the
 * manifest's `summary` lists, else the first text or choice field with a value. A choice reads as
 * its label. Empty when nothing names it yet (a new item).
 */
export function itemSummary(item: Record<string, unknown>, field: SettingField, pick: (text: LocalizedText | undefined) => string): string {
  const schema = field.itemSchema ?? {}
  const keys = field.summary ?? Object.keys(schema).filter((k) => schema[k].type === 'string' || schema[k].type === 'enum')
  for (const key of keys) {
    const text = shown(item[key], schema[key], pick)
    if (text) return text
  }
  return ''
}

function shown(value: unknown, field: ListItemField | undefined, pick: (text: LocalizedText | undefined) => string): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const raw = String(value).trim()
  if (!raw || !field) return raw
  if (field.type === 'enum') {
    const option = field.options?.find((o) => optionValue(o) === raw)
    return option ? pick(optionLabel(option)) : raw
  }
  return raw
}

/**
 * How many columns a `list` setting is drawn in, or null for one row per item. `grid` is a count
 * or the key of the number setting holding the widget's own; the editor follows it, capped.
 */
export function gridColumns(field: SettingField, schema: Record<string, SettingField>, values: Record<string, unknown>): number | null {
  if (field.grid === undefined) return null
  const n = typeof field.grid === 'number' ? field.grid : Number(values[field.grid] ?? schema[field.grid]?.default)
  if (!Number.isFinite(n) || n < 1) return Math.min(4, MAX_EDITOR_COLUMNS)
  return Math.min(Math.floor(n), MAX_EDITOR_COLUMNS)
}

/** `list` moved: the item at `from` taken out and put back at `to` among the others. */
export function moveTo<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list]
  if (from < 0 || from >= out.length) return out
  const [item] = out.splice(from, 1)
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item)
  return out
}
