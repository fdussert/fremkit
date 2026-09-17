import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  concatListLine,
  createBambuRtspCamera,
  ffmpegArgs,
  FFMPEG_MISSING,
  resolveFfmpeg,
  rtspUrl,
  splitJpegFrames,
  sweepStaleCameraDirs,
  type FfmpegProcessLike,
  type FfmpegSpawnOptions,
} from '../src/providers/bambu-rtsp.js'
import { BambuCameras, cameraTransport } from '../src/bambu/cameras.js'

/** A minimal JPEG: the markers the splitter looks for, with `size` bytes in all. */
function jpeg(size: number, fill = 0x2a): Buffer {
  const body = Buffer.alloc(size, fill)
  body[0] = 0xff; body[1] = 0xd8; body[2] = 0xff
  body[size - 2] = 0xff; body[size - 1] = 0xd9
  return body
}

describe('splitJpegFrames', () => {
  it('cuts one frame and keeps nothing', () => {
    const one = jpeg(64)
    const parsed = splitJpegFrames(one)
    expect(parsed.frames).toHaveLength(1)
    expect(parsed.frames[0].equals(one)).toBe(true)
    expect(parsed.rest.length).toBe(0)
  })

  it('cuts several frames out of one chunk', () => {
    const a = jpeg(40, 0x11)
    const b = jpeg(60, 0x22)
    const parsed = splitJpegFrames(Buffer.concat([a, b]))
    expect(parsed.frames.map((f) => f.length)).toEqual([40, 60])
    expect(parsed.frames[1].equals(b)).toBe(true)
  })

  it('keeps a half-arrived frame as the tail instead of emitting it', () => {
    const whole = jpeg(50)
    const parsed = splitJpegFrames(Buffer.concat([whole, whole.subarray(0, 20)]))
    expect(parsed.frames).toHaveLength(1)
    expect(parsed.rest.length).toBe(20)
  })

  it('reassembles a frame split across two chunks', () => {
    const whole = jpeg(80, 0x33)
    const first = splitJpegFrames(whole.subarray(0, 31))
    expect(first.frames).toHaveLength(0)
    const second = splitJpegFrames(Buffer.concat([first.rest, whole.subarray(31)]))
    expect(second.frames).toHaveLength(1)
    expect(second.frames[0].equals(whole)).toBe(true)
  })

  it('skips whatever is not a picture and resynchronises on the next marker', () => {
    const noise = Buffer.from([0x00, 0x01, 0xff, 0x02, 0x7f])
    const parsed = splitJpegFrames(Buffer.concat([noise, jpeg(48, 0x44)]))
    expect(parsed.frames).toHaveLength(1)
    expect(parsed.frames[0].length).toBe(48)
    expect(parsed.rest.length).toBe(0)
  })
})

describe('ffmpegArgs', () => {
  it('feeds the list file to the concat demuxer, so no URL reaches argv', () => {
    const args = ffmpegArgs('list', '/tmp/x/stream.txt')
    expect(args).toContain('concat')
    expect(args[args.indexOf('-i') + 1]).toBe('/tmp/x/stream.txt')
    expect(args.join(' ')).not.toContain('rtsps://')
    expect(args.join(' ')).toContain('image2pipe')
  })

  it('passes the URL directly in the fallback form', () => {
    const args = ffmpegArgs('argv', 'rtsps://bblp:code@printer:322/streaming/live/1')
    expect(args[args.indexOf('-i') + 1]).toBe('rtsps://bblp:code@printer:322/streaming/live/1')
    expect(args).toContain('-rtsp_transport')
  })

  it('builds the printer’s stream URL and escapes a quote in the list line', () => {
    expect(rtspUrl('printer.local', 'abc12345')).toBe('rtsps://bblp:abc12345@printer.local:322/streaming/live/1')
    expect(concatListLine("rtsps://a'b")).toBe("file 'rtsps://a'\\''b'\n")
  })
})

describe('resolveFfmpeg', () => {
  it('finds nothing when PATH is empty and no package manager installed one', () => {
    // The fallback list is real, so this only asserts the shape of the answer.
    const found = resolveFfmpeg({ PATH: '' } as NodeJS.ProcessEnv)
    expect(found === null || found.endsWith('/ffmpeg')).toBe(true)
  })
})

