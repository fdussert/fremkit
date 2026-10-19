/**
 * `pnpm widget:new <id>` and `pnpm widget:check <folder>…`, for people writing a widget.
 *
 * Run from the repository root by tsx (see the root package.json); a relative path on the command
 * line is read against the directory pnpm was started in (`INIT_CWD`), not the root.
 *
 *   pnpm widget:new my-widget [--name-en … --name-fr … --description-en … --description-fr …]
 *                             [--category info] [--size 8x4] [--channel system] [--no-compact]
 *                             [--author handle] [--dir folder] [--port 4242] [--yes]
 *   pnpm widget:check <folder> [<folder>…]
 *   pnpm widget:preview <id>… | --all [--dir <folder>] [--url <demo server>]   (see cli/preview.ts)
 *
 * `new` writes into the author's folder (`FREMKIT_WIDGET_DEV_DIR`, else `<dataDir>/widgets-dev`)
 * — never the checkout's `widgets/`, which is for built-ins — then asks a running server to
 * rescan, with the access secret read from its token file and kept out of every command line.
 */

import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'
import { shippedPaths } from '../paths.js'
import { authorWidgetsDir } from '../widgets/dev.js'
import { installedWidgetsDir } from '../widgets/installed.js'
import { WIDGET_CATEGORIES, type WidgetCategory } from '../widgets/manifest.js'
import {
  channelProblem, idProblem, isCategory, nameFromId, parseSize, PLACEHOLDER_DESCRIPTION, scaffoldWidget, type ScaffoldOptions,
} from '../widgets/scaffold.js'
import { checkWidgetFolder } from '../widgets/check.js'
import { accessTokenPath } from '../http/access-file.js'

class UsageError extends Error {}

const USAGE = `usage:
  pnpm widget:new <id> [--name-en <text>] [--name-fr <text>] [--description-en <text>]
                       [--description-fr <text>] [--category <${WIDGET_CATEGORIES.join('|')}>]
                       [--size <cols>x<rows>] [--channel <name>] [--no-compact] [--author <handle>]
                       [--dir <folder>] [--port <n>] [--yes]
  pnpm widget:check <folder> [<folder>…]
  pnpm widget:preview <id> [<id>…] | --all [--dir <folder>] [--url <demo server>] [--wait <ms>] [--png] [--dry-run]`

/** Where the user typed the command: pnpm runs the script from the root and says so here. */
const cwd = process.env.INIT_CWD || process.cwd()

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const eq = arg.indexOf('=')
    if (eq > 0) { flags.set(arg.slice(2, eq), arg.slice(eq + 1)); continue }
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (['yes', 'no-compact', 'help', 'all', 'png', 'dry-run'].includes(name) || next === undefined || next.startsWith('--')) flags.set(name, true)
    else { flags.set(name, next); i++ }
  }
  return { positional, flags }
}

function flag(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name)
  if (v === true) throw new UsageError(`--${name} needs a value`)
  return v
}

/** The data folder the server on this checkout uses: `FREMKIT_DATA_DIR`, else `<root>/data`. */
function dataDir(): string {
  const configured = process.env.FREMKIT_DATA_DIR
  if (configured && !isAbsolute(configured)) throw new UsageError(`FREMKIT_DATA_DIR must be an absolute path, got ${configured}`)
  return configured || join(shippedPaths().root, 'data')
}

/** Resolves symlinks where the path exists, so two spellings of one folder compare equal. */
function canonical(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}

/**
 * Questions on a terminal, one line each. Lines are read through the interface's iterator, which
 * queues them: an answer typed (or pasted) ahead of its question is kept rather than lost.
 */
class Prompter {
  private readonly rl = createInterface({ input: stdin, output: stdout, terminal: true })
  private readonly lines = this.rl[Symbol.asyncIterator]()

  async ask(question: string, fallback: string): Promise<string> {
    stdout.write(`${question} [${fallback}] `)
    const next = await this.lines.next()
    if (next.done) throw new UsageError('\ncancelled')
    const answer = String(next.value).trim()
    return answer === '' ? fallback : answer
  }

  close(): void { this.rl.close() }
}

async function ask(prompter: Prompter | null, question: string, fallback: string): Promise<string> {
  return prompter ? prompter.ask(question, fallback) : fallback
}

