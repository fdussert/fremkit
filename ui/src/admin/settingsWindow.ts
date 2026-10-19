import { ref } from 'vue'
import { fold, matchesQuery } from './library'

/**
 * The settings window: a sidebar of panes, the selected screen's first, then the app's.
 *
 * It used to be one long "Screen" panel mixing what belongs to the screen being edited (its
 * layout, its bar, its background) with what belongs to the whole app (the language, the theme,
 * the backups, the privacy switches), so a setting was found by scrolling past the others. The
 * panes say which is which, and the search finds a setting without knowing where it lives.
 */
export type SettingsPane = 'screen' | 'general' | 'appearance' | 'share' | 'history' | 'privacy' | 'devices' | 'about'

/** The app-wide panes, in the sidebar's order, under the screens. */
export const APP_PANES: readonly { id: Exclude<SettingsPane, 'screen'>; icon: string }[] = [
  { id: 'general', icon: 'settings' },
  { id: 'appearance', icon: 'palette' },
  { id: 'share', icon: 'share-2' },
  { id: 'history', icon: 'history' },
  { id: 'privacy', icon: 'shield' },
  { id: 'devices', icon: 'tablet' },
  { id: 'about', icon: 'info' },
]

export const paneLabel = (pane: SettingsPane): string => `admin.settings.pane.${pane}`

/**
 * What the search reads: every block of every pane, by its id (a `BaseSection` id, or a
 * `SettingsBlock` id for the few blocks that do not fold), its title and its fields' labels, as
 * dictionary keys. A field added to a pane gets its label here, or the search will not find it;
 * `settings.test.ts` checks every key exists in both languages.
 *
 * `title` is set only for the blocks that fold: those are what "expand all" acts on.
 */
export interface SettingsEntry {
  pane: SettingsPane
  id: string
  title?: string
  labels: readonly string[]
}

export const SETTINGS_INDEX: readonly SettingsEntry[] = [
  { pane: 'screen', id: 'screen.name', labels: ['admin.inspector.screen.name', 'admin.inspector.screen.remove'] },
  {
    pane: 'screen', id: 'screen.layout', title: 'admin.inspector.screen.layout',
    labels: ['admin.inspector.screen.grid', 'admin.inspector.screen.area', 'admin.inspector.screen.orientation',
      'admin.inspector.screen.viewport', 'admin.inspector.screen.navHeight', 'admin.inspector.screen.navStyle',
      'admin.inspector.screen.adminGesture', 'admin.inspector.screen.navOpacity', 'admin.inspector.screen.tileOpacity',
      'admin.inspector.screen.autoCycle'],
  },
  { pane: 'screen', id: 'screen.navWidgets', title: 'admin.inspector.screen.navWidgets', labels: [] },
  {
    pane: 'screen', id: 'screen.background', title: 'admin.inspector.screen.background',
    labels: ['admin.inspector.screen.color', 'admin.background.image', 'admin.background.fit'],
  },
  {
    pane: 'screen', id: 'screen.brightness', title: 'brightness.admin.title',
    labels: ['brightness.admin.level', 'brightness.admin.dayNight', 'brightness.admin.followMac'],
  },
  { pane: 'screen', id: 'screen.kiosk', title: 'admin.inspector.screen.kiosk', labels: ['admin.inspector.screen.kioskUrl'] },
  { pane: 'general', id: 'general.language', labels: ['admin.inspector.screen.language'] },
  {
    pane: 'appearance', id: 'appearance.theme',
    labels: ['admin.inspector.screen.theme', 'admin.inspector.screen.theme.night', 'admin.inspector.screen.theme.nightTheme'],
  },
  {
    pane: 'share', id: 'screen.share', title: 'admin.share.section',
    labels: ['admin.share.exportSetup', 'admin.share.exportScreen', 'admin.share.import'],
  },
  { pane: 'history', id: 'screen.history', title: 'admin.inspector.screen.history', labels: ['admin.palette.history'] },
  {
    pane: 'history', id: 'screen.backup', title: 'admin.inspector.screen.backup',
    labels: ['admin.inspector.screen.backup.download', 'admin.inspector.screen.backup.restore'],
  },
  {
    pane: 'privacy', id: 'screen.privacy', title: 'admin.inspector.screen.privacy',
    labels: ['admin.inspector.screen.claudeUsage', 'admin.inspector.screen.accountEmail', 'admin.inspector.screen.codexAccount',
      'admin.inspector.screen.codexSources', 'admin.inspector.screen.macmonTemperature'],
  },
  {
    pane: 'devices', id: 'screen.devices', title: 'admin.inspector.screen.devices',
    labels: ['admin.devices.enable', 'admin.devices.removeAll', 'admin.devices.resetCertificate'],
  },
  {
    pane: 'about', id: 'screen.about', title: 'admin.inspector.screen.about',
    labels: ['admin.inspector.screen.about.source', 'admin.inspector.screen.about.sietch', 'admin.inspector.screen.about.diagnostics'],
  },
]

/** The pane a block lives in; null for an id that is not the settings window's (`widget.*`, `page.*`). */
export function paneOfSection(id: string): SettingsPane | null {
  return SETTINGS_INDEX.find((e) => e.id === id)?.pane ?? null
}

/** The blocks of a pane that fold, for its "expand all": none when there is only one. */
export function foldableSections(pane: SettingsPane): string[] {
  const ids = SETTINGS_INDEX.filter((e) => e.pane === pane && e.title).map((e) => e.id)
  return ids.length > 1 ? ids : []
}

/**
 * The blocks a query finds, by pane, in the sidebar's order; null for an empty query.
 *
 * A block matches when every word typed appears in its pane's name, its title or one of its
 * labels, accents ignored — "opacite" finds "Opacité de la barre", "kiosque" the Kiosk block in
 * French. Placeholders (`{percent}`) are not words anybody types, so they are left out.
 */
export function searchSettings(query: string, t: (key: string) => string): Map<SettingsPane, Set<string>> | null {
  if (!fold(query).trim()) return null
  const text = (key: string): string => t(key).replace(/\{\w+\}/g, '')
  const found = new Map<SettingsPane, Set<string>>()
  for (const pane of ['screen', ...APP_PANES.map((p) => p.id)] as SettingsPane[]) {
    for (const entry of SETTINGS_INDEX.filter((e) => e.pane === pane)) {
      const parts = [text(paneLabel(pane)), ...(entry.title ? [text(entry.title)] : []), ...entry.labels.map(text)]
      if (!matchesQuery(parts, query)) continue
      const set = found.get(pane) ?? new Set<string>()
      set.add(entry.id)
      found.set(pane, set)
    }
  }
  return found
}

/** The pane on show. Kept for the visit, like a window that reopens where it was left. */
export const settingsPane = ref<SettingsPane>('screen')
/** What the window's search box holds; cleared whenever the window is opened on a given pane. */
export const settingsQuery = ref('')

/** Opens the settings window, on `pane` when one is named, else where it was left. */
export function openSettings(s: { openModal(name: 'settings'): void }, pane?: SettingsPane): void {
  if (pane) {
    settingsPane.value = pane
    settingsQuery.value = ''
  }
  s.openModal('settings')
}

/**
 * Brings the pane holding block `id` up, for a reveal ("Navigation bar settings…", "Copy
 * diagnostics…"). Clears the search, which could be hiding it. False for an id of another panel.
 */
export function showSettingsSection(id: string): boolean {
  const pane = paneOfSection(id)
  if (!pane) return false
  settingsPane.value = pane
  settingsQuery.value = ''
  return true
}
