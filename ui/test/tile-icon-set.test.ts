import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { ICONS, TILE_ICONS } from '../src/shared/icons'
import { isChoosablePictogram, tileIconUrl } from '../src/shared/tileIcon'

const widgetsDir = new URL('../../widgets/', import.meta.url)

describe('the choosable pictograms', () => {
  it('are all drawn by the icon table', () => {
    for (const name of TILE_ICONS) expect(Object.hasOwn(ICONS, name), name).toBe(true)
  })
  it('hold 60 distinct names and no brand mark', () => {
    expect(new Set(TILE_ICONS).size).toBe(60)
    expect(TILE_ICONS).not.toContain('github')
  })
  it('include the icon every built-in widget suggests', () => {
    let checked = 0
    for (const id of readdirSync(widgetsDir)) {
      let manifest: { icon?: string }
      try { manifest = JSON.parse(readFileSync(new URL(`${id}/manifest.json`, widgetsDir), 'utf8')) } catch { continue }
      if (!manifest.icon) continue
      expect(TILE_ICONS, `${id}: ${manifest.icon}`).toContain(manifest.icon)
      checked++
    }
    // A moved widgets/ folder or unreadable manifests would otherwise pass having checked nothing.
    expect(checked).toBeGreaterThanOrEqual(10)
  })
  it('are told apart from the admin tool icons and from prototype keys', () => {
    expect(isChoosablePictogram('server')).toBe(true)
    expect(isChoosablePictogram('trash-2')).toBe(false)
    expect(isChoosablePictogram('constructor')).toBe(false)
    expect(isChoosablePictogram(undefined)).toBe(false)
  })
})

describe('tileIconUrl', () => {
  it('points at the byte route, encoded', () => {
    expect(tileIconUrl('1-nas.svg')).toBe('/api/tile-icons/1-nas.svg')
  })
})
