import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { BUILTIN_COLORS, type ThemeColors } from './color'
import type { Config, ThemeInfo, ThemesResponse } from './types'

/** The theme every config falls back to, and the one the others are layered on. */
export const BUILTIN_THEME = 'fremkit'

const themes = ref<Record<string, ThemeInfo>>({})
/** The properties painted on the host document right now, mirrored for the widget frames. */
const applied = ref<Record<string, string>>({})
const errors = ref<ThemesResponse['errors']>([])
let loading: Promise<void> | null = null

async function load(): Promise<void> {
  const res = await fetch('/api/themes')
  if (!res.ok) return
  const body = (await res.json()) as ThemesResponse
  themes.value = body.themes
  errors.value = body.errors
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
      const body = (await res.json()) as ThemesResponse
      themes.value = body.themes
      errors.value = body.errors
    },
  }
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

/** Paints the theme a config names, and repaints when either the config or the catalog changes. */
export function useConfigTheme(config: Ref<Config | null>): void {
  const { themes: all, reload } = useThemes()
  const paint = (): void => {
    const id = config.value?.display.theme
    applyTheme(document.documentElement, themeVariables(all.value, id))
    if (id && !all.value[id] && !asked.has(id)) {
      asked.add(id)
      void reload().catch(() => { /* offline: the built-in theme's own values stand */ })
    }
  }
  watch([all, () => config.value?.display.theme], paint, { immediate: true })
}
