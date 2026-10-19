import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { tr } from '../i18n.js'
import { execCommand, type Exec } from './exec.js'
import { HELPER_REVEAL_URL, openHelperUrl } from '../helper/routes.js'
import {
  createDuScanner, createNativeScanner, resolveScannerBinary, ScanError,
  type DiskScanner, type ScanFailure, type ScanHandle, type ScanProgress, type ScanStats,
} from './disk-map-scanner.js'
import { buildView, DEFAULT_POLICY, findNode, resize, validateTree, type DiskNode, type DiskPolicy, type ViewNode } from './disk-map-tree.js'
import { isTrusted, type CommandContext, type Provider } from './types.js'

/**
 * The `disk-map` channel: what fills a disk, for the DaisyDisk-style ring of `widgets/disk-map`.
 *
 * Scans run on demand only — a tap on the widget — and never on a clock: a walk of a home folder
 * reads a million entries. One at a time: a new scan of the root being scanned replaces the one
 * running, a scan of another root waits its turn. The result is held in memory pruned (see `disk-map-tree.ts`) and saved
 * under `<dataDir>/disk-map/`, so a restart shows the last scan with its date.
 *
 * The widget never names a path. It names a root from a closed list (the home folder, the local
 * volumes under /Volumes) and the folder names it drilled through; the server checks those names
 * against its own tree and resolves them under the root, `realpath` included, before anything runs.
 * Nothing is deleted or moved, on purpose: the commands are scan, cancel, view, reveal in Finder
 * and open the Full Disk Access settings.
 */

export interface DiskRoot {
  id: string
  label: string
  kind: 'home' | 'volume'
  path: string
}

export interface RootSummary {
  scannedAt: number
  size: number
  files: number
  unreadable: number
  scanner: DiskScanner['kind']
  /** Changes whenever what `view` answers for this root changes: a scan, a folder rescanned. */
  generation: number
}

export interface DiskMapSnapshot {
  scanner: DiskScanner['kind'] | null
  roots: { id: string; label: string; kind: DiskRoot['kind'] }[]
  scanning: {
    root: string; path: string[]; startedAt: number; directories: number; files: number; current: string[]
    /** The folder macOS is asking the user about (a privacy prompt), below `path`; null otherwise. */
    waiting: string[] | null
  } | null
  /** Roots waiting for the running scan to finish, in the order they will run. */
  queued: string[]
  results: Record<string, RootSummary>
  /** The last failure per root; `path` is the folder that was being rescanned, [] for the root. */
  errors: Record<string, { path: string[]; code: ScanFailure | 'gone' }>
}

/** `/sbin/mount` lines for the volumes worth offering: local, browsable, under /Volumes. */
export function parseMounts(output: string): { name: string; path: string }[] {
  const volumes: { name: string; path: string }[] = []
  for (const line of output.split('\n')) {
    const match = /^.+? on (\/Volumes\/.+) \(([^()]*)\)$/.exec(line)
    if (!match) continue
    const path = match[1]
    const name = path.slice('/Volumes/'.length)
    const options = match[2].split(',').map((o) => o.trim())
    // `local` is what the kernel says about a file system that is not on the network (nfs, smbfs,
    // afpfs, webdav never carry it); `nobrowse` is what Finder hides too.
    if (!options.includes('local') || options.includes('nobrowse')) continue
    if (!name || name.includes('/') || name.startsWith('.') || name.startsWith('com.apple.')) continue
    volumes.push({ name, path })
  }
  return volumes
}

