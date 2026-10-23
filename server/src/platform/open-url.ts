import { execFile } from 'node:child_process'
import { targetPlatform, windowsTool } from './index.js'

/** Runs a program with an argument list, never through a shell. */
export type Exec = (file: string, args: string[], options?: { timeout?: number }) => Promise<void>

export interface OpenUrlDeps {
  platform?: NodeJS.Platform
  exec?: Exec
  /** Milliseconds before the opener is killed. */
  timeout?: number
  /** The schemes accepted; web pages only unless a caller names a deep link it checked itself. */
  schemes?: readonly string[]
}

const defaultExec: Exec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, shell: false }, (error) => (error ? reject(error) : resolve()))
  })

/**
 * Opens a URL in the user's default handler. Takes the parsed `href` the caller checked, and
 * refuses anything but `http:`/`https:` (or the schemes the caller names), so a `file:` URL or an
 * argument that looks like an option never reaches the opener.
 */
export async function openUrl(href: string, deps: OpenUrlDeps = {}): Promise<void> {
  let parsed: URL
  try { parsed = new URL(href) } catch { throw new Error('refused URL') }
  if (!(deps.schemes ?? ['http:', 'https:']).includes(parsed.protocol)) throw new Error('refused URL')
  const exec = deps.exec ?? defaultExec
  const options = deps.timeout === undefined ? undefined : { timeout: deps.timeout }
  if (targetPlatform(deps.platform) === 'win32') {
    await exec(windowsTool('rundll32'), ['url.dll,FileProtocolHandler', href], options)
  } else {
    await exec('/usr/bin/open', [href], options)
  }
}
