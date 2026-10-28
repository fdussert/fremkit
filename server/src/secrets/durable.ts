import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The open file the durable writes use: write, flush to disk, close. */
export interface DurableHandle {
  writeFile(data: string, encoding: 'utf8'): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

/** The file-system calls a durable write makes; the tests give a recording one. */
export interface DurableIo {
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>
  open(path: string, flags: string, mode?: number): Promise<DurableHandle>
  chmod(path: string, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

export const nodeIo: DurableIo = { mkdir, open, chmod, rename, unlink }

/**
 * Writes `text` to `path` so that it is on disk, not only in the cache, once this resolves:
 * a temporary written and flushed, renamed into place, then the folder flushed so the rename
 * is too. What a file whose loss would cost a secret needs before the plaintext copy goes.
 */
export async function writeFileDurably(io: DurableIo, path: string, text: string, mode: number): Promise<void> {
  await io.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  const handle = await io.open(tmp, 'w', mode)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  // The mode at creation and again after: `open` applies it only to a file it creates.
  await io.chmod(tmp, mode)
  await io.rename(tmp, path)
  await syncDir(io, dirname(path))
}

/** Flushes an existing file to disk. `r+`: Windows flushes only a handle open for writing. */
export async function syncFile(io: DurableIo, path: string): Promise<void> {
  const handle = await io.open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Flushes a folder's entries (a rename, a new file). Windows cannot open or flush a folder this
 * way and answers EPERM or EISDIR; there NTFS's journal already holds the rename, so that one
 * answer is not a failure.
 */
export async function syncDir(io: DurableIo, dir: string): Promise<void> {
  let handle: DurableHandle
  try {
    handle = await io.open(dir, 'r')
  } catch (err) {
    if (isNoDirSync(err)) return
    throw err
  }
  try {
    await handle.sync()
  } catch (err) {
    if (!isNoDirSync(err)) throw err
  } finally {
    await handle.close()
  }
}

function isNoDirSync(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EISDIR'
}
