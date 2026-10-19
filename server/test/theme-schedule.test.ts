import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { ConfigSchema, type Config } from '../src/config/schema.js'
import { createThemeProvider, deviceThemeView, themeInForce } from '../src/themes/schedule.js'
import { buildApp } from '../src/app.js'

/** A local wall-clock instant, so the fixed-time cases hold in any time zone. */
const local = (h: number, m = 0, day = 18, month = 9): number => new Date(2026, month, day, h, m).getTime()

const config = (extra: object = {}): Config => ConfigSchema.parse({
  version: 4,
  theme: 'fremkit',
  screens: [{ id: 'edge', name: 'Edge', kind: 'edge', pages: [{ id: 'p', name: 'P' }] }],
  ...extra,
})

describe('themeInForce', () => {
  it('is the one theme, day and night, when there is no schedule', () => {
    for (const h of [3, 12, 23]) expect(themeInForce(config(), local(h))).toEqual({ id: 'fremkit', phase: 'day', scheduled: false })
  })

  it('switches at fixed times, at once, on the Mac clock', () => {
    const c = config({ themeSchedule: { night: 'edge', schedule: 'fixed', dayAt: '07:00', nightAt: '21:00' } })
    expect(themeInForce(c, local(12))).toMatchObject({ id: 'fremkit', phase: 'day', scheduled: true, next: { to: 'night' } })
    expect(new Date(themeInForce(c, local(12)).next!.at).getTime()).toBe(local(21))
    // No ramp: one minute after the switch is already the night theme.
    expect(themeInForce(c, local(20, 59))).toMatchObject({ id: 'fremkit', phase: 'day' })
    expect(themeInForce(c, local(21, 0))).toMatchObject({ id: 'edge', phase: 'night' })
    expect(themeInForce(c, local(3))).toMatchObject({ id: 'edge', phase: 'night', next: { to: 'day' } })
    expect(themeInForce(c, local(7, 1))).toMatchObject({ id: 'fremkit', phase: 'day' })
  })

  it('follows sunrise and sunset at the place typed', () => {
    // Paris on the summer solstice: the sun is up at noon UTC and down at midnight UTC.
    const c = config({ themeSchedule: { night: 'edge', latitude: 48.8566, longitude: 2.3522 } })
    expect(themeInForce(c, Date.UTC(2026, 5, 21, 12))).toMatchObject({ id: 'fremkit', phase: 'day' })
    expect(themeInForce(c, Date.UTC(2026, 5, 21, 23, 30))).toMatchObject({ id: 'edge', phase: 'night' })
    // Sunset in Paris that day is about 19:58 UTC.
    const at = new Date(themeInForce(c, Date.UTC(2026, 5, 21, 12)).next!.at)
    expect(Math.abs(at.getTime() - Date.UTC(2026, 5, 21, 19, 58))).toBeLessThan(5 * 60_000)
  })

  it('keeps the day theme, and says why, when the sun schedule has no place yet', () => {
    const c = config({ themeSchedule: { night: 'edge' } })
    expect(themeInForce(c, local(23))).toEqual({ id: 'fremkit', phase: 'day', scheduled: true, problem: 'no-location' })
  })

  it('stays on the night theme through a polar night', () => {
    const c = config({ themeSchedule: { night: 'edge', latitude: 78.22, longitude: 15.65 } })
    expect(themeInForce(c, Date.UTC(2026, 11, 21, 12))).toMatchObject({ id: 'edge', phase: 'night' })
    expect(themeInForce(c, Date.UTC(2026, 5, 21, 0))).toMatchObject({ id: 'fremkit', phase: 'day' })
  })

  it('names the night id as written, unknown or not: the page falls back as it does for `theme`', () => {
    const c = config({ themeSchedule: { night: 'gone', schedule: 'fixed' } })
    expect(themeInForce(c, local(23)).id).toBe('gone')
  })
})

describe('theme provider', () => {
  it('publishes the theme in force on the `theme` channel, from the config as it is now', async () => {
    let c = config()
    const p = createThemeProvider(() => c, () => local(23))
    expect(p.channel).toBe('theme')
    expect(await p.poll!()).toMatchObject({ id: 'fremkit', phase: 'day' })
    c = config({ themeSchedule: { night: 'edge', schedule: 'fixed' } })
    expect(await p.poll!()).toMatchObject({ id: 'edge', phase: 'night' })
  })
})

describe('GET /api/themes', () => {
  let dataDir: string
  let app: FastifyInstance
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'fremkit-theme-schedule-'))
    // Night all day long: the same time twice is read as "always day" by the schedule, so the
    // night starts one minute after the day does.
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const minus = new Date(now.getTime() - 2 * 60_000)
    const plus = new Date(now.getTime() - 60_000)
    const cfg = config({ themeSchedule: {
      night: 'edge', schedule: 'fixed',
      dayAt: `${pad(minus.getHours())}:${pad(minus.getMinutes())}`, nightAt: `${pad(plus.getHours())}:${pad(plus.getMinutes())}`,
    } })
    await writeFile(join(dataDir, 'fremkit.json'), JSON.stringify(cfg), 'utf8')
    app = await buildApp({ accessToken: null, dataDir, widgetsDir: join(process.cwd(), '..', 'widgets'), providers: [], connectionTypes: [] })
  })
  afterEach(async () => { await app.close() })

  it('carries the theme in force, so the first paint is already the right one', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/themes' })
    expect(res.statusCode).toBe(200)
    expect(res.json().inForce).toMatchObject({ id: 'edge', phase: 'night', scheduled: true })
    expect(res.json().inForce.next).toMatchObject({ to: 'day' })
  })

  it('gives a request from off this Mac the theme in force without the time of the next switch', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/themes', remoteAddress: '192.0.2.10' })
    expect(res.statusCode).toBe(200)
    expect(res.json().inForce).toEqual({ id: 'edge', phase: 'night', scheduled: true })
  })
})

describe('deviceThemeView', () => {
  it('keeps the theme and its phase and drops the next switch', () => {
    const snapshot = { id: 'edge', phase: 'night', scheduled: true, next: { at: '2026-10-19T06:12:00.000Z', to: 'day' } }
    expect(deviceThemeView(snapshot)).toEqual({ id: 'edge', phase: 'night', scheduled: true })
    expect(deviceThemeView(null)).toBeNull()
  })
})
