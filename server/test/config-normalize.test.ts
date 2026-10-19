import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from '../src/config/store.js'
import { normalizeInstances, parseCityString } from '../src/config/normalize.js'
import { migrateAppearance, normalizeV3 } from '../src/config/migrate.js'
import { ConfigSchema } from '../src/config/schema.js'
import { V3ConfigSchema } from '../src/config/v3.js'

/** A v4 config showing one clock, `clock-1`, on the Edge's first page. */
const clock = (settings: Record<string, unknown>) => ({
  version: 4,
  widgets: { 'clock-1': { widgetId: 'clock', settings } },
  screens: [{
    id: 'edge', name: 'Xeneon Edge', kind: 'edge',
    pages: [{ id: 'home', name: 'Accueil', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 }] }],
  }],
})
/** The same clock in a v3 file, as written before the list setting existed. */
const v3clock = (settings: Record<string, unknown>) => ({
  version: 3,
  pages: [{ id: 'home', name: 'Accueil', widgets: [{ instanceId: 'clock-1', widgetId: 'clock', x: 0, y: 0, w: 16, h: 4, settings }] }],
})
const citiesOf = (config: { widgets: Record<string, { settings: Record<string, unknown> }> }): unknown =>
  config.widgets['clock-1'].settings.cities

describe('parseCityString', () => {
  it('reads one item per city, defaulting the per-city flags', () => {
    expect(parseCityString('NYC=America/New_York, Tokyo=Asia/Tokyo')).toEqual([
      { label: 'NYC', timezone: 'America/New_York', hour12: false, seconds: false },
      { label: 'Tokyo', timezone: 'Asia/Tokyo', hour12: false, seconds: false },
    ])
  })
  it('turns an empty string into an empty list', () => {
    expect(parseCityString('')).toEqual([])
  })
  it('drops an entry without a zone, exactly as the old widget did when rendering', () => {
    expect(parseCityString('NYC, Tokyo=Asia/Tokyo, Paris=')).toEqual([
      { label: 'Tokyo', timezone: 'Asia/Tokyo', hour12: false, seconds: false },
    ])
  })
})

describe('migrateAppearance', () => {
  /** One instance carrying the legacy keys, parsed exactly as a file on disk would be. */
  const parse = (extra: Record<string, unknown>) => V3ConfigSchema.parse({
    version: 3,
    pages: [{ id: 'home', name: 'Accueil', widgets: [{ instanceId: 'w-1', widgetId: 'clock', x: 0, y: 0, w: 16, h: 4, ...extra }] }],
  }).pages[0].widgets[0]

  it('turns a transparent tile into a fully faded one with no colour of its own', () => {
    const w = parse({ appearance: 'transparent' })
    migrateAppearance(w)
    expect(w.opacity).toBe(0)
    expect(w.bgColor).toBeUndefined()
  })
  it('turns an outlined accent into the frame mode', () => {
    const w = parse({ appearance: 'accent', accentStyle: 'outline', accentColor: '#d9b36a' })
    migrateAppearance(w)
    expect(w.accentMode).toBe('frame')
    expect(w.accentColor).toBe('#d9b36a')
  })
  it('turns a filled accent into the fill mode, with or without an explicit style', () => {
    for (const extra of [{ appearance: 'accent' }, { appearance: 'accent', accentStyle: 'fill' }]) {
      const w = parse(extra)
      migrateAppearance(w)
      expect(w.accentMode).toBe('fill')
    }
  })
  it('leaves a panel tile with none of the new keys set', () => {
    const w = parse({ appearance: 'panel', opacity: 0.5 })
    migrateAppearance(w)
    expect(w.accentMode).toBeUndefined()
    expect(w.bgColor).toBeUndefined()
    expect(w.opacity).toBe(0.5)
  })
  it('drops both legacy keys, so the instance is written back in the new shape', () => {
    const w = parse({ appearance: 'accent', accentStyle: 'outline' })
    migrateAppearance(w)
    expect('appearance' in w).toBe(false)
    expect('accentStyle' in w).toBe(false)
    expect(JSON.stringify(w)).not.toMatch(/appearance|accentStyle/)
  })
  it('leaves an instance already written in the new shape untouched', () => {
    const w = parse({ bgColor: '#123456', accentMode: 'frame', opacity: 0.4 })
    migrateAppearance(w)
    expect(w).toMatchObject({ bgColor: '#123456', accentMode: 'frame', opacity: 0.4 })
  })
})

