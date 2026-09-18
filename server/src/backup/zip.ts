import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * Just enough ZIP to write a backup and read one back.
 *
 * No dependency: `node:zlib` already provides `crc32`, `deflateRaw` and `inflateRaw`, which is
 * everything the format needs, and a release whose whole point was to shrink the attack surface
 * is a poor place to add two packages (one to write, one to read) that parse untrusted archives.
 * The format is small and fully specified, so it is written out here.
 *
 * Writing uses *stored* entries — no compression. The bulk of a backup is PNG and JPEG
 * backgrounds, which are already compressed, and the config is a few kilobytes; deflating would
 * buy almost nothing and add a failure mode. Reading accepts stored *and* deflated entries,
 * because the archive handed back to `/api/restore` may have been rebuilt by anything.
 *
 * Deliberately not supported: ZIP64 (a 50 MB body limit is far below the 4 GB boundary),
 * encryption, and multi-disk archives. Each is refused rather than half-read.
 */

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
/** The version that understands everything written here. */
const VERSION = 20

export interface ZipEntry {
  name: string
  data: Buffer
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

/** MS-DOS date and time, which is what the format stores. */
function dosDateTime(when: Date): { date: number; time: number } {
  const year = Math.max(1980, when.getFullYear())
  return {
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
  }
}

/** One archive holding `entries`, in order, uncompressed. */
export function writeZip(entries: ZipEntry[], when: Date = new Date()): Buffer {
  const { date, time } = dosDateTime(when)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const sum = crc32(entry.data)
    const size = entry.data.byteLength

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(VERSION, 4)
    local.writeUInt16LE(0, 6)                 // flags
    local.writeUInt16LE(METHOD_STORE, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(size, 18)             // compressed
    local.writeUInt32LE(size, 22)             // uncompressed
    local.writeUInt16LE(name.byteLength, 26)
    local.writeUInt16LE(0, 28)                // extra
    locals.push(local, name, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(VERSION, 4)         // version made by
    central.writeUInt16LE(VERSION, 6)         // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(METHOD_STORE, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(sum, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt16LE(0, 30)              // extra
    central.writeUInt16LE(0, 32)              // comment
    central.writeUInt16LE(0, 34)              // disk
    central.writeUInt16LE(0, 36)              // internal attrs
    central.writeUInt32LE(0, 38)              // external attrs
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.byteLength + name.byteLength + size
  }

  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)                    // this disk
  eocd.writeUInt16LE(0, 6)                    // disk with the directory
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.byteLength, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)                   // comment
  return Buffer.concat([...locals, directory, eocd])
}

/** Where the end-of-central-directory record starts, or -1. Scanned from the back. */
function findEocd(buf: Buffer): number {
  const earliest = Math.max(0, buf.byteLength - 22 - 0xffff)
  for (let i = buf.byteLength - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/**
 * The entries of an archive.
 *
 * `maxEntries` and `maxTotalBytes` bound what a hostile archive can make the server allocate: a
 * few hundred bytes of headers can claim gigabytes of output, which is the zip bomb. Every
 * refusal is a `ZipError` naming nothing but the reason.
 */
export function readZip(buf: Buffer, limits: { maxEntries?: number; maxTotalBytes?: number } = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 512
  const maxTotalBytes = limits.maxTotalBytes ?? 64 * 1024 * 1024

  const eocd = findEocd(buf)
  if (eocd < 0) throw new ZipError('not a zip archive')
  const count = buf.readUInt16LE(eocd + 10)
  const directorySize = buf.readUInt32LE(eocd + 12)
  const directoryAt = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) {
    throw new ZipError('zip64 archives are not supported')
  }
  if (count > maxEntries) throw new ZipError('too many entries')
  if (directoryAt + directorySize > buf.byteLength) throw new ZipError('truncated archive')

  const entries: ZipEntry[] = []
  let total = 0
  let at = directoryAt
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.byteLength || buf.readUInt32LE(at) !== CENTRAL_SIG) throw new ZipError('truncated archive')
    const flags = buf.readUInt16LE(at + 8)
    const method = buf.readUInt16LE(at + 10)
    const declaredCrc = buf.readUInt32LE(at + 16)
    const compressedSize = buf.readUInt32LE(at + 20)
    const uncompressedSize = buf.readUInt32LE(at + 24)
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength = buf.readUInt16LE(at + 32)
    const localAt = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    at += 46 + nameLength + extraLength + commentLength

    // Bit 0 is "encrypted". Nothing here can decrypt, and a half-read entry is worse than none.
    if (flags & 0x1) throw new ZipError('encrypted entries are not supported')
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) throw new ZipError('unsupported compression')
    total += uncompressedSize
    if (total > maxTotalBytes) throw new ZipError('archive contents too large')

    if (localAt + 30 > buf.byteLength || buf.readUInt32LE(localAt) !== LOCAL_SIG) throw new ZipError('truncated archive')
    const localNameLength = buf.readUInt16LE(localAt + 26)
    const localExtraLength = buf.readUInt16LE(localAt + 28)
    const dataAt = localAt + 30 + localNameLength + localExtraLength
    if (dataAt + compressedSize > buf.byteLength) throw new ZipError('truncated archive')
    const raw = buf.subarray(dataAt, dataAt + compressedSize)

    let data: Buffer
    if (method === METHOD_STORE) {
      data = Buffer.from(raw)
    } else {
      try {
        // Bounded by the declared size, so a bomb cannot expand past what was accounted for.
        data = inflateRawSync(raw, { maxOutputLength: Math.min(uncompressedSize, maxTotalBytes) })
      } catch {
        throw new ZipError('an entry could not be read')
      }
    }
    // The checksum the archive states, against the bytes that came out: a truncated or rewritten
    // entry is refused rather than restored.
    if (crc32(data) !== declaredCrc) throw new ZipError('an entry is corrupt')
    entries.push({ name, data })
  }
  return entries
}

/** Deflates a buffer, for tests that need a deflated entry to read back. */
export function deflateForTest(data: Buffer): Buffer {
  return deflateRawSync(data)
}