/** A fake ffmpeg: records how it was launched and lets a test push stdout or kill it. */
function fakeFfmpeg() {
  const runs: FfmpegSpawnOptions[] = []
  const live: { stdout: (c: Buffer) => void; exit: () => void; killed: number }[] = []
  const spawnProcess = (opts: FfmpegSpawnOptions): FfmpegProcessLike => {
    runs.push(opts)
    const run = { stdout: (_c: Buffer) => {}, exit: () => {}, killed: 0 }
    live.push(run)
    return {
      onStdout: (cb) => { run.stdout = cb },
      onExit: (cb) => { run.exit = cb },
      kill: () => { run.killed += 1 },
    }
  }
  return { runs, live, spawnProcess, last: () => live[live.length - 1] }
}

describe('createBambuRtspCamera', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const build = (fake: ReturnType<typeof fakeFfmpeg>, resolve = () => '/usr/bin/ffmpeg' as string | null) =>
    createBambuRtspCamera({ host: 'printer.local', accessCode: 'code', spawnProcess: fake.spawnProcess, resolve, writeList: () => ({ path: '/tmp/list.txt', cleanup: () => {} }) })

  it('keeps only the last frame of what ffmpeg wrote', () => {
    const fake = fakeFfmpeg()
    const camera = build(fake)
    camera.start()
    fake.last().stdout(Buffer.concat([jpeg(40, 0x11), jpeg(50, 0x22)]))
    expect(camera.state).toBe('streaming')
    expect(camera.latest()?.jpeg.length).toBe(50)
    camera.stop()
  })

  it('reports a missing ffmpeg as its own error code and does not retry', () => {
    const fake = fakeFfmpeg()
    const camera = build(fake, () => null)
    camera.start()
    expect(camera.state).toBe('error')
    expect(camera.errorCode).toBe(FFMPEG_MISSING)
    vi.advanceTimersByTime(120_000)
    expect(fake.runs).toHaveLength(0)
    camera.stop()
  })

  it('falls back to the plain -i form when the concat run dies straight away', () => {
    const fake = fakeFfmpeg()
    const camera = build(fake)
    camera.start()
    expect(fake.runs[0].args).toContain('concat')
    fake.last().exit()
    vi.advanceTimersByTime(2000)
    expect(fake.runs).toHaveLength(2)
    expect(fake.runs[1].args).not.toContain('concat')
    expect(fake.runs[1].args.join(' ')).toContain('rtsps://')
    camera.stop()
  })

  it('stays on the list form once a frame proved it works', () => {
    const fake = fakeFfmpeg()
    const camera = build(fake)
    camera.start()
    fake.last().stdout(jpeg(40))
    fake.last().exit()
    vi.advanceTimersByTime(2000)
    expect(fake.runs).toHaveLength(2)
    expect(fake.runs[1].args).toContain('concat')
    camera.stop()
  })

  it('backs off between reconnections and resets after a frame', () => {
    const fake = fakeFfmpeg()
    const camera = build(fake)
    camera.start()
    fake.last().exit()
    vi.advanceTimersByTime(1999)
    expect(fake.runs).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(fake.runs).toHaveLength(2)
    fake.last().exit()
    vi.advanceTimersByTime(3999)
    expect(fake.runs).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(fake.runs).toHaveLength(3)
  })

  it('kills a silent ffmpeg rather than waiting on it forever', () => {
    const fake = fakeFfmpeg()
    const camera = build(fake)
    camera.start()
    const first = fake.last()
    vi.advanceTimersByTime(20_000)
    expect(first.killed).toBe(1)
    expect(camera.state).toBe('error')
    camera.stop()
  })

  it('kills ffmpeg and drops the picture on stop', () => {
    const fake = fakeFfmpeg()
    const camera = build(fake)
    camera.start()
    fake.last().stdout(jpeg(40))
    camera.stop()
    expect(fake.live[0].killed).toBe(1)
    expect(camera.latest()).toBeNull()
    expect(camera.state).toBe('idle')
    vi.advanceTimersByTime(60_000)
    expect(fake.runs).toHaveLength(1)
  })
})

