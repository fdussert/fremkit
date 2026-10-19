import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { ChangeBatcher, classifyChange, widgetDevDir, WidgetDevWatcher, type Timers, type WidgetReload } from '../src/widgets/dev.js'

describe('widgetDevDir', () => {
  it('is off unless FREMKIT_WIDGET_DEV=1', () => {
    expect(widgetDevDir({}, '/data')).toBeUndefined()
    expect(widgetDevDir({ FREMKIT_WIDGET_DEV: '0' }, '/data')).toBeUndefined()
    expect(widgetDevDir({ FREMKIT_WIDGET_DEV_DIR: '/elsewhere' }, '/data')).toBeUndefined()
  })

  it('defaults to <dataDir>/widgets-dev, never the marketplace folder', () => {
    expect(widgetDevDir({ FREMKIT_WIDGET_DEV: '1' }, '/data')).toBe(join('/data', 'widgets-dev'))
  })

  it('takes an absolute FREMKIT_WIDGET_DEV_DIR and refuses a relative one', () => {
    expect(widgetDevDir({ FREMKIT_WIDGET_DEV: '1', FREMKIT_WIDGET_DEV_DIR: '/src/sietch/widgets' }, '/data')).toBe('/src/sietch/widgets')
    expect(() => widgetDevDir({ FREMKIT_WIDGET_DEV: '1', FREMKIT_WIDGET_DEV_DIR: 'widgets' }, '/data')).toThrow(/absolute/)
  })
})

describe('classifyChange', () => {
  it('names the widget a file belongs to', () => {
    expect(classifyChange('my-widget/index.html')).toEqual({ id: 'my-widget', manifest: false })
    expect(classifyChange('my-widget/assets/app.js')).toEqual({ id: 'my-widget', manifest: false })
  })

  it('marks a manifest, and only the top-level one, as a rescan', () => {
    expect(classifyChange('my-widget/manifest.json')).toEqual({ id: 'my-widget', manifest: true })
    expect(classifyChange('my-widget/fixtures/manifest.json')).toEqual({ id: 'my-widget', manifest: false })
  })

  it('treats the folder itself appearing or going as a rescan', () => {
    expect(classifyChange('my-widget')).toEqual({ id: 'my-widget', manifest: true })
  })

  it('ignores what is not a widget: no name, a root that is not an id, dotfiles', () => {
    expect(classifyChange(null)).toBeNull()
    expect(classifyChange('')).toBeNull()
    expect(classifyChange('.DS_Store')).toBeNull()
    expect(classifyChange('README.md')).toBeNull()
    expect(classifyChange('my-widget.bak/index.html')).toBeNull()
    expect(classifyChange('.tmp-123/manifest.json')).toBeNull()
    expect(classifyChange('my-widget/.git/index')).toBeNull()
    expect(classifyChange('my-widget/.DS_Store')).toBeNull()
  })

  it('ignores the scratch files editors write while saving', () => {
    expect(classifyChange('my-widget/index.html~')).toBeNull()
    expect(classifyChange('my-widget/4913')).toBeNull()
    expect(classifyChange('my-widget/index.html.swp')).toBeNull()
    expect(classifyChange('my-widget/#index.html#')).toBeNull()
  })

  it('reads a Windows separator like a slash', () => {
    expect(classifyChange('my-widget\\manifest.json')).toEqual({ id: 'my-widget', manifest: true })
  })
})

/** Timers driven by hand, with a clock that only moves when told. */
function fakeClock() {
  let now = 0
  let next = 1
  const pending = new Map<number, { at: number; cb: () => void }>()
  const timers: Timers = {
    setTimeout: (cb, ms) => { const id = next++; pending.set(id, { at: now + ms, cb }); return id },
    clearTimeout: (id) => { pending.delete(id as number) },
  }
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      pending.delete(due[0])
      now = due[1].at
      due[1].cb()
    }
    now = target
  }
  return { timers, advance, now: () => now, pending }
}

