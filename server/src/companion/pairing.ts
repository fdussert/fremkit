import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { CODE_ALPHABET } from '../devices/codes.js'
import type { DeviceStore } from '../devices/store.js'
import { pairClientMac, pairKey, pairServerMac, sameMac } from './pairProof.js'
import { shortExtensionId } from './protocol.js'
import { PairingLock } from './lock.js'

/** Short enough to type from the Edge at a glance. */
export const MATCH_CODE_LENGTH = 4
/** Wrong codes one request survives: the third refuses it. */
export const MAX_WRONG_CODES = 3
export const REQUEST_TTL_MS = 120_000
/** Requests accepted per minute, from every extension together. */
export const MAX_REQUESTS_PER_MINUTE = 5
/** Requests accepted per minute from one install, on top of the global count. */
export const MAX_REQUESTS_PER_INSTALL_PER_MINUTE = 3
/** How long an install whose request was refused is turned away. */
export const REFUSED_COOLDOWN_MS = 60_000

const WINDOW_MS = 60_000
/** Distinct installs counted as turned away while one request waits; past it the count stops. */
export const MAX_TURNED_AWAY = 99

type Answerable = { result: 'notFound' | 'changed' } | { req: PairRequest }

/** Compares two codes in a time that does not depend on where they differ. */
function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Why a request was not taken. `locked`: too many wrong codes, until the user unlocks (lock.ts). */
export type RequestRefusal = 'limited' | 'busy' | 'cooldown' | 'locked'

/** `changed`: the request on show is not the one answered, or the code given is not its code. */
export type AnswerResult = 'ok' | 'notFound' | 'changed'

export type CollectResult = { state: 'pending' | 'refused' | 'expired' }

/**
 * The answer to the extension's proof of the code (see pairProof.ts): `paired` with the server's
 * own proof and the token, once; `wrong` when its mac is not the code's; `exhausted` when that
 * wrong one was the last try, which refuses the request.
 */
export type ConfirmResult =
  | { state: 'paired'; nonce: string; mac: string; token: string; deviceId: string }
  | { state: 'wrong' | 'exhausted' | 'refused' | 'expired' }

interface PairRequest {
  requestId: string
  code: string
  name: string
  origin: string
  installId: string
  expiresAt: number
  /** `pairing` while the device record is being written; the extension is told `pending`. */
  state: 'pending' | 'pairing' | 'refused'
  /** K(code), derived when the request is made, so the proof is answered at once. */
  key: Promise<Buffer>
  wrong: number
}

/**
 * A browser extension asking to pair, and the user's answer.
 *
 * One request waits for an answer at a time, and nothing else takes its place: a new request from
 * the same install replaces it (the extension asking again after its popup reopened), one from any
 * other install is turned away as `busy` until the waiting one is answered or expires. The code is
 * shown on the Edge and in the admin, never sent to the extension: the user types it there, and
 * that is the approval. The extension then proves it (`confirm`, see pairProof.ts) and gets its
 * token in the answer. Three wrong codes, and the request is refused. Refusing on
 * the Edge names the code it was shown for, so a request swapped in after the user read the code
 * is never the one refused; a refused request is kept until it expires, two minutes after it was
 * made, so the extension can collect the answer.
 *
 * Requests are counted globally, like wrong pairing codes: an origin is only a name the asker
 * picks, so a per-origin count would limit nothing. The per-install count and the cooldown after a
 * refusal only keep one honest extension from hammering; a local process can pick any install id,
 * and what protects the user is that only the Edge shows the code.
 *
 * Nothing here logs: the code and the token are secrets, and the routes log the events.
 */
