import ICAL from 'ical.js'
import type { ConnectionProviderContext } from '../connections/types.js'
import type { Provider } from './types.js'
import { USER_AGENT } from '../version.js'

/**
 * How long one GET of the ICS document may take. Outlook builds a published calendar on demand
 * and a large one takes well over ten seconds the first time; the next reads come from its cache.
 */
export const ICS_TIMEOUT_MS = 30_000
/** Published calendars change slowly and the file is fetched whole every time. */
const POLL_EVERY_MS = 5 * 60_000
/** After a failed read the next try comes sooner: a cold Outlook or a Wi-Fi blink should not cost five minutes. */
export const RETRY_AFTER_FAILURE_MS = 30_000
/** A published calendar is a plain file: anything bigger than this is not one we want to hold. */
export const MAX_ICS_BYTES = 5 * 1024 * 1024
/** Redirects are followed by hand, so every hop can be checked for https. */
export const MAX_REDIRECTS = 3

/** The window the snapshot covers, relative to now. */
export const WINDOW_PAST_MS = 60 * 60_000
export const WINDOW_AHEAD_MS = 14 * 24 * 60 * 60_000
/** How many events one snapshot carries at most, after sorting. */
export const MAX_EVENTS = 200
/**
 * A guard on the recurrence walk: a daily rule started years ago still reaches the window in a
 * few thousand steps, and a rule that never does must not spin forever.
 */
const MAX_OCCURRENCES = 5_000

/** The colour an event falls back to when the connection stores none, or stores a broken one. */
export const DEFAULT_CALENDAR_COLOR = '#5b8def'
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

export const normalizeColor = (value: string | undefined): string =>
  value && COLOR_RE.test(value) ? value.toLowerCase() : DEFAULT_CALENDAR_COLOR

/** One occurrence, already resolved to wall-clock milliseconds on this machine. */
export interface CalEvent {
  id: string
  title: string
  start: number
  end: number
  allDay: boolean
  location?: string
  /** The connection the event came from, so a widget can tell two calendars apart. */
  calendar: string
  color: string
}

/**
 * What the `calendar:<id>` channel publishes.
 *
 * No timestamp, like the Azure DevOps snapshot: a fresh `updatedAt` in every payload would defeat
 * the registry's dedup and wake every subscriber for a calendar that did not change.
 */
export interface CalSnapshot { events: CalEvent[]; error?: string }

/** Why a fetch of the ICS document did not produce a calendar. The type turns these into prose. */
export type IcsFailure = 'unreachable' | 'notHttps' | 'tooLarge' | 'tooManyRedirects' | 'http'

export class IcsFetchError extends Error {
  constructor(readonly reason: IcsFailure, readonly status = 0) {
    // The message never carries the URL: it is a secret, and errors end up in logs.
    super(`ics ${reason}${status ? ` ${status}` : ''}`)
    this.name = 'IcsFetchError'
  }
}

/** Reads a response body, refusing anything past the cap before it is buffered whole. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) {
    const text = await res.text()
    if (Buffer.byteLength(text) > MAX_ICS_BYTES) throw new IcsFetchError('tooLarge')
    return text
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    size += value.byteLength
    if (size > MAX_ICS_BYTES) {
      await reader.cancel().catch(() => { /* already closed */ })
      throw new IcsFetchError('tooLarge')
    }
    chunks.push(value)
  }
  return Buffer.from(Buffer.concat(chunks)).toString('utf8')
}

const discard = (res: Response): Promise<void> => res.body?.cancel().catch(() => { /* already closed */ }) ?? Promise.resolve()

/**
 * Downloads a published calendar.
 *
 * Redirects are followed by hand rather than by `fetch`, because every hop has to be checked
 * for https: a published link that bounces through plain http would put the secret URL — and the
 * whole calendar — on the wire in the clear.
 */