describe('cameraTransport', () => {
  it('sends X1 and H2 printers to RTSPS and everything else to port 6000', () => {
    for (const model of ['X1C', 'X1E', 'H2C', 'H2D', 'H2S', 'h2c']) expect(cameraTransport(model)).toBe('rtsp')
    for (const model of ['P1S', 'P1P', 'A1', 'A1 mini', 'autre', '', undefined]) expect(cameraTransport(model)).toBe('tls')
  })
})

describe('BambuCameras transport choice', () => {
  it('spawns ffmpeg for an H2 and opens a socket for a P1', () => {
    const fake = fakeFfmpeg()
    const dialled: string[] = []
    const cameras = new BambuCameras({
      spawnProcess: fake.spawnProcess,
      resolveFfmpeg: () => '/usr/bin/ffmpeg',
      connectTls: () => {
        dialled.push('tls')
        return { onReady: () => {}, onData: () => {}, onClose: () => {}, write: () => {}, end: () => {} }
      },
    })
    cameras.configure('bambu-h2', { host: 'printer.local', accessCode: 'code', model: 'H2C' })
    cameras.configure('bambu-p1', { host: 'printer.local', accessCode: 'code', model: 'P1S' })
    cameras.snapshot('bambu-h2')
    cameras.snapshot('bambu-p1')
    expect(fake.runs).toHaveLength(1)
    expect(dialled).toEqual(['tls'])
    cameras.stopAll()
  })

  it('rebuilds the camera when the model switches protocol', () => {
    const fake = fakeFfmpeg()
    const cameras = new BambuCameras({ spawnProcess: fake.spawnProcess, resolveFfmpeg: () => '/usr/bin/ffmpeg' })
    cameras.configure('bambu-x', { host: 'printer.local', accessCode: 'code', model: 'P1S' })
    cameras.configure('bambu-x', { host: 'printer.local', accessCode: 'code', model: 'H2C' })
    cameras.snapshot('bambu-x')
    expect(fake.runs).toHaveLength(1)
    cameras.stopAll()
  })
})

describe('concatListLine and a URL that is not one', () => {
  it('escapes a single quote, which is all the concat format escapes', () => {
    expect(concatListLine("rtsps://a'b/stream")).toBe("file 'rtsps://a'\\''b/stream'\n")
  })
  it('refuses a newline rather than escaping it', () => {
    // A newline ends the line and the rest would be read as a second concat directive. There is
    // no escape for it in that format, and no real URL carries one.
    for (const url of ['rtsps://host/s\nfile /etc/passwd', 'rtsps://host/s\r\nfile /etc/passwd', 'a\rb']) {
      expect(() => concatListLine(url), JSON.stringify(url)).toThrow(/invalide/)
    }
  })
})

describe('sweepStaleCameraDirs', () => {
  it('removes only the directories this server makes', () => {
    const removed: string[] = []
    const swept = sweepStaleCameraDirs({
      tmp: '/tmp-x',
      readdir: (() => ['fremkit-cam-abc', 'fremkit-cam-def', 'com.apple.something', 'unrelated']) as never,
      rm: ((p: string) => { removed.push(String(p)) }) as never,
    })
    expect(swept).toBe(2)
    expect(removed).toEqual(['/tmp-x/fremkit-cam-abc', '/tmp-x/fremkit-cam-def'])
  })
  it('says nothing when the temp directory cannot be read', () => {
    expect(sweepStaleCameraDirs({ readdir: (() => { throw new Error('EACCES') }) as never })).toBe(0)
  })
  it('keeps going when one directory refuses to go', () => {
    let calls = 0
    const swept = sweepStaleCameraDirs({
      tmp: '/tmp-x',
      readdir: (() => ['fremkit-cam-a', 'fremkit-cam-b']) as never,
      rm: (() => { if (calls++ === 0) throw new Error('EBUSY') }) as never,
    })
    expect(swept).toBe(1)
  })
})
