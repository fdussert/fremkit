// The local access secret, for Node scripts that call the server (see SECURITY.md). The same
// rules as lib/access.sh, plus Windows, and the same support-folder rule as the server's
// `supportDirectory()` in server/src/http/access-file.ts (scripts-access.test.ts keeps the two
// from drifting). Plain JavaScript on purpose: scripts ship beside it with no build step.
//
// The secret goes in an `Authorization` header and nowhere else: never argv, never the
// environment of a child, never printed. The file is read on every call, so a script follows a
// server restart and sends nothing while no server runs.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'

const ABSOLUTE_WINDOWS = /^[A-Za-z]:\\/

/** The port in an http://host:port/… URL, or 4242. */
export function portOf(url) {
  let rest = String(url ?? '').replace(/^[^/]*:\/\//, '')
  rest = rest.split('/')[0]
  const i = rest.lastIndexOf(':')
  const port = i >= 0 ? rest.slice(i + 1) : ''
  return /^\d{1,5}$/.test(port) ? Number(port) : 4242
}

/** The helper's support folder. Only `win32` is Windows; every other platform is the Mac's rule. */
export function supportDirectory(env = process.env, platform = process.platform, home = homedir()) {
  const override = env.FREMKIT_SUPPORT_DIR
  if (platform === 'win32') {
    if (override && ABSOLUTE_WINDOWS.test(override)) return override
    const local = env.LOCALAPPDATA
    const base = local && ABSOLUTE_WINDOWS.test(local) ? local : win32.join(home, 'AppData', 'Local')
    return win32.join(base, 'Fremkit')
  }
  if (override && override.startsWith('/')) return override
  return join(home, 'Library', 'Application Support', 'Fremkit')
}

/** The token file for a port (default 4242); `FREMKIT_ACCESS_TOKEN_FILE` names the file outright. */
export function tokenFile(port = 4242, env = process.env, platform = process.platform, home = homedir()) {
  if (env.FREMKIT_ACCESS_TOKEN_FILE) return env.FREMKIT_ACCESS_TOKEN_FILE
  const dir = supportDirectory(env, platform, home)
  return (platform === 'win32' ? win32.join : join)(dir, `access-${port}.token`)
}

/** The secret for a port, or null when the file is not there or is empty. */
function readToken(port, env, platform) {
  try {
    const first = readFileSync(tokenFile(port, env, platform), 'utf8').split('\n')[0].replace(/\r$/, '')
    return first || null
  } catch {
    return null
  }
}

/** Whether a URL names this machine (127.0.0.1, localhost, [::1]): the only place the secret is sent. */
export function isLoopbackUrl(url) {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(String(url)).hostname)
  } catch {
    return false
  }
}

/** Headers to spread into a `fetch`: `{ Authorization }`, or `{}` when there is no secret. */
export function authHeader(port = 4242, env = process.env, platform = process.platform) {
  const token = readToken(port, env, platform)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * A one-time link that signs a browser in and lands on `next` (a path, default `/`). `base` is
 * the server's URL, which mints the code; `page` is the origin the link is opened on when that is
 * not the server itself (the Vite dev server, which proxies /auth). Null on any failure.
 */
export async function authUrl(base, next = '/', page = base) {
  try {
    const root = String(base).replace(/\/+$/, '')
    const res = await fetch(`${root}/api/auth/code`, {
      method: 'POST',
      headers: authHeader(portOf(root)),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    const code = (await res.json())?.code
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]+$/.test(code)) return null
    return `${String(page).replace(/\/+$/, '')}/auth?code=${code}&next=${encodeURIComponent(next)}`
  } catch {
    return null
  }
}