export async function fetchIcs(url: string, fetchFn: typeof fetch = fetch): Promise<string> {
  let target = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL
    try { parsed = new URL(target) } catch { throw new IcsFetchError('notHttps') }
    if (parsed.protocol !== 'https:') throw new IcsFetchError('notHttps')

    let res: Response
    try {
      res = await fetchFn(target, {
        redirect: 'manual',
        headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(ICS_TIMEOUT_MS),
      })
    } catch {
      // Never the error itself: its message quotes the URL, and the URL is the secret.
      throw new IcsFetchError('unreachable')
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      await discard(res)
      if (!location) throw new IcsFetchError('http', res.status)
      try { target = new URL(location, parsed).toString() } catch { throw new IcsFetchError('notHttps') }
      continue
    }
    if (!res.ok) {
      await discard(res)
      throw new IcsFetchError('http', res.status)
    }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_ICS_BYTES) {
      await discard(res)
      throw new IcsFetchError('tooLarge')
    }
    return readCapped(res)
  }
  throw new IcsFetchError('tooManyRedirects')
}

/** Thrown when the downloaded document is not an iCalendar one. */
export class NotACalendarError extends Error {
  constructor() { super('not a calendar'); this.name = 'NotACalendarError' }
}

type IcalComponent = InstanceType<typeof ICAL.Component>
type IcalTime = InstanceType<typeof ICAL.Time>

/** Parses the document into its VCALENDAR root, registering the time zones it carries. */
function readCalendar(ics: string): IcalComponent {
  let root: IcalComponent
  try {
    root = new ICAL.Component(ICAL.parse(ics))
  } catch {
    throw new NotACalendarError()
  }
  if (root.name !== 'vcalendar') throw new NotACalendarError()
  // An Outlook export carries the definition of every zone it uses; without registering them a
  // TZID=Europe/Paris would silently be read as floating local time.
  for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
    const tzid = String(vtimezone.getFirstPropertyValue('tzid') ?? '')
    if (!tzid || ICAL.TimezoneService.has(tzid)) continue
    try { ICAL.TimezoneService.register(new ICAL.Timezone(vtimezone)) } catch { /* keep the others */ }
  }
  return root
}

/** True when the component says this occurrence was called off. */
const isCancelled = (component: IcalComponent): boolean =>
  String(component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED'

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** How many VEVENTs the document holds: what the connection test reports. */
export function countEvents(ics: string): number {
  return readCalendar(ics).getAllSubcomponents('vevent').length
}

export interface ParseOptions {
  /** The connection id stamped on every event. */
  calendar: string
  color: string
  /** Window bounds in epoch milliseconds; an event is kept when it overlaps them. */
  from: number
  to: number
}

/**
 * Expands a published calendar into the occurrences that fall inside the window.
 *
 * Recurrence is walked occurrence by occurrence rather than computed: `ICAL.Event` already
 * applies EXDATE and swaps in the RECURRENCE-ID overrides, so the walk only has to stop once it
 * is past the window and drop what the file marks as cancelled.
 */
export function parseCalendar(ics: string, opts: ParseOptions): CalEvent[] {
  const root = readCalendar(ics)
  const color = normalizeColor(opts.color)
  const vevents = root.getAllSubcomponents('vevent')

  // Overrides are the components carrying a RECURRENCE-ID; they belong to the master of same UID,
  // and stand on their own when that master is not in the file.
  const masters: IcalComponent[] = []
  const overrides = new Map<string, IcalComponent[]>()
  for (const vevent of vevents) {
    const uid = String(vevent.getFirstPropertyValue('uid') ?? '')
    if (vevent.getFirstProperty('recurrence-id')) {
      const list = overrides.get(uid)
      if (list) list.push(vevent)
      else overrides.set(uid, [vevent])
    } else {
      masters.push(vevent)
    }
  }
  const claimed = new Set<string>()

  const out: CalEvent[] = []
  const push = (
    id: string,
    component: IcalComponent,
    startTime: IcalTime,
    endTime: IcalTime,
    summary: string,
    location: string,
  ): void => {
    if (isCancelled(component)) return
    const start = startTime.toJSDate().getTime()
    let end = endTime.toJSDate().getTime()
    if (!Number.isFinite(start) || !Number.isFinite(end)) return
    // A zero-length event still has to be drawable, and an all-day one that ends where it starts
    // is a one-day event written the short way.
    if (end < start) end = start
    if (end <= opts.from || start >= opts.to) return
    const event: CalEvent = {
      id,
      // An empty summary is left empty: naming it is the widget's business, in its language.
      title: summary,
      start,
      end,
      allDay: startTime.isDate === true,
      calendar: opts.calendar,
      color,
    }
    if (location) event.location = location
    out.push(event)
  }

  for (const vevent of masters) {
    const uid = String(vevent.getFirstPropertyValue('uid') ?? '')
    const exceptions = overrides.get(uid) ?? []
    claimed.add(uid)
    let event: InstanceType<typeof ICAL.Event>
    try {
      event = new ICAL.Event(vevent, { exceptions })
    } catch {
      continue
    }
    const summary = text(event.summary)
    const location = text(event.location)

    if (!event.isRecurring()) {
      if (!event.startDate || !event.endDate) continue
      push(uid, vevent, event.startDate, event.endDate, summary, location)
      continue
    }

    let iterator: ReturnType<typeof event.iterator>
    try { iterator = event.iterator() } catch { continue }
    for (let seen = 0; seen < MAX_OCCURRENCES; seen++) {
      let next: IcalTime | null
      try { next = iterator.next() } catch { break }
      if (!next) break
      if (next.toJSDate().getTime() >= opts.to) break
      let details: ReturnType<typeof event.getOccurrenceDetails>
      try { details = event.getOccurrenceDetails(next) } catch { continue }
      // `item` is the override when one applies, the master otherwise: STATUS and the moved
      // times both have to be read off it rather than off the series.
      const item = details.item
      push(
        `${uid}@${details.recurrenceId.toICALString()}`,
        item.component,
        details.startDate,
        details.endDate,
        text(item.summary) || summary,
        text(item.location) || location,
      )
    }
  }

  // An override whose series is not in the file is all we know of that event: keep it.
  for (const [uid, list] of overrides) {
    if (claimed.has(uid)) continue
    for (const vevent of list) {
      let event: InstanceType<typeof ICAL.Event>
      try { event = new ICAL.Event(vevent) } catch { continue }
      if (!event.startDate || !event.endDate) continue
      push(`${uid}@${event.recurrenceId?.toICALString() ?? ''}`, vevent, event.startDate, event.endDate, text(event.summary), text(event.location))
    }
  }

  out.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title))
  return out.slice(0, MAX_EVENTS)
}

