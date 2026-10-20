// A screenshot as the browser hands it over: a `data:` URL from tabs.captureVisibleTab, turned
// into a Blob for the clipboard (the popup's Copy screenshot) or for the shot route (⌃⇧S).

const DATA_URL = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/

/** `data:image/(png|jpeg);base64,…` → Blob of that type. Throws on anything else. */
export function dataUrlBlob(dataUrl) {
  const match = typeof dataUrl === 'string' ? DATA_URL.exec(dataUrl) : null
  if (!match) throw new Error('not an image data URL')
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: match[1] })
}

/** The largest JPEG Fremkit's shot route takes (SHOT_MAX_BYTES on the server). */
export const SHOT_MAX_BYTES = 2_097_152
/** A shot drawn again is at most this wide or tall. */
const SHOT_MAX_SIDE = 1920
/** The JPEG qualities a shot drawn again tries, in order. */
const SHOT_QUALITIES = [0.85, 0.7, 0.5]

/**
 * The shot as the route takes it: `blob` itself when it fits in `maxBytes`, else the image drawn
 * again with its long side at most `maxSide`, as a JPEG at 0.85, then 0.7, then 0.5 — the first
 * that fits. Null when none does.
 */
export async function fitShot(blob, {
  maxBytes = SHOT_MAX_BYTES,
  maxSide = SHOT_MAX_SIDE,
  decode = (b) => createImageBitmap(b),
  canvas = (w, h) => new OffscreenCanvas(w, h),
} = {}) {
  if (blob.size <= maxBytes) return blob
  const image = await decode(blob)
  let surface
  try {
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height))
    const w = Math.max(1, Math.round(image.width * scale))
    const h = Math.max(1, Math.round(image.height * scale))
    surface = canvas(w, h)
    surface.getContext('2d').drawImage(image, 0, 0, w, h)
  } finally {
    image.close?.()
  }
  for (const quality of SHOT_QUALITIES) {
    const out = await surface.convertToBlob({ type: 'image/jpeg', quality })
    if (out.size <= maxBytes) return out
  }
  return null
}

/** The shot route's request: this install's token, no cookie, nothing cached. */
export function shotInit(blob, token) {
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' },
    body: blob,
    credentials: 'omit',
    cache: 'no-store',
  }
}

/** Chrome throws on a tab id that is not a non-negative integer. */
const validId = (id) => Number.isInteger(id) && id >= 0

/**
 * ⌃⇧S, the worker's half: the given tab, else the focused window's active one, captured and posted
 * to Fremkit's shot route for the Mac's clipboard. Only for a dev tab this install has a row for
 * (`isDevTab`), and only while the socket open now was greeted with Fremdev's yes (`canSend`): its
 * challenge proved the port is Fremkit, so the token goes to nobody else. Checked again after the
 * capture, which the socket may not have outlived. The key press is the activeTab grant the capture
 * needs. Flashes ✓ when the route answered 200, ! otherwise, and sends nothing on a refusal here.
 */
export async function shootTab(given, { activeTab, isDevTab, canSend, token, capture, fetch, url, flash, fit = fitShot }) {
  const tab = given ?? (await activeTab())
  if (!tab || !validId(tab.id) || !(await isDevTab(tab.id)) || !canSend() || !token()) return flash('!')
  try {
    const shot = await fit(dataUrlBlob(await capture(tab.windowId)))
    const bearer = token()
    if (!shot || !canSend() || !bearer) return flash('!')
    const res = await fetch(url, shotInit(shot, bearer))
    flash(res.status === 200 ? '✓' : '!')
  } catch {
    flash('!')
  }
}
