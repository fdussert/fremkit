import type { Config, Screen, Widget } from '../config/schema.js'
import { detectImageType } from '../backgrounds/routes.js'
import { redact, type RedactionContext } from '../diagnostics/redact.js'
import { tr, type Locale, type LocalizedText } from '../i18n.js'
import { FREMKIT_VERSION } from '../version.js'
import type { WidgetManifest } from '../widgets/manifest.js'
import type { WidgetSource } from '../widgets/catalog.js'
import {
  LAYOUT_FORMAT, LAYOUT_VERSION, MAX_SHARED_IMAGE_BYTES, MAX_SHARED_IMAGES_BYTES, MAX_SHARED_NAME, layoutFilename,
  type LayoutFile, type LayoutScope, type SharedBackground, type SharedDisplay, type SharedImage, type SharedSource, type SharedWidget,
} from './format.js'
import { classifySetting, previewValue, stringLeaves } from './settings.js'

/** What building a shared layout needs from the running server. */
export interface ShareDeps {
  config(): Config
  manifest(widgetId: string): WidgetManifest | undefined
  source(widgetId: string): WidgetSource | undefined
  /** The bytes of a stored background, or null when the library no longer has it. */
  readImage(name: string): Promise<Buffer | null>
  /**
   * The values that must never leave this Mac: every connection's secrets and hosts, the names
   * the user gave connections and devices, the Mac's own names, the home folder, the account.
   */
  redaction(): Promise<RedactionContext>
  /** The wallpaper every install ships (`backgrounds/seed.ts`): named in a file, never copied. */
  shippedBackground: string
}

export interface ExportRequest {
  scope: LayoutScope
  /** The screen a page or a screen is taken from. Absent: the Edge's, else the first. */
  screenId?: string
  /** The page, for a page export. Absent: the screen's first. */
  pageId?: string
  /** Free-text settings the person ticked in the preview, as `<instanceId>:<key>`. */
  include?: string[]
}

/** Why something the dashboard has is not in the file. */
export type LeftOutReason = 'connection' | 'personal' | 'unknown' | 'invalid'

export interface ExportReport {
  scope: LayoutScope
  /** The page's, the screen's, or null for a whole setup. */
  name: string | null
  screens: number
  pages: number
  tiles: number
  widgets: { widgetId: string; name: LocalizedText; version: string; source: SharedSource; count: number }[]
  theme: LayoutFile['theme'] | null
  images: {
    embedded: { key: string; bytes: number }[]
    leftOut: { reason: 'missing' | 'tooLarge' | 'budget'; bytes?: number }[]
  }
  /** Settings that are never shared, and those the net caught. */
  removed: { instanceId: string; widget: string; key: string; label: LocalizedText; reason: LeftOutReason }[]
  /** Free-text settings, shared only when ticked. `included` says whether this file has it. */
  optional: { id: string; instanceId: string; widget: string; key: string; label: LocalizedText; preview: string; included: boolean }[]
  /** Names replaced by a neutral one, and tile titles dropped, because they matched something identifying. */
  renamed: { kind: 'page' | 'screen' | 'title'; to: string | null }[]
}

export interface ExportResult { file: LayoutFile; filename: string; report: ExportReport }

/** The export asked for something that is not there: an unknown screen or page. */
export class ShareRequestError extends Error {
  constructor(message: string) { super(message); this.name = 'ShareRequestError' }
}

/** The final net caught something the builder let through. A bug, and the file is not handed out. */
export class ShareLeakError extends Error {
  constructor(readonly path: string) { super(`refusing to export: ${path} looks identifying`); this.name = 'ShareLeakError' }
}

/** True when nothing in `value` is changed by the diagnostics redaction: nothing identifying. */
function clean(value: unknown, ctx: RedactionContext): boolean {
  return stringLeaves(value).every((s) => redact(s, ctx) === s)
}

