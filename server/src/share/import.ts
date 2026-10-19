import type { Config } from '../config/schema.js'
import { detectImageType } from '../backgrounds/routes.js'
import { tr, type Locale, type LocalizedText } from '../i18n.js'
import type { WidgetManifest } from '../widgets/manifest.js'
import type { WidgetSource } from '../widgets/catalog.js'
import {
  LAYOUT_FORMAT, LAYOUT_VERSION, LayoutFileSchema, MAX_SHARED_IMAGE_BYTES, MAX_SHARED_IMAGES_BYTES,
  type LayoutFile, type LayoutScope, type SharedBackground, type SharedSource,
} from './format.js'
import { classifySetting, stringLeaves } from './settings.js'

/** What reading a shared layout needs from the running server. */
export interface ImportDeps {
  config(): Config
  manifest(widgetId: string): WidgetManifest | undefined
  source(widgetId: string): WidgetSource | undefined
  /** The stored name of the wallpaper every install ships, which a file names rather than carries. */
  shippedBackground: string
}

/** A file that cannot be read: not a layout, from a newer Fremkit, or malformed. The message is for the user. */
export class LayoutError extends Error {
  constructor(message: string) { super(message); this.name = 'LayoutError' }
}

export type ImportWidgetStatus = WidgetSource | 'missing'

export interface ImportReport {
  scope: LayoutScope
  /** The Fremkit that wrote the file, as it says. */
  fremkit: string | null
  /** The page's or the screen's name; null for a setup. */
  name: string | null
  screens: number
  pages: number
  tiles: number
  /**
   * Every widget id the file uses. `missing` ones are not in `layout`: the admin offers to
   * install them from the Sietch, and reads the file again once they are.
   */
  widgets: { widgetId: string; version: string; source: SharedSource; status: ImportWidgetStatus; localVersion: string | null; count: number }[]
  theme: LayoutFile['theme'] | null
  /** The images the layout still references, checked. `shipped` ones are already in the library. */
  images: { key: string; bytes: number; shipped: boolean }[]
  /** The settings that point at a connection, blanked: the admin asks which of the user's to use. */
  connections: { widget: string; widgetId: string; setting: string; label: LocalizedText; connectionType: string; multiple: boolean }[]
  /** What the reading dropped, counted: settings, placements that did not fit their grid, images that were not images. */
  dropped: { settings: number; placements: number; images: number }
}

export interface ImportResult {
  /** The file as it may be applied: only widgets this Mac has, every reference resolved. */
  layout: LayoutFile
  report: ImportReport
  /** The library name of the shipped wallpaper, for the `shipped` image. */
  shippedBackground: string
}

/** One string that may contain another; used to spot a connection id the file should not know. */
const mentions = (value: unknown, ids: Set<string>): boolean => stringLeaves(value).some((s) => ids.has(s))

/**
 * Reads a layout file from somebody else. Everything in it is untrusted: the schema bounds every
 * value, settings are checked again against this Mac's manifests — whatever the author's Fremkit
 * let through — and anything pointing at a connection is blanked, here as on export, so a file
 * can never attach a widget to one of this user's accounts without them choosing it.
 */
