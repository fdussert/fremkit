/**
 * The command palette's list, as data: what a command is, how a query finds and ranks commands,
 * how the results are grouped, and the short memory of what was run last.
 *
 * Pure functions, no DOM and no store: the commands themselves are built by `paletteCommands.ts`
 * and drawn by `CommandPalette.vue`. The matching is the widget library's (`matchesQuery`, `fold`),
 * so a query finds a widget here exactly as it does in the library and the registry.
 */
import { fold, matchesQuery } from './library'

/** The palette's sections, in the order they show with an empty query. */
export const PALETTE_GROUPS = ['recent', 'fix', 'widget', 'actions', 'goto', 'select', 'add', 'connections', 'settings'] as const
export type PaletteGroup = (typeof PALETTE_GROUPS)[number]

export interface Command {
  /** Stable while the thing it acts on exists: the recent list remembers commands by it. */
  id: string
  group: PaletteGroup
  label: string
  /** Muted text after the label: where, or on what, the command acts. Searched too. */
  context?: string
  /** Searched, never shown: a description, an id, a synonym. */
  keywords?: string[]
  /** A shortcut hint, in the macOS spelling. */
  shortcut?: string
  /** A toggle or a choice: true draws a check mark. */
  checked?: boolean
  disabled?: boolean
  danger?: boolean
  run?: () => void
  /**
   * A submenu: → or Enter on a command with no `run` opens it in the palette. A command with both
   * runs on Enter and opens on →.
   */
  children?: Command[]
}

/** A command found by a query, with the submenus it was found in. */
export interface Hit {
  command: Command
  /** Labels of the submenus above it, outermost first; empty for a top-level command. */
  trail: string[]
}

export interface PaletteSection {
  group: PaletteGroup
  hits: Hit[]
  /** How many more matched than the section shows. */
  more: number
}

/** Rows a section shows: with a query, and before anything is typed. */
export const QUERY_LIMIT = 8
export const BROWSE_LIMIT = 6
/** Commands the palette remembers. */
export const RECENT_MAX = 5
/** Sections shown whole before anything is typed: they are short and they are why one opens it. */
const UNCAPPED: ReadonlySet<PaletteGroup> = new Set(['recent', 'fix', 'widget', 'actions'])
/** Sections only a query shows: listing every setting of every widget would bury the rest. */
const SEARCH_ONLY: ReadonlySet<PaletteGroup> = new Set(['settings'])

/**
 * Every command reachable from `commands`, its submenus included — those a search looks into.
 * Two kinds are not: a destructive submenu — the "Delete…" whose single item is the confirmation
 * — so that confirmation stays one deliberate step away rather than one Enter after typing
 * "delete"; and the extras of a command that runs by itself (a widget to add, whose card menu
 * hangs off it), which would otherwise answer every query once per widget.
 */
export function flatten(commands: Command[], trail: string[] = []): Hit[] {
  const out: Hit[] = []
  for (const command of commands) {
    out.push({ command, trail })
    if (command.children?.length && !command.danger && !command.run) out.push(...flatten(command.children, [...trail, command.label]))
  }
  return out
}

/**
 * How well a command answers a query, or null when it does not. Every word typed must appear in
 * its label, context, trail or keywords (`matchesQuery`); the score then prefers the label to
 * the rest, a label that starts with the query to one that merely holds it, words found at the
 * start of words, top-level commands to those in a submenu, and short labels to long ones.
 */
export function scoreHit(hit: Hit, query: string): number | null {
  const { command, trail } = hit
  if (!matchesQuery([command.label, command.context ?? '', ...trail, ...(command.keywords ?? [])], query)) return null
  const q = fold(query).trim().replace(/\s+/g, ' ')
  const label = fold(command.label)
  const words = q.split(' ').filter(Boolean)
  const starts = (word: string): boolean => label.startsWith(word) || label.includes(' ' + word) || label.includes('-' + word)
  let score: number
  if (!q) score = 0
  else if (label === q) score = 1000
  else if (label.startsWith(q)) score = 800
  else if (words.every(starts)) score = 600
  else if (words.every((w) => label.includes(w))) score = 400
  else score = 200
  score -= trail.length * 50
  score -= Math.min(label.length, 60)
  if (command.disabled) score -= 300
  return score
}

/**
 * The palette's sections for a query.
 *
 * Empty query: the recent commands first, then every section in its order; the long ones are cut
 * at `BROWSE_LIMIT` and the settings are left out. With a query: every command that matches,
 * submenus included, each section sorted by score and cut at `QUERY_LIMIT`, the sections in the
 * order of their best hit. A recent command scores higher. `whole` cuts nothing: a submenu opened
 * in the palette is short, and is shown entire.
 */
export function searchCommands(
  commands: Command[], query: string, recent: readonly string[] = [], opts: { whole?: boolean } = {},
): PaletteSection[] {
  const typed = fold(query).trim() !== ''
  const sections = new Map<PaletteGroup, { hits: { hit: Hit; score: number }[] }>()
  const add = (group: PaletteGroup, hit: Hit, score: number): void => {
    const section = sections.get(group) ?? { hits: [] }
    section.hits.push({ hit, score })
    sections.set(group, section)
  }
  const recentRank = (id: string): number => {
    const i = recent.indexOf(id)
    return i < 0 ? 0 : (RECENT_MAX - i) * 20
  }

  if (!typed) {
    const all = flatten(commands)
    recent.forEach((id, i) => {
      const hit = all.find((h) => h.command.id === id && !h.command.disabled)
      if (hit) add('recent', hit, -i)
    })
    for (const command of commands) if (!SEARCH_ONLY.has(command.group)) add(command.group, { command, trail: [] }, 0)
  } else {
    for (const hit of flatten(commands)) {
      const score = scoreHit(hit, query)
      if (score !== null) add(hit.command.group, hit, score + recentRank(hit.command.id))
    }
  }

  const out: (PaletteSection & { best: number })[] = []
  for (const group of PALETTE_GROUPS) {
    const section = sections.get(group)
    if (!section) continue
    // A stable sort: equal scores keep the order the commands were built in.
    const ranked = typed ? [...section.hits].sort((a, b) => b.score - a.score) : section.hits
    const limit = opts.whole ? Infinity : typed ? QUERY_LIMIT : UNCAPPED.has(group) ? Infinity : BROWSE_LIMIT
    out.push({
      group,
      hits: ranked.slice(0, limit).map((r) => r.hit),
      more: Math.max(0, ranked.length - limit),
      best: ranked[0]?.score ?? 0,
    })
  }
  if (typed) out.sort((a, b) => b.best - a.best)
  return out.map(({ group, hits, more }) => ({ group, hits, more }))
}

/** `id` at the front of the recent list, once, the list cut at `max`. */
export function pushRecent(list: readonly string[], id: string, max: number = RECENT_MAX): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, max)
}
