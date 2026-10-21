import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompanionDev, DEV_INSTALL_MAX_BYTES, DEV_PUBLISH_MS, SHOT_SOUND_MIN_MS, SHOT_VIEW_MS, type DevRow } from '../src/companion/dev.js'
import {
  FREMDEV_FEATURES,
  FREMDEV_SHOTVIEW_MODULE,
  MAX_MESSAGE_BYTES,
  parseAfterHello,
  parseExtensionMessage,
  SHOT_THUMB_MAX,
  type DevTab,
  type ServerMessage,
} from '../src/companion/protocol.js'
import { AFPLAY, afplayShotSound, SHOT_SOUND_FILE, SHOT_SOUND_TIMEOUT_MS } from '../src/companion/shotSound.js'
import { demoShotSound } from '../src/demo/clipboard.js'
// @ts-expect-error the extension's plain JavaScript has no declarations
import { THUMB_MAX_CHARS } from '../../companion/lib/devshot.js'

// Fremdev's shot on the Edge: `dev.shot` from the extension, the row's thumbnail on `companion:dev`
// for 3 seconds, and the capture sound when the extension's option asks for it.

const A = '11111111-1111-4111-8111-111111111111'
const PREFIX = 'data:image/jpeg;base64,/9j/'
const THUMB = `${PREFIX}4AAQ`
/** A thumbnail `n` characters long, its base64 in whole quads. */
const thumbOf = (n: number) => PREFIX + 'A'.repeat(n - PREFIX.length - ((n - PREFIX.length) % 4))
const SHOTVIEW = ['fremplay', 'fremdev', FREMDEV_SHOTVIEW_MODULE]

function row(tabId: number, history: DevTab['history'] = []): DevTab {
  return {
    tabId,
    app: 'My app',
    host: 'localhost:5173',
    errors: { total: 0, open: 0, seen: 0, last: null },
    requests: { total: 0, open: 0, seen: 0, last: null },
    history,
    devServer: null,
    inFlight: 0,
    perf: {},
    server: 'up',
    activity: 1_000,
  }
}

