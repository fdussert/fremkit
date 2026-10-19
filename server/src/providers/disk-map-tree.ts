/**
 * The disk map's tree: what a scan returns, what the server holds, and the slices it hands to the
 * widget. Pure functions, no I/O.
 *
 * A node is what `fremkit-scan` prints (see `native/Sources/FremkitCore/DiskTree.swift`): sizes
 * are allocated bytes, like `du`; `others` is what was not held one by one; `more` says something
 * worth drawing is below and was not held, so looking inside means scanning that folder again.
 */

export type DiskKind = 'd' | 'f' | 'x'

export interface DiskNode {
  name: string
  kind: DiskKind
  size: number
  files?: number
  /** Unreadable directories below, this one included. */
  unreadable?: number
  /** `[count, bytes]` of the entries not held one by one. */
  others?: [number, number]
  more?: boolean
  children?: DiskNode[]
}

export interface DiskPolicy {
  depth: number
  minBytes: number
  maxChildren: number
  budget: number
}

export const DEFAULT_POLICY: DiskPolicy = { depth: 6, minBytes: 1 << 20, maxChildren: 128, budget: 20_000 }

/** A child worth more than 1/120 of its parent (3° of the ring) is never folded away quietly. */
export const VISIBLE_SHARE = 120

const MAX_DEPTH = 64
const MAX_NODES = 250_000
const MAX_NAME = 1024

/**
 * Checks a tree that came from outside the process — the scanner's output, a file on disk — and
 * returns it typed. Strict: an unknown kind, a negative size, a name with a slash, a tree deeper
 * than 64 levels or larger than 250 000 nodes is refused whole.
 */
export function validateTree(value: unknown): DiskNode {
  let count = 0
  const nonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  const walk = (v: unknown, depth: number, isRoot: boolean): DiskNode => {
    if (depth > MAX_DEPTH) throw new Error('tree too deep')
    if (++count > MAX_NODES) throw new Error('tree too large')
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('node is not an object')
    const o = v as Record<string, unknown>
    const name = o.name
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME || name.includes('\0')) throw new Error('bad name')
    // The root's name is the last component of whatever was scanned; below it a name is one segment.
    if (!isRoot && (name.includes('/') || name === '.' || name === '..')) throw new Error('bad name')
    if (o.kind !== 'd' && o.kind !== 'f' && o.kind !== 'x') throw new Error('bad kind')
    if (!nonNegative(o.size)) throw new Error('bad size')
    const node: DiskNode = { name, kind: o.kind, size: o.size }
    if (o.files !== undefined) { if (!nonNegative(o.files)) throw new Error('bad files'); node.files = o.files }
    if (o.unreadable !== undefined) { if (!nonNegative(o.unreadable)) throw new Error('bad unreadable'); node.unreadable = o.unreadable }
    if (o.others !== undefined) {
      const others = o.others
      if (!Array.isArray(others) || others.length !== 2 || !nonNegative(others[0]) || !nonNegative(others[1])) throw new Error('bad others')
      node.others = [others[0], others[1]]
    }
    if (o.more !== undefined) { if (typeof o.more !== 'boolean') throw new Error('bad more'); if (o.more) node.more = true }
    if (o.children !== undefined) {
      if (!Array.isArray(o.children)) throw new Error('bad children')
      if (o.children.length > 0) node.children = o.children.map((c) => walk(c, depth + 1, false))
    }
    return node
  }
  return walk(value, 0, true)
}

/** The node at `segments` below `tree`, or null. */
export function findNode(tree: DiskNode, segments: readonly string[]): DiskNode | null {
  let node: DiskNode | undefined = tree
  for (const segment of segments) {
    node = node.children?.find((c) => c.name === segment)
    if (!node) return null
  }
  return node
}

/**
 * A folder was measured again: it and every ancestor take the difference in size, files and
 * unreadable folders, so the rings above it still add up. The held tree keeps its own shape — the
 * new measurement is held beside it — so this never grows the tree. False when the path is not in
 * the tree.
 */
export function resize(tree: DiskNode, segments: readonly string[], measured: DiskNode): boolean {
  if (segments.length === 0) return false
  const chain: DiskNode[] = [tree]
  for (const segment of segments) {
    const next = chain[chain.length - 1].children?.find((c) => c.name === segment)
    if (!next) return false
    chain.push(next)
  }
  const target = chain[chain.length - 1]
  const dSize = measured.size - target.size
  const dFiles = (measured.files ?? 0) - (target.files ?? 0)
  const dUnreadable = (measured.unreadable ?? 0) - (target.unreadable ?? 0)
  for (const node of chain) {
    node.size = Math.max(0, node.size + dSize)
    if (dFiles) node.files = Math.max(0, (node.files ?? 0) + dFiles)
    if (dUnreadable) {
      const u = Math.max(0, (node.unreadable ?? 0) + dUnreadable)
      if (u) node.unreadable = u
      else delete node.unreadable
    }
  }
  return true
}

const largerFirst = (a: DiskNode, b: DiskNode): number =>
  a.size !== b.size ? b.size - a.size : a.name < b.name ? -1 : a.name > b.name ? 1 : 0

function addOthers(node: DiskNode, count: number, size: number): void {
  const [c, s] = node.others ?? [0, 0]
  node.others = [c + count, s + size]
}

