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
