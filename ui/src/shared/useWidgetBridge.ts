import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { useSocket } from './socket'
import { t, useI18n } from './i18n'
import { isHexColor, tileText } from './color'
import { channelAllowed, mergeSettings, type AccentMode, type NavSlot, type WidgetInstance, type WidgetManifest, type WidgetSize } from './types'

export type BridgeState = 'loading' | 'ready' | 'error'

export interface BridgeOptions {
  /**
   * True while the widget is drawn inside the navigation bar. The host frame then draws neither
   * a title nor a surface — the bar is the surface — and the widget lays itself out as one line.
   */
  compact?: () => boolean
  /**
   * The widget's real pixel size, when it is not the grid's. The navigation bar sizes its
   * widgets itself: as many cells wide as the manifest asks for, and the bar's own height.
   */
  pixelSize?: () => { width: number; height: number }
  /**
   * Which cluster of the navigation bar the widget sits in. The bar pushes the right cluster
   * against the dots, but the iframe keeps its allotted width either way, so the widget has to
   * align its own content — it needs to know which side it is on to do that.
   */
  slot?: () => NavSlot
}

/**
 * Host side of the Fremkit postMessage protocol: answers a widget iframe's hello,
 * relays its subscriptions, commands and proxied fetches, and reports its load state.
 * Shared by the dashboard tiles and the admin preview so both behave identically.
 */
