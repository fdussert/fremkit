/**
 * A connection type built from a widget's declaration rather than written in this repository.
 *
 * Everything here is derived from a manifest that came over the network, so nothing is trusted
 * beyond what `ConnectionDeclSchema` already refused. What this file adds is the behaviour the
 * schema cannot express: how the URL is built, where the secret goes, and what the generic Test
 * button does.
 *
 * The secret never leaves the server. The widget asks the proxy for a path; the proxy resolves
 * the connection, injects the secret and hands back the answer. That is the whole point of
 * declaring a connection instead of giving a widget a token and a `fetch`.
 */

import { isPrivateLiteral } from '../net/private.js'
import { tr } from '../i18n.js'
import type { ConnectionDecl, ConnectionKind, WidgetManifest } from '../widgets/manifest.js'
import type { ConnectionFieldSpec, ConnectionType, TestResult } from './types.js'
import type { Locale } from '../config/schema.js'

/** The prefix that keeps a declared id out of the coded types' namespace, for ever. */
export const DECLARED_PREFIX = 'decl:'

/** How long a Test may take before it is an unreachable host rather than a slow one. */
const TEST_TIMEOUT_MS = 10_000

/**
 * The id of the type a widget declares: `decl:<widgetId>:<slug>`.
 *
 * Two widgets declaring "Homey" get two type ids, which is the honest answer — they may mean
 * different hosts, different keys and different requests. Sharing one *connection* between them
 * is a separate thing the admin offers explicitly (§5), not something an id collision does
 * silently.
 */
export function declaredTypeId(widgetId: string, name: string): string {
  return `${DECLARED_PREFIX}${widgetId}:${slug(name)}`
}

/** True for an id this module owns. */
export function isDeclaredType(id: string): boolean {
  return id.startsWith(DECLARED_PREFIX)
}

/** The widget a declared type belongs to, or undefined when the id is not one of ours. */
export function declaredBy(typeId: string): string | undefined {
  if (!isDeclaredType(typeId)) return undefined
  return typeId.slice(DECLARED_PREFIX.length).split(':')[0] || undefined
}

function slug(name: string): string {
  const out = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  // A name of nothing but punctuation would otherwise make an id ending in a bare colon.
  return out || 'connection'
}

/**
 * The one string a `LocalizedText` is slugged from — deterministically.
 *
 * Not "the first value": that is the order the keys happen to sit in the JSON file, so a manifest
 * reformatted between two versions would change the type id and orphan every connection made
 * with it. English when it is there, otherwise the alphabetically first locale, so the same
 * declaration always produces the same id whatever an editor did to the file.
 */
export function slugText(text: ConnectionDecl['name']): string {
  if (typeof text === 'string') return text
  if (typeof text.en === 'string' && text.en) return text.en
  const keys = Object.keys(text).sort()
  return keys.length ? (text[keys[0]] ?? 'connection') : 'connection'
}

/** The field whose value is the secret, or undefined for the `host` kind, which has none. */
export function secretField(decl: ConnectionDecl): string | undefined {
  return decl.fields.find((f) => f.secret)?.key
}

/**
 * The non-secret field that is the user half of HTTP Basic.
 *
 * `http-basic` needs a user and a password, and only the password is worth hiding. Rather than
 * inventing a field, the declaration may name one `account` or `user`; if it names neither, the
 * user half is empty, which is what a service that wants "token as password" expects.
 */
export function basicUserField(decl: ConnectionDecl): string | undefined {
  return decl.fields.find((f) => !f.secret && (f.key === 'account' || f.key === 'user'))?.key
}

/**
 * What the user typed into the `host` field, once it is certain to be only a host.
 *
 * `hostname` is the name the private-address rules judge; `authority` is what goes into the URL,
 * with the port and the brackets an IPv6 address needs.
 */
export interface DeclaredHost { hostname: string; authority: string }

/**
 * Parses the `host` field, or refuses it.
 *
 * This is the one input on this whole path that the *user* types and the *widget* writes the
 * label, the placeholder and the hint for. "Paste this address" is therefore the attack, and the
 * string had better be a host and nothing else — the previous hand-rolled split let all of these
 * through:
 *
 * - `10.0.0.1:x@evil.example` — read as private, sent to `evil.example`, key in the clear;
 * - `user:pw@evil.example` — userinfo carrying whatever the widget asked for;
 * - `10.0.0.1/../x` — a path prefix in front of the allow-listed path, so the matcher and the
 *   service disagree about what was asked for;
 * - `10.0.0.1?a=b` — the declared path lands in the query string.
 *
 * So: parse it as a URL, and refuse it unless every other component is empty *and* the host the
 * parser produces is the string that was typed. That second half is what makes this safe rather
 * than clever — anything the parser dropped, moved or normalised away means the string was not
 * a host, and there is no need to reason about which of those it was.
 */