const SOURCE: Record<WidgetSource, SharedSource> = { builtin: 'builtin', installed: 'sietch', dev: 'local' }

/** The keys of a display that describe a layout. Brightness, the device record and the rest stay home. */
const DISPLAY_KEYS = ['cols', 'rows', 'cell', 'autoCycleSeconds', 'navHeight', 'navStyle', 'navOpacity', 'tileOpacity', 'adminGesture', 'orientation', 'viewport'] as const

/** The keys of a widget that describe its look. Settings are filtered on their own. */
const LOOK_KEYS = ['showTitle', 'bgColor', 'accentColor', 'accentMode', 'opacity'] as const

/** The keys of a layout file whose values are closed vocabularies, checked by the schema rather than read. */
const STRUCTURAL = new Set(['format', 'version', 'fremkit', 'scope', 'widgetId', 'kind', 'slot', 'fit', 'accentMode',
  'navStyle', 'adminGesture', 'orientation', 'source', 'widget', 'image', 'color', 'bgColor', 'accentColor', 'day', 'night', 'data'])

/**
 * The last net: every string of the file outside the closed vocabularies — names, titles, every
 * setting value and key — goes through `redact()`. The builder already filtered each one; this
 * runs on the finished file so a field added to the format later cannot slip past unread.
 */
