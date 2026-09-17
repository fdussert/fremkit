/**
 * What a Bambu printer's address may look like.
 *
 * Kept apart from the connection type and from the provider because all three need it and the
 * type already imports the provider: asking the provider to import the type back would be a
 * cycle.
 */

/**
 * A hostname or an IPv4 literal: letters, digits, dots and dashes, nothing else. An IPv6 literal
 * is accepted bracketed, the way a URL writes it.
 *
 * The value ends up as the host of an MQTT connection and inside an RTSPS URL handed to ffmpeg,
 * so a `user:pass@host`, a port, a path or a whole URL is rejected here rather than being
 * quietly reinterpreted further down.
 */
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/

/** True for a host the provider and the camera may dial. */
export function isValidBambuHost(host: string): boolean {
  return host.length <= 253 && HOST_RE.test(host)
}
