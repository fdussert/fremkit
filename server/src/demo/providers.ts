import { z } from 'zod'
import type { Provider } from '../providers/types.js'
import { tr } from '../i18n.js'
import type { Config } from '../config/schema.js'
import { findInstance, type InstanceLookup } from '../config/instances.js'
import { resolveServices, type ServiceResult } from '../providers/service-status.js'
import { buildView, findNode, type DiskNode } from '../providers/disk-map-tree.js'
import { codexProviders } from './codex.js'
import {
  DEMO_APPS, DEMO_CLIPBOARD, DEMO_PROCESSES, DEMO_SESSIONS, DEMO_TRACKS,
  clamp, coverArt, round1, wander,
} from './world.js'

/**
 * Every channel the server publishes, answered from the invented machine of `world.ts`.
 *
 * Demo mode (`FREMKIT_DEMO=1`, see docs/demo-mode.md) registers these *instead of* the real
 * providers: nothing here runs a program, reads a file, opens a socket or asks the keychain.
 * Commands are accepted and acted out on the fake state — play/pause toggles, a slider moves —
 * and the ones that would act on the Mac (open an app, reveal in Finder) answer `ok` and do
 * nothing.
 *
 * The data moves a little with time, through `wander`, so a recording looks alive: the clock is
 * the real one, the CPU drifts, the track plays.
 */

const GB = 1024 ** 3
const MB = 1024 ** 2

export interface DemoProviderOptions {
  /** The live config: the brightness screens and the service list are read from it. */
  config: () => Config
  now?: () => number
  /**
   * How a command finds the instance it names, scoped to a paired device's own screen as the real
   * providers are. Every instance of the config when left out.
   */
  instances?: InstanceLookup
}

/** What a demo command answers when it would have acted on the Mac. */
const ACTED = async (): Promise<{ ok: true }> => ({ ok: true })

export function createDemoProviders(opts: DemoProviderOptions): Provider[] {
  const now = opts.now ?? Date.now
  const startedAt = now()
  return [
    systemProvider(now, startedAt),
    processesProvider(now),
    networkProvider(now),
    batteryProvider(now),
    volumeProvider(),
    spotifyProvider(now),
    clipboardProvider(now),
    dockProvider(now),
    brightnessProvider(opts.config),
    diskMapProvider(now),
    ...claudeProviders(now, opts.config),
    ...codexProviders(now, opts.config),
    dockerProvider(now),
    localModelsProvider(now),
    mutedeckProvider(now),
    { channel: 'cleanshot', commands: { run: ACTED } },
    rtkProvider(now),
    { channel: 'shortcuts', commands: { open: ACTED } },
    { channel: 'messages-2fa', commands: { copyLatest: async () => ({ ok: false, error: tr(undefined, 'messages2fa.noneFound') }) } },
    serviceStatusProvider(now, opts.instances ?? ((id) => findInstance(opts.config(), id))),
  ]
}

function systemProvider(now: () => number, startedAt: number): Provider {
  const total = 32 * GB
  return {
    channel: 'system',
    intervalMs: 2000,
    poll: async () => {
      const t = now()
      const load = clamp(wander(t, 24, 12, 40_000), 3, 97)
      const cores = Array.from({ length: 10 }, (_, i) => round1(clamp(wander(t, load, 18, 9_000 + i * 1_300, i * 0.37), 0, 100)))
      const used = wander(t, 17.5 * GB, 1.2 * GB, 120_000)
      const disk = 994_662_584_320
      const diskUsed = 612 * GB + Math.round(wander(t, 0, 0.4 * GB, 300_000))
      const backup = 1_999_844_147_200
      const backupUsed = 1_204 * GB
      return {
        uptimeSeconds: Math.floor((3 * 86_400 + 4 * 3_600 + 17 * 60) + (t - startedAt) / 1000),
        cpu: {
          load: round1(load), cores,
          temp: round1(wander(t, 52, 6, 60_000)), tempSource: 'system', tempError: null,
        },
        memory: { total, used: Math.round(used), free: Math.round(total - used), swapUsed: 1.1 * GB, swapTotal: 4 * GB },
        disks: [
          { mount: '/', size: disk, used: diskUsed, available: disk - diskUsed, use: round1(diskUsed / disk * 100) },
          { mount: '/Volumes/Backup', size: backup, used: backupUsed, available: backup - backupUsed, use: round1(backupUsed / backup * 100) },
        ],
        network: [{ iface: 'en0', rx: Math.round(downBps(t)), tx: Math.round(upBps(t)) }],
      }
    },
  }
}

