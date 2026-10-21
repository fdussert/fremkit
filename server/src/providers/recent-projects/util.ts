import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'

/** Rejects with `timeout` once `ms` have passed; the work itself is left to finish or fail. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The modification time of a file, or null when it is not there. */
export async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

export async function isExecutableFile(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false
  try {
    const [info] = await Promise.all([stat(path), access(path, constants.X_OK)])
    return info.isFile()
  } catch {
    return false
  }
}
