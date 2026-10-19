/**
 * `pnpm widget:preview`: a picture of each widget, taken against a demo server.
 *
 *   pnpm widget:preview <id> [<id>…] | --all  [--dir <folder>] [--url <demo server>]
 *                       [--wait <ms>] [--png] [--dry-run]
 *
 * For each widget: a dashboard screen exactly its default size holding it alone, with the demo
 * settings of `demo/seed.ts` (a built-in) or its manifest defaults (anyone else's), opened in
 * headless Chromium at twice the CSS resolution; once the widget shows data the tile is captured
 * with a transparent outside, encoded as WebP by Chromium itself (no image library in the
 * project), written as `preview.webp` beside the manifest, and the manifest's `preview` is set.
 *
 * The widgets are the built-ins (`widgets/`) unless `--dir` names an author's folder, which is
 * read the way `pnpm dev` reads `widgets-dev`. The server is an in-process demo one on a free
 * port (`FREMKIT_DEMO` semantics: invented data, temporary data folder), or the demo server
 * `--url` names, whose config is changed for the capture and put back after.
 *
 * Playwright is not a dependency: `PLAYWRIGHT=<path to the playwright package>` (default
 * `require('playwright')`) and `CHROMIUM=<executable>` when Playwright's own is not installed —
 * the same two variables as `scripts/check-widget-sandbox.ts`.
 */

import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shippedPaths } from '../paths.js'
import { DEFAULT_BACKGROUND } from '../backgrounds/seed.js'
import { generateToken } from '../http/access.js'
import { accessTokenPath } from '../http/access-file.js'
import { ManifestSchema, PREVIEW_MAX_BYTES, PREVIEW_SCALE, PREVIEW_CELL_PX, type WidgetManifest } from '../widgets/manifest.js'
import { DEMO_SETTINGS, prepareDemoDataDir } from '../demo/seed.js'
import { declaredTypeId, slugText } from '../connections/declared.js'
import type { Config } from '../config/schema.js'

export class PreviewUsageError extends Error {}

/** The screen and the instance the captures use; removed again when `--url` was given. */
const SCREEN_ID = 'fremkit-preview'
const INSTANCE_PREFIX = 'fremkit-preview-'
/** The narrowest preview screen, in cells. */
const MIN_COLS = 32

/** What we use of Playwright, typed here so the project does not need it to typecheck. */
interface Page {
  goto(url: string): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>
  addStyleTag(opts: { content: string }): Promise<unknown>
  locator(selector: string): { screenshot(opts: { omitBackground?: boolean; type?: 'png' }): Promise<Buffer> }
  frames(): Frame[]
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>
  close(): Promise<void>
}
interface Frame { url(): string; evaluate<T>(fn: () => T): Promise<T> }
interface Browser {
  newContext(opts: { viewport: { width: number; height: number }; deviceScaleFactor: number; locale?: string }): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>
  close(): Promise<void>
}

export interface PreviewOptions {
  ids: string[]
  all: boolean
  dir?: string
  url?: string
  waitMs: number
  png: boolean
  dryRun: boolean
}

/** A widget to capture: where its folder is, and what it says about itself. */
export interface Target { id: string; folder: string; manifest: WidgetManifest }

