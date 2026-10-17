/**
 * The admin's About section and the README's Credits section name the same people. The admin
 * reads `credits.ts`; the README is written by hand, so this is what notices when somebody is
 * added to one and not the other.
 */
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'
import { CONTRIBUTORS, MAINTAINER } from '../src/shared/credits'

const readme = readFileSync(new NodeURL('../../README.md', import.meta.url), 'utf8')
const section = readme.split('## Credits and trademarks')[1]?.split('\n## ')[0] ?? ''

describe('credits', () => {
  it('has a Credits section in the README', () => {
    expect(section).not.toBe('')
  })

  it.each([MAINTAINER, ...CONTRIBUTORS])('names $handle in the README, linked to their GitHub', (person) => {
    expect(section).toContain(`[${person.handle}](https://github.com/${person.github})`)
  })
})
