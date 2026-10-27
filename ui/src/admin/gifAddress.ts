/**
 * What a pasted GIF address is, for the GIF board's editor panel.
 *
 * A Giphy address becomes a `giphy` item by its id: Giphy's content is never cached, so the board
 * shows it from Giphy's CDN. Any other `https:` address is a `link`, which the server downloads
 * and caches before it is added. A Giphy address the id cannot be read from (a `gph.is` short
 * link, an explore page) is refused with `giphyLink`: the server would refuse to cache it, and the
 * search finds the GIF.
 */
export type ParsedGif =
  | { kind: 'giphy'; giphyId: string }
  | { kind: 'link'; url: string }
  | { error: 'notHttps' | 'invalid' | 'giphyLink' }

/** Mirrors the config schema: a Giphy id, and a link's length. */
const GIPHY_ID = /^[A-Za-z0-9]{1,64}$/
const MAX_URL = 2048

/** Mirrors `isGiphyHost` in `server/src/gifs/store.ts`; a trailing dot names the same host. */
function isGiphyHost(host: string): boolean {
  return host === 'giphy.com' || host.endsWith('.giphy.com') || host === 'gph.is' || host.endsWith('.gph.is')
}

/** The id in a Giphy address's path, or null when it holds none we know how to read. */
function giphyIdOf(host: string, path: string[]): string | null {
  let id: string | undefined
  if (host === 'giphy.com' || host === 'www.giphy.com') {
    // /gifs/<slug>-<id> or /gifs/<id>: the id is what follows the slug's last dash.
    if ((path[0] === 'gifs' || path[0] === 'embed') && path.length === 2) id = path[1].split('-').pop()
  } else if (/^media\d*\.giphy\.com$/.test(host)) {
    // /media/<id>/<file> or /media/v1.<…>/<id>/<file>
    if (path[0] === 'media' && path.length === 3) id = path[1]
    else if (path[0] === 'media' && path.length === 4 && path[1].startsWith('v1.')) id = path[2]
  } else if (host === 'i.giphy.com') {
    // /<id>.gif, /<id>/giphy.gif or /media/<id>/giphy.gif
    const rest = path[0] === 'media' ? path.slice(1) : path
    if (rest.length === 1 && rest[0].endsWith('.gif')) id = rest[0].slice(0, -4)
    else if (rest.length === 2 && rest[1] === 'giphy.gif') id = rest[0]
  }
  return id && GIPHY_ID.test(id) ? id : null
}

export function parseGifAddress(input: string): ParsedGif {
  const text = input.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { error: 'invalid' }
  }
  if (url.protocol === 'http:') return { error: 'notHttps' }
  if (url.protocol !== 'https:' || !url.hostname) return { error: 'invalid' }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (isGiphyHost(host)) {
    const id = giphyIdOf(host, url.pathname.split('/').filter(Boolean))
    return id ? { kind: 'giphy', giphyId: id } : { error: 'giphyLink' }
  }
  if (url.href.length > MAX_URL) return { error: 'invalid' }
  return { kind: 'link', url: url.href }
}