/** The ids a running server knows, valid or not, or null when none answers. */
async function serverIds(base: string, token: string | null): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${base}/api/widgets`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    const body = await res.json() as { widgets: Record<string, unknown>; errors: { id: string }[] }
    return new Set([...Object.keys(body.widgets), ...body.errors.map((e) => e.id)])
  } catch {
    return null
  }
}

/** The server's secret for `port`, as `scripts/lib/access.sh` finds it; null when there is none. */
async function readToken(port: number): Promise<string | null> {
  const file = process.env.FREMKIT_ACCESS_TOKEN_FILE || accessTokenPath(port)
  try {
    const token = (await readFile(file, 'utf8')).split('\n')[0].trim()
    return token === '' ? null : token
  } catch {
    return null
  }
}

async function commandNew(positional: string[], flags: Map<string, string | true>): Promise<number> {
  const id = positional[0]
  if (!id || positional.length > 1) throw new UsageError(USAGE)
  const problem = idProblem(id)
  if (problem) throw new UsageError(problem)

  const root = shippedPaths().root
  const builtinDir = join(root, 'widgets')
  const data = dataDir()
  const dirFlag = flag(flags, 'dir')
  const target = dirFlag ? resolve(cwd, dirFlag) : authorWidgetsDir(process.env, data)
  // The checkout's widgets/ is for what ships with Fremkit, and data/widgets is the marketplace's:
  // a new widget belongs in neither.
  if (canonical(target) === canonical(builtinDir)) {
    throw new UsageError(`${target} holds the widgets Fremkit ships; a new widget goes to the registry. Leave out --dir to use the author's folder.`)
  }
  if (canonical(target) === canonical(installedWidgetsDir(data))) {
    throw new UsageError(`${target} is written by the marketplace installer only, and a widget there is granted nothing. Leave out --dir to use the author's folder.`)
  }

  const port = Number(flag(flags, 'port') ?? process.env.FREMKIT_PORT) || 4242
  const base = `http://127.0.0.1:${port}`
  const token = await readToken(port)

  // Refused wherever the id is already taken: here, among the built-ins, among the installed
  // widgets, or in the catalogue of the server that will read it.
  const taken = [
    { dir: target, what: 'in this folder' },
    { dir: builtinDir, what: 'by a widget Fremkit ships' },
    { dir: installedWidgetsDir(data), what: 'by a widget installed from the marketplace' },
  ].find(({ dir }) => existsSync(join(dir, id)))
  if (taken) throw new UsageError(`"${id}" is already taken ${taken.what} (${join(taken.dir, id)})`)
  const known = await serverIds(base, token)
  if (known?.has(id)) throw new UsageError(`"${id}" is already a widget of the server on :${port}`)

  const interactive = flags.get('yes') !== true && stdin.isTTY === true
  const rl = interactive ? new Prompter() : null
  try {
    const nameEn = flag(flags, 'name-en') ?? await ask(rl, 'Name (English)', nameFromId(id))
    const nameFr = flag(flags, 'name-fr') ?? await ask(rl, 'Name (French)', nameEn)
    const descEn = flag(flags, 'description-en') ?? await ask(rl, 'One-line description (English)', PLACEHOLDER_DESCRIPTION.en)
    const descFr = flag(flags, 'description-fr') ?? await ask(rl, 'One-line description (French)', PLACEHOLDER_DESCRIPTION.fr)
    const category = flag(flags, 'category') ?? await ask(rl, `Category (${WIDGET_CATEGORIES.join(', ')})`, 'other')
    if (!isCategory(category)) throw new UsageError(`"${category}" is not a category: ${WIDGET_CATEGORIES.join(', ')}`)
    const sizeText = flag(flags, 'size') ?? await ask(rl, 'Size in grid cells, columns x rows (the Edge is 64 columns wide)', '8x4')
    const size = parseSize(sizeText)
    if (!size) throw new UsageError(`"${sizeText}" is not a size: write it as 8x4`)
    const channelText = flags.has('channel')
      ? flag(flags, 'channel')
      : await ask(rl, 'Data channel it reads (system, battery, … — empty for none)', '')
    const channel = channelText?.trim() || undefined
    if (channel) { const p = channelProblem(channel); if (p) throw new UsageError(p) }
    const author = flag(flags, 'author') ?? (await ask(rl, 'Your handle, shown on the card (the registry requires one)', '') || undefined)

    const options: ScaffoldOptions = {
      id,
      name: { fr: nameFr, en: nameEn },
      description: { fr: descFr, en: descEn },
      category: category as WidgetCategory,
      size,
      ...(channel ? { channel } : {}),
      ...(author ? { author } : {}),
      ...(flags.get('no-compact') === true ? {} : { compact: 4 }),
    }
    const folder = join(target, id)
    await mkdir(folder, { recursive: true })
    for (const [name, content] of Object.entries(scaffoldWidget(options))) {
      await writeFile(join(folder, name), content, { flag: 'wx' })
    }
    console.log(`Created ${folder}`)
    if (!author) console.log('  Add your handle as "author" in manifest.json before publishing: the registry refuses a widget without one.')
  } finally {
    rl?.close()
  }

  // Tell the server, if one runs. A server started without FREMKIT_WIDGET_DEV=1 does not read the
  // author's folder at all, and saying so is more use than a rescan that silently shows nothing.
  try {
    const res = await fetch(`${base}/api/widgets/rescan`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    })
    if (res.status === 401) {
      console.log(`The server on :${port} refused the rescan (no access secret found). Press ⟳ in the admin's widget library.`)
    } else if (res.ok) {
      const body = await res.json() as { widgets: Record<string, unknown>; errors: { id: string; error: string }[] }
      const error = body.errors.find((e) => e.id === id)
      if (body.widgets[id]) console.log(`The server on :${port} rescanned: "${id}" is in the admin's widget library.`)
      else if (error) console.log(`The server on :${port} refused it: ${error.error}`)
      else console.log(`The server on :${port} does not read ${target}: start one with \`pnpm dev\`, or with FREMKIT_WIDGET_DEV=1${dirFlag ? ` FREMKIT_WIDGET_DEV_DIR=${target}` : ''}.`)
    }
  } catch {
    console.log(`No server on :${port}. \`pnpm dev\` starts one that reads ${target} and reloads the widget on every save.`)
  }
  console.log(`Check it before publishing: pnpm widget:check ${join(target, id)}`)
  return 0
}