export function parseDeclaredHost(raw: string): DeclaredHost | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed || trimmed.length > 300) return null
  // A URL parser accepts a surprising amount of whitespace by stripping it; refused up front so
  // the comparison below is about shape rather than about what got trimmed.
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null

  let url: URL
  try { url = new URL(`https://${trimmed}`) } catch { return null }
  if (url.username !== '' || url.password !== '') return null
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
  // The whole of the check: what the parser ended up with has to be what was typed. A trailing
  // slash, a default port, an escaped character, a second `@` — anything at all — fails here.
  if (url.host !== trimmed.toLowerCase()) return null
  if (!url.hostname) return null

  return { hostname: url.hostname.replace(/^\[(.*)\]$/, '$1'), authority: url.host }
}

/**
 * The scheme a request to this host actually uses.
 *
 * `http` is declared for LAN devices and is refused anywhere else: a declaration that asked for
 * plain HTTP to a public host would be sending the user's key across the internet in the clear,
 * whatever the author intended. A private host is the one case where there is no certificate to
 * be had, so it is the one case where the exception exists.
 */
export function schemeFor(decl: ConnectionDecl, host: DeclaredHost): 'https' | 'http' {
  if (decl.scheme !== 'http') return 'https'
  return isPrivateLiteral(host.hostname) ? 'http' : 'https'
}

/** `scheme://host` with nothing else: the path is appended by the caller, already checked. */
export function originOf(decl: ConnectionDecl, host: DeclaredHost): string {
  return `${schemeFor(decl, host)}://${host.authority}`
}

/**
 * The headers and the query parameter that carry the secret, by kind.
 *
 * Returned rather than applied, so the proxy and the Test button inject it the same way and a
 * test that asserts "the secret is in the header" is asserting about the one place it is built.
 */