async function readTarget(folder: string, id: string): Promise<Target | null> {
  try {
    const manifest = ManifestSchema.parse(JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')))
    return { id, folder, manifest }
  } catch {
    return null
  }
}

async function findTargets(opts: PreviewOptions, builtinDir: string): Promise<Target[]> {
  const root = opts.dir ?? builtinDir
  const ids = opts.all ? (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort() : opts.ids
  if (ids.length === 0) throw new PreviewUsageError('name a widget id, or pass --all')
  const targets: Target[] = []
  for (const id of ids) {
    const target = await readTarget(join(root, id), id)
    if (!target) throw new PreviewUsageError(`${join(root, id)} holds no valid manifest.json`)
    targets.push(target)
  }
  return targets
}

/** The connection a capture creates for a widget's declared type: one per widget, removed after. */
const CONNECTION_PREFIX = 'fremkit-preview-'

/**
 * The settings a widget is captured with: the demo's (`DEMO_SETTINGS`) or its manifest defaults,
 * with every `connection` setting still empty pointed at a connection of its type — one the demo
 * seeded (the Synology NAS), else one the capture created for the widget's declared type. Without
 * it a widget that reads through a connection could only ever show "pick a connection".
 */
export function previewSettings(target: Target, connections: { id: string; type: string }[]): Record<string, unknown> {
  const settings: Record<string, unknown> = structuredClone(DEMO_SETTINGS[target.id] ?? {})
  for (const [key, field] of Object.entries(target.manifest.settingsSchema)) {
    if (field.type !== 'connection' || settings[key] !== undefined || !field.connectionType) continue
    const found = connections.find((c) => c.type === field.connectionType)
    if (found) settings[key] = found.id
  }
  return settings
}

/**
 * A connection of the widget's declared type, unless the demo already holds one: the declared
 * fields filled with documentation-range placeholders. The demo server answers its requests from
 * invented devices (`demo/declared.ts`), so nothing typed here is ever dialled or sent.
 */
async function declaredConnection(api: (p: string, i?: RequestInit) => Promise<Response>, target: Target, existing: { type: string }[]): Promise<string | null> {
  const decl = target.manifest.connection
  if (!decl) return null
  const type = declaredTypeId(target.id, slugText(decl.name))
  if (existing.some((c) => c.type === type)) return null
  const fields: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  for (const f of decl.fields) {
    if (f.secret) secrets[f.key] = 'demo'
    else fields[f.key] = f.key === 'host' ? '192.0.2.40' : 'demo'
  }
  const id = CONNECTION_PREFIX + target.id
  const res = await api(`/api/connections/${id}`, { method: 'PUT', body: JSON.stringify({ type, name: 'Demo', fields, secrets }) })
  return res.ok ? id : null
}

/** The config the capture of one widget is made with: the server's, plus one screen of its size. */
function withPreviewScreen(base: Config, target: Target): Config {
  const [w, h] = target.manifest.defaultSize
  const instanceId = INSTANCE_PREFIX + target.id
  const widgets = Object.fromEntries(Object.entries(base.widgets).filter(([id]) => !id.startsWith(INSTANCE_PREFIX)))
  widgets[instanceId] = { widgetId: target.id, showTitle: false, settings: previewSettings(target, base.connections) }
  return {
    ...base,
    widgets,
    screens: [
      ...base.screens.filter((s) => s.id !== SCREEN_ID),
      {
        id: SCREEN_ID, name: 'Preview', kind: 'device',
        // Never narrower than the bar's own clusters need, which the config check enforces even
        // with an empty bar; the capture takes the tile alone anyway.
        display: { cols: Math.max(w, MIN_COLS), rows: h, cell: PREVIEW_CELL_PX, autoCycleSeconds: 0 },
        nav: [],
        pages: [{ id: 'preview', name: 'Preview', items: [{ instanceId, x: 0, y: 0, w, h }] }],
      },
    ],
  }
}

function withoutPreviewScreen(config: Config): Config {
  return {
    ...config,
    widgets: Object.fromEntries(Object.entries(config.widgets).filter(([id]) => !id.startsWith(INSTANCE_PREFIX))),
    screens: config.screens.filter((s) => s.id !== SCREEN_ID),
  }
}

/** Sets `"preview"` in a manifest's text, keeping the author's formatting everywhere else. */
export function setPreviewField(text: string, file: string): string {
  const json = JSON.stringify(file)
  let next: string
  if (/"preview"\s*:\s*"[^"]*"/.test(text)) next = text.replace(/("preview"\s*:\s*)"[^"]*"/, `$1${json}`)
  else next = text.replace(/("version"\s*:\s*"[^"]*"\s*,)/, `$1 "preview": ${json},`)
  try {
    if ((JSON.parse(next) as { preview?: unknown }).preview === file) return next
  } catch { /* fall through to a clean rewrite */ }
  const parsed = JSON.parse(text) as Record<string, unknown>
  return JSON.stringify({ ...parsed, preview: file }, null, 2) + '\n'
}

/** Text a widget shows while it has nothing yet: the capture waits for it to go. */
const LOADING_RE = /Loading…|Chargement…|Reconnecting|Reconnexion/i

export async function runPreview(opts: PreviewOptions): Promise<number> {
  const shipped = shippedPaths()
  if (!existsSync(join(shipped.uiDist, 'index.html'))) throw new PreviewUsageError('no built UI: run `pnpm --filter ui build` first')
  const targets = await findTargets(opts, shipped.widgetsDir)

  const require = createRequire(import.meta.url)
  let playwright: { chromium: { launch(o: object): Promise<Browser> } }
  try {
    playwright = require(process.env.PLAYWRIGHT ?? 'playwright') as typeof playwright
  } catch {
    throw new PreviewUsageError('Playwright is not installed here: set PLAYWRIGHT=<path to the playwright package> (and CHROMIUM=<executable> if its browser is missing)')
  }

  // The server: ours, in this process, or the demo server named by --url.
  let base: string
  let token: string
  let close = async (): Promise<void> => {}
  if (opts.url) {
    base = opts.url.replace(/\/$/, '')
    const port = Number(new URL(base).port) || 80
    token = (await readFile(accessTokenPath(port), 'utf8').catch(() => '')).trim()
    if (!token) throw new PreviewUsageError(`no access secret for ${base} (${accessTokenPath(port)})`)
  } else {
    const { buildApp } = await import('../app.js')
    const work = await mkdtemp(join(tmpdir(), 'fremkit-preview-'))
    const { dir: dataDir } = await prepareDemoDataDir({ configured: join(work, 'data'), liveDataDir: join(shipped.root, 'data') })
    token = generateToken()
    // A free port, chosen before the app is built: the WebSocket's origin check reads it from
    // `FREMKIT_PORT` (ws/routes.ts), and the Host check from `port`.
    const port = await freePort()
    process.env.FREMKIT_PORT = String(port)
    const app = await buildApp({
      accessToken: token, dataDir, demo: true, devicesPort: 0, port,
      widgetsDir: shipped.widgetsDir, themesDir: shipped.themesDir, uiDist: shipped.uiDist, bridgePath: shipped.bridgePath,
      wallpaperPath: join(shipped.wallpaperDir, DEFAULT_BACKGROUND),
      ...(opts.dir ? { widgetDevDir: opts.dir } : {}),
    })
    await app.listen({ port, host: '127.0.0.1' })
    base = `http://127.0.0.1:${port}`
    close = async () => { await app.close(); await rm(work, { recursive: true, force: true }) }
  }
  const api = async (path: string, init: RequestInit = {}): Promise<Response> => fetch(base + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) },
  })

  const demo = await api('/api/demo').then((r) => (r.ok ? r.json() as Promise<{ demo: boolean }> : { demo: false })).catch(() => ({ demo: false }))
  if (!demo.demo) {
    await close()
    throw new PreviewUsageError(`${base} is not a demo server: previews are only taken of invented data (pnpm demo)`)
  }
  const original = await (await api('/api/config')).json() as Config
  const catalog = await (await api('/api/widgets')).json() as { widgets: Record<string, unknown> }

  const browser = await playwright.chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) })
  let failed = 0
  const created: string[] = []
  try {
    for (const target of targets) {
      if (!catalog.widgets[target.id]) {
        console.log(`✗ ${target.id}: the server does not list it${opts.dir ? '' : ' (is it in --dir?)'}`)
        failed++
        continue
      }
      const made = await declaredConnection(api, target, original.connections)
      if (made) created.push(made)
      // The config again: it holds the connection just made, and a PUT keeps the server's list.
      const current = made ? await (await api('/api/config')).json() as Config : original
      const put = await api('/api/config', { method: 'PUT', body: JSON.stringify(withPreviewScreen(current, target)) })
      if (!put.ok) { console.log(`✗ ${target.id}: the server refused the preview screen (${put.status} ${await put.text()})`); failed++; continue }
      const result = await capture(browser, base, api, target, opts)
      if (!result.ok) { console.log(`✗ ${target.id}: ${result.error}`); failed++; continue }
      const name = opts.png ? 'preview.png' : 'preview.webp'
      const note = result.empty ? '  ! it still looked empty when captured: check the picture' : ''
      if (opts.dryRun) {
        console.log(`✓ ${target.id}: ${result.width}×${result.height} ${name}, ${result.bytes.byteLength} bytes (not written)${note}`)
        continue
      }
      await writeFile(join(target.folder, name), result.bytes)
      // A preview of the other format left behind would be packed for nothing.
      const other = join(target.folder, opts.png ? 'preview.webp' : 'preview.png')
      if (existsSync(other)) await rm(other)
      const manifestPath = join(target.folder, 'manifest.json')
      await writeFile(manifestPath, setPreviewField(await readFile(manifestPath, 'utf8'), name))
      console.log(`✓ ${target.id}: ${join(target.folder, name)}, ${result.width}×${result.height}, ${result.bytes.byteLength} bytes${note}`)
    }
  } finally {
    await browser.close()
    if (opts.url) {
      await api('/api/config', { method: 'PUT', body: JSON.stringify(withoutPreviewScreen(original)) }).catch(() => {})
      for (const id of created) await api(`/api/connections/${id}`, { method: 'DELETE' }).catch(() => {})
    }
    await close()
  }
  if (!opts.dryRun && failed < targets.length && !opts.url) {
    console.log('Rescan the widgets of a running server to see them in the library (⟳ in the admin).')
  }
  return failed === 0 ? 0 : 1
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

