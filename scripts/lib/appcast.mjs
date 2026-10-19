// Writes Sparkle's appcast for one release, and extracts that release's CHANGELOG section.
//
//   node scripts/lib/appcast.mjs notes <version> <CHANGELOG.md>
//       prints the section `## <version>` of the changelog (Markdown), or fails if there is none
//   node scripts/lib/appcast.mjs appcast <version> <build> <enclosure-url> <length> <ed-signature> <notes.md>
//       prints appcast.xml with a single item
//   node scripts/lib/appcast.mjs verify <file> <ed-signature> <public-key-base64>
//       fails unless the signature is the public key's over the file, i.e. what Sparkle will check
//
// One item is enough: the feed is the newest release's asset (see docs/releasing.md), and Sparkle
// only needs the newest update a given Mac can take. The release notes are the changelog section,
// turned into the little HTML Sparkle's window shows.
import { readFileSync } from 'node:fs'
import { createPublicKey, verify } from 'node:crypto'

const [command, ...args] = process.argv.slice(2)

function fail(message) {
  console.error(`appcast: ${message}`)
  process.exit(1)
}

function section(changelog, version) {
  const lines = readFileSync(changelog, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${version}` || line.startsWith(`## ${version} `))
  if (start < 0) fail(`no "## ${version}" section in ${changelog}`)
  let end = lines.findIndex((line, i) => i > start && line.startsWith('## '))
  if (end < 0) end = lines.length
  const body = lines.slice(start + 1, end).join('\n').trim()
  if (!body) fail(`the "## ${version}" section of ${changelog} is empty`)
  return body
}

const escapeXml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(text) {
  return escapeXml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
}

/** Headings, bullet lists (with wrapped continuation lines) and paragraphs: what the changelog uses. */
function toHtml(markdown) {
  const out = []
  let list = null
  let paragraph = null
  const flush = () => {
    if (list) out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`)
    if (paragraph) out.push(`<p>${inline(paragraph)}</p>`)
    list = null
    paragraph = null
  }
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd()
    const heading = /^(#{3,6})\s+(.*)$/.exec(line)
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (!line.trim()) {
      flush()
    } else if (heading) {
      flush()
      out.push(`<h3>${inline(heading[2])}</h3>`)
    } else if (bullet) {
      if (paragraph) flush()
      list ??= []
      list.push(bullet[1])
    } else if (list && /^\s+/.test(line)) {
      list[list.length - 1] += ' ' + line.trim()
    } else {
      if (list) flush()
      paragraph = paragraph ? `${paragraph} ${line.trim()}` : line.trim()
    }
  }
  flush()
  return out.join('\n')
}

if (command === 'notes') {
  const [version, changelog] = args
  if (!version || !changelog) fail('usage: notes <version> <CHANGELOG.md>')
  process.stdout.write(section(changelog, version) + '\n')
} else if (command === 'appcast') {
  const [version, build, url, length, signature, notes] = args
  if (!notes) fail('usage: appcast <version> <build> <enclosure-url> <length> <ed-signature> <notes.md>')
  if (!/^\d+$/.test(length)) fail(`length must be a byte count, got ${length}`)
  const html = toHtml(readFileSync(notes, 'utf8'))
  process.stdout.write(`<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Fremkit</title>
    <link>https://github.com/fdussert/fremkit</link>
    <item>
      <title>Fremkit ${escapeXml(version)}</title>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <sparkle:version>${escapeXml(build)}</sparkle:version>
      <sparkle:shortVersionString>${escapeXml(version)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      <description><![CDATA[${html.replaceAll(']]>', ']]&gt;')}]]></description>
      <enclosure url="${escapeXml(url)}" length="${length}" type="application/octet-stream" sparkle:edSignature="${escapeXml(signature)}"/>
    </item>
  </channel>
</rss>
`)
} else if (command === 'verify') {
  const [file, signature, publicKey] = args
  if (!publicKey) fail('usage: verify <file> <ed-signature> <public-key-base64>')
  const raw = Buffer.from(publicKey, 'base64')
  if (raw.length !== 32) fail('the public key is not a base64 Ed25519 key (32 bytes)')
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
  if (!verify(null, readFileSync(file), key, Buffer.from(signature, 'base64'))) {
    fail(`${file} is not signed by the key in the public key given: installed apps would refuse it`)
  }
} else {
  fail('usage: appcast.mjs notes|appcast|verify …')
}