async function commandCheck(positional: string[]): Promise<number> {
  if (positional.length === 0) throw new UsageError(USAGE)
  const builtinDir = join(shippedPaths().root, 'widgets')
  let builtinIds = new Set<string>()
  try { builtinIds = new Set(await readdir(builtinDir)) } catch { /* no checkout widgets: nothing to collide with */ }
  let failed = 0
  for (const path of positional) {
    const folder = resolve(cwd, path)
    // The built-ins themselves are checked against the rules, not against their own ids.
    const own = canonical(join(folder, '..')) === canonical(builtinDir)
    const result = await checkWidgetFolder(folder, own ? {} : { builtinIds })
    const label = result.manifest ? `${result.id} ${result.manifest.version}` : result.id
    if (result.errors.length === 0) {
      console.log(`✓ ${label}: ${result.files} files, ${result.zipBytes} bytes packed`)
    } else {
      failed++
      console.log(`✗ ${label}`)
      for (const e of result.errors) console.log(`    ${e}`)
    }
    for (const w of result.warnings) console.log(`  ! ${w}`)
  }
  return failed === 0 ? 0 : 1
}

async function commandPreview(positional: string[], flags: Map<string, string | true>): Promise<number> {
  const dir = flag(flags, 'dir')
  const wait = flag(flags, 'wait')
  const waitMs = wait === undefined ? 1500 : Number(wait)
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new UsageError('--wait is a number of milliseconds')
  // Loaded only here: it pulls in the whole server, which `new` and `check` have no use for.
  const { runPreview, PreviewUsageError } = await import('./preview.js')
  try {
    return await runPreview({
      ids: positional,
      all: flags.get('all') === true,
      ...(dir ? { dir: resolve(cwd, dir) } : {}),
      ...(flag(flags, 'url') ? { url: flag(flags, 'url') } : {}),
      waitMs,
      png: flags.get('png') === true,
      dryRun: flags.get('dry-run') === true,
    })
  } catch (error) {
    if (error instanceof PreviewUsageError) throw new UsageError(error.message)
    throw error
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const { positional, flags } = parseArgs(rest)
  if (flags.has('help') || command === undefined) { console.log(USAGE); return command === undefined ? 1 : 0 }
  if (command === 'new') return commandNew(positional, flags)
  if (command === 'check') return commandCheck(positional)
  if (command === 'preview') return commandPreview(positional, flags)
  throw new UsageError(USAGE)
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code },
  (error: unknown) => {
    console.error(error instanceof UsageError ? error.message : error)
    process.exitCode = error instanceof UsageError ? 2 : 1
  },
)