export function readLayout(raw: unknown, deps: ImportDeps, locale?: Locale): ImportResult {
  const config = deps.config()
  const lang = locale ?? config.locale
  if (!raw || typeof raw !== 'object' || (raw as { format?: unknown }).format !== LAYOUT_FORMAT) {
    throw new LayoutError(tr(lang, 'share.notALayout'))
  }
  const version = (raw as { version?: unknown }).version
  if (typeof version === 'number' && version > LAYOUT_VERSION) {
    const by = (raw as { fremkit?: unknown }).fremkit
    throw new LayoutError(tr(lang, 'share.tooNew', { version: typeof by === 'string' ? by.slice(0, 32) : '?' }))
  }
  const parsed = LayoutFileSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new LayoutError(tr(lang, 'share.invalid', { where: issue?.path.join('.') || '—' }))
  }
  const file = structuredClone(parsed.data)
  const dropped = { settings: 0, placements: 0, images: 0 }

  // Images first: a reference to one that is not an image, or not there, is dropped with it.
  const images: ImportReport['images'] = []
  let budget = MAX_SHARED_IMAGES_BYTES
  for (const [key, image] of Object.entries(file.images)) {
    if ('shipped' in image) { images.push({ key, bytes: 0, shipped: true }); continue }
    const bytes = Buffer.from(image.data, 'base64')
    if (!bytes.length || bytes.length > MAX_SHARED_IMAGE_BYTES || bytes.length > budget || !detectImageType(bytes)) {
      delete file.images[key]
      dropped.images++
      continue
    }
    budget -= bytes.length
    images.push({ key, bytes: bytes.length, shipped: false })
  }
  const known = (bg: SharedBackground | undefined): SharedBackground | undefined => {
    if (!bg) return undefined
    const out = { ...bg }
    if (out.image && !Object.hasOwn(file.images, out.image)) { delete out.image; delete out.fit }
    return Object.keys(out).length ? out : undefined
  }

  // Widgets: the ones this Mac has are kept, their settings read again against its manifests.
  const connectionIds = new Set(config.connections.map((c) => c.id))
  const status = new Map<string, ImportWidgetStatus>()
  const connections: ImportReport['connections'] = []
  for (const [key, widget] of Object.entries(file.widgets)) {
    const manifest = deps.manifest(widget.widgetId)
    status.set(widget.widgetId, manifest ? deps.source(widget.widgetId) ?? 'builtin' : 'missing')
    if (!manifest) { delete file.widgets[key]; continue }
    const schema = manifest.settingsSchema
    const settings: Record<string, unknown> = {}
    for (const [k, value] of Object.entries(widget.settings)) {
      const field = Object.hasOwn(schema, k) ? schema[k] : undefined
      const verdict = classifySetting(field, value)
      if ((verdict === 'keep' || verdict === 'optional') && !mentions(value, connectionIds)) settings[k] = value
      // A connection setting is blanked on purpose and asked about below; it is not a loss.
      else if (verdict !== 'connection') dropped.settings++
    }
    widget.settings = settings
    for (const [k, field] of Object.entries(schema)) {
      if ((field.type === 'connection' || field.type === 'connections') && field.connectionType) {
        connections.push({ widget: key, widgetId: widget.widgetId, setting: k, label: field.label, connectionType: field.connectionType, multiple: field.type === 'connections' })
      }
    }
    if (widget.background && !Object.hasOwn(file.images, widget.background.image)) delete widget.background
  }

  // Placements: each screen's grid is checked as the config's own validation would, so a file
  // that would make the save fail is fixed here — tiles dropped and counted — rather than there.
  let pages = 0
  let tiles = 0
  for (const screen of file.screens) {
    const { cols, rows } = screen.display
    const onScreen = new Set<string>()
    const bg = known(screen.display.background)
    if (bg) screen.display.background = bg
    else delete screen.display.background
    for (const page of screen.pages) {
      const kept: typeof page.items = []
      for (const p of page.items) {
        const widget = Object.hasOwn(file.widgets, p.widget) ? file.widgets[p.widget] : undefined
        if (!widget) { if (!wasMissing(p.widget)) dropped.placements++; continue }
        const min = deps.manifest(widget.widgetId)!.minSize
        const rect = { ...p, w: Math.max(p.w, min[0]), h: Math.max(p.h, min[1]) }
        const outside = rect.x + rect.w > cols || rect.y + rect.h > rows
        const overlaps = kept.some((o) => rect.x < o.x + o.w && o.x < rect.x + rect.w && rect.y < o.y + o.h && o.y < rect.y + rect.h)
        if (onScreen.has(p.widget) || outside || overlaps) { dropped.placements++; continue }
        onScreen.add(p.widget)
        kept.push(rect)
      }
      page.items = kept
      const pbg = known(page.background)
      if (pbg) page.background = pbg
      else delete page.background
      pages++
      tiles += kept.length
    }
    screen.nav = screen.nav.filter((item) => {
      const widget = Object.hasOwn(file.widgets, item.widget) ? file.widgets[item.widget] : undefined
      if (!widget) { if (!wasMissing(item.widget)) dropped.placements++; return false }
      if (onScreen.has(item.widget) || !deps.manifest(widget.widgetId)!.compact) { dropped.placements++; return false }
      onScreen.add(item.widget)
      return true
    })
  }

  // A widget placed nowhere any more is not imported.
  const placed = new Set(file.screens.flatMap((s) => [...s.nav.map((n) => n.widget), ...s.pages.flatMap((p) => p.items.map((i) => i.widget))]))
  for (const key of Object.keys(file.widgets)) if (!placed.has(key)) delete file.widgets[key]
  // Only the images still referenced travel on.
  const referenced = new Set<string>()
  const see = (bg: { image?: string } | undefined): void => { if (bg?.image) referenced.add(bg.image) }
  for (const w of Object.values(file.widgets)) see(w.background)
  for (const s of file.screens) { see(s.display.background); for (const p of s.pages) see(p.background) }
  for (const key of Object.keys(file.images)) if (!referenced.has(key)) delete file.images[key]

  function wasMissing(key: string): boolean {
    const widgetId = parsed.data!.widgets[key]?.widgetId
    return widgetId !== undefined && status.get(widgetId) === 'missing'
  }

  const counts = new Map<string, number>()
  for (const w of Object.values(parsed.data.widgets)) counts.set(w.widgetId, (counts.get(w.widgetId) ?? 0) + 1)
  const report: ImportReport = {
    scope: file.scope,
    fremkit: file.fremkit ?? null,
    name: file.scope === 'page' ? file.screens[0].pages[0].name : file.scope === 'screen' ? file.screens[0].name : null,
    screens: file.screens.length, pages, tiles,
    widgets: [...counts].map(([widgetId, count]) => ({
      widgetId, count,
      version: parsed.data!.catalog[widgetId]?.version ?? '',
      source: parsed.data!.catalog[widgetId]?.source ?? 'local',
      status: status.get(widgetId) ?? 'missing',
      localVersion: deps.manifest(widgetId)?.version ?? null,
    })),
    theme: file.theme ?? null,
    images: images.filter((i) => Object.hasOwn(file.images, i.key)),
    connections: connections.filter((c) => Object.hasOwn(file.widgets, c.widget)),
    dropped,
  }
  return { layout: file, report, shippedBackground: deps.shippedBackground }
}
