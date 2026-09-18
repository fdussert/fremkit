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
export const SDK_VERSION = 1
