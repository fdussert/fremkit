import { describe, it, expect } from 'vitest'
import { DEFAULT_WIDGET_DIM, backgroundStyle, backgroundUrl, fade, surfaceOpacity, widgetBackgroundStyle, widgetDim } from '../src/shared/background'

describe('backgroundUrl', () => {
  it('points at the backgrounds route and escapes the name', () => {
    expect(backgroundUrl('1-a.png')).toBe('/api/backgrounds/1-a.png')
    expect(backgroundUrl('1-a b.png')).toBe('/api/backgrounds/1-a%20b.png')
  })
})

describe('backgroundStyle', () => {
  it('stays empty when nothing is configured', () => {
    expect(backgroundStyle(undefined)).toEqual({})
    expect(backgroundStyle({})).toEqual({})
  })
  it('applies a colour alone', () => {
    expect(backgroundStyle({ color: '#101820' })).toEqual({ 'background-color': '#101820' })
  })
  it('ignores a malformed colour rather than writing it into the style', () => {
    expect(backgroundStyle({ color: 'javascript:alert(1)' })).toEqual({})
  })
  it('applies an image, centred and never repeated, covering by default', () => {
    expect(backgroundStyle({ image: '1-a.png' })).toEqual({
      'background-image': 'url(/api/backgrounds/1-a.png)',
      'background-size': 'cover',
      'background-position': 'center',
      'background-repeat': 'no-repeat',
    })
  })
  it('honours the contain fit', () => {
    expect(backgroundStyle({ image: '1-a.png', fit: 'contain' })['background-size']).toBe('contain')
  })
  it('combines colour and image', () => {
    const style = backgroundStyle({ color: '#101820', image: '1-a.png', fit: 'cover' })
    expect(style['background-color']).toBe('#101820')
    expect(style['background-image']).toBe('url(/api/backgrounds/1-a.png)')
  })
})

describe('widgetBackgroundStyle', () => {
  it('stays empty without an image, so the tile keeps its appearance surface', () => {
    expect(widgetBackgroundStyle(undefined)).toEqual({})
  })
  it('paints the image centred and never repeated, covering by default', () => {
    expect(widgetBackgroundStyle({ image: '1-a.png' })).toEqual({
      'background-image': 'url(/api/backgrounds/1-a.png)',
      'background-size': 'cover',
      'background-position': 'center',
      'background-repeat': 'no-repeat',
    })
  })
  it('honours the contain fit', () => {
    expect(widgetBackgroundStyle({ image: '1-a.png', fit: 'contain' })['background-size']).toBe('contain')
  })
  it('never sets a background colour, unlike the screen background', () => {
    expect(widgetBackgroundStyle({ image: '1-a.png' })['background-color']).toBeUndefined()
  })
})

describe('widgetDim', () => {
  it('falls back to the default when no dim is stored', () => {
    expect(widgetDim(undefined)).toBe(DEFAULT_WIDGET_DIM)
    expect(widgetDim({ image: '1-a.png' })).toBe(DEFAULT_WIDGET_DIM)
  })
  it('passes a stored value through, zero included', () => {
    expect(widgetDim({ image: '1-a.png', dim: 0 })).toBe(0)
    expect(widgetDim({ image: '1-a.png', dim: 0.6 })).toBe(0.6)
  })
  it('clamps rather than blanking the tile out', () => {
    expect(widgetDim({ image: '1-a.png', dim: 5 })).toBe(0.9)
    expect(widgetDim({ image: '1-a.png', dim: -1 })).toBe(0)
  })
  it('ignores a value that is not a finite number', () => {
    expect(widgetDim({ image: '1-a.png', dim: NaN })).toBe(DEFAULT_WIDGET_DIM)
    expect(widgetDim({ image: '1-a.png', dim: '0.5' as unknown as number })).toBe(DEFAULT_WIDGET_DIM)
  })
})

describe('surfaceOpacity', () => {
  it('reads a missing value as solid, so a config written before the setting still paints', () => {
    expect(surfaceOpacity(undefined)).toBe(1)
  })
  it('passes a stored value through, zero included', () => {
    expect(surfaceOpacity(0)).toBe(0)
    expect(surfaceOpacity(0.4)).toBe(0.4)
    expect(surfaceOpacity(1)).toBe(1)
  })
  it('clamps rather than letting a bad value out of the 0–1 range', () => {
    expect(surfaceOpacity(1.5)).toBe(1)
    expect(surfaceOpacity(-0.1)).toBe(0)
  })
  it('ignores a value that is not a finite number', () => {
    expect(surfaceOpacity(NaN)).toBe(1)
    expect(surfaceOpacity('0.5' as unknown as number)).toBe(1)
  })
})

describe('fade', () => {
  it('leaves a colour untouched when it is fully opaque', () => {
    expect(fade('#d9b36a', 1)).toBe('#d9b36a')
    expect(fade('var(--surface)', 1)).toBe('var(--surface)')
  })
  it('turns a literal hex into an exact rgba', () => {
    expect(fade('#d9b36a', 0.4)).toBe('rgba(217, 179, 106, 0.4)')
  })
  it('mixes a CSS variable, whose value only the browser knows', () => {
    expect(fade('var(--surface)', 0.4)).toBe('color-mix(in srgb, var(--surface) 40%, transparent)')
  })
})
