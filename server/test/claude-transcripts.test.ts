import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, appendFile, utimes, symlink, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanTranscriptsToday, createTranscriptScanner } from '../src/claude/transcripts.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'transcripts-')) })

const now = new Date('2026-09-16T15:00:00Z')
const line = (id: string, ts: string, usage: Record<string, number>) =>
  JSON.stringify({ type: 'assistant', timestamp: ts, requestId: 'r-' + id, message: { id, usage } })

async function transcript(rel: string, lines: string[], mtime = now) {
  const file = join(dir, rel)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, lines.join('\n') + '\n')
  await utimes(file, mtime, mtime)
}

describe('scanTranscriptsToday', () => {
  it('sums today assistant usage, deduplicates by message id, counts sessions', async () => {
    await transcript('p1/a.jsonl', [
      line('m1', '2026-09-16T10:00:00Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
      line('m1', '2026-09-16T10:00:01Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
      JSON.stringify({ type: 'user', timestamp: '2026-09-16T10:00:02Z' }),
      line('m2', '2026-09-15T20:00:00Z', { input_tokens: 999, output_tokens: 999 }),
      'not json',
    ])
    await transcript('p2/b.jsonl', [line('m3', '2026-09-16T12:00:00Z', { input_tokens: 1, output_tokens: 2 })])
    const r = await scanTranscriptsToday(dir, now)
    expect(r).toEqual({ input: 11, output: 7, cacheRead: 100, cacheWrite: 20, messages: 2, sessions: 2, hourly: expect.any(Array) })
  })
  it('keeps the fallback id per-file so entries lacking message.id/requestId in different files do not collide', async () => {
    const noIdLine = (ts: string, usage: Record<string, number>) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { usage } })
    await transcript('p1/a.jsonl', [noIdLine('2026-09-16T10:00:00Z', { input_tokens: 10, output_tokens: 5 })])
    await transcript('p2/b.jsonl', [noIdLine('2026-09-16T10:00:00Z', { input_tokens: 10, output_tokens: 5 })])
    const r = await scanTranscriptsToday(dir, now)
    expect(r).toMatchObject({ input: 20, output: 10, messages: 2, sessions: 2 })
  })
  it('skips files not modified today and tolerates a missing dir', async () => {
    await transcript('old/c.jsonl', [line('m9', '2026-09-16T01:00:00Z', { input_tokens: 5, output_tokens: 5 })], new Date('2026-09-10T00:00:00Z'))
    expect((await scanTranscriptsToday(dir, now)).messages).toBe(0)
    expect((await scanTranscriptsToday(join(dir, 'nope'), now)).messages).toBe(0)
  })
})

describe('createTranscriptScanner', () => {
  it('reuses the cache: a second scan with no change opens no file', async () => {
    await transcript('p1/a.jsonl', [line('m1', '2026-09-16T10:00:00Z', { input_tokens: 10, output_tokens: 5 })])
    const openFile = vi.fn((p: string) => open(p, 'r'))
    const scanner = createTranscriptScanner(dir, { openFile })
    expect(await scanner.scanToday(now)).toMatchObject({ input: 10, output: 5, messages: 1, sessions: 1 })
    expect(openFile).toHaveBeenCalledTimes(1)
    expect(await scanner.scanToday(now)).toMatchObject({ input: 10, output: 5, messages: 1, sessions: 1 })
    expect(openFile).toHaveBeenCalledTimes(1)
  })

  it('reads only the appended bytes and adds exactly their usage', async () => {
    const file = join(dir, 'p1/a.jsonl')
    await transcript('p1/a.jsonl', [line('m1', '2026-09-16T10:00:00Z', { input_tokens: 10, output_tokens: 5 })])
    const openFile = vi.fn((p: string) => open(p, 'r'))
    const scanner = createTranscriptScanner(dir, { openFile })
    await scanner.scanToday(now)
    // A partial trailing line must not be consumed: only the complete one counts.
    await appendFile(file, line('m2', '2026-09-16T11:00:00Z', { input_tokens: 3, output_tokens: 1 }) + '\n' + '{"type":"assis')
    expect(await scanner.scanToday(now)).toMatchObject({ input: 13, output: 6, messages: 2, sessions: 1 })
    expect(openFile).toHaveBeenCalledTimes(2)
    // Completing the partial line adds it on the next scan, without re-counting m1/m2.
    await appendFile(file, 'tant"}\n' + line('m3', '2026-09-16T12:00:00Z', { input_tokens: 7, output_tokens: 2 }) + '\n')
    expect(await scanner.scanToday(now)).toMatchObject({ input: 20, output: 8, messages: 3, sessions: 1 })
  })

  it('rescans in full when a file shrinks', async () => {
    const file = join(dir, 'p1/a.jsonl')
    await transcript('p1/a.jsonl', [
      line('m1', '2026-09-16T10:00:00Z', { input_tokens: 10, output_tokens: 5 }),
      line('m2', '2026-09-16T10:30:00Z', { input_tokens: 4, output_tokens: 4 }),
    ])
    const scanner = createTranscriptScanner(dir)
    expect(await scanner.scanToday(now)).toMatchObject({ input: 14, messages: 2 })
    await writeFile(file, line('m9', '2026-09-16T13:00:00Z', { input_tokens: 1, output_tokens: 1 }) + '\n')
    expect(await scanner.scanToday(now)).toMatchObject({ input: 1, output: 1, messages: 1, sessions: 1 })
  })

  it('buckets tokens per local hour and keeps them through incremental scans', async () => {
    await transcript('h/a.jsonl', [
      line('h1', '2026-09-16T08:30:00Z', { input_tokens: 10, output_tokens: 5 }),   // 10 h Paris
      line('h2', '2026-09-16T08:45:00Z', { input_tokens: 1, output_tokens: 1 }),    // 10 h Paris
      line('h3', '2026-09-16T12:10:00Z', { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 50 }), // 14 h Paris
    ])
    const scanner = createTranscriptScanner(dir)
    const r1 = await scanner.scanToday(now)
    expect(r1.hourly).toHaveLength(24)
    expect(r1.hourly[10]).toBe(17); expect(r1.hourly[14]).toBe(150); expect(r1.hourly.reduce((a, b) => a + b, 0)).toBe(167)
    await appendFile(join(dir, 'h/a.jsonl'), line('h4', '2026-09-16T12:50:00Z', { input_tokens: 3, output_tokens: 0 }) + '\n')
    await utimes(join(dir, 'h/a.jsonl'), now, now)
    const r2 = await scanner.scanToday(now)
    expect(r2.hourly[14]).toBe(153)
  })

  it('does not hang on a symlinked directory loop', async () => {
    await transcript('p1/a.jsonl', [line('m1', '2026-09-16T10:00:00Z', { input_tokens: 10, output_tokens: 5 })])
    await symlink(join(dir, 'p1'), join(dir, 'p1', 'loop'), 'dir')
    const r = await createTranscriptScanner(dir).scanToday(now)
    expect(r).toMatchObject({ input: 10, output: 5, messages: 1, sessions: 1 })
  })
})
