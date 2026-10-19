import { z } from 'zod'
import {
  AccentModeSchema, AdminGestureSchema, BackgroundFitSchema, HEX_COLOR_RE, MAX_NAV_WIDGETS, MAX_WIDGET_DIM,
  NavHeightSchema, NavSlotSchema, NavStyleSchema, OpacitySchema, ThemeIdSchema, WIDGET_ID_RE,
} from '../config/schema.js'

/**
 * The shape of a shared layout: a `.fremkit-layout.json` holding one page, one screen or every
 * screen, as somebody posts it for others to load.
 *
 * It is *not* a slice of `fremkit.json`. That file names connections, carries the privacy and
 * consent records, the brightness schedule's coordinates, and instance ids a user may have typed;
 * this one is built from scratch out of what describes a layout and nothing else, so a key added
 * to the config later never leaks into a shared file by default. See `export.ts` for what goes in
 * and `import.ts` for how a file from a stranger is read.
 */

export const LAYOUT_FORMAT = 'fremkit-layout'
/**
 * The version a file written today carries. A file with a higher one comes from a newer Fremkit
 * and is refused with a message saying so, rather than half-read.
 */
export const LAYOUT_VERSION = 1
/** The file name's suffix: `home.fremkit-layout.json`. */
export const LAYOUT_EXTENSION = '.fremkit-layout.json'

/** Largest background image embedded in a file, decoded. A bigger one is listed as left out. */
export const MAX_SHARED_IMAGE_BYTES = 4 * 1024 * 1024
/**
 * Largest total of embedded images, decoded. Base64 inflates it by 4/3, which keeps a whole file
 * under the 25 MB a GitHub attachment may weigh, with room to spare.
 */
export const MAX_SHARED_IMAGES_BYTES = 12 * 1024 * 1024
/** Body limit of the import route: the images at their base64 size, plus the layout itself. */
export const MAX_LAYOUT_BODY_BYTES = Math.ceil(MAX_SHARED_IMAGES_BYTES * 4 / 3) + 2 * 1024 * 1024

export const MAX_SHARED_SCREENS = 16
export const MAX_SHARED_PAGES = 50
export const MAX_SHARED_WIDGETS = 500
export const MAX_SHARED_IMAGES = 64
/** Longest page or screen name, and longest tile title. */
export const MAX_SHARED_NAME = 60
/** Settings of one widget: how many, how long a string, how deep a value. */
export const MAX_SETTING_KEYS = 64
export const MAX_SETTING_STRING = 2000
export const MAX_SETTING_ITEMS = 100
export const MAX_SETTING_DEPTH = 4

/** A widget's key inside the file: `w1`, `w2`… never the instance id it had on the author's Mac. */
export const SHARED_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
/** An image's key inside the file: `image-1.png`… never the name it was uploaded under. */
export const IMAGE_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}(?:\.[a-z0-9]{1,5})?$/

const Name = z.string().trim().min(1).max(MAX_SHARED_NAME)
const ImageKey = z.string().regex(IMAGE_KEY_RE)
const WidgetKey = z.string().regex(SHARED_KEY_RE)
const Color = z.string().regex(HEX_COLOR_RE)

/** A setting value as plain JSON, bounded so a file cannot ship a megabyte of nested arrays. */
export function isBoundedJson(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= MAX_SETTING_STRING
  if (depth >= MAX_SETTING_DEPTH) return false
  if (Array.isArray(value)) return value.length <= MAX_SETTING_ITEMS && value.every((v) => isBoundedJson(v, depth + 1))
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return entries.length <= MAX_SETTING_ITEMS && entries.every(([k, v]) => k.length <= 64 && isBoundedJson(v, depth + 1))
  }
  return false
}

const SettingsSchema = z.record(z.string().min(1).max(64), z.unknown())
  .refine((s) => Object.keys(s).length <= MAX_SETTING_KEYS && Object.values(s).every((v) => isBoundedJson(v)), {
    message: 'settings out of bounds',
  })

export const SharedBackgroundSchema = z.object({
  color: Color.optional(),
  image: ImageKey.optional(),
  fit: BackgroundFitSchema.optional(),
})
export type SharedBackground = z.infer<typeof SharedBackgroundSchema>

export const SharedWidgetSchema = z.object({
  widgetId: z.string().regex(WIDGET_ID_RE).max(64),
  title: Name.optional(),
  showTitle: z.boolean().default(true),
  bgColor: Color.optional(),
  accentColor: Color.optional(),
  accentMode: AccentModeSchema.optional(),
  background: z.object({
    image: ImageKey,
    fit: BackgroundFitSchema.optional(),
    dim: z.number().min(0).max(MAX_WIDGET_DIM).optional(),
  }).optional(),
  opacity: OpacitySchema.optional(),
  settings: SettingsSchema.default({}),
})
export type SharedWidget = z.infer<typeof SharedWidgetSchema>

