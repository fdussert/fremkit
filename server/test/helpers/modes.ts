import { stat } from 'node:fs/promises'
import { expect } from 'vitest'

/**
 * Asserts a POSIX permission mode. Windows files carry no owner/group/other bits (`stat` reports
 * 0o666 or 0o444), so the check applies where the modes exist; the server's Windows data-folder
 * protection (an ACL) is tested where it is implemented.
 */
export async function expectMode(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return
  expect((await stat(path)).mode & 0o777).toBe(mode)
}
