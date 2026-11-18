import { describe, expect, it } from 'vitest'
import { dropMarker, gridDropIndex, type Box } from '../src/admin/gifDrag'

// Three thumbnails a row, 100 px squares, 10 px apart: a, b, c on the first row, d, e on the second.
const box = (i: number): Box => ({ left: (i % 3) * 110, top: Math.floor(i / 3) * 110, width: 100, height: 100 })
const boxes = [0, 1, 2, 3, 4].map(box)

describe('gridDropIndex', () => {
  it('counts the thumbnails before the pointer, row by row', () => {
    expect(gridDropIndex(boxes, 10, 50, -1)).toBe(0)
    expect(gridDropIndex(boxes, 60, 50, -1)).toBe(1)
    expect(gridDropIndex(boxes, 300, 50, -1)).toBe(3)
    expect(gridDropIndex(boxes, 10, 150, -1)).toBe(3)
    expect(gridDropIndex(boxes, 200, 150, -1)).toBe(5)
    // Below every row: last.
    expect(gridDropIndex(boxes, 10, 400, -1)).toBe(5)
  })

  it('leaves the dragged thumbnail out when it comes from this group', () => {
    // a dragged past c lands third once moved (index 2).
    expect(gridDropIndex(boxes, 300, 50, 0)).toBe(2)
    // e dragged to the very start.
    expect(gridDropIndex(boxes, 10, 50, 4)).toBe(0)
    // a dropped back on itself stays first.
    expect(gridDropIndex(boxes, 40, 50, 0)).toBe(0)
  })
})

describe('dropMarker', () => {
  const ids = ['a', 'b', 'c']
  it('names the thumbnail the line goes before, null for last', () => {
    expect(dropMarker(ids, 'a', 1)).toBe('c')
    expect(dropMarker(ids, 'c', 0)).toBe('a')
    expect(dropMarker(ids, 'a', 2)).toBeNull()
    // From another group.
    expect(dropMarker(ids, 'x', 1)).toBe('b')
    expect(dropMarker(ids, 'x', 3)).toBeNull()
  })
  it('draws nothing when the drop changes nothing', () => {
    expect(dropMarker(ids, 'b', 1)).toBeUndefined()
    expect(dropMarker(ids, 'c', 2)).toBeUndefined()
  })
})
