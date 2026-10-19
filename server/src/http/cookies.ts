/**
 * One cookie's value out of a `Cookie` header: the first one named exactly `name`, trimmed, or
 * undefined when there is none. An empty value comes back as `''`; callers that treat it as
 * missing say so themselves. Parsed by hand: there is no cookie plugin here.
 *
 * Shared by the local access gate (`access.ts`) and the paired-devices gate (`devices/gate.ts`).
 */
export function readCookie(header: string | string[] | undefined, name: string): string | undefined {
  const raw = Array.isArray(header) ? header.join('; ') : header
  if (typeof raw !== 'string') return undefined
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}
