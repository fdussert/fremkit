// The toolbar popup: the Fremkit header with the link state, the Fremplay and Fremdev cards,
// and the pairing view while the browser is not linked. Everything it shows comes from
// chrome.storage, which the worker writes; it asks the worker to act and re-renders on changes.

import { localize, t } from './i18n.js'
import { browserName } from './lib/browser.js'
import { BUILTIN_PERMISSION_ORIGINS, parsePattern } from './lib/devhosts.js'
import { fremplayBlocked, shareErrorKey } from './lib/errors.js'
import { cleanFrames, embeddedPlayer, pickVideo, survey } from './lib/video.js'

localize()

const $ = (id) => document.getElementById(id)
const ask = (type, extra = {}) => chrome.runtime.sendMessage({ target: 'worker', type, ...extra }).catch(() => null)

const PAIR_ERRORS = {
  refused: () => t('pairRefused'),
  expired: () => t('pairExpired'),
  limited: () => t('pairLimited'),
  busy: () => t('pairBusy'),
  cooldown: () => t('pairCooldown'),
  exhausted: () => t('pairExhausted'),
  locked: () => t('pairLocked'),
  disabled: () => t('pairDisabled'),
  impostor: () => t('linkImpostor'),
  unreachable: () => t('pairUnreachable'),
  failed: () => t('pairFailed'),
}
const CODE_ERRORS = {
  wrongCode: () => t('pairWrongCode'),
  badCode: () => t('pairBadCode'),
  busy: () => t('pairChecking'),
}
const LINKS = {
  ok: ['ok', () => t('linkOk')],
  connecting: ['wait', () => t('linkConnecting')],
  unreachable: ['ko', () => t('linkUnreachable')],
  revoked: ['ko', () => t('linkRevoked')],
  refused: ['ko', () => t('linkRefused')],
  impostor: ['ko', () => t('linkImpostor')],
  unpaired: ['', () => t('linkUnpaired')],
}

const browser = browserName(navigator.userAgentData?.brands)
let local = {}
let session = {}
let tab = null
/** What the popup found in the tab: the main video, or an embedded player to ask access for. */
const video = { checked: false, picked: null, askOrigin: null, restricted: false }
let busy = false
/** A start is under way: the popup closes once it is accepted, from the reply or from storage. */
let starting = false
let shownError = null
/** What the last typed code got, until the next try: `wrongCode`, `badCode`, … */
let codeError = null
/** Fremdev is being turned on or off; the key of the message under its card, if any. */
let fremdevBusy = false
let fremdevError = null

const hostOf = (url) => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

async function inspectTab() {
  video.checked = false
  video.picked = null
  video.askOrigin = null
  video.restricted = false
  if (!Number.isInteger(tab?.id) || tab.id < 0) {
    video.restricted = true
  } else {
    try {
      // The popup's activeTab grant lets it look before offering the button.
      const frames = cleanFrames(await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: survey }))
      video.picked = pickVideo(frames)
      const origin = embeddedPlayer(frames, video.picked)
      if (origin && !(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) video.askOrigin = origin
    } catch {
      // chrome:// pages, the Web Store, the PDF viewer…
      video.restricted = true
    }
  }
  video.checked = true
}

/** Linked as far as the popup shows it: a token the server has not said is removed (worker `removed`). */
const isPaired = () => Boolean(local.token) && !local.revoked

function renderLink() {
  const paired = isPaired()
  const link = paired ? (session.link === 'unpaired' ? 'connecting' : (session.link ?? 'connecting')) : local.revoked ? 'revoked' : 'unpaired'
  const [cls, label] = LINKS[link] ?? LINKS.connecting
  $('link').className = `pill ${cls}`
  $('linktext').textContent = label()
  $('device').textContent = paired ? t('footerLinked', local.name || browser) : t('footerUnpaired', browser)
}

function renderPairing() {
  const now = Date.now()
  const pending = local.pairing && local.pairing.expiresAt > now ? local.pairing : null
  $('connect').hidden = Boolean(pending)
  $('connect').disabled = busy
  // The code is never shown here: it is on the Edge, which only the real Fremkit can write to,
  // and typing it is what pairs (lib/pairProof.js).
  $('code').hidden = !pending
  if (!pending) codeError = null
  if (pending) {
    const left = Math.ceil((pending.expiresAt - now) / 1000)
    $('valid').textContent = t('pairValid', `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`)
    $('typed').disabled = busy
    $('confirm').disabled = busy
  }
  const typedError = pending && codeError ? (CODE_ERRORS[codeError] ?? PAIR_ERRORS.failed)() : null
  $('codeerror').hidden = !typedError
  $('codeerror').textContent = typedError ?? ''
  // Shown removed with the token kept: the 4401 came before any proof, so another program holding
  // Fremkit's port may have sent it to get this browser to pair with it instead.
  $('removedwarn').hidden = !(local.revoked && local.token)
  const error = pending ? null : (PAIR_ERRORS[local.pairError]?.() ?? (local.revoked ? t('pairRevoked') : null))
  $('pairerror').hidden = !error
  $('pairerror').textContent = error ?? ''
}