function processesProvider(now: () => number): Provider {
  return {
    channel: 'processes',
    intervalMs: 5000,
    poll: async () => {
      const t = now()
      const processes = DEMO_PROCESSES
        .map((p, i) => ({ pid: p.pid, name: p.name, cpu: round1(clamp(wander(t, p.cpu, p.cpu * 0.45, 25_000 + i * 2_000, i), 0.1, 100)), mem: p.mem }))
        .sort((a, b) => b.cpu - a.cpu)
      return { processes }
    },
  }
}

const downBps = (t: number): number => clamp(wander(t, 2.4 * MB, 2.1 * MB, 30_000), 40_000, 20 * MB)
const upBps = (t: number): number => clamp(wander(t, 420_000, 380_000, 22_000, 0.4), 8_000, 5 * MB)

function networkProvider(now: () => number): Provider {
  return {
    channel: 'network',
    intervalMs: 2000,
    poll: async () => {
      const t = now()
      const history: [number, number][] = []
      for (let i = 59; i >= 0; i--) {
        const at = t - i * 2000
        history.push([Math.round(downBps(at)), Math.round(upBps(at))])
      }
      const [down, up] = history[history.length - 1]
      return { iface: 'en0', kind: 'wifi', ip: '192.0.2.42', ssid: 'Example Wi-Fi', downBps: down, upBps: up, history }
    },
  }
}

function batteryProvider(now: () => number): Provider {
  return {
    channel: 'battery',
    intervalMs: 30_000,
    poll: async () => {
      // Discharging slowly from 86 %, a percent every few minutes, and back up once it gets low.
      const minutes = Math.floor(now() / 60_000)
      const percent = 86 - (minutes % 240) / 6
      return {
        mac: { percent: Math.round(percent), charging: false, minutesLeft: Math.round(percent * 5.4) },
        devices: [
          { name: 'Magic Keyboard', kind: 'keyboard', percent: 82 },
          { name: 'Magic Mouse', kind: 'mouse', percent: 46 },
          { name: 'Headphones', kind: 'headphones', percent: 64, parts: { left: 70, right: 64, case: 91 } },
          { name: 'Trackpad', kind: 'trackpad', percent: 18 },
        ],
      }
    },
  }
}

const VolumeSet = z.object({ level: z.number().finite() })
const VolumeMute = z.object({ muted: z.boolean() })

function volumeProvider(): Provider {
  const state = { level: 45, muted: false }
  return {
    channel: 'volume',
    intervalMs: 1000,
    poll: async () => ({ ...state }),
    commands: {
      set: async (payload) => {
        const parsed = VolumeSet.safeParse(payload)
        if (!parsed.success) throw new Error('invalid level')
        state.level = clamp(Math.round(parsed.data.level), 0, 100)
        return { level: state.level }
      },
      mute: async (payload) => {
        const parsed = VolumeMute.safeParse(payload)
        if (!parsed.success) throw new Error('invalid mute')
        state.muted = parsed.data.muted
        return { muted: state.muted }
      },
    },
  }
}

function spotifyProvider(now: () => number): Provider {
  // Where the current track started, as if it had been playing since then; paused freezes it.
  let track = 0
  let startedAt = now() - 47_000
  let pausedAt: number | null = null
  const position = (): number => (pausedAt ?? now()) - startedAt
  const advance = (): void => {
    while (pausedAt === null && position() >= DEMO_TRACKS[track].durationMs) {
      startedAt += DEMO_TRACKS[track].durationMs
      track = (track + 1) % DEMO_TRACKS.length
    }
  }
  const go = (step: number): { ok: true } => {
    track = (track + step + DEMO_TRACKS.length) % DEMO_TRACKS.length
    startedAt = (pausedAt ?? now())
    return { ok: true }
  }
  return {
    channel: 'spotify',
    intervalMs: 1000,
    poll: async () => {
      advance()
      const t = DEMO_TRACKS[track]
      return {
        available: true,
        state: pausedAt === null ? 'playing' : 'paused',
        title: t.title, artist: t.artist, album: t.album, artwork: coverArt(t.hue),
        durationMs: t.durationMs, positionMs: Math.floor(position()), volume: 70,
      }
    },
    commands: {
      playPause: async () => {
        if (pausedAt === null) pausedAt = now()
        else { startedAt += now() - pausedAt; pausedAt = null }
        return { ok: true }
      },
      next: async () => go(1),
      // Like a real player: back to the start of the track first, the previous one only from there.
      previous: async () => (position() > 3000 ? (startedAt = pausedAt ?? now(), { ok: true as const }) : go(-1)),
      activate: ACTED,
    },
  }
}

