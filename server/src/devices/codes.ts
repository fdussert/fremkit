import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { expandIpv6 } from '../net/private.js'

/** No I, O, 0 or 1: a code is read off a screen and may be typed by hand. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 8
export const CODE_TTL_MS = 300_000
/**
 * The pairing secret: 256 random bits, base64url without padding, so 43 characters. It rides in the
 * QR code beside the code and pairs like it, but past the wrong-code limit (`consumeSecret`): a
 * guesser can hold the typed code at 429, never the QR. 2^256 values leave nothing to guess.
 */
export const SECRET_BYTES = 32
export const SECRET_LENGTH = 43
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/
/**
 * Wrong codes allowed per minute from one peer (`peerKey`). Five is a typing mistake or two with
 * room to spare; counted per peer so that one guesser does not, by itself, lock the real iPad out.
 */
export const MAX_WRONG_PER_MINUTE = 5
/**
 * Wrong codes allowed per minute from every peer together, per code: the ceiling that keeps a
 * guesser with many addresses from multiplying the per-peer allowance.
 *
 * The numbers: a code is 8 characters from 32, so 32^8 ≈ 1.1 × 10^12 values, and lives 5 minutes.
 * At 60 wrong guesses a minute at most 300 are ever tried against one code, a chance of about
 * 3 × 10^-10 of hitting it. The ceiling is what a guesser with many addresses (IPv4 aliases,
 * several link-local addresses or ULA prefixes, several machines) can still spend, holding pairing
 * at 429 for everyone while it keeps guessing. Issuing a new code resets it (`issue`), since a new
 * code is a new secret and the bound above is per code — but a guesser watching for the new code
 * spends the fresh total as fast, so that is no way out against one; it only ends a lock-out the
 * guesser has given up.
 */
export const MAX_WRONG_PER_MINUTE_TOTAL = 60

/**
 * Who a wrong guess is counted against: an IPv4 address (a mapped one read as the IPv4 it is), a
 * link-local IPv6 address as itself, or any other IPv6 address's /64.
 *
 * Why the /64: inside its own /64 one IPv6 host picks any address it likes (SLAAC privacy
 * addresses, as many as it cares to make), so counting per address would give one machine as
 * many allowances as it wants. The /64 is the smallest prefix a host does not control; the cost
 * is that the IPv6 peers of one segment share an allowance.
 *
 * Why not for link-local (fe80::/10): every link-local address on every link is in the same
 * fe80::/64, so keying it by /64 made one key for the whole network — a single guesser on the
 * link held pairing at 429 for an iPad coming in over link-local IPv6, which is what a `.local`
 * name usually resolves to. Keyed by address, one host can still make several link-local
 * addresses, and what bounds those is the total ceiling, as for IPv4 aliases. (The iPad also tries
 * the Mac's other addresses when one answers 429; see `PairClient`.)
 *
 * Something unreadable is counted under itself.
 */
