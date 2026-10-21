// What a Fremdev shot looks like in the tab it captured, as macOS's own screenshot does: a white
// flash over the viewport, then the shot's thumbnail in the bottom-right corner for 3 seconds.
//
// `shotOverlay` is handed to chrome.scripting.executeScript as `func`, so it is serialized and run
// on its own in the tab's isolated world (never the page's): it closes over nothing and imports
// nothing. It is built to owe the page nothing and to survive a strict CSP:
// - one host element on <html>, every property set `!important` through the CSSOM (a CSP that
//   refuses inline styles governs `style` attributes, not the CSSOM; a page's `!important` rule
//   loses to an inline `!important`), `all: initial` so nothing is inherited;
// - the rest inside a closed shadow root: page CSS cannot select it, page script cannot reach it;
// - no stylesheet, no <img>, no URL: the thumbnail's bytes are decoded here (createImageBitmap on a
//   Blob made from them) and painted on a <canvas>, so an `img-src 'self'` page shows it too;
// - the Web Animations API for the motion, and none of it under `prefers-reduced-motion`;
// - pointer-events none throughout, so the page under it keeps every click.
// The host is removed when the thumbnail has faded, or when the next shot replaces it.

/**
 * Draws the flash and, when `thumb` is a JPEG data URL, its thumbnail. Returns nothing the page
 * could read; throws nothing (a page that is not a document of ours, an image that does not decode:
 * the flash alone, or nothing).
 */
export async function shotOverlay(thumb) {
  /** How long the thumbnail stays, its fades included. */
  const HOLD_MS = 3000
  const KEY = '__fremkitShotOverlay'
  const scope = globalThis
  try {
    // A second shot within 3 s: the first one's overlay goes at once.
    if (typeof scope[KEY] === 'function') scope[KEY]()
  } catch { /* gone already */ }
  const root = document.documentElement
  if (!root) return

  const set = (el, props) => {
    for (const [name, value] of Object.entries(props)) el.style.setProperty(name, value, 'important')
  }
  const reduced = (() => {
    try {
      return matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return false
    }
  })()

  const host = document.createElement('fremkit-shot')
  set(host, {
    all: 'initial',
    display: 'block',
    position: 'fixed',
    inset: '0',
    width: '100vw',
    height: '100vh',
    margin: '0',
    padding: '0',
    border: '0',
    'z-index': '2147483647',
    'pointer-events': 'none',
    contain: 'strict',
    background: 'transparent',
    opacity: '1',
    transform: 'none',
    visibility: 'visible',
  })
  const shadow = host.attachShadow({ mode: 'closed' })
  const timers = []
  const remove = () => {
    for (const t of timers) clearTimeout(t)
    host.remove()
    if (scope[KEY] === remove) delete scope[KEY]
  }
  scope[KEY] = remove
  root.appendChild(host)

  if (!reduced) {
    const flash = document.createElement('div')
    // No `opacity` here: an `!important` one would beat the animation's (and the canvas's likewise).
    set(flash, { position: 'absolute', inset: '0', background: '#ffffff', 'pointer-events': 'none' })
    shadow.appendChild(flash)
    const fade = flash.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 150, easing: 'ease-out', fill: 'forwards' })
    fade.finished.then(() => flash.remove(), () => flash.remove())
  }

  const match = typeof thumb === 'string' ? /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(thumb) : null
  let bitmap = null
  if (match) {
    try {
      const binary = atob(match[1])
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
    } catch {
      bitmap = null
    }
  }
  if (scope[KEY] !== remove) return bitmap?.close?.()
  if (!bitmap) {
    // The flash alone: gone once it has faded.
    timers.push(setTimeout(remove, 200))
    return
  }

  // At most 240 CSS pixels on its long side, and never wider than a third of a narrow window.
  const long = Math.max(bitmap.width, bitmap.height)
  const side = Math.max(80, Math.min(240, Math.round(innerWidth / 3), long))
  const cssW = Math.round((bitmap.width / long) * side)
  const cssH = Math.round((bitmap.height / long) * side)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  bitmap.close?.()
  set(canvas, {
    display: 'block',
    position: 'absolute',
    right: '20px',
    bottom: '20px',
    width: `${cssW}px`,
    height: `${cssH}px`,
    margin: '0',
    padding: '0',
    border: '3px solid #ffffff',
    'border-radius': '8px',
    'box-sizing': 'content-box',
    'box-shadow': '0 10px 30px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.15)',
    background: '#ffffff',
    'pointer-events': 'none',
  })
  shadow.appendChild(canvas)

  if (reduced) {
    timers.push(setTimeout(remove, HOLD_MS))
    return
  }
  canvas.animate(
    [{ opacity: 0, transform: 'translateX(24px) scale(0.96)' }, { opacity: 1, transform: 'none' }],
    { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'both' },
  )
  timers.push(setTimeout(() => {
    const out = canvas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-in', fill: 'forwards' })
    out.finished.then(remove, remove)
  }, HOLD_MS - 300))
}
