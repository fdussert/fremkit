/**
 * The one function that makes text safe to paste into a public bug report.
 *
 * A diagnostics report ends up in a GitHub issue, which anybody can read and nobody can fully
 * take back. So everything that leaves `GET /api/diagnostics` goes through `redact()`, and the
 * rule throughout is the one the brief set: when in doubt, redact. A report missing a host name
 * costs a question in the issue; a report carrying a token costs the user a credential.
 *
 * Two kinds of rule. The *known* values — every connection's secrets, the access secret, the
 * configured hosts, the Mac's names, the home folder — are replaced wherever they appear,
 * whatever the line around them looks like: a secret echoed inside a stack trace is still that
 * secret. The *shapes* — bearer tokens, `key=value` credentials, long random strings, e-mail
 * addresses, LAN host names, IP addresses — catch what nobody told us about.
 */

export interface RedactionContext {
  /** Values never to show: every connection's secrets, the access secret. */
  secrets?: string[]
  /** Host names or addresses a connection is configured with. */
  hosts?: string[]
  /** Free-text names the user gave things (connections, paired devices). */
  names?: string[]
  /** The Mac's own names: its host name, computer name, local host name. */
  machineNames?: string[]
  /** The user's home folder, shown as `~`. */
  home?: string
  /** The user's account name. */
  username?: string
}

/** What a removed value is replaced with, by kind, so a reader can still follow the line. */
export const MARK = {
  secret: '[secret]',
  token: '[token]',
  email: '[email]',
  ip: '[ip]',
  host: '[host]',
  name: '[name]',
  mac: '[mac]',
  user: '[user]',
} as const

/** Shorter than this, a "secret" would wipe ordinary digits and words out of every line. */
const MIN_SECRET_LENGTH = 4
/** Same for names and host names: a two-letter name is a word, not something identifying. */
const MIN_NAME_LENGTH = 3

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replaces every occurrence of each value, longest first, so a value that contains another is
 * replaced whole rather than left with a hole in it. Case-insensitive for host and machine
 * names, which DNS and macOS both treat that way.
 */
function replaceValues(text: string, values: string[] | undefined, mark: string, opts: { min: number; ignoreCase?: boolean; word?: boolean }): string {
  const list = [...new Set((values ?? []).map((v) => v.trim()).filter((v) => v.length >= opts.min))]
    .sort((a, b) => b.length - a.length)
  let out = text
  for (const value of list) {
    // A whole-word match where asked, so a name like "Office" does not eat "OfficeJet".
    const body = escape(value)
    const pattern = opts.word ? `(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])` : body
    out = out.replace(new RegExp(pattern, opts.ignoreCase ? 'gi' : 'g'), mark)
  }
  return out
}

/** The variants a secret may appear as in a log line: as is, URL-encoded, base64 in a Basic header. */
function secretVariants(secret: string): string[] {
  const out = [secret]
  const encoded = encodeURIComponent(secret)
  if (encoded !== secret) out.push(encoded)
  // JSON-escaped, as pino writes a string that contains quotes or backslashes.
  const json = JSON.stringify(secret).slice(1, -1)
  if (json !== secret) out.push(json)
  return out
}

/**
 * The host part of a configured field value, if it has one: `https://nas.example.com:5001/x`
 * gives `nas.example.com`, a bare `192.0.2.10` gives itself. Anything else gives nothing.
 */
export function hostOf(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    // A bare word ("token", "primary") parses as a host too; only dotted names and IPv6 count.
    if (!host.includes('.') && !host.includes(':')) return null
    if (isLoopback(host)) return null
    return host
  } catch {
    return null
  }
}

