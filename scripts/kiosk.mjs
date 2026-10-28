#!/usr/bin/env node
// Launch the dashboard full screen, as an app window, on the Xeneon Edge display (2560x720).
// Without the Edge plugged in: a 2560x720 window at the origin of the main display.
//
// macOS: Google Chrome, opened with `open -na`; the display is found with CoreGraphics (Swift).
// Windows: Microsoft Edge; the display is found with System.Windows.Forms (PowerShell).
//
// The server answers only holders of its access secret: the browser is given a one-time link that
// sets the cookie in its own profile and lands on the dashboard (see lib/access.mjs). The secret
// itself never reaches argv.
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { authUrl } from './lib/access.mjs'
import { isMainModule } from './lib/main.mjs'
import { systemRoot } from './open.mjs'

const ABSOLUTE_DRIVE_DIR = /^[A-Za-z]:\\[^"<>|?*]*$/

/** An environment directory when it is an absolute drive path with no `..` segment, else null. */
export function safeWindowsDir(value) {
  if (typeof value !== 'string' || !ABSOLUTE_DRIVE_DIR.test(value)) return null
  if (value.split(/[\\/]/).includes('..')) return null
  return value.replace(/\\+$/, '')
}

/** The Edge executable: Program Files (x86) first, then Program Files. Null when neither has it. */
export function edgePath(env = process.env, exists = existsSync) {
  for (const key of ['ProgramFiles(x86)', 'ProgramFiles']) {
    const dir = safeWindowsDir(env[key])
    if (!dir) continue
    const candidate = `${dir}\\Microsoft\\Edge\\Application\\msedge.exe`
    if (exists(candidate)) return candidate
  }
  return null
}

/** The browser profile folder of the kiosk. */
export function profileDir(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32') {
    const base = safeWindowsDir(env.LOCALAPPDATA) ?? win32.join(home, 'AppData', 'Local')
    return win32.join(base, 'Fremkit', 'kiosk-profile')
  }
  return join(home, 'Library', 'Application Support', 'Fremkit', 'chrome-profile')
}

/** A constant, sent on stdin: nothing is ever interpolated into it. Prints "X Y". */
export const SWIFT_SCREEN_SCRIPT = `import CoreGraphics
var count: UInt32 = 0
var ids = [CGDirectDisplayID](repeating: 0, count: 16)
CGGetActiveDisplayList(16, &ids, &count)
for i in 0..<Int(count) {
  let b = CGDisplayBounds(ids[i])
  if Int(b.width) == 2560 && Int(b.height) == 720 { print(Int(b.origin.x), Int(b.origin.y)); exit(0) }
}
print(0, 0)
`

/** A constant, sent on stdin: nothing is ever interpolated into it. Prints "X Y". DPI-aware first,
 * so a scaled display still reports its real 2560x720 bounds. */
export const POWERSHELL_SCREEN_SCRIPT = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class FremkitDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][FremkitDpi]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
$x = 0
$y = 0
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  if ($s.Bounds.Width -eq 2560 -and $s.Bounds.Height -eq 720) { $x = $s.Bounds.X; $y = $s.Bounds.Y; break }
}
Write-Output ("{0} {1}" -f $x, $y)
`

/** "X Y" (two integers) from a screen script's output, else null. Strict: anything else is "not found". */
export function parseScreenOrigin(stdout) {
  const m = /^(-?\d{1,6}) (-?\d{1,6})\r?\n?$/.exec(String(stdout))
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null
}

/** The screen script's program and arguments, by absolute path. */
export function screenCommand(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return {
      file: `${systemRoot(env)}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: ['-NoProfile', '-Command', '-'],
      script: POWERSHELL_SCREEN_SCRIPT,
    }
  }
  return { file: '/usr/bin/swift', args: ['-'], script: SWIFT_SCREEN_SCRIPT }
}

/** The browser flags: the same on both platforms. */
export function kioskFlags({ profile, url, x, y }) {
  return [
    `--user-data-dir=${profile}`,
    `--app=${url}`,
    `--window-position=${x},${y}`,
    '--window-size=2560,720',
    '--kiosk',
    '--no-first-run',
    '--disable-session-crashed-bubble',
    '--autoplay-policy=no-user-gesture-required',
  ]
}

/** The program and argument list that start the kiosk browser, or `{ error }` (no Edge on Windows). */
export function kioskCommand({ platform = process.platform, env = process.env, exists = existsSync, profile, url, x, y }) {
  const flags = kioskFlags({ profile, url, x, y })
  if (platform === 'win32') {
    const edge = edgePath(env, exists)
    if (!edge) return { error: 'fremkit: Microsoft Edge was not found under Program Files. Install it, then run this again.' }
    return { file: edge, args: flags }
  }
  return { file: '/usr/bin/open', args: ['-na', 'Google Chrome', '--args', ...flags] }
}

/**
 * Runs the screen script; resolves to the parsed origin, or 0,0 when the script fails, times out
 * or prints something else (as kiosk.sh did), after a one-line warning through `warn`.
 */
export function findScreen({ platform = process.platform, env = process.env, run = runScript, warn = () => {} } = {}) {
  const cmd = screenCommand(platform, env)
  const fallback = () => {
    warn('fremkit: the 2560x720 Edge display was not found; opening on the main display.')
    return { x: 0, y: 0 }
  }
  return Promise.resolve()
    .then(() => run(cmd))
    .then((stdout) => parseScreenOrigin(stdout) ?? fallback(), fallback)
}

/** Runs a program with a constant script on stdin; resolves to its stdout. */
export function runScript({ file, args, script }, { execFile = nodeExecFile, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
    child.stdin?.on('error', () => {})
    child.stdin?.end(script)
  })
}

/** Starts a program detached and resolves once it has spawned; rejects when it cannot. */
export function launch(file, args, { spawn = nodeSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** The whole command, with its seams injected. Returns the exit code. */
export async function main(
  _argv = [],
  { env = process.env, platform = process.platform, io = {}, mint = authUrl, run = runScript, start = launch, exists = existsSync, mkdir = mkdirSync, home = homedir() } = {},
) {
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`))
  const server = env.FREMKIT_URL || 'http://127.0.0.1:4242'
  const url = await mint(server.replace(/\/+$/, ''), '/')
  if (!url) {
    err(`fremkit: could not get a sign-in link from ${server}; is the server running?`)
    return 1
  }
  const profile = profileDir(env, platform, home)
  const { x, y } = await findScreen({ platform, env, run, warn: err })
  const cmd = kioskCommand({ platform, env, exists, profile, url, x, y })
  if (cmd.error) {
    err(cmd.error)
    return 1
  }
  try {
    mkdir(profile, { recursive: true, mode: 0o700 })
    await start(cmd.file, cmd.args)
  } catch {
    err(`fremkit: could not start the browser (${cmd.file}).`)
    return 1
  }
  return 0
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
