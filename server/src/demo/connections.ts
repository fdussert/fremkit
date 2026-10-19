import type { ConnectionType, PickOption } from '../connections/types.js'
import type { Provider } from '../providers/types.js'
import type { SynologySnapshot } from '../providers/synology.js'
import { clamp, demoEvents, wander } from './world.js'

/**
 * The coded connection types, as demo mode serves them.
 *
 * Same id, same fields, same channel prefix — the admin's forms and every widget's settings work
 * unchanged, and a connection added during a demo publishes at once — but `test()` succeeds
 * without going anywhere and `createProvider()` builds a fake fed from `world.ts`. No request
 * leaves the machine and no credential is ever read: the secrets a demo connection is given are
 * stored in the demo's own data folder and ignored.
 */
export function demoConnectionTypes(real: ConnectionType[], now: () => number = Date.now): ConnectionType[] {
  return real.map((type) => ({
    ...type,
    async test() { return { ok: true as const, detail: 'Demo mode: nothing was contacted.' } },
    ...(type.options ? { options: async (): Promise<PickOption[]> => [] } : {}),
    ...(type.createProvider ? { createProvider: (ctx: { id: string; channel: string; fields: Record<string, string> }) => demoConnectionProvider(type.id, ctx, now) } : {}),
  }))
}

function demoConnectionProvider(type: string, ctx: { id: string; channel: string; fields: Record<string, string> }, now: () => number): Provider {
  switch (type) {
    case 'ics': {
      const color = /^#[0-9a-f]{6}$/i.test(ctx.fields.color ?? '') ? ctx.fields.color : '#4f8cff'
      return { channel: ctx.channel, intervalMs: 60_000, poll: async () => ({ events: demoEvents(ctx.id, color, now()) }) }
    }
    case 'github': return { channel: ctx.channel, intervalMs: 60_000, poll: async () => githubSnapshot(now()) }
    case 'azure-devops': return { channel: ctx.channel, intervalMs: 10_000, poll: async () => azureSnapshot(now()) }
    case 'bambu': return { channel: ctx.channel, intervalMs: 1000, poll: async () => bambuSnapshot(now()) }
    case 'synology': return { channel: ctx.channel, intervalMs: 15_000, poll: async () => synologySnapshot(now()) }
    // A type added later that nobody taught demo mode about: an honest "not set up" rather than
    // a real provider that would go out onto the network.
    default: return { channel: ctx.channel, intervalMs: 60_000, poll: async () => ({ error: 'unconfigured' }) }
  }
}

const MIN = 60_000

function githubSnapshot(t: number): unknown {
  const repo = (name: string): string => `example-org/${name}`
  const url = 'https://github.com/example-org'
  return {
    notifications: [
      { id: 'n1', reason: 'review_requested', title: 'Add dark mode to the settings page', type: 'pr', repo: repo('website'), updatedAt: t - 6 * MIN, url },
      { id: 'n2', reason: 'mention', title: 'Crash when the cache folder is missing', type: 'issue', repo: repo('api'), updatedAt: t - 48 * MIN, url },
      { id: 'n3', reason: 'subscribed', title: 'v2.4.0', type: 'release', repo: repo('cli'), updatedAt: t - 3 * 60 * MIN, url },
    ],
    reviewRequests: [
      { id: 'p1', number: 482, title: 'Add dark mode to the settings page', repo: repo('website'), author: 'alex-example', updatedAt: t - 6 * MIN, url, draft: false },
      { id: 'p2', number: 117, title: 'Retry uploads on a flaky network', repo: repo('mobile-app'), author: 'sam-example', updatedAt: t - 95 * MIN, url, draft: false },
    ],
    myPrs: [
      { id: 'p3', number: 219, title: 'Rate-limit the public endpoints', repo: repo('api'), author: 'demo-user', updatedAt: t - 20 * MIN, url, draft: false },
      { id: 'p4', number: 488, title: 'WIP: new pricing page', repo: repo('website'), author: 'demo-user', updatedAt: t - 2 * 60 * MIN, url, draft: true },
    ],
    runs: [
      { id: 'r1', repo: repo('api'), name: 'CI', branch: 'feature/rate-limit', status: 'running', event: 'push', actor: 'demo-user', startedAt: t - 3 * MIN, updatedAt: t - 10_000, url },
      { id: 'r2', repo: repo('website'), name: 'Deploy preview', branch: 'feature/pricing', status: 'completed', conclusion: 'success', event: 'pull_request', actor: 'demo-user', startedAt: t - 26 * MIN, updatedAt: t - 21 * MIN, url },
      { id: 'r3', repo: repo('mobile-app'), name: 'CI', branch: 'hotfix/login', status: 'completed', conclusion: 'failure', event: 'push', actor: 'sam-example', startedAt: t - 70 * MIN, updatedAt: t - 62 * MIN, url },
    ],
    rateLimit: { remaining: 4_812, reset: Math.floor(t / 1000) + 2_400 },
  }
}