function clipboardProvider(now: () => number): Provider {
  let cleared = false
  return {
    channel: 'clipboard',
    intervalMs: 5000,
    poll: async () => {
      if (cleared) return { entries: [] }
      const t = now()
      return { entries: DEMO_CLIPBOARD.map((e, i) => ({ id: String(i + 1), preview: e.preview, at: t - e.minutesAgo * 60_000, masked: e.masked })) }
    },
    commands: {
      copy: ACTED,
      clear: async () => { cleared = true; return { ok: true } },
    },
  }
}

function dockProvider(now: () => number): Provider {
  return {
    channel: 'dock',
    intervalMs: 1000,
    poll: async () => {
      // A new chat message now and then, so the badge visibly moves in a recording.
      const tick = Math.floor(now() / 45_000)
      return {
        available: true,
        apps: DEMO_APPS.map((app) => ({
          bundleId: app.bundleId,
          name: app.name,
          badge: app.bundleId === 'com.example.chat' ? String(12 + (tick % 4)) : app.badge,
          running: true,
        })),
      }
    },
    commands: { activate: ACTED },
  }
}

const BrightnessSet = z.object({ screen: z.string().max(64).optional(), value: z.number().finite() })
const BrightnessStep = z.object({ screen: z.string().max(64).optional(), delta: z.number().finite().min(-100).max(100) })

function brightnessProvider(config: () => Config): Provider {
  const levels = new Map<string, number>()
  let seq = 0
  const kiosk = (): string | null => config().screens.find((s) => s.kind === 'edge')?.id ?? null
  const screenOf = (id: string | undefined): string => {
    const target = id ?? kiosk()
    if (!target || !config().screens.some((s) => s.id === target)) throw new Error('unknown screen')
    return target
  }
  const set = (id: string, value: number): { screen: string; value: number } => {
    const v = clamp(Math.round(value), 0, 100)
    levels.set(id, v)
    seq++
    return { screen: id, value: v }
  }
  return {
    channel: 'brightness',
    intervalMs: 5000,
    poll: async () => ({
      kiosk: kiosk(),
      screens: Object.fromEntries(config().screens.map((s) => {
        const value = levels.get(s.id) ?? 70
        return [s.id, { available: true, value, target: value, seq, mode: 'manual', overridden: false, builtin: false }]
      })),
    }),
    commands: {
      set: async (payload) => {
        const p = BrightnessSet.safeParse(payload ?? {})
        if (!p.success) throw new Error('invalid payload')
        return set(screenOf(p.data.screen), p.data.value)
      },
      step: async (payload) => {
        const p = BrightnessStep.safeParse(payload ?? {})
        if (!p.success) throw new Error('invalid payload')
        const id = screenOf(p.data.screen)
        return set(id, (levels.get(id) ?? 70) + p.data.delta)
      },
      resume: async () => ({ ok: true }),
    },
  }
}

/** A home folder of a plausible shape: a few big folders, each with a few children. */
function demoTree(): DiskNode {
  const folder = (name: string, gb: number, kids: [string, number][] = []): DiskNode => {
    const children = kids.map(([n, g]): DiskNode => ({ name: n, kind: n.includes('.') ? 'f' : 'd', size: Math.round(g * GB), files: Math.round(g * 140) }))
    const rest = gb - kids.reduce((sum, [, g]) => sum + g, 0)
    return {
      name, kind: 'd', size: Math.round(gb * GB), files: Math.round(gb * 400),
      ...(children.length ? { children } : {}),
      ...(rest > 0.05 ? { others: [Math.round(rest * 30), Math.round(rest * GB)] as [number, number] } : {}),
    }
  }
  const children: DiskNode[] = [
    folder('Library', 96, [['Application Support', 41], ['Caches', 22], ['Containers', 18], ['Developer', 11]]),
    folder('Movies', 74, [['Holiday 2025', 38], ['Screen recordings', 21], ['Edits', 12]]),
    folder('Pictures', 58, [['Photos Library.photoslibrary', 51], ['Wallpapers', 4]]),
    folder('Projects', 46, [['website', 14], ['api', 11], ['mobile-app', 9], ['experiments', 6]]),
    folder('Documents', 31, [['Archive', 12], ['Invoices', 3], ['Books', 6]]),
    folder('Music', 22, [['Library', 19]]),
    folder('Downloads', 17, [['installers', 9], ['dataset.csv', 2.4]]),
    folder('Desktop', 4),
  ]
  const size = children.reduce((sum, c) => sum + c.size, 0) + 3 * GB
  return { name: '~', kind: 'd', size, files: 1_284_311, children, others: [42, 3 * GB] }
}

