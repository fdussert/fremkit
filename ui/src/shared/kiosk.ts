/**
 * Making a document stop behaving like a web page.
 *
 * The dashboard runs on a 2560×720 touch strip with no keyboard and no window chrome, and a long
 * press is one of its own gestures. WebKit answers a long press with its native context menu —
 * "Reload" on the bar, "Open Frame in New Window" inside a widget — and a drag selects text or
 * picks an image up. Every one of those is a way out of the kiosk with no way back.
 *
 * The helper turns the same things off on its `WKWebView`, which is the real defence; this is
 * what covers the plain-Chrome kiosk path, and a second layer under the helper. The widget
 * documents get the same treatment from `server/src/bridge/fremkit.js`, which cannot import
 * this: it is a plain browser script injected into a sandboxed iframe.
 */

/** The rules, as one stylesheet. Kept here so the bridge's copy can be compared against it. */
export const KIOSK_CSS = [
  'html{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;',
  '-webkit-tap-highlight-color:transparent;cursor:default}',
  'img,a{-webkit-user-drag:none}',
  '::-webkit-scrollbar{display:none}',
  ':focus{outline:none}',
].join('')

/** True when the document already carries the stylesheet, so a second call is a no-op. */
const MARKER = 'data-fremkit-kiosk'

export function applyKioskBehaviour(doc: Document): void {
  // The marker first: it guards the whole function, not just the stylesheet. Returning after the
  // listeners were registered meant a second call added a second pair of them, and the pair is
  // anonymous — nothing can ever take them off again.
  if (doc.querySelector(`style[${MARKER}]`)) return
  doc.addEventListener('contextmenu', (e) => e.preventDefault())
  doc.addEventListener('dragstart', (e) => e.preventDefault())
  const style = doc.createElement('style')
  style.setAttribute(MARKER, '')
  style.textContent = KIOSK_CSS
  const head = doc.head ?? doc.documentElement
  // First, so a page rule that wants selection back wins on order.
  head.insertBefore(style, head.firstChild)
}
