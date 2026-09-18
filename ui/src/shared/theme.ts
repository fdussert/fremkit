import { ref, watch, type Ref } from 'vue'
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

/** Paints the theme a config names, and repaints when either the config or the catalog changes. */
export function useConfigTheme(config: Ref<Config | null>): void {
  const { themes: all } = useThemes()
  const paint = (): void => {
    applyTheme(document.documentElement, themeVariables(all.value, config.value?.display.theme))
  }
  watch([all, () => config.value?.display.theme], paint, { immediate: true })
}
