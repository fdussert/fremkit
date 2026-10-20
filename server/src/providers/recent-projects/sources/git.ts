import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Source, SourceEntry } from '../types.js'
import { canonicalRoot, expandHome } from '../paths.js'
import { mtimeOf } from '../util.js'

/** How far below a root a repository is looked for: `~/Dev/client/app` is depth 2. */
export const GIT_MAX_DEPTH = 3
/** Folders read per root before the walk gives up: a root set to the home folder stays cheap. */
const MAX_DIRS_PER_ROOT = 4000
/** Never walked into: dependencies, build output, caches, and the Mac's own folders. */
const SKIP = new Set([
  'node_modules', 'bower_components', 'vendor', 'Pods', 'DerivedData', 'build', 'dist', 'out',
  'target', 'bin', 'obj', 'venv', '__pycache__', 'Library', 'Applications', 'Movies', 'Music',
  'Pictures', 'Photos Library.photoslibrary',
])

/**
 * When a repository was last touched, without running git: the newest of `HEAD` (a checkout, a
 * commit on a branch switch) and `index` (any staging, any commit). A worktree's `.git` is a
 * file naming its real git folder, which is followed.
 */
export async function repoTouchedAt(repo: string): Promise<number | null> {
  const dotGit = join(repo, '.git')
  let gitDir = dotGit
  try {
    const info = await stat(dotGit)
    if (info.isFile()) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec((await readFile(dotGit, 'utf8')).slice(0, 4096))
      if (!m) return info.mtimeMs
      gitDir = isAbsolute(m[1]) ? m[1] : resolve(dirname(dotGit), m[1])
    }
  } catch {
    return null
  }
  const times = (await Promise.all([mtimeOf(join(gitDir, 'HEAD')), mtimeOf(join(gitDir, 'index'))]))
    .filter((t): t is number => t !== null)
  return times.length ? Math.max(...times) : null
}

/** The repositories under one root, breadth first, at most `GIT_MAX_DEPTH` folders down. */
export async function scanRoot(root: string): Promise<SourceEntry[]> {
  const out: SourceEntry[] = []
  let queue: string[] = [root]
  let read = 0
  for (let depth = 0; depth <= GIT_MAX_DEPTH && queue.length; depth++) {
    const next: string[] = []
    for (const dir of queue) {
      if (read++ >= MAX_DIRS_PER_ROOT) return out
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      if (entries.some((e) => e.name === '.git')) {
        const at = await repoTouchedAt(dir)
        if (at !== null) out.push({ path: dir, seenAt: at })
        // A repository's own folders are its business: nested checkouts are rare and costly.
        continue
      }
      if (depth === GIT_MAX_DEPTH) continue
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue
        next.push(join(dir, e.name))
      }
    }
    queue = next
  }
  return out
}

/** The roots as the walk takes them: `~` expanded, canonical, and allowed. */
export async function resolveRoots(typed: string[], home: string): Promise<{ typed: string; real: string }[]> {
  const out: { typed: string; real: string }[] = []
  for (const t of typed) {
    const real = await canonicalRoot(expandHome(t.trim(), home), home)
    if (real) out.push({ typed: t.trim(), real })
  }
  return out
}

export const gitSource: Source = {
  id: 'git',
  label: { fr: 'Dépôts git', en: 'Git repositories' },
  available: async () => true,
  async list(ctx) {
    const roots = await resolveRoots(ctx.gitRoots, ctx.home)
    const lists = await Promise.all(roots.map(async (r) => (await scanRoot(r.real)).map((e) => ({ ...e, gitRoot: r.typed }))))
    return lists.flat()
  },
}
