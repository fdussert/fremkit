import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { BUILTIN_COLORS, type ThemeColors } from './color'
import type { Config, ThemeInfo, ThemeInForce, ThemeSchedule, ThemesResponse } from './types'

/** The theme every config falls back to, and the one the others are layered on. */
export const BUILTIN_THEME = 'fremkit'

const themes = ref<Record<string, ThemeInfo>>({})
/** The properties painted on the host document right now, mirrored for the widget frames. */
const applied = ref<Record<string, string>>({})
const errors = ref<ThemesResponse['errors']>([])
/**
 * Day or night, as the server reckons it (`server/src/themes/schedule.ts`): first from the
 * catalog's answer, then from the `theme` channel. Null until either has spoken.
 */
const inForce = ref<ThemeInForce | null>(null)
let loading: Promise<void> | null = null

function take(body: ThemesResponse): void {
  themes.value = body.themes
  errors.value = body.errors
  if (body.inForce) inForce.value = body.inForce
}

async function load(): Promise<void> {
  const res = await fetch('/api/themes')
  if (!res.ok) return
  take((await res.json()) as ThemesResponse)
}

/**
 * The themes the server found, loaded once per page and shared by everything that needs them:
 * the dashboard paints one, the admin lists them all. A failed load leaves the map empty, which
 * paints nothing — the CSS in `tokens.css` is the built-in theme's own values, so the page still
 * looks right.
 */
export function useThemes(): {
  themes: Ref<Record<string, ThemeInfo>>
  errors: Ref<ThemesResponse['errors']>
  reload: () => Promise<void>
  rescan: () => Promise<void>
} {
  if (!loading) loading = load().catch(() => { /* offline: the stylesheet defaults stand */ })
  return {
    themes,
    errors,
    reload: () => load(),
    rescan: async () => {
      const res = await fetch('/api/themes/rescan', { method: 'POST' })
      if (!res.ok) return
      take((await res.json()) as ThemesResponse)
    },
  }
}

/**
 * Keeps the page's day / night in step with the server's, live. Called once by each page that
 * paints a theme (the dashboard, the admin); `useConfigTheme` then repaints on every switch.
 */
export function followThemeSchedule(socket: { subscribe(channel: string, cb: (data: unknown) => void): () => void }): () => void {
  return socket.subscribe('theme', (data) => {
    const d = data as ThemeInForce | null
    if (d && (d.phase === 'day' || d.phase === 'night')) inForce.value = d
  })
}

/** What the server last said about day and night, for the admin's status line. */
export function useThemeInForce(): Ref<ThemeInForce | null> { return inForce }

/**
 * The theme id to paint: the night theme when the config has one and the server says it is
 * night, the config's `theme` otherwise.
 *
 * The phase comes from the server, the ids from the config this page holds: in the admin that is
 * the config being edited, so choosing another night theme at night shows at once, before the
 * save has gone through. A paired device's config carries only the night theme's id
 * (`deviceConfigView`), which is all this reads.
 */
export function themeIdInForce(
  config: { theme?: string; themeSchedule?: Pick<ThemeSchedule, 'night'> } | null | undefined,
  now: ThemeInForce | null,
): string | undefined {
  if (config?.themeSchedule && now?.phase === 'night') return config.themeSchedule.night
  return config?.theme
}

/** The custom properties of a theme, or the built-in one's when the id is unknown. */
export function themeVariables(all: Record<string, ThemeInfo>, id: string | undefined): Record<string, string> {
  return (id && all[id]?.variables) || all[BUILTIN_THEME]?.variables || {}
}

/** The properties the host is painting, for anything that has to pass them on. */
export function useAppliedTheme(): Ref<Record<string, string>> { return applied }

/**
 * A hex colour as `#rrggbb`, or null.
 *
 * The token schema accepts `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`, and everything downstream
 * of this — `luminance`, `rgb`, `fade` — reads the six-digit form only. So a theme writing
 * `#111` was read as "not a colour" and silently got the built-in fallback instead: the tile
 * rules were then judged against a surface nobody was painting.
 *
 * The alpha is dropped rather than mixed: what these colours are used for is picking a readable
 * foreground, and a translucent surface shows the page behind it — which is why the caller walks
 * a chain of tokens instead. A fully transparent one is still not a colour and falls through.
 */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(value.trim())
  if (!m) return null
  const digits = m[1]
  let rgb: string
  let alpha = 'ff'
  if (digits.length === 3 || digits.length === 4) {
    rgb = [...digits.slice(0, 3)].map((c) => c + c).join('')
    if (digits.length === 4) alpha = digits[3] + digits[3]
  } else if (digits.length === 6 || digits.length === 8) {
    rgb = digits.slice(0, 6)
    if (digits.length === 8) alpha = digits.slice(6, 8)
  } else return null
  // Fully transparent has no colour to read; the caller's fallback is the honest answer.
  if (parseInt(alpha, 16) === 0) return null
  return `#${rgb.toLowerCase()}`
}

