import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CONFIG_VERSION, type Config, type Placement } from '../config/schema.js'
import { BUILTIN_THEME } from '../themes/theme.js'
import { DEFAULT_BACKGROUND } from '../backgrounds/seed.js'
import { FileSecretStore } from '../secrets/file.js'
import { DEMO_APPS, DEMO_CALENDARS, DEMO_NAS } from './world.js'

/**
 * The settings each built-in widget is shown with in demo mode and in its preview image.
 *
 * Only what differs from the manifest's defaults, and only what makes the widget show something:
 * a calendar with no calendar selected, a service list with no service, a shortcuts grid with no
 * button would all be empty states. A widget missing from this table is shown with its defaults,
 * which is what an author's widget gets from `pnpm widget:preview`.
 *
 * A few Sietch widgets are here too, for their previews only (none is on the seeded dashboard):
 * their defaults show nothing until something is ticked. A `connection` setting needs no entry;
 * the preview points it at a demo connection of its type.
 */
export const DEMO_SETTINGS: Record<string, Record<string, unknown>> = {
  calendar: { calendars: DEMO_CALENDARS.map((c) => c.id) },
  clock: {
    cities: [
      { label: 'New York', timezone: 'America/New_York', hour12: false, seconds: false },
      { label: 'Tokyo', timezone: 'Asia/Tokyo', hour12: false, seconds: false },
    ],
  },
  notifications: { apps: DEMO_APPS.map((a) => a.bundleId) },
  processes: { count: 10 },
  'service-status': {
    services: [
      { name: 'Website', kind: 'http', url: 'https://example.com' },
      { name: 'API', kind: 'http', url: 'https://api.example.com/health' },
      { name: 'Database', kind: 'tcp', url: 'db.example.com:5432' },
      { name: 'Backup NAS', kind: 'ping', url: '192.0.2.10' },
    ],
  },
  shortcuts: {
    buttons: [
      { label: 'Mail', kind: 'app', target: 'Mail', icon: '✉️' },
      { label: 'Docs', kind: 'url', target: 'https://example.com/docs', icon: '📘' },
      { label: 'Focus', kind: 'shortcut', target: 'Focus mode', icon: '🎧' },
      { label: 'Notes', kind: 'app', target: 'Notes', icon: '📝' },
      { label: 'Music', kind: 'app', target: 'Music', icon: '🎵' },
      { label: 'Calendar', kind: 'app', target: 'Calendar', icon: '📅' },
      { label: 'Timer', kind: 'shortcut', target: 'Start timer', icon: '⏱️' },
      { label: 'Status', kind: 'url', target: 'https://status.example.com', icon: '🟢' },
    ],
  },
  weather: { location: 'Paris' },
  // Sietch widgets.
  'homey-devices': { all: true },
  'homey-flows': { all: true },
}

/**
 * Built-ins the demo leaves off its dashboard and gives no provider: Fremplay shows a browser
 * tab sent by the Fremkit Companion extension, which a demo has no way to fake, and it is an
 * experimental feature hidden in the admin until `labs.companion` is on.
 */
export const DEMO_LEAVES_OUT: readonly string[] = ['fremplay']

/** The instance ids and places of the seeded dashboard: two pages that show every built-in but those. */
const PAGES: { id: string; name: string; items: (Placement & { widgetId: string })[] }[] = [
  {
    id: 'today', name: 'Today',
    items: [
      { instanceId: 'clock-1', widgetId: 'clock', x: 0, y: 0, w: 16, h: 4 },
      { instanceId: 'weather-1', widgetId: 'weather', x: 0, y: 4, w: 16, h: 6 },
      { instanceId: 'spotify-1', widgetId: 'spotify', x: 0, y: 10, w: 16, h: 6 },
      { instanceId: 'calendar-1', widgetId: 'calendar', x: 16, y: 0, w: 16, h: 12 },
      { instanceId: 'notifications-1', widgetId: 'notifications', x: 16, y: 12, w: 16, h: 4 },
      { instanceId: 'claude-sessions-1', widgetId: 'claude-sessions', x: 32, y: 0, w: 16, h: 8 },
      { instanceId: 'claude-usage-1', widgetId: 'claude-usage', x: 32, y: 8, w: 16, h: 4 },
      { instanceId: 'service-status-1', widgetId: 'service-status', x: 32, y: 12, w: 8, h: 4 },
      { instanceId: 'pomodoro-1', widgetId: 'pomodoro', x: 40, y: 12, w: 8, h: 4 },
      { instanceId: 'cpu-1', widgetId: 'cpu', x: 48, y: 0, w: 8, h: 4 },
      { instanceId: 'memory-1', widgetId: 'memory', x: 56, y: 0, w: 8, h: 4 },
      { instanceId: 'network-1', widgetId: 'network', x: 48, y: 4, w: 16, h: 4 },
      { instanceId: 'disk-1', widgetId: 'disk', x: 48, y: 8, w: 16, h: 4 },
      { instanceId: 'battery-1', widgetId: 'battery', x: 48, y: 12, w: 8, h: 4 },
      { instanceId: 'volume-1', widgetId: 'volume', x: 56, y: 12, w: 8, h: 4 },
    ],
  },
  {
    id: 'mac', name: 'Mac',
    items: [
      { instanceId: 'disk-map-1', widgetId: 'disk-map', x: 0, y: 0, w: 24, h: 12 },
      { instanceId: 'brightness-1', widgetId: 'brightness', x: 0, y: 12, w: 12, h: 4 },
      { instanceId: 'uptime-1', widgetId: 'uptime', x: 12, y: 12, w: 12, h: 4 },
      { instanceId: 'processes-1', widgetId: 'processes', x: 24, y: 0, w: 16, h: 8 },
      { instanceId: 'clipboard-1', widgetId: 'clipboard', x: 24, y: 8, w: 16, h: 8 },
      { instanceId: 'shortcuts-1', widgetId: 'shortcuts', x: 40, y: 0, w: 24, h: 8 },
      { instanceId: 'clock-2', widgetId: 'clock', x: 40, y: 8, w: 24, h: 8 },
    ],
  },
]