export function peerKey(address: string): string {
  const ip = address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%[^%]*$/, '')
  if (!ip.includes(':')) return ip
  const groups = expandIpv6(ip)
  if (!groups) return ip
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >>> 8, groups[6] & 0xff, groups[7] >>> 8, groups[7] & 0xff].join('.')
  }
  if ((groups[0] & 0xffc0) === 0xfe80) return groups.map((g) => g.toString(16)).join(':')
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`
}

const WINDOW_MS = 60_000

export type ConsumeResult = 'ok' | 'wrong' | 'expired' | 'limited'

function same(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/** A count of wrong guesses in a minute that began with the first of them. */
class Window {
  start = 0
  wrong = 0
  roll(now: number): void {
    if (this.wrong > 0 && now - this.start >= WINDOW_MS) this.wrong = 0
  }
  add(now: number): void {
    if (this.wrong === 0) this.start = now
    this.wrong++
  }
}

/**
 * The pairing code shown on the Mac: one live code at a time, single use, five minutes long, with
 * the secret its QR code carries bound to it: issued with it, spent with it, dropped with it.
 *
 * Wrong guesses are counted per peer (`peerKey`) and in total. Once a peer's allowance is spent,
 * every attempt from it is refused — the right code included, or the limit would mean nothing —
 * until its minute is over; other peers go on. Once the total is spent, every attempt from
 * anyone is refused until that minute is over, or until a new code is issued. The QR code's secret
 * is the one exception (`consumeSecret`): the right one pairs whatever the counters say.
 */
export class PairingCodes {
  /** `proof` is what `consume` takes for the code: the code itself unless `issue` was told otherwise. */
  private live: { code: string; proof: string; secret: string; expiresAt: number } | null = null
  private readonly total = new Window()
  /**
   * Per peer. Bounded without a cap of its own: an entry is only made by a wrong guess the total
   * allowed, so at most `MAX_WRONG_PER_MINUTE_TOTAL` a minute, and spent ones are dropped.
   */
  private readonly peers = new Map<string, Window>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Issues a fresh code, replacing any live one. The total is reset with it (a new secret, a new
   * per-code bound); the per-peer windows are kept, so a guesser is not handed a fresh allowance.
   * `proofOf` turns the code into what a device sends for it (`codeProof`, bound to the Mac's key).
   */
  issue(proofOf: (code: string) => string = (code) => code): { code: string; secret: string; expiresAt: number } {
    this.total.wrong = 0
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    const secret = randomBytes(SECRET_BYTES).toString('base64url')
    this.live = { code, proof: proofOf(code), secret, expiresAt: this.now() + CODE_TTL_MS }
    return { code, secret, expiresAt: this.live.expiresAt }
  }

  /** True while a code is issued, unused and unexpired: the only time pairing is open at all. */
  hasLive(): boolean {
    return this.live !== null && this.now() <= this.live.expiresAt
  }

  /**
   * Pairs with the typed code, as the proof `issue`'s `proofOf` makes of it. `address` is the
   * address the attempt came from, as the socket reports it.
   */
  consume(proof: string, address = ''): ConsumeResult {
    const peer = peerKey(address)
    const now = this.now()
    this.roll(now)
    if (this.limited(peer)) return 'limited'
    if (this.live && same(proof, this.live.proof)) return this.spend(now)
    return this.count(peer, now)
  }

  /**
   * Pairs with the QR code's secret. The right secret is taken before the limit is looked at, so a
   * guesser holding codes at 429 does not keep the QR from pairing; a wrong one takes exactly the
   * wrong-code path (refused while limited, counted otherwise), so there is one way to fail.
   */
  consumeSecret(secret: string, address = ''): ConsumeResult {
    const now = this.now()
    this.roll(now)
    if (this.live && same(secret, this.live.secret)) return this.spend(now)
    const peer = peerKey(address)
    if (this.limited(peer)) return 'limited'
    return this.count(peer, now)
  }

  /** True while someone is being refused for guessing: one peer or everyone. */
  guessing(): boolean {
    this.roll(this.now())
    if (this.total.wrong >= MAX_WRONG_PER_MINUTE_TOTAL) return true
    for (const w of this.peers.values()) if (w.wrong >= MAX_WRONG_PER_MINUTE) return true
    return false
  }

  /** Drops the live code and its secret. The guess counters are kept, so clearing is no way around the limit. */
  clear(): void {
    this.live = null
  }

  private limited(peer: string): boolean {
    const own = this.peers.get(peer)
    return this.total.wrong >= MAX_WRONG_PER_MINUTE_TOTAL || (own !== undefined && own.wrong >= MAX_WRONG_PER_MINUTE)
  }

  /** Uses up the live code, and its secret with it: either one pairs once. */
  private spend(now: number): ConsumeResult {
    const live = this.live!
    this.live = null
    return now > live.expiresAt ? 'expired' : 'ok'
  }

  private count(peer: string, now: number): ConsumeResult {
    this.total.add(now)
    let window = this.peers.get(peer)
    if (!window) this.peers.set(peer, (window = new Window()))
    window.add(now)
    return 'wrong'
  }

  private roll(now: number): void {
    this.total.roll(now)
    for (const [peer, w] of this.peers) {
      w.roll(now)
      if (w.wrong === 0) this.peers.delete(peer)
    }
  }
}
