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

export const ExtensionMessageSchema = z.discriminatedUnion('type', [
  // The first message of a socket: which record to prove, and the nonce to prove it on.
  z.strictObject({ type: z.literal('challenge'), deviceId: Id, nonce: z.string().regex(NONCE_RE) }),
  // The one message that is not strict: a newer extension may say more in its hello (the spec
  // plans a `modules` list) and must still connect. Unknown keys are stripped, not refused.
  z.object({
    type: z.literal('hello'),
    token: Token,
    installId: Id,
    // Any integer: the server answers a version it does not speak with `tab.refused`.
    protocol: z.number().int(),
    session: z.strictObject({ sessionId: Id, meta: MetaSchema }).optional(),
  }),
  z.strictObject({ type: z.literal('tab.started'), sessionId: Id, meta: MetaSchema }),
  z.strictObject({ type: z.literal('tab.meta'), sessionId: Id, meta: MetaSchema }),
  z.strictObject({ type: z.literal('tab.offer'), sessionId: Id, receiverId: Id, sdp: Sdp }),
  z.strictObject({ type: z.literal('tab.stopped'), sessionId: Id }),
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
   * `modules`: which of the extension's modules this server has switched on, Fremplay alone so
   * far (`labs.companion`). Optional and new within protocol 2: an extension that does not read
   * it learns the same from `tab.refused` with `disabled`.
   */
  | { type: 'ready'; protocol: number; modules?: { fremplay: boolean } }
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

/** Null when the text is over the size limit, is not JSON, or is not one of the messages. */
export function parseExtensionMessage(raw: string): ExtensionMessage | null {
  if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = ExtensionMessageSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}