export class CompanionPairing {
  private readonly requests = new Map<string, PairRequest>()
  private waiting: string | null = null
  private accepted: number[] = []
  private readonly acceptedByInstall = new Map<string, number[]>()
  /** installId → when its request was refused. */
  private readonly refusedAt = new Map<string, number>()
  /**
   * The installs turned away as `busy` while a request waits. Shown with it: a request that sits
   * on the slot while other browsers ask is one the user may not have made. Only the user's answer
   * clears it: a request that replaces itself, or one that takes the slot after an expiry, keeps
   * the count, so a squatter cannot wipe the signal by posting again. Nor does it outlive the
   * episode: once nothing has waited for `REQUEST_TTL_MS`, it goes, so a request the user makes
   * days later is not shown with browsers turned away from an old one.
   */
  private turnedAway = new Set<string>()
  /** Since when no request waits, after the waiting one expired; null while one waits or was answered. */
  private idleSince: number | null = null
  private readonly listeners = new Set<() => void>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly store: DeviceStore,
    private readonly now: () => number = () => Date.now(),
    /** In memory only unless given one with a file (`createCompanion` does). */
    private readonly lock: PairingLock = new PairingLock(null),
  ) {}

  /** True while pairing is locked after too many wrong codes. */
  get locked(): boolean {
    return this.lock.locked
  }

  /** The user's Unlock in Settings → Devices. */
  async unlock(): Promise<void> {
    await this.lock.unlock()
    this.changed()
  }

  /** `salt`: the extension's random `saltE`, which salts K(code) with the request id (pairProof.ts). */
  request(input: { origin: string; name: string; installId: string; salt: string }): { requestId: string; code: string; expiresAt: number } | RequestRefusal {
    const now = this.now()
    this.sweep(now)
    if (this.lock.locked) return 'locked'
    const refused = this.refusedAt.get(input.installId)
    if (refused !== undefined && now - refused < REFUSED_COOLDOWN_MS) return 'cooldown'
    const waiting = this.waiting === null ? undefined : this.requests.get(this.waiting)
    if (waiting && (waiting.installId !== input.installId || waiting.origin !== input.origin)) {
      const before = this.turnedAway.size
      if (before < MAX_TURNED_AWAY) this.turnedAway.add(`${input.origin} ${input.installId}`)
      if (this.turnedAway.size !== before) this.changed()
      return 'busy'
    }
    this.accepted = this.accepted.filter((t) => now - t < WINDOW_MS)
    if (this.accepted.length >= MAX_REQUESTS_PER_MINUTE) return 'limited'
    const mine = (this.acceptedByInstall.get(input.installId) ?? []).filter((t) => now - t < WINDOW_MS)
    if (mine.length >= MAX_REQUESTS_PER_INSTALL_PER_MINUTE) return 'limited'
    this.accepted.push(now)
    mine.push(now)
    this.acceptedByInstall.set(input.installId, mine)

    // Only ever the same install's own request: another install's was turned away above.
    if (waiting) this.requests.delete(waiting.requestId)
    let code = ''
    for (let i = 0; i < MATCH_CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    const requestId = randomUUID()
    // Started now, ready long before anybody has typed four characters (~50 ms here).
    const key = pairKey(code, requestId, input.salt)
    key.catch(() => { /* surfaces on `confirm` */ })
    const req: PairRequest = {
      requestId,
      code,
      name: input.name,
      origin: input.origin,
      installId: input.installId,
      expiresAt: now + REQUEST_TTL_MS,
      state: 'pending',
      key,
      wrong: 0,
    }
    this.requests.set(req.requestId, req)
    this.waiting = req.requestId
    this.idleSince = null
    this.armTimer()
    this.changed()
    return { requestId: req.requestId, code: req.code, expiresAt: req.expiresAt }
  }

  /**
   * The request waiting for the user's answer, for the Edge and the admin to show, with how many
   * other installs were turned away since the user last answered one (at most `MAX_TURNED_AWAY`),
   * and the first characters of the asking extension's id (`extension`).
   */
  pending(): { requestId: string; code: string; name: string; extension: string; expiresAt: number; turnedAway: number } | null {
    this.sweep(this.now())
    const req = this.waiting === null ? undefined : this.requests.get(this.waiting)
    return req
      ? { requestId: req.requestId, code: req.code, name: req.name, extension: shortExtensionId(req.origin), expiresAt: req.expiresAt, turnedAway: this.turnedAway.size }
      : null
  }

  /**
   * The extension's proof that the user typed the Edge's code: `macE` over the request id and its
   * nonce, under K(code). The client proves first, so whatever made the request learns only
   * whether its guess was right: one online guess per try, three tries. A right one pairs the
   * extension and answers the server's own proof, `macS` over both nonces, with the token; the
   * extension takes the token only if that proof checks and came back within two seconds.
   */
  async confirm(requestId: string, origin: string, nonceE: string, macE: string): Promise<ConfirmResult> {
    this.sweep(this.now())
    const req = this.requests.get(requestId)
    if (!req || req.origin !== origin) return { state: req ? 'refused' : 'expired' }
    if (req.state !== 'pending') return { state: req.state === 'refused' ? 'refused' : 'expired' }
    const key = await req.key
    // Refused, or paired by a proof that got here first, while K was read.
    const now = req.state as PairRequest['state']
    if (now !== 'pending') return { state: now === 'refused' ? 'refused' : 'expired' }
    if (!sameMac(macE, pairClientMac(key, requestId, nonceE))) {
      req.wrong += 1
      if (req.wrong >= MAX_WRONG_CODES) {
        this.kill(req)
        // Counted across requests too: a guesser that asks again and again ends up locked out.
        if (await this.lock.noteExhausted(this.now())) this.changed()
        return { state: 'exhausted' }
      }
      return { state: 'wrong' }
    }
    // Off the waiting slot before the record is written, so neither a refuse nor a second right
    // proof can race this one.
    req.state = 'pairing'
    this.waiting = null
    this.turnedAway = new Set()
    try {
      const { device, token } = await this.store.createExtension({ name: req.name, origin: req.origin, installId: req.installId })
      const nonceS = randomBytes(32).toString('base64url')
      return { state: 'paired', nonce: nonceS, mac: pairServerMac(key, requestId, nonceE, nonceS), token, deviceId: device.id }
    } finally {
      this.requests.delete(requestId)
      this.changed()
    }
  }

  /** Refuses the waiting request if `code` is the one it shows; its install waits a minute to ask again. */
  refuse(requestId: string, code: unknown): AnswerResult {
    const found = this.answerable(requestId, code)
    if ('result' in found) return found.result
    this.kill(found.req)
    this.turnedAway = new Set()
    return 'ok'
  }

  /** Refuses a request: the Edge's Refuse, or the code tried too often. Its install waits a minute. */
  private kill(req: PairRequest): void {
    req.state = 'refused'
    if (this.waiting === req.requestId) {
      this.waiting = null
      this.idleSince = this.now()
    }
    this.refusedAt.set(req.installId, this.now())
    this.changed()
  }

  /** False when the request exists and was made from another origin. */
  belongsTo(requestId: string, origin: string): boolean {
    const req = this.requests.get(requestId)
    return req === undefined || req.origin === origin
  }

  /**
   * Where a request stands, for the origin that made it: waiting, refused, or (unknown, replaced,
   * paired or expired) `expired`. Another origin is refused and leaves the request as it was. The
   * token never comes from here: only `finish` hands it out.
   */
  collect(requestId: string, origin: string): CollectResult {
    this.sweep(this.now())
    const req = this.requests.get(requestId)
    if (!req) return { state: 'expired' }
    if (req.origin !== origin) return { state: 'refused' }
    return { state: req.state === 'refused' ? 'refused' : 'pending' }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** Stops the expiry timer. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private answerable(requestId: string, code: unknown): Answerable {
    this.sweep(this.now())
    const waiting = this.waiting === null ? undefined : this.requests.get(this.waiting)
    if (!waiting || waiting.state !== 'pending') return { result: 'notFound' }
    if (waiting.requestId !== requestId || typeof code !== 'string' || !sameCode(code, waiting.code)) return { result: 'changed' }
    return { req: waiting }
  }

  /** Drops every expired request, and says so once when there was any. */
  private sweep(now: number): void {
    let dropped = false
    for (const [id, req] of this.requests) {
      // A pairing still writing its record is left alone: `confirm` drops it once written.
      if (req.state !== 'pairing' && now >= req.expiresAt) {
        this.requests.delete(id)
        if (this.waiting === id) {
          this.waiting = null
          this.idleSince = req.expiresAt
        }
        dropped = true
      }
    }
    // Nothing waited for a whole request's life: the browsers turned away belong to another time.
    if (this.waiting === null && this.idleSince !== null && now - this.idleSince >= REQUEST_TTL_MS) {
      this.turnedAway = new Set()
      this.idleSince = null
    }
    for (const [installId, at] of this.refusedAt) if (now - at >= REFUSED_COOLDOWN_MS) this.refusedAt.delete(installId)
    for (const [installId, times] of this.acceptedByInstall) {
      if (times.every((t) => now - t >= WINDOW_MS)) this.acceptedByInstall.delete(installId)
    }
    if (dropped) this.changed()
  }

  /** Notices the waiting request's expiry without waiting for somebody to ask. */
  private armTimer(): void {
    this.dispose()
    this.timer = setTimeout(() => {
      this.timer = null
      this.sweep(this.now())
    }, REQUEST_TTL_MS + 50)
    this.timer.unref()
  }

  private changed(): void {
    for (const cb of this.listeners) {
      try {
        cb()
      } catch {
        // A listener's failure is its own; the others still hear about the change.
      }
    }
  }
}
