import { pick, tr, type Locale } from '../i18n.js'
import type { ConnectionType } from './types.js'

/** A colour as a connection stores it: the six-digit hex form, nothing else. */
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

/** A field as the admin receives it: every label already resolved to one language. */
export interface ConnectionFieldDescription {
  key: string
  label: string
  secret?: boolean
  required?: boolean
  placeholder?: string
  help?: string
  options?: string[]
  color?: boolean
}

export interface ConnectionTypeDescription {
  id: string; name: string; description: string; icon: string; fields: ConnectionFieldDescription[]
  /** The plain field keys a stored secret is tied to; see `ConnectionType.secretBindings`. */
  secretBindings: string[]
}

/** Which secrets are already stored for a connection, so validation knows what may be omitted. */
export type StoredSecrets = (fieldKey: string) => boolean

export class ConnectionTypeRegistry {
  private types = new Map<string, ConnectionType>()

  constructor(types: ConnectionType[] = []) {
    for (const t of types) this.register(t)
  }

  register(type: ConnectionType): void { this.types.set(type.id, type) }
  get(id: string): ConnectionType | undefined { return this.types.get(id) }
  list(): ConnectionType[] { return [...this.types.values()] }

  /**
   * The JSON `GET /api/connections/types` serves: the shape of each form, no behaviour.
   *
   * Texts are resolved here rather than sent as `{ fr, en }` pairs, so the admin renders what it
   * is given and only this one place has to know how a missing translation falls back.
   */
  describe(locale?: Locale): ConnectionTypeDescription[] {
    return this.list().map((type) => ({
      id: type.id,
      name: pick(type.name, locale),
      description: pick(type.description, locale),
      icon: type.icon,
      // The admin needs these to offer the secret again as soon as the user edits a bound field,
      // rather than letting them fill a form the server is bound to refuse.
      secretBindings: type.secretBindings ?? [],
      fields: type.fields.map((f) => ({
        key: f.key,
        ...(f.secret === undefined ? {} : { secret: f.secret }),
        ...(f.required === undefined ? {} : { required: f.required }),
        ...(f.options === undefined ? {} : { options: f.options }),
        ...(f.color === undefined ? {} : { color: f.color }),
        label: pick(f.label, locale),
        ...(f.placeholder === undefined ? {} : { placeholder: pick(f.placeholder, locale) }),
        ...(f.help === undefined ? {} : { help: pick(f.help, locale) }),
      })),
    }))
  }

  /**
   * Refuses a request that would send a stored secret somewhere the caller just moved it to.
   *
   * `fields` is what the caller submitted, `existing` what is stored. When one of the type's
   * `secretBindings` changes and a stored secret is neither resubmitted nor cleared, that secret
   * would travel to the new host on the very next poll or test — so the caller is asked to
   * re-enter it. Submitting an empty secret means "forget it", which sends nothing anywhere and
   * is allowed.
   */
  bindingErrors(
    type: ConnectionType,
    fields: Record<string, string>,
    secrets: Record<string, string>,
    existing: { fields: Record<string, string> } | undefined,
    stored: StoredSecrets,
    locale?: Locale,
  ): string[] {
    if (!existing) return []
    const kept = this.secretKeys(type).filter((key) => stored(key) && !(key in secrets))
    if (!kept.length) return []
    const errors: string[] = []
    for (const f of type.fields) {
      if (!(type.secretBindings ?? []).includes(f.key)) continue
      if (!(f.key in fields)) continue
      if (fields[f.key] === (existing.fields[f.key] ?? '')) continue
      errors.push(tr(locale, 'connections.secretBound', { field: pick(f.label, locale) }))
    }
    return errors
  }

  /** Field keys of a type, split by kind. */
  secretKeys(type: ConnectionType): string[] { return type.fields.filter((f) => f.secret).map((f) => f.key) }
  plainKeys(type: ConnectionType): string[] { return type.fields.filter((f) => !f.secret).map((f) => f.key) }

  /**
   * Validates one submitted connection against its type. Returns messages in `locale`, empty when
   * fine. `stored` says which secrets already exist, so an unchanged secret may be left out of the
   * PUT. Field names quoted in a message are the labels, resolved to the same language.
   */
  validate(
    type: ConnectionType,
    fields: Record<string, string>,
    secrets: Record<string, string>,
    stored: StoredSecrets = () => false,
    locale?: Locale,
  ): string[] {
    const errors: string[] = []
    const plain = new Set(this.plainKeys(type))
    const secret = new Set(this.secretKeys(type))

    for (const key of Object.keys(fields)) {
      if (secret.has(key)) errors.push(tr(locale, 'connections.fieldIsSecret', { field: key }))
      else if (!plain.has(key)) errors.push(tr(locale, 'connections.unknownField', { type: type.id, key }))
    }
    for (const key of Object.keys(secrets)) {
      if (!secret.has(key)) errors.push(tr(locale, 'connections.unknownSecretField', { type: type.id, key }))
    }
    for (const f of type.fields) {
      if (!f.required) continue
      const label = pick(f.label, locale)
      if (f.secret) {
        const submitted = secrets[f.key]
        const kept = submitted === undefined && stored(f.key)
        if (!kept && !submitted) errors.push(tr(locale, 'connections.fieldRequired', { field: label }))
      } else if (!fields[f.key]?.trim()) {
        errors.push(tr(locale, 'connections.fieldRequired', { field: label }))
      }
      if (!f.secret && f.options && fields[f.key] && !f.options.includes(fields[f.key])) {
        errors.push(tr(locale, 'connections.unexpectedValue', { field: label, value: fields[f.key] }))
      }
    }
    // Colour fields are checked whether or not they are required: the value is written straight
    // into a widget's CSS, so only the six-digit hex form ever gets through.
    for (const f of type.fields) {
      if (f.secret || !f.color) continue
      const value = fields[f.key]
      if (value && !COLOR_RE.test(value)) {
        errors.push(tr(locale, 'connections.invalidColor', { field: pick(f.label, locale) }))
      }
    }
    return errors
  }
}
