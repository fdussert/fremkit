// A dev tab's performance: the bounds of the values fremdev/perf.js reads, the regression rule, and
// the memory of the previous loads it is judged against. Pure but for PerfMemory, which keeps that
// memory in the storage area it is given (chrome.storage.session in the worker).
//
// The rule: a load is a regression when its LCP or its load is at least PERF_RATIO × the median of
// the previous PERF_SAMPLES loads of the same origin and path *and* at least PERF_MIN_MS slower; or
// when a Web Vital is in the "poor" band (LCP over LCP_POOR_MS, CLS over CLS_POOR). The heap and the
// long tasks are shown, never judged.

export const PERF_RATIO = 1.5
export const PERF_MIN_MS = 500
export const LCP_POOR_MS = 4000
export const CLS_POOR = 0.25
/** The previous loads a load is judged against, per origin and path. */
export const PERF_SAMPLES = 5
/** The origins and paths remembered, the least recently used dropped. */
export const PERF_KEYS = 50
/** The highest ratio a perf entry carries (DevTabSchema's bound). */
const MAX_RATIO = 1000

/** Each value's bounds: integers but the CLS, which is rounded to 3 decimals. */
const BOUNDS = {
  load: { max: 600_000, int: true },
  lcp: { max: 600_000, int: true },
  cls: { max: 100, int: false },
  longTasks: { max: 100_000, int: true },
  heapMb: { max: 65_536, int: true },
}
/** The values in the order they are shown. */
export const PERF_FIELDS = Object.keys(BOUNDS)
export const PERF_METRICS = ['load', 'lcp', 'cls']

const round3 = (v) => Math.round(v * 1000) / 1000

/** Whether `v` may be the value `key`. */
export function isPerfValue(key, v) {
  const b = BOUNDS[key]
  return !!b && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= b.max && (!b.int || Number.isInteger(v))
}

/**
 * The values a `perf` page event carries, rebuilt from the known keys alone (the CLS rounded to 3
 * decimals); null when one of them is there and out of its bounds, or when none is.
 */
export function perfValues(msg) {
  const out = {}
  for (const key of PERF_FIELDS) {
    if (msg?.[key] === undefined) continue
    if (!isPerfValue(key, msg[key])) return null
    out[key] = key === 'cls' ? round3(msg[key]) : msg[key]
  }
  return Object.keys(out).length > 0 ? out : null
}

/** A row's values kept to the known keys within bounds: what the wire and the session copy carry. */
export function cleanPerf(perf) {
  const out = {}
  if (!perf || typeof perf !== 'object') return out
  for (const key of PERF_FIELDS) if (isPerfValue(key, perf[key])) out[key] = perf[key]
  return out
}

/** The middle value, or the mean of the two middle ones; NaN for none. */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  if (s.length === 0) return Number.NaN
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** `{ metric, value, ratio }` when `cur[metric]` is a regression against the previous loads' median. */
function slower(previous, cur, metric) {
  const value = cur?.[metric]
  if (!isPerfValue(metric, value)) return null
  const before = previous.map((p) => p?.[metric]).filter((v) => isPerfValue(metric, v))
  if (before.length === 0) return null
  const m = median(before)
  // A previous load of 0 is no baseline.
  if (!(m > 0) || value < PERF_RATIO * m || value - m < PERF_MIN_MS) return null
  return { metric, value, ratio: Math.min(MAX_RATIO, Math.round((value / m) * 10) / 10) }
}

/**
 * The verdict on a load's values `cur` against the previous loads' samples, or null: LCP slower,
 * then load slower (each needing a previous value for it), then LCP poor, then CLS poor. With no
 * samples, only the poor bands apply.
 */
export function perfVerdict(previous, cur) {
  const list = Array.isArray(previous) ? previous : []
  const verdict = slower(list, cur, 'lcp') ?? slower(list, cur, 'load')
  if (verdict) return verdict
  if (isPerfValue('lcp', cur?.lcp) && cur.lcp > LCP_POOR_MS) return { metric: 'lcp', value: cur.lcp, ratio: null }
  if (isPerfValue('cls', cur?.cls) && cur.cls > CLS_POOR) return { metric: 'cls', value: cur.cls, ratio: null }
  return null
}

/** A sample as it is kept: its load and LCP, when they are values. */
function sampleOf(s) {
  const out = {}
  for (const key of ['load', 'lcp']) if (isPerfValue(key, s?.[key])) out[key] = s[key]
  return out
}

const STORE_KEY = 'fremdevPerf'
const MAX_KEY = 2048

/**
 * The previous loads' samples, per key (origin + pathname), in `storage.fremdevPerf` as a list
 * `[{ key, samples }]`, the most recently used last: the last PERF_SAMPLES samples per key, at most
 * PERF_KEYS keys. What is read back is checked: anything else reads as nothing.
 */
export class PerfMemory {
  constructor(storage) {
    this.storage = storage
    // One read-modify-write at a time: two loads ending together must not lose one.
    this.queue = Promise.resolve()
  }

  async read() {
    let raw
    try {
      raw = (await this.storage.get(STORE_KEY))?.[STORE_KEY]
    } catch {
      return []
    }
    if (!Array.isArray(raw)) return []
    return raw
      .filter((e) => e && typeof e.key === 'string' && e.key.length <= MAX_KEY && Array.isArray(e.samples))
      .slice(-PERF_KEYS)
      .map((e) => ({ key: e.key, samples: e.samples.slice(-PERF_SAMPLES).map(sampleOf) }))
  }

  async samples(key) {
    await this.queue
    return (await this.read()).find((e) => e.key === key)?.samples ?? []
  }

  push(key, sample) {
    const run = this.queue.then(async () => {
      if (typeof key !== 'string' || key.length > MAX_KEY) return
      const list = await this.read()
      const old = list.find((e) => e.key === key)
      const samples = [...(old?.samples ?? []), sampleOf(sample)].slice(-PERF_SAMPLES)
      const next = [...list.filter((e) => e !== old), { key, samples }].slice(-PERF_KEYS)
      await this.storage.set({ [STORE_KEY]: next }).catch(() => undefined)
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Forgets every load (Fremdev turned off). */
  clear() {
    const run = this.queue.then(() => this.storage.set({ [STORE_KEY]: [] }).catch(() => undefined))
    this.queue = run.catch(() => undefined)
    return run
  }
}
