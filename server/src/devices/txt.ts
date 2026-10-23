/** An IPv4 or IPv6 literal, possibly with a zone: all a TXT `a=` may carry. */
const TXT_ADDRESS = /^[0-9A-Fa-f.:]+(%[0-9A-Za-z]+)?$/

/**
 * The TXT record the pairing listener is advertised with, `a=<address> p=<port>`, or null when
 * there is no address or it is not an address literal. `p` repeats the SRV port: a device that
 * cannot resolve the SRV target cannot read it there. One rule for `dns-sd` and for ciao.
 */
export function txtRecord(address: string | null, port: number): { a: string; p: string } | null {
  return address !== null && TXT_ADDRESS.test(address) ? { a: address, p: String(port) } : null
}
