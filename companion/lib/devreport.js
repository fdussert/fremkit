import { cleanPerf } from './devperf.js'
import { clip, homePath, pathOf } from './devlog.js'

// A dev tab's bug report, in Markdown: what the Edge copies (`dev.report`, through the server) and
// what the popup copies. Pure: the words, the time and the date are the caller's (chrome.i18n and
// the browser's locale in the worker), so a test reads the exact text.
//
// The tab is lib/devtabs.js's internal one, stacks included (an error's stack, a build's code frame
// and stack): they leave the worker only here, and only in a report copied with its stack. Full
// paths stay in the worker too: every text, origin, frame and path is written with its home folder
// as `~` (homePath) before it is clipped.

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
/** A count: a non-negative integer, 0 for anything else. */
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0)
/** What Vite's overlay names for an error with no file: never a file. */
const UNKNOWN_FILE = 'unknown file'

/**
 * `lines` as a fenced code block inside a list item (indented 2), so a Markdown renderer keeps
 * their alignment and reads `> 2 |` or `<script setup>` as code. The fence is longer than any run
 * of backticks in the lines. Nothing for no line.
 */
function fenced(lines) {
  if (lines.length === 0) return []
  let longest = 0
  for (const l of lines) for (const run of l.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [`  ${fence}`, ...lines.map((l) => `  ${l}`), `  ${fence}`]
}

function entryLines(e, { stack, t, time }) {
  const count = e.n > 1 ? `×${e.n} ` : ''
  const state = e.state === 'seen' ? ` (${t('stateSeen')})` : e.state === 'resolved' ? ` (${t('stateResolved')})` : ''
  const at = time(e.at)
  switch (e.kind) {
    case 'error': {
      const out = [`- ${at} ${count}${homeLine(e.text)}${state}`]
      if (typeof e.origin === 'string' && e.origin !== '') out.push(`  at ${homeLine(e.origin)}`)
      // The first frame is the origin already.
      if (stack && Array.isArray(e.stack)) out.push(...fenced(e.stack.slice(1).map((frame) => homeLine(frame, Infinity))))
      return out
    }
    case 'request':
      return [`- ${at} ${count}${line(e.method)} ${homeLine(e.path)} ${e.status > 0 ? e.status : t('noAnswer')}${state}`]
    case 'limited':
      return [`- ${at} +${e.n} ${t('reportLimited')}${state}`]
    case 'slow':
      return [`- ${at} ${count}${line(e.method)} ${homeLine(e.path)} ${Math.round(Number(e.ms) || 0)} ms${state}`]
    case 'perf': {
      const name = METRIC_NAMES[e.metric]
      const value = Number(e.value)
      if (name === undefined || !Number.isFinite(value)) return []
      const v = e.metric === 'cls' ? value.toFixed(2) : seconds(value)
      const ratio = Number(e.ratio)
      const text = e.ratio !== null && Number.isFinite(ratio) ? t('reportPerfSlower', name, v, ratio.toFixed(1)) : t('reportPerfPoor', name, v)
      return [`- ${at} ${count}${line(text)}${state}`]
    }
    case 'build': {
      const out = [`- ${at} ${count}${homeLine(e.text)}${state}`]
      // Where, with no file when there is none (Vite's `unknown file`, from an entry read before
      // build.js knew it): `at 3:15`, or no line at all.
      const file = typeof e.path === 'string' && e.path !== UNKNOWN_FILE ? e.path : ''
      const pos = isPos(e.line) ? `${e.line}${isPos(e.col) ? `:${e.col}` : ''}` : ''
      if (file !== '') out.push(`  at ${homeLine(file)}${pos ? `:${pos}` : ''}`)
      else if (pos !== '') out.push(`  at ${pos}`)
      // The overlay's code frame, its alignment kept, then its stack: with the stack only.
      if (stack) {
        const lines = [...(Array.isArray(e.frame) ? e.frame : []), ...(Array.isArray(e.stack) ? e.stack : [])]
        out.push(...fenced(lines.map((l) => homeLine(l, Infinity))))
      }
      return out
    }
    default:
      return []
  }
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`
/** The metrics' own names, the same in every language. */
const METRIC_NAMES = { load: 'Load', lcp: 'LCP', cls: 'CLS' }

/**
 * The current document's values on one line, in the order perf.js reads them, or null when there
 * is none: `Load 1.2 s · LCP 0.8 s · CLS 0.02 · 3 long tasks · 45 MB`. The names are the metrics'
 * own, the same in every language.
 */
function perfLine(perf) {
  const p = cleanPerf(perf)
  const parts = []
  if (p.load !== undefined) parts.push(`Load ${seconds(p.load)}`)
  if (p.lcp !== undefined) parts.push(`LCP ${seconds(p.lcp)}`)
  if (p.cls !== undefined) parts.push(`CLS ${p.cls.toFixed(2)}`)
  if (p.longTasks !== undefined) parts.push(`${p.longTasks} long ${p.longTasks === 1 ? 'task' : 'tasks'}`)
  if (p.heapMb !== undefined) parts.push(`${p.heapMb} MB`)
  return parts.length > 0 ? parts.join(' · ') : null
}

function render(tab, entries, opts) {
  const { t, date, now } = opts
  const host = line(tab.host)
  const title = homeLine(tab.title || tab.host)
  const out = [
    `## ${t('reportTitle')}: ${title} (${host}${homeLine(pathOf(tab.url))})`,
    `${date(now)} · ${t('reportServer')}: ${tab.server === 'down' ? 'down' : 'up'}`,
  ]
  const perf = perfLine(tab.perf)
  if (perf !== null) out.push(`${t('reportPerf')}: ${perf}`)
  out.push(t('reportLines'))
  const builds = entries.filter((e) => e.kind === 'build')
  const errors = entries.filter((e) => e.kind === 'error' || e.kind === 'limited')
  const requests = entries.filter((e) => e.kind === 'request')
  const slow = entries.filter((e) => e.kind === 'slow')
  const perfs = entries.filter((e) => e.kind === 'perf')
  // The compile error first: while it shows, nothing else on the page is current.
  // Each section counts its own: the tab's errors tally holds the build entries too, and the open
  // ones among them are the history's live build entries (the ring uncounts any it pushes out).
  const all = Array.isArray(tab.history) ? tab.history : []
  const liveBuilds = all.filter((e) => e.kind === 'build' && (e.state === 'open' || e.state === 'seen')).length
  const buildTotal = Math.max(all.filter((e) => e.kind === 'build').length, count(tab.buildTotal))
  if (builds.length > 0) {
    out.push('', `### ${t('reportBuild', liveBuilds, buildTotal)}`)
    for (const e of builds) out.push(...entryLines(e, opts))
  }
  if (errors.length > 0) {
    const open = Math.max(0, count(tab.errors?.open) - liveBuilds)
    const total = Math.max(0, count(tab.errors?.total) - buildTotal)
    out.push('', `### ${t('reportErrors', open, total)}`)
    for (const e of errors) out.push(...entryLines(e, opts))
  }
  if (requests.length > 0) {
    out.push('', `### ${t('reportRequests')}`)
    for (const e of requests) out.push(...entryLines(e, opts))
  }
  // A load's regression: what lit the row orange, beside the failed requests it is counted with.
  if (perfs.length > 0) {
    out.push('', `### ${t('reportPerf')}`)
    for (const e of perfs) out.push(...entryLines(e, opts))
  }
  // Last: a slow request is no fault, only a lead.
  if (slow.length > 0) {
    out.push('', `### ${t('reportSlow')}`)
    for (const e of slow) out.push(...entryLines(e, opts))
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
