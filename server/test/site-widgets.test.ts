import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The landing page lists the built-in widgets from a table written by hand in `site/main.js`
 * (the registry's are fetched live). Four widgets shipped without ever reaching it; this keeps
 * the table to the `widgets/` folder: same ids, same names, same categories. The descriptions
 * are the page's own, shorter than a manifest's, and are left alone.
 */
const SHIPPED = fileURLToPath(new URL('../../widgets', import.meta.url))
const SITE = fileURLToPath(new URL('../../site/main.js', import.meta.url))

type Row = [id: string, fr: string, en: string, descFr: string, descEn: string, category: string]

function siteRows(): Row[] {
  const js = readFileSync(SITE, 'utf8')
  const start = js.indexOf('[', js.indexOf('var CORE = ['))
  const end = js.indexOf('].map(', start)
  expect(start, 'the CORE table of site/main.js').toBeGreaterThan(0)
  expect(end, 'the end of the CORE table').toBeGreaterThan(start)
  // The table is a literal of string arrays: evaluated as written, nothing else runs.
  return new Function(`return ${js.slice(start, end + 1)}`)() as Row[]
}

/**
 * Built in, yet behind a switch under Experimental features: the page announces one only once
 * its switch is gone, so it stays out of the table until then.
 */
const EXPERIMENTAL: readonly string[] = ['fremdev']

function shipped() {
  return readdirSync(SHIPPED)
    .filter((id) => existsSync(join(SHIPPED, id, 'manifest.json')) && !EXPERIMENTAL.includes(id))
    .map((id) => JSON.parse(readFileSync(join(SHIPPED, id, 'manifest.json'), 'utf8')) as { id: string; name: string | { fr: string; en: string }; category: string })
}

describe('the built-in widgets listed on the site', () => {
  it('are the ones the repository ships', () => {
    expect(siteRows().map((row) => row[0]).sort()).toEqual(shipped().map((m) => m.id).sort())
  })

  it('leave out the experimental ones, which do exist', () => {
    const ids = siteRows().map((row) => row[0])
    for (const id of EXPERIMENTAL) {
      expect(existsSync(join(SHIPPED, id, 'manifest.json')), `widgets/${id}`).toBe(true)
      expect(ids, `${id} on the site`).not.toContain(id)
    }
  })

  it('carry the names and categories of their manifests', () => {
    const rows = new Map(siteRows().map((row) => [row[0], row]))
    for (const manifest of shipped()) {
      const row = rows.get(manifest.id)
      if (!row) continue
      // A manifest's name is one string when it reads the same in both languages.
      const name = typeof manifest.name === 'string' ? { fr: manifest.name, en: manifest.name } : manifest.name
      expect({ id: row[0], fr: row[1], en: row[2], category: row[5] })
        .toEqual({ id: manifest.id, fr: name.fr, en: name.en, category: manifest.category })
    }
  })

  it('all have a description in both languages', () => {
    for (const row of siteRows()) {
      expect(row[3].trim(), `${row[0]} in French`).not.toBe('')
      expect(row[4].trim(), `${row[0]} in English`).not.toBe('')
    }
  })
})
