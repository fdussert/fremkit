import { describe, it, expect, vi } from 'vitest'
import {
  createClipboardProvider, isSecret, capText, previewOf,
  MAX_ENTRIES, MAX_TEXT_BYTES, PREVIEW_CHARS, MASKED_PREVIEW,
  type ClipboardSnapshot, type Pasteboard,
} from '../src/providers/clipboard.js'

const LOCAL = { loopback: true }

/** A pasteboard whose content the test sets, and whose writes it inspects. */
function fake(initial = '') {
  let content = initial
  const written: string[] = []
  const pasteboard: Pasteboard = {
    read: async () => content,
    write: async (text) => { written.push(text); content = text },
  }
  return { pasteboard, written, set: (t: string) => { content = t } }
}

let clock = 1_000
const now = () => (clock += 1000)

describe('clipboard masking', () => {
  it('masks a long unbroken run', () => {
    expect(isSecret('a'.repeat(32))).toBe(true)
    expect(isSecret('a'.repeat(31))).toBe(false)
    expect(isSecret('a'.repeat(40) + ' ' + 'b'.repeat(40))).toBe(false)
  })
  it('masks a text that names a secret, whatever its case', () => {
    for (const text of ['my PASSWORD is x', 'the secret sauce', 'Authorization: Bearer x', 'BEGIN RSA PRIVATE KEY', 'sk-123', 'ghp_123']) {
      expect(isSecret(text), text).toBe(true)
    }
    expect(isSecret('hello world')).toBe(false)
  })
  it('replaces the preview of a masked entry and truncates the others', () => {
    expect(previewOf('x'.repeat(200), true)).toBe(MASKED_PREVIEW)
    expect(previewOf('x'.repeat(200), false)).toHaveLength(PREVIEW_CHARS)
  })
  it('caps the stored text', () => {
    expect(Buffer.byteLength(capText('x'.repeat(5000)))).toBe(MAX_TEXT_BYTES)
    expect(Buffer.byteLength(capText('é'.repeat(5000)))).toBeLessThanOrEqual(MAX_TEXT_BYTES)
    expect(capText('short')).toBe('short')
  })
})

describe('clipboard history', () => {
  it('publishes previews, never the text, and masks what looks like a secret', async () => {
    const { pasteboard, set } = fake('hello world')
    const p = createClipboardProvider(pasteboard, now)
    await p.poll!()
    set('ghp_' + 'a'.repeat(36))
    const snap = await p.poll!() as ClipboardSnapshot
    expect(snap.entries.map((e) => [e.preview, e.masked])).toEqual([[MASKED_PREVIEW, true], ['hello world', false]])
    expect(JSON.stringify(snap)).not.toContain('ghp_a')
    for (const e of snap.entries) expect(Object.keys(e).sort()).toEqual(['at', 'id', 'masked', 'preview'])
  })
  it('ignores an unchanged pasteboard and an empty one', async () => {
    const { pasteboard, set } = fake('one')
    const p = createClipboardProvider(pasteboard, now)
    await p.poll!()
    await p.poll!()
    set('   ')
    const snap = await p.poll!() as ClipboardSnapshot
    expect(snap.entries).toHaveLength(1)
  })
  it('moves an entry copied again back to the front instead of duplicating it', async () => {
    const { pasteboard, set } = fake('one')
    const p = createClipboardProvider(pasteboard, now)
    await p.poll!()
    set('two'); await p.poll!()
    set('one'); const snap = await p.poll!() as ClipboardSnapshot
    expect(snap.entries.map((e) => e.preview)).toEqual(['one', 'two'])
    expect(snap.entries).toHaveLength(2)
  })
  it('keeps only the newest MAX_ENTRIES, newest first', async () => {
    const { pasteboard, set } = fake()
    const p = createClipboardProvider(pasteboard, now)
    for (let i = 0; i < MAX_ENTRIES + 5; i++) { set(`entry ${i}`); await p.poll!() }
    const snap = await p.poll!() as ClipboardSnapshot
    expect(snap.entries).toHaveLength(MAX_ENTRIES)
    expect(snap.entries[0].preview).toBe(`entry ${MAX_ENTRIES + 4}`)
    expect(snap.entries.at(-1)!.preview).toBe('entry 5')
    expect(snap.entries.map((e) => e.at)).toEqual([...snap.entries].sort((a, b) => b.at - a.at).map((e) => e.at))
  })
})

describe('clipboard commands', () => {
  it('copy puts the full text back, even for a masked entry', async () => {
    const secret = 'sk-' + 'z'.repeat(40)
    const { pasteboard, written, set } = fake(secret)
    const p = createClipboardProvider(pasteboard, now)
    await p.poll!()
    set('something else'); await p.poll!()
    const snap = await p.poll!() as ClipboardSnapshot
    const masked = snap.entries.find((e) => e.masked)!
    expect(await p.commands!.copy({ id: masked.id }, LOCAL)).toEqual({ ok: true })
    expect(written).toEqual([secret])
  })
  it('copy refuses an unknown id, a bad payload and a remote caller', async () => {
    const { pasteboard, written } = fake('one')
    const p = createClipboardProvider(pasteboard, now)
    await p.poll!()
    expect(await p.commands!.copy({ id: 'nope' }, LOCAL)).toMatchObject({ ok: false })
    expect(await p.commands!.copy({}, LOCAL)).toMatchObject({ ok: false })
    expect(await p.commands!.copy({ id: '1' }, { loopback: false })).toMatchObject({ ok: false })
    expect(await p.commands!.copy({ id: '1' })).toMatchObject({ ok: false })
    expect(written).toEqual([])
  })
  it('copy does not reorder the list it was tapped in', async () => {
    const { pasteboard, set } = fake('one')
    const p = createClipboardProvider(pasteboard, now)
    await p.poll!()
    set('two'); await p.poll!()
    await p.commands!.copy({ id: '1' }, LOCAL)
    expect(((await p.poll!()) as ClipboardSnapshot).entries.map((e) => e.preview)).toEqual(['two', 'one'])
  })
  it('clear empties the history and the current pasteboard does not come back', async () => {
    const { pasteboard } = fake('one')
    const p = createClipboardProvider(pasteboard, now)
    await p.poll!()
    expect(await p.commands!.clear(null)).toEqual({ ok: true, entries: [] })
    expect(((await p.poll!()) as ClipboardSnapshot).entries).toEqual([])
  })
  it('drops everything when the last subscriber leaves', async () => {
    const { pasteboard } = fake('one')
    const p = createClipboardProvider(pasteboard, now)
    await p.poll!()
    p.stop!()
    expect(((await p.poll!()) as ClipboardSnapshot).entries.map((e) => e.preview)).toEqual(['one'])
  })
  it('survives an unreadable pasteboard', async () => {
    const read = vi.fn(async () => { throw new Error('no text') })
    const p = createClipboardProvider({ read, write: async () => {} }, now)
    expect(await p.poll!()).toEqual({ entries: [] })
  })
})
