import { clip, homePath, pathOf } from './devlog.js'

// A dev tab's bug report, in Markdown: what the Edge copies (`dev.report`, through the server) and
// what the popup copies. Pure: the words, the time and the date are the caller's (chrome.i18n and
// the browser's locale in the worker), so a test reads the exact text.
//
// The tab is lib/devtabs.js's internal one, stacks included: they leave the worker only here. A
// build entry's full path stays in the worker too: the report writes its home folder `~/` (homePath).

/** The longest report text; the server refuses a longer one (REPORT_MAX in server/src/companion/protocol.ts). */
export const REPORT_MAX = 48_000
/** The whole `dev.report`, JSON-encoded: the socket closes on a message over 65 536 bytes. */
const MESSAGE_MAX_BYTES = 60_000
const MAX_FIELD = 300

/** One line of Markdown: no line break from the page can open a heading or a list item. */
const line = (s, max = MAX_FIELD) => clip(String(s ?? '').replace(/\s*[\r\n]+\s*/g, ' '), max)
/** A line that may name a file on this Mac: its home folder is `~/`. */
const homeLine = (s, max = MAX_FIELD) => line(homePath(String(s ?? '')), max)
const isPos = (v) => Number.isInteger(v) && v >= 1

function entryLines(e, { stack, t, time }) {
  const count = e.n > 1 ? `×${e.n} ` : ''
  const state = e.state === 'seen' ? ` (${t('stateSeen')})` : e.state === 'resolved' ? ` (${t('stateResolved')})` : ''
  const at = time(e.at)
  switch (e.kind) {
    case 'error': {
      const out = [`- ${at} ${count}${homeLine(e.text)}${state}`]
      if (typeof e.origin === 'string' && e.origin !== '') out.push(`  at ${line(e.origin)}`)
      // The first frame is the origin already.
      if (stack && Array.isArray(e.stack)) for (const frame of e.stack.slice(1)) out.push(`    ${line(frame, Infinity)}`)
      return out
    }
    case 'request':
      return [`- ${at} ${count}${line(e.method)} ${line(e.path)} ${e.status > 0 ? e.status : t('noAnswer')}${state}`]
    case 'limited':
      return [`- ${at} +${e.n} ${t('reportLimited')}${state}`]
    case 'build': {
      const out = [`- ${at} ${count}${homeLine(e.text)}${state}`]
      if (typeof e.path === 'string' && e.path !== '') {
        const pos = isPos(e.line) ? `:${e.line}${isPos(e.col) ? `:${e.col}` : ''}` : ''
        out.push(`  at ${homeLine(e.path)}${pos}`)
      }
      return out
    }
    default:
      return []
  }
}

function render(tab, entries, opts) {
  const { t, date, now } = opts
  const host = line(tab.host)
  const title = line(tab.title || tab.host)
  const out = [
    `## ${t('reportTitle')}: ${title} (${host}${line(pathOf(tab.url))})`,
    `${date(now)} · ${t('reportServer')}: ${tab.server === 'down' ? 'down' : 'up'}`,
    t('reportLines'),
  ]
  const builds = entries.filter((e) => e.kind === 'build')
  const errors = entries.filter((e) => e.kind === 'error' || e.kind === 'limited')
  const requests = entries.filter((e) => e.kind === 'request')
  // The compile error first: while it shows, nothing else on the page is current.
  if (builds.length > 0) {
    out.push('', `### ${t('reportBuild')}`)
    for (const e of builds) out.push(...entryLines(e, opts))
  }
  if (errors.length > 0) {
    out.push('', `### ${t('reportErrors', tab.errors?.open ?? 0, tab.errors?.total ?? 0)}`)
    for (const e of errors) out.push(...entryLines(e, opts))
  }
  if (requests.length > 0) {
    out.push('', `### ${t('reportRequests')}`)
    for (const e of requests) out.push(...entryLines(e, opts))
  }
  return out.join('\n')
}

/**
 * The report of `tab`, newest entries first. Over `max` characters (or refused by `fits`), the
 * oldest entries go first, then the stacks, and last the text is cut.
 */
export function buildReport(tab, { stack = false, now, t, time, date, max = REPORT_MAX, fits = () => true }) {
  const ok = (text) => text.length <= max && fits(text)
  let entries = Array.isArray(tab.history) ? [...tab.history] : []
  let withStack = stack
  let text = render(tab, entries, { stack: withStack, now, t, time, date })
  while (!ok(text) && (entries.length > 1 || withStack)) {
    if (entries.length > 1) entries = entries.slice(0, -1)
    else withStack = false
    text = render(tab, entries, { stack: withStack, now, t, time, date })
  }
  // Only a caller's odd `fits` gets here: the header and one bounded entry fit any sane budget.
  while (!ok(text) && text.length > 0) text = clip(text, Math.min(max, Math.floor(text.length * 0.9)))
  return text
}

const encoder = new TextEncoder()

/** The `dev.report` answering a `dev.report.ask`, its text cut until the whole message fits the socket. */
export function reportMessage(id, tabId, tab, opts) {
  const msg = (text) => ({ type: 'dev.report', id, tabId, text })
  const fits = (text) => encoder.encode(JSON.stringify(msg(text))).length <= MESSAGE_MAX_BYTES
  return msg(buildReport(tab, { ...opts, fits }))
}
