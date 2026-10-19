// When the worker should next ask whether its socket is still wanted.

/** Slack after the presence window ends, so the check lands past it rather than on its edge. */
export const IDLE_SLACK_MS = 100

/** Milliseconds until the presence window (`presenceUntil`, epoch ms) is over, plus the slack. */
export function idleDelay(presenceUntil, now) {
  return Math.max(0, presenceUntil - now) + IDLE_SLACK_MS
}
