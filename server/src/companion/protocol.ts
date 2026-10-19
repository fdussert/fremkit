import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { isWellFormedToken } from '../http/access.js'
import { hostAddresses } from '../widgets/webrtc.js'

/**
 * 2: the socket opens with `challenge`/`proof` before `hello` (the server proves it holds the
 * extension's record before the token is sent). A version 1 extension says hello first and is
 * refused with 1008, which it shows as "update needed".
 */
export const PROTOCOL = 2

/** What the proof's HMAC signs, before the extension's nonce. */
export const PROOF_LABEL = 'fremkit-companion-proof-v1|'

/** 32 random bytes in base64url, unpadded: exactly 43 characters. */
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/

/**
 * The server's answer to a `challenge`: base64url(HMAC-SHA256(key, PROOF_LABEL + nonce)), where
 * the key is the 32 raw bytes of sha256(token), the digest the device store keeps (in hex). The
 * extension recomputes the same key from its token (companion/lib/proof.js), so a server that
 * answers right holds this extension's record, and only then does the token leave the browser.
 */
export function proofMac(key: Buffer, nonce: string): string {
  return createHmac('sha256', key).update(PROOF_LABEL + nonce, 'utf8').digest('base64url')
}

/** The origin of a Chrome extension: its id is 32 letters from a to p. */
export const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/

/**
 * Fremkit Companion's id, fixed by the `key` in companion/manifest.json: the Web Store listing's,
 * and an unpacked copy of companion/ gets the same one.
 */
export const COMPANION_EXTENSION_ID = 'lnckeodobpbbmfbdlpnegjpchgkehdlk'

/** Extra ids a developer allows (a copy with another `key`), comma-separated. */
export const EXTENSION_IDS_ENV = 'FREMKIT_COMPANION_EXTENSION_IDS'

const EXTENSION_ID_RE = /^[a-p]{32}$/

/**
 * The extension origins the companion routes and socket answer: Companion's, plus the ids listed in
 * `FREMKIT_COMPANION_EXTENSION_IDS`. Any other extension is refused before it can ask to pair, so
 * one from the store that is not Companion cannot hold the pairing slot or put a request on the
 * Edge. `ignored`: the entries that are not extension ids, for the caller to log.
 */
export function companionOrigins(env: NodeJS.ProcessEnv = process.env): { origins: ReadonlySet<string>; ignored: string[] } {
  const ids = new Set([COMPANION_EXTENSION_ID])
  const ignored: string[] = []
  for (const raw of (env[EXTENSION_IDS_ENV] ?? '').split(',')) {
    const id = raw.trim()
    if (id === '') continue
    if (EXTENSION_ID_RE.test(id)) ids.add(id)
    else ignored.push(id)
  }
  return { origins: new Set([...ids].map((id) => `chrome-extension://${id}`)), ignored }
}

/** The first characters of an extension origin's id, to tell two extensions apart at a glance. */
export function shortExtensionId(origin: string): string {
  return origin.slice('chrome-extension://'.length, 'chrome-extension://'.length + 6)
}

export const MAX_MESSAGE_BYTES = 65_536
export const MAX_SDP = 32_000

const MAX_TITLE = 300
/** A week: longer than any video, short enough to keep a bogus value off the screen. */
const MAX_SECONDS = 604_800

/**
 * Loopback, a `.local` name, or one of `own`, this Mac's addresses. A host candidate is one of its
 * machine's own addresses by construction, and both ends of a share are on this Mac, so an address
 * of another host on the network is never a candidate either side should be given.
 */
function isLocalAddress(address: string, own: ReadonlySet<string>): boolean {
  // mDNS names are what browsers put in a host candidate to hide the real address; the kiosk's
  // answer carries one.
  if (address.endsWith('.local') && address.length > '.local'.length) return /^[a-z0-9.-]+$/i.test(address)
  // A link-local IPv6 address may name its interface: fe80::1%en0.
  const bare = address.split('%')[0].toLowerCase()
  const family = isIP(bare)
  if (family === 4) return bare.startsWith('127.') || own.has(bare)
  if (family === 6) return bare === '::1' || own.has(bare)
  return false
}

/**
 * True when an SDP names nothing beyond this Mac: it starts with `v=0`, fits `MAX_SDP`, and every
 * candidate is of type `host` on loopback, on a `.local` name or on one of this Mac's own addresses
 * (`own`, read from its interfaces at each call: a DHCP lease or a VPN moves them). The offer is the
 * only thing that tells the kiosk where to connect, so a server-reflexive or relay candidate, or
 * another machine's address, is refused rather than relayed: a linked extension cannot make the
 * kiosk probe the network.
 */
