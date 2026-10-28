import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { windowsUnsafeSegment } from '../src/widgets/routes.js'

describe('windowsUnsafeSegment', () => {
  it('names the reserved devices, with any extension and in any case, and a trailing dot or space', () => {
    for (const segment of ['CON', 'con', 'Nul.txt', 'aux.js', 'PRN', 'com1', 'COM9.png', 'lpt3.css', 'LPT¹', 'com².js',
      'conin$', 'CONOUT$', 'index.html.', 'index.html ', 'app.js...', '.', 'CON .txt', 'nul  .js', 'Aux. .css', 'com1 ']) {
      expect(windowsUnsafeSegment(segment), segment).toBe(true)
    }
    for (const segment of ['index.html', 'console.js', 'nullable.js', 'com.js', 'com10.js', 'lpt.css', 'auxiliary.png', 'icon.svg', '.well',
      'my con.txt', 'con-x.js', 'a.con.js']) {
      expect(windowsUnsafeSegment(segment), segment).toBe(false)
    }
  })
})

describe('the widget file route on Windows', () => {
  let dir: string
  let app: FastifyInstance
  let mac: FastifyInstance

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-widget-win-'))
    await mkdir(join(dir, 'widgets', 'clock'), { recursive: true })
    await writeFile(join(dir, 'widgets', 'clock', 'manifest.json'), JSON.stringify({ id: 'clock', name: 'Clock', version: '1.0.0', minSize: [4, 4], defaultSize: [4, 4] }))
    await writeFile(join(dir, 'widgets', 'clock', 'index.html'), '<!doctype html><title>w</title>')
    await writeFile(join(dir, 'widgets', 'clock', 'app.js'), 'console.log(1)')
    app = await buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets'), platform: 'win32' })
    mac = await buildApp({ accessToken: null, dataDir: join(dir, 'data-mac'), widgetsDir: join(dir, 'widgets'), platform: 'darwin' })
  })
  afterAll(async () => {
    await app?.close()
    await mac?.close()
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  it('refuses a device name or a stripped trailing dot before touching the disk', async () => {
    for (const url of ['/widgets/clock/CON', '/widgets/clock/nul.js', '/widgets/clock/sub/aux', '/widgets/clock/COM1.png',
      '/widgets/clock/index.html.', '/widgets/clock/app.js%20', '/widgets/clock/lpt1/app.js', '/widgets/clock/CON%20.txt', '/widgets/clock/nul%20%20.js']) {
      expect((await app.inject({ url })).statusCode, url).toBe(400)
    }
    expect((await app.inject({ url: '/widgets/clock/app.js' })).statusCode).toBe(200)
    expect((await app.inject({ url: '/widgets/clock/index.html' })).body).toContain('/fremkit.js')
  })

  it('leaves the Mac as it was: such names are plain missing files there', async () => {
    expect((await mac.inject({ url: '/widgets/clock/nul.js' })).statusCode).toBe(404)
  })
})
