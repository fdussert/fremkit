import { describe, it, expect } from 'vite-plus/test'
import {
  applyBudget, buildView, countNodes, findNode, pruneTree, resize, validateTree, DEFAULT_POLICY, type DiskNode,
} from '../src/providers/disk-map-tree.js'

const dir = (name: string, size: number, children?: DiskNode[], extra: Partial<DiskNode> = {}): DiskNode =>
  ({ name, kind: 'd', size, ...(children ? { children } : {}), ...extra })
const file = (name: string, size: number): DiskNode => ({ name, kind: 'f', size, files: 1 })

describe('validateTree', () => {
  it('accepts what the scanner prints', () => {
    const tree = validateTree({
      name: 'example', kind: 'd', size: 10, files: 2, unreadable: 1, others: [3, 4], more: true,
      children: [{ name: 'a', kind: 'f', size: 6 }, { name: 'Mail', kind: 'x', size: 0, unreadable: 1 }],
    })
    expect(tree.children?.map((c) => c.kind)).toEqual(['f', 'x'])
    expect(tree.others).toEqual([3, 4])
  })
  it('refuses a name that is a path, an unknown kind, a negative size', () => {
    expect(() => validateTree({ name: 'r', kind: 'd', size: 1, children: [{ name: '../x', kind: 'd', size: 1 }] })).toThrow()
    expect(() => validateTree({ name: 'r', kind: 'd', size: 1, children: [{ name: '..', kind: 'd', size: 1 }] })).toThrow()
    expect(() => validateTree({ name: 'r', kind: 'z', size: 1 })).toThrow()
    expect(() => validateTree({ name: 'r', kind: 'd', size: -1 })).toThrow()
    expect(() => validateTree({ name: 'r', kind: 'd', size: 1, others: [1] })).toThrow()
  })
  it('refuses a tree deeper than it would ever draw', () => {
    let node: DiskNode = file('leaf', 1)
    for (let i = 0; i < 80; i++) node = dir(`d${i}`, 1, [node])
    expect(() => validateTree(node)).toThrow('too deep')
  })
})

describe('findNode and resize', () => {
  it('finds a node by names and gives its ancestors a folder\'s new size', () => {
    const tree = dir('~', 100, [dir('Library', 80, [dir('Caches', 50, undefined, { more: true })]), file('a', 20)])
    expect(findNode(tree, ['Library', 'Caches'])?.size).toBe(50)
    expect(findNode(tree, ['Library', 'nope'])).toBeNull()
    expect(resize(tree, ['Library', 'Caches'], dir('Caches', 70, [file('big', 60)], { files: 4 }))).toBe(true)
    const caches = findNode(tree, ['Library', 'Caches'])!
    expect(caches.size).toBe(70)
    // The shape stays: the measurement is held elsewhere, the tree only takes the numbers.
    expect(caches.children).toBeUndefined()
    expect(tree.size).toBe(120)
    expect(tree.children?.[0].size).toBe(100)
    expect(tree.files).toBe(4)
    expect(resize(tree, ['Gone', 'x'], file('x', 1))).toBe(false)
  })
})

describe('pruneTree and applyBudget', () => {
  it('keeps the largest, folds the rest into others, keeps unreadable folders', () => {
    const tree = dir('r', 1000, [file('small', 1), file('big', 600), file('mid', 300), dir('locked', 0, undefined, { kind: 'x', unreadable: 1 })])
    pruneTree(tree, { ...DEFAULT_POLICY, minBytes: 10, maxChildren: 1 })
    expect(tree.children?.map((c) => c.name)).toEqual(['big', 'locked'])
    expect(tree.others).toEqual([2, 301])
    // Cut by maxChildren, not by the budget: a rescan would cut the same way, so no `more`.
    expect(tree.more).toBeUndefined()
  })
  it('cuts below the depth and says there is more', () => {
    const tree = dir('r', 100, [dir('a', 100, [dir('b', 100, [file('c', 100)])])])
    pruneTree(tree, { ...DEFAULT_POLICY, minBytes: 1, depth: 1 })
    expect(tree.children?.[0].children).toBeUndefined()
    expect(tree.children?.[0].more).toBe(true)
  })
  it('keeps at most the budget, the largest first', () => {
    const tree = dir('r', 1000, [dir('a', 700, [file('a1', 690), file('a2', 10)]), dir('b', 300, [file('b1', 300)])])
    applyBudget(tree, 3)
    expect(countNodes(tree)).toBe(4)
    expect(tree.children?.map((c) => c.name)).toEqual(['a', 'b'])
    expect(tree.children?.[0].children?.map((c) => c.name)).toEqual(['a1'])
    expect(tree.children?.[1].children).toBeUndefined()
    // b1 is 30 % of b: worth drawing, so looking inside b rescans it.
    expect(tree.children?.[1].more).toBe(true)
  })
})

describe('buildView', () => {
  const tree = dir('~', 1000, [
    dir('Library', 600, [dir('Caches', 400), dir('Tiny', 1), file('f', 199)]),
    file('movie', 300),
    file('speck', 2),
    dir('Mail', 0, undefined, { kind: 'x', unreadable: 1 }),
  ], { others: [5, 98], unreadable: 1 })

  it('sends the rings asked for, narrow entries folded into one Others', () => {
    const view = buildView(tree, { rings: 2, minDegrees: 3.5, listMax: 60 })
    expect(view.children?.map((c) => [c.kind, c.name])).toEqual([['d', 'Library'], ['f', 'movie'], ['f', 'speck'], ['x', 'Mail'], ['o', '']])
    expect(view.children?.at(-1)).toMatchObject({ kind: 'o', size: 98, count: 5 })
    // Second ring: Tiny is 0.1 % of the centre, below 3.5°.
    expect(view.children?.[0].children?.map((c) => c.name)).toEqual(['Caches', 'f', ''])
    // Two rings: nothing below the second.
    expect(view.children?.[0].children?.[0].children).toBeUndefined()
  })
  it('caps the list', () => {
    const many = dir('r', 100, Array.from({ length: 100 }, (_, i) => file(`f${i}`, 1)))
    const view = buildView(many, { rings: 1, minDegrees: 3.5, listMax: 10 })
    expect(view.children).toHaveLength(11)
    expect(view.children?.at(-1)).toMatchObject({ kind: 'o', count: 90, size: 90 })
  })
  it('draws nothing inside a folder cut by the depth', () => {
    const cut = dir('r', 100, [dir('deep', 100, undefined, { others: [3, 100], more: true })])
    const view = buildView(cut, { rings: 3, minDegrees: 3.5, listMax: 60 })
    expect(view.children?.[0]).toEqual({ name: 'deep', kind: 'd', size: 100, more: true })
  })
})
