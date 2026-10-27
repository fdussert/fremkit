import { searchGiphy } from '../../gifs/giphy.js'
import { tr } from '../../i18n.js'
import type { ConnectionType, TestResult } from '../types.js'

export interface GiphyTestDeps { fetchFn?: typeof fetch }

/**
 * A Giphy API key, for the GIF board's search in the admin.
 *
 * Coded rather than declared by the widget: the key travels as a query parameter (a declared
 * connection sends one auth header), and the search is the admin's, made by the server, never by
 * the widget. The key stays in the secret store and never reaches a page. No provider: nothing
 * is published on a channel.
 */
export const giphyType: ConnectionType = {
  id: 'giphy',
  name: { fr: 'Giphy', en: 'Giphy' },
  description: { fr: 'Recherche de GIFs pour le tableau de GIFs', en: 'GIF search for the GIF board' },
  // The icon set has no image pictogram; `video` is the closest to a moving picture.
  icon: 'video',
  fields: [
    {
      key: 'apiKey',
      label: { fr: 'Clé d’API', en: 'API key' },
      secret: true,
      required: true,
      help: {
        fr: 'Une clé « API » gratuite créée sur developers.giphy.com (100 recherches par heure). Les GIFs de Giphy ne sont jamais conservés.',
        en: 'A free “API” key created at developers.giphy.com (100 searches an hour). Giphy’s GIFs are never stored.',
      },
    },
  ],

  async test(_fields, secrets, deps: GiphyTestDeps = {}): Promise<TestResult> {
    const key = secrets.apiKey ?? ''
    if (key === '') return { ok: false, error: tr(undefined, 'gifs.unauthorized') }
    const result = await searchGiphy(key, 'hello', 0, deps.fetchFn ?? fetch)
    if (result.ok) return { ok: true, detail: tr(undefined, 'giphy.connected', { count: result.total }) }
    return { ok: false, error: tr(undefined, `gifs.${result.error}`) }
  },
}
