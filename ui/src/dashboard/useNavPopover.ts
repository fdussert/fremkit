import { onUnmounted, ref, type Ref } from 'vue'
import type { NavWidget } from '../shared/types'
import type { Anchor } from '../shared/popover'

/** How long a popover stays up with nothing touching it. */
export const POPOVER_TIMEOUT_MS = 15000

/** The popover currently up: which bar widget opened it, and where it hangs from. */
export interface OpenPopover {
  widget: NavWidget
  anchor: Anchor
  /** The box the popover must stay inside, in the same space as `anchor`. */
  screen: { width: number; height: number }
}

/**
 * Where the popover is drawn: the viewport for the dashboard, the (scaled) board for the admin's
 * preview. `project` maps the compact frame's on-screen rect into that space and says how big it
 * is; the default is the viewport, one to one.
 */
export interface PopoverHost {
  project?: (rect: DOMRect) => { anchor: Anchor; screen: { width: number; height: number } }
}

const viewportProject = (rect: DOMRect) => ({
  anchor: { left: rect.left, width: rect.width, top: rect.top },
  screen: { width: window.innerWidth, height: window.innerHeight },
})

/**
 * The single popover of one screen: opening, closing and its idle timeout. Only one is ever up,
 * so a second bar widget tapped while another is open simply replaces it.
 *
 * It closes on a second tap on the same compact frame, on a tap anywhere outside it, and 15 s
 * after it opened. The window listener is capture-phase so it runs before anything in the page,
 * but it only closes the popover for taps landing outside both the popover and the frame that
 * opened it — a tap on the widget inside still reaches the widget. Taps inside the widget's own
 * iframe never reach this document at all (it is sandboxed into an opaque origin), which is
 * exactly what keeps them from closing the popover; they cannot restart the timer either.
 */
export function useNavPopover(host: PopoverHost = {}) {
  const project = host.project ?? viewportProject
  const open = ref<OpenPopover | null>(null) as Ref<OpenPopover | null>
  /** The compact frame the open popover belongs to: a tap on it is the frame's, not an outside one. */
  let anchorEl: Element | null = null
  /** The popover's own root, once it is mounted: a tap inside it keeps the popover up. */
  let popoverEl: Element | null = null
  let timer: number | undefined

  function disarm(): void {
    window.clearTimeout(timer)
    timer = undefined
  }
  /** Restart the idle countdown; called on opening and on every tap the popover itself sees. */
  function keepAlive(): void {
    disarm()
    timer = window.setTimeout(close, POPOVER_TIMEOUT_MS)
  }
  function close(): void {
    disarm()
    open.value = null
    anchorEl = null
    popoverEl = null
    window.removeEventListener('pointerdown', onWindowPointerDown, true)
  }
  function onWindowPointerDown(e: PointerEvent): void {
    const target = e.target as Node | null
    if (target && (popoverEl?.contains(target) || anchorEl?.contains(target))) {
      // Inside the popover, or on the frame that opened it (whose own handler decides): keep it up.
      keepAlive()
      return
    }
    close()
  }

  /** A tap on a compact frame: opens its popover, or closes it if that one is already up. */
  function toggle(widget: NavWidget, el: Element): void {
    if (open.value?.widget.instanceId === widget.instanceId) { close(); return }
    const { anchor, screen } = project(el.getBoundingClientRect())
    anchorEl = el
    popoverEl = null
    open.value = { widget, anchor, screen }
    keepAlive()
    window.addEventListener('pointerdown', onWindowPointerDown, true)
  }

  /** The mounted popover reports its root element, so taps inside it can be told apart. */
  function setPopoverEl(el: Element | null): void { popoverEl = el }

  onUnmounted(close)

  return { open, toggle, close, keepAlive, setPopoverEl }
}

export type NavPopoverController = ReturnType<typeof useNavPopover>
