import { HEX_COLOR_RE } from '../config/schema.js'
import type { SettingField, SettingOption } from '../widgets/manifest.js'
import { isBoundedJson } from './format.js'

/**
 * Which of a widget's settings may travel in a shared layout, decided by the type its manifest
 * gives the setting — never by its name or by what the value looks like.
 *
 * - **keep**: closed values that describe a look or a behaviour and cannot hold anything about a
 *   person: booleans, numbers, colours, an enum value from the manifest's own options, a time
 *   zone, a list whose items are made only of those.
 * - **optional**: free text — a `string`, an enum with no options to check against, the Dock's
 *   `apps`, a `list` with a text field. A calendar URL, an address, a note to self live there.
 *   Left out unless the person exporting ticks it in the preview, and even then it must pass the
 *   redaction net (`export.ts`).
 * - **connection**: `connection`, `connections` and `pick` point at the author's own accounts and
 *   devices. Always blanked; whoever loads the file chooses their own.
 * - **unknown** / **invalid**: a key the manifest does not declare, or a value of the wrong type.
 *   Nothing to describe it, so it does not travel.
 */
export type SettingVerdict = 'keep' | 'optional' | 'connection' | 'unknown' | 'invalid'

/** An IANA zone name, or empty for the Mac's own. A closed vocabulary, checked by shape. */
const TIMEZONE_RE = /^(?:[A-Za-z][A-Za-z0-9_+-]{0,30}(?:\/[A-Za-z0-9_+-]{1,30}){0,2})?$/

const CONNECTION_TYPES = new Set(['connection', 'connections', 'pick'])

const optionValue = (option: SettingOption): string => (typeof option === 'string' ? option : option.value)

function closed(type: string, options: SettingField['options'], value: unknown): boolean | 'free' {
  switch (type) {
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'color': return typeof value === 'string' && HEX_COLOR_RE.test(value)
    case 'timezone': return typeof value === 'string' && TIMEZONE_RE.test(value)
    case 'enum':
      if (typeof value !== 'string') return false
      // An enum with no options is a free text field the admin happens to draw as a select.
      return options?.length ? options.map(optionValue).includes(value) : 'free'
    case 'string': return typeof value === 'string' ? 'free' : false
    default: return false
  }
}

/** The verdict for one setting. `field` is the manifest's entry for its key, if it has one. */
export function classifySetting(field: SettingField | undefined, value: unknown): SettingVerdict {
  if (!field) return 'unknown'
  if (CONNECTION_TYPES.has(field.type)) return 'connection'
  if (value === null || value === undefined || !isBoundedJson(value)) return 'invalid'
  if (field.type === 'apps') {
    return Array.isArray(value) && value.every((v) => typeof v === 'string') ? 'optional' : 'invalid'
  }
  if (field.type === 'list') {
    if (!Array.isArray(value)) return 'invalid'
    const items = Object.entries(field.itemSchema ?? {})
    let free = false
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return 'invalid'
      for (const [key, v] of Object.entries(item as Record<string, unknown>)) {
        const spec = items.find(([k]) => k === key)?.[1]
        if (!spec) return 'invalid'
        const ok = closed(spec.type, spec.options, v)
        if (ok === false) return 'invalid'
        if (ok === 'free') free = true
      }
    }
    return free ? 'optional' : 'keep'
  }
  const ok = closed(field.type, field.options, value)
  return ok === 'free' ? 'optional' : ok ? 'keep' : 'invalid'
}

/** True for a setting type that names one of the user's connections. */
export const isConnectionField = (field: SettingField | undefined): boolean => !!field && CONNECTION_TYPES.has(field.type)

/** Every string inside a value, however deep: what the redaction net reads. */
export function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) { out.push(k); stringLeaves(v, out) }
  }
  return out
}

/** A short, one-line rendering of a value for the export preview's checkbox. */
export function previewValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 120 ? `${text.slice(0, 117)}…` : text
}
