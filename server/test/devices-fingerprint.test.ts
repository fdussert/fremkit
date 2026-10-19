import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FINGERPRINT_LIST_SHA256, WORDS, fingerprintWords } from '../src/devices/fingerprint.js'
import { computerName } from '../src/devices/host.js'
import { createAdvertiser, type AdvertiserChild } from '../src/devices/bonjour.js'

const FILE = new URL('../src/devices/fingerprint-words.txt', import.meta.url)

describe('fingerprintWords', () => {
  it('maps the first four bytes of the hash to words', () => {
    const hash = Buffer.from([0x00, 0x01, 0xfe, 0xff, ...new Array(28).fill(7)]).toString('base64url')
    expect(fingerprintWords(hash)).toEqual([WORDS[0], WORDS[1], WORDS[254], WORDS[255]])
    expect(fingerprintWords(hash)).toEqual(['aardvark', 'absurd', 'woodlark', 'zulu'])
  })

  it('ships 256 unique lowercase ASCII words whose bytes match the pinned hash', () => {
    const bytes = readFileSync(FILE)
    const lines = bytes.toString('utf8').split('\n')
    expect(lines.pop()).toBe('')
    expect(lines).toHaveLength(256)
    expect(new Set(lines).size).toBe(256)
    for (const w of lines) expect(w).toMatch(/^[a-z]+$/)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(FINGERPRINT_LIST_SHA256)
    expect([...WORDS]).toEqual(lines)
  })
})

describe('fingerprintWords on a short hash', () => {
  it('throws rather than mapping missing bytes to aardvark', () => {
    expect(() => fingerprintWords(Buffer.from([1, 2, 3]).toString('base64url'))).toThrow()
    expect(() => fingerprintWords('')).toThrow()
  })
})

describe('computerName', () => {
  const ok = (stdout: string) => async () => ({ stdout, stderr: '' })
  it('reads and trims the name', async () => {
    expect(await computerName(ok("  Example's Mac \n"))).toBe("Example's Mac")
  })
  it('runs scutil by its absolute path', async () => {
    const calls: string[] = []
    await computerName(async (file) => { calls.push(file); return { stdout: 'Mac', stderr: '' } })
    expect(calls).toEqual(['/usr/sbin/scutil'])
  })
  it('falls back to Fremkit when scutil fails or prints nothing', async () => {
    expect(await computerName(async () => { throw new Error('x') })).toBe('Fremkit')
    expect(await computerName(ok('\n'))).toBe('Fremkit')
  })
  it('cuts at 63 bytes on a character boundary', async () => {
    const name = await computerName(ok('é'.repeat(40)))
    expect(Buffer.byteLength(name)).toBe(62)
    expect(name).toBe('é'.repeat(31))
  })
  it('does not leave a trailing space after the cut', async () => {
    expect(await computerName(ok(`${'a'.repeat(62)} b`))).toBe('a'.repeat(62))
  })
})

describe('the advertiser with a name', () => {
  it('registers under the computer name and reaps any stale one for its port, whatever its name', () => {
    const child = { exitCode: null, signalCode: null, kill: () => true, on: () => undefined } as AdvertiserChild
    const calls: string[][] = []
    const killed: number[] = []
    const ad = createAdvertiser({
      platform: 'darwin',
      spawn: (_c, args) => { calls.push(args); return child },
      kill: (pid) => { killed.push(pid) },
      onExit: () => () => undefined,
      listProcesses: () => [
        '7 /usr/bin/dns-sd -R Old Name _fremkit._tcp local 4243',
        '8 /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4243',
        '9 /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4300',
        '10 /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4243 extra',
        '11 /bin/sh -c /usr/bin/dns-sd -R Fremkit _fremkit._tcp local 4243',
      ].join('\n'),
    })
    ad(4243, 'Example Mac')
    expect(calls).toEqual([['-R', 'Example Mac', '_fremkit._tcp', 'local', '4243']])
    expect(killed).toEqual([7, 8])
  })
})
