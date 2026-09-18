/**
 * Comparing two versions, which is the whole reason the manifest's `version` is semver.
 *
 * The twin of `tools/semver.ts` in the registry repository, kept as a copy for the same reason
 * the index schema is: neither repository's release schedule is the other's problem, and the
 * behaviour is pinned on both sides by its own tests rather than by a shared dependency.
 *
 * Only what the registry actually asks: is this release newer than the last one, and which of a
 * list is the greatest. Ranges, carets and tildes have no meaning here — a widget is installed
 * at a version, not at a constraint.
 *
 * Build metadata is ignored, as semver.org says it must be: `1.0.0+a` and `1.0.0+b` are the same
 * release. A pre-release sorts *below* the release it leads to, and two pre-releases compare
 * identifier by identifier, numbers numerically and anything else alphabetically.
 */

export interface Parsed { major: number; minor: number; patch: number; pre: string[] }

const RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function parseSemver(version: string): Parsed | null {
  const m = RE.exec(version)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

const NUMERIC = /^(0|[1-9]\d*)$/

function comparePre(a: string[], b: string[]): number {
  // No pre-release at all is the greater: 1.0.0 comes after 1.0.0-rc.1.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    // A shorter run of identifiers is the smaller, all else being equal.
    if (i >= a.length) return -1
    if (i >= b.length) return 1
    const x = a[i], y = b[i]
    const xn = NUMERIC.test(x), yn = NUMERIC.test(y)
    if (xn && yn) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; continue }
    // A numeric identifier is always lower than an alphanumeric one.
    if (xn !== yn) return xn ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** -1, 0 or 1. An unparseable version sorts below every parseable one, and ties with itself. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a), y = parseSemver(b)
  if (!x || !y) return x === y ? 0 : x ? 1 : -1
  if (x.major !== y.major) return x.major < y.major ? -1 : 1
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1
  if (x.patch !== y.patch) return x.patch < y.patch ? -1 : 1
  return comparePre(x.pre, y.pre)
}

export function isNewer(candidate: string, than: string): boolean {
  return compareSemver(candidate, than) > 0
}

/** The greatest of a list, or null when the list is empty. */
export function greatest(versions: string[]): string | null {
  return versions.reduce<string | null>((best, v) => (best === null || compareSemver(v, best) > 0 ? v : best), null)
}
