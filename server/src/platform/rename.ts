/**
 * A rename that rides out a file briefly held open on Windows.
 *
 * Replacing a file by renaming over it fails there with `EPERM`, `EBUSY` or `EACCES` while
 * another handle has it open: a concurrent read of the same file, an antivirus scan, the search
 * indexer. Those holds last milliseconds, so the rename is tried again a few times over about a
 * second, as graceful-fs does (with a shorter bound). Anywhere else, and for any other error, the
 * first failure is the answer.
 */
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
/** Waits between attempts, in ms: seven attempts over about 0.9 s. */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 30, 60, 100, 200, 500]

export async function renameRetrying(
  rename: (from: string, to: string) => Promise<void>,
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const delays = platform === 'win32' ? RENAME_RETRY_DELAYS_MS : []
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (attempt >= delays.length || code === undefined || !RETRY_CODES.has(code)) throw error
      await sleep(delays[attempt]!)
    }
  }
}
