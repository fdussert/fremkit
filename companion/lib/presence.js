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
