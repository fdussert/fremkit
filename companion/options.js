// The options page: whether this browser is linked and under which name, unlinking, Fremdev's own
// development hosts, and the Fremplay and Fremdev shortcuts (changed on the browser's own shortcut page).

import { localize, t } from './i18n.js'
import { parsePattern, releasableOrigins } from './lib/devhosts.js'

localize()

const $ = (id) => document.getElementById(id)
const ask = (type) => chrome.runtime.sendMessage({ target: 'worker', type }).catch(() => null)

let hostsBusy = false

async function readFremdev() {
  const { fremdev } = await chrome.storage.local.get('fremdev')
  const saved = fremdev && typeof fremdev === 'object' ? fremdev : {}
  const patterns = Array.isArray(saved.patterns) ? saved.patterns.filter((p) => parsePattern(p)) : []
  return { saved, patterns }
}

async function savePatterns(saved, patterns) {
  await chrome.storage.local.set({ fremdev: { ...saved, patterns } })
  // The worker registers the scripts where the patterns now apply and drops the rows elsewhere.
  await ask('fremdevPatterns')
}

function showHostError(key) {
  $('hosterror').hidden = !key
  $('hosterror').textContent = key ? t(key) : ''
}

function renderHosts(patterns) {
  const list = $('devhosts')
  list.replaceChildren()
  for (const pattern of patterns) {
    const li = document.createElement('li')
    const code = document.createElement('code')
    code.textContent = pattern
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'ghost'
    remove.textContent = t('optDevHostRemove')
    remove.setAttribute('aria-label', t('optDevHostRemoveLabel', pattern))
    remove.disabled = hostsBusy
    remove.addEventListener('click', () => removeHost(pattern))
    li.append(code, remove)
    list.append(li)
  }
  list.hidden = patterns.length === 0
  $('devhostsnone').hidden = patterns.length > 0
  $('addbutton').disabled = hostsBusy
}

async function render() {
  const local = await chrome.storage.local.get(['token', 'name', 'revoked'])
  const { link } = await chrome.storage.session.get('link')
  const paired = Boolean(local.token)
  $('paired').hidden = !paired
  $('paired').textContent = paired ? t('optPairedAs', local.name || 'Chrome') : ''
  $('rename').hidden = !paired
  $('unpaired').hidden = paired
  $('unpair').hidden = !paired
  $('unpairhint').hidden = !paired
  const [cls, label] = !paired
    ? local.revoked ? ['ko', t('linkRevoked')] : ['', t('linkUnpaired')]
    : link === 'ok' ? ['ok', t('linkOk')] : link === 'unreachable' ? ['ko', t('linkUnreachable')] : ['wait', t('linkConnecting')]
  $('link').className = `pill ${cls}`
  $('linktext').textContent = label

  renderHosts((await readFremdev()).patterns)

  const commands = await chrome.commands.getAll()
  showShortcut($('hint'), commands.find((c) => c.name === 'fremplay-toggle')?.shortcut)
  showShortcut($('shothint'), commands.find((c) => c.name === 'fremdev-shot')?.shortcut)
}

/** A command's keys as `kbd`s, or the note that it has none. */
function showShortcut(hint, shortcut) {
  hint.replaceChildren()
  if (!shortcut) hint.textContent = t('shortcutNone')
  else {
    for (const key of shortcut.includes('+') ? shortcut.split('+') : [...shortcut]) {
      const kbd = document.createElement('kbd')
      kbd.textContent = key
      hint.append(kbd)
    }
  }
}

$('unpair').addEventListener('click', async () => {
  $('unpair').disabled = true
  await chrome.runtime.sendMessage({ target: 'worker', type: 'unpair' }).catch(() => null)
  $('unpair').disabled = false
  render()
})

$('addhost').addEventListener('submit', (e) => {
  e.preventDefault()
  if (hostsBusy) return
  const parsed = parsePattern($('newhost').value)
  if (!parsed) return showHostError('optDevHostInvalid')
  showHostError(null)
  // Asked within the submit: the browser takes a permission request only from the user's gesture.
  const asked = chrome.permissions.request({ origins: parsed.permissions })
  hostsBusy = true
  render()
  asked
    .then(
      async (granted) => {
        if (!granted) return showHostError('fremdevNeedsAccess')
        const { saved, patterns } = await readFremdev()
        if (!patterns.includes(parsed.pattern)) await savePatterns(saved, [...patterns, parsed.pattern])
        $('newhost').value = ''
      },
      () => showHostError('fremdevNeedsAccess'),
    )
    .finally(() => {
      hostsBusy = false
      render()
    })
})

async function removeHost(pattern) {
  if (hostsBusy) return
  hostsBusy = true
  showHostError(null)
  render()
  try {
    const { saved, patterns } = await readFremdev()
    const rest = patterns.filter((p) => p !== pattern)
    await savePatterns(saved, rest)
    // Its origin goes back unless another pattern still needs it (`*-dev.example.com` and
    // `*-qa.example.com` share `*.example.com`'s origins), it covers another grant (a Fremplay player's),
    // or it is one the extension keeps (lib/devhosts.js `releasableOrigins`).
    const { origins: held = [] } = await chrome.permissions.getAll()
    const release = releasableOrigins(pattern, rest, held)
    // A failed removal is left alone on purpose: the pattern is already gone, so Fremdev no longer
    // watches that host, and the leftover grant shows in Chrome's site settings for the user to drop.
    if (release) await chrome.permissions.remove({ origins: release }).catch(() => false)
  } finally {
    hostsBusy = false
    render()
  }
}

// A page cannot link to chrome://; the tabs API may open it.
$('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }))

chrome.storage.onChanged.addListener(() => render())
window.addEventListener('focus', () => render())
render()
