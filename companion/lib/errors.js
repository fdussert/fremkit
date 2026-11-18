// The message key the popup shows for each error a start or a share can end with (`lastError`),
// and what it shows while Fremkit says Fremplay is off. The worker stores the codes; only the
// popup turns them into words, in the browser's language (_locales).

export const SHARE_ERRORS = {
  noVideo: 'noVideo',
  noWidget: 'errNoWidget',
  disabled: 'errDisabled',
  offerRefused: 'errOfferRefused',
  protocol: 'errProtocol',
  unreachable: 'errUnreachable',
  capture: 'errCapture',
  unpaired: 'errUnpaired',
  noVideoLeft: 'errNoVideoLeft',
  needsPermission: 'errNeedsPermission',
  failed: 'errFailed',
}

/** The message key for an error code; an unknown one reads as a plain failure. */
export function shareErrorKey(code) {
  return Object.hasOwn(SHARE_ERRORS, code) ? SHARE_ERRORS[code] : SHARE_ERRORS.failed
}

/**
 * What the Fremplay card says before anything is tried, and whether Send is greyed: Fremkit said
 * Fremplay is off (`fremplayOff`, from its `ready` or a `disabled` refusal). Null otherwise.
 */
export function fremplayBlocked(session) {
  return session?.fremplayOff === true ? { error: 'disabled', key: SHARE_ERRORS.disabled } : null
}

/**
 * What the worker stores when Fremkit says whether Fremplay is on (`ready.modules`): the flag, and,
 * with Fremplay back on, no "turned off" left as the last error for the popup to show on its next
 * open. Null when nothing changes.
 */
export function fremplaySwitch(session, off) {
  const patch = {}
  if ((session?.fremplayOff === true) !== off) patch.fremplayOff = off
  if (!off && session?.lastError === 'disabled') patch.lastError = null
  return Object.keys(patch).length > 0 ? patch : null
}

/**
 * The pairing error to store for a refused `POST /api/companion/pair` (`pairError`), or null for
 * another status. Each refusal names its reason; one this version does not know reads as the
 * status's usual one.
 *
 * - 409 `busy`: another extension's request waits on the Edge. `unseen`: nobody on the Mac could
 *   see the code (no dashboard on screen, Settings → Devices shut); Fremkit 0.5.1 and later.
 *   `disabled`: a 0.5.0 server with the companion switched off.
 * - 423 `locked`: pairing locked after too many wrong codes.
 * - 429 `limited`: too many requests; `cooldown`: refused a moment ago.
 */
const PAIR_REFUSALS = {
  409: { known: ['busy', 'unseen', 'disabled'], fallback: 'busy' },
  423: { known: ['locked'], fallback: 'locked' },
  429: { known: ['limited', 'cooldown'], fallback: 'limited' },
}

export function pairRefusal(status, reason) {
  const refusal = PAIR_REFUSALS[status]
  if (!refusal) return null
  return refusal.known.includes(reason) ? reason : refusal.fallback
}