type Capture = { ok: true; bytes: Buffer; width: number; height: number; empty: boolean } | { ok: false; error: string }

async function capture(browser: Browser, base: string, api: (p: string, i?: RequestInit) => Promise<Response>, target: Target, opts: PreviewOptions): Promise<Capture> {
  const [w, h] = target.manifest.defaultSize
  const width = w * PREVIEW_CELL_PX
  const height = h * PREVIEW_CELL_PX
  // Room below for the bar, which the screenshot of the tile leaves out.
  const context = await browser.newContext({ viewport: { width: Math.max(w, MIN_COLS) * PREVIEW_CELL_PX, height: height + 80 }, deviceScaleFactor: PREVIEW_SCALE, locale: 'en-GB' })
  try {
    const page = await context.newPage()
    const code = await (await api('/api/auth/code', { method: 'POST' })).json() as { code?: string }
    if (!code.code) return { ok: false, error: 'the server gave no sign-in code' }
    await page.goto(`${base}/auth?code=${encodeURIComponent(code.code)}&next=${encodeURIComponent(`/?screen=${SCREEN_ID}`)}`)
    await page.waitForSelector('.frame iframe', { timeout: 15_000 })
    // Nothing behind the tile: its rounded corners come out transparent.
    await page.addStyleTag({ content: 'html, body, #app, .root, .stage { background: transparent !important } .background, .bar { display: none !important }' })
    const empty = !(await waitForData(page, opts.waitMs))
    const png = await page.locator('.frame').screenshot({ omitBackground: true, type: 'png' })
    const encoded = opts.png ? { ok: true as const, bytes: png } : await toWebp(page, png)
    if (!encoded.ok) return encoded
    if (encoded.bytes.byteLength > PREVIEW_MAX_BYTES) return { ok: false, error: `${encoded.bytes.byteLength} bytes even at the lowest quality, over ${PREVIEW_MAX_BYTES}` }
    return { ok: true, bytes: encoded.bytes, width: width * PREVIEW_SCALE, height: height * PREVIEW_SCALE, empty }
  } finally {
    await context.close()
  }
}

