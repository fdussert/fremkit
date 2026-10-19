// The options page: whether this browser is linked and under which name, unlinking, and the
// Fremplay shortcut (changed on the browser's own shortcut page).

import { localize, t } from './i18n.js'

localize()

const $ = (id) => document.getElementById(id)

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

// A page cannot link to chrome://; the tabs API may open it.
$('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }))

chrome.storage.onChanged.addListener(() => render())
window.addEventListener('focus', () => render())
render()
