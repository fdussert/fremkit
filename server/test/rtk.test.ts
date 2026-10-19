import { describe, it, expect, vi } from 'vitest'
import {
  createRtkProvider, localDate, parseGain, resolveRtkBinary, RTK_DAYS, RTK_POLL_MS, RTK_RETRY_MS,
} from '../src/providers/rtk.js'

const day = (date: string, saved: number) => ({
  date, commands: 10, input_tokens: saved * 2, output_tokens: saved, saved_tokens: saved,
  savings_pct: 50, total_time_ms: 4000, avg_time_ms: 400,
})
const gain = (daily: unknown[] = [day('2026-10-15', 100), day('2026-10-16', 300)]) => JSON.stringify({
  summary: {
    total_commands: 20, total_input: 800, total_output: 400, total_saved: 400,
    avg_savings_pct: 50, total_time_ms: 8000, avg_time_ms: 400,
  },
  daily,
})
const NOON = new Date(2026, 9, 16, 12)

describe('parseGain', () => {
  it('keeps the totals, today and the daily rows', () => {
    const data = parseGain(gain(), NOON)
    expect(data.total).toEqual({ commands: 20, input: 800, output: 400, saved: 400, percent: 50, avgTimeMs: 400 })
    expect(data.today).toEqual({ date: '2026-10-16', commands: 10, input: 600, output: 300, saved: 300, percent: 50 })
    expect(data.daily.map((d) => d.date)).toEqual(['2026-10-15', '2026-10-16'])
  })

  it('reports zeros for a day RTK has not run yet', () => {
    const data = parseGain(gain([day('2026-10-14', 100)]), NOON)
    expect(data.today).toEqual({ date: '2026-10-16', commands: 0, input: 0, output: 0, saved: 0, percent: 0 })
  })

  it('keeps only the most recent days, oldest first', () => {
    const rows = Array.from({ length: 45 }, (_, i) => day(localDate(new Date(2026, 8, 1 + i)), i)).reverse()
    const data = parseGain(gain(rows), NOON)
    expect(data.daily).toHaveLength(RTK_DAYS)
    expect(data.daily.at(-1)?.saved).toBe(44)
    expect(data.daily[0]!.date < data.daily.at(-1)!.date).toBe(true)
  })

  it('accepts a summary with no daily rows', () => {
    expect(parseGain(JSON.stringify({ summary: JSON.parse(gain()).summary }), NOON).daily).toEqual([])
  })

  it('ignores fields a newer RTK adds', () => {
    const v1 = JSON.parse(gain())
    v1.summary.oversized_excluded = 3
    expect(parseGain(JSON.stringify(v1), NOON).total.saved).toBe(400)
  })

  it('refuses malformed output', () => {
    expect(() => parseGain('not json')).toThrow(SyntaxError)
    expect(() => parseGain(JSON.stringify({ summary: { total_saved: -1 } }))).toThrow()
    expect(() => parseGain(gain([{ ...day('2026-10-16', 1), date: '../etc' }]))).toThrow()
  })
})

describe('resolveRtkBinary', () => {
  it('takes the first executable install', async () => {
    const seen: string[] = []
    const path = await resolveRtkBinary(async (p) => { seen.push(p); if (p !== '/usr/local/bin/rtk') throw new Error('no') })
    expect(path).toBe('/usr/local/bin/rtk')
    expect(seen[0]).toBe('/opt/homebrew/bin/rtk')
  })

  it('fails as unavailable when none is installed', async () => {
    await expect(resolveRtkBinary(async () => { throw new Error('no') })).rejects.toThrow('unavailable')
  })
})

describe('rtk provider', () => {
  it('runs a fixed argument list and publishes a fresh snapshot', async () => {
    const run = vi.fn(async () => gain())
    const provider = createRtkProvider({ run, now: () => NOON })
    const snap = await provider.poll!()
    expect(run).toHaveBeenCalledWith(['gain', '--daily', '--format', 'json'])
    expect(snap).toMatchObject({ stale: false, error: null })
    expect(snap.data?.today.saved).toBe(300)
    expect(provider.intervalMs).toBe(RTK_POLL_MS)
    expect(provider.commands).toBeUndefined()
  })

  it('reports a missing binary without data', async () => {
    const provider = createRtkProvider({ run: async () => { throw new Error('unavailable') } })
    expect(await provider.poll!()).toEqual({ data: null, stale: false, error: 'unavailable', updatedAt: null })
    expect(provider.intervalMs).toBe(RTK_RETRY_MS)
  })

  it('keeps the last good snapshot when a poll fails, then recovers', async () => {
    const outputs = [gain(), 'garbage', gain()]
    const provider = createRtkProvider({ run: async () => outputs.shift()!, now: () => NOON })
    const good = await provider.poll!()
    const bad = await provider.poll!()
    expect(bad).toMatchObject({ stale: true, error: 'invalid', data: good.data, updatedAt: good.updatedAt })
    expect(provider.intervalMs).toBe(RTK_RETRY_MS)
    expect(await provider.poll!()).toMatchObject({ stale: false, error: null })
    expect(provider.intervalMs).toBe(RTK_POLL_MS)
  })

  it('calls a failed run offline', async () => {
    const provider = createRtkProvider({ run: async () => { throw new Error('offline') } })
    expect((await provider.poll!()).error).toBe('offline')
  })
})
