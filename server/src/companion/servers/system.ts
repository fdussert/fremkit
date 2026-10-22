/**
 * The programs Fremdev's server list runs, and the files it reads: every one by absolute path
 * through `execFile`, with an argument list, a timeout and no shell. Injected into the provider so
 * its tests run on fixture output.
 */

import { execFile } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { localEnv, resolveDockerBinary } from '../../providers/local-operations.js'

export const LSOF = '/usr/sbin/lsof'
export const PS = '/bin/ps'

/** The most a `package.json` may weigh for its `name` to be read. */
export const PACKAGE_JSON_MAX_BYTES = 64 * 1024

const TIMEOUT_MS = 5_000
const MAX_BUFFER = 4 * 1024 * 1024

export type ExecFn = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<string>

export interface ServersSystem {
  /** The user's uid: other accounts' listeners are never listed. */
  uid: number
  /** The home folder, published as `~`. */
  home: string
  /** `lsof -nP -iTCP -sTCP:LISTEN -F pcuLn`. */
  runLsofListen(): Promise<string>
  /**
   * `ps -ax -o pid=,ppid=,pgid=,uid=,lstart=,etime=,%cpu=,rss=,comm=`: every process, so the
   * listeners' parents (the launch root) and Fremkit's own descendants (`selfTree`) are known from
   * one call. `comm` last, or macOS cuts it to 16 characters.
   */
  runPsStats(): Promise<string>
  /** `ps -o pid=,args= -p <pids>`: the command lines of the listeners and their parents only. */
  runPsArgs(pids: number[]): Promise<string>
  /** `lsof -a -p <pids> -d cwd -Fn`. */
  runLsofCwd(pids: number[]): Promise<string>
  /** `docker ps --format '{{.Names}}\t{{.Ports}}'`, through the binary `resolveDockerBinary` finds. */
  runDockerPorts(): Promise<string>
  /** `name` from `<folder>/package.json` (at most `PACKAGE_JSON_MAX_BYTES`, cached by mtime), else null. */
  readPackageName(folder: string): Promise<string | null>
}

/**
 * `execFile` resolving stdout. lsof and ps exit 1 when one of the pids asked for is gone, or when
 * nothing listens, and still print what they found: that output is kept.
 */
export const execText: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, shell: false, encoding: 'utf8' }, (error, stdout) => {
      if (!error) return resolve(stdout)
      if (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' && (error as { code: number }).code === 1) return resolve(stdout ?? '')
      reject(new Error('unavailable'))
    })
  })

/** A package name as npm allows it, or null. */
function packageName(raw: string): string | null {
  try {
    const name = (JSON.parse(raw) as { name?: unknown }).name
    return typeof name === 'string' && name.length > 0 && name.length <= 214 && !/[\s\u0000-\u001f]/.test(name) ? name : null
  } catch {
    return null
  }
}

export function createServersSystem(exec: ExecFn = execText, env: NodeJS.ProcessEnv = process.env): ServersSystem {
  const base = localEnv(env)
  // `lstart` follows the locale: under C it is the five words `parsePs` expects.
  const psEnv: NodeJS.ProcessEnv = { ...base, LC_ALL: 'C' }
  const opts = (e: NodeJS.ProcessEnv) => ({ env: e, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER })
  const cache = new Map<string, { mtimeMs: number; name: string | null }>()
  const pidList = (pids: number[]) => pids.filter((p) => Number.isInteger(p) && p > 0).join(',')

  return {
    uid: process.getuid?.() ?? -1,
    home: homedir(),
    runLsofListen: () => exec(LSOF, ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcuLn'], opts(base)),
    runPsStats: () => exec(PS, ['-ax', '-o', 'pid=,ppid=,pgid=,uid=,lstart=,etime=,%cpu=,rss=,comm='], opts(psEnv)),
    runPsArgs: async (pids) => {
      const list = pidList(pids)
      return list ? exec(PS, ['-o', 'pid=,args=', '-p', list], opts(psEnv)) : ''
    },
    runLsofCwd: async (pids) => {
      const list = pidList(pids)
      return list ? exec(LSOF, ['-a', '-p', list, '-d', 'cwd', '-Fn'], opts(base)) : ''
    },
    runDockerPorts: async () => exec(await resolveDockerBinary(), ['ps', '--format', '{{.Names}}\t{{.Ports}}'], opts(base)),
    async readPackageName(folder) {
      const path = join(folder, 'package.json')
      try {
        const info = await stat(path)
        if (!info.isFile() || info.size > PACKAGE_JSON_MAX_BYTES) return null
        const hit = cache.get(path)
        if (hit && hit.mtimeMs === info.mtimeMs) return hit.name
        const file = await open(path, 'r')
        try {
          const buf = Buffer.alloc(PACKAGE_JSON_MAX_BYTES)
          const { bytesRead } = await file.read(buf, 0, PACKAGE_JSON_MAX_BYTES, 0)
          const name = packageName(buf.subarray(0, bytesRead).toString('utf8'))
          if (cache.size > 256) cache.clear()
          cache.set(path, { mtimeMs: info.mtimeMs, name })
          return name
        } finally {
          await file.close()
        }
      } catch {
        return null
      }
    },
  }
}
