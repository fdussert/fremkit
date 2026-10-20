// A screenshot as the browser hands it over: a `data:` URL from tabs.captureVisibleTab, turned
// into a Blob for the clipboard (the popup's Copy screenshot) or for the shot route (Task 9).

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
