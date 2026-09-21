/**
 * Version sent as `User-Agent` by every outbound call. Kept as a literal rather than read from
 * package.json: the server runs from `src` under tsx and from `dist` after a build, and the
 * relative path to package.json is not the same in both.
 */
export const FREMKIT_VERSION = '0.2.0'
export const USER_AGENT = `fremkit/${FREMKIT_VERSION}`