const DiskView = z.object({
  root: z.string().max(200),
  path: z.array(z.string().max(255)).max(64).default([]),
  rings: z.number().int().min(1).max(6).default(3),
  minDegrees: z.number().min(0).max(90).default(3.5),
}).loose()

function diskMapProvider(now: () => number): Provider {
  const tree = demoTree()
  let scannedAt = now() - 26 * 60_000
  let generation = 1
  return {
    channel: 'disk-map',
    intervalMs: 5000,
    poll: async () => ({
      scanner: 'native',
      roots: [{ id: 'home', label: '~', kind: 'home' }],
      scanning: null,
      queued: [],
      results: { home: { scannedAt, size: tree.size, files: tree.files ?? 0, unreadable: 0, scanner: 'native', generation } },
      errors: {},
    }),
    commands: {
      view: async (payload) => {
        const parsed = DiskView.safeParse(payload ?? {})
        if (!parsed.success) return { ok: false, error: 'invalid' }
        if (parsed.data.root !== 'home') return { ok: true, view: null }
        const node = findNode(tree, parsed.data.path)
        if (!node) return { ok: false, error: 'gone' }
        const view = buildView(node, { rings: parsed.data.rings, minDegrees: parsed.data.minDegrees, listMax: 60 })
        return { ok: true, view, path: parsed.data.path, scannedAt, generation }
      },
      // A scan "finishes" at once: there is nothing to walk.
      scan: async () => { scannedAt = now(); generation++; return { ok: true } },
      cancel: ACTED,
      reveal: ACTED,
      revealPrompt: ACTED,
      openPrivacy: ACTED,
    },
  }
}

function claudeProviders(now: () => number, config: () => Config): Provider[] {
  const dismissed = new Set<string>()
  const sessions = (): unknown[] => {
    const t = now()
    // The working session moves on to another file every twenty seconds.
    const step = Math.floor(t / 20_000)
    const files = ['src/pages/pricing.vue', 'src/components/PlanCard.vue', 'src/styles/pricing.css', 'test/pricing.spec.ts']
    return DEMO_SESSIONS.map((s, i) => {
      const sessionId = `demo-session-${i + 1}`
      const since = t - s.minutesAgo * 60_000
      const size = 200_000
      return {
        sessionId,
        project: s.project,
        cwd: `/Users/demo/Projects/${s.project}`,
        title: s.title,
        branch: s.branch,
        model: s.model,
        state: s.state,
        since,
        lastEventAt: s.state === 'working' ? t - 4_000 : since,
        ...('tool' in s ? { tool: s.tool, toolDetail: s.state === 'working' ? files[step % files.length] : s.toolDetail } : {}),
        ...('lastMessage' in s ? { lastMessage: s.lastMessage } : {}),
        subagents: s.state === 'working' ? 1 : 0,
        context: { used: Math.round(size * s.pct / 100), size, pct: s.pct },
        costUsd: round1(s.pct / 9),
        client: { kind: i % 2 ? 'terminal' : 'vscode', label: i % 2 ? 'Terminal' : 'VS Code' },
      }
    }).filter((s) => !dismissed.has(s.sessionId))
  }
  const hourly = (t: number): number[] => {
    const hour = new Date(t).getHours()
    return Array.from({ length: 24 }, (_, h) => (h > hour || h < 8 || h > 20 ? 0 : Math.round(wander(h * 3_600_000, 180_000, 120_000, 5 * 3_600_000) + 40_000)))
  }
  const resetIn = (t: number, hours: number): number => Math.floor(t / 1000) + Math.round(hours * 3600)
  return [
    {
      channel: 'claude-sessions',
      intervalMs: 1000,
      poll: async () => ({ sessions: sessions(), today: { sessions: 6, done: 4, commits: 7 } }),
      commands: {
        focus: ACTED,
        preview: ACTED,
        dismiss: async (payload) => {
          const id = (payload as { sessionId?: unknown } | null)?.sessionId
          if (typeof id === 'string') dismissed.add(id)
          return { dismissed: typeof id === 'string' }
        },
      },
    },
    {
      channel: 'claude-usage',
      intervalMs: 60_000,
      poll: async () => {
        const t = now()
        const hours = hourly(t)
        const tokens = hours.reduce((a, b) => a + b, 0)
        return {
          fiveHour: { pct: Math.round(wander(t, 38, 6, 600_000)), resetsAt: resetIn(t, 2.3) },
          sevenDay: { pct: 61, resetsAt: resetIn(t, 76) },
          spendLimit: null,
          updatedAt: t,
          stale: false,
          today: {
            input: Math.round(tokens * 0.12), output: Math.round(tokens * 0.08),
            cacheRead: Math.round(tokens * 0.7), cacheWrite: Math.round(tokens * 0.1),
            messages: 214, sessions: 6, hourly: hours, costUsd: 18.4,
          },
        }
      },
    },
    {
      channel: 'claude-account',
      intervalMs: 60_000,
      poll: async () => {
        const t = now()
        if (!config().privacy.claudeAccountUsage) {
          return { available: false, stale: false, error: 'disabled', updatedAt: null, fiveHour: null, sevenDay: null, limits: [], breakdown: [] }
        }
        const five = Math.round(wander(t, 38, 6, 600_000))
        return {
          available: true, stale: false, updatedAt: t,
          fiveHour: { pct: five, resetsAt: resetIn(t, 2.3) },
          sevenDay: { pct: 61, resetsAt: resetIn(t, 76) },
          limits: [
            { kind: 'five_hour', name: '5 h', percent: five, resetsAt: resetIn(t, 2.3), active: true },
            { kind: 'seven_day', name: 'Week', percent: 61, resetsAt: resetIn(t, 76), active: true },
            { kind: 'seven_day_opus', name: 'Opus', percent: 44, resetsAt: resetIn(t, 76), active: true },
          ],
          breakdown: [{ name: 'Opus', percent: 72 }, { name: 'Sonnet', percent: 28 }],
        }
      },
    },
    {
      channel: 'claude-identity',
      intervalMs: 300_000,
      poll: async () => ({ loggedIn: true, subscriptionType: 'max', authMethod: 'claude.ai', updatedAt: now(), stale: false, error: null }),
    },
  ]
}

