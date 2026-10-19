/**
 * Writing a widget: the author's folder, and the watcher that reloads a widget when it is saved.
 *
 * Off unless the server is started with `FREMKIT_WIDGET_DEV=1` (`pnpm dev` exports it). The app
 * never sets it, so a shipped Fremkit neither reads an author's folder nor watches anything.
 *
 * The folder is `<dataDir>/widgets-dev` unless `FREMKIT_WIDGET_DEV_DIR` names another — a clone
 * of the registry's `widgets/`, typically, so the widget is written where its pull request will
 * come from. Not `<dataDir>/widgets`: that one is the marketplace's, written by the installer and
 * by nothing else, and a widget there with no consent record is granted nothing at all. Not the
 * checkout's `widgets/` either: that is the built-ins, and a new widget belongs to the registry.
 */

import { watch as fsWatch } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { WIDGET_ID_RE } from '../config/schema.js'

/** The channel the dashboard and the admin hear "these widgets changed on disk" on. */
export const WIDGET_DEV_CHANNEL = 'widget-dev'

/** How long a save has to be quiet before the reload goes out. Editors write in bursts. */
export const WIDGET_DEV_DEBOUNCE_MS = 150
/** The longest a reload waits while something keeps writing, so a busy build still shows. */
export const WIDGET_DEV_MAX_WAIT_MS = 1000

/**
 * The author's folder for this environment, or undefined when widget development is off.
 * Throws on a relative `FREMKIT_WIDGET_DEV_DIR`, like `FREMKIT_DATA_DIR`: relative to what the
 * process happened to start in is not a place.
 */
export function widgetDevDir(env: NodeJS.ProcessEnv, dataDir: string): string | undefined {
  if (env.FREMKIT_WIDGET_DEV !== '1') return undefined
  return authorWidgetsDir(env, dataDir)
}

/**
 * The author's folder whether or not this process reads it: `pnpm widget:new` writes there for
 * the server that will. Same rules as `widgetDevDir`.
 */
export function authorWidgetsDir(env: NodeJS.ProcessEnv, dataDir: string): string {
  const custom = env.FREMKIT_WIDGET_DEV_DIR
  if (custom) {
    if (!isAbsolute(custom)) throw new Error(`FREMKIT_WIDGET_DEV_DIR must be an absolute path, got ${custom}`)
    return custom
  }
  return join(dataDir, 'widgets-dev')
}

/** One file event, as far as a reload cares: which widget, and whether its catalogue entry moved. */
export interface WidgetChange {
  id: string
  /** The manifest changed, or the folder itself appeared or went: the catalogue must be read again. */
  manifest: boolean
}

/** What the dashboard and the admin are told: reload these widgets, after a rescan if `manifest`. */
export interface WidgetReload {
  ids: string[]
  manifest: boolean
}

/**
 * Names an editor writes beside a file while saving it: Vim's `4913` probe and `.swp`, Emacs's
 * `#lock#`, the `~` backup most editors leave. None of them is the widget.
 */
function isEditorScratch(name: string): boolean {
  return name.endsWith('~') || name.startsWith('#') || /^\d+$/.test(name)
    || /\.(swp|swx|swo|tmp|crdownload)$/i.test(name)
}

/**
 * Turns a path relative to a watched root into the change it means, or null when it means none.
 *
 * The first segment is the widget's folder and must be a widget id — `.DS_Store` at the root,
 * the installer's `.tmp-…` staging folder and an `<id>.bak` are not. A dotted segment anywhere
 * below (`.git`, `.DS_Store`) is the author's tooling, never served, never reloaded for.
 */
export function classifyChange(filename: string | null | undefined): WidgetChange | null {
  if (!filename) return null
  const parts = filename.split(/[\\/]+/).filter((p) => p !== '')
  if (parts.length === 0) return null
  const [id] = parts
  if (!WIDGET_ID_RE.test(id)) return null
  if (parts.some((p) => p.startsWith('.'))) return null
  if (isEditorScratch(parts[parts.length - 1])) return null
  // The folder itself: a widget created, renamed or deleted, which only a rescan can tell apart.
  if (parts.length === 1) return { id, manifest: true }
  return { id, manifest: parts.length === 2 && parts[1] === 'manifest.json' }
}

