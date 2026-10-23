#!/usr/bin/env node
// Claude Code status line, the Node version of claude-statusline.sh (Windows, or anywhere with
// no jq): prints the same one-line status for the same input and forwards the JSON to Fremkit.
// Configure: "statusLine": { "type": "command", "command": "node <repo>\\scripts\\claude-statusline.mjs" }
//
// Always exits 0. The server's access secret is read from its token file and sent in a header only.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { authHeader, portOf } from './lib/access.mjs'

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

function gitBranch(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd || '.', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
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
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { process.stdout.write('\n'); return }

  let cwd = '.'
  try { cwd = alt(get(get(input, 'workspace'), 'current_dir'), get(input, 'cwd'), '.') } catch { /* the line below fails the same way */ }
  const branch = await gitBranch(typeof cwd === 'string' ? cwd : '.')

  // Forwarded without holding the line back: sent now, awaited after the line is printed.
  let sent = Promise.resolve()
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    sent = fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(portOf(URL_)) },
      body: JSON.stringify({ ...input, hook_event_name: 'StatusLine', fremkit_branch: branch }),
      signal: AbortSignal.timeout(500),
    }).then((res) => res.body?.cancel(), () => {})
  }

  let line = ''
  try { line = statusLine(input, branch) } catch { /* jq fails the same way: an empty line */ }
  process.stdout.write(`${line}\n`)
  await sent
}

// Not process.exit(): a piped stdout may still be flushing. Every wait above is bounded.
process.exitCode = 0
main().catch(() => {})