function renderShortcut(shortcut) {
  const hint = $('hint')
  hint.replaceChildren()
  if (!shortcut) {
    hint.textContent = t('shortcutNone')
    return
  }
  hint.append(`${t('shortcut')} `)
  // macOS gives "⌃⇧F", the others "Ctrl+Shift+F".
  for (const key of shortcut.includes('+') ? shortcut.split('+') : [...shortcut]) {
    const kbd = document.createElement('kbd')
    kbd.textContent = key
    hint.append(kbd)
  }
}

function renderFremplay() {
  const share = session.share ?? null
  const here = Boolean(share) && share.tabId === tab?.id
  const elsewhere = Boolean(share) && !here

  $('ttitle').textContent = tab?.title ?? ''
  $('thost').textContent = hostOf(tab?.url)
  const icon = tab?.favIconUrl
  $('favicon').src = icon && /^(https?|data):/.test(icon) ? icon : 'icons/icon-16.png'

  $('live').hidden = !share
  $('livetext').textContent = here ? t('liveHere') : elsewhere ? t('liveElsewhere', share.meta?.title || share.meta?.host || '') : ''

  // Fremkit said Fremplay is off: Send is greyed and the card says why, whatever the tab holds.
  const blocked = fremplayBlocked(session)
  const canStart = !blocked && video.checked && !video.restricted && Boolean(video.picked || video.askOrigin)
  const go = $('go')
  go.hidden = here
  go.disabled = busy || !canStart
  go.textContent = !blocked && video.checked && !video.restricted && !canStart ? t('noVideo') : elsewhere ? t('sendInstead') : t('send')
  $('stop').hidden = !share
  $('stop').disabled = busy

  // The exact origin the browser will be asked for, before the click that asks: the page decided
  // which frame looked like a player, so the user judges whether that site should be let in.
  const askOrigin = video.askOrigin && !here ? video.askOrigin : null
  $('ask').hidden = !askOrigin
  $('ask').textContent = askOrigin ? t('askAccess', askOrigin) : ''

  const error = blocked ? t(blocked.key) : shownError ? t(shareErrorKey(shownError)) : video.restricted && !here ? t('errCapture') : null
  $('error').hidden = !error
  $('error').textContent = error ?? ''
}

const fremdevOn = () => local.fremdev?.on === true

/** What Fremkit said of Fremdev (worker `fremdevSupport`): its line under the card, or none. */
const FREMDEV_NOTES = { unsupported: 'fremdevUnsupported', disabled: 'fremdevDisabled' }

function renderFremdev() {
  const on = fremdevOn()
  const note = FREMDEV_NOTES[session.fremdevSupport] ?? null
  const sw = $('fremdevswitch')
  sw.setAttribute('aria-checked', String(on))
  // Greyed while Fremkit cannot take it, but only while off: Fremdev left on before Fremkit was
  // downgraded or its experimental switch turned off must still be turnable off from here, or its
  // scripts would stay registered on the dev hosts with no way out but Chrome's settings.
  sw.disabled = fremdevBusy || (Boolean(note) && !on)
  $('fremdevicon').classList.toggle('on', on && !note)
  const n = on && !note ? Object.keys(session.devTabs ?? {}).length : null
  $('fremdevtabs').hidden = n === null
  $('fremdevtabs').textContent = n === null ? '' : n === 0 ? t('fremdevTabsNone') : n === 1 ? t('fremdevTabsOne') : t('fremdevTabs', n)
  $('fremdevnote').hidden = !note
  $('fremdevnote').textContent = note ? t(note) : ''
  $('fremdeverror').hidden = !fremdevError
  $('fremdeverror').textContent = fremdevError ? t(fremdevError) : ''
}

function render() {
  const paired = isPaired()
  renderLink()
  $('menu').hidden = !paired
  $('pair').hidden = paired
  if (paired) {
    renderFremplay()
    renderFremdev()
  } else renderPairing()
}

