import { describe, expect, it } from 'vitest'
import { JsonTooLargeError, MAX_JSON_BYTES, readJsonCapped } from '../src/net/json.js'

/** A streamed response, the way fetch gives one. */
const streamed = (body: string, headers: Record<string, string> = {}) =>
  new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(body)); c.close() },
  }), { headers })

describe('readJsonCapped', () => {
  it('reads an ordinary answer', async () => {
    expect(await readJsonCapped(streamed('{"a":1}'))).toEqual({ a: 1 })
    expect(await readJsonCapped(new Response('[1,2,3]'))).toEqual([1, 2, 3])
  })

  it('answers undefined for an empty body', async () => {
    expect(await readJsonCapped(new Response(''))).toBeUndefined()
  })

  it('refuses a body past the cap rather than truncating it', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(200) })
    await expect(readJsonCapped(streamed(big), 50)).rejects.toThrow(JsonTooLargeError)
  })

  it('refuses on the declared length without reading a byte', async () => {
    const res = streamed('{"a":1}', { 'content-length': String(MAX_JSON_BYTES + 1) })
    await expect(readJsonCapped(res)).rejects.toThrow(JsonTooLargeError)
  })

  it('refuses a body that lies about its length', async () => {
    // No content-length at all, so the cap has to be enforced while reading.
    await expect(readJsonCapped(streamed('x'.repeat(300)), 100)).rejects.toThrow(JsonTooLargeError)
  })

  it('still refuses a too-large body with no stream to read', async () => {
    await expect(readJsonCapped(new Response('x'.repeat(300)), 100)).rejects.toThrow(JsonTooLargeError)
  })

  it('propagates a parse failure, which the callers already handle', async () => {
    await expect(readJsonCapped(streamed('{ nope'))).rejects.toThrow()
  })
})