function dockerProvider(now: () => number): Provider {
  return {
    channel: 'docker-local',
    intervalMs: 10_000,
    poll: async () => {
      const t = now()
      const cpu = (base: number, phase: number): string => `${clamp(wander(t, base, base * 0.6, 30_000, phase), 0, 400).toFixed(2)}%`
      return {
        data: {
          containers: [
            { id: 'a1b2c3d4e5f6', name: 'web', image: 'example/web:latest', state: 'running', status: 'Up 3 hours', stats: { cpu: cpu(4, 0), memory: '182MiB / 7.6GiB', memoryPercent: '2.34%', pids: '12', netIO: '48.2MB / 12.1MB', blockIO: '0B / 4.1MB' } },
            { id: 'b2c3d4e5f6a1', name: 'db', image: 'postgres:16', state: 'running', status: 'Up 3 hours', stats: { cpu: cpu(1.5, 1), memory: '96MiB / 7.6GiB', memoryPercent: '1.23%', pids: '9', netIO: '3.4MB / 5.8MB', blockIO: '22MB / 61MB' } },
            { id: 'c3d4e5f6a1b2', name: 'cache', image: 'redis:7', state: 'running', status: 'Up 3 hours', stats: { cpu: cpu(0.4, 2), memory: '12MiB / 7.6GiB', memoryPercent: '0.15%', pids: '5', netIO: '1.1MB / 0.9MB', blockIO: '0B / 0B' } },
            { id: 'd4e5f6a1b2c3', name: 'worker', image: 'example/worker:latest', state: 'exited', status: 'Exited (0) 20 minutes ago', stats: null },
          ],
        },
        stale: false, error: null, updatedAt: t,
      }
    },
  }
}

function rtkProvider(now: () => number): Provider {
  return {
    channel: 'rtk',
    intervalMs: 60_000,
    poll: async () => {
      const t = new Date(now())
      const daily = Array.from({ length: 14 }, (_, i) => {
        const d = new Date(t)
        d.setDate(d.getDate() - (13 - i))
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        const commands = 120 + ((i * 37) % 90)
        const input = commands * 5200
        const saved = Math.round(input * 0.71)
        return { date, commands, input, output: input - saved, saved, percent: 71 }
      })
      const sum = (k: 'commands' | 'input' | 'output' | 'saved'): number => daily.reduce((a, d) => a + d[k], 0)
      return {
        data: {
          total: { commands: sum('commands'), input: sum('input'), output: sum('output'), saved: sum('saved'), percent: 71, avgTimeMs: 38 },
          today: daily[daily.length - 1],
          daily,
        },
        stale: false, error: null, updatedAt: now(),
      }
    },
  }
}

