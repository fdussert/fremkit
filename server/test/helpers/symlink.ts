import { symlink } from 'node:fs/promises'
import type { TestContext } from 'vitest'

/**
 * Creates a symlink, or skips the test where the platform refuses: Windows needs Developer Mode
 * or an elevated process (EPERM), which a CI runner has and a developer's account may not.
 */
export async function symlinkOrSkip(ctx: TestContext, target: string, path: string, type?: 'dir' | 'file'): Promise<void> {
  try {
    await symlink(target, path, type)
  } catch (err) {
    if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM') ctx.skip('symlinks need Developer Mode or elevation on Windows')
    throw err
  }
}
