#!/usr/bin/env node
// Claude Code hook, the Node version of claude-hook.sh (Windows, or anywhere with no bash):
// forwards the event JSON to Fremkit. Always exits 0; never blocks the session.
// Configure it with "async": true in ~/.claude/settings.json, command `node <repo>\scripts\claude-hook.mjs`.
//
// The hook runs inside the session's environment, which is the only place that knows where that
// session lives, so a `client` object is added to the event here (see docs/claude-code.md).
//
// What is deliberately not sent: ORCA_AGENT_HOOK_ENDPOINT and ORCA_AGENT_HOOK_TOKEN. A credential
// does not belong in an event that ends up in data/claude-sessions.json.
//
// The server's access secret is read from its token file and sent in a header; it is never on a
// command line, in a child's environment, or printed.
import { readFileSync } from 'node:fs'
import { authHeader, portOf } from './lib/access.mjs'

const env = process.env
const URL_ = env.FREMKIT_HOOK_URL || 'http://127.0.0.1:4242/api/hooks/claude'

// Control characters become spaces rather than escapes (newlines are dropped): none of these
// fields is supposed to hold any, and a mangled value is better than a body the server drops whole.
const clean = (value) => String(value ?? '').replace(/\n/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ')
const put = (target, key, value) => {
  const text = clean(value)
  if (text) target[key] = text
}

/** The `client` object from the environment; empty when nothing is known. */
export function clientFrom(environment, ppid) {
  const client = {}
  put(client, 'bundleId', environment.__CFBundleIdentifier)
  put(client, 'program', environment.TERM_PROGRAM)
  if (Number.isInteger(ppid) && ppid > 1) client.pid = ppid
  put(client, 'terminalSession', environment.TERM_SESSION_ID || environment.ITERM_SESSION_ID)
  // Only a plain distribution name: the server drops anything else, so do not send it.
  if (/^[A-Za-z0-9._-]{1,64}$/.test(environment.WSL_DISTRO_NAME ?? '')) client.wslDistro = environment.WSL_DISTRO_NAME
  const orca = {}
  put(orca, 'pane', environment.ORCA_PANE_KEY)
  put(orca, 'tab', environment.ORCA_TAB_ID)
  put(orca, 'terminal', environment.ORCA_TERMINAL_HANDLE)
  if (Object.keys(orca).length) client.orca = orca
  return client
}

/** The body with `client` merged in; the original text when it is not an object or nothing is known. */
export function merge(body, client) {
  if (!Object.keys(client).length) return body
  try {
    const parsed = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body
    // The event's own `client`, if it has one, wins, as in the bash version.
    return JSON.stringify({ client, ...parsed })
  } catch {
    return body
  }
}

async function main() {
  let body = ''
  try { body = readFileSync(0, 'utf8') } catch { return }
  if (!body.trim()) return
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(portOf(URL_)) },
      body: merge(body, clientFrom(env, process.ppid)),
      signal: AbortSignal.timeout(1000),
    })
    await res.body?.cancel()
  } catch { /* offline, refused, timed out: the session must not notice */ }
}

// Not process.exit(): every wait above is bounded.
process.exitCode = 0
main().catch(() => {})