export interface CalendarProviderDeps {
  fetchFn?: typeof fetch
  now?: () => number
}

/**
 * One provider per configured ICS connection, on the channel `calendar:<id>`.
 *
 * A failed refresh keeps the last snapshot and flags it `offline`, the way the Azure DevOps
 * provider does: a dashboard showing this morning's agenda dimmed is better than an empty one
 * because the Wi-Fi blinked.
 */
export function createCalendarProvider(ctx: ConnectionProviderContext, deps: CalendarProviderDeps = {}): Provider {
  const fetchFn = deps.fetchFn ?? fetch
  const now = deps.now ?? Date.now
  const url = ctx.secrets.url ?? ''
  const color = normalizeColor(ctx.fields.color)
  let last: CalSnapshot = { events: [] }
  let failed = false

  return {
    channel: ctx.channel,
    // The registry reads this before every wait, so a failure shortens the next one.
    get intervalMs() { return failed ? RETRY_AFTER_FAILURE_MS : POLL_EVERY_MS },

    async poll(): Promise<CalSnapshot> {
      if (!url) return { events: [], error: 'unconfigured' }
      let ics: string
      try {
        ics = await fetchIcs(url, fetchFn)
        failed = false
      } catch (err) {
        // Unreachable, throttled, a 5xx: temporary, so the last agenda stays on screen.
        failed = true
        const reason = err instanceof IcsFetchError ? `${err.reason}${err.status ? ' ' + err.status : ''}` : 'unknown'
        console.warn(`[calendar:${ctx.id}] fetch failed (${reason}); retrying in ${RETRY_AFTER_FAILURE_MS / 1000} s`)
        return { ...last, error: 'offline' }
      }
      const t = now()
      try {
        last = { events: parseCalendar(ics, { calendar: ctx.id, color, from: t - WINDOW_PAST_MS, to: t + WINDOW_AHEAD_MS }) }
      } catch {
        return { ...last, error: 'invalid' }
      }
      return last
    },
  }
}