/**
 * The per-folder cut `fremkit-scan` makes as it goes, for a tree built elsewhere (the `du`
 * fallback): below `depth` nothing is held, an entry under `minBytes` or past the `maxChildren`
 * largest goes into "others", unreadable folders are always kept.
 */
export function pruneTree(node: DiskNode, policy: DiskPolicy, depth = 0): void {
  const children = node.children ?? []
  if (children.length === 0) return
  if (depth >= policy.depth) {
    addOthers(node, children.length, children.reduce((sum, c) => sum + c.size, 0))
    node.more = true
    delete node.children
    return
  }
  const readable = children.filter((c) => c.kind !== 'x').sort(largerFirst)
  const unreadable = children.filter((c) => c.kind === 'x').sort((a, b) => (a.name < b.name ? -1 : 1))
  const kept: DiskNode[] = []
  for (const child of readable) {
    const keep = kept.length < policy.maxChildren && (child.size >= policy.minBytes || (child.unreadable ?? 0) > 0)
    if (keep) { kept.push(child); continue }
    // Never `more` here: a rescan would make the same cut and show the same "others".
    addOthers(node, 1, child.size)
  }
  const keptUnreadable = unreadable.slice(0, policy.maxChildren)
  if (unreadable.length > keptUnreadable.length) addOthers(node, unreadable.length - keptUnreadable.length, 0)
  node.children = [...kept, ...keptUnreadable]
  if (node.children.length === 0) delete node.children
  for (const child of kept) pruneTree(child, policy, depth + 1)
}

/** At most `budget` nodes below the root, the largest first: the same cut as `DiskTreePruner`. */
export function applyBudget(root: DiskNode, budget: number): void {
  const all: { node: DiskNode; depth: number }[] = []
  const collect = (node: DiskNode, depth: number): void => {
    for (const child of node.children ?? []) {
      if (child.kind !== 'x') all.push({ node: child, depth })
      collect(child, depth + 1)
    }
  }
  collect(root, 1)
  if (all.length <= budget) return
  all.sort((a, b) => (a.node.size !== b.node.size ? b.node.size - a.node.size : a.depth - b.depth))
  const kept = new Set(all.slice(0, budget).map((e) => e.node))
  const prune = (node: DiskNode): void => {
    if (!node.children) return
    const children: DiskNode[] = []
    for (const child of node.children) {
      if (child.kind === 'x' || kept.has(child)) {
        children.push(child)
        prune(child)
      } else {
        addOthers(node, 1, child.size)
        if (child.size * VISIBLE_SHARE >= node.size) node.more = true
      }
    }
    if (children.length) node.children = children
    else delete node.children
  }
  prune(root)
}

export function countNodes(node: DiskNode): number {
  return 1 + (node.children ?? []).reduce((sum, c) => sum + countNodes(c), 0)
}

/** One node as the widget receives it: `o` is the grey "Others" segment. */
export interface ViewNode {
  name: string
  kind: DiskKind | 'o'
  size: number
  /** For `o`: how many entries it stands for. */
  count?: number
  unreadable?: number
  more?: boolean
  children?: ViewNode[]
}

export interface ViewOptions {
  /** Rings drawn around the centre. */
  rings: number
  /** Narrowest segment drawn, in degrees of the whole circle. */
  minDegrees: number
  /** Most rows of the list (the first ring's entries). */
  listMax: number
}

/**
 * What the widget draws for the folder at the centre: its children down to `rings` levels.
 *
 * Only entries big enough to see are sent. The first ring also feeds the list beside the ring, so
 * it keeps up to `listMax` entries of at least 0.1 % — the widget folds the narrow ones into the
 * ring's "Others" itself. Deeper rings keep what spans `minDegrees` of the circle. Everything else
 * becomes one "Others (n)". Unreadable folders are always sent: they are the ones to explain.
 */
export function buildView(node: DiskNode, opts: ViewOptions): ViewNode {
  const total = Math.max(1, node.size)
  const level = (n: DiskNode, depth: number): ViewNode => {
    const view: ViewNode = { name: n.name, kind: n.kind, size: n.size }
    if (n.unreadable) view.unreadable = n.unreadable
    if (n.more) view.more = true
    // A folder cut by the depth has everything in "others": drawn as nothing rather than as one
    // grey ring, since looking inside rescans it anyway.
    if (depth >= opts.rings || (!n.children?.length && (!n.others || n.more))) return view
    const share = depth === 0 ? 1 / 1000 : opts.minDegrees / 360
    const limit = depth === 0 ? opts.listMax : 64
    const children: ViewNode[] = []
    let othersCount = n.others?.[0] ?? 0
    let othersSize = n.others?.[1] ?? 0
    let unreadableShown = 0
    for (const child of n.children ?? []) {
      if (child.kind === 'x') {
        if (unreadableShown++ < 16) { children.push(level(child, depth + 1)); continue }
      } else if (child.size / total >= share && children.length < limit) {
        children.push(level(child, depth + 1))
        continue
      }
      othersCount += 1
      othersSize += child.size
    }
    children.sort((a, b) => (a.kind === 'x' ? 1 : 0) - (b.kind === 'x' ? 1 : 0) || b.size - a.size)
    if (othersCount > 0 && othersSize > 0) children.push({ name: '', kind: 'o', size: othersSize, count: othersCount })
    if (children.length) view.children = children
    return view
  }
  return level(node, 0)
}