const ROOT_ID = z.string().max(300).regex(/^(home|volume:[^/\0]+)$/)
const SEGMENT = z.string().min(1).max(255).refine(
  (s) => !s.includes('/') && !s.includes('\0') && s !== '.' && s !== '..', 'invalid name',
)
const SEGMENTS = z.array(SEGMENT).max(64)
/** The dashboard stamps every widget command with the instance that sent it. */
const INSTANCE = { instanceId: z.string().max(200).optional() }
const ViewPayload = z.object({
  ...INSTANCE,
  root: ROOT_ID,
  path: SEGMENTS.default([]),
  rings: z.number().int().min(1).max(4).default(3),
  minDegrees: z.number().min(0.5).max(20).default(3.5),
}).strict()
const TargetPayload = z.object({ ...INSTANCE, root: ROOT_ID, path: SEGMENTS.default([]) }).strict()
const EmptyPayload = z.object({ ...INSTANCE }).strict()
/** `root` absent cancels whatever runs; present, it cancels that root's scan, running or queued. */
const CancelPayload = z.object({ ...INSTANCE, root: ROOT_ID.optional() }).strict()

const SAVE_VERSION = 1
const SAVED = z.object({
  version: z.literal(SAVE_VERSION),
  root: ROOT_ID,
  path: z.string().max(4096),
  scannedAt: z.number().nonnegative(),
  scanner: z.enum(['native', 'du']),
  stats: z.object({ directories: z.number(), files: z.number(), unreadable: z.number(), ms: z.number() }),
  tree: z.unknown(),
})

/** Rescanned subfolders held per root, the most recent last. */
const MAX_SUBTREES = 8
const SUBTREE_BUDGET = 5000
const LIST_MAX = 60

interface Held {
  root: string
  path: string
  scannedAt: number
  scanner: DiskScanner['kind']
  stats: ScanStats
  tree: DiskNode
  generation: number
  /** Folders rescanned because the main tree did not hold their insides, keyed by path. */
  subtrees: Map<string, DiskNode>
}

interface Running {
  id: number
  root: string
  segments: string[]
  startedAt: number
  progress: ScanProgress
  handle: ScanHandle
}

export interface DiskMapOptions {
  dataDir: string
  home?: string
  /** The scanner to use; by default the helper's `fremkit-scan` when it is there, else `du`. */
  scanner?: () => Promise<DiskScanner>
  /** `/sbin/mount`'s output. */
  mounts?: () => Promise<string>
  /** Runs `/usr/bin/open` with these arguments. */
  open?: (args: string[]) => Promise<unknown>
  /** Asks the helper to lower the dashboard for a while (`fremkit://reveal`). */
  revealHelper?: () => Promise<void>
  now?: () => number
}

/** The file a root's last scan is saved in: the id is not a safe file name, its hex is. */
const saveName = (rootId: string): string =>
  rootId === 'home' ? 'home.json' : `volume-${Buffer.from(rootId.slice('volume:'.length)).toString('hex')}.json`

const key = (segments: readonly string[]): string => segments.join('\0')

/**
 * Resolves names under a root and checks the result is still inside it: a symlink or a rename
 * between the scan and now must not lead `open` or the scanner anywhere else.
 */
export async function resolveInside(rootPath: string, segments: readonly string[]): Promise<string> {
  const root = await realpath(rootPath)
  const target = await realpath(join(root, ...segments))
  if (target !== root && !target.startsWith(root.endsWith('/') ? root : `${root}/`)) throw new Error('outside')
  return target
}

