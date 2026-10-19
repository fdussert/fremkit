/**
 * Configs the tests start from. Each one is a whole, valid version-4 config: the fixture writes
 * the first one to disk before the server starts and PUTs the others through `/api/config`, which
 * validates them like any save from the admin.
 */

export interface Placement { instanceId: string; x: number; y: number; w: number; h: number; locked?: boolean }
export interface PageSeed { id: string; name: string; items: Placement[]; background?: { color?: string; image?: string } }
export interface ScreenSeed {
  id: string
  name: string
  kind: 'edge' | 'device'
  display: Record<string, unknown>
  nav: { instanceId: string; slot: 'left' | 'right' }[]
  pages: PageSeed[]
}
export interface ConfigSeed {
  version: 4
  theme?: string
  themeSchedule?: Record<string, unknown>
  connections: unknown[]
  secrets: { backend: 'file' }
  locale: 'en'
  widgets: Record<string, { widgetId: string; showTitle: boolean; settings: Record<string, unknown>; title?: string; opacity?: number }>
  screens: ScreenSeed[]
}

/** The Edge's grid: 64 × 16 cells of 40 px under an 80 px bar. */
export const EDGE_DISPLAY = { cols: 64, rows: 16, cell: 40, autoCycleSeconds: 0 }

/** One Edge, one page, one clock. The state every test starts from unless it says otherwise. */
export function baseConfig(): ConfigSeed {
  return {
    version: 4,
    connections: [],
    // Never the keychain: see server.ts.
    secrets: { backend: 'file' },
    locale: 'en',
    widgets: { 'clock-1': { widgetId: 'clock', showTitle: true, settings: {} } },
    screens: [{
      id: 'edge', name: 'Xeneon Edge', kind: 'edge', display: { ...EDGE_DISPLAY }, nav: [],
      pages: [{ id: 'home', name: 'Home', items: [{ instanceId: 'clock-1', x: 0, y: 0, w: 16, h: 4 }] }],
    }],
  }
}

/** A device screen beside the Edge, for anything that crosses screens. */
export function deviceScreen(id = 'desk', name = 'Desk'): ScreenSeed {
  return {
    id, name, kind: 'device',
    display: { cols: 24, rows: 14, cell: 40, autoCycleSeconds: 0, orientation: 'landscape', viewport: { width: 1024, height: 768 } },
    nav: [],
    pages: [{ id: 'main', name: 'Main', items: [] }],
  }
}

/** HH:MM, `minutes` from now, in this machine's local time: what a fixed schedule reads. */
export function clockIn(minutes: number, now = new Date()): string {
  const at = new Date(now.getTime() + minutes * 60_000)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