/** The bar: a clock and the weather on the left, Claude's limits and the CPU on the right. */
const NAV = [
  { instanceId: 'clock-bar', widgetId: 'clock', slot: 'left' as const },
  { instanceId: 'weather-bar', widgetId: 'weather', slot: 'left' as const },
  { instanceId: 'claude-usage-bar', widgetId: 'claude-usage', slot: 'right' as const },
  { instanceId: 'cpu-bar', widgetId: 'cpu', slot: 'right' as const },
]

/** The config a fresh demo data folder starts with. */
export function demoConfig(locale: 'fr' | 'en' = 'en'): Config {
  const widgets: Config['widgets'] = {}
  for (const item of [...PAGES.flatMap((p) => p.items), ...NAV]) {
    widgets[item.instanceId] = { widgetId: item.widgetId, showTitle: false, settings: structuredClone(DEMO_SETTINGS[item.widgetId] ?? {}) }
  }
  return {
    version: CONFIG_VERSION,
    theme: BUILTIN_THEME,
    connections: [
      ...DEMO_CALENDARS.map((c) => ({ id: c.id, type: 'ics', name: c.name, fields: { color: c.color } })),
      // For the Synology widgets of the Sietch: not on the dashboard, but there to pick.
      { id: DEMO_NAS.id, type: 'synology', name: DEMO_NAS.name, fields: { host: DEMO_NAS.host, account: DEMO_NAS.account } },
    ],
    // A file next to the config, never the keychain: a demo has nothing to keep secret.
    secrets: { backend: 'file' },
    locale,
    privacy: { claudeAccountUsage: true, showAccountEmail: false, codexAccount: true, codexHistorySources: ['cli', 'vscode', 'appServer'], macmonTemperature: false },
    marketplace: { installed: {} },
    // As on a fresh install: the iPad screens stay an experimental feature until it is ticked.
    labs: { devices: false, companion: false },
    widgets,
    screens: [{
      id: 'edge',
      name: 'Xeneon Edge',
      kind: 'edge',
      display: { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0, background: { image: DEFAULT_BACKGROUND, fit: 'cover' } },
      nav: NAV.map(({ instanceId, slot }) => ({ instanceId, slot })),
      pages: PAGES.map((p) => ({ id: p.id, name: p.name, items: p.items.map(({ instanceId, x, y, w, h }) => ({ instanceId, x, y, w, h })) })),
    }],
  }
}

/** Written into every demo data folder: the proof a folder is one demo mode may write into. */
export const DEMO_MARKER = '.fremkit-demo'

export class DemoDataDirError extends Error {}

/**
 * The data folder a demo server runs on.
 *
 * A temporary one unless `configured` names another, and never the live one: not the checkout's
 * `data/`, and not any folder that already holds a `fremkit.json` without the demo marker — a
 * demo seeds and writes its folder, and a user's real dashboard must not be what it writes over.
 * A fresh folder gets the marker and the demo dashboard; one that has both is reused as it is,
 * so changes made during a demo survive a restart of the same folder.
 */
export async function prepareDemoDataDir(opts: { configured?: string; liveDataDir: string; locale?: 'fr' | 'en' }): Promise<{ dir: string; temporary: boolean }> {
  let dir: string
  let temporary = false
  if (opts.configured) {
    dir = resolve(opts.configured)
    if (dir === resolve(opts.liveDataDir)) throw new DemoDataDirError(`refusing to run the demo on the live data folder ${dir}`)
    if (existsSync(join(dir, 'fremkit.json')) && !existsSync(join(dir, DEMO_MARKER))) {
      throw new DemoDataDirError(`${dir} holds a dashboard that is not a demo one; give the demo an empty folder`)
    }
    await mkdir(dir, { recursive: true, mode: 0o700 })
  } else {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-demo-'))
    temporary = true
  }
  if (!existsSync(join(dir, DEMO_MARKER))) await writeFile(join(dir, DEMO_MARKER), 'This folder belongs to a Fremkit demo server (FREMKIT_DEMO=1).\n')
  if (!existsSync(join(dir, 'fremkit.json'))) {
    await writeFile(join(dir, 'fremkit.json'), JSON.stringify(demoConfig(opts.locale), null, 2) + '\n')
    // The calendars' address is a required secret: without one the editor lists them as broken.
    // Never fetched — the demo connection types publish invented events.
    const secrets = new FileSecretStore(join(dir, 'secrets.json'))
    for (const c of DEMO_CALENDARS) await secrets.set(`${c.id}/url`, `https://calendar.example.com/${c.id}.ics`)
    await secrets.set(`${DEMO_NAS.id}/password`, 'demo')
  }
  return { dir, temporary }
}