async function startHere() {
  const res = await ask('start', { tabId: tab.id })
  busy = false
  starting = false
  if (res?.ok) return window.close()
  shownError = res?.error ?? 'failed'
  ask('seen')
  render()
}

$('go').addEventListener('click', () => {
  if (busy || !tab) return
  busy = true
  starting = true
  shownError = null
  render()
  const origin = video.askOrigin
  if (!origin) return void startHere()
  // A player from another site: its permission is asked now, within the click. The browser's
  // prompt may close this popup, so the worker is told first and starts the share once granted.
  ask('expectGrant', { tabId: tab.id, origin })
  chrome.permissions.request({ origins: [`${origin}/*`] }).then(
    (granted) => {
      // Granted: the worker starts it, and the storage change tells this popup how it went.
      if (!granted) startHere()
    },
    () => startHere(),
  )
})

$('fremdevswitch').addEventListener('click', () => {
  if (fremdevBusy) return
  fremdevError = null
  if (fremdevOn()) {
    // Off keeps webRequest and the dev origins: the next turn-on asks nothing.
    fremdevBusy = true
    render()
    ask('fremdevOff').then(() => {
      fremdevBusy = false
      render()
    })
    return
  }
  // Asked here, within the click (the worker has no gesture): webRequest and every dev origin,
  // the built-in hosts and the user's patterns, in one prompt.
  const patterns = Array.isArray(local.fremdev?.patterns) ? local.fremdev.patterns : []
  const origins = [...new Set([...BUILTIN_PERMISSION_ORIGINS, ...patterns.flatMap((p) => parsePattern(p)?.permissions ?? [])])]
  // Chrome's prompt may close this popup before it can say `fremdevOn`: the worker is told first and
  // turns Fremdev on itself when the grant lands (fremdev.js `expectGrant`); a start from both joins.
  ask('expectFremdev')
  const asked = chrome.permissions.request({ permissions: ['webRequest'], origins })
  fremdevBusy = true
  render()
  asked
    .then(
      async (granted) => {
        if (!granted) fremdevError = 'fremdevNeedsAccess'
        else if (!(await ask('fremdevOn'))?.ok) fremdevError = 'fremdevFailed'
      },
      () => {
        fremdevError = 'fremdevNeedsAccess'
      },
    )
    .finally(() => {
      fremdevBusy = false
      render()
    })
})

$('stop').addEventListener('click', async () => {
  busy = true
  render()
  await ask('stop')
  busy = false
  shownError = null
  render()
})

$('connect').addEventListener('click', async () => {
  busy = true
  codeError = null
  render()
  await ask('pair')
  busy = false
  render()
  $('typed').value = ''
  $('typed').focus()
})

$('code').addEventListener('submit', async (e) => {
  e.preventDefault()
  if (busy) return
  busy = true
  codeError = null
  render()
  const res = await ask('confirmCode', { code: $('typed').value })
  busy = false
  // Paired: the storage change renders the menu. A wrong code is cleared for the next try.
  if (!res?.ok) {
    codeError = res?.error ?? 'failed'
    $('typed').value = ''
  }
  render()
  if (!res?.ok) $('typed').focus()
})

$('settings').addEventListener('click', (e) => {
  e.preventDefault()
  chrome.runtime.openOptionsPage()
  window.close()
})

chrome.storage.onChanged.addListener((changes, area) => {
  const target = area === 'local' ? local : area === 'session' ? session : null
  if (!target) return
  for (const [key, { newValue }] of Object.entries(changes)) target[key] = newValue
  // A start the worker ran after a permission prompt: close on success, show its error otherwise.
  if (starting && session.share?.tabId === tab?.id && session.share?.accepted) return window.close()
  if (starting && area === 'session' && changes.lastError?.newValue) {
    busy = false
    starting = false
    shownError = changes.lastError.newValue
    ask('seen')
  }
  // Just paired: look at the tab for the menu.
  if (area === 'local' && changes.token?.newValue && !changes.token.oldValue) inspectTab().then(render)
  render()
})

async function main() {
  ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  local = await chrome.storage.local.get(null)
  session = await chrome.storage.session.get(null)
  if (session.lastError) {
    shownError = session.lastError
    ask('seen')
  }
  render()
  ask('open')
  // The pairing's time left counts down; the share's title changes under the menu.
  setInterval(() => !isPaired() && render(), 1000)
  const commands = await chrome.commands.getAll()
  renderShortcut(commands.find((c) => c.name === 'fremplay-toggle')?.shortcut)
  if (isPaired()) {
    await inspectTab()
    render()
  }
}

main().catch(() => {
  shownError = 'failed'
  render()
})