export function isLocalSdp(sdp: string, own: Iterable<string> = hostAddresses()): boolean {
  if (sdp.length > MAX_SDP || !sdp.startsWith('v=0')) return false
  const mine = new Set([...own].map((a) => a.toLowerCase()))
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) continue
    // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
    const fields = line.split(/\s+/)
    if (fields[6] !== 'typ' || fields[7] !== 'host' || !isLocalAddress(fields[4] ?? '', mine)) return false
  }
  return true
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

/**
 * A bare hostname, as `new URL(...).hostname` gives it: no scheme, port or path. IPv6 hostnames
 * (which the URL API wraps in brackets) are refused: a video page on a bare IPv6 address is not
 * worth the extra grammar.
 */
const HostSchema = z.string().regex(HOSTNAME_RE)

const SecondsSchema = z.number().min(0).max(MAX_SECONDS)

export const MetaSchema = z.strictObject({
  title: z.string().max(MAX_TITLE),
  host: HostSchema,
  currentTime: SecondsSchema,
  duration: SecondsSchema,
  paused: z.boolean(),
  muted: z.boolean(),
  volume: z.number().min(0).max(1),
})
export type TabMeta = z.infer<typeof MetaSchema>

const Id = z.uuid()
/**
 * An offer's text, bounded. Whether it names only this Mac is the session's call (`isLocalSdp`): a
 * candidate it refuses costs that one receiver its video, with `tab.refused` (reason `offer`, and
 * the receiver), rather than closing the socket, which the extension would reconnect and offer again.
 */
const Sdp = z.string().max(MAX_SDP)
const Token = z.string().refine(isWellFormedToken, 'not a token')

/** The extension's modules. */
export const FREMPLAY_MODULE = 'fremplay'
export const FREMDEV_MODULE = 'fremdev'

/**
 * The names of the modules an extension runs. Unknown names pass, so a newer extension with a module
 * this server has never heard of still connects.
 */
const ModulesSchema = z.array(z.string().min(1).max(32)).max(8)

/** At most this many dev tabs in one `dev.tabs`. */
export const MAX_DEV_TABS = 32
/** The longest error text or request path a dev tab row carries. */
export const MAX_DEV_TEXT = 300

const MAX_COUNT = 1_000_000
const Count = z.number().int().min(0).max(MAX_COUNT)
const Stamp = z.number().finite().min(0)

/** A tab's errors or requests: counts, `open` being the ones not yet dismissed or answered. */
function tally<T extends z.ZodType>(last: T) {
  return z
    .strictObject({ total: Count, open: Count, last: last.nullable() })
    .refine((t) => t.open <= t.total, { message: 'open above total' })
}

