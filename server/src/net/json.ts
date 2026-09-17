/**
 * Reading a JSON answer without trusting how big it is.
 *
 * `res.json()` reads to the end, whatever the end turns out to be. Every provider here talks to
 * something the user configured — a Homey on the LAN, a GitHub Enterprise host, a printer — so
 * the answer is not hostile by design, but it is not bounded by anything either: a misconfigured
 * host, a captive portal or a compromised device can hand back gigabytes and the poll will hold
 * all of it in memory before anything looks at it.
 *
 * The cap is generous. A page of GitHub notifications is tens of kilobytes; a Homey with a
 * hundred devices is a few hundred.
 */

/** Largest JSON answer a provider will read. */
export const MAX_JSON_BYTES = 4 * 1024 * 1024

export class JsonTooLargeError extends Error {
  constructor() {
    super('response too large')
    this.name = 'JsonTooLargeError'
  }
}

/**
 * Reads a response as JSON, giving up past `max` bytes.
 *
 * Refuses rather than truncating: half a JSON document is not a document, and a provider quietly
 * parsing one would be worse than an error it can report as `offline`.
 */
export async function readJsonCapped(res: Response, max: number = MAX_JSON_BYTES): Promise<unknown> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel().catch(() => {})
    throw new JsonTooLargeError()
  }
  const reader = res.body?.getReader()
  // No stream to read (a mocked Response in a test, an empty body): fall back to the whole text,
  // still checked against the cap.
  if (!reader) {
    const text = await res.text()
    if (Buffer.byteLength(text) > max) throw new JsonTooLargeError()
    return text === '' ? undefined : JSON.parse(text)
  }
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      void reader.cancel().catch(() => {})
      throw new JsonTooLargeError()
    }
    chunks.push(Buffer.from(value))
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? undefined : JSON.parse(text)
}