describe('normalizeV3', () => {
  it('converts every legacy appearance of a loaded config, on all pages', () => {
    const config = normalizeV3(V3ConfigSchema.parse({
      version: 3,
      pages: [
        { id: 'a', name: 'A', widgets: [{ instanceId: 'w-1', widgetId: 'clock', x: 0, y: 0, w: 16, h: 4, appearance: 'transparent' }] },
        { id: 'b', name: 'B', widgets: [{ instanceId: 'w-2', widgetId: 'clock', x: 0, y: 0, w: 16, h: 4, appearance: 'accent', accentStyle: 'outline' }] },
      ],
    }))
    expect(config.pages[0].widgets[0].opacity).toBe(0)
    expect(config.pages[1].widgets[0].accentMode).toBe('frame')
    expect(JSON.stringify(config)).not.toMatch(/appearance|accentStyle/)
  })

  it('converts a v3 clock whose cities are still a string', () => {
    const config = normalizeV3(V3ConfigSchema.parse(v3clock({ cities: 'NYC=America/New_York' })))
    expect(config.pages[0].widgets[0].settings.cities).toEqual([{ label: 'NYC', timezone: 'America/New_York', hour12: false, seconds: false }])
  })
})

describe('normalizeInstances', () => {
  it('drops an orphan widget', () => {
    const config = normalizeInstances(ConfigSchema.parse({
      ...clock({}),
      widgets: { 'clock-1': { widgetId: 'clock' }, 'cpu-9': { widgetId: 'cpu' } },
    }))
    expect(Object.keys(config.widgets)).toEqual(['clock-1'])
  })
  it('keeps a widget placed only in a bar', () => {
    const base = clock({})
    const config = normalizeInstances(ConfigSchema.parse({
      ...base,
      widgets: { ...base.widgets, 'cpu-1': { widgetId: 'cpu' } },
      screens: [{ ...base.screens[0], nav: [{ instanceId: 'cpu-1' }] }],
    }))
    expect(Object.keys(config.widgets).sort()).toEqual(['clock-1', 'cpu-1'])
  })
  it('converts a clock instance whose cities are still a string', () => {
    const config = normalizeInstances(ConfigSchema.parse(clock({ seconds: true, cities: 'NYC=America/New_York' })))
    expect(citiesOf(config)).toEqual([{ label: 'NYC', timezone: 'America/New_York', hour12: false, seconds: false }])
    expect(config.widgets['clock-1'].settings.seconds).toBe(true)
  })
  it('converts a clock that sits only in a bar too', () => {
    const base = clock({})
    const config = normalizeInstances(ConfigSchema.parse({
      ...base,
      widgets: { ...base.widgets, 'clock-2': { widgetId: 'clock', settings: { cities: 'Tokyo=Asia/Tokyo' } } },
      screens: [{ ...base.screens[0], nav: [{ instanceId: 'clock-2' }] }],
    }))
    expect(config.widgets['clock-2'].settings.cities).toEqual([{ label: 'Tokyo', timezone: 'Asia/Tokyo', hour12: false, seconds: false }])
  })
  it('leaves a list alone, and never touches another widget', () => {
    const list = [{ label: 'Tokyo', timezone: 'Asia/Tokyo', hour12: true, seconds: true }]
    expect(citiesOf(normalizeInstances(ConfigSchema.parse(clock({ cities: list }))))).toEqual(list)
    const other = ConfigSchema.parse({ ...clock({}), widgets: { 'clock-1': { widgetId: 'weather', settings: { cities: 'NYC=America/New_York' } } } })
    expect(citiesOf(normalizeInstances(other))).toBe('NYC=America/New_York')
  })
})

describe('ConfigStore', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fremkit-')) })

  it('serves the converted list after loading a file written before the list setting', async () => {
    const file = join(dir, 'fremkit.json')
    await writeFile(file, JSON.stringify(v3clock({ cities: 'NYC=America/New_York' })))
    const store = new ConfigStore(file)
    expect(citiesOf(await store.load())).toEqual([{ label: 'NYC', timezone: 'America/New_York', hour12: false, seconds: false }])
  })

  it('converts on save too, so a PUT of an old config never stores the string back', async () => {
    const store = new ConfigStore(join(dir, 'fremkit.json'))
    await store.load()
    expect(citiesOf(await store.save(clock({ cities: 'Tokyo=Asia/Tokyo' })))).toEqual([
      { label: 'Tokyo', timezone: 'Asia/Tokyo', hour12: false, seconds: false },
    ])
  })
})
