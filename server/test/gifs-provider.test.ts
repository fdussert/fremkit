import { describe, expect, it, vi } from 'vitest'
import type { Config, GifBoard } from '../src/config/schema.js'
import { GIF_PASTE_SCRIPT, writeGifToPasteboard } from '../src/gifs/pasteboard.js'
import { createGifBoardProvider, gifSnapshot } from '../src/gifs/provider.js'
import { GifFetchError, type GifStore } from '../src/gifs/store.js'
import { tr } from '../src/i18n.js'

const LOCAL = { loopback: true, paired: false }
const LINK = 'https://example.com/party.gif'

const board: GifBoard = {
  groups: [{
    id: 'grp001',
    name: 'Reactions',
    items: [
      { id: 'item01', kind: 'giphy', giphyId: 'abc', label: 'Yes' },
      { id: 'item02', kind: 'link', url: LINK },
    ],
  }],
}

/** The provider reads `gifs` and nothing else. */
function configWith(gifs?: GifBoard): Config {
  return { gifs } as Config
}

function fakeStore(overrides: Partial<Record<'tempCopy' | 'ensureCached' | 'isCached' | 'prune' | 'sweepTemp', ReturnType<typeof vi.fn>>> = {}) {
  const fake = {
    tempCopy: vi.fn(async (id: string) => `/tmp/gifs/tmp/${id}.gif`),
    ensureCached: vi.fn(async () => '/data/gifs/cache/hash.gif'),
    isCached: vi.fn(async () => true),
    prune: vi.fn(async () => {}),
    sweepTemp: vi.fn(async () => {}),
    ...overrides,
  }
  return fake as typeof fake & GifStore
}

function setup(opts: { gifs?: GifBoard; store?: ReturnType<typeof fakeStore>; now?: () => number } = {}) {
  let config = configWith('gifs' in opts ? opts.gifs : board)
  const store = opts.store ?? fakeStore()
  const paste = vi.fn(async (_path: string) => {})
  const provider = createGifBoardProvider({ config: () => config, gifs: store, paste, now: opts.now })
  return { provider, store, paste, setConfig: (c: Config) => { config = c } }
}

describe('writeGifToPasteboard', () => {
  it('hands the path to the script as an argument, never inside it', async () => {
    const run = vi.fn(async () => {})
    await writeGifToPasteboard('/x/a.gif', run)
    expect(run).toHaveBeenCalledWith(GIF_PASTE_SCRIPT, ['/x/a.gif'])
    expect(GIF_PASTE_SCRIPT).not.toContain('/x/a.gif')
  })

  it('writes the bytes and the file URL under bridged type names', () => {
    expect(GIF_PASTE_SCRIPT).toContain("$('public.file-url')")
    expect(GIF_PASTE_SCRIPT).toContain("$('com.compuserve.gif')")
  })
})

describe('gifSnapshot', () => {
  it('is empty without a board', () => {
    expect(gifSnapshot(undefined)).toEqual({ groups: [] })
  })

  it('points a Giphy item at Giphy and a link at its URL', () => {
    expect(gifSnapshot(board)).toEqual({
      groups: [{
        id: 'grp001',
        name: 'Reactions',
        items: [
          { id: 'item01', kind: 'giphy', label: 'Yes', src: 'https://i.giphy.com/abc.gif', thumb: 'https://media.giphy.com/media/abc/200w.gif' },
          { id: 'item02', kind: 'link', src: LINK, thumb: LINK },
        ],
      }],
    })
  })
})