function isLoopback(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4 = new RegExp(`(?<![\\d.])${OCTET}(?:\\.${OCTET}){3}(?![\\d.]*\\d)`, 'g')

/**
 * IPv6 in its full form or with a `::`, with an optional zone (`%en0`). Bounded on both sides so
 * that a clock time (`12:30:45`) or a C++ name (`std::string`) is left alone.
 */
const H = '[0-9A-Fa-f]{1,4}'
const IPV6 = new RegExp(
  `(?<![0-9A-Za-z_:.])(?:(?:${H}:){7}${H}|(?:${H}:){1,7}:(?:${H}(?::${H}){0,6})?|::${H}(?::${H}){0,6})(?:%[A-Za-z0-9]+)?(?![0-9A-Za-z_:])`,
  'g',
)

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

/** Host names only a home or office network resolves. */
const LAN_HOST = /(?<![A-Za-z0-9-])[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.(?:local|lan|home|internal|localdomain|home\.arpa)(?![A-Za-z0-9-])/gi

/** `scheme://user:password@host`: the user-info goes, the host is left to the host rules. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi

/** `Bearer …`, `Basic …`, `token …` in an Authorization-like position. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]+/gi

/**
 * `key=value`, `key: value`, `"key":"value"` where the key names a credential. The key stays so
 * the reader knows something was there. A value already replaced, or an auth scheme the rule
 * above handled, is left as it is.
 */
const CREDENTIAL_KEY = /((?:["']?)(?:[A-Za-z0-9_-]*?)(?:token|secret|password|passwd|pwd|api[_-]?key|apikey|access[_-]?key|auth|authorization|cookie|session|credential|private[_-]?key|access[_-]?code|sid)(?:["']?)\s*[:=]\s*["']?)(?!(?:Bearer|Basic|Token|Digest)\s)(?!\[)([^\s"',;&}]+)/gi

/** A query parameter's value: tokens travel in URLs more often than anyone would like. */
const QUERY_VALUE = /([?&][A-Za-z0-9_.-]+=)[^&\s"'#]+/g

/** Three base64url segments: a JWT. */
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g

/**
 * A long run of letters, digits and token punctuation holding both letters and digits: the shape
 * of an API key, a PAT, a hash or a UUID. A plain long word has no digit and is left alone.
 */
const LONG_TOKEN = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g

/** Removes from `text` everything a public bug report must not carry. See the module comment. */
export function redact(text: string, ctx: RedactionContext = {}): string {
  let out = text

  // Known values first, while they are still whole: a later shape rule would otherwise cut a
  // secret in two and leave half of it behind.
  out = replaceValues(out, (ctx.secrets ?? []).flatMap(secretVariants), MARK.secret, { min: MIN_SECRET_LENGTH })

  // The home folder before anything that could match inside it.
  if (ctx.home && ctx.home.length > 1) {
    const home = ctx.home.replace(/\/+$/, '')
    out = out.replace(new RegExp(`${escape(home)}(?=/|\\b|$)`, 'g'), '~')
  }
  // Any other account's home: a log line from a run under another user, a path in a stack trace.
  out = out.replace(/\/Users\/(?!Shared\b)[^/\s"'`]+/g, `/Users/${MARK.user}`)

  out = out.replace(URL_CREDENTIALS, `$1${MARK.secret}@`)
  out = out.replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${MARK.token}`)
  out = out.replace(JWT, MARK.token)
  out = out.replace(CREDENTIAL_KEY, (_m, key: string) => `${key}${MARK.secret}`)
  out = out.replace(QUERY_VALUE, `$1${MARK.secret}`)
  out = out.replace(EMAIL, MARK.email)

  out = replaceValues(out, ctx.hosts, MARK.host, { min: MIN_NAME_LENGTH, ignoreCase: true })
  out = replaceValues(out, ctx.machineNames, MARK.mac, { min: MIN_NAME_LENGTH, ignoreCase: true, word: true })
  out = replaceValues(out, ctx.names, MARK.name, { min: MIN_NAME_LENGTH, word: true })
  out = out.replace(LAN_HOST, MARK.host)

  out = out.replace(IPV6, (m) => (isLoopback(m) ? m : MARK.ip))
  out = out.replace(IPV4, (m) => (isLoopback(m) || m === '0.0.0.0' ? m : MARK.ip))

  out = out.replace(LONG_TOKEN, MARK.token)
  if (ctx.username) out = replaceValues(out, [ctx.username], MARK.user, { min: MIN_NAME_LENGTH, word: true })
  return out
}
