import { describe, expect, it, vi } from 'vitest'
import ICAL from 'ical.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  countEvents,
  createCalendarProvider,
  RETRY_AFTER_FAILURE_MS,
  DEFAULT_CALENDAR_COLOR,
  fetchIcs,
  IcsFetchError,
  MAX_ICS_BYTES,
  MAX_MASTERS,
  MAX_TIMEZONES,
  normalizeColor,
  NotACalendarError,
  parseCalendar,
  type CalSnapshot,
} from '../src/providers/calendar.js'
import { icsType } from '../src/connections/types/ics.js'
import { ConnectionTypeRegistry } from '../src/connections/registry.js'

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}.ics`, import.meta.url)), 'utf8')

const GOOGLE = fixture('calendar-google')
const OUTLOOK = fixture('calendar-outlook')
const MALFORMED = fixture('calendar-malformed')

/**
 * The fixtures live around this Monday, so the window is pinned rather than relative to today.
 * It is 30 days wide, which cuts the weekly series short: an occurrence past the window is one
 * of the things worth asserting.
 */
const MARCH = Date.UTC(2026, 2, 16, 8, 0, 0)
const WINDOW = { from: MARCH, to: MARCH + 30 * 24 * 3600_000 }
const opts = (over: Partial<{ calendar: string; color: string; from: number; to: number }> = {}) =>
  ({ calendar: 'cal-1', color: '#ff8800', ...WINDOW, ...over })

const iso = (ms: number): string => new Date(ms).toISOString()

const ok = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/calendar', ...headers } })

describe('normalizeColor', () => {
  it('keeps a six-digit hex and falls back on anything else', () => {
    expect(normalizeColor('#AABBCC')).toBe('#aabbcc')
    expect(normalizeColor('#abc')).toBe(DEFAULT_CALENDAR_COLOR)
    expect(normalizeColor('red')).toBe(DEFAULT_CALENDAR_COLOR)
    expect(normalizeColor(undefined)).toBe(DEFAULT_CALENDAR_COLOR)
  })
})

describe('parseCalendar, Google export', () => {
  const events = parseCalendar(GOOGLE, opts())

  it('reads a timed event with its location', () => {
    const standup = events.find((e) => e.title === 'Daily standup')
    expect(standup).toMatchObject({ allDay: false, location: 'Room One', calendar: 'cal-1', color: '#ff8800' })
    expect(iso(standup!.start)).toBe('2026-03-18T09:00:00.000Z')
    expect(iso(standup!.end)).toBe('2026-03-18T09:30:00.000Z')
  })

  it('marks a DATE-valued event as all-day', () => {
    const offsite = events.find((e) => e.title === 'Team offsite')
    expect(offsite?.allDay).toBe(true)
    // A DATE has no zone: it is the local day, whatever zone the machine runs in.
    expect(new Date(offsite!.start).getDate()).toBe(20)
  })

  it('expands the weekly rule, skips the EXDATE and keeps the moved instance', () => {
    const reviews = events.filter((e) => e.title.startsWith('Weekly review'))
    expect(reviews.map((r) => iso(r.start))).toEqual([
      '2026-03-16T14:00:00.000Z',
      '2026-03-23T16:30:00.000Z',
      '2026-04-06T14:00:00.000Z',
      '2026-04-13T14:00:00.000Z',
    ])
    // The moved one carries the override's own summary and location.
    expect(reviews[1]).toMatchObject({ title: 'Weekly review (moved)', location: 'Room Three' })
  })

  it('sorts by start and gives every occurrence its own id', () => {
    expect([...events].sort((a, b) => a.start - b.start)).toEqual(events)
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length)
  })

  it('drops what falls outside the window', () => {
    const narrow = parseCalendar(GOOGLE, opts({ to: Date.UTC(2026, 2, 19) }))
    expect(narrow.map((e) => e.title)).toEqual(['Weekly review', 'Daily standup'])
  })
})

describe('parseCalendar, Outlook export', () => {
  const events = parseCalendar(OUTLOOK, opts({ color: 'nonsense' }))

  it('resolves TZID=Europe/Paris against the VTIMEZONE it carries', () => {
    const kickoff = events.find((e) => e.title === 'Project kickoff')
    // 10:00 Paris in March is CET, UTC+1.
    expect(iso(kickoff!.start)).toBe('2026-03-18T09:00:00.000Z')
    expect(iso(kickoff!.end)).toBe('2026-03-18T10:30:00.000Z')
    expect(kickoff?.location).toBe('Paris office')
  })

  it('falls back to the default colour when the connection stores a broken one', () => {
    expect(events.every((e) => e.color === DEFAULT_CALENDAR_COLOR)).toBe(true)
  })

  it('expands the daily rule and drops the cancelled occurrence', () => {
    const syncs = events.filter((e) => e.title === 'Daily sync')
    expect(syncs).toHaveLength(9)
    expect(syncs.some((s) => iso(s.start) === '2026-03-19T08:00:00.000Z')).toBe(false)
    expect(syncs.some((s) => iso(s.start) === '2026-03-18T08:00:00.000Z')).toBe(true)
  })
})

describe('parseCalendar, malformed input', () => {
  it('refuses a document that is not a calendar', () => {
    expect(() => parseCalendar(MALFORMED, opts())).toThrow(NotACalendarError)
    expect(() => countEvents(MALFORMED)).toThrow(NotACalendarError)
  })

  it('refuses a VCARD, which parses but is not a calendar', () => {
    expect(() => parseCalendar('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Someone\r\nEND:VCARD\r\n', opts()))
      .toThrow(NotACalendarError)
  })

  it('counts the events of a real calendar', () => {
    expect(countEvents(GOOGLE)).toBe(4)
  })
})

describe('fetchIcs', () => {
  it('refuses anything that is not https', async () => {
    const fetchFn = vi.fn()
    await expect(fetchIcs('http://example.invalid/c.ics', fetchFn as unknown as typeof fetch))
      .rejects.toMatchObject({ reason: 'notHttps' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('follows up to three redirects', async () => {
    const seen: string[] = []
    const fetchFn = vi.fn(async (url: string) => {
      seen.push(url)
      if (seen.length <= 3) return new Response(null, { status: 302, headers: { location: `https://h.invalid/${seen.length}` } })
      return ok(GOOGLE)
    })
    await expect(fetchIcs('https://h.invalid/0', fetchFn as unknown as typeof fetch)).resolves.toContain('VCALENDAR')
    expect(seen).toHaveLength(4)
  })

  it('gives up past the fourth hop', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://h.invalid/next' } }))
    await expect(fetchIcs('https://h.invalid/0', fetchFn as unknown as typeof fetch))
      .rejects.toMatchObject({ reason: 'tooManyRedirects' })
  })

  it('refuses a redirect that drops to plain http', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://h.invalid/c.ics' } }))
    await expect(fetchIcs('https://h.invalid/0', fetchFn as unknown as typeof fetch))
      .rejects.toMatchObject({ reason: 'notHttps' })
  })

  it('reports the HTTP status of a refusal', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 404 }))
    await expect(fetchIcs('https://h.invalid/c.ics', fetchFn as unknown as typeof fetch))
      .rejects.toMatchObject({ reason: 'http', status: 404 })
  })

  it('refuses a body that announces itself as too large', async () => {
    const fetchFn = vi.fn(async () => ok('BEGIN:VCALENDAR', { 'content-length': String(MAX_ICS_BYTES + 1) }))
    await expect(fetchIcs('https://h.invalid/c.ics', fetchFn as unknown as typeof fetch))
      .rejects.toMatchObject({ reason: 'tooLarge' })
  })

  it('refuses a body that grows past the cap while it streams', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 6; i++) controller.enqueue(chunk)
        controller.close()
      },
    })
    const fetchFn = vi.fn(async () => new Response(body, { status: 200 }))
    await expect(fetchIcs('https://h.invalid/c.ics', fetchFn as unknown as typeof fetch))
      .rejects.toMatchObject({ reason: 'tooLarge' })
  })

  it('turns a network failure into a reason that does not quote the URL', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND https://secret.invalid/c.ics') })
    const err = await fetchIcs('https://secret.invalid/c.ics', fetchFn as unknown as typeof fetch).catch((e) => e)
    expect(err).toBeInstanceOf(IcsFetchError)
    expect(err.message).not.toContain('secret.invalid')
  })
})

