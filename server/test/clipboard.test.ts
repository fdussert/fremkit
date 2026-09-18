import { describe, it, expect, vi } from 'vitest'
import {
  createClipboardProvider, isSecret, capText, previewOf, characterClasses, isPrivatePasteboard,
  MAX_ENTRIES, MAX_TEXT_BYTES, PREVIEW_CHARS, MASKED_PREVIEW, SECRET_MIN_LENGTH,
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
    expect(await p.commands!.clear(null, LOCAL)).toEqual({ ok: true, entries: [] })
    expect(((await p.poll!()) as ClipboardSnapshot).entries).toEqual([])
  })
  it('refuses a clear that did not come from this machine', async () => {
    // Emptying the history is acting on what the user's Mac has copied, exactly as `copy` is.
    const { pasteboard } = fake('one')
    const p = createClipboardProvider(pasteboard, now)
    await p.poll!()
    expect(await p.commands!.clear(null, { loopback: false })).toMatchObject({ ok: false })
    expect(((await p.poll!()) as ClipboardSnapshot).entries.map((e) => e.preview)).toEqual(['one'])
  })
  it('asks the pasteboard for its types once while the same concealed text sits on it', async () => {
    // `osascript -l JavaScript` with an AppKit import is 100–200 ms of CPU. A concealed reading is
    // not remembered as seen — a later, unconcealed copy of the same text is the user's to keep —
    // so without a throttle of its own the question was asked every second for as long as a
    // password manager left a password on the pasteboard: the very case it was written for.
    const { pasteboard } = fake('Tr0ub4dor&3')
    let asked = 0
    pasteboard.types = async () => { asked++; return ['org.nspasteboard.ConcealedType'] }
    const p = createClipboardProvider(pasteboard, now)
    expect(((await p.poll!()) as ClipboardSnapshot).entries).toEqual([])
    expect(((await p.poll!()) as ClipboardSnapshot).entries).toEqual([])
    expect(asked).toBe(1)
  })
  it('asks again once another concealed text replaces it', async () => {
    const { pasteboard, set } = fake('Tr0ub4dor&3')
    let asked = 0
    pasteboard.types = async () => { asked++; return ['org.nspasteboard.ConcealedType'] }
    const p = createClipboardProvider(pasteboard, now)
    await p.poll!()
    set('hunter2!A'); await p.poll!()
    expect(asked).toBe(2)
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

describe('what counts as a secret', () => {
  it('masks an ordinary password, which the length rule alone published in full', () => {
    // Eight to twenty characters with mixed classes: well under the 32 the old rule needed.
    for (const text of ['Tr0ub4dor&3', 'hunter2!A', 'S3cret.Pass', 'aB3dEf9h', 'Passw0rd']) {
      expect(isSecret(text), text).toBe(true)
    }
  })
  it('still masks a long unbroken run, whatever it is made of', () => {
    expect(isSecret('a'.repeat(SECRET_MIN_LENGTH))).toBe(true)
    expect(isSecret('ghp_' + 'x'.repeat(36))).toBe(true)
  })
  it('masks a text naming a credential, even with spaces', () => {
    for (const text of ['my password is x', 'Bearer abc', 'mot de passe: 1234', 'API key for prod']) {
      expect(isSecret(text), text).toBe(true)
    }
  })
  it('leaves prose and single words alone', () => {
    for (const text of ['Bonjour tout le monde', 'a note to self', 'chaussure', 'lowercaseword', 'hello']) {
      expect(isSecret(text), text).toBe(false)
    }
  })
  it('leaves an accented or capitalised word alone', () => {
    // `[^A-Za-z0-9]` counted the `è` of `problème` as a symbol, so every accented French word
    // scored two classes and was masked — as was any capitalised word of eight letters.
    for (const text of ['problème', 'Dashboard', 'événement', 'téléphone', 'Rétrospective',
      'Écran', 'Widget', 'Ordinateur']) {
      expect(isSecret(text), text).toBe(false)
    }
  })
  it('still masks a short token once it carries a digit or a third class', () => {
    for (const text of ['Passw0rd', 'aB3dEf9h', 'mot2passe', 'Été2026!']) {
      expect(isSecret(text), text).toBe(true)
    }
  })
  it('leaves a destination alone: a URL or an address is copied to go somewhere', () => {
    // These mix character classes, and masking every one of them would empty the widget of
    // everything useful.
    for (const text of ['https://example.com', 'www.example.com', 'example.com/path',
      'someone@example.com', 'mailto:someone@example.com', 'tel:+33123456789']) {
      expect(isSecret(text), text).toBe(false)
    }
  })
  it('still masks a destination long enough to be carrying a token', () => {
    expect(isSecret('https://example.com/reset?token=' + 'a'.repeat(40))).toBe(true)
  })
  it('counts the character classes a text draws on', () => {
    expect(characterClasses('abcdef')).toBe(1)
    expect(characterClasses('abcDEF')).toBe(2)
    expect(characterClasses('abcDEF123')).toBe(3)
    expect(characterClasses('abcDEF123!')).toBe(4)
    expect(characterClasses('')).toBe(0)
  })
})

describe('a pasteboard that asks not to be remembered', () => {
  const board = (text: string, types: string[]) => ({
    read: async () => text,
    write: async () => {},
    types: async () => types,
  })

  it('records nothing at all for a concealed pasteboard', async () => {
    for (const type of ['org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType',
      'org.nspasteboard.AutoGeneratedType']) {
      const p = createClipboardProvider(board('the password itself', ['public.utf8-plain-text', type]))
      const snapshot = await p.poll!() as { entries: unknown[] }
      // Not masked — absent. A password manager's copy is not ours to hold.
      expect(snapshot.entries, type).toEqual([])
    }
  })

  it('never records the text of a concealed pasteboard, nor remembers having seen it', async () => {
    // The text *is* read: knowing whether the pasteboard changed is what lets us skip the
    // expensive type question on an unchanged one, and that needs the bytes. It goes no further
    // than a local variable — never into the history, never published, never on disk.
    const read = vi.fn(async () => 'the password itself')
    const p = createClipboardProvider({ read, write: async () => {}, types: async () => ['org.nspasteboard.ConcealedType'] })
    expect((await p.poll!() as { entries: unknown[] }).entries).toEqual([])
    // And it is asked again next time rather than treated as already seen: a later copy of the
    // same text from somewhere that does not conceal it is the user's to keep.
    expect((await p.poll!() as { entries: unknown[] }).entries).toEqual([])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('records an ordinary pasteboard as before', async () => {
    const p = createClipboardProvider(board('Bonjour tout le monde', ['public.utf8-plain-text']))
    const snapshot = await p.poll!() as { entries: { preview: string }[] }
    expect(snapshot.entries.map((e) => e.preview)).toEqual(['Bonjour tout le monde'])
  })

  it('records as before on a machine that cannot answer the type question', async () => {
    // No `types` at all, and one that throws: both get the old behaviour, not an empty widget.
    // The rejection used to be caught by the same try as the read, which emptied the widget.
    const without = createClipboardProvider({ read: async () => 'plain text here', write: async () => {} })
    expect((await without.poll!() as { entries: unknown[] }).entries).toHaveLength(1)
    const throwing = createClipboardProvider({
      read: async () => 'plain text here', write: async () => {},
      types: async () => { throw new Error('osascript missing') },
    })
    expect((await throwing.poll!() as { entries: unknown[] }).entries).toHaveLength(1)
  })

  it('asks for the types only when the text on the pasteboard changed', async () => {
    // `osascript -l JavaScript` with an AppKit import is 100-200 ms of CPU, and this polls every
    // second for as long as the dashboard is up.
    let text = 'first thing'
    const types = vi.fn(async () => ['public.utf8-plain-text'])
    const p = createClipboardProvider({ read: async () => text, write: async () => {}, types })
    await p.poll!()
    expect(types).toHaveBeenCalledTimes(1)
    await p.poll!()
    await p.poll!()
    expect(types).toHaveBeenCalledTimes(1)
    text = 'something else'
    await p.poll!()
    expect(types).toHaveBeenCalledTimes(2)
  })

  it('does not ask for the types of an empty pasteboard', async () => {
    const types = vi.fn(async () => [])
    const p = createClipboardProvider({ read: async () => '   ', write: async () => {}, types })
    await p.poll!()
    expect(types).not.toHaveBeenCalled()
  })
})
