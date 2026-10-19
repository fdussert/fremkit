/**
 * The invented machine demo mode describes: what it is called, what it runs, what is on its disk.
 *
 * Everything here is made up and generic on purpose (AGENTS.md, "generic by design"): placeholder
 * names, `example.com`, documentation address ranges. The same values feed the providers, the
 * seeded dashboard and the widget previews, so a screenshot taken anywhere shows one coherent
 * machine rather than three.
 *
 * Pure: no I/O, no clock of its own. Whatever moves takes `now` as an argument, so a test can
 * freeze time and a GIF can see it move.
 */

/** A value that wanders smoothly around `base`: two slow sines, out of step, never random. */
export function wander(now: number, base: number, amplitude: number, periodMs: number, phase = 0): number {
  const t = now / periodMs + phase
  return base + amplitude * (0.65 * Math.sin(t * 2 * Math.PI) + 0.35 * Math.sin(t * 2 * Math.PI * 2.7 + 1.3))
}

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
export const round1 = (n: number): number => Math.round(n * 10) / 10

/** Applications the demo Dock shows, with the badge each one carries. */
export const DEMO_APPS = [
  { bundleId: 'com.example.mail', name: 'Mail', badge: '3', hue: 210, glyph: 'envelope' },
  { bundleId: 'com.example.chat', name: 'Chat', badge: '12', hue: 265, glyph: 'bubble' },
  { bundleId: 'com.example.calendar', name: 'Calendar', badge: null, hue: 0, glyph: 'grid' },
  { bundleId: 'com.example.tasks', name: 'Tasks', badge: '•', hue: 140, glyph: 'check' },
  { bundleId: 'com.example.music', name: 'Music', badge: null, hue: 330, glyph: 'ring' },
  { bundleId: 'com.example.notes', name: 'Notes', badge: null, hue: 45, glyph: 'bars' },
] as const

export type DemoGlyph = typeof DEMO_APPS[number]['glyph']

/** The ICS calendars the demo dashboard is seeded with. Their ids are what the calendar widget selects. */
export const DEMO_CALENDARS = [
  { id: 'demo-work', name: 'Work', color: '#4f8cff' },
  { id: 'demo-home', name: 'Home', color: '#e0a03c' },
] as const

/** The Synology NAS the demo dashboard is connected to. Never contacted: its channel is invented. */
export const DEMO_NAS = { id: 'demo-nas', name: 'NAS', host: '192.0.2.10', account: 'fremkit' } as const

/** Hours after local midnight, and how long, for each calendar's recurring events. */
const WORK_EVENTS = [
  { title: 'Weekly sync', at: 9.5, minutes: 30, location: 'Room 2' },
  { title: 'Design review', at: 11, minutes: 60, location: 'Studio' },
  { title: 'Lunch with the team', at: 12.5, minutes: 60, location: '' },
  { title: 'Release planning', at: 14, minutes: 45, location: 'Video call' },
  { title: 'Customer demo', at: 16, minutes: 30, location: 'Video call' },
  { title: '1:1 with Alex', at: 17, minutes: 30, location: '' },
]
const HOME_EVENTS = [
  { title: 'Gym', at: 7, minutes: 60, location: 'Riverside club' },
  { title: 'Pick up the parcel', at: 18.5, minutes: 15, location: '' },
  { title: 'Dinner with Sam', at: 20, minutes: 90, location: 'Bistro 12' },
]

/** Today's events, in minutes from the start of the current hour. */
const TODAY_WORK = [
  { title: 'Weekly sync', in: -10, minutes: 40, location: 'Room 2' },
  { title: 'Design review', in: 60, minutes: 60, location: 'Studio' },
  { title: 'Release planning', in: 150, minutes: 45, location: 'Video call' },
  { title: 'Customer demo', in: 240, minutes: 30, location: 'Video call' },
]
const TODAY_HOME = [
  { title: 'Pick up the parcel', in: 100, minutes: 15, location: '' },
  { title: 'Dinner with Sam', in: 300, minutes: 90, location: 'Bistro 12' },
]

export interface DemoEvent {
  id: string; title: string; start: number; end: number; allDay: boolean
  location?: string; calendar: string; color: string
}

function localMidnight(now: number, dayOffset: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + dayOffset)
  return d.getTime()
}

/**
 * The events of one demo calendar for the week ahead, relative to `now` so the list is never
 * empty whatever day it is run on. An unknown id gets a short generic calendar of its own.
 */