export function authFor(
  decl: ConnectionDecl,
  fields: Record<string, string>,
  secrets: Record<string, string>,
): { headers: Record<string, string>; query: Record<string, string> } {
  const key = secretField(decl)
  const secret = key ? (secrets[key] ?? '') : ''
  const kind: ConnectionKind = decl.kind
  if (kind === 'http-bearer') return { headers: { Authorization: `Bearer ${secret}` }, query: {} }
  if (kind === 'http-basic') {
    const userKey = basicUserField(decl)
    const user = userKey ? (fields[userKey] ?? '') : ''
    return { headers: { Authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}` }, query: {} }
  }
  if (kind === 'api-key-header') return { headers: { [decl.headerName as string]: secret }, query: {} }
  if (kind === 'api-key-query') return { headers: {}, query: { [decl.queryName as string]: secret } }
  return { headers: {}, query: {} }
}

/** The fields of the admin form, as the declaration described them. */
function fieldsOf(decl: ConnectionDecl): ConnectionFieldSpec[] {
  return decl.fields.map((f) => ({
    key: f.key,
    label: f.label,
    ...(f.secret === undefined ? {} : { secret: f.secret }),
    ...(f.required === undefined ? {} : { required: f.required }),
    ...(f.placeholder === undefined ? {} : { placeholder: f.placeholder }),
    ...(f.help === undefined ? {} : { help: f.help }),
  }))
}

export interface DeclaredTypeDeps {
  /** Only ever passed by the tests; production uses the global `fetch`. */
  fetch?: typeof fetch
}

/**
 * The generic Test: one GET at the declared `test.path`, expecting the declared status.
 *
 * A declaration with no `test` has nothing to press the button about, so the button says the
 * connection was saved rather than pretending to have checked something.
 *
 * Every failure is a fixed sentence of this repository's. Never the body — a service's error
 * page is remote HTML in the admin — and never the URL, which on a LAN is the user's own
 * address.
 */
async function runTest(
  decl: ConnectionDecl,
  fields: Record<string, string>,
  secrets: Record<string, string>,
  deps: DeclaredTypeDeps,
  locale?: Locale,
): Promise<TestResult> {
  const raw = (fields.host ?? '').trim()
  if (!raw) return { ok: false, error: tr(locale, 'declared.noHost') }
  // Refused before the declaration's `test` is even looked at: a string that is not a host is
  // wrong whether or not there is anything to test.
  const host = parseDeclaredHost(raw)
  if (!host) return { ok: false, error: tr(locale, 'declared.badHost') }
  if (!decl.test) return { ok: true, detail: tr(locale, 'declared.noTest') }

  const doFetch = deps.fetch ?? fetch
  const auth = authFor(decl, fields, secrets)
  let url: URL
  try { url = new URL(originOf(decl, host) + decl.test.path) }
  catch { return { ok: false, error: tr(locale, 'declared.badHost') } }
  for (const [name, value] of Object.entries(auth.query)) url.searchParams.set(name, value)

  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { ...auth.headers, accept: 'application/json, text/plain;q=0.9, */*;q=0.1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    })
    if (res.status === decl.test.expect) return { ok: true, detail: tr(locale, 'declared.reached') }
    if (res.status === 401 || res.status === 403) return { ok: false, error: tr(locale, 'declared.unauthorized') }
    // The status is a number the service chose; it says something useful and carries nothing of
    // the user's. The body never appears.
    return { ok: false, error: tr(locale, 'declared.unexpectedStatus', { status: String(res.status) }) }
  } catch {
    // TLS, DNS, refused, timed out: one sentence, because telling them apart would mean
    // repeating the address back, and on a LAN the address is the user's own.
    return { ok: false, error: tr(locale, 'declared.unreachable') }
  }
}

/**
 * The connection type a widget's declaration amounts to.
 *
 * `secretBindings: ['host']` is the rule that matters most here: the secret is bound to the host
 * it was entered for, so moving the host while keeping the stored secret is refused and the user
 * is asked for it again. Without it, editing one field would quietly send somebody's API key to
 * a new address.
 *
 * No `channelPrefix` and no `createProvider`: a declared connection publishes nothing. A widget
 * asks the proxy when it wants something, which is why this costs no polling and no channel.
 */
export function declaredType(widgetId: string, decl: ConnectionDecl, deps: DeclaredTypeDeps = {}): ConnectionType {
  return {
    id: declaredTypeId(widgetId, slugText(decl.name)),
    name: decl.name,
    description: decl.hint ?? '',
    icon: 'plug',
    fields: fieldsOf(decl),
    secretBindings: ['host'],
    test: (fields, secrets) => runTest(decl, fields, secrets, deps),
  }
}

/**
 * Which declared types the type registry should be holding, given what is installed.
 *
 * Only *installed* widgets: a built-in that wanted a connection would have a coded type written
 * for it, in this repository, reviewed with it. And only the declaration the user consented to —
 * a widget cannot widen what it may reach by editing its own manifest on disk, any more than it
 * can widen its channels.
 *
 * Uninstalling a widget takes its type out of the registry and **leaves the connections alone**.
 * The record and its secret stay until the user says otherwise: reinstalling is then the same
 * connection rather than a form to fill again, and deleting somebody's API key because they
 * removed a widget is not a decision this code gets to make.
 */
export function declaredFromCatalog(
  entries: Iterable<[string, { manifest: WidgetManifest; source: 'builtin' | 'installed' }]>,
  granted: (id: string) => WidgetManifest | undefined,
): { widgetId: string; decl: ConnectionDecl }[] {
  const out: { widgetId: string; decl: ConnectionDecl }[] = []
  for (const [id, entry] of entries) {
    if (entry.source !== 'installed') continue
    const decl = granted(id)?.connection
    if (decl) out.push({ widgetId: id, decl })
  }
  return out
}

export function syncDeclaredTypes(
  registry: { register(type: ConnectionType): void; remove(id: string): void; list(): ConnectionType[] },
  installed: { widgetId: string; decl: ConnectionDecl }[],
  deps: DeclaredTypeDeps = {},
): void {
  const wanted = new Map(installed.map((w) => [declaredTypeId(w.widgetId, slugText(w.decl.name)), w]))
  for (const type of registry.list()) {
    if (isDeclaredType(type.id) && !wanted.has(type.id)) registry.remove(type.id)
  }
  for (const [, w] of wanted) registry.register(declaredType(w.widgetId, w.decl, deps))
}
