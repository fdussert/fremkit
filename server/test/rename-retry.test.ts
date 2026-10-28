import { describe, expect, it } from 'vitest'
import { RENAME_RETRY_DELAYS_MS, renameRetrying } from '../src/platform/rename.js'

const failing = (codes: (string | null)[]) => {
  const calls: string[] = []
  const rename = async (from: string, to: string) => {
    calls.push(`${from}>${to}`)
    const code = codes.shift()
    if (code) throw Object.assign(new Error(code), { code })
  }
  return { calls, rename }
}

describe('renameRetrying', () => {
  it('rides out a file briefly held open on Windows', async () => {
    const waits: number[] = []
    const { calls, rename } = failing(['EBUSY', 'EPERM', 'EACCES', null])
    await renameRetrying(rename, 'a.tmp', 'a', 'win32', async (ms) => { waits.push(ms) })
    expect(calls).toHaveLength(4)
    expect(waits).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 3))
  })

  it('gives up after a bounded number of attempts, with the last error', async () => {
    const { calls, rename } = failing(Array(20).fill('EBUSY'))
    await expect(renameRetrying(rename, 'a.tmp', 'a', 'win32', async () => {})).rejects.toMatchObject({ code: 'EBUSY' })
    expect(calls).toHaveLength(RENAME_RETRY_DELAYS_MS.length + 1)
    expect(RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThan(1000)
  })

  it('never retries another error, or anywhere but Windows', async () => {
    for (const [codes, platform] of [[['ENOENT'], 'win32'], [['EBUSY'], 'darwin']] as const) {
      const { calls, rename } = failing([...codes])
      await expect(renameRetrying(rename, 'a.tmp', 'a', platform, async () => { throw new Error('no wait expected') })).rejects.toMatchObject({ code: codes[0] })
      expect(calls).toHaveLength(1)
    }
  })
})