export const DevTabSchema = z.strictObject({
  tabId: z.number().int().min(0).max(2_147_483_647),
  /** The tab's title, or its host:port. */
  app: z.string().max(120),
  /** host:port, as the URL gives it: `_` included, a URL's host may carry one (`my_app.localhost`). */
  host: z.string().regex(/^[a-z0-9._\-[\]:]{1,260}$/i),
  errors: tally(z.strictObject({ text: z.string().max(MAX_DEV_TEXT), at: Stamp })),
  requests: tally(
    z.strictObject({
      // A path alone: a query or fragment can carry a token.
      path: z.string().max(MAX_DEV_TEXT).regex(/^\/[^?#]*$/),
      /** 0: the request failed before any answer. */
      status: z.number().int().min(0).max(599),
      at: Stamp,
    }),
  ),
  server: z.enum(['up', 'down']),
  /** Milliseconds since the epoch of the tab's last event. */
  activity: Stamp,
})
export type DevTab = z.infer<typeof DevTabSchema>

export const ExtensionMessageSchema = z.discriminatedUnion('type', [
  // The first message of a socket: which record to prove, and the nonce to prove it on.
  z.strictObject({ type: z.literal('challenge'), deviceId: Id, nonce: z.string().regex(NONCE_RE) }),
  // The one message that is not strict: a newer extension may say more in its hello (it already
  // lists its `modules`) and must still connect. Unknown keys are stripped, not refused.
  z.object({
    type: z.literal('hello'),
    token: Token,
    installId: Id,
    // Any integer: the server answers a version it does not speak with `tab.refused`.
    protocol: z.number().int(),
    // A list it cannot read (a newer extension's ninth module, a longer name) still connects:
    // the install is then not Fremdev-capable, and Fremplay works as before.
    modules: ModulesSchema.optional().catch(undefined),
    session: z.strictObject({ sessionId: Id, meta: MetaSchema }).optional(),
  }),
  z.strictObject({ type: z.literal('tab.started'), sessionId: Id, meta: MetaSchema }),
  z.strictObject({ type: z.literal('tab.meta'), sessionId: Id, meta: MetaSchema }),
  z.strictObject({ type: z.literal('tab.offer'), sessionId: Id, receiverId: Id, sdp: Sdp }),
  z.strictObject({ type: z.literal('tab.stopped'), sessionId: Id }),
  // The modules the extension runs now, said again when the user switches one on or off.
  z.strictObject({ type: z.literal('modules'), modules: ModulesSchema }),
  // The dev tabs' whole state, replacing the last: a tab missing from it is gone.
  z.strictObject({ type: z.literal('dev.tabs'), tabs: z.array(DevTabSchema).max(MAX_DEV_TABS) }),
  // Keeps the extension's service worker awake while a dev tab is open.
  z.strictObject({ type: z.literal('ping') }),
])
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>

export const ControlSchema = z
  .strictObject({
    action: z.enum(['toggle', 'seek', 'volume', 'mute', 'stop', 'show']),
    delta: z.union([z.literal(-10), z.literal(10)]).optional(),
    value: z.number().min(0).max(1).optional(),
  })
  .refine((c) => c.action !== 'seek' || c.delta !== undefined, { message: 'seek needs a delta' })
  .refine((c) => c.action !== 'volume' || c.value !== undefined, { message: 'volume needs a value' })
export type Control = z.infer<typeof ControlSchema>

/** What the server sends the extension. It is built here, never parsed, so it is a plain type. */
export type ServerMessage =
  | { type: 'proof'; mac: string }
  /**
   * `modules`: which of the extension's modules this server has switched on (`fremplay`:
   * `labs.companion`). Optional and new within protocol 2: an extension that does not read it
   * learns the same from `tab.refused` with `disabled`. `fremdev` is present only on a server that
   * speaks Fremdev, and the extension sends no Fremdev message to a server that leaves it out.
   */
  | { type: 'ready'; protocol: number; modules?: { fremplay: boolean; fremdev?: boolean } }
  | { type: 'tab.accepted'; sessionId: string }
  /** `disabled`: Fremplay is off in Fremkit (`labs.companion`). */
  | { type: 'tab.refused'; sessionId: string; reason: 'noWidget' | 'protocol' | 'disabled' }
  /** One receiver's offer named more than this Mac: that receiver gets no video, the share goes on. */
  | { type: 'tab.refused'; sessionId: string; reason: 'offer'; receiverId: string }
  | { type: 'tab.view'; receiverId: string }
  | { type: 'tab.answer'; receiverId: string; sdp: string }
  | ({ type: 'tab.control' } & Control)
  | { type: 'tab.detach'; receiverId: string }
  | { type: 'tab.stop' }
  | { type: 'revoked' }
  /** The Edge asks the tab to come to the front. */
  | { type: 'dev.focus'; tabId: number }
  /** The Edge dismisses the tab's open errors. */
  | { type: 'dev.clear'; tabId: number }

/** The JSON of a message within the size limit; undefined when over it or not JSON. */
function readJson(raw: string): unknown {
  if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Null when the text is over the size limit, is not JSON, or is not one of the messages. */
export function parseExtensionMessage(raw: string): ExtensionMessage | null {
  const json = readJson(raw)
  if (json === undefined) return null
  const parsed = ExtensionMessageSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** Fremdev's messages: after hello, one that fails its schema costs itself, never the socket. */
const DEV_MESSAGE_TYPES: ReadonlySet<unknown> = new Set(['dev.tabs', 'modules', 'ping'])

/** A `dev.tabs` whose rows are judged one by one. */
const DevTabsEnvelope = z.strictObject({ type: z.literal('dev.tabs'), tabs: z.array(z.unknown()).max(MAX_DEV_TABS) })

/**
 * What a message after hello comes to. `msg` null: a Fremdev message that did not parse, dropped
 * whole. `dropped`: how many dev rows (or messages) were left out, for a debug line that carries
 * none of their content. Null, as with `parseExtensionMessage`: the socket is refused.
 *
 * Fremdev's messages never cost the socket: it also carries Fremplay's share, and a row the server
 * cannot read (an extension newer than it, or a bound one side has wrong) would otherwise close it,
 * and the extension reconnect and send the same row again. Every other message stays strict.
 */
export function parseAfterHello(raw: string): { msg: ExtensionMessage | null; dropped: number } | null {
  const json = readJson(raw)
  if (json === undefined) return null
  const parsed = ExtensionMessageSchema.safeParse(json)
  if (parsed.success) return { msg: parsed.data, dropped: 0 }
  const type = typeof json === 'object' && json !== null ? (json as { type?: unknown }).type : undefined
  if (!DEV_MESSAGE_TYPES.has(type)) return null
  if (type !== 'dev.tabs') return { msg: null, dropped: 1 }
  const envelope = DevTabsEnvelope.safeParse(json)
  if (!envelope.success) return { msg: null, dropped: 1 }
  const tabs: DevTab[] = []
  for (const row of envelope.data.tabs) {
    const tab = DevTabSchema.safeParse(row)
    if (tab.success) tabs.push(tab.data)
  }
  return { msg: { type: 'dev.tabs', tabs }, dropped: envelope.data.tabs.length - tabs.length }
}