describe('icsType', () => {
  it('declares the calendar channel family rather than its own id', () => {
    expect(icsType.channelPrefix).toBe('calendar')
  })

  it('reports the event count of a calendar it could read', async () => {
    const fetchFn = vi.fn(async () => ok(GOOGLE))
    const result = await icsType.test({}, { url: 'https://h.invalid/c.ics' }, { fetchFn: fetchFn as unknown as typeof fetch })
    expect(result).toMatchObject({ ok: true })
    expect((result as { detail: string }).detail).toContain('4')
  })

  it('reports a document that is not a calendar', async () => {
    const fetchFn = vi.fn(async () => ok(MALFORMED))
    const result = await icsType.test({}, { url: 'https://h.invalid/c.ics' }, { fetchFn: fetchFn as unknown as typeof fetch })
    expect(result).toMatchObject({ ok: false })
    expect((result as { error: string }).error).toMatch(/iCalendar/)
  })

  it('reports each fetch failure in its own words, never with the URL', async () => {
    const cases: [() => Promise<Response>, RegExp][] = [
      [async () => new Response('x', { status: 503 }), /503/],
      [async () => { throw new Error('boom https://secret.invalid') }, /injoignable|unreachable/],
      [async () => ok('x', { 'content-length': String(MAX_ICS_BYTES + 1) }), /5 M/],
    ]
    for (const [impl, matcher] of cases) {
      const result = await icsType.test({}, { url: 'https://secret.invalid/c.ics' }, { fetchFn: impl as unknown as typeof fetch })
      expect(result).toMatchObject({ ok: false })
      const error = (result as { error: string }).error
      expect(error).toMatch(matcher)
      expect(error).not.toContain('secret.invalid')
    }
  })

  it('refuses a colour that is not #rrggbb', () => {
    const types = new ConnectionTypeRegistry([icsType])
    expect(types.validate(icsType, { color: '#0a0b0c' }, { url: 'https://h.invalid/c.ics' }, () => false, 'en')).toEqual([])
    expect(types.validate(icsType, { color: 'blue' }, { url: 'https://h.invalid/c.ics' }, () => false, 'en'))
      .toEqual(['invalid colour for “Colour”: #rrggbb expected'])
  })

  it('describes the colour field as a colour', () => {
    const described = new ConnectionTypeRegistry([icsType]).describe('en')
    expect(described[0].fields.find((f) => f.key === 'color')?.color).toBe(true)
    expect(described[0].fields.find((f) => f.key === 'url')?.secret).toBe(true)
  })
})

