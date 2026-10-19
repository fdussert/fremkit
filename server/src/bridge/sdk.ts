/**
 * The generation of the widget SDK this build speaks.
 *
 * A widget's manifest says which generation it was written against; the number is compared, not
 * the Fremkit version, because the two move for different reasons — a patch release changes the
 * server every week and changes nothing a widget can see. It goes up only when the bridge gains
 * something a widget may *rely* on, and a widget asking for more than this build has is refused
 * at install rather than installed and left half-broken.
 *
 * The bridge repeats the number as a literal (`Fremkit.sdk`), because it is a plain browser
 * script with no imports; `bridge.test.ts` holds the two together.
 */
export const SDK_VERSION = 3

/**
 * What each generation put on the `Fremkit` global, by name.
 *
 * Generations only add: a widget written for 1 still installs and runs on a build that speaks 2,
 * because the comparison is `manifest.sdk > SDK_VERSION`. `bridge.test.ts` refuses a member of
 * the bridge that no generation lists, so a new helper cannot ship without someone deciding
 * whether it needs a new generation — the miss that let `installedApps` and `appIcon` reach a
 * build still saying 1.
 */
export const SDK_GENERATIONS: Readonly<Record<number, readonly string[]>> = {
  1: [
    'ready', 'sdk', 'instanceId', 'settings', 'locale', 'tokens',
    'accentMode', 'accentColor', 'onSurface', 'showTitle', 'compact', 'slot', 'size',
    'whenReady', 'subscribe', 'sendCommand', 'fetch',
    'esc', 'el', 'color', 't', 'onResize', 'onSettings', 'onLocale',
  ],
  // Fremkit 0.3.0: images a sandboxed frame cannot load itself, fetched by the host.
  2: ['favicon', 'image', 'installedApps', 'appIcon'],
  // The screen a frame is drawn on, for a widget whose data is per screen (brightness),
  // and a control that must not swipe the page under the finger (holdSwipe).
  3: ['screen', 'holdSwipe'],
}
