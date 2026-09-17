/**
 * Finding the icon a page declares.
 *
 * Pure string work, kept apart from the fetching and the cache so it can be tested with a
 * handful of HTML snippets instead of a network.
 */

/** `<link …>` tags, opening tag only: a `<link>` never has a closing one. */
const LINK_RE = /<link\b[^>]*>/gi
/** `<base href="…">`, which changes what a relative icon href is relative to. */
const BASE_RE = /<base\b[^>]*>/i

/** Reads one attribute out of a tag, quoted or bare. */
function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
  const m = re.exec(tag)
  if (!m) return null
  return (m[2] ?? m[3] ?? m[4] ?? '').trim()
}

/** The largest square edge a `sizes` attribute claims; 0 when it claims nothing usable. */
export function largestSize(sizes: string | null): number {
  if (!sizes) return 0
  // `any` (an SVG that scales to anything) beats every pixel size.
  if (/\bany\b/i.test(sizes)) return Number.MAX_SAFE_INTEGER
  let best = 0
  for (const token of sizes.split(/\s+/)) {
    const m = /^(\d+)[xX](\d+)$/.exec(token)
    if (!m) continue
    best = Math.max(best, Number(m[1]), Number(m[2]))
  }
  return best
}

/** How much we want a given `rel`: an Apple touch icon first, a plain icon second, nothing else. */
function relRank(rel: string | null): number {
  if (!rel) return 0
  const tokens = rel.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.includes('apple-touch-icon') || tokens.includes('apple-touch-icon-precomposed')) return 2
  if (tokens.includes('icon')) return 1
  return 0
}

/** True when a `<link>` announces an SVG, which the store does not keep. */
function isSvgLink(tag: string, url: URL): boolean {
  if ((attr(tag, 'type') ?? '').toLowerCase().includes('svg')) return true
  return /\.svg$/i.test(url.pathname)
}

/**
 * The icon URL a page declares, absolute, or `null` when it declares none.
 *
 * `apple-touch-icon` wins over `icon`/`shortcut icon`; among equals the largest `sizes` wins,
 * and the first one in the document breaks the remaining ties. Relative hrefs resolve against
 * `<base href>` when the page has one, and against the page's own URL otherwise. SVG links are
 * skipped: the store refuses them, and picking one would only cost a fetch before falling back
 * to `/favicon.ico`.
 */
export function pickIconHref(html: string, pageUrl: string): string | null {
  let base: URL
  try { base = new URL(pageUrl) } catch { return null }
  const baseTag = BASE_RE.exec(html)
  if (baseTag) {
    const href = attr(baseTag[0], 'href')
    if (href) { try { base = new URL(href, base) } catch { /* unusable <base>: keep the page URL */ } }
  }

  let best: { rank: number; size: number; url: string } | null = null
  let match: RegExpExecArray | null
  LINK_RE.lastIndex = 0
  while ((match = LINK_RE.exec(html)) !== null) {
    const tag = match[0]
    const rank = relRank(attr(tag, 'rel'))
    if (rank === 0) continue
    const href = attr(tag, 'href')
    if (!href) continue
    let resolved: URL
    try { resolved = new URL(href, base) } catch { continue }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
    if (isSvgLink(tag, resolved)) continue
    const size = largestSize(attr(tag, 'sizes'))
    if (best && (rank < best.rank || (rank === best.rank && size <= best.size))) continue
    best = { rank, size, url: resolved.toString() }
  }
  return best ? best.url : null
}
