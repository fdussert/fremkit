/**
 * The admin's experimental features: what is hidden until a flag of `config.labs` turns it on,
 * and the gesture that shows the switches.
 *
 * One flag right now, `fremdev`; iPad pairing and the browser companion both shipped for everyone.
 * To add a flag:
 *
 * 1. a key in `LabsSchema` (`server/src/config/schema.ts`), `name: z.boolean().default(false)`,
 *    and the same key in `Labs` (`ui/src/shared/types.ts`);
 * 2. one entry in `LAB_FLAGS` below with its label and hint keys, both locales;
 * 3. a reader here, `config?.labs?.name === true`, for what the flag hides (as `labsFremdev`).
 *
 * PUT /api/config keeps a flag the admin does not send, a restore keeps this Mac's, and
 * `labsShown` reads every flag, so none of that needs a change. The switches sit in
 * Settings → About and appear after the version number is clicked seven times, the way a phone's
 * developer options do.
 */
import { ref } from 'vue'
import type { Config, Labs, WidgetManifest } from '../shared/types'
import { FREMDEV_WIDGET } from '../shared/fremdevGate'

/** One switch of the experimental features block in Settings → About. */
export interface LabFlag {
  key: keyof Labs
  /** Locale keys of its checkbox and the line under it. */
  label: string
  hint: string
}

/**
 * The flags Settings → About offers, in order. An entry looks like
 * `{ key: 'name', label: 'admin.inspector.screen.labs.name', hint: 'admin.inspector.screen.labs.name.hint' }`.
 */
export const LAB_FLAGS: readonly LabFlag[] = [
  { key: 'fremdev', label: 'admin.inspector.screen.labs.fremdev', hint: 'admin.inspector.screen.labs.fremdev.hint' },
]

/** `labs.fremdev`: Fremdev, the companion's development-tabs module (docs/companion.md). */
export function labsFremdev(config: Config | null | undefined): boolean {
  return config?.labs?.fremdev === true
}

/**
 * Whether a widget is offered to place (the library, the bar's list, the palette). Fremdev is left
 * out while `labs.fremdev` is off; one already placed stays where it is, greyed on the canvas and
 * not drawn on the dashboard (`shared/fremdevGate.ts`). Every other widget, Fremplay included, is
 * always offered.
 */
export function widgetOffered(config: Config | null | undefined, widgetId: string): boolean {
  return widgetId !== FREMDEV_WIDGET || labsFremdev(config)
}

/** The catalogue's manifests a widget list offers, per `widgetOffered`. */
export function offeredManifests(config: Config | null | undefined, manifests: Record<string, WidgetManifest>): WidgetManifest[] {
  return Object.values(manifests).filter((m) => widgetOffered(config, m.id))
}

/** Clicks on the version that reveal the switches. */
export const REVEAL_TAPS = 7
/** All of them within this long of the first one; a slower series starts over. */
export const REVEAL_WINDOW_MS = 4000

/**
 * Whether the switches have been revealed in this admin session. Module-level so it survives the
 * settings being closed and opened again; a reload hides them again unless a flag is on.
 */
const revealed = ref(false)

let taps = 0
let firstAt = 0

/**
 * One click on the version. Answers true on the click that reveals the switches, and only then:
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
