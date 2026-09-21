import { ref } from 'vue'

/**
 * A two-tap confirmation, in the page.
 *
 * `window.confirm` is what the admin used to ask "delete this?", and inside the kiosk's web
 * view a native dialog never shows: the call answers `false` at once, the button does nothing,
 * and nothing says why. Two taps do the same job without a dialog: the first arms the button
 * — it turns red and says "Confirm?" — the second, within a few seconds, does it. Anything
 * else, or the wait running out, disarms it.
 */
export interface Confirm {
  /** True while `key` is armed; the button reads "Confirm?" and wears the danger style. */
  armed(key: string): boolean
  /**
   * The button's click handler: arms `key` on the first call, runs `action` on the second.
   * Returns true when the action ran.
   */
  ask(key: string, action: () => void | Promise<void>): boolean
  /** Forgets an armed key without running anything. */
  reset(): void
}

export const CONFIRM_WINDOW_MS = 4000

export function useConfirm(now: () => number = Date.now): Confirm {
  const key = ref<string | null>(null)
  let armedAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function reset(): void {
    key.value = null
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  return {
    armed: (k) => key.value === k,
    ask(k, action) {
      if (key.value === k && now() - armedAt <= CONFIRM_WINDOW_MS) {
        reset()
        void action()
        return true
      }
      reset()
      key.value = k
      armedAt = now()
      timer = setTimeout(reset, CONFIRM_WINDOW_MS)
      return false
    },
    reset,
  }
}