export function demoEvents(calendarId: string, color: string, now: number): DemoEvent[] {
  const events: DemoEvent[] = []
  const template = calendarId === 'demo-home' ? HOME_EVENTS : WORK_EVENTS
  // Today is relative to now, whatever the hour: a capture taken at night still shows a busy
  // afternoon ahead rather than one dinner. The days after follow the template's own hours.
  const hour = Math.floor(now / 3_600_000) * 3_600_000
  const today = calendarId === 'demo-home' ? TODAY_HOME : TODAY_WORK
  today.forEach((ev, i) => {
    const start = hour + ev.in * 60_000
    events.push({
      id: `${calendarId}-0-${i}`, title: ev.title, start, end: start + ev.minutes * 60_000, allDay: false,
      ...(ev.location ? { location: ev.location } : {}), calendar: calendarId, color,
    })
  })
  for (let day = 1; day < 7; day++) {
    const midnight = localMidnight(now, day)
    const weekday = new Date(midnight).getDay()
    const weekend = weekday === 0 || weekday === 6
    if (calendarId !== 'demo-home' && weekend) continue
    template.forEach((ev, i) => {
      // Not every event every day: a calendar that repeats itself exactly looks fake.
      if ((day + i) % 3 === 2) return
      const start = midnight + ev.at * 3_600_000
      events.push({
        id: `${calendarId}-${day}-${i}`,
        title: ev.title,
        start,
        end: start + ev.minutes * 60_000,
        allDay: false,
        ...(ev.location ? { location: ev.location } : {}),
        calendar: calendarId,
        color,
      })
    })
    if (calendarId === 'demo-home' && day === 2) {
      events.push({ id: `${calendarId}-${day}-allday`, title: 'Public holiday', start: midnight, end: midnight + 86_400_000, allDay: true, calendar: calendarId, color })
    }
  }
  return events.sort((a, b) => a.start - b.start)
}

/** Playlist of the demo music player: invented titles, invented artists. */
export const DEMO_TRACKS = [
  { title: 'Northern Lights', artist: 'The Placeholders', album: 'Example Sessions', durationMs: 214_000, hue: 200 },
  { title: 'Paper Planes at Dawn', artist: 'Lorem & Ipsum', album: 'Dolor Sit', durationMs: 187_000, hue: 20 },
  { title: 'Signal / Noise', artist: 'Demo Unit', album: 'Test Pattern', durationMs: 243_000, hue: 290 },
]

/** An album cover: a gradient square as a `data:` SVG, which the widget CSP already allows. */
export function coverArt(hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="hsl(${hue},70%,58%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},65%,28%)"/>`
    + `</linearGradient></defs><rect width="300" height="300" fill="url(#g)"/>`
    + `<circle cx="150" cy="150" r="78" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="10"/>`
    + `<circle cx="150" cy="150" r="22" fill="rgba(255,255,255,.75)"/></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

/** The demo's processes, with the share of CPU each one hovers around. */
export const DEMO_PROCESSES = [
  { pid: 412, name: 'Browser', cpu: 18, mem: 6.2 },
  { pid: 1033, name: 'Code Editor', cpu: 11, mem: 4.8 },
  { pid: 877, name: 'Music', cpu: 4, mem: 1.6 },
  { pid: 2210, name: 'node', cpu: 7, mem: 2.1 },
  { pid: 98, name: 'WindowServer', cpu: 6, mem: 1.2 },
  { pid: 1502, name: 'Chat', cpu: 3, mem: 2.4 },
  { pid: 330, name: 'Photos', cpu: 1.5, mem: 3.1 },
  { pid: 2671, name: 'Terminal', cpu: 1.2, mem: 0.6 },
  { pid: 154, name: 'Spotlight', cpu: 0.8, mem: 0.9 },
  { pid: 611, name: 'Finder', cpu: 0.5, mem: 0.7 },
]

/** What the demo clipboard history holds; none of it looks like a secret except the one that should. */
export const DEMO_CLIPBOARD = [
  { preview: 'https://example.com/docs/getting-started', minutesAgo: 2, masked: false },
  { preview: 'Meeting moved to 3 pm, same room', minutesAgo: 9, masked: false },
  { preview: '••••••••', minutesAgo: 21, masked: true },
  { preview: 'git switch -c feature/new-widget', minutesAgo: 34, masked: false },
  { preview: '198.51.100.24', minutesAgo: 58, masked: false },
  { preview: 'Thanks, looks great — ship it!', minutesAgo: 75, masked: false },
]

/** The demo Claude Code sessions, as the sessions card draws them. */
export const DEMO_SESSIONS = [
  { project: 'website', title: 'Pricing page', branch: 'feature/pricing', state: 'working', tool: 'Edit', toolDetail: 'src/pages/pricing.vue', model: 'Opus', minutesAgo: 3, pct: 41 },
  { project: 'api', title: 'Rate limits', branch: 'feature/rate-limit', state: 'permission', tool: 'Bash', toolDetail: 'pnpm test', model: 'Sonnet', minutesAgo: 1, pct: 63 },
  { project: 'docs', title: 'Quick start', branch: 'main', state: 'done', model: 'Opus', minutesAgo: 12, pct: 28, lastMessage: 'The quick start now covers the three install paths.' },
  { project: 'mobile-app', title: 'Flaky login', branch: 'hotfix/login', state: 'idle', model: 'Sonnet', minutesAgo: 40, pct: 12 },
] as const
