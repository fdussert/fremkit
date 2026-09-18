import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { FREMKIT_VERSION, USER_AGENT } from '../src/version.js'

describe('FREMKIT_VERSION', () => {
  it('is the version in package.json', async () => {
    // It is a literal rather than a read, because the server runs from src under tsx and from
    // dist after a build and the relative path differs — so the two have to be tied here.
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(FREMKIT_VERSION).toBe(pkg.version)
  })
  it('is the same version the workspace root declares', async () => {
    // Two package.json files carry a version, and a release is one number. A bump in one and not
    // the other is the kind of thing nobody notices until a User-Agent disagrees with a tag.
    const root = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(root.version).toBe(FREMKIT_VERSION)
  })

  it('is what every outbound call announces', () => {
    expect(USER_AGENT).toBe(`fremkit/${FREMKIT_VERSION}`)
    expect(USER_AGENT).not.toContain('claude-code')
  })
})