export interface Timers {
  setTimeout(cb: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realTimers: Timers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/**
 * Gathers the changes of one save into one reload.
 *
 * Trailing debounce, with a ceiling: every change pushes the flush back by `delayMs`, but never
 * further than `maxWaitMs` after the first one, so a tool that writes continuously still gets
 * its widget reloaded.
 */
export class ChangeBatcher {
  private ids = new Set<string>()
  private manifest = false
  private timer: unknown = undefined
  private firstAt: number | null = null

  constructor(
    private readonly flush: (reload: WidgetReload) => void,
    private readonly delayMs = WIDGET_DEV_DEBOUNCE_MS,
    private readonly maxWaitMs = WIDGET_DEV_MAX_WAIT_MS,
    private readonly timers: Timers = realTimers,
    private readonly now: () => number = Date.now,
  ) {}

  add(change: WidgetChange): void {
    this.ids.add(change.id)
    this.manifest ||= change.manifest
    const now = this.now()
    this.firstAt ??= now
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
    const wait = Math.max(0, Math.min(this.delayMs, this.firstAt + this.maxWaitMs - now))
    this.timer = this.timers.setTimeout(() => this.fire(), wait)
  }

  /** Drops whatever is pending: the server is closing and nobody is listening. */
  cancel(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
    this.reset()
  }

  private fire(): void {
    const reload: WidgetReload = { ids: [...this.ids].sort(), manifest: this.manifest }
    this.reset()
    this.flush(reload)
  }

  private reset(): void {
    this.ids.clear()
    this.manifest = false
    this.timer = undefined
    this.firstAt = null
  }
}

/** Starts watching `dir` recursively; `onChange` gets each event's path relative to it. */
export type WatchFn = (dir: string, onChange: (filename: string | null) => void, onError: (error: Error) => void) => { close(): void }

const realWatch: WatchFn = (dir, onChange, onError) => {
  const watcher = fsWatch(dir, { recursive: true }, (_event, filename) => onChange(filename === null ? null : String(filename)))
  watcher.on('error', onError)
  return watcher
}

export interface WidgetDevWatcherOptions {
  /** The folders whose `<id>/…` files are watched: the author's, and the checkout's built-ins. */
  roots: string[]
  /** Called once per batch; a rejection is logged, never thrown into the watcher. */
  onReload: (reload: WidgetReload) => void | Promise<void>
  onError?: (error: Error) => void
  watch?: WatchFn
  batcher?: (flush: (reload: WidgetReload) => void) => ChangeBatcher
}

/** Watches widget folders and reports each save as one batched reload. */
export class WidgetDevWatcher {
  private watchers: { close(): void }[] = []
  private readonly batcher: ChangeBatcher

  constructor(private readonly opts: WidgetDevWatcherOptions) {
    const flush = (reload: WidgetReload): void => {
      Promise.resolve()
        .then(() => opts.onReload(reload))
        .catch((error: unknown) => opts.onError?.(error as Error))
    }
    this.batcher = opts.batcher ? opts.batcher(flush) : new ChangeBatcher(flush)
  }

  start(): void {
    const watch = this.opts.watch ?? realWatch
    for (const root of this.opts.roots) {
      try {
        this.watchers.push(watch(root, (filename) => this.onEvent(filename), (error) => this.opts.onError?.(error)))
      } catch (error) {
        // A root that is not there (a checkout with no `widgets/`) is not worth refusing to start.
        this.opts.onError?.(error as Error)
      }
    }
  }

  /** Public for the tests, which feed it paths rather than touching a disk. */
  onEvent(filename: string | null): void {
    const change = classifyChange(filename)
    if (change) this.batcher.add(change)
  }

  close(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    this.batcher.cancel()
  }
}
