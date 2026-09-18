import { describe, expect, it } from 'vitest'
import { crc32 } from 'node:zlib'
import { ZipError, deflateForTest, readZip, writeZip } from '../src/backup/zip.js'

const entry = (name: string, text: string) => ({ name, data: Buffer.from(text, 'utf8') })

describe('writeZip and readZip', () => {
  it('round-trips entries, in order, with their bytes intact', () => {
    const entries = [entry('fremkit.json', '{"version":2}'), entry('backgrounds/a.png', 'not really a png')]
    const back = readZip(writeZip(entries))
    expect(back.map((e) => e.name)).toEqual(['fremkit.json', 'backgrounds/a.png'])
    expect(back[1].data.toString('utf8')).toBe('not really a png')
  })

  it('writes something a zip reader recognises', () => {
    const zip = writeZip([entry('a.txt', 'x')])
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    expect(zip.readUInt32LE(zip.byteLength - 22)).toBe(0x06054b50)
  })

  it('handles an empty archive and an empty entry', () => {
    expect(readZip(writeZip([]))).toEqual([])
    expect(readZip(writeZip([entry('empty', '')]))[0].data.byteLength).toBe(0)
  })

  it('keeps binary bytes and non-ASCII names exactly', () => {
    const bytes = Buffer.from([0, 1, 2, 255, 128, 0x89, 0x50])
    const back = readZip(writeZip([{ name: 'fonds/été.png', data: bytes }]))
    expect(back[0].name).toBe('fonds/été.png')
    expect(back[0].data).toEqual(bytes)
  })

  it('reads a deflated entry, which is what another tool would produce', () => {
    // We only ever write stored entries; an archive handed back to /api/restore may have been
    // rebuilt by anything.
    const text = 'a'.repeat(5000)
    const data = Buffer.from(text, 'utf8')
    const deflated = deflateForTest(data)
    const zip = handBuilt([{ name: 'big.txt', raw: deflated, method: 8, crc: crc32(data), size: data.byteLength }])
    expect(readZip(zip)[0].data.toString('utf8')).toBe(text)
  })
})

describe('readZip refuses a hostile archive', () => {
  it('refuses something that is not a zip at all', () => {
    expect(() => readZip(Buffer.from('hello'))).toThrow(ZipError)
    expect(() => readZip(Buffer.alloc(0))).toThrow(ZipError)
    expect(() => readZip(Buffer.alloc(200))).toThrow(/not a zip/)
  })

  it('refuses a truncated archive', () => {
    const zip = writeZip([entry('a.txt', 'hello')])
    expect(() => readZip(zip.subarray(0, zip.byteLength - 30))).toThrow(ZipError)
  })

  it('refuses more entries than the cap', () => {
    const many = Array.from({ length: 20 }, (_, i) => entry(`f-${i}`, 'x'))
    expect(() => readZip(writeZip(many), { maxEntries: 5 })).toThrow(/too many entries/)
  })

  it('refuses an archive claiming more content than the cap: the zip bomb', () => {
    const big = Buffer.alloc(100_000, 0x41)
    expect(() => readZip(writeZip([{ name: 'big', data: big }]), { maxTotalBytes: 1000 }))
      .toThrow(/too large/)
  })

  it('refuses an entry whose checksum does not match its bytes', () => {
    const zip = writeZip([entry('a.txt', 'hello')])
    // Flip a byte of the payload, leaving the stated crc alone.
    const tampered = Buffer.from(zip)
    const at = tampered.indexOf(Buffer.from('hello'))
    tampered[at] = 0x48
    expect(() => readZip(tampered)).toThrow(/corrupt/)
  })

  it('refuses an encrypted entry rather than half-reading it', () => {
    const zip = handBuilt([{ name: 'secret', raw: Buffer.from('x'), method: 0, crc: crc32(Buffer.from('x')), size: 1, flags: 0x1 }])
    expect(() => readZip(zip)).toThrow(/encrypted/)
  })

  it('refuses a compression method it does not implement', () => {
    const zip = handBuilt([{ name: 'a', raw: Buffer.from('x'), method: 14, crc: crc32(Buffer.from('x')), size: 1 }])
    expect(() => readZip(zip)).toThrow(/unsupported compression/)
  })

  it('refuses a zip64 archive instead of misreading its offsets', () => {
    const zip = writeZip([entry('a.txt', 'hello')])
    const eocd = zip.byteLength - 22
    const forged = Buffer.from(zip)
    forged.writeUInt16LE(0xffff, eocd + 10)
    expect(() => readZip(forged)).toThrow(/zip64/)
  })
})

/** A zip built by hand, so a test can produce entries writeZip never writes. */
function handBuilt(items: { name: string; raw: Buffer; method: number; crc: number; size: number; flags?: number }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(item.flags ?? 0, 6)
    local.writeUInt16LE(item.method, 8)
    local.writeUInt32LE(item.crc, 14)
    local.writeUInt32LE(item.raw.byteLength, 18)
    local.writeUInt32LE(item.size, 22)
    local.writeUInt16LE(name.byteLength, 26)
    locals.push(local, name, item.raw)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(item.flags ?? 0, 8)
    central.writeUInt16LE(item.method, 10)
    central.writeUInt32LE(item.crc, 16)
    central.writeUInt32LE(item.raw.byteLength, 20)
    central.writeUInt32LE(item.size, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.byteLength + name.byteLength + item.raw.byteLength
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(items.length, 8)
  eocd.writeUInt16LE(items.length, 10)
  eocd.writeUInt32LE(directory.byteLength, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}
