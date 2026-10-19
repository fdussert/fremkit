/**
 * A throwaway Fremkit server for one Playwright worker.
 *
 * Everything it touches is its own: a temporary data folder (the config, the history, the
 * background library, `secrets.json`), a temporary support folder (the access-token file and the
 * log), its own port, and a registry index served from this process so the marketplace never
 * reaches the network. The secrets backend is `file`, written into the first config before the
 * server reads it: a test that stores a secret must never reach the macOS keychain.
 *
 * The server is the real one, `server/src/index.ts` under tsx, serving the built `ui/dist`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { baseConfig } from './seeds.js'

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SERVER_DIR = join(ROOT, 'server')
const TSX = join(SERVER_DIR, 'node_modules', '.bin', 'tsx')
const FIXTURES = fileURLToPath(new URL('.', import.meta.url))

/**
 * The test ports: 4330–4339 by default, one per parallel worker, never the live 4242.
 * `E2E_FIRST_PORT` moves the range, so several checkouts or agents can run the suite at once.
 */
export const FIRST_PORT = firstPort(process.env.E2E_FIRST_PORT)

function firstPort(value: string | undefined): number {
  if (value === undefined || value === '') return 4330
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535 - 10 || (port <= 4243 && port + 9 >= 4242)) {
    throw new Error(`E2E_FIRST_PORT must be a free range of ten ports clear of 4242–4243, not ${value}`)
  }
  return port
}
export const MAX_WORKERS = 10

export interface ServerOptions {
  port: number
  /** Widgets read from `<dataDir>/widgets-dev` (`FREMKIT_WIDGET_DEV=1`): the hostile test widgets. */
  devWidgets?: string[]
}

export interface RunningServer {
  port: number
  baseURL: string
  /** The local access secret, handed to the server in its environment. */
  token: string
  dataDir: string
  /** Every line the server wrote, for a failing test's report. */
  log: string[]
  stop(): Promise<void>
}

/** A local registry index with nothing in it: the admin reads it when it opens. */
async function startRegistry(): Promise<{ url: string; server: Server }> {
  const index = await readFile(join(FIXTURES, 'registry', 'index.json'), 'utf8')
  const server = createServer((req, res) => {
    if (req.url?.split('?')[0] === '/index.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(index)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/index.json`, server }
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string, child: ChildProcess, log: string[], ms = 30_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`the test server exited (${child.exitCode}) before ${what}:\n${log.slice(-40).join('')}`)
    if (await check()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ${what}:\n${log.slice(-40).join('')}`)
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  if (!existsSync(join(ROOT, 'ui', 'dist', 'index.html'))) {
    throw new Error('ui/dist is missing: run `pnpm --filter ui build` before `pnpm e2e`')
  }
  const tmp = await mkdtemp(join(tmpdir(), 'fremkit-e2e-'))
  const dataDir = join(tmp, 'data')
  const supportDir = join(tmp, 'support')
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await mkdir(supportDir, { recursive: true, mode: 0o700 })
  await writeFile(join(dataDir, 'fremkit.json'), JSON.stringify(baseConfig(), null, 2))
  for (const id of opts.devWidgets ?? []) {
    await cp(join(FIXTURES, 'widgets', id), join(dataDir, 'widgets-dev', id), { recursive: true })
  }

  const registry = await startRegistry()
  const token = randomBytes(32).toString('base64url')
  const log: string[] = []
  const child = spawn(TSX, ['src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: tmp,
      LANG: 'en_US.UTF-8',
      FREMKIT_PORT: String(opts.port),
      FREMKIT_DATA_DIR: dataDir,
      FREMKIT_SUPPORT_DIR: supportDir,
      FREMKIT_ACCESS_TOKEN: token,
      // Only so the registry may be this process's http://127.0.0.1 one (see server/src/index.ts).
      FREMKIT_DEV: '1',
      FREMKIT_REGISTRY_URL: registry.url,
      ...(opts.devWidgets?.length ? { FREMKIT_WIDGET_DEV: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', (d: Buffer) => log.push(d.toString()))
  child.stderr!.on('data', (d: Buffer) => log.push(d.toString()))

  const stop = async (): Promise<void> => {
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((r) => setTimeout(r, 4_000))])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    await new Promise((r) => registry.server.close(r))
    await rm(tmp, { recursive: true, force: true })
  }

  try {
    // The token file is written once the port is bound: the server is ready when it appears.
    const tokenFile = join(supportDir, `access-${opts.port}.token`)
    await waitFor(() => existsSync(tokenFile), 'the server to listen', child, log)
  } catch (error) {
    await stop()
    throw error
  }

  return { port: opts.port, baseURL: `http://127.0.0.1:${opts.port}`, token, dataDir, log, stop }
}