export const SharedPlacementSchema = z.object({
  widget: WidgetKey,
  x: z.number().int().min(0).max(1000),
  y: z.number().int().min(0).max(1000),
  w: z.number().int().min(1).max(1000),
  h: z.number().int().min(1).max(1000),
  locked: z.boolean().optional(),
})
export type SharedPlacement = z.infer<typeof SharedPlacementSchema>

export const SharedPageSchema = z.object({
  name: Name,
  items: z.array(SharedPlacementSchema).max(MAX_SHARED_WIDGETS).default([]),
  background: SharedBackgroundSchema.optional(),
})
export type SharedPage = z.infer<typeof SharedPageSchema>

export const SharedNavItemSchema = z.object({
  widget: WidgetKey,
  slot: NavSlotSchema.default('left'),
  popup: z.boolean().optional(),
})

/**
 * A screen's grid and look. Not its brightness — the day/night schedule carries the author's
 * coordinates, and a level suits one panel in one room — and not anything naming a device.
 */
export const SharedDisplaySchema = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  cell: z.number().int().min(1).max(1000).default(40),
  autoCycleSeconds: z.number().int().min(0).max(86400).default(0),
  navHeight: NavHeightSchema.optional(),
  navStyle: NavStyleSchema.optional(),
  navOpacity: OpacitySchema.optional(),
  tileOpacity: OpacitySchema.optional(),
  adminGesture: AdminGestureSchema.optional(),
  background: SharedBackgroundSchema.optional(),
  orientation: z.enum(['landscape', 'portrait']).optional(),
  viewport: z.object({ width: z.number().int().min(1).max(10000), height: z.number().int().min(1).max(10000) }).optional(),
})
export type SharedDisplay = z.infer<typeof SharedDisplaySchema>

export const SharedScreenSchema = z.object({
  name: Name,
  kind: z.enum(['edge', 'device']),
  display: SharedDisplaySchema,
  nav: z.array(SharedNavItemSchema).max(MAX_NAV_WIDGETS).default([]),
  pages: z.array(SharedPageSchema).min(1).max(MAX_SHARED_PAGES),
})
export type SharedScreen = z.infer<typeof SharedScreenSchema>

/** Where a widget comes from, so whoever loads the file knows whether it ships or has to be installed. */
export const SharedSourceSchema = z.enum(['builtin', 'sietch', 'local'])
export type SharedSource = z.infer<typeof SharedSourceSchema>

/**
 * An embedded image, base64; or the wallpaper every install ships, named rather than copied.
 * The type is not trusted: the bytes are checked on import as an upload is.
 */
export const SharedImageSchema = z.union([
  z.object({ shipped: z.literal(true) }),
  z.object({ data: z.string().min(1).max(Math.ceil(MAX_SHARED_IMAGE_BYTES * 4 / 3) + 4) }),
])
export type SharedImage = z.infer<typeof SharedImageSchema>

export const LayoutScopeSchema = z.enum(['page', 'screen', 'setup'])
export type LayoutScope = z.infer<typeof LayoutScopeSchema>

export const LayoutFileSchema = z.object({
  format: z.literal(LAYOUT_FORMAT),
  version: z.literal(LAYOUT_VERSION),
  /** The Fremkit that wrote it, for the message a too-new file gets. Informative only. */
  fremkit: z.string().max(32).optional(),
  scope: LayoutScopeSchema,
  /** The theme the author used, and the night one if they had a schedule. Never the schedule itself. */
  theme: z.object({ day: ThemeIdSchema, night: ThemeIdSchema.optional() }).optional(),
  widgets: z.record(WidgetKey, SharedWidgetSchema)
    .refine((w) => Object.keys(w).length <= MAX_SHARED_WIDGETS, { message: 'too many widgets' }),
  /** Per widget id: the version the author had, and where it came from. */
  catalog: z.record(z.string().regex(WIDGET_ID_RE).max(64), z.object({
    version: z.string().max(40),
    source: SharedSourceSchema,
  })).default({}),
  screens: z.array(SharedScreenSchema).min(1).max(MAX_SHARED_SCREENS),
  images: z.record(ImageKey, SharedImageSchema)
    .refine((i) => Object.keys(i).length <= MAX_SHARED_IMAGES, { message: 'too many images' })
    .default({}),
})
  .refine((f) => f.scope === 'setup' || f.screens?.length === 1, { message: 'a page or a screen file holds one screen' })
  // Refinements run even when a member failed, hence the guarded reads.
  .refine((f) => f.scope !== 'page' || (f.screens?.[0]?.pages?.length === 1 && f.screens[0].nav?.length === 0), {
    message: 'a page file holds one page and no bar',
  })
export type LayoutFile = z.infer<typeof LayoutFileSchema>

/** A file name from what the file holds: `home.fremkit-layout.json`, `fremkit-setup.fremkit-layout.json`. */
export function layoutFilename(name: string): string {
  const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '')
  return `${slug || 'fremkit'}${LAYOUT_EXTENSION}`
}
