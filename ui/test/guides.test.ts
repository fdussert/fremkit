import { describe, expect, it } from 'vitest'
import { alignmentGuides, boundsOf } from '../src/admin/guides'

const grid = { cols: 64, rows: 16 }

describe('alignmentGuides', () => {
  it('draws nothing for a tile that lines up with nothing', () => {
    expect(alignmentGuides({ x: 3, y: 3, w: 5, h: 3 }, [{ x: 20, y: 9, w: 7, h: 4 }], grid)).toEqual([])
  })

  it('lines up left edges, spanning both tiles', () => {
    const guides = alignmentGuides({ x: 10, y: 1, w: 4, h: 3 }, [{ x: 10, y: 8, w: 6, h: 2 }], grid)
    expect(guides).toEqual([{ axis: 'x', at: 10, from: 1, to: 10, kind: 'edge' }])
  })

  it('counts a right edge against a left edge: two tiles side by side share a line', () => {
    const guides = alignmentGuides({ x: 6, y: 9, w: 4, h: 2 }, [{ x: 10, y: 1, w: 4, h: 3 }], grid)
    expect(guides).toEqual([{ axis: 'x', at: 10, from: 1, to: 11, kind: 'edge' }])
  })

  it('matches centres with centres, on half cells too', () => {
    // Centre of 10..15 is 12.5; centre of 11..14 is 12.5.
    const guides = alignmentGuides({ x: 10, y: 1, w: 5, h: 2 }, [{ x: 11, y: 5, w: 3, h: 3 }], grid)
    expect(guides).toEqual([{ axis: 'x', at: 12.5, from: 1, to: 8, kind: 'center' }])
  })

  it('never matches an edge against a centre', () => {
    // The other's centre is at x = 12, the moved tile's left edge too: no guide.
    expect(alignmentGuides({ x: 12, y: 1, w: 3, h: 2 }, [{ x: 10, y: 5, w: 4, h: 3 }], grid)).toEqual([])
  })

  it('lines up with the board: its edges and its centre', () => {
    const guides = alignmentGuides({ x: 28, y: 6, w: 8, h: 3 }, [], grid)
    // Centre 32 = the board's centre; nothing on y (6..9, centre 7.5, the board's is 8).
    expect(guides).toEqual([{ axis: 'x', at: 32, from: 0, to: 16, kind: 'center' }])
    const corner = alignmentGuides({ x: 0, y: 12, w: 4, h: 4 }, [], grid)
    expect(corner).toEqual([
      { axis: 'x', at: 0, from: 0, to: 16, kind: 'edge' },
      { axis: 'y', at: 16, from: 0, to: 64, kind: 'edge' },
    ])
  })

  it('merges every tile meeting on one line into one guide', () => {
    const guides = alignmentGuides({ x: 20, y: 5, w: 4, h: 2 },
      [{ x: 20, y: 0, w: 3, h: 2 }, { x: 18, y: 12, w: 2, h: 2 }], grid)
    expect(guides).toEqual([{ axis: 'x', at: 20, from: 0, to: 14, kind: 'edge' }])
  })

  it('on a resize, compares only what the handle moves', () => {
    const other = { x: 10, y: 8, w: 6, h: 2 }
    // Left edges line up (10), right edges too (16).
    const r = { x: 10, y: 1, w: 6, h: 3 }
    expect(alignmentGuides(r, [other], grid, 'e').map((g) => g.at)).toEqual([13, 16])
    expect(alignmentGuides(r, [other], grid, 'w').map((g) => g.at)).toEqual([10, 13])
    // A south handle moves nothing on x.
    expect(alignmentGuides(r, [other], grid, 's').filter((g) => g.axis === 'x')).toEqual([])
  })
})

describe('boundsOf', () => {
  it('is the box around a group', () => {
    expect(boundsOf([{ x: 2, y: 1, w: 4, h: 2 }, { x: 10, y: 5, w: 2, h: 3 }])).toEqual({ x: 2, y: 1, w: 10, h: 7 })
    expect(boundsOf([])).toBeNull()
  })
})
