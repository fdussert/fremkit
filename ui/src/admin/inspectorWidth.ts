/**
 * The inspector's width, dragged wider when a widget's settings need the room. A habit of the
 * person editing, so it is kept per browser like the folded sections, never in the config.
 */
export const INSPECTOR_MIN = 300
export const INSPECTOR_MAX = 720
/** Room the canvas keeps however wide the inspector is dragged. */
export const CANVAS_KEEPS = 480
export const INSPECTOR_STEP = 20

const KEY = 'fremkit.inspector.width'

/** A width the window can afford: never under the default, never eating the canvas. */
export function clampInspectorWidth(width: number, windowWidth: number): number {
  const max = Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, windowWidth - CANVAS_KEEPS))
  if (!Number.isFinite(width)) return INSPECTOR_MIN
  return Math.round(Math.min(max, Math.max(INSPECTOR_MIN, width)))
}

export function loadInspectorWidth(): number {
  try {
    const saved = Number(localStorage.getItem(KEY))
    return saved > 0 ? saved : INSPECTOR_MIN
  } catch { return INSPECTOR_MIN }
}

export function saveInspectorWidth(width: number): void {
  try {
    if (width === INSPECTOR_MIN) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, String(width))
  } catch { /* private window: this visit only */ }
}