export function assertShareable(file: LayoutFile, ctx: RedactionContext): void {
  // `free` turns on under a widget's settings: there every key and value is read, whatever its name.
  const walk = (value: unknown, path: string, key: string, free: boolean): void => {
    if (typeof value === 'string') {
      if ((free || !STRUCTURAL.has(key)) && redact(value, ctx) !== value) throw new ShareLeakError(path)
      return
    }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`, key, free)); return }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (free && redact(k, ctx) !== k) throw new ShareLeakError(`${path}.${k}`)
        // Image bytes are base64, not text: their check is the magic-byte test on import.
        if (path === '$.images') continue
        walk(v, `${path}.${k}`, k, free || (k === 'settings' && /^\$\.widgets\.[^.]+$/.test(path)))
      }
    }
  }
  walk(file, '$', '', false)
}

/** Builds the shared layout and the report the preview shows. Reads the config as saved. */
export async function buildLayout(deps: ShareDeps, req: ExportRequest, locale?: Locale): Promise<ExportResult> {
  const config = deps.config()
  const ctx = await deps.redaction()
  const include = new Set(req.include ?? [])
  const lang = locale ?? config.locale

  const source = req.scope === 'setup'
    ? config.screens
    : [pickScreen(config, req.screenId)]
  const page = req.scope === 'page' ? pickPage(source[0], req.pageId) : null

  const report: ExportReport = {
    scope: req.scope,
    name: req.scope === 'page' ? page!.name : req.scope === 'screen' ? source[0].name : null,
    screens: source.length, pages: 0, tiles: 0, widgets: [], theme: null,
    images: { embedded: [], leftOut: [] }, removed: [], optional: [], renamed: [],
  }

  // Widgets get neutral keys in order of appearance: an instance id may be something the user typed.
  const keys = new Map<string, string>()
  const keyOf = (instanceId: string): string => {
    let key = keys.get(instanceId)
    if (!key) { key = `w${keys.size + 1}`; keys.set(instanceId, key) }
    return key
  }

  // Images: one key per stored name, embedded while the budget lasts.
  const images: Record<string, SharedImage> = {}
  const imageKeys = new Map<string, string | null>()
  let budget = MAX_SHARED_IMAGES_BYTES
  const imageOf = async (name: string | undefined): Promise<string | null> => {
    if (!name) return null
    if (imageKeys.has(name)) return imageKeys.get(name)!
    let key: string | null = null
    if (name === deps.shippedBackground) {
      key = 'fremkit-wallpaper'
      images[key] = { shipped: true }
    } else {
      const bytes = await deps.readImage(name)
      const type = bytes ? detectImageType(bytes) : null
      if (!bytes || !type) report.images.leftOut.push({ reason: 'missing' })
      else if (bytes.length > MAX_SHARED_IMAGE_BYTES) report.images.leftOut.push({ reason: 'tooLarge', bytes: bytes.length })
      else if (bytes.length > budget) report.images.leftOut.push({ reason: 'budget', bytes: bytes.length })
      else {
        budget -= bytes.length
        key = `image-${Object.keys(images).length + 1}.${type.ext}`
        images[key] = { data: bytes.toString('base64') }
        report.images.embedded.push({ key, bytes: bytes.length })
      }
    }
    imageKeys.set(name, key)
    return key
  }
  const backgroundOf = async (bg: { color?: string; image?: string; fit?: 'cover' | 'contain' } | undefined): Promise<SharedBackground | undefined> => {
    if (!bg) return undefined
    const out: SharedBackground = {}
    if (bg.color) out.color = bg.color
    const image = await imageOf(bg.image)
    if (image) { out.image = image; if (bg.fit) out.fit = bg.fit }
    return Object.keys(out).length ? out : undefined
  }

  /** A required name: kept when nothing in it identifies anyone, else a neutral one. */
  const nameOr = (name: string, kind: 'page' | 'screen', n: number): string => {
    const trimmed = name.trim().slice(0, MAX_SHARED_NAME)
    if (trimmed && clean(trimmed, ctx)) return trimmed
    const to = tr(lang, kind === 'page' ? 'share.pageName' : 'share.screenName', { n })
    report.renamed.push({ kind, to })
    return to
  }

  const screens: LayoutFile['screens'] = []
  for (const [si, screen] of source.entries()) {
    const display: Record<string, unknown> = {}
    for (const k of DISPLAY_KEYS) if (screen.display[k] !== undefined) display[k] = structuredClone(screen.display[k])
    const bg = await backgroundOf(screen.display.background)
    if (bg) display.background = bg
    const pages: LayoutFile['screens'][number]['pages'] = []
    for (const [pi, p] of (page ? [page] : screen.pages).entries()) {
      const items = p.items
        .filter((x) => Object.hasOwn(config.widgets, x.instanceId))
        .map((x) => ({ widget: keyOf(x.instanceId), x: x.x, y: x.y, w: x.w, h: x.h, ...(x.locked ? { locked: true } : {}) }))
      const pbg = await backgroundOf(p.background)
      pages.push({ name: nameOr(p.name, 'page', pi + 1), items, ...(pbg ? { background: pbg } : {}) })
      report.tiles += items.length
    }
    report.pages += pages.length
    const nav = page ? [] : screen.nav
      .filter((x) => Object.hasOwn(config.widgets, x.instanceId))
      .map((x) => ({ widget: keyOf(x.instanceId), slot: x.slot, ...(x.popup ? { popup: true } : {}) }))
    screens.push({
      name: nameOr(screen.name, 'screen', si + 1),
      kind: screen.kind,
      display: display as SharedDisplay,
      nav, pages,
    })
  }

  const widgets: Record<string, SharedWidget> = {}
  const catalog: LayoutFile['catalog'] = {}
  const counts = new Map<string, number>()
  for (const [instanceId, key] of keys) {
    const widget = config.widgets[instanceId]
    const manifest = deps.manifest(widget.widgetId)
    const label = widget.title?.trim() || (manifest ? pickName(manifest.name, lang) : widget.widgetId)
    widgets[key] = await shareWidget(widget, manifest, instanceId, label)
    counts.set(widget.widgetId, (counts.get(widget.widgetId) ?? 0) + 1)
    const from = deps.source(widget.widgetId)
    catalog[widget.widgetId] = { version: manifest?.version ?? '0.0.0', source: from ? SOURCE[from] : 'local' }
  }
  for (const [widgetId, count] of counts) {
    report.widgets.push({
      widgetId, count, version: catalog[widgetId].version, source: catalog[widgetId].source,
      name: deps.manifest(widgetId)?.name ?? widgetId,
    })
  }

  async function shareWidget(widget: Widget, manifest: WidgetManifest | undefined, instanceId: string, label: string): Promise<SharedWidget> {
    const out: SharedWidget = { widgetId: widget.widgetId, showTitle: widget.showTitle, settings: {} }
    for (const k of LOOK_KEYS) if (widget[k] !== undefined) (out as Record<string, unknown>)[k] = widget[k]
    if (widget.title !== undefined) {
      const title = widget.title.trim().slice(0, MAX_SHARED_NAME)
      if (title && clean(title, ctx)) out.title = title
      else if (title) report.renamed.push({ kind: 'title', to: null })
    }
    if (widget.background) {
      const image = await imageOf(widget.background.image)
      if (image) {
        out.background = { image }
        if (widget.background.fit) out.background.fit = widget.background.fit
        if (widget.background.dim !== undefined) out.background.dim = widget.background.dim
      }
    }
    const schema = manifest?.settingsSchema ?? {}
    for (const [key, value] of Object.entries(widget.settings)) {
      const field = Object.hasOwn(schema, key) ? schema[key] : undefined
      const fieldLabel: LocalizedText = field?.label ?? key
      const verdict = classifySetting(field, value)
      const leftOut = (reason: LeftOutReason): void => {
        // An empty value is no loss worth listing: a connection nobody chose, a cleared field.
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return
        report.removed.push({ instanceId, widget: label, key, label: fieldLabel, reason })
      }
      if (verdict === 'connection' || verdict === 'unknown' || verdict === 'invalid') { leftOut(verdict); continue }
      // Every value is read by the net, closed ones too: an enum value can still be a name.
      if (!clean({ [key]: value }, ctx)) { leftOut('personal'); continue }
      // An empty free-text field says nothing about anyone: it travels as the default it is.
      const empty = value === '' || (Array.isArray(value) && !value.length)
      if (verdict === 'optional' && !empty) {
        const id = `${instanceId}:${key}`
        const included = include.has(id)
        report.optional.push({ id, instanceId, widget: label, key, label: fieldLabel, preview: previewValue(value), included })
        if (!included) continue
      }
      out.settings[key] = structuredClone(value)
    }
    return out
  }

  const theme = config.theme
    ? { day: config.theme, ...(config.themeSchedule?.night ? { night: config.themeSchedule.night } : {}) }
    : undefined
  report.theme = theme ?? null

  const file: LayoutFile = {
    format: LAYOUT_FORMAT,
    version: LAYOUT_VERSION,
    fremkit: FREMKIT_VERSION,
    scope: req.scope,
    ...(theme ? { theme } : {}),
    widgets, catalog, screens, images,
  }
  assertShareable(file, ctx)
  const filename = layoutFilename(req.scope === 'setup' ? 'fremkit-setup' : (report.name ?? 'fremkit'))
  return { file, filename, report }
}

function pickName(name: LocalizedText, locale: Locale): string {
  if (typeof name === 'string') return name
  return name[locale] ?? name.en ?? name.fr ?? Object.values(name)[0] ?? ''
}

function pickScreen(config: Config, id: string | undefined): Screen {
  if (id === undefined) return config.screens.find((s) => s.kind === 'edge') ?? config.screens[0]
  const screen = config.screens.find((s) => s.id === id)
  if (!screen) throw new ShareRequestError(tr(config.locale, 'share.unknownScreen'))
  return screen
}

function pickPage(screen: Screen, id: string | undefined): Screen['pages'][number] {
  if (id === undefined) return screen.pages[0]
  const page = screen.pages.find((p) => p.id === id)
  if (!page) throw new ShareRequestError(tr(undefined, 'share.unknownPage'))
  return page
}
