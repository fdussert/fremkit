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

type Item = Record<string, unknown>

/** Anything with item fields: a list setting, or a list an item holds. */
type HasItems = { itemSchema?: Record<string, ListItemField> }

/** The key of the one list an item of this setting (or of this held list) may hold, or null. */
export function nestedListKey(field: HasItems): string | null {
  return Object.entries(field.itemSchema ?? {}).find(([, f]) => f.type === 'list')?.[0] ?? null
}

/** A new item starts from its schema's defaults, and from an empty value where it declares none. */
export function newItem(f: HasItems): Item {
  const item: Item = {}
  for (const [key, field] of Object.entries(f.itemSchema ?? {})) {
    item[key] = field.default ?? (field.type === 'boolean' ? false : field.type === 'number' ? 0 : field.type === 'list' ? [] : '')
  }
  return item
}

/** The items an item holds under `key`; anything else stored there reads as none. */
export function heldItems(item: Item | undefined, key: string): Item[] {
  const held = item?.[key]
  return Array.isArray(held) ? (held as Item[]) : []
}

/** An item as `schema` describes it: the keys it declares, the lists it holds conformed in turn. */
function conform(item: Item, schema: Record<string, ListItemField>): Item {
  return Object.fromEntries(Object.entries(item)
    .filter(([key]) => Object.hasOwn(schema, key))
    .map(([key, value]) => {
      const field = schema[key]
      if (field.type !== 'list') return [key, value]
      return [key, Array.isArray(value) ? (value as Item[]).map((child) => conform(child, field.itemSchema ?? {})) : []]
    }))
}

/** True when nothing `item` holds would be lost under `schema`: each list it fills, `schema` has room for. */
function fits(item: Item, schema: Record<string, ListItemField>): boolean {
  return Object.entries(item).every(([key, value]) => {
    if (!Array.isArray(value) || value.length === 0) return true
    const field = Object.hasOwn(schema, key) ? schema[key] : undefined
    return field?.type === 'list' && (value as Item[]).every((child) => fits(child, field.itemSchema ?? {}))
  })
}

/**
 * `list` with the item at `from` moved into the list the item at `into` holds under `key`, at its
 * end. Null when that cannot be: the same item, an item holding a list the level below has no
 * room for (a subgroup into a subgroup), or a holder already at its `max`. Only the fields the
 * held items declare go along.
 */
export function nestInto(list: readonly Item[], from: number, into: number, key: string, held: ListItemField): Item[] | null {
  const moved = list[from]
  const holder = list[into]
  if (!moved || !holder || from === into || !fits(moved, held.itemSchema ?? {})) return null
  const inside = heldItems(holder, key)
  if (held.max !== undefined && inside.length >= held.max) return null
  const next = list.map((item, i) => (i === into ? { ...item, [key]: [...inside, conform(moved, held.itemSchema ?? {})] } : item))
  next.splice(from, 1)
  return next
}

/**
 * `list` with the item at `j` of the list held under `key` by the item at `i` taken out, and put
 * back right after its holder as an item of `field`, its missing fields from `fresh`.
 */
export function takeOut(list: readonly Item[], i: number, key: string, j: number, field: HasItems, fresh: Item): Item[] {
  const holder = list[i]
  const inside = heldItems(holder, key)
  if (!holder || j < 0 || j >= inside.length) return [...list]
  const next = [...list]
  next[i] = { ...holder, [key]: inside.filter((_, n) => n !== j) }
  next.splice(i + 1, 0, { ...fresh, ...conform(inside[j], field.itemSchema ?? {}) })
  return next
}
