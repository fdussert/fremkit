import { watch, type Ref } from 'vue'
import type { DeviceInfo } from './remote'

/** What the page tells the device app that hosts it (the iPad's or the Android one). */
export type NativeMessage =
  | { type: 'unauthorized' }
  | { type: 'screen'; screenId: string | null }
  | { type: 'brightness'; target: number; seq: number }
  /** The user asked for the app's own settings sheet (the Android app only; see `AppSettingsMenu`). */
  | { type: 'settings' }

interface NativeWindow {
  webkit?: { messageHandlers?: { fremkit?: { postMessage(msg: unknown): void } } }
  fremkit?: unknown
}

/**
 * The Android app's listener, `window.fremkit` (a `WebMessageListener`), which takes strings only.
 * Anything else under that name is not it: a string, an element named so (`id="fremkit"`), and
 * above all a frame named `fremkit`, whose window is reachable as `window.fremkit` and has a
 * `postMessage` too. Nothing but the bridge's hello is ever posted to a frame's window.
 */
function androidHandler(win: Window): { postMessage(msg: string): void } | null {
  try {
    const candidate = (win as unknown as NativeWindow).fremkit
    if (typeof candidate !== 'object' || candidate === null) return null
    if ((candidate as { window?: unknown }).window === candidate) return null
    if (typeof Node === 'function' && candidate instanceof Node) return null
    const handler = candidate as { postMessage?: unknown }
    return typeof handler.postMessage === 'function' ? (handler as { postMessage(msg: string): void }) : null
  } catch {
    return null
  }
}

/**
 * Which device app hosts the page: the iPad's (WebKit's `fremkit` handler), the Android one
 * (`window.fremkit`, under `androidHandler`'s rules), or none in a plain browser. WebKit's first,
 * as in `nativeBridge`.
 */
export function nativePlatform(win: Window = window): 'ios' | 'android' | null {
  try {
    if ((win as unknown as NativeWindow).webkit?.messageHandlers?.fremkit) return 'ios'
  } catch {
    return null
  }
  return androidHandler(win) ? 'android' : null
}

/** The app's message handler, or null when the page runs in a plain browser. WebKit's first. */
export function nativeBridge(win: Window = window): { post(msg: NativeMessage): void } | null {
  const webkit = (win as unknown as NativeWindow).webkit?.messageHandlers?.fremkit
  if (webkit) {
    return {
      post(msg) {
        try { webkit.postMessage(msg) } catch { /* the app is gone: nothing to tell */ }
      },
    }
  }
  const android = androidHandler(win)
  if (!android) return null
  return {
    post(msg) {
      try { android.postMessage(JSON.stringify(msg)) } catch { /* the app is gone: nothing to tell */ }
    },
  }
}

/**
 * Reports to the app that the device was revoked (once), which screen it shows, and the brightness
 * target of that screen (once per `seq`). Outside the app it does nothing.
 */
export function useNativeBridge(
  device: Ref<DeviceInfo | null>,
  unauthorized: Ref<boolean>,
  win: Window = window,
): void {
  const bridge = nativeBridge(win)
  if (!bridge) return

  let sentUnauthorized = false
  watch(unauthorized, (v) => {
    if (!v || sentUnauthorized) return
    sentUnauthorized = true
    bridge.post({ type: 'unauthorized' })
  }, { immediate: true })

  // The watcher fires only when the screen id changes; no device yet is not a screen.
  watch(() => device.value?.screenId, (id) => {
    if (id === undefined) return
    bridge.post({ type: 'screen', screenId: id })
  }, { immediate: true })

  // The server's seq restarts at 0 with the server, so compare for inequality, not order.
  let lastSeq: number | null = null
  watch(() => device.value?.brightness, (b) => {
    if (!b || b.target === null || b.seq === lastSeq) return
    lastSeq = b.seq
    bridge.post({ type: 'brightness', target: b.target, seq: b.seq })
  }, { immediate: true })
}
