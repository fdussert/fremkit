#!/usr/bin/env node
// Opens the dashboard or the admin in the default browser, signed in.
//
//   pnpm open            the dashboard, http://127.0.0.1:4242/
//   pnpm open /admin     the admin
//   pnpm open --dev …    the same through the Vite dev server (pnpm dev), http://localhost:5173
//   pnpm open --print …  print the link instead of opening it
//
// The server only answers callers holding its access secret (SECURITY.md). This reads it from the
// token file, asks the server for a one-time code, and opens /auth?code=…, which sets the cookie
// and lands on the page. The link works once, within a minute. The secret itself never reaches
// argv: only that one-time link does.
import { execFile } from 'node:child_process'
import { authUrl, portOf, tokenFile } from './lib/access.mjs'
import { isMainModule } from './lib/main.mjs'

export const USAGE = 'usage: pnpm open [--dev] [--print] [/path]'

/** The flags and the path of one invocation, or `{ error }` for anything else (exit code 2). */
export function parseArgs(argv, env = process.env) {
  const server = env.FREMKIT_URL || `http://127.0.0.1:${env.FREMKIT_PORT || 4242}`
  const out = { server, page: server, print: false, path: '/' }
  for (const arg of argv) {
    if (arg === '--dev') out.page = 'http://localhost:5173'
    else if (arg === '--print') out.print = true
    else if (arg.startsWith('/')) out.path = arg
    else return { error: USAGE }
  }
  return out
}

/** `SystemRoot` when the environment gives an absolute drive path with no `..` segment, else C:\Windows. */
export function systemRoot(env = process.env) {
  const v = env.SystemRoot ?? env.SYSTEMROOT
  if (typeof v === 'string' && /^[A-Za-z]:\\[^"<>|?*]*$/.test(v) && !v.split(/[\\/]/).includes('..')) {
    return v.replace(/\\+$/, '')
  }
  return 'C:\\Windows'
}

/** The program and argument list that open a URL in the default browser, by absolute path. */
export function openerCommand(url, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return { file: `${systemRoot(env)}\\System32\\rundll32.exe`, args: ['url.dll,FileProtocolHandler', url] }
  }
  return { file: '/usr/bin/open', args: [url] }
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, (err) => (err ? reject(err) : resolve()))
  })
}

/**
 * The whole command, with its seams injected. Returns the exit code; writes through `io`.
 * `opener(file, args)` runs the browser launch.
 */
export async function main(argv, { env = process.env, platform = process.platform, io = {}, opener = run, mint = authUrl } = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`))
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`))
  const args = parseArgs(argv, env)
  if (args.error) {
    err(args.error)
    return 2
  }
  const url = await mint(args.server, args.path, args.page)
  if (!url) {
    err(`fremkit: could not get a sign-in link from ${args.server}.`)
    err(`Is the server running, and is ${tokenFile(portOf(args.server), env, platform)} readable?`)
    return 1
  }
  if (args.print) {
    out(url)
    return 0
  }
  const { file, args: argList } = openerCommand(url, platform, env)
  try {
    await opener(file, argList)
  } catch {
    err(`fremkit: could not open the browser (${file}). The link: ${url}`)
    return 1
  }
  return 0
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
