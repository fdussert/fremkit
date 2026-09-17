import type { Provider } from './types.js'

type FetchFn = typeof fetch

export function createMutedeckProvider(baseUrl = 'http://localhost:3491', fetchFn: FetchFn = fetch): Provider {
  const post = (path: string) => async () => {
    const r = await fetchFn(`${baseUrl}${path}`, { method: 'POST', signal: AbortSignal.timeout(2000) })
    if (!r.ok) throw new Error(`MuteDeck ${path}: HTTP ${r.status}`)
    return { ok: true }
  }
  return {
    channel: 'mutedeck',
    intervalMs: 1000,
    async poll() {
      try {
        const r = await fetchFn(`${baseUrl}/v1/status`, { signal: AbortSignal.timeout(2000) })
        if (!r.ok) return { available: false }
        return { ...(await r.json() as Record<string, unknown>), available: true }
      } catch {
        return { available: false }
      }
    },
    commands: {
      toggleMute: post('/v1/mute'),
      toggleVideo: post('/v1/video'),
      toggleShare: post('/v1/share'),
      toggleRecord: post('/v1/record'),
      leave: post('/v1/leave'),
    },
  }
}
