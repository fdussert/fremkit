// The toolbar popup: the Fremkit header with the link state, the Fremplay and Fremdev cards,
// and the pairing view while the browser is not linked. Everything it shows comes from
// chrome.storage, which the worker writes; it asks the worker to act and re-renders on changes.

import { localize, t } from './i18n.js'
import { browserName } from './lib/browser.js'
import { BUILTIN_PERMISSION_ORIGINS, parsePattern } from './lib/devhosts.js'
import { homePath } from './lib/devlog.js'
import { clearBeforeCapture, dataUrlBlob, thumbOf } from './lib/devshot.js'
import { dismissShotOverlay } from './lib/shotview.js'
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
  unseen: () => t('pairUnseen'),
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
/** tabId → 'done' | 'failed': what the last Copy report of that tab gave, shown for COPY_SHOWN_MS. */
const copied = new Map()
/** tabId → the timer that puts its button back. */
const copyTimers = new Map()
const COPY_SHOWN_MS = 2_000
/** The same two maps for Copy screenshot. */
const shotCopied = new Map()
const shotTimers = new Map()

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

/** A dev tab's light as the widget paints it (`stateOfTab` in widgets/fremdev/logic.js). */
function lightOf(row) {
  const open = (t) => (typeof t?.open === 'number' ? t.open : 0)
  const unseen = (t) => Math.max(0, open(t) - (typeof t?.seen === 'number' ? t.seen : 0))
  if (unseen(row.errors) > 0 || row.server === 'down') return 'red'
  if (unseen(row.requests) > 0) return 'orange'
  if (open(row.errors) > 0) return 'red seen'
  if (open(row.requests) > 0) return 'orange seen'
  return 'green'
}

/** Shows `outcome` on a tab's button for COPY_SHOWN_MS. One timer per tab and map: a second click restarts it. */
function flash(map, timers, tabId, outcome) {
  map.set(tabId, outcome)
  render()
  clearTimeout(timers.get(tabId))
  timers.set(tabId, setTimeout(() => {
    timers.delete(tabId)
    map.delete(tabId)
    render()
  }, COPY_SHOWN_MS))
}

/** The report comes from the worker; the clipboard is written here, still within the click. */
async function copyReport(tabId) {
  const res = await ask('fremdevReport', { tabId, stack: $('fremdevstack').checked })
  let outcome = 'failed'
  if (res?.ok && typeof res.text === 'string') {
    try {
      await navigator.clipboard.writeText(res.text)
      outcome = 'done'
    } catch { /* the popup lost focus */ }
  }
  flash(copied, copyTimers, tabId, outcome)
}

/** The popup's own tab, captured as PNG: the activeTab grant of this popup covers it. */
async function copyScreenshot(tabId) {
  let outcome = 'failed'
  try {
    // The Blob is a promise handed to ClipboardItem, so the write is made inside the click.
    // A thumbnail from a shot just before (⌃⇧S) leaves the tab first, so it is not in this one.
    const shot = clearBeforeCapture(() => chrome.scripting.executeScript({ target: { tabId }, func: dismissShotOverlay }))
      .then(() => chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }))
      .then(dataUrlBlob)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': shot })])
    outcome = 'done'
    // On the clipboard: the worker shows it in the tab and on the Edge, from a thumbnail made here.
    void thumbOf(await shot).then((thumb) => ask('fremdevShot', { tabId, thumb }))
  } catch (err) {
    // No capture right, or the popup lost focus. Only the reason is logged, never the image.
    console.warn('Fremdev: copy screenshot failed:', err?.message ?? err)
  }
  flash(shotCopied, shotTimers, tabId, outcome)
}

/** tabId → its list item, kept across renders: the rows change every 500 ms under an error storm, and a button rebuilt mid-press loses the click. */
const devItems = new Map()

function devItem(tabId) {
  let item = devItems.get(tabId)
  if (item) return item
  const li = document.createElement('li')
  const light = document.createElement('span')
  const title = document.createElement('span')
  title.className = 'dtitle'
  const button = document.createElement('button')
  button.type = 'button'
  button.addEventListener('click', () => void copyReport(tabId))
  const shotButton = document.createElement('button')
  shotButton.type = 'button'
  shotButton.addEventListener('click', () => void copyScreenshot(tabId))
  li.append(light, title, button, shotButton)
  item = { li, light, title, button, shotButton }
  devItems.set(tabId, item)
  return item
}

function renderDevTabs(rows) {
  const list = $('fremdevlist')
  const ids = new Set(rows.map((r) => r.tabId))
  for (const [id, item] of devItems) {
    if (ids.has(id)) continue
    item.li.remove()
    devItems.delete(id)
  }
  rows.forEach((row, i) => {
    const { li, light, title, button, shotButton } = devItem(row.tabId)
    light.className = `light ${lightOf(row)}`
    // The session copy keeps the page's own title: a home folder in it reads `~` here too.
    title.textContent = homePath(row.title || row.host || '')
    title.title = row.host || ''
    const state = copied.get(row.tabId)
    button.className = `ghost ${state ?? ''}`.trim()
    button.textContent = state === 'done' ? t('fremdevCopied') : state === 'failed' ? t('fremdevCopyFailed') : t('fremdevCopy')
    // Only the tab the popup was opened on can be captured (activeTab).
    shotButton.hidden = row.tabId !== tab?.id
    const shot = shotCopied.get(row.tabId)
    shotButton.className = `ghost ${shot ?? ''}`.trim()
    shotButton.textContent = shot === 'done' ? t('fremdevCopied') : shot === 'failed' ? t('fremdevCopyFailed') : t('fremdevShot')
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null)
  })
  list.hidden = rows.length === 0
  $('fremdevstackrow').hidden = rows.length === 0
}

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
  // Latest first, as on the Edge.
  const rows = n ? Object.values(session.devTabs).filter((r) => Number.isInteger(r?.tabId)).sort((a, b) => b.activity - a.activity) : []
  renderDevTabs(rows)
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
