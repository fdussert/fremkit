import type { LocalizedText } from '../i18n.js'
import type { Provider } from '../providers/types.js'

/**
 * One field of a connection form. Every human-readable part is a `{ fr, en }` pair, or a plain
 * string for a text that reads the same in both languages; the registry resolves them before the
 * API hands the form to the admin.
 */
export interface ConnectionFieldSpec {
  key: string
  label: LocalizedText
  /** A secret value: stored in the SecretStore, never echoed back by the API. */
  secret?: boolean
  required?: boolean
  placeholder?: LocalizedText
  help?: LocalizedText
  /** When present, the admin renders a drop-down instead of a text field. */
  options?: string[]
  /**
   * A `#rrggbb` colour: the admin renders a swatch instead of a text field, and seeds a new
   * connection with the next colour of its palette. Never a secret — it is shown next to the
   * connection wherever the connection is offered.
   */
  color?: boolean
}

export type TestResult = { ok: true; detail: string } | { ok: false; error: string }

/** Everything a connection type needs to build its provider for one configured connection. */
export interface ConnectionProviderContext {
  id: string
  /** `<type>:<id>`, the channel widgets subscribe to. */
  channel: string
  fields: Record<string, string>
  secrets: Record<string, string>
  /**
   * Stores a secret of this connection, for the rare case where the *remote service* issues one.
   *
   * Only Synology needs it so far: DSM refuses a one-time code it has already seen, and hands
   * back a device token on the first two-factor login that stands in for the code from then on.
   * Without somewhere to put that token the user would type six fresh digits at every restart.
   *
   * It writes to the same store the connections API writes to, under the same
   * `<connectionId>/<fieldKey>` key, so the value is a secret in every sense the rest of the
   * project already means: never returned by the API, never logged, never in a backup. A type
   * that has no such case simply never calls it.
   */
  saveSecret?(fieldKey: string, value: string): Promise<void>
}

/**
 * One choice a `pick` setting offers. `value` is what the widget stores — an id, never a name,
 * so renaming a device in the Homey app does not empty a dashboard. `group` heads a section of
 * the checkbox list (a zone, a flow folder) and `hint` is a discreet second line.
 */
export interface PickOption { value: string; label: string; group?: string; hint?: string }

/**
 * What `options()` refuses with. The status is the one the route answers: 400 for a source the
 * type does not know — a widget author's mistake — and 502 for a device that would not answer.
 * The message is already translated and never quotes a secret or a URL.
 */
export class OptionsError extends Error {
  constructor(public readonly status: 400 | 502, message: string) {
    super(message)
    this.name = 'OptionsError'
  }
}

export interface ConnectionType {
  id: string
  name: LocalizedText
  description: LocalizedText
  /** Icon name from `ui/src/shared/icons.ts`. */
  icon: string
  fields: ConnectionFieldSpec[]
  /**
   * The plain field keys this type's secrets are bound to: the ones that decide *where* the
   * secret is sent. A GitHub token belongs to one `host`, a Bambu access code to one printer
   * (`host` and `serial`).
   *
   * Changing one of them while leaving the secret stored would send that secret to the new
   * destination, so the API refuses it and asks for the secret again. A type leaves this out
   * when it has nothing to bind: Azure DevOps always talks to `dev.azure.com`, and an ICS
   * calendar's URL *is* its secret, so it cannot be changed without being re-entered.
   */
  secretBindings?: string[]
  /**
   * The channel family this type publishes under, when it is not the type id itself. `ics`
   * publishes on `calendar:<id>`: what a widget subscribes to is a calendar, whatever file
   * format it happens to arrive in.
   */
  channelPrefix?: string
  /** `deps` is only ever passed by the type's own tests; production callers omit it. */
  test(fields: Record<string, string>, secrets: Record<string, string>, deps?: unknown): Promise<TestResult>
  /**
   * The choices a `pick` setting of a widget offers, for one `source` the type understands
   * (`devices`, `flows`…). Omitted by a type that has nothing to list. Refuses with an
   * `OptionsError`; `deps` is only ever passed by the type's own tests.
   */
  options?(source: string, fields: Record<string, string>, secrets: Record<string, string>, deps?: unknown): Promise<PickOption[]>
  /** Omitted by a type that only authenticates something and publishes no channel of its own. */
  createProvider?(ctx: ConnectionProviderContext): Provider
}
