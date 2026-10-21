// The throwaway TLS server the Android app's instrumented WebView tests load pages from
// (android/app/src/androidTest/…/DashboardWebViewTest.kt). Started and stopped by
// `scripts/build-android.sh device-test`; nothing else runs it.
//
//   node scripts/android-test-server.mjs <lan-address> <first-port>
//
// It listens on the Mac's LAN address (the Mac's own server answers 421 over loopback, so the
// tablet reaches the Mac the way it will for real), on three ports from <first-port>:
//
//   main   key A   the "Mac": the test pages, /seen and /reset
//   other  key A   another origin under the same key (for main-frame navigations)
//   wrong  key B   the same host with another key (a Mac whose key changed, or an impostor)
//
// Both keys are P-256, made fresh for each run in a 0700 temporary folder that is removed once
// they are read; nothing is written anywhere else. It prints one line,
// `READY {"main":…,"other":…,"wrong":…,"pinA":"…","pinB":"…"}`: public test data (the pins of two
// throwaway keys), which the script hands to the instrumentation. No token exists here: the tests
// send a made-up one, and the server records only whether a `fremkit_device` cookie came.
//
// What it saw (port, method, path, cookie present, WebSocket) is answered by GET /seen on main,
// and forgotten with GET /reset?scenario=<name>, which also picks the page main serves at `/`.
// No dependency: node's https and crypto, and /usr/bin/openssl for the certificates.
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [host, first] = process.argv.slice(2)
if (!host || !/^\d+$/.test(first ?? '')) {
  console.error('usage: node scripts/android-test-server.mjs <lan-address> <first-port>')
  process.exit(2)
}
const MAIN = Number(first)
const OTHER = MAIN + 1
const WRONG = MAIN + 2

function makeKey(dir, name) {
  const key = path.join(dir, `${name}.key`)
  const cert = path.join(dir, `${name}.crt`)
  execFileSync('/usr/bin/openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key])
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-new', '-key', key, '-out', cert, '-days', '2',
    '-subj', '/CN=fremkit-device-test', '-addext', `subjectAltName=IP:${host}`], { stdio: 'ignore' })
  const pem = { key: readFileSync(key), cert: readFileSync(cert) }
  const spki = new X509Certificate(pem.cert).publicKey.export({ type: 'spki', format: 'der' })
  return { ...pem, pin: createHash('sha256').update(spki).digest('base64url') }
}

const dir = mkdtempSync(path.join(tmpdir(), 'fremkit-android-test-'))
let a, b
try {
  a = makeKey(dir, 'a')
  b = makeKey(dir, 'b')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

let seen = []
let scenario = 'basic'

const origin = (port) => `https://${host}:${port}`

/** The page main serves at `/`: each scenario posts what it found through the app's listener. */
function page(cookie) {
  const say = `function say(id) { if (window.fremkit) { try { fremkit.postMessage(JSON.stringify({ type: 'screen', screenId: id })) } catch (e) {} } }`
  const bodies = {
    basic: `say('loaded:cookie=${cookie ? 'yes' : 'no'}')
      var ws = new WebSocket('wss://' + location.host + '/ws')
      ws.onopen = function () { say('ws:open') }
      ws.onerror = function () { say('ws:error') }`,
    'wss-wrong': `say('loaded')
      var ws = new WebSocket('wss://${host}:${WRONG}/ws')
      ws.onopen = function () { say('ws:open') }
      ws.onerror = function () { say('ws:error') }`,
    'nav-get': `say('loaded')
      setTimeout(function () { location.href = '${origin(OTHER)}/' }, 300)
      setTimeout(function () { say('still-here') }, 2500)`,
    'nav-post': `say('loaded')
      setTimeout(function () { document.getElementById('f').submit() }, 300)`,
    frames: `say('loaded')
      window.addEventListener('message', function (e) {
        if (e.data && e.data.frame) say('frame-loaded:' + e.data.frame + ':' + e.data.fremkit)
      })
      ;['/widgets/ok/index.html', '/admin', '/widgets/%2e%2e/admin', '/notwidget.html'].forEach(function (src) {
        var f = document.createElement('iframe'); f.src = src; document.body.appendChild(f)
      })
      setTimeout(function () { say('from-main') }, 3000)`,
    gum: `say('loaded')
      navigator.mediaDevices.getUserMedia({ video: true }).then(
        function () { say('gum:allowed') },
        function (e) { say('gum:rejected:' + e.name) })`,
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>device test</title></head><body style="background:#000;color:#fff">
<form id="f" method="POST" action="${origin(OTHER)}/post"><input name="x" value="1"></form>
<script>${say}
${bodies[scenario] ?? `say('unknown-scenario')`}
</script></body></html>`
}

const widget = `<!doctype html><html><body><script>
parent.postMessage({ frame: 'ok', fremkit: typeof window.fremkit }, '*')
if (window.fremkit) { try { fremkit.postMessage(JSON.stringify({ type: 'screen', screenId: 'from-frame' })) } catch (e) {} }
</script></body></html>`

function handler(port) {
  return (req, res) => {
    const url = new URL(req.url, 'https://x')
    const cookie = /(?:^|;\s*)fremkit_device=/.test(req.headers.cookie ?? '')
    const send = (status, type, body) => {
      // No keep-alive: every load is a new TLS connection, so what a test sees is the WebView's
      // certificate decision and not a pooled socket opened under an earlier one.
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', connection: 'close' })
      res.end(body)
    }
    if (port === MAIN && url.pathname === '/seen') return send(200, 'application/json', JSON.stringify(seen))
    if (port === MAIN && url.pathname === '/reset') {
      seen = []
      scenario = url.searchParams.get('scenario') ?? 'basic'
      return send(200, 'application/json', '{}')
    }
    seen.push({ port, method: req.method, path: req.url, cookie, ws: false })
    if (url.pathname === '/') return send(200, 'text/html', port === MAIN ? page(cookie) : '<!doctype html><title>x</title>')
    if (url.pathname === '/widgets/ok/index.html') return send(200, 'text/html', widget)
    if (url.pathname === '/favicon.ico') return send(404, 'text/plain', '')
    return send(200, 'text/html', '<!doctype html><title>not a widget</title>')
  }
}

/** Enough of a WebSocket server for `onopen`: the handshake, then silence. */
function upgrade(port) {
  return (req, socket) => {
    const cookie = /(?:^|;\s*)fremkit_device=/.test(req.headers.cookie ?? '')
    seen.push({ port, method: 'GET', path: req.url, cookie, ws: true })
    const key = req.headers['sec-websocket-key']
    if (!key) return socket.destroy()
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('error', () => {})
  }
}

const servers = [[MAIN, a], [OTHER, a], [WRONG, b]].map(([port, creds]) => {
  const server = https.createServer({ key: creds.key, cert: creds.cert }, handler(port))
  server.on('upgrade', upgrade(port))
  server.on('tlsClientError', () => {})
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
})

const running = await Promise.all(servers).catch((e) => {
  console.error(`android-test-server: ${e.message}`)
  process.exit(1)
})
console.log('READY ' + JSON.stringify({ main: MAIN, other: OTHER, wrong: WRONG, pinA: a.pin, pinB: b.pin }))

function stop() {
  for (const s of running) s.close()
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
