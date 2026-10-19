/**
 * The admin's experimental features: what is hidden until `config.labs` turns it on, and the
 * gesture that shows the switches.
 *
 * Today that is the browser companion and its Fremplay widget, behind `labs.companion`. A feature
 * added later is one key in `LabsSchema` (server) and one checkbox in Settings → About. The
 * switches sit there and appear after the version number is clicked seven times, the way a
 * phone's developer options do.
 */
import { ref } from 'vue'
import type { Config, WidgetManifest } from '../shared/types'
import type { DeviceStatus } from '../shared/api'
import { COMPANION_WIDGETS } from '../shared/companionGate'

/**
 * True when the browser companion is shown: the pairing request in the Devices pane, Fremplay in
 * the widget lists, and the pairing prompt on the Edge. The extension rows show while one is paired
 * whatever this says (`showsExtensions`). Off is also Fremplay off: the server refuses shares and
 * pairing with it (docs/companion.md), as a product switch. The companion routes, the socket's
 * challenge and the `companion` channel's refusal to paired devices hold either way.
 */
export function labsCompanion(config: Config | null | undefined): boolean {
  return config?.labs?.companion === true
}

/** The built-in widgets that belong to the companion, kept out of the widget lists while it is off. */
export { COMPANION_WIDGETS } from '../shared/companionGate'

/**
 * Whether a widget is offered to place (the library, the bar's list, the palette). Fremplay is
 * left out while `labs.companion` is off; one already placed stays where it is, greyed on the
 * canvas and not drawn on the dashboard (`shared/companionGate.ts`).
 */
export function widgetOffered(config: Config | null | undefined, widgetId: string): boolean {
  return labsCompanion(config) || !COMPANION_WIDGETS.includes(widgetId)
}

/** The catalogue's manifests a widget list offers, per `widgetOffered`. */
export function offeredManifests(config: Config | null | undefined, manifests: Record<string, WidgetManifest>): WidgetManifest[] {
  return Object.values(manifests).filter((m) => widgetOffered(config, m.id))
}

/** True when a browser extension is paired, whatever `labs.companion` says. */
export function extensionsPaired(status: DeviceStatus | null | undefined): boolean {
  return (status?.devices ?? []).some((d) => d.kind === 'extension')
}

/**
 * The browser extension part of the Devices pane: shown with `labs.companion` on, and whenever an
 * extension is paired whatever the flag says — its row is where it is renamed and removed. The
 * pairing request card inside it shows only with the flag on (`labsCompanion`).
 */
export function showsExtensions(config: Config | null | undefined, status: DeviceStatus | null | undefined): boolean {
  return labsCompanion(config) || extensionsPaired(status)
}

/** Clicks on the version that reveal the switch. */
export const REVEAL_TAPS = 7
/** All of them within this long of the first one; a slower series starts over. */
export const REVEAL_WINDOW_MS = 4000

/**
 * Whether the switch has been revealed in this admin session. Module-level so it survives the
 * inspector being closed and opened again; a reload hides it again unless the flag is on.
 */
const revealed = ref(false)

let taps = 0
let firstAt = 0

/**
 * One click on the version. Answers true on the click that reveals the switch, and only then:
 * clicks after it, or while it is already shown, change nothing.
 */
export function tapVersion(now: number = Date.now()): boolean {
  if (revealed.value) return false
  if (taps === 0 || now - firstAt > REVEAL_WINDOW_MS) {
    taps = 0
    firstAt = now
  }
  taps += 1
  if (taps < REVEAL_TAPS) return false
  taps = 0
  revealed.value = true
  return true
}

/**
 * The switches are shown once revealed, and always while any flag is on, so it can be turned off.
 * Reads every key of `config.labs`, so a flag added later needs nothing here.
 */
export function labsShown(config: Config | null | undefined): boolean {
  return revealed.value || Object.values(config?.labs ?? {}).some((on) => on === true)
}

/** Back to a fresh session: for tests. */
export function resetLabsReveal(): void {
  revealed.value = false
  taps = 0
  firstAt = 0
}
