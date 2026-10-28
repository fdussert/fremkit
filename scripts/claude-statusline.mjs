#!/usr/bin/env node
// Claude Code status line, the Node version of claude-statusline.sh (Windows, or anywhere with
// no jq): prints the same one-line status for the same input and forwards the JSON to Fremkit.
// Configure: "statusLine": { "type": "command", "command": "node <repo>\\scripts\\claude-statusline.mjs" }
//
// Always exits 0. The server's access secret is read from its token file and sent in a header only.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { authHeader, isLoopbackUrl, portOf } from './lib/access.mjs'

const URL_ = process.env.FREMKIT_HOOK_URL || 'http://127.0.0.1:4242/api/hooks/claude'

// jq's `//`: null and false fall through.
const alt = (...values) => values.find((v) => v !== undefined && v !== null && v !== false)
// jq's `.key`: null passes through, anything but an object cannot be indexed (jq fails, and so
// does the line: an empty one, as the bash script prints).
function get(value, key) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('cannot index')
  return value[key]
}
const pct = (x) => `${Math.floor(x)}%`
// jq's `round` goes away from zero on halves.
const round = (x) => Math.sign(x) * Math.round(Math.abs(x))
const num = (x) => {
  if (typeof x !== 'number') throw new Error('not a number')
  return x
}

const ABSOLUTE_WINDOWS = /^[A-Za-z]:\\/

/**
 * git on Windows, by full path: the first absolute `X:\` PATH entry holding `git.exe`, or null.
 * A bare `git` would be looked up in the current folder before PATH there, and Claude Code runs
 * this line in the session's folder: a repository with a `git.exe` at its root would run it. `.`,
 * relative and empty entries are skipped for the same reason.
 */
export function windowsGit(env = process.env, exists = existsSync) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path')
  for (const entry of String((key && env[key]) || '').split(';')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (!ABSOLUTE_WINDOWS.test(dir)) continue
    const candidate = win32.join(dir, 'git.exe')
    if (exists(candidate)) return candidate
  }
  return null
}

// On the Mac a bare `git`, as the bash version: PATH lookup there never includes the current
// folder. On Windows git by full path (above), and no branch when there is none. No shell either way.
function gitBranch(cwd, platform = process.platform) {
  const git = platform === 'win32' ? windowsGit() : 'git'
  if (!git) return Promise.resolve('')
  return new Promise((resolve) => {
    execFile(git, ['-C', cwd || '.', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      // Like `$(…)`: whatever git printed counts, even when it then failed.
      resolve(String(stdout ?? err?.stdout ?? '').replace(/\n+$/, ''))
    })
  })
}

export function statusLine(input, branch) {
  const model = get(input, 'model')
  const workspace = get(input, 'workspace')
  const dir = alt(get(workspace, 'current_dir'), get(input, 'cwd'))
  const used = get(get(input, 'context_window'), 'used_percentage')
  const cost = get(get(input, 'cost'), 'total_cost_usd')
  const limits = get(input, 'rate_limits')
  const five = get(get(limits, 'five_hour'), 'used_percentage')
  const seven = get(get(limits, 'seven_day'), 'used_percentage')
  const folder = dir === undefined ? undefined : (typeof dir === 'string' ? dir.split(/[\\/]/).pop() : (() => { throw new Error('not a string') })())
  const parts = [
    alt(get(model, 'display_name'), get(model, 'id')),
    folder,
    branch,
    used != null ? `ctx ${pct(num(used))}` : undefined,
    cost != null ? `$${String(round(num(cost) * 100) / 100)}` : undefined,
    five != null ? `5h ${pct(num(five))}` : undefined,
    seven != null ? `7d ${pct(num(seven))}` : undefined,
  ]
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join(' · ')
}

async function main() {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { await new Promise((done) => process.stdout.write('\n', done)); return }

  let cwd = '.'
  try { cwd = alt(get(get(input, 'workspace'), 'current_dir'), get(input, 'cwd'), '.') } catch { /* the line below fails the same way */ }
  const branch = await gitBranch(typeof cwd === 'string' ? cwd : '.')

  // Forwarded without holding the line back: sent now, awaited after the line is printed.
  let sent = Promise.resolve()
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    sent = fetch(URL_, {
      method: 'POST',
      // The secret goes to this machine only, and a redirect is never followed.
      headers: { 'content-type': 'application/json', ...(isLoopbackUrl(URL_) ? authHeader(portOf(URL_)) : {}) },
      redirect: 'manual',
      body: JSON.stringify({ ...input, hook_event_name: 'StatusLine', fremkit_branch: branch }),
      signal: AbortSignal.timeout(500),
    }).then((res) => res.body?.cancel(), () => {})
  }

  let line = ''
  try { line = statusLine(input, branch) } catch { /* jq fails the same way: an empty line */ }
  // The line is out first. The request gets a moment to leave (a local server answers in
  // milliseconds), but a server that hangs does not hold the status line up for its full timeout.
  await new Promise((done) => process.stdout.write(`${line}\n`, done))
  await Promise.race([sent, new Promise((done) => setTimeout(done, 250))])
}

// Exit once the line has been written (awaited above) rather than when the socket closes.
// Only when run, not when a test imports statusLine().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {}).finally(() => process.exit(0))
