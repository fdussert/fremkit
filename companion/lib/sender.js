// Who may talk to the worker and the offscreen document: the extension's own pages, nothing else.

/**
 * True when a `runtime.onMessage` sender is one of this extension's own contexts: its id, no tab
 * and a URL under the extension's base (`chrome.runtime.getURL('')`). Code the extension injects
 * into a page (`chrome.scripting`) carries the same id but the page's tab and URL, so it is
 * refused. `tabPages` lists the extension pages that open in a tab (the options page): such a
 * sender is accepted only when its URL, without query or fragment, is exactly one of them.
 */
export function isOwnContext(sender, { id, base, tabPages = [] }) {
  if (!sender || typeof id !== 'string' || !id || sender.id !== id) return false
  if (typeof base !== 'string' || !base || typeof sender.url !== 'string' || !sender.url.startsWith(base)) return false
  if (!sender.tab) return true
  return tabPages.includes(sender.url.split(/[?#]/)[0])
}
