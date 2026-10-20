import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Source, SourceEntry } from '../types.js'
import { exists } from '../util.js'

const FILES = ['recentProjects.xml', 'recentSolutions.xml']

function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/**
 * The projects of one `recentProjects.xml` (IntelliJ, WebStorm, PyCharm…) or
 * `recentSolutions.xml` (Rider), with the time each was last activated. Rider names a solution
 * file: its folder is the project. `$USER_HOME$` is the IDEs' own spelling of the home folder.
 */
export function parseRecentProjects(xml: string, home: string): SourceEntry[] {
  const out: SourceEntry[] = []
  const entry = /<entry key="([^"]+)">([\s\S]*?)<\/entry>/g
  let m: RegExpExecArray | null
  while ((m = entry.exec(xml))) {
    let path = unescapeXml(m[1]).replace('$USER_HOME$', home)
    if (/\.(sln|slnx|csproj|ipr)$/i.test(path)) path = dirname(path)
    const ts = /name="activationTimestamp" value="(\d+)"/.exec(m[2]) ?? /name="projectOpenTimestamp" value="(\d+)"/.exec(m[2])
    out.push({ path, seenAt: ts ? Number(ts[1]) : null })
  }
  return out
}

export function createJetbrainsSource(): Source {
  const base = (home: string) => join(home, 'Library', 'Application Support', 'JetBrains')
  return {
    id: 'jetbrains',
    label: { fr: 'JetBrains', en: 'JetBrains' },
    available: async (ctx) => exists(base(ctx.home)),
    async list(ctx) {
      // One folder per product and version (IntelliJIdea2026.2, Rider2026.1…). Only those touched
      // in the last year are read: a machine keeps every version it ever ran.
      const root = base(ctx.home)
      const yearAgo = Date.now() - 365 * 86_400_000
      const out: SourceEntry[] = []
      for (const product of await readdir(root)) {
        for (const file of FILES) {
          const path = join(root, product, 'options', file)
          try {
            if ((await stat(path)).mtimeMs < yearAgo) continue
            out.push(...parseRecentProjects(await readFile(path, 'utf8'), ctx.home))
          } catch { /* no such file for this product */ }
        }
      }
      return out
    },
  }
}
