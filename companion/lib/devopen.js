// Open in editor: the URL of the dev server's own open-in-editor endpoint for a history entry.
//
// Built from the tab's origin and from the extension's own copy of the entry (the full path a build
// entry keeps, an error's unredacted origin), never from anything the server or the Edge sends: the
// Edge names an entry by its id, and the result's origin is always the tab's. This URL is the only
// thing that carries a home folder in full; it is fetched, never sent.
//
// One endpoint per dev server kind:
// - Vite:    `<base>__open-in-editor?file=<path[:line:col]>` (launch-editor-middleware), the path
//            relative to the Vite root, or absolute; build entries and errors thrown on the page's
//            own origin.
// - Next:    `/__nextjs_launch-editor?file=<path>&lineNumber=<n>&column=<n>&line1=<n>&column1=<n>`;
//            build entries only. Next 15.5 reads `line1` and `column1` (its webpack and Turbopack
//            middlewares alike) and opens line 1 without them; earlier releases read `lineNumber` and
//            `column`. Both pairs go, each server ignoring the other's.
// - webpack: `/webpack-dev-server/open-editor?fileName=<path[:line:col]>`; build entries only.
// Vite and webpack answer 200 whether or not an editor opened; Next answers 204, or 404 for a file it
// does not find. A 2xx means the server answered, not that an editor opened.

const PLACE_RE = /^(.*):(\d+):(\d+)$/

/** `path:line:col` as its parts; null for anything else. */
export function parsePlace(s) {
  const m = typeof s === 'string' ? PLACE_RE.exec(s) : null
  return m ? { path: m[1], line: Number(m[2]), col: Number(m[3]) } : null
}

const enc = encodeURIComponent
const isPos = (v) => Number.isInteger(v) && v >= 1
/** `path`, with `:line:col` when both are known. */
const withPlace = (path, line, col) => (isPos(line) && isPos(col) ? `${path}:${line}:${col}` : path)

/** The tab's origin, for http(s) alone; null when its URL does not parse. */
function originOf(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

/**
 * The file Vite is asked to open for an error thrown on the page's own origin: its URL path, decoded
 * (a folder with a space reaches the page as `%20`), the base stripped, then `@fs/` made absolute
 * again or the leading `/` dropped (Vite resolves it against its root). Null for another origin's
 * script (`host/path`), a protocol-relative one, or a path that does not decode.
 */
function viteErrorFile(origin, base) {
  const place = parsePlace(origin)
  if (!place || !place.path.startsWith('/') || place.path.startsWith('//')) return null
  let path
  try {
    path = decodeURIComponent(place.path)
  } catch {
    return null
  }
  const prefix = base.slice(0, -1)
  if (prefix !== '' && path.startsWith(`${prefix}/`)) path = path.slice(prefix.length)
  path = path.startsWith('/@fs/') ? path.slice('/@fs'.length) : path.slice(1)
  return path === '' ? null : withPlace(path, place.line, place.col)
}

/**
 * The URL that asks the tab's dev server to open `entry`'s file, or null: no known dev server, a
 * tab URL that does not parse, or an entry that names no file this kind can open.
 * `tab` and `entry` are the extension's own (devtabs.js), not the wire's.
 */
export function editorUrl(tab, entry) {
  const origin = originOf(tab?.url)
  if (!origin || !entry) return null
  const isBuild = entry.kind === 'build' && typeof entry.path === 'string' && entry.path !== ''
  switch (tab.devServer) {
    case 'vite': {
      const base = typeof tab.serverBase === 'string' && tab.serverBase.startsWith('/') && tab.serverBase.endsWith('/') ? tab.serverBase : '/'
      let file = null
      if (isBuild) file = withPlace(entry.path, entry.line, entry.col)
      else if (entry.kind === 'error') file = viteErrorFile(entry.origin, base)
      return file === null ? null : `${origin}${base}__open-in-editor?file=${enc(file)}`
    }
    case 'next': {
      if (!isBuild) return null
      const { line, col } = entry
      const place = isPos(line) && isPos(col) ? `&lineNumber=${line}&column=${col}&line1=${line}&column1=${col}` : ''
      return `${origin}/__nextjs_launch-editor?file=${enc(entry.path)}${place}`
    }
    case 'webpack':
      return isBuild ? `${origin}/webpack-dev-server/open-editor?fileName=${enc(withPlace(entry.path, entry.line, entry.col))}` : null
    default:
      return null
  }
}
