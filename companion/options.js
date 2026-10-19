// The options page: whether this browser is linked and under which name, unlinking, Fremdev's own
// development hosts, and the Fremplay shortcut (changed on the browser's own shortcut page).

import { localize, t } from './i18n.js'
import { BUILTIN_PERMISSION_ORIGINS, parsePattern } from './lib/devhosts.js'

localize()

const $ = (id) => document.getElementById(id)
const ask = (type) => chrome.runtime.sendMessage({ target: 'worker', type }).catch(() => null)

/** Never released when a pattern goes: Fremdev's built-in hosts and Fremkit's own port. */
const KEPT = new Set([...BUILTIN_PERMISSION_ORIGINS, 'http://127.0.0.1:4242/*'])
let hostsBusy = false

/**
 * Whether two `*://host/*` permissions cover a common host. Removing one would take the other's
 * hosts with it when it covers them, so either way the removal waits for the last pattern.
 */
function overlaps(a, b) {
  const host = (o) => /^\*:\/\/([^/]+)\/\*$/.exec(o)?.[1] ?? o
  const [ha, hb] = [host(a), host(b)]
  const under = (wild, h) => wild.startsWith('*.') && (h.replace(/^\*\./, '') === wild.slice(2) || h.endsWith(wild.slice(1)))
  return ha === hb || under(ha, hb) || under(hb, ha)
}

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
  const shortcut = commands.find((c) => c.name === 'fremplay-toggle')?.shortcut
  const hint = $('hint')
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
  const asked = chrome.permissions.request({ origins: [parsed.permission] })
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
    // `*-qa.example.com` share `*://*.example.com/*`) or it is one the extension keeps.
    const permission = parsePattern(pattern)?.permission
    const needed = rest.some((p) => overlaps(permission, parsePattern(p)?.permission ?? ''))
    if (permission && !needed && !KEPT.has(permission)) await chrome.permissions.remove({ origins: [permission] }).catch(() => false)
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