/** Ollama with three models on disk, two of them loaded, and one MLX server: generic names only. */
function localModelsProvider(now: () => number): Provider {
  const installed = [
    { name: 'llama-3.1-8b-instruct', size: 4.9 * GB },
    { name: 'qwen-2.5-coder-7b', size: 4.7 * GB },
    { name: 'nomic-embed-text', size: 0.27 * GB },
  ].map((m) => ({ ...m, size: Math.round(m.size), size_vram: null, context_length: null, expires_at: null }))
  return {
    channel: 'local-models',
    intervalMs: 15_000,
    poll: async () => {
      const t = now()
      const part = <T>(data: T): { data: T; stale: false; error: null; updatedAt: number } => ({ data, stale: false, error: null, updatedAt: t })
      const loaded = [
        { name: 'llama-3.1-8b-instruct', size: Math.round(6.2 * GB), size_vram: Math.round(6.2 * GB), context_length: 8_192 },
        { name: 'nomic-embed-text', size: Math.round(0.6 * GB), size_vram: Math.round(0.6 * GB), context_length: 2_048 },
      ].map((m) => ({ ...m, expires_at: new Date(t + 4 * 60_000).toISOString() }))
      const mlx = [{
        pid: 48_213, backend: 'MLX' as const, model: 'qwen-2.5-coder-7b-4bit', port: 8080,
        cpu: round1(clamp(wander(t, 6, 5, 20_000), 0.2, 100)), memoryBytes: Math.round(4.4 * GB),
      }]
      return { installed: part(installed), loaded: part(loaded), mlx: part(mlx) }
    },
  }
}

/**
 * MuteDeck in a meeting: muted, camera on. The buttons toggle the fake state; leaving ends the
 * call, and another one starts a minute later so a recording never stays on an empty tile.
 */
function mutedeckProvider(now: () => number): Provider {
  const state = { mute: 'active', video: 'active', share: 'inactive', record: 'inactive' }
  let leftAt: number | null = null
  const inCall = (): boolean => {
    if (leftAt !== null && now() - leftAt > 60_000) leftAt = null
    return leftAt === null
  }
  const toggle = (key: keyof typeof state) => async (): Promise<{ ok: true }> => {
    if (inCall()) state[key] = state[key] === 'active' ? 'inactive' : 'active'
    return { ok: true }
  }
  return {
    channel: 'mutedeck',
    intervalMs: 1000,
    poll: async () => (inCall()
      ? { available: true, status: 200, control: 'system', call: 'active', ...state }
      : { available: true, status: 200, control: 'system', call: 'inactive', mute: 'disabled', video: 'disabled', share: 'disabled', record: 'disabled' }),
    commands: {
      toggleMute: toggle('mute'),
      toggleVideo: toggle('video'),
      toggleShare: toggle('share'),
      toggleRecord: toggle('record'),
      leave: async () => { leftAt = now(); return { ok: true } },
    },
  }
}

function serviceStatusProvider(now: () => number, instances: InstanceLookup): Provider {
  return {
    channel: 'service-status',
    intervalMs: 60_000,
    poll: async () => ({ ok: true }),
    commands: {
      probe: async (payload, ctx) => {
        const instanceId = (payload as { instanceId?: unknown } | null)?.instanceId
        if (typeof instanceId !== 'string') return { ok: false, error: 'invalid payload' }
        const resolved = resolveServices((id) => instances(id, ctx), instanceId)
        if (!resolved.ok) return resolved
        const t = now()
        const results: ServiceResult[] = resolved.services.map((s, i) => {
          // One service runs slow for a while, every few minutes, so the amber dot shows up.
          const slow = i === 1 && Math.floor(t / 180_000) % 3 === 0
          const latencyMs = Math.round(clamp(wander(t, slow ? 640 : 38 + i * 21, slow ? 120 : 12, 50_000, i), 4, 2000))
          return { name: s.name, state: slow ? 'warn' : 'up', latencyMs }
        })
        return { ok: true, results }
      },
    },
  }
}