function setup(opts: { modules?: string[]; enabled?: () => boolean } = {}) {
  const changed = vi.fn<() => void>()
  const play = vi.fn<() => void>()
  const dev = new CompanionDev({
    send: (_id: string, _msg: ServerMessage) => undefined,
    changed,
    enabled: opts.enabled ?? (() => true),
    pairedCount: () => 1,
    sound: { play },
  })
  dev.connect(A, 'Chrome', opts.modules ?? SHOTVIEW)
  dev.onMessage(A, { type: 'dev.tabs', tabs: [row(7), row(8)] })
  vi.advanceTimersByTime(DEV_PUBLISH_MS)
  const shot = (tabId: number, thumb: string | null = THUMB, sound = false) => dev.onMessage(A, { type: 'dev.shot', tabId, thumb, sound })
  const rows = (): DevRow[] => dev.snapshot().installs[0]?.tabs ?? []
  const shotOn = (tabId: number) => rows().find((r) => r.tabId === tabId)?.shot
  return { dev, changed, play, shot, rows, shotOn }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('dev.shot on the wire', () => {
  const msg = (over: Record<string, unknown> = {}) => JSON.stringify({ type: 'dev.shot', tabId: 7, thumb: THUMB, sound: false, ...over })

  it('takes a JPEG data URL, or null, and the sound flag', () => {
    expect(parseExtensionMessage(msg())).toEqual({ type: 'dev.shot', tabId: 7, thumb: THUMB, sound: false })
    expect(parseExtensionMessage(msg({ thumb: null, sound: true }))).toEqual({ type: 'dev.shot', tabId: 7, thumb: null, sound: true })
    expect(parseExtensionMessage(msg({ thumb: thumbOf(SHOT_THUMB_MAX) }))).not.toBeNull()
  })

  it('caps the thumbnail where the extension does, well under the socket frame', () => {
    expect(SHOT_THUMB_MAX).toBe(THUMB_MAX_CHARS)
    expect(Buffer.byteLength(msg({ thumb: thumbOf(SHOT_THUMB_MAX), tabId: 2_147_483_647 }))).toBeLessThan(MAX_MESSAGE_BYTES - 20_000)
  })

  it('refuses a bad prefix, another type, broken base64, a thumbnail too long, a bad tab or extra keys', () => {
    for (const bad of [
      { thumb: 'data:image/png;base64,iVBORw0KGgo=' },
      { thumb: 'data:image/jpeg;base64,iVBORw0KGgo=' },
      { thumb: 'data:image/svg+xml;base64,PHN2Zz4=' },
      { thumb: 'data:text/html;base64,/9j/4AAQ' },
      { thumb: 'data:image/jpeg,/9j/4AAQ' },
      { thumb: `${PREFIX}4AA` },
      { thumb: `${PREFIX}4A"Q` },
      { thumb: ` ${THUMB}` },
      { thumb: 'https://example.com/a.jpg' },
      { thumb: thumbOf(SHOT_THUMB_MAX + 4) },
      { thumb: 42 },
      { tabId: -1 },
      { tabId: 1.5 },
      { sound: 'yes' },
      { sound: undefined },
      { url: 'https://example.com/' },
    ]) {
      expect(parseExtensionMessage(msg(bad)), JSON.stringify(bad).slice(0, 60)).toBeNull()
    }
  })

  it('after hello, a bad one is dropped and the socket kept', () => {
    expect(parseAfterHello(msg({ thumb: 'data:image/png;base64,iVBORw0KGgo=' }))).toEqual({ msg: null, dropped: 1 })
    expect(parseAfterHello(msg({ thumb: thumbOf(SHOT_THUMB_MAX + 4) }))).toEqual({ msg: null, dropped: 1 })
    expect(parseAfterHello(msg())?.msg).toEqual({ type: 'dev.shot', tabId: 7, thumb: THUMB, sound: false })
  })

  it('is negotiated: fremdev.shotview is one of the Fremdev features', () => {
    expect(FREMDEV_FEATURES).toContain(FREMDEV_SHOTVIEW_MODULE)
  })
})

describe('CompanionDev and dev.shot', () => {
  it('shows the shot on its row, published, then clears it after 3 s and publishes again', () => {
    const t = setup()
    t.changed.mockClear()
    t.shot(7)
    expect(t.changed).toHaveBeenCalledTimes(1)
    expect(t.shotOn(7)).toEqual({ thumb: THUMB, until: Date.now() + SHOT_VIEW_MS })
    expect(t.shotOn(8)).toBeUndefined()
    vi.advanceTimersByTime(SHOT_VIEW_MS - 1)
    expect(t.shotOn(7)).toBeDefined()
    vi.advanceTimersByTime(1)
    expect(t.shotOn(7)).toBeUndefined()
    // The clearing publish (throttled like the rows' own).
    vi.advanceTimersByTime(DEV_PUBLISH_MS)
    expect(t.changed).toHaveBeenCalledTimes(2)
    expect(t.rows()).toEqual([row(7), row(8)])
  })

  it('a shot with no thumbnail still shows on the row', () => {
    const t = setup()
    t.shot(7, null)
    expect(t.shotOn(7)).toEqual({ thumb: null, until: Date.now() + SHOT_VIEW_MS })
  })

  it('a newer shot replaces the one showing, and its own 3 s count', () => {
    const t = setup()
    t.shot(7)
    vi.advanceTimersByTime(2_000)
    t.shot(8, `${PREFIX}4BBB`)
    expect(t.shotOn(7)).toBeUndefined()
    expect(t.shotOn(8)?.thumb).toBe(`${PREFIX}4BBB`)
    vi.advanceTimersByTime(1_500)
    expect(t.shotOn(8)).toBeDefined()
    vi.advanceTimersByTime(1_500)
    expect(t.shotOn(8)).toBeUndefined()
  })

  it('drops a shot for a tab the install did not report', () => {
    const t = setup()
    t.changed.mockClear()
    t.shot(9, THUMB, true)
    expect(t.rows().some((r) => r.shot)).toBe(false)
    expect(t.changed).not.toHaveBeenCalled()
    expect(t.play).not.toHaveBeenCalled()
  })

  it('drops a shot from an install that did not list fremdev.shotview, or has Fremdev off', () => {
    for (const modules of [['fremplay', 'fremdev'], ['fremplay', 'fremdev', 'fremdev.shot'], ['fremplay', FREMDEV_SHOTVIEW_MODULE]]) {
      const t = setup({ modules })
      t.changed.mockClear()
      t.shot(7, THUMB, true)
      expect(t.dev.snapshot().installs[0].tabs.some((r: DevRow) => r.shot), modules.join()).toBe(false)
      expect(t.changed).not.toHaveBeenCalled()
      expect(t.play).not.toHaveBeenCalled()
    }
  })

  it('drops a shot while Fremdev is disabled in Fremkit', () => {
    let on = true
    const t = setup({ enabled: () => on })
    on = false
    t.shot(7, THUMB, true)
    on = true
    expect(t.shotOn(7)).toBeUndefined()
    expect(t.play).not.toHaveBeenCalled()
  })

  it('forgets the shot when the feature is withdrawn or the socket closes', () => {
    const t = setup()
    t.shot(7)
    t.dev.onMessage(A, { type: 'modules', modules: ['fremplay', 'fremdev'] })
    expect(t.shotOn(7)).toBeUndefined()
    t.dev.onMessage(A, { type: 'modules', modules: SHOTVIEW })
    t.shot(7)
    t.dev.disconnect(A)
    t.dev.connect(A, 'Chrome', SHOTVIEW)
    t.dev.onMessage(A, { type: 'dev.tabs', tabs: [row(7)] })
    expect(t.shotOn(7)).toBeUndefined()
    // Its timer went with it: nothing fires later.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
  })

  it('shows nothing once the tab left the rows', () => {
    const t = setup()
    t.shot(7)
    t.dev.onMessage(A, { type: 'dev.tabs', tabs: [row(8)] })
    expect(t.rows().some((r) => r.shot)).toBe(false)
  })
})

describe('the snapshot cap with a thumbnail', () => {
  /** A history as heavy as the schema allows: 20 build entries of 300 characters each. */
  const heavy = (): DevTab['history'] => Array.from({ length: 20 }, (_, i) => ({
    kind: 'build' as const, text: 'x'.repeat(300), file: `/src/${'y'.repeat(290)}.vue`, line: 1, col: 1, id: i + 1, n: 1, at: 1_000, state: 'open' as const,
  }))

  it('keeps every row and every entry, and leaves the thumbnail out when they and it would not fit', () => {
    const t = setup()
    const full = Array.from({ length: 4 }, (_, i) => row(i + 7, heavy()))
    t.dev.onMessage(A, { type: 'dev.tabs', tabs: full })
    const rowsBytes = Buffer.byteLength(JSON.stringify(full))
    expect(rowsBytes).toBeLessThan(DEV_INSTALL_MAX_BYTES)
    expect(rowsBytes + SHOT_THUMB_MAX).toBeGreaterThan(DEV_INSTALL_MAX_BYTES)
    t.shot(7, thumbOf(SHOT_THUMB_MAX))
    const rows = t.rows()
    expect(rows).toHaveLength(4)
    for (const r of rows) expect(r.history).toHaveLength(20)
    expect(rows.map(({ shot: _shot, ...r }) => r)).toEqual(full)
    // The row still says the shot was copied.
    expect(t.shotOn(7)).toEqual({ thumb: null, until: Date.now() + SHOT_VIEW_MS })
  })

  it('carries the thumbnail when the rows leave room, and stays under the cap', () => {
    const t = setup()
    t.shot(7, thumbOf(SHOT_THUMB_MAX))
    expect(t.shotOn(7)?.thumb?.length).toBeGreaterThan(SHOT_THUMB_MAX - 4)
    expect(Buffer.byteLength(JSON.stringify(t.rows()))).toBeLessThanOrEqual(DEV_INSTALL_MAX_BYTES)
  })

  it('counts the shot itself, not only the thumbnail: rows and thumbnail just under the cap leave it out', () => {
    const t = setup()
    const rows = Array.from({ length: 2 }, (_, i) => row(i + 7, heavy()))
    t.dev.onMessage(A, { type: 'dev.tabs', tabs: rows })
    const rowsBytes = Buffer.byteLength(JSON.stringify(rows))
    const thumb = thumbOf(DEV_INSTALL_MAX_BYTES - rowsBytes - 10)
    expect(thumb.length).toBeLessThanOrEqual(SHOT_THUMB_MAX)
    expect(rowsBytes + thumb.length).toBeLessThanOrEqual(DEV_INSTALL_MAX_BYTES)
    t.shot(7, thumb)
    expect(t.shotOn(7)?.thumb).toBeNull()
    expect(Buffer.byteLength(JSON.stringify(t.rows()))).toBeLessThanOrEqual(DEV_INSTALL_MAX_BYTES)
  })
})

describe('the capture sound', () => {
  it('is off unless the message asks: sound false plays nothing', () => {
    const t = setup()
    t.shot(7, THUMB, false)
    t.shot(8, null, false)
    expect(t.play).not.toHaveBeenCalled()
  })

  it('plays at most once per second per install', () => {
    const t = setup()
    t.shot(7, THUMB, true)
    expect(t.play).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(SHOT_SOUND_MIN_MS - 1)
    t.shot(7, THUMB, true)
    expect(t.play).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    t.shot(7, THUMB, true)
    expect(t.play).toHaveBeenCalledTimes(2)
    // A reconnect does not reset it.
    t.dev.disconnect(A)
    t.dev.connect(A, 'Chrome', SHOTVIEW)
    t.dev.onMessage(A, { type: 'dev.tabs', tabs: [row(7)] })
    t.shot(7, THUMB, true)
    expect(t.play).toHaveBeenCalledTimes(2)
  })

  it('is silent when none is given (a CompanionDev built without one)', () => {
    const dev = new CompanionDev({ send: () => undefined, changed: () => undefined, enabled: () => true, pairedCount: () => 1 })
    dev.connect(A, 'Chrome', SHOTVIEW)
    dev.onMessage(A, { type: 'dev.tabs', tabs: [row(7)] })
    expect(() => dev.onMessage(A, { type: 'dev.shot', tabId: 7, thumb: null, sound: true })).not.toThrow()
  })

  it('runs /usr/bin/afplay on the system file alone, with an argument list', () => {
    const exec = vi.fn((_file: string, _args: readonly string[], _opts: { timeout: number }, cb: (e: Error | null) => void) => cb(null))
    afplayShotSound(exec).play()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0].slice(0, 3)).toEqual([
      '/usr/bin/afplay',
      ['/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Screen Capture.aif'],
      { timeout: SHOT_SOUND_TIMEOUT_MS },
    ])
    expect(AFPLAY).toBe('/usr/bin/afplay')
    expect(SHOT_SOUND_FILE.startsWith('/System/Library/')).toBe(true)
  })

  it('ignores a player that fails or throws', () => {
    const failing = vi.fn((_f: string, _a: readonly string[], _o: { timeout: number }, cb: (e: Error | null) => void) => cb(new Error('ENOENT')))
    expect(() => afplayShotSound(failing).play()).not.toThrow()
    const throwing = vi.fn(() => { throw new TypeError('bad') })
    expect(() => afplayShotSound(throwing).play()).not.toThrow()
  })

  it('a demo plays nothing: buildApp hands it the silent sound', () => {
    expect(() => demoShotSound.play()).not.toThrow()
    const app = readFileSync(join(import.meta.dirname, '..', 'src', 'app.ts'), 'utf8')
    expect(app).toMatch(/\.\.\.\(demo \? \{[^}]*shotSound: demoShotSound[^}]*\} : \{\}\)/)
  })
})
