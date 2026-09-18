import { describe, it, expect, vi } from 'vitest'
import { parseVolume, createVolumeProvider } from '../src/providers/volume.js'
import { parseSpotify, createSpotifyProvider, SPOTIFY_BUNDLE_ID } from '../src/providers/spotify.js'
import { createMutedeckProvider } from '../src/providers/mutedeck.js'

describe('volume', () => {
  it('parses osascript output', () => {
    expect(parseVolume('output volume:45, input volume:50, alert volume:100, output muted:false')).toEqual({ level: 45, muted: false })
    expect(parseVolume('output volume:0, input volume:50, alert volume:100, output muted:true')).toEqual({ level: 0, muted: true })
  })
  it('set clamps and mute forwards', async () => {
    const run = vi.fn(async () => '')
    const p = createVolumeProvider(run)
    await p.commands!.set({ level: 150 })
    expect(run).toHaveBeenLastCalledWith('set volume output volume 100')
    await p.commands!.mute({ muted: true })
    expect(run).toHaveBeenLastCalledWith('set volume output muted true')
  })
})

describe('spotify', () => {
  it('parses the delimited state', () => {
    // The separator is an ASCII unit separator: a track name can contain any printable text.
    const s = parseSpotify(['playing', 'Song', 'Artist', 'Album', 'https://i.scdn.co/x', '215000', '12.5', '80'].join('\x1f'))
    expect(s).toEqual({ available: true, state: 'playing', title: 'Song', artist: 'Artist', album: 'Album', artwork: 'https://i.scdn.co/x', durationMs: 215000, positionMs: 12500, volume: 80 })
  })
  it('reports unavailable when Spotify is not running', async () => {
    const run = vi.fn(async (script: string) => (script.includes('System Events') ? 'false' : ''))
    expect(await createSpotifyProvider(run).poll!()).toEqual({ available: false })
  })
  it('reports stopped when no track', async () => {
    const run = vi.fn(async (script: string) => (script.includes('System Events') ? 'true' : 'stopped'))
    expect(await createSpotifyProvider(run).poll!()).toEqual({ available: true, state: 'stopped' })
  })
  it('propagates osascript errors', async () => {
    const run = vi.fn(async (script: string) => { if (script.includes('System Events')) return 'true'; throw new Error('osascript timeout') })
    await expect(createSpotifyProvider(run).poll!()).rejects.toThrow(/timeout/)
  })
})

describe('mutedeck', () => {
  it('maps status and unavailability', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ status: 'call', mute: 'active', video: 'inactive' }), { status: 200 }))
    expect(await createMutedeckProvider('http://x', ok as any).poll!()).toEqual({ available: true, status: 'call', mute: 'active', video: 'inactive' })
    const down = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    expect(await createMutedeckProvider('http://x', down as any).poll!()).toEqual({ available: false })
  })
  it('sends commands as POST', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }))
    const p = createMutedeckProvider('http://x', f as any)
    await p.commands!.toggleMute(null)
    expect(f).toHaveBeenLastCalledWith('http://x/v1/mute', expect.objectContaining({ method: 'POST' }))
    await p.commands!.toggleShare(null)
    expect(f).toHaveBeenLastCalledWith('http://x/v1/share', expect.objectContaining({ method: 'POST' }))
    await p.commands!.toggleRecord(null)
    expect(f).toHaveBeenLastCalledWith('http://x/v1/record', expect.objectContaining({ method: 'POST' }))
  })
})

describe('volume payloads', () => {
  it('refuses a level that is not a number instead of sending NaN to osascript', async () => {
    const run = vi.fn(async () => '')
    const p = createVolumeProvider(run)
    for (const bad of [{ level: 'loud' }, { level: null }, {}, null, { level: NaN }, { level: Infinity }]) {
      await expect(p.commands!.set(bad), JSON.stringify(bad)).rejects.toThrow()
    }
    expect(run).not.toHaveBeenCalled()
  })
  it('refuses a mute value that is not a boolean', async () => {
    const run = vi.fn(async () => '')
    const p = createVolumeProvider(run)
    for (const bad of [{ muted: 'yes' }, {}, null, { muted: 1 }]) {
      await expect(p.commands!.mute(bad), JSON.stringify(bad)).rejects.toThrow()
    }
    expect(run).not.toHaveBeenCalled()
  })
  it('still takes the real payloads', async () => {
    const run = vi.fn(async () => '')
    const p = createVolumeProvider(run)
    expect(await p.commands!.set({ level: 42 })).toEqual({ level: 42 })
    expect(await p.commands!.mute({ muted: false })).toEqual({ muted: false })
  })
})

describe('spotify activate', () => {
  const LOCAL = { loopback: true }

  it('opens the application by bundle id, with a fixed argv', async () => {
    const open = vi.fn(async () => {})
    const p = createSpotifyProvider(vi.fn(async () => ''), open)
    expect(await p.commands!.activate(null, LOCAL)).toEqual({ ok: true })
    // Nothing in the argv comes from the caller: there is no payload at all.
    expect(open).toHaveBeenCalledWith('open', ['-b', SPOTIFY_BUNDLE_ID])
  })

  it('ignores whatever payload a widget sends, because there is nothing to steer', async () => {
    const open = vi.fn(async () => {})
    const p = createSpotifyProvider(vi.fn(async () => ''), open)
    await p.commands!.activate({ bundleId: 'com.apple.Terminal', target: 'Terminal' }, LOCAL)
    expect(open).toHaveBeenCalledWith('open', ['-b', SPOTIFY_BUNDLE_ID])
  })

  it('refuses a command that did not come from this machine', async () => {
    const open = vi.fn(async () => {})
    const p = createSpotifyProvider(vi.fn(async () => ''), open)
    expect(await p.commands!.activate(null, { loopback: false })).toMatchObject({ ok: false })
    expect(await p.commands!.activate(null)).toMatchObject({ ok: false })
    expect(open).not.toHaveBeenCalled()
  })

  it('reports a failure rather than throwing', async () => {
    const open = vi.fn(async () => { throw new Error('Unable to find application') })
    const p = createSpotifyProvider(vi.fn(async () => ''), open)
    expect(await p.commands!.activate(null, LOCAL)).toEqual({ ok: false, error: 'Unable to find application' })
  })
})

describe('the spotify field separator', () => {
  it('survives a title containing pipes', () => {
    // The old separator was `|||`, and a track called "a ||| b" shifted every field after it.
    const s = parseSpotify(['playing', 'a ||| b', 'Artist', 'Album', 'https://i.scdn.co/x', '1000', '1', '80'].join('\x1f'))
    expect(s).toMatchObject({ title: 'a ||| b', artist: 'Artist', album: 'Album', volume: 80 })
  })
})
