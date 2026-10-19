// Strings come from _locales/{fr,en}/messages.json. Chrome fills `__MSG_key__` in the manifest
// only, so the pages carry the same placeholders and `localize` fills them at load.

/** The message for `key` in the browser's language, with `$1` replaced by `sub`. */
export const t = (key, sub) => chrome.i18n.getMessage(key, sub === undefined ? undefined : [String(sub)]) || key

const fill = (text) => text.replace(/__MSG_(\w+?)__/g, (_, key) => t(key))

/** Replaces every `__MSG_key__` in the page's text and in its title, alt and aria-label attributes. */
export function localize(doc = document) {
  doc.documentElement.lang = chrome.i18n.getUILanguage().split('-')[0]
  doc.title = fill(doc.title)
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue.includes('__MSG_')) node.nodeValue = fill(node.nodeValue)
  }
  for (const el of doc.querySelectorAll('[title], [alt], [aria-label]')) {
    for (const attr of ['title', 'alt', 'aria-label']) {
      const value = el.getAttribute(attr)
      if (value?.includes('__MSG_')) el.setAttribute(attr, fill(value))
    }
  }
}