describe('gif-board provider', () => {
  it('polls the snapshot of the saved board', async () => {
    const { provider } = setup()
    expect(provider.channel).toBe('gif-board')
    expect(provider.intervalMs).toBe(5000)
    expect(await provider.poll!()).toEqual(gifSnapshot(board))
  })

  it('warms the cache for links not cached yet, and swallows a failure', async () => {
    const store = fakeStore({
      isCached: vi.fn(async () => false),
      ensureCached: vi.fn(async () => { throw new GifFetchError('unreachable') }),
    })
    const { provider } = setup({ store })
    await provider.poll!()
    await vi.waitFor(() => expect(store.ensureCached).toHaveBeenCalledWith(LINK))
    expect(store.tempCopy).not.toHaveBeenCalled()
  })

  it('sweeps and prunes at the first poll, then at most once a minute', async () => {
    let clock = 1_000_000
    const { provider, store } = setup({ now: () => clock })
    await provider.poll!()
    await vi.waitFor(() => expect(store.sweepTemp).toHaveBeenCalledTimes(1))
    expect(store.prune).toHaveBeenCalledWith([LINK])
    clock += 30_000
    await provider.poll!()
    clock += 29_000
    await provider.poll!()
    expect(store.sweepTemp).toHaveBeenCalledTimes(1)
    clock += 2_000
    await provider.poll!()
    await vi.waitFor(() => expect(store.sweepTemp).toHaveBeenCalledTimes(2))
    expect(store.prune).toHaveBeenCalledTimes(2)
  })

  it('refuses a copy from anything but this Mac or a paired device', async () => {
    const { provider, paste, store } = setup()
    for (const ctx of [{ loopback: false, paired: false }, undefined]) {
      expect(await provider.commands!.copy!({ id: 'item01' }, ctx)).toEqual({ ok: false, error: tr(undefined, 'provider.localOnly') })
    }
    expect(paste).not.toHaveBeenCalled()
    expect(store.tempCopy).not.toHaveBeenCalled()
  })

  it('copies for a paired device, a tablet beside the Mac being a second Edge', async () => {
    const { provider, paste } = setup()
    expect(await provider.commands!.copy!({ id: 'item01' }, { loopback: false, paired: true, deviceId: 'dev-1' })).toEqual({ ok: true })
    expect(paste).toHaveBeenCalledTimes(1)
  })

  it('refuses a bad payload', async () => {
    const { provider, paste } = setup()
    for (const bad of [null, {}, { id: '' }, { id: 'x'.repeat(25) }, { id: 3 }]) {
      expect(await provider.commands!.copy!(bad, LOCAL)).toEqual({ ok: false, error: tr(undefined, 'provider.invalidPayload') })
    }
    expect(paste).not.toHaveBeenCalled()
  })

  it('copies a Giphy item through a temp copy, the stamped instance id allowed', async () => {
    const { provider, store, paste } = setup()
    expect(await provider.commands!.copy!({ id: 'item01', instanceId: 'w1' }, LOCAL)).toEqual({ ok: true })
    expect(store.tempCopy).toHaveBeenCalledWith('abc')
    expect(store.ensureCached).not.toHaveBeenCalled()
    expect(paste).toHaveBeenCalledWith('/tmp/gifs/tmp/abc.gif')
  })

  it('copies a link item from the cache', async () => {
    const { provider, store, paste } = setup()
    expect(await provider.commands!.copy!({ id: 'item02' }, LOCAL)).toEqual({ ok: true })
    expect(store.ensureCached).toHaveBeenCalledWith(LINK)
    expect(paste).toHaveBeenCalledWith('/data/gifs/cache/hash.gif')
  })

  it('answers unknownItem for an id no longer on the board', async () => {
    const { provider, paste, setConfig } = setup()
    setConfig(configWith({ groups: [] }))
    expect(await provider.commands!.copy!({ id: 'item01' }, LOCAL)).toEqual({ ok: false, error: tr(undefined, 'gifs.unknownItem') })
    expect(paste).not.toHaveBeenCalled()
  })

  it('names a download failure by its code', async () => {
    const store = fakeStore({ ensureCached: vi.fn(async () => { throw new GifFetchError('notGif') }) })
    const { provider, paste } = setup({ store })
    expect(await provider.commands!.copy!({ id: 'item02' }, LOCAL)).toEqual({ ok: false, error: tr(undefined, 'gifs.notGif') })
    expect(paste).not.toHaveBeenCalled()
  })

  it('answers a pasteboard failure with a fixed message, osascript\'s own text kept for the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { provider, paste } = setup()
    paste.mockRejectedValueOnce(new Error('execution error: Error: write failed (-2700)'))
    expect(await provider.commands!.copy!({ id: 'item02' }, LOCAL)).toEqual({ ok: false, error: tr(undefined, 'gifs.pasteFailed') })
    expect(String(warn.mock.calls[0]?.[0])).toContain('write failed')
    warn.mockRestore()
  })

  it('pastes one copy at a time', async () => {
    const order: string[] = []
    let release!: () => void
    const store = fakeStore({
      tempCopy: vi.fn(async (id: string) => { order.push(`temp:${id}`); return `/t/${id}.gif` }),
    })
    const { provider, paste } = setup({ store })
    paste.mockImplementationOnce(async (p: string) => { order.push(`paste:${p}`); await new Promise<void>((r) => { release = r }) })
    paste.mockImplementation(async (p: string) => { order.push(`paste:${p}`) })
    const first = provider.commands!.copy!({ id: 'item01' }, LOCAL)
    const second = provider.commands!.copy!({ id: 'item02' }, LOCAL)
    await vi.waitFor(() => expect(order).toEqual(['temp:abc', 'paste:/t/abc.gif']))
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['temp:abc', 'paste:/t/abc.gif', 'paste:/data/gifs/cache/hash.gif'])
  })

  it('refuses a third copy while two are queued, and takes one again once they are done', async () => {
    let release!: () => void
    const { provider, paste } = setup()
    paste.mockImplementationOnce(async () => { await new Promise<void>((r) => { release = r }) })
    const first = provider.commands!.copy!({ id: 'item01' }, LOCAL)
    const second = provider.commands!.copy!({ id: 'item02' }, LOCAL)
    expect(await provider.commands!.copy!({ id: 'item01' }, LOCAL)).toEqual({ ok: false, error: tr(undefined, 'gifs.busy') })
    await vi.waitFor(() => expect(paste).toHaveBeenCalledTimes(1))
    release()
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }])
    expect(await provider.commands!.copy!({ id: 'item01' }, LOCAL)).toEqual({ ok: true })
    expect(paste).toHaveBeenCalledTimes(3)
  })
})
