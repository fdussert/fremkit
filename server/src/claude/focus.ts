import { execFile } from 'node:child_process'
import type { SessionClient } from './tracker.js'

/**
 * Bringing the window of a Claude session to the front.
 *
 * The card knows a session is waiting for an answer and, until now, that was the end of what it
 * could do: the person read "waiting for you" and then went looking through their windows for
 * which one. The hook already runs inside the session, so the pane it lives in is known; this is
 * the other half, turning that back into a window in front of you.
 *
 * Everything here runs through `execFile` with a fixed argument list — no shell, ever — and every
 * value taken from a session is matched against a pattern first. Not because a shell could eat
 * it (there is none) but because these end up as command-line arguments, and an argument that
 * starts with a dash is a flag. The AppleScripts are constants and take their one variable as
 * `on run argv`, so nothing is ever interpolated into a script.
 */

export type Runner = (cmd: string, args: string[]) => Promise<void>

const run: Runner = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 5000 }, (err) => (err ? reject(err) : resolve())))

/** Orca ships its CLI inside the bundle; `orca terminal switch` is what fronts one pane. */
const ORCA_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
const ORCA_BUNDLE = 'com.stablyai.orca'
const VSCODE_BUNDLE = 'com.microsoft.VSCode'

/** A bundle id, as `open -b` will take it. */
const BUNDLE_RE = /^[A-Za-z0-9.-]{1,120}$/
/** A tty as `ps` prints it: `ttys028`. The AppleScripts compare against `/dev/` + this. */
const TTY_RE = /^tty[A-Za-z0-9.]{1,12}$/
/** A runtime-issued Orca terminal handle: `term_2e8d4c0c-…`. */
const ORCA_TERMINAL_RE = /^term_[A-Za-z0-9._-]{1,64}$/
/** A path `open` is given as the folder to reuse a window on. Absolute, and not a flag. */
const PATH_RE = /^\/[^\0]{0,1024}$/

/**
 * Terminal.app: pick the tab whose tty is the session's, then raise it.
 *
 * `tty` is the only property that identifies a tab from the outside — `TERM_SESSION_ID`, which
 * the environment does carry, is not exposed to AppleScript at all. Falling through to a plain
 * `activate` is deliberate: the window may have been closed, and fronting the application is
 * still more than the card could do before.
 */
const TERMINAL_SCRIPT = `on run argv
  set wanted to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        try
          if tty of t is wanted then
            set selected of t to true
            set index of w to 1
            activate
            return "tab"
          end if
        end try
      end repeat
    end repeat
    activate
  end tell
  return "app"
end run`

/** iTerm2: the same walk, one level deeper — a tab holds sessions, and the tty is on a session. */
const ITERM_SCRIPT = `on run argv
  set wanted to item 1 of argv
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          try
            if tty of s is wanted then
              select w
              select t
              select s
              activate
              return "tab"
            end if
          end try
        end repeat
      end repeat
    end repeat
    activate
  end tell
  return "app"
end run`

export interface FocusResult {
  ok: boolean
  /** What actually happened, so the card can say "its tab" rather than "its application". */
  how?: 'pane' | 'tab' | 'app'
  reason?: 'unknownClient' | 'failed'
}

/**
 * Fronts the window a session lives in.
 *
 * Ordered from the most precise thing the client offers to the least: the exact pane, then the
 * application. An unknown client with no bundle id has nothing to aim at and says so, rather
 * than fronting something arbitrary.
 */
export async function focusClient(client: SessionClient | undefined, cwd: string, runner: Runner = run): Promise<FocusResult> {
  if (!client) return { ok: false, reason: 'unknownClient' }
  const kind = kindOf(client)
  try {
    switch (kind) {
      case 'orca': return await focusOrca(client, runner)
      case 'terminal': return await focusTty(TERMINAL_SCRIPT, client.tty, 'com.apple.Terminal', runner)
      case 'iterm': return await focusTty(ITERM_SCRIPT, client.tty, 'com.googlecode.iterm2', runner)
      case 'vscode': return await focusVscode(cwd, runner)
      default: return await focusApp(client.bundleId, runner)
    }
  } catch {
    // A window that will not come forward is not a reason to log anything with a pane key in it.
    return { ok: false, reason: 'failed' }
  }
}

/** The same table as the tracker's view, kept here as the answer to "how do I raise this one". */
function kindOf(client: SessionClient): string {
  const b = client.bundleId?.toLowerCase()
  const p = client.program?.toLowerCase()
  if (b === ORCA_BUNDLE.toLowerCase() || p === 'orca') return 'orca'
  if (b === 'com.apple.terminal' || p === 'apple_terminal') return 'terminal'
  if (b === 'com.googlecode.iterm2' || p === 'iterm.app') return 'iterm'
  if (b === 'com.microsoft.vscode' || b === 'com.visualstudio.code.oss' || p === 'vscode') return 'vscode'
  return 'other'
}

/**
 * Orca: `orca terminal switch --terminal <handle>` raises the exact pane.
 *
 * Found by reading the CLI its bundle ships (`orca --help`): `terminal switch` is documented as
 * "Switch to a terminal tab in the UI" and takes the runtime handle the session's environment
 * exports as `ORCA_TERMINAL_HANDLE`. The other routes — the `orca://` URL scheme, and the agent
 * hook endpoint the hooks post to — were considered and left alone: the scheme is undocumented,
 * and the endpoint is an inbound receiver guarded by a token this code has no business holding.
 */
async function focusOrca(client: SessionClient, runner: Runner): Promise<FocusResult> {
  const handle = client.orca?.terminal
  if (handle && ORCA_TERMINAL_RE.test(handle)) {
    try {
      await runner(ORCA_CLI, ['terminal', 'switch', '--terminal', handle])
      return { ok: true, how: 'pane' }
    } catch { /* the CLI is missing, or the pane is gone: front the app instead */ }
  }
  return await focusApp(ORCA_BUNDLE, runner)
}

/** Terminal.app and iTerm2: an AppleScript that walks the tabs, with the tty as its only argument. */
async function focusTty(script: string, tty: string | undefined, bundleId: string, runner: Runner): Promise<FocusResult> {
  if (tty && TTY_RE.test(tty)) {
    try {
      await runner('/usr/bin/osascript', ['-e', script, `/dev/${tty}`])
      return { ok: true, how: 'tab' }
    } catch { /* automation refused, or the window is gone */ }
  }
  return await focusApp(bundleId, runner)
}

/** VS Code: `open -b … <folder>` reuses the window already on that folder rather than opening one. */
async function focusVscode(cwd: string, runner: Runner): Promise<FocusResult> {
  if (PATH_RE.test(cwd)) {
    try {
      await runner('/usr/bin/open', ['-b', VSCODE_BUNDLE, cwd])
      return { ok: true, how: 'app' }
    } catch { /* not installed under that id */ }
  }
  return await focusApp(VSCODE_BUNDLE, runner)
}

/** The last resort everywhere: front the application, if we know which one it is. */
async function focusApp(bundleId: string | undefined, runner: Runner): Promise<FocusResult> {
  if (!bundleId || !BUNDLE_RE.test(bundleId)) return { ok: false, reason: 'unknownClient' }
  await runner('/usr/bin/open', ['-b', bundleId])
  return { ok: true, how: 'app' }
}