export function useWidgetBridge(
  iframe: Ref<HTMLIFrameElement | undefined>,
  instance: () => WidgetInstance,
  manifest: () => WidgetManifest | undefined,
  cell: () => number,
  options: BridgeOptions = {},
): { state: Ref<BridgeState> } {
  const socket = useSocket()
  const { locale } = useI18n()
  const state = ref<BridgeState>('loading')
  /** channel -> how to stop relaying it. One entry per channel, so a re-subscribe is a no-op. */
  const unsubs = new Map<string, () => void>()
  let timer: number | undefined

  const size = (): WidgetSize => {
    const inst = instance()
    return { w: inst.w, h: inst.h, px: options.pixelSize?.() ?? { width: inst.w * cell(), height: inst.h * cell() } }
  }
  /** The accent colour the widget should paint with, or null for the theme default. */
  const accentColor = (): string | null => {
    const inst = instance()
    return isHexColor(inst.accentColor) ? inst.accentColor : null
  }
  /** How much of the tile the accent paints; absent means it paints none of it. */
  const accentMode = (): AccentMode => instance().accentMode ?? 'none'
  /**
   * The text colour that reads on the tile's body, the same value the frame paints as
   * `--tile-text`. The widget gets it as `--on-surface`, plus the matching on-light/on-dark class.
   */
  const onSurface = (): string => {
    const inst = instance()
    return tileText(accentMode(), inst.accentColor, inst.bgColor)
  }
  /** The chrome the host draws around the widget, as one message payload. */
  const chrome = () => ({
    accentColor: accentColor(),
    accentMode: accentMode(),
    onSurface: onSurface(),
    slot: options.slot?.() ?? null,
  })
  // Settings and data come out of Vue's reactive config as Proxies, which postMessage cannot
  // structured-clone (a DataCloneError on the first array-valued setting). JSON round-trip
  // strips the proxies; every message here is plain JSON anyway.
  const post = (msg: unknown) => iframe.value?.contentWindow?.postMessage(JSON.parse(JSON.stringify(msg)), '*')
  const reply = (id: string, result?: unknown, error?: string) => post({ type: 'fremkit:result', id, result, error })

  /** A non-empty string, or null. Every field of a widget's message is checked through this. */
  const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

  /**
   * The iframe's `src` at its last load, and whether we have stopped trusting what is inside it.
   *
   * `ev.source` is the iframe's `contentWindow`, and that object survives a navigation: a widget
   * that sets `location` gets a brand-new document holding the same `contentWindow`, which would
   * keep answering to this widget's identity and inherit its subscriptions — a channel carrying a
   * connection's data among them. A load whose `src` attribute is unchanged is such a
   * self-navigation (a host-driven change to another widget changes the attribute), so the
   * subscriptions go and the frame is not answered again. A widget that wants to start over asks
   * the host, it does not reload itself.
   */
  let loadedSrc: string | null = null
  let disowned = false

  function onLoad() {
    const src = iframe.value?.getAttribute('src') ?? ''
    if (loadedSrc === null || loadedSrc !== src) {
      loadedSrc = src
      disowned = false
      return
    }
    disowned = true
    unsubs.forEach((f) => f())
    unsubs.clear()
    state.value = 'error'
  }

  function onMessage(ev: MessageEvent) {
    if (!iframe.value || ev.source !== iframe.value.contentWindow) return
    if (disowned) return
    const m = ev.data
    if (!m || typeof m.type !== 'string') return
    switch (m.type) {
      case 'fremkit:hello':
        post({
          type: 'fremkit:init',
          instanceId: instance().instanceId,
          settings: mergeSettings(manifest(), instance().settings),
          size: size(),
          ...chrome(),
          showTitle: instance().showTitle,
          compact: options.compact?.() === true,
          locale: locale.value,
        })
        state.value = 'ready'
        window.clearTimeout(timer)
        break
      case 'fremkit:subscribe': {
        const channel = str(m.channel)
        if (!channel || !channelAllowed(manifest()?.subscriptions ?? [], channel)) break
        if (unsubs.has(channel)) break
        unsubs.set(channel, socket.subscribe(channel, (data) => post({ type: 'fremkit:data', channel, data })))
        break
      }
      case 'fremkit:unsubscribe': {
        // A widget whose settings now point at another connection drops the old channel.
        const channel = str(m.channel)
        if (!channel) break
        unsubs.get(channel)?.()
        unsubs.delete(channel)
        break
      }
      case 'fremkit:command': {
        const id = str(m.id)
        const channel = str(m.channel)
        const name = str(m.name)
        if (!id) break
        if (!channel || !name) { reply(id, undefined, t('bridge.badRequest')); break }
        if (!channelAllowed(manifest()?.commands ?? [], channel)) { reply(id, undefined, t('bridge.channelNotAllowed', { channel })); break }
        socket.command(channel, name, m.payload).then((r) => reply(id, r), (e: Error) => reply(id, undefined, e.message))
        break
      }
      case 'fremkit:fetch': {
        const id = str(m.id)
        const url = str(m.url)
        if (!id) break
        // The proxy is GET-only; a widget naming another method is asking for something the
        // bridge never promised, so it is refused rather than quietly turned into a GET.
        const method = str(m.init?.method) ?? 'GET'
        if (!url || method.toUpperCase() !== 'GET') { reply(id, undefined, t('bridge.badRequest')); break }
        fetch(`/api/proxy/${encodeURIComponent(instance().widgetId)}?url=${encodeURIComponent(url)}`, { method: 'GET' })
          .then(async (r) => reply(id, { status: r.status, headers: { 'content-type': r.headers.get('content-type') }, body: await r.text() }))
          .catch((e: Error) => reply(id, undefined, e.message))
        break
      }
    }
  }

  function armTimeout() {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => { if (state.value === 'loading') state.value = 'error' }, 5000)
  }

  onMounted(() => {
    window.addEventListener('message', onMessage)
    if (!manifest()) { state.value = 'error'; return }
    armTimeout()
  })
  onUnmounted(() => {
    window.removeEventListener('message', onMessage)
    iframe.value?.removeEventListener('load', onLoad)
    unsubs.forEach((f) => f())
    unsubs.clear()
    window.clearTimeout(timer)
  })
  // The frame is behind a `v-if="manifest"`, so it appears after this runs.
  watch(iframe, (el, old) => {
    old?.removeEventListener('load', onLoad)
    el?.addEventListener('load', onLoad)
  }, { immediate: true })
  watch(
    () => JSON.stringify(size()),
    (json) => post({ type: 'fremkit:resize', size: JSON.parse(json) as WidgetSize }),
  )
  // Settings change in place rather than through a remount. A widget that does not listen for
  // fremkit:settings simply keeps its current values until it is next mounted.
  watch(
    () => JSON.stringify(mergeSettings(manifest(), instance().settings)),
    (json) => { if (state.value === 'ready') post({ type: 'fremkit:settings', settings: JSON.parse(json) }) },
  )
  // Same idea for the chrome: the accent, the mode and the text colour all change in place, so
  // editing the appearance in the admin never reloads the widget.
  watch(
    () => JSON.stringify(chrome()),
    (json) => { if (state.value === 'ready') post({ type: 'fremkit:appearance', ...JSON.parse(json) }) },
  )
  // A widget renders its own strings, so the language reaches it the same way its settings do:
  // in place, without a remount.
  watch(locale, (value) => { if (state.value === 'ready') post({ type: 'fremkit:locale', locale: value }) })
  watch(manifest, (m) => { if (m && state.value === 'error') { state.value = 'loading'; armTimeout() } })

  return { state }
}
