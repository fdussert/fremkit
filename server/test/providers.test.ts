import { describe, it, expect, vi } from 'vitest'
import { parseVolume, createVolumeProvider } from '../src/providers/volume.js'
import { parseSpotify, createSpotifyProvider } from '../src/providers/spotify.js'
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
    const s = parseSpotify('playing|||Song|||Artist|||Album|||https://i.scdn.co/x|||215000|||12.5|||80')
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