describe('createCalendarProvider', () => {
  const ctx = { id: 'cal-1', channel: 'calendar:cal-1', fields: { color: '#112233' }, secrets: { url: 'https://h.invalid/c.ics' } }

  it('publishes the events of the window, stamped with the connection', async () => {
    const fetchFn = vi.fn(async () => ok(GOOGLE))
    const provider = createCalendarProvider(ctx, { fetchFn: fetchFn as unknown as typeof fetch, now: () => MARCH })
    const snapshot = await provider.poll!() as CalSnapshot
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.events.length).toBeGreaterThan(0)
    expect(snapshot.events.every((e) => e.calendar === 'cal-1' && e.color === '#112233')).toBe(true)
    expect(provider.channel).toBe('calendar:cal-1')
  })

  it('keeps the last snapshot and flags it offline when the fetch fails', async () => {
    let fail = false
    const fetchFn = vi.fn(async () => (fail ? new Response('slow down', { status: 429 }) : ok(GOOGLE)))
    const provider = createCalendarProvider(ctx, { fetchFn: fetchFn as unknown as typeof fetch, now: () => MARCH })
    const first = await provider.poll!() as CalSnapshot
    fail = true
    const second = await provider.poll!() as CalSnapshot
    expect(second.error).toBe('offline')
    expect(second.events).toEqual(first.events)
  })

  it('polls again sooner after a failure, then settles back to the slow rhythm', async () => {
    let fail = true
    const fetchFn = vi.fn(async () => (fail ? new Response('slow down', { status: 429 }) : ok(GOOGLE)))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = createCalendarProvider(ctx, { fetchFn: fetchFn as unknown as typeof fetch, now: () => MARCH })
    const slow = provider.intervalMs!
    await provider.poll!()
    expect(provider.intervalMs).toBe(RETRY_AFTER_FAILURE_MS)
    expect(provider.intervalMs).toBeLessThan(slow)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).not.toContain('h.invalid')
    fail = false
    await provider.poll!()
    expect(provider.intervalMs).toBe(slow)
    warn.mockRestore()
  })

  it('flags a document that stopped being a calendar', async () => {
    const fetchFn = vi.fn(async () => ok(MALFORMED))
    const provider = createCalendarProvider(ctx, { fetchFn: fetchFn as unknown as typeof fetch, now: () => MARCH })
    expect(await provider.poll!()).toEqual({ events: [], error: 'invalid' })
  })

  it('says so rather than dialling out when no URL is stored', async () => {
    const fetchFn = vi.fn()
    const provider = createCalendarProvider({ ...ctx, secrets: {} }, { fetchFn: fetchFn as unknown as typeof fetch })
    expect(await provider.poll!()).toEqual({ events: [], error: 'unconfigured' })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('the bounds on one calendar file', () => {
  const ics = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//\r\n${body}END:VCALENDAR\r\n`
  const event = (i: number) =>
    `BEGIN:VEVENT\r\nUID:e-${i}\r\nDTSTART:20260101T090000Z\r\nDTEND:20260101T100000Z\r\nSUMMARY:E${i}\r\nEND:VEVENT\r\n`

  it('reads at most MAX_MASTERS series out of a file', () => {
    // Each master can expand to MAX_OCCURRENCES, so the two would otherwise multiply.
    let body = ''
    for (let i = 0; i < MAX_MASTERS + 25; i++) body += event(i)
    const from = Date.UTC(2025, 11, 1)
    const to = Date.UTC(2026, 11, 1)
    const events = parseCalendar(ics(body), { calendar: 'c1', color: DEFAULT_CALENDAR_COLOR, from, to })
    // MAX_EVENTS still applies on top, so this only asserts it did not choke and stayed bounded.
    expect(events.length).toBeLessThanOrEqual(MAX_MASTERS)
  })

  it('registers at most MAX_TIMEZONES zones from a remote file', () => {
    // TimezoneService is process-wide, so a remote file writes into global state.
    let body = ''
    for (let i = 0; i < MAX_TIMEZONES + 10; i++) {
      body += `BEGIN:VTIMEZONE\r\nTZID:Fremkit/Zone-${i}\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0000\r\nTZOFFSETTO:+0000\r\nTZNAME:Z\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n`
    }
    body += event(1)
    parseCalendar(ics(body), { calendar: 'c1', color: DEFAULT_CALENDAR_COLOR, from: Date.UTC(2025, 11, 1), to: Date.UTC(2026, 11, 1) })
    const registered = Array.from({ length: MAX_TIMEZONES + 10 }, (_, i) => `Fremkit/Zone-${i}`)
      .filter((tzid) => ICAL.TimezoneService.has(tzid))
    expect(registered.length).toBeLessThanOrEqual(MAX_TIMEZONES)
  })
})