describe('ChangeBatcher', () => {
  it('turns a burst of saves into one reload, after the burst', () => {
    const clock = fakeClock()
    const flushed: WidgetReload[] = []
    const b = new ChangeBatcher((r) => flushed.push(r), 150, 1000, clock.timers, clock.now)
    b.add({ id: 'b', manifest: false })
    clock.advance(100)
    b.add({ id: 'a', manifest: false })
    clock.advance(100)
    b.add({ id: 'b', manifest: true })
    clock.advance(149)
    expect(flushed).toEqual([])
    clock.advance(1)
    expect(flushed).toEqual([{ ids: ['a', 'b'], manifest: true }])
  })

  it('starts afresh after a flush', () => {
    const clock = fakeClock()
    const flushed: WidgetReload[] = []
    const b = new ChangeBatcher((r) => flushed.push(r), 150, 1000, clock.timers, clock.now)
    b.add({ id: 'a', manifest: true })
    clock.advance(150)
    b.add({ id: 'b', manifest: false })
    clock.advance(150)
    expect(flushed).toEqual([{ ids: ['a'], manifest: true }, { ids: ['b'], manifest: false }])
  })

  it('never waits longer than the ceiling while writes keep coming', () => {
    const clock = fakeClock()
    const flushed: WidgetReload[] = []
    const b = new ChangeBatcher((r) => flushed.push(r), 150, 1000, clock.timers, clock.now)
    for (let t = 0; t < 1000; t += 100) { b.add({ id: 'a', manifest: false }); clock.advance(100) }
    expect(flushed).toHaveLength(1)
    expect(clock.now()).toBe(1000)
  })

  it('drops what is pending on cancel', () => {
    const clock = fakeClock()
    const flushed: WidgetReload[] = []
    const b = new ChangeBatcher((r) => flushed.push(r), 150, 1000, clock.timers, clock.now)
    b.add({ id: 'a', manifest: false })
    b.cancel()
    clock.advance(1000)
    expect(flushed).toEqual([])
    expect(clock.pending.size).toBe(0)
  })
})

describe('WidgetDevWatcher', () => {
  it('watches every root, filters events and reports one batch', async () => {
    const clock = fakeClock()
    const handlers = new Map<string, (f: string | null) => void>()
    const closed: string[] = []
    const reloads: WidgetReload[] = []
    const watcher = new WidgetDevWatcher({
      roots: ['/dev', '/builtin'],
      watch: (dir, onChange) => { handlers.set(dir, onChange); return { close: () => closed.push(dir) } },
      batcher: (flush) => new ChangeBatcher(flush, 150, 1000, clock.timers, clock.now),
      onReload: (r) => { reloads.push(r) },
    })
    watcher.start()
    expect([...handlers.keys()]).toEqual(['/dev', '/builtin'])
    handlers.get('/dev')!('my-widget/index.html')
    handlers.get('/dev')!('my-widget/.index.html.swp')
    handlers.get('/builtin')!('.DS_Store')
    handlers.get('/builtin')!('clock/manifest.json')
    clock.advance(150)
    await Promise.resolve(); await Promise.resolve()
    expect(reloads).toEqual([{ ids: ['clock', 'my-widget'], manifest: true }])
    watcher.close()
    expect(closed).toEqual(['/dev', '/builtin'])
  })

  it('reports a failing reload or a missing root without throwing', async () => {
    const clock = fakeClock()
    const errors: Error[] = []
    let handler: ((f: string | null) => void) | undefined
    const watcher = new WidgetDevWatcher({
      roots: ['/missing', '/dev'],
      watch: (dir, onChange) => {
        if (dir === '/missing') throw new Error('ENOENT')
        handler = onChange
        return { close: () => {} }
      },
      batcher: (flush) => new ChangeBatcher(flush, 150, 1000, clock.timers, clock.now),
      onReload: () => { throw new Error('scan failed') },
      onError: (e) => errors.push(e),
    })
    watcher.start()
    handler!('w/index.html')
    clock.advance(150)
    await vi.waitFor(() => expect(errors.map((e) => e.message)).toEqual(['ENOENT', 'scan failed']))
    watcher.close()
  })
})

describe('WidgetDevWatcher on a real folder', () => {
  it('reloads a widget when one of its files is saved', async () => {
    const { mkdtemp, mkdir, writeFile, realpath } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const root = await realpath(await mkdtemp(join(tmpdir(), 'widgets-dev-')))
    await mkdir(join(root, 'my-widget'))
    const reloads: WidgetReload[] = []
    const watcher = new WidgetDevWatcher({ roots: [root], onReload: (r) => { reloads.push(r) } })
    watcher.start()
    try {
      // fs.watch can take a moment to arm on macOS; keep saving until the first event lands.
      await vi.waitFor(async () => {
        await writeFile(join(root, 'my-widget', 'index.html'), `<html>${Date.now()}</html>`)
        expect(reloads.some((r) => r.ids.includes('my-widget'))).toBe(true)
      }, { timeout: 5000, interval: 200 })
    } finally {
      watcher.close()
    }
  })
})