export function createDiskMapProvider(opts: DiskMapOptions): Provider<DiskMapSnapshot> {
  const home = opts.home ?? homedir()
  const now = opts.now ?? Date.now
  const run: Exec = execCommand
  const mounts = opts.mounts ?? (() => run('/sbin/mount', []))
  const open = opts.open ?? ((args: string[]) => run('/usr/bin/open', args))
  const revealHelper = opts.revealHelper ?? (() => openHelperUrl(HELPER_REVEAL_URL))
  const saveDir = join(opts.dataDir, 'disk-map')

  let scannerPromise: Promise<DiskScanner> | null = null
  let scannerKind: DiskScanner['kind'] | null = null
  const scanner = (): Promise<DiskScanner> => {
    scannerPromise ??= (opts.scanner ?? (async () => {
      const binary = await resolveScannerBinary()
      return binary ? createNativeScanner(binary) : createDuScanner()
    }))().then((s) => { scannerKind = s.kind; return s })
    return scannerPromise
  }

  let rootsCache: { at: number; roots: DiskRoot[] } | null = null
  const listRoots = async (): Promise<DiskRoot[]> => {
    if (rootsCache && now() - rootsCache.at < 15_000) return rootsCache.roots
    const roots: DiskRoot[] = [{ id: 'home', label: '~', kind: 'home', path: home }]
    try {
      for (const v of parseMounts(await mounts())) roots.push({ id: `volume:${v.name}`, label: v.name, kind: 'volume', path: v.path })
    } catch {
      // No volume list this time: the home folder is still there.
    }
    rootsCache = { at: now(), roots }
    return roots
  }

  const held = new Map<string, Held>()
  let loading: Promise<void> | null = null
  const load = (): Promise<void> => {
    loading ??= (async () => {
      let names: string[] = []
      try { names = await readdir(saveDir) } catch { return }
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        try {
          const saved = SAVED.parse(JSON.parse(await readFile(join(saveDir, name), 'utf8')))
          if (saveName(saved.root) !== name) continue
          held.set(saved.root, {
            root: saved.root, path: saved.path, scannedAt: saved.scannedAt, scanner: saved.scanner, stats: saved.stats,
            tree: validateTree(saved.tree), generation: 1, subtrees: new Map(),
          })
        } catch {
          // A file that does not read back is ignored, not repaired: the next scan rewrites it.
        }
      }
    })()
    return loading
  }

  const save = async (h: Held): Promise<void> => {
    const body = JSON.stringify({ version: SAVE_VERSION, root: h.root, path: h.path, scannedAt: h.scannedAt, scanner: h.scanner, stats: h.stats, tree: h.tree })
    await mkdir(saveDir, { recursive: true })
    const file = join(saveDir, saveName(h.root))
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, body, { mode: 0o600 })
    await rename(tmp, file)
  }

  let running: Running | null = null
  let nextId = 1
  /**
   * Scans of other roots asked for while one runs, by root, oldest first. Two tiles on two roots
   * tapped together would otherwise cancel each other, and the first would be left on "never
   * scanned" with no error to say why. A root asked for again keeps its place with the new path.
   */
  const queue = new Map<string, string[]>()
  /** The last failure per root, until a scan of that root succeeds. */
  const errors = new Map<string, { path: string[]; code: ScanFailure | 'gone' }>()

  /**
   * The node at `segments`, looked up in the main tree and, where that tree stops (`more`), in a
   * subfolder rescanned since. Only names the server's own tree holds are ever found.
   */
  const lookup = (h: Held, segments: readonly string[]): DiskNode | null => {
    for (let cut = segments.length; cut > 0; cut--) {
      const sub = h.subtrees.get(key(segments.slice(0, cut)))
      if (sub) return findNode(sub, segments.slice(cut))
    }
    return findNode(h.tree, segments)
  }

  const startScan = async (rootId: string, wanted: string[]): Promise<{ ok: boolean; error?: string; queued?: boolean }> => {
    await load()
    const root = (await listRoots()).find((r) => r.id === rootId)
    if (!root) return { ok: false, error: 'unknown-root' }
    const h = held.get(rootId)
    // A folder is rescanned only inside a tree the server holds. One that is no longer there is
    // "gone" — never a reason to walk the whole root instead.
    const segments = wanted.length > 0 && h ? wanted : []
    if (wanted.length > 0 && (!h || !lookup(h, wanted))) return { ok: false, error: 'gone' }
    if (running && running.root !== rootId) {
      queue.set(rootId, segments)
      return { ok: true, queued: true }
    }
    queue.delete(rootId)
    let path: string
    try {
      path = await resolveInside(root.path, segments)
      if (!(await stat(path)).isDirectory()) throw new Error('not a directory')
    } catch {
      if (segments.length > 0) return { ok: false, error: 'gone' }
      errors.set(rootId, { path: [], code: 'missing' })
      return { ok: false, error: 'missing' }
    }
    const policy: DiskPolicy = segments.length === 0 ? DEFAULT_POLICY : {
      ...DEFAULT_POLICY,
      budget: SUBTREE_BUDGET,
      // Detail in proportion to the folder: 1/4000 of it, between 4 KB and the root's 1 MB.
      minBytes: Math.min(DEFAULT_POLICY.minBytes, Math.max(4096, Math.floor((lookup(h!, segments)?.size ?? 0) / 4000))),
    }
    const s = await scanner()
    // Checked again after the awaits: another root may have started meanwhile.
    if (running && running.root !== rootId) {
      queue.set(rootId, segments)
      return { ok: true, queued: true }
    }
    // No await between the cancel and `running = …`: two commands racing would otherwise both
    // cancel nothing, and the first scan would walk on with nobody reading it.
    running?.handle.cancel()
    const id = nextId++
    const handle = s.start(path, policy, (progress) => { if (running?.id === id) running.progress = progress })
    running = { id, root: rootId, segments, startedAt: now(), progress: { directories: 0, files: 0, path: [], waiting: null }, handle }
    handle.result.then(async (outcome) => {
      if (running?.id !== id) return
      running = null
      next()
      errors.delete(rootId)
      const current = held.get(rootId)
      if (segments.length === 0 || !current) {
        const next: Held = {
          root: rootId, path, scannedAt: now(), scanner: s.kind, stats: outcome.stats,
          tree: { ...outcome.tree, name: root.label }, generation: (current?.generation ?? 0) + 1, subtrees: new Map(),
        }
        held.set(rootId, next)
        await save(next).catch((err: unknown) => console.error('disk-map: could not save the scan:', (err as Error).message))
      } else {
        // The folder's parents in the main tree take its new size, so the rings above it add up.
        resize(current.tree, segments, outcome.tree)
        current.subtrees.delete(key(segments))
        current.subtrees.set(key(segments), { ...outcome.tree, name: segments[segments.length - 1] })
        while (current.subtrees.size > MAX_SUBTREES) current.subtrees.delete(current.subtrees.keys().next().value!)
        current.generation++
      }
    }, (err: unknown) => {
      if (running?.id !== id) return
      running = null
      const code: ScanFailure = err instanceof ScanError ? err.code : 'failed'
      if (code !== 'cancelled') errors.set(rootId, { path: segments, code })
      next()
    })
    return { ok: true }
  }

  /** Starts the oldest queued scan, and the one after it if that one cannot start. */
  const next = (): void => {
    if (running) return
    const first = queue.entries().next()
    if (first.done) return
    const [rootId, segments] = first.value
    queue.delete(rootId)
    startScan(rootId, segments).then((r) => {
      // `missing` is recorded by `startScan`; a folder gone meanwhile is recorded here, so the
      // tile that asked says so instead of waiting for nothing.
      if (!r.ok && r.error === 'gone') errors.set(rootId, { path: segments, code: 'gone' })
      if (!r.ok) next()
    }, () => next())
  }

  const snapshot = async (): Promise<DiskMapSnapshot> => {
    await load()
    const roots = await listRoots()
    const results: Record<string, RootSummary> = {}
    for (const r of roots) {
      const h = held.get(r.id)
      if (h) {
        results[r.id] = {
          scannedAt: h.scannedAt, size: h.tree.size, files: h.tree.files ?? 0, unreadable: h.tree.unreadable ?? 0,
          scanner: h.scanner, generation: h.generation,
        }
      }
    }
    if (scannerKind === null) await scanner()
    return {
      scanner: scannerKind,
      roots: roots.map(({ id, label, kind }) => ({ id, label, kind })),
      scanning: running && {
        root: running.root, path: running.segments, startedAt: running.startedAt,
        directories: running.progress.directories, files: running.progress.files, current: running.progress.path,
        waiting: running.progress.waiting,
      },
      queued: [...queue.keys()],
      results,
      errors: Object.fromEntries(roots.flatMap((r) => { const e = errors.get(r.id); return e ? [[r.id, e]] : [] })),
    }
  }

  const invalid = (error: z.ZodError) => ({ ok: false, error: error.issues[0]?.message ?? tr(undefined, 'provider.invalidPayload') })
  const localOnly = () => ({ ok: false, error: tr(undefined, 'provider.localOnly') })

  return {
    channel: 'disk-map',
    get intervalMs() { return running ? 1000 : 5000 },
    // No `stop()` that cancels: the last widget going away is also every dashboard reload, and a
    // scan half way through a home folder is worth finishing for the next look.
    poll: snapshot,
    commands: {
      /** The slice of the tree the widget draws, centred on one folder. */
      view: async (payload) => {
        const parsed = ViewPayload.safeParse(payload)
        if (!parsed.success) return invalid(parsed.error)
        await load()
        const { root, path, rings, minDegrees } = parsed.data
        const h = held.get(root)
        if (!h) return { ok: true, view: null }
        const node = lookup(h, path)
        if (!node) return { ok: false, error: 'gone' }
        const view: ViewNode = buildView(node, { rings, minDegrees, listMax: LIST_MAX })
        return { ok: true, view, path, scannedAt: h.scannedAt, generation: h.generation }
      },
      scan: async (payload, ctx?: CommandContext) => {
        if (!isTrusted(ctx)) return localOnly()
        const parsed = TargetPayload.safeParse(payload ?? {})
        if (!parsed.success) return invalid(parsed.error)
        return startScan(parsed.data.root, parsed.data.path)
      },
      cancel: async (payload, ctx?: CommandContext) => {
        if (!isTrusted(ctx)) return localOnly()
        const parsed = CancelPayload.safeParse(payload ?? {})
        if (!parsed.success) return invalid(parsed.error)
        const { root } = parsed.data
        if (root !== undefined) queue.delete(root)
        if (root === undefined || running?.root === root) running?.handle.cancel()
        return { ok: true }
      },
      /** Shows the folder in Finder — the path comes from the server's tree, never the payload. */
      reveal: async (payload, ctx?: CommandContext) => {
        if (!isTrusted(ctx)) return localOnly()
        const parsed = TargetPayload.safeParse(payload)
        if (!parsed.success) return invalid(parsed.error)
        await load()
        const { root: rootId, path } = parsed.data
        const h = held.get(rootId)
        const root = (await listRoots()).find((r) => r.id === rootId)
        const node = h && lookup(h, path)
        if (!root || !node) return { ok: false, error: 'gone' }
        let target: string
        try {
          target = await resolveInside(root.path, path)
        } catch {
          return { ok: false, error: 'gone' }
        }
        try {
          await open(['-R', target])
          return { ok: true }
        } catch {
          return { ok: false, error: 'failed' }
        }
      },
      /**
       * Lowers the dashboard behind the other windows for a while, so the privacy prompt a scan
       * waits on can be seen and answered: on the Edge it opens under the kiosk. The widget cannot
       * call `/api/helper/reveal` from its sandboxed frame, so it asks here. Without the helper
       * (`pnpm dev`) `open` fails or finds nobody, and the answer says so; nothing else happens.
       */
      revealPrompt: async (payload, ctx?: CommandContext) => {
        if (!isTrusted(ctx)) return localOnly()
        const parsed = EmptyPayload.safeParse(payload ?? {})
        if (!parsed.success) return invalid(parsed.error)
        try {
          await revealHelper()
          return { ok: true }
        } catch {
          return { ok: false, error: 'failed' }
        }
      },
      /** System Settings at Privacy & Security → Full Disk Access. */
      openPrivacy: async (payload, ctx?: CommandContext) => {
        if (!isTrusted(ctx)) return localOnly()
        const parsed = EmptyPayload.safeParse(payload ?? {})
        if (!parsed.success) return invalid(parsed.error)
        try {
          await open(['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'])
          return { ok: true }
        } catch {
          return { ok: false, error: 'failed' }
        }
      },
    },
  }
}
