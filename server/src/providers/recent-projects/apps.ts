import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from '../exec.js'
import { detectHerdrTerminal, openInHerdr, type HerdrReach, type HerdrTerminal } from './herdr.js'
import type { ResolveBinary } from './sources/cli.js'
import { exists } from './util.js'

/** What a project can be opened with: a closed list, nothing a widget composes. */
export const APP_IDS = ['finder', 'terminal', 'iterm', 'ghostty', 'vscode', 'cursor', 'zed', 'xcode', 'herdr', 'tmux'] as const
export type AppId = (typeof APP_IDS)[number]

const OPEN = '/usr/bin/open'

/** The bundle each Mac application is found as, in the places applications are installed. */
const BUNDLES: Partial<Record<AppId, string[]>> = {
  finder: ['/System/Library/CoreServices/Finder.app'],
  terminal: ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app'],
  iterm: ['iTerm.app'],
  ghostty: ['Ghostty.app'],
  vscode: ['Visual Studio Code.app'],
  cursor: ['Cursor.app'],
  zed: ['Zed.app'],
  xcode: ['Xcode.app'],
}

export interface AppDeps {
  exec: Exec
  resolveBinary: ResolveBinary
  /** Whether a path exists; swapped in tests so they do not depend on what this Mac has. */
  exists?: (path: string) => Promise<boolean>
}

/** The bundle path of an application, or null when it is not installed. */
async function bundleOf(app: AppId, has: (p: string) => Promise<boolean>): Promise<string | null> {
  for (const name of BUNDLES[app] ?? []) {
    const candidates = name.startsWith('/') ? [name] : [join('/Applications', name), join(homedir(), 'Applications', name)]
    for (const c of candidates) if (await has(c)) return c
  }
  return null
}

/** The applications of `APP_IDS` installed on this Mac, in that order. */
export async function installedApps(deps: AppDeps): Promise<AppId[]> {
  const has = deps.exists ?? exists
  const out: AppId[] = []
  for (const app of APP_IDS) {
    if (app === 'herdr' || app === 'tmux') {
      if (await deps.resolveBinary(app)) out.push(app)
    } else if (await bundleOf(app, has)) {
      out.push(app)
    }
  }
  return out
}

export type OpenResult = { ok: true; herdr?: HerdrReach; front?: AppId | null } | { ok: false; error: string }

/**
 * Opens one folder with one application. `path` has been checked against the snapshot by the
 * caller; every program is run by its absolute path with an argument list, never a shell.
 * Herdr goes to the pane already in the folder, or splits a new one beside the focused pane
 * without moving the focus, then brings its terminal forward; tmux opens a new window.
 */
export async function openWith(app: AppId, path: string, deps: AppDeps, opts: { terminal?: HerdrTerminal } = {}): Promise<OpenResult> {
  if (app === 'herdr' || app === 'tmux') {
    const bin = await deps.resolveBinary(app)
    if (!bin) return { ok: false, error: 'not-installed' }
    if (app === 'tmux') {
      await deps.exec(bin, ['new-window', '-c', path])
      return { ok: true }
    }
    const herdr = await openInHerdr(deps.exec, bin, path)
    return { ok: true, herdr, front: await bringTerminalForward(opts.terminal ?? 'auto', deps) }
  }
  const bundle = await bundleOf(app, deps.exists ?? exists)
  if (!bundle) return { ok: false, error: 'not-installed' }
  await deps.exec(OPEN, ['-a', bundle, path])
  return { ok: true }
}

/**
 * Activates the terminal Herdr runs in (`open -a` with no file only brings it forward): the one
 * the tile chose, or the one found running Herdr's client. Null when none is known or installed;
 * a terminal that will not come forward never fails the open, whose work in Herdr is done.
 */
async function bringTerminalForward(choice: HerdrTerminal, deps: AppDeps): Promise<AppId | null> {
  try {
    const app = choice === 'auto' ? await detectHerdrTerminal(deps.exec) : choice
    const bundle = app && (await bundleOf(app, deps.exists ?? exists))
    if (!app || !bundle) return null
    await deps.exec(OPEN, ['-a', bundle])
    return app
  } catch {
    return null
  }
}