/**
 * Waits until the widget's frame has drawn something that is not a loading message, then
 * `settleMs` more for its transitions. False when it never got there.
 */
async function waitForData(page: Page, settleMs: number): Promise<boolean> {
  const deadline = Date.now() + 20_000
  let ready = false
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => f.url().includes('/widgets/'))
    const text = frame ? await frame.evaluate(() => (document.body ? document.body.innerText.trim() : '')).catch(() => '') : ''
    const drawn = frame ? await frame.evaluate(() => document.querySelectorAll('canvas, svg, img').length).catch(() => 0) : 0
    // The host page's socket first: a widget fed by a channel shows nothing until it is up.
    const connected = await page.evaluate(() => !document.querySelector('.banner'), null).catch(() => false)
    if (connected && (text !== '' || drawn > 0) && !LOADING_RE.test(text)) { ready = true; break }
    await page.waitForTimeout(250)
  }
  await page.waitForTimeout(settleMs)
  return ready
}

/**
 * PNG → WebP, by Chromium's own encoder: lossless first (UI is flat colour, often smallest that
 * way), then lossy at falling quality until it fits under the ceiling.
 */
async function toWebp(page: Page, png: Buffer): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  for (const quality of [1, 0.92, 0.85, 0.75, 0.6, 0.45]) {
    const dataUrl = await page.evaluate(async ({ b64, q }) => {
      // Through an <img>: the page's CSP lets `data:` images in, and no `fetch` of one.
      const img = new Image()
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = `data:image/png;base64,${b64}` })
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d')!.drawImage(img, 0, 0)
      return canvas.toDataURL('image/webp', q)
    }, { b64: png.toString('base64'), q: quality })
    if (!dataUrl.startsWith('data:image/webp')) return { ok: false, error: 'this Chromium cannot encode WebP: pass --png' }
    const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    if (bytes.byteLength <= PREVIEW_MAX_BYTES) return { ok: true, bytes }
  }
  return { ok: false, error: `over ${PREVIEW_MAX_BYTES} bytes even at the lowest quality` }
}