function azureSnapshot(t: number): unknown {
  const url = 'https://dev.azure.com/example-org'
  // A build that runs for eight minutes, then starts again: the stages move in a recording.
  const cycle = 8 * MIN
  const into = t % cycle
  const started = t - into
  const stages = ['Build', 'Test', 'Deploy to staging']
  const current = Math.min(stages.length - 1, Math.floor(into / (cycle / stages.length)))
  return {
    running: [{
      id: 9000 + Math.floor(t / cycle) % 1000, number: `2026.${1 + Math.floor(t / cycle) % 300}`, pipeline: 'web-app CI', branch: 'main',
      requestedFor: 'Demo User', reason: 'individualCI', status: 'running', queuedAt: started - 20_000, startedAt: started, url,
      stages: stages.map((name, i) => (i < current ? { name, state: 'done', result: 'succeeded' } : i === current ? { name, state: 'running' } : { name, state: 'pending' })),
    }],
    history: [
      { id: 8121, number: '2026.141', pipeline: 'web-app CI', branch: 'main', requestedFor: 'Demo User', reason: 'individualCI', status: 'completed', result: 'succeeded', queuedAt: t - 64 * MIN, startedAt: t - 63 * MIN, finishedAt: t - 55 * MIN, url, stages: stages.map((name) => ({ name, state: 'done', result: 'succeeded' })) },
      { id: 8117, number: '2026.140', pipeline: 'api nightly', branch: 'release/2.4', requestedFor: 'Alex Example', reason: 'schedule', status: 'completed', result: 'failed', queuedAt: t - 9 * 60 * MIN, startedAt: t - 9 * 60 * MIN, finishedAt: t - 9 * 60 * MIN + 12 * MIN, url, stages: [{ name: 'Build', state: 'done', result: 'succeeded' }, { name: 'Test', state: 'done', result: 'failed' }, { name: 'Deploy to staging', state: 'done', result: 'skipped' }] },
    ],
  }
}

function bambuSnapshot(t: number): unknown {
  // A three-hour print, looping.
  const total = 180 * MIN
  const into = t % total
  const percent = Math.floor(into / total * 100)
  return {
    connected: true, model: 'Example printer', state: 'running',
    file: 'desk-organizer.3mf', percent, remainingMin: Math.round((total - into) / MIN),
    layer: Math.floor(percent * 2.4), totalLayers: 240,
    nozzleTemp: Math.round(clamp(wander(t, 220, 1.5, 20_000), 200, 240)), nozzleTarget: 220,
    bedTemp: Math.round(clamp(wander(t, 55, 0.8, 30_000), 40, 70)), bedTarget: 55,
    speedLevel: 2,
  }
}

const TB = 1000 ** 4

/** A four-bay NAS: two volumes, one of them getting full, four disks that warm up a little. */
function synologySnapshot(t: number): SynologySnapshot {
  const disk = (n: number, model: string, base: number, container: string): SynologySnapshot['disks'][number] => ({
    id: `sata${n}`, name: `Drive ${n}`, model,
    temperature: Math.round(clamp(wander(t, base, 1.5, 40 * MIN, n * 0.4), 25, 60)),
    smart: 'normal', status: 'normal', container,
  })
  return {
    cpu: Math.round(clamp(wander(t, 9, 6, 90_000), 1, 100)),
    memory: { usedPercent: Math.round(wander(t, 38, 3, 10 * MIN)), totalBytes: 8 * 1024 ** 3 },
    network: {
      rx: Math.round(clamp(wander(t, 1_800_000, 1_600_000, 45_000), 20_000, 110_000_000)),
      tx: Math.round(clamp(wander(t, 420_000, 380_000, 35_000, 0.6), 8_000, 110_000_000)),
    },
    uptimeSeconds: 41 * 86_400 + 6 * 3_600 + Math.floor((t / 1000) % 3_600),
    model: 'DS-Example',
    dsmVersion: 'DSM 7.2.2',
    volumes: [
      { id: 'Volume 1', size: Math.round(10.5 * TB), used: Math.round(6.1 * TB), status: 'normal', fsType: 'btrfs' },
      { id: 'Volume 2', size: Math.round(3.6 * TB), used: Math.round(3.18 * TB), status: 'normal', fsType: 'btrfs' },
    ],
    disks: [
      disk(1, 'Example NAS HDD 8TB', 36, 'Volume 1'),
      disk(2, 'Example NAS HDD 8TB', 38, 'Volume 1'),
      disk(3, 'Example NAS HDD 4TB', 35, 'Volume 2'),
      disk(4, 'Example NAS HDD 4TB', 37, 'Volume 2'),
    ],
    at: t,
  }
}
