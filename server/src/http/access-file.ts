/**
 * Where the access secret is written, and how it gets there.
 *
 * One file per port, in the helper's support folder: `~/Library/Application Support/Fremkit/
 * access-<port>.token`, or under `FREMKIT_SUPPORT_DIR` when that moves the helper's files (a
 * second helper under test). Keyed by port rather than kept in the data folder, because every
 * reader knows the port and nothing else: the Claude Code hook runs from any directory, the
 * helper may find a `pnpm dev` server from another checkout on its port, and the app keeps its
 * data somewhere a checkout does not. Whoever listens on the port owns the file.
 *
 * Written once the server listens and removed when it exits, so the file names a live server or
 * none: a reader that finds it while something else holds the port (another account's program
 * that bound it while ours was down) holds a secret nobody will take any more.
 *
 * Mode `0600`, replaced atomically: written to a temporary file in the same folder and renamed
 * over the old one, so a reader sees the previous secret or the new one, never half of either.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { generateToken, isWellFormedToken } from './access.js'

/** The environment variable the helper passes its secret in. Removed once read. */
export const ACCESS_TOKEN_ENV = 'FREMKIT_ACCESS_TOKEN'

/** The helper's support folder: `FREMKIT_SUPPORT_DIR` when absolute, as `HelperPaths` reads it. */
export function supportDirectory(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.FREMKIT_SUPPORT_DIR
  if (override && isAbsolute(override)) return override
  return join(home, 'Library', 'Application Support', 'Fremkit')
}

/** The token file for a port. */
export function accessTokenPath(port: number, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(supportDirectory(env, home), `access-${port}.token`)
}

/**
 * The secret this server runs with: the one its launcher handed it, else a new one.
 *
 * The helper passes a fresh one to every server it spawns, so it knows the secret without
 * reading it back and a respawned server never honours its predecessor's. The variable is deleted from the environment once read: the server
 * runs other programs (`ffmpeg`, `open`, the disk scanner), and none of them has any business
 * inheriting it. A value that is not a well-formed secret is ignored, without being quoted.
 */
export function resolveAccessToken(env: NodeJS.ProcessEnv = process.env): { token: string; source: 'env' | 'generated'; rejected: boolean } {
  const given = env[ACCESS_TOKEN_ENV]
  delete env[ACCESS_TOKEN_ENV]
  if (isWellFormedToken(given)) return { token: given, source: 'env', rejected: false }
  return { token: generateToken(), source: 'generated', rejected: given !== undefined && given !== '' }
}

/** Writes the secret to `path`, mode `0600`, replacing any previous file in one rename. */
export async function writeAccessToken(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    // `wx`: never through a file or a link someone put there first.
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(`${token}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    // The mode given to `open` is masked by the umask, which can only narrow it; said anyway.
    await chmod(tmp, 0o600)
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

/**
 * Removes the token file if it still holds `token`, synchronously, for an exit handler. A file
 * another server has written since (a second server on the port, started by hand) is left alone.
 * Quiet: an exit is no time to fail.
 */
export function removeAccessToken(path: string, token: string): void {
  try {
    if (readFileSync(path, 'utf8').trim() === token) unlinkSync(path)
  } catch {
    // Gone already, or unreadable: nothing to do.
  }
}
