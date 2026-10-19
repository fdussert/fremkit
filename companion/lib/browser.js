// What the extension calls the browser it runs in, for the pairing request: the name the user
// then sees on the Edge and in Appareils. Chromium browsers share one extension, so the brand
// list of `navigator.userAgentData` is what tells them apart.

const NAMES = [
  // The full name: the screen it is shown on is the Edge too.
  [/edge/i, 'Microsoft Edge'],
  [/opera/i, 'Opera'],
  [/brave/i, 'Brave'],
  // Arc and Vivaldi are not known to put their own brand in the list today (they report Chrome's
  // or Chromium's), so their users see "Chrome" or "Chromium". Kept for the day they do: the
  // output is always one of the server's names whatever the brands say.
  [/vivaldi/i, 'Vivaldi'],
  [/^arc$/i, 'Arc'],
  [/google chrome/i, 'Chrome'],
]

/** A short browser name from `navigator.userAgentData.brands`, `Chromium` when none is known. */
export function browserName(brands) {
  for (const [re, name] of NAMES) if ((brands ?? []).some((b) => re.test(b?.brand ?? ''))) return name
  return 'Chromium'
}
