import { describe, it, expect } from 'vitest'
import {
  isHexColor, luminance, onAccent, rgb, rgba, tileAccent, tileBody, tileText,
  ON_ACCENT_DARK, ON_ACCENT_LIGHT, THEME_ACCENT, THEME_SURFACE,
} from '../src/shared/color'

describe('isHexColor', () => {
  it('accepts #rrggbb in either case', () => {
    expect(isHexColor('#2f6feb')).toBe(true)
    expect(isHexColor('#2F6FEB')).toBe(true)
  })
  it('rejects anything else', () => {
    for (const bad of ['#fff', '2f6feb', '#2f6feb80', 'red', '', null, undefined, 42]) {
      expect(isHexColor(bad)).toBe(false)
    }
  })
})

describe('rgb', () => {
  it('splits the three channels', () => {
    expect(rgb('#000000')).toEqual([0, 0, 0])
    expect(rgb('#ffffff')).toEqual([255, 255, 255])
    expect(rgb('#2f6feb')).toEqual([0x2f, 0x6f, 0xeb])
  })
})

describe('luminance', () => {
  it('spans 0 to 1 between black and white', () => {
    expect(luminance('#000000')).toBe(0)
    expect(luminance('#ffffff')).toBeCloseTo(1, 10)
  })
  it('weights green above red above blue', () => {
    expect(luminance('#00ff00')).toBeGreaterThan(luminance('#ff0000'))
    expect(luminance('#ff0000')).toBeGreaterThan(luminance('#0000ff'))
  })
})

describe('onAccent', () => {
  it('uses near-black on light accents', () => {
    expect(onAccent('#ffffff')).toBe(ON_ACCENT_DARK)
    expect(onAccent('#f0e68c')).toBe(ON_ACCENT_DARK)
    expect(onAccent('#00ff00')).toBe(ON_ACCENT_DARK)
    // The product accent: sand is light enough to take the dark text.
    expect(onAccent('#d9b36a')).toBe(ON_ACCENT_DARK)
  })
  it('uses white on dark accents', () => {
    expect(onAccent('#000000')).toBe(ON_ACCENT_LIGHT)
    expect(onAccent('#2f6feb')).toBe(ON_ACCENT_LIGHT)
    expect(onAccent('#d9463f')).toBe(ON_ACCENT_LIGHT)
  })
  it('falls back to white for a malformed colour', () => {
    expect(onAccent('nope')).toBe(ON_ACCENT_LIGHT)
  })
})

describe('rgba', () => {
  it('writes the three channels plus the alpha', () => {
    expect(rgba('#000000', 0)).toBe('rgba(0, 0, 0, 0)')
    expect(rgba('#2f6feb', 0.3)).toBe('rgba(47, 111, 235, 0.3)')
    expect(rgba('#ffffff', 1)).toBe('rgba(255, 255, 255, 1)')
  })
})

describe('tileAccent', () => {
  it('prefers the instance colour and falls back to the theme accent', () => {
    expect(tileAccent('#2f6feb')).toBe('#2f6feb')
    expect(tileAccent(undefined)).toBe(THEME_ACCENT)
    expect(tileAccent('nope')).toBe(THEME_ACCENT)
  })
})

describe('tileBody', () => {
  it('is the accent when the accent fills the whole tile', () => {
    expect(tileBody('fill', '#2f6feb', '#ffffff')).toBe('#2f6feb')
    expect(tileBody('fill', undefined, '#ffffff')).toBe(THEME_ACCENT)
  })
  it('is the background colour in every other mode', () => {
    expect(tileBody('none', '#2f6feb', '#ffffff')).toBe('#ffffff')
    expect(tileBody('frame', '#2f6feb', '#ffffff')).toBe('#ffffff')
  })
  it('falls back to the theme surface when the tile carries no colour', () => {
    expect(tileBody(undefined)).toBe(THEME_SURFACE)
    expect(tileBody('frame', '#2f6feb')).toBe(THEME_SURFACE)
  })
})

describe('tileText', () => {
  it('reads the luminance of the body the tile actually paints', () => {
    // The sand accent filling the tile is light, so its text is the dark one.
    expect(tileText('fill', undefined)).toBe(ON_ACCENT_DARK)
    expect(tileText('fill', '#0b0d10')).toBe(ON_ACCENT_LIGHT)
    expect(tileText('none', '#ffffff', '#ffffff')).toBe(ON_ACCENT_DARK)
    // The theme surface is dark, whatever the accent does elsewhere on the tile.
    expect(tileText('frame', '#ffffff')).toBe(ON_ACCENT_LIGHT)
  })
})

/**
 * The luminance rules decide black or white text. Where an instance names no colour of its own
 * they judge what the *theme* paints, not what the built-in palette paints: on a light theme the
 * two answers are opposite, and the value also travels to the widget as `--on-surface`.
 */
describe('the colours the rules are judged against', () => {
  const PAPIER = { accent: '#a2622a', surface: '#fbf9f4' }
  const NUIT = { accent: '#6aa8ff', surface: '#0f1523' }

  it('paints a tile with no colour of its own in the theme accent', () => {
    expect(tileAccent(undefined, PAPIER)).toBe('#a2622a')
    expect(tileAccent('#123456', PAPIER)).toBe('#123456')
    expect(tileAccent(undefined)).toBe(THEME_ACCENT)
  })

  it('reads dark text on a light theme surface, and light text on a dark one', () => {
    expect(tileText('none', undefined, undefined, PAPIER)).toBe(ON_ACCENT_DARK)
    expect(tileText('none', undefined, undefined, NUIT)).toBe(ON_ACCENT_LIGHT)
  })

  it('judges a filled tile against the theme accent it is filled with, not the surface', () => {
    // A pale accent on a light theme: the body is the accent, so the text has to turn dark even
    // though both of this theme's other colours would have said otherwise.
    expect(tileText('fill', undefined, undefined, { accent: '#f5e9c8', surface: '#fbf9f4' })).toBe(ON_ACCENT_DARK)
    expect(tileText('fill', undefined, undefined, PAPIER)).toBe(ON_ACCENT_LIGHT)
    expect(tileBody('fill', undefined, undefined, PAPIER)).toBe(PAPIER.accent)
  })

  it('still lets the instance colour decide when it has one', () => {
    expect(tileText('none', undefined, '#ffffff', NUIT)).toBe(ON_ACCENT_DARK)
  })
})
