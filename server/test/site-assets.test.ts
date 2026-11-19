import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The site's pages are never cached, its stylesheet and script are (`site/_headers`, and the
 * CDN keeps them longer than that file says). Under one unchanging address, a new page was
 * served with the stylesheet and the script of the page before it for hours: links without
 * their style, a widget list one release behind. So each page names them with `?v=` and the
 * first ten hex digits of the file's SHA-256, and a changed file is a new address.
 *
 * When this fails after an edit of `site/style.css` or `site/main.js`, write the value the
 * message gives into the page it names.
 */
const SITE = fileURLToPath(new URL('../../site', import.meta.url))
const VERSIONED = ['style.css', 'main.js']

function version(file: string): string {
  return createHash('sha256').update(readFileSync(join(SITE, file))).digest('hex').slice(0, 10)
}

/** Every `href`/`src` of a page that points at one of the versioned files, as written. */
function references(html: string): string[] {
  return [...html.matchAll(/(?:href|src)="([^"]*)"/g)]
    .map((match) => match[1]!)
    .filter((url) => VERSIONED.some((file) => url.split('?')[0]!.replace(/^\//, '') === file))
}

describe('the site’s stylesheet and script', () => {
  const pages = readdirSync(SITE).filter((name) => name.endsWith('.html'))

  it('are loaded by the pages this test reads', () => {
    expect(pages).toContain('index.html')
    expect(references(readFileSync(join(SITE, 'index.html'), 'utf8')).length).toBe(2)
  })

  it.each(pages)('are named by their content in %s', (page) => {
    for (const url of references(readFileSync(join(SITE, page), 'utf8'))) {
      const path = url.split('?')[0]!
      const file = path.replace(/^\//, '')
      expect(url, `site/${page} loads ${file}`).toBe(`${path}?v=${version(file)}`)
    }
  })
})
