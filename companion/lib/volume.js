// The volume shown for a share whose volume went through YouTube's player. YouTube scales the
// element's volume by its loudness normalisation, so the element reads less than what was set:
// the worker keeps a hint, `{ element, value }`, of what the element read right after the set
// and what the user asked for.

/**
 * `state` with the volume the user set, as long as the element still has the volume it read
 * right after (`hint.element`). Once it differs, something else moved it (the page, a key): the
 * hint is dropped from `share` and the element's own volume shows from then on.
 */
export function withVolumeHint(share, state) {
  const hint = share.volumeHint
  if (!state || !hint) return state
  if (Math.abs(state.volume - hint.element) < 1e-3) return { ...state, volume: hint.value }
  share.volumeHint = null
  return state
}
