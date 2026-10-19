import { describe, expect, it } from 'vitest'
import { BROWSE_LIMIT, flatten, pushRecent, QUERY_LIMIT, scoreHit, searchCommands, type Command, type PaletteGroup } from '../src/admin/palette'

const cmd = (label: string, group: PaletteGroup = 'actions', extra: Partial<Command> = {}): Command =>
  ({ id: `${group}:${label}`, group, label, run: () => {}, ...extra })
const labels = (sections: ReturnType<typeof searchCommands>) => sections.flatMap((s) => s.hits.map((h) => h.command.label))

describe('scoreHit', () => {
  const hit = (c: Command, trail: string[] = []) => ({ command: c, trail })

  it('needs every word somewhere, accents and case aside', () => {
    expect(scoreHit(hit(cmd('Météo')), 'meteo')).not.toBeNull()
    expect(scoreHit(hit(cmd('Duplicate', 'widget', { context: 'Clock' })), 'dup clock')).not.toBeNull()
    expect(scoreHit(hit(cmd('Duplicate')), 'dup clock')).toBeNull()
  })

  it('prefers an exact label, then a prefix, then word starts, then anywhere, then the context', () => {
    const q = 'page'
    const exact = scoreHit(hit(cmd('Page')), q)!
    const prefix = scoreHit(hit(cmd('Page background…')), q)!
    const word = scoreHit(hit(cmd('New page')), q)!
    const inside = scoreHit(hit(cmd('Homepages')), q)!
    const context = scoreHit(hit(cmd('Rename', 'actions', { context: 'Page Home' })), q)!
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(inside)
    expect(inside).toBeGreaterThan(context)
  })

  it('ranks a command in a submenu, and a greyed one, lower', () => {
    expect(scoreHit(hit(cmd('Work')), 'work')!).toBeGreaterThan(scoreHit(hit(cmd('Work'), ['Move to page']), 'work')!)
    expect(scoreHit(hit(cmd('Paste')), 'paste')!).toBeGreaterThan(scoreHit(hit(cmd('Paste', 'actions', { disabled: true })), 'paste')!)
  })
})

describe('flatten', () => {
  it('reaches into submenus but never into a destructive one', () => {
    const tree = [
      cmd('Move to page', 'widget', { run: undefined, children: [cmd('Work', 'widget')] }),
      cmd('Delete everywhere', 'widget', { run: undefined, danger: true, children: [cmd('Delete Clock everywhere', 'widget', { danger: true })] }),
    ]
    const hits = flatten(tree)
    expect(hits.map((h) => h.command.label)).toEqual(['Move to page', 'Work', 'Delete everywhere'])
    expect(hits[1].trail).toEqual(['Move to page'])
  })

  it('leaves the extras of a command that runs by itself behind →', () => {
    const add = cmd('Clock', 'add', { children: [cmd('Add to page', 'add')] })
    expect(flatten([add]).map((h) => h.command.label)).toEqual(['Clock'])
  })
})

describe('searchCommands', () => {
  const many = Array.from({ length: 12 }, (_, i) => cmd(`Widget ${i}`, 'add'))
  const commands = [
    cmd('Duplicate', 'widget'), cmd('New page'), cmd('Home', 'goto'), ...many,
    cmd('Format', 'settings', { context: 'Clock' }),
  ]

  it('browses every section in order, the long ones cut and the settings left out', () => {
    const sections = searchCommands(commands, '')
    expect(sections.map((s) => s.group)).toEqual(['widget', 'actions', 'goto', 'add'])
    const add = sections.find((s) => s.group === 'add')!
    expect(add.hits).toHaveLength(BROWSE_LIMIT)
    expect(add.more).toBe(12 - BROWSE_LIMIT)
  })

  it('puts the recent commands first, newest first, skipping those that are gone or greyed', () => {
    const greyed = cmd('Redo', 'actions', { disabled: true })
    const sections = searchCommands([...commands, greyed], '', ['goto:Home', 'gone', 'actions:Redo', 'widget:Duplicate'])
    expect(sections[0].group).toBe('recent')
    expect(sections[0].hits.map((h) => h.command.label)).toEqual(['Home', 'Duplicate'])
  })

  it('finds the settings, and orders the sections by their best hit', () => {
    const sections = searchCommands(commands, 'format')
    expect(labels(sections)).toEqual(['Format'])
    const mixed = searchCommands([cmd('Home page settings'), cmd('Home', 'goto')], 'home')
    expect(mixed.map((s) => s.group)).toEqual(['goto', 'actions'])
  })

  it('cuts each section at the query limit and says how many more there are', () => {
    const sections = searchCommands(commands, 'widget')
    const add = sections.find((s) => s.group === 'add')!
    expect(add.hits).toHaveLength(QUERY_LIMIT)
    expect(add.more).toBe(12 - QUERY_LIMIT)
    expect(searchCommands(many, '', [], { whole: true })[0].hits).toHaveLength(12)
  })

  it('lifts a recent command among equals', () => {
    const two = [cmd('Copy style', 'widget'), cmd('Copy', 'widget')]
    expect(labels(searchCommands(two, 'co'))[0]).toBe('Copy')
    // Both start with "co"; "Copy style" is longer, but run recently it goes first.
    expect(labels(searchCommands(two, 'co', ['widget:Copy style']))[0]).toBe('Copy style')
  })

  it('finds a command inside a submenu by its path', () => {
    const tree = [cmd('Move to page', 'widget', { run: undefined, children: [cmd('Work', 'widget'), cmd('Home', 'widget')] })]
    const sections = searchCommands(tree, 'move work')
    expect(sections[0].hits.map((h) => [h.trail.join(), h.command.label])).toEqual([['Move to page', 'Work']])
  })
})

describe('pushRecent', () => {
  it('moves a command to the front once and keeps the list short', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    expect(pushRecent(['a', 'b', 'c', 'd', 'e'], 'f')).toEqual(['f', 'a', 'b', 'c', 'd'])
  })
})
