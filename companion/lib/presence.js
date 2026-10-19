// When the worker should next ask whether its socket is still wanted.

/** Slack after the presence window ends, so the check lands past it rather than on its edge. */
export const IDLE_SLACK_MS = 100

/** Milliseconds until the presence window (`presenceUntil`, epoch ms) is over, plus the slack. */
export function idleDelay(presenceUntil, now) {
  return Math.max(0, presenceUntil - now) + IDLE_SLACK_MS
}

/**
 * Whether only Fremdev wants the socket: no share and no popup's presence window. Such attempts
 * stay quiet: they never put a warning on the badge (the popup's own attempt does, when opened).
 */
export function onlyFremdev(share, presenceUntil, now) {
  return !share && now >= presenceUntil
}

/** At most one pass per `ms`: Fremdev's reconnections, however many dev events ask. */
export class ReconnectGate {
  constructor(ms) {
    this.ms = ms
    this.last = -Infinity
  }

  allow(now) {
    if (now - this.last < this.ms) return false
    this.last = now
    return true
  }
}

/** Answers that Fremdev is unsupported or off, in a row, before the probes slow down. */
export const PROBE_MISSES = 3
/** How often a server that keeps saying no is asked again. */
export const PROBE_SLOW_MS = 5 * 60_000

/**
 * Fremdev's probes of a server that said it does not speak Fremdev, or has it off: each one opens a
 * socket, which a Fremplay tile shows (offline, then idle). After PROBE_MISSES such answers in a
 * row, at most one probe per PROBE_SLOW_MS. `yes`, or `reset()` (the popup opened), starts over.
 * Only answers count: a server that does not answer leaves this alone.
 */
export class ProbeBackoff {
  constructor(misses = PROBE_MISSES, slowMs = PROBE_SLOW_MS) {
    this.limit = misses
    this.slowMs = slowMs
    this.misses = 0
    this.last = -Infinity
  }

  /** A server's `ready`, as `fremdevSupport` reads it. */
  heard(support) {
    if (support === 'yes') this.reset()
    else if (support === 'unsupported' || support === 'disabled') this.misses += 1
  }

  reset() {
    this.misses = 0
    this.last = -Infinity
  }

  /** Whether a probe may go now. */
  allow(now) {
    return this.misses < this.limit || now - this.last >= this.slowMs
  }

  /** A probe went. */
  probed(now) {
    this.last = now
  }
}

/**
 * Whether the badge shows the `!`. The link state is the truth for the popup; an `unreachable` that
 * only Fremdev's own attempts met (`linkQuiet`) stays off the badge, and a share waiting for the
 * server to come back keeps showing itself.
 */
export function linkAlarm({ link, share, linkQuiet }) {
  if (['revoked', 'refused', 'impostor'].includes(link)) return true
  return link === 'unreachable' && !share && !linkQuiet
}
