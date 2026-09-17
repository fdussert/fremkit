import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeUsage } from '../src/claude/usage.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'usage-')) })

const rl = { five_hour: { used_percentage: 23.5, resets_at: 1_800_000_000 }, seven_day: { used_percentage: 41, resets_at: 1_800_500_000 } }

describe('ClaudeUsage', () => {
  it('starts empty and stale', async () => {
    const u = new ClaudeUsage({ filePath: join(dir, 'u.json'), transcriptsDir: join(dir, 'none') })
    await u.load()
    expect(u.snapshot()).toMatchObject({ fiveHour: null, sevenDay: null, spendLimit: null, updatedAt: null, stale: true, today: { messages: 0, costUsd: 0 } })
  })
  it('applies rate limits, persists them, and reloads', async () => {
    let t = 1_000_000
    const file = join(dir, 'u.json')
    const u = new ClaudeUsage({ filePath: file, transcriptsDir: join(dir, 'none'), now: () => t })
    await u.load()
    await u.applyStatusLine({ session_id: 's1', rate_limits: rl, cost: { total_cost_usd: 0.5 } })
    expect(u.snapshot()).toMatchObject({ fiveHour: { pct: 23.5, resetsAt: 1_800_000_000 }, sevenDay: { pct: 41, resetsAt: 1_800_500_000 }, spendLimit: null, updatedAt: 1_000_000, stale: false })
    await u.flush()
    expect(JSON.parse(await readFile(file, 'utf8')).fiveHour.pct).toBe(23.5)
    const again = new ClaudeUsage({ filePath: file, transcriptsDir: join(dir, 'none'), now: () => t })
    await again.load()
    expect(again.snapshot().sevenDay).toEqual({ pct: 41, resetsAt: 1_800_500_000 })
  })
  it('goes stale after 10 minutes and sums today cost per session', async () => {
    let t = 1_000_000
    const u = new ClaudeUsage({ filePath: join(dir, 'u.json'), transcriptsDir: join(dir, 'none'), now: () => t })
    await u.load()
    await u.applyStatusLine({ session_id: 's1', rate_limits: rl, cost: { total_cost_usd: 0.5 } })
    await u.applyStatusLine({ session_id: 's1', rate_limits: rl, cost: { total_cost_usd: 0.8 } })
    await u.applyStatusLine({ session_id: 's2', cost: { total_cost_usd: 0.2 } })
    expect(u.snapshot().today.costUsd).toBeCloseTo(1.0)
    t += 11 * 60_000
    expect(u.snapshot().stale).toBe(true)
  })
  it('debounces persistence: a burst of status lines produces a single write', async () => {
    const writeFn = vi.fn(async (path: string, data: string) => { await writeFile(path, data, 'utf8') })
    const u = new ClaudeUsage({ filePath: join(dir, 'u.json'), transcriptsDir: join(dir, 'none'), writeFn })
    await u.load()
    await u.applyStatusLine({ session_id: 's1', rate_limits: rl, cost: { total_cost_usd: 0.5 } })
    await u.applyStatusLine({ session_id: 's1', rate_limits: rl, cost: { total_cost_usd: 0.9 } })
    expect(writeFn).not.toHaveBeenCalled()
    await u.flush()
    expect(writeFn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(join(dir, 'u.json'), 'utf8')).costs.s1).toBe(0.9)
    // Nothing dirty left: flushing again writes nothing.
    await u.flush()
    expect(writeFn).toHaveBeenCalledTimes(1)
  })
  it('falls back to defaults when the persisted file is malformed', async () => {
    const file = join(dir, 'u.json')
    await writeFile(file, JSON.stringify({ fiveHour: { pct: 'nope' }, costs: 'bad' }), 'utf8')
    const u = new ClaudeUsage({ filePath: file, transcriptsDir: join(dir, 'none') })
    await u.load()
    expect(u.snapshot()).toMatchObject({ fiveHour: null, sevenDay: null, updatedAt: null, stale: true })
  })
})
