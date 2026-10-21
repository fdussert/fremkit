// A screenshot as the browser hands it over: a `data:` URL from tabs.captureVisibleTab, turned
// into a Blob for the clipboard (the popup's Copy screenshot) or for the shot route (⌃⇧S), and the
// small thumbnail both paths show afterwards: in the tab (lib/shotview.js) and on the Edge (`dev.shot`).

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

/** The longest thumbnail `dev.shot` carries, data URL included (SHOT_THUMB_MAX on the server). */
export const THUMB_MAX_CHARS = 40_000
/** The long sides a thumbnail tries, then the JPEG qualities at each: the first that fits wins. */
const THUMB_SIDES = [320, 240, 160]
const THUMB_QUALITIES = [0.7, 0.5]
/**
 * A thumbnail as the server takes it: a JPEG (`/9j/` is FF D8 FF in base64), whole base64 quads.
 * The same rule as SHOT_THUMB_RE on the server.
 */
const THUMB_RE = /^data:image\/jpeg;base64,\/9j\/(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Whether `value` is a thumbnail `dev.shot` may carry. */
export const isThumb = (value) => typeof value === 'string' && value.length <= THUMB_MAX_CHARS && THUMB_RE.test(value)

/** A Blob as a `data:` URL of its own type, without FileReader (a service worker has it, a test has not). */
export async function blobDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  // In slices: String.fromCharCode takes its arguments on the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${blob.type};base64,${btoa(binary)}`
}

/**
 * The shot's thumbnail, made here so the page and the Edge never get the shot itself: the image
 * drawn with its long side at 320 pixels (never enlarged), as a JPEG at 0.7 then 0.5, then at 240 and
 * 160 pixels, the first whose data URL fits in `maxChars`. Null when none does or the image does
 * not decode.
 */
export async function thumbOf(blob, {
  maxChars = THUMB_MAX_CHARS,
  decode = (b) => createImageBitmap(b),
  canvas = (w, h) => new OffscreenCanvas(w, h),
  toDataUrl = blobDataUrl,
} = {}) {
  let image
  try {
    image = await decode(blob)
  } catch {
    return null
  }
  try {
    for (const side of THUMB_SIDES) {
      const scale = Math.min(1, side / Math.max(image.width, image.height))
      const w = Math.max(1, Math.round(image.width * scale))
      const h = Math.max(1, Math.round(image.height * scale))
      const surface = canvas(w, h)
      surface.getContext('2d').drawImage(image, 0, 0, w, h)
      for (const quality of THUMB_QUALITIES) {
        const url = await toDataUrl(await surface.convertToBlob({ type: 'image/jpeg', quality }))
        if (url.length <= maxChars && THUMB_RE.test(url)) return url
      }
    }
    return null
  } catch {
    return null
  } finally {
    image.close?.()
  }
}

/**
 * After a shot reached the clipboard, by either path: the thumbnail shown in the tab (`inject`,
 * lib/shotview.js in the isolated world), then sent to the Edge (`tellEdge`, which sends `dev.shot`
 * only where the server took Fremdev's word for it). `thumb` null: the tab still flashes, and the Edge
 * still says it was copied. Neither may fail the shot: it is on the clipboard already, and the
 * badge has said so.
 */
export async function shotFeedback(tabId, thumb, { inject, tellEdge, sound }) {
  const shown = isThumb(thumb) ? thumb : null
  await Promise.resolve().then(() => inject(tabId, shown)).catch(() => undefined)
  const loud = await Promise.resolve().then(sound).then((v) => v === true, () => false)
  await Promise.resolve().then(() => tellEdge(tabId, shown, loud)).catch(() => undefined)
}

/** How long a shot waits for the last shot's thumbnail to leave the tab before it captures anyway. */
export const CLEAR_WAIT_MS = 300

/**
 * Takes the last shot's thumbnail out of the tab before the next capture, so the feedback never ends
 * up in the image it confirms (macOS leaves its own out too). `run` removes it; a tab that makes it
 * wait (a hung page) or refuses it costs at most `waitMs`, and the capture goes ahead.
 */
export async function clearBeforeCapture(run, { waitMs = CLEAR_WAIT_MS, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  await Promise.race([Promise.resolve().then(run).catch(() => undefined), wait(waitMs)])
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
 * Before the capture, `before(tabId)` takes a previous shot's thumbnail out of the tab; after a 200,
 * `after(tabId, shot)` shows this one (`shotFeedback`). Neither is the shot's outcome.
 */
export async function shootTab(given, { activeTab, isDevTab, canSend, token, capture, fetch, url, flash, fit = fitShot, before = async () => undefined, after = async () => undefined }) {
  const tab = given ?? (await activeTab())
  if (!tab || !validId(tab.id) || !(await isDevTab(tab.id)) || !canSend() || !token()) return flash('!')
  try {
    await Promise.resolve().then(() => before(tab.id)).catch(() => undefined)
    const shot = await fit(dataUrlBlob(await capture(tab.windowId)))
    const bearer = token()
    if (!shot || !canSend() || !bearer) return flash('!')
    const res = await fetch(url, shotInit(shot, bearer))
    const ok = res.status === 200
    flash(ok ? '✓' : '!')
    if (ok) await Promise.resolve().then(() => after(tab.id, shot)).catch(() => undefined)
  } catch {
    flash('!')
  }
}