/**
 * One custom property of the theme in force, as a colour. A token the theme leaves out — or one
 * it writes fully transparent, which has no luminance to speak of — falls back to the value
 * given.
 */
export function themeColor(variables: Record<string, string>, name: string, fallback: string): string {
  return normalizeHex(variables[name]) ?? fallback
}

/**
 * The colours the tile luminance rules are judged against. A theme that drops the tile card
 * leaves `--tile-surface` transparent, and what shows through is the page behind it, so the
 * fallback walks `--tile-surface` → `--surface` → the built-in value rather than stopping
 * at the first one it cannot read.
 */
export function useThemeColors(): ComputedRef<ThemeColors> {
  return computed(() => ({
    accent: themeColor(applied.value, '--accent', BUILTIN_COLORS.accent),
    surface: themeColor(applied.value, '--tile-surface',
      themeColor(applied.value, '--surface', BUILTIN_COLORS.surface)),
  }))
}

/**
 * Writes the properties on an element and takes back the ones the previous theme had set, so
 * switching to a theme that leaves a token out falls back to the stylesheet rather than keeping
 * the colour of the theme before it.
 */
export function applyTheme(root: HTMLElement, variables: Record<string, string>): void {
  const previous = (root.dataset.themeVars || '').split(' ').filter(Boolean)
  for (const name of previous) if (!(name in variables)) root.style.removeProperty(name)
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value)
  root.dataset.themeVars = Object.keys(variables).join(' ')
  if (root === document.documentElement) applied.value = variables
}

/**
 * Ids this page has already gone back to the server for.
 *
 * The catalog is read once per page, and a theme can appear after that: installed from the
 * registry in another tab, restored with a backup, or dropped into the folder by hand. Without
 * this the screen would paint the built-in theme until somebody reloaded it. Once per id, so an
 * id that genuinely does not exist costs one request rather than one per repaint.
 */
const asked = new Set<string>()

/** Time given to the widget frames to repaint their tokens before the new picture is taken. */
const FRAMES_SETTLE_MS = 150

type ViewTransitionDocument = Document & { startViewTransition?: (cb: () => Promise<void> | void) => unknown }

/**
 * Paints a day / night switch as a crossfade where the browser can (a view transition: one
 * snapshot of the page before, one after, faded into each other), and at once elsewhere or when
 * the user asked for less motion. The widgets are in frames that repaint a moment after the host,
 * so the "after" picture waits for them. The fade's length is in `tokens.css`.
 */
function crossfade(paint: () => void): void {
  const doc = document as ViewTransitionDocument
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!doc.startViewTransition || reduced) { paint(); return }
  doc.startViewTransition(async () => {
    paint()
    await new Promise<void>((r) => setTimeout(r, FRAMES_SETTLE_MS))
  })
}

/**
 * Paints the theme in force — the config's, or its night theme at night (`themeIdInForce`) — and
 * repaints when the config, the catalog or the day / night phase changes. A change of phase
 * crossfades; anything else (another theme picked, the catalog arriving) paints at once.
 */
export function useConfigTheme(config: Ref<Config | null>): void {
  const { themes: all, reload } = useThemes()
  let phase: ThemeInForce['phase'] | undefined
  let painted: string | undefined
  const paint = (): void => {
    const id = themeIdInForce(config.value, inForce.value)
    const switched = phase !== undefined && inForce.value?.phase !== phase && id !== painted && Object.keys(all.value).length > 0
    phase = inForce.value?.phase
    painted = id
    const draw = (): void => applyTheme(document.documentElement, themeVariables(all.value, id))
    if (switched) crossfade(draw)
    else draw()
    if (id && !all.value[id] && !asked.has(id)) {
      asked.add(id)
      void reload().catch(() => { /* offline: the built-in theme's own values stand */ })
    }
  }
  watch([all, () => themeIdInForce(config.value, inForce.value), () => inForce.value?.phase], paint, { immediate: true })
}
