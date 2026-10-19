/**
 * The widget `pnpm widget:new` writes: a manifest, a page and a changelog that already follow
 * every rule of docs/writing-widgets.md and pass `pnpm widget:check`, so an author starts from
 * something that works and changes it, rather than from a blank page and a list of rules.
 *
 * Pure: it returns file contents and decides nothing about where they go. The command line in
 * `server/src/cli/widget.ts` does the asking, the refusing and the writing.
 */

import { WIDGET_ID_RE } from '../config/schema.js'
import { WIDGET_CATEGORIES, type WidgetCategory } from './manifest.js'

export interface ScaffoldOptions {
  id: string
  name: { fr: string; en: string }
  description: { fr: string; en: string }
  category: WidgetCategory
  /** `[cols, rows]` the widget is dropped at. */
  size: [number, number]
  /** The data channel it reads, or none: then it is a small touch counter. */
  channel?: string
  /** Who wrote it — required by the registry, so asked for; left out when not given. */
  author?: string
  /** The bar width, in cells, of its compact rendering; none for a widget with no bar form. */
  compact?: number
}

/** Why an id cannot be a widget's, or null when it can. The catalogue's own rule. */
export function idProblem(id: string): string | null {
  if (id === '') return 'the id is empty'
  if (!WIDGET_ID_RE.test(id)) return `"${id}" is not a widget id: lowercase letters, digits, - and _ only`
  if (id.length > 64) return 'the id is longer than 64 characters'
  return null
}

/** `8x4` → `[8, 4]`, or null when it is not a size. */
export function parseSize(text: string): [number, number] | null {
  const m = /^\s*(\d{1,2})\s*[x×*]\s*(\d{1,2})\s*$/i.exec(text)
  if (!m) return null
  const size: [number, number] = [Number(m[1]), Number(m[2])]
  return size[0] >= 1 && size[1] >= 1 ? size : null
}

export function isCategory(value: string): value is WidgetCategory {
  return (WIDGET_CATEGORIES as readonly string[]).includes(value)
}

/**
 * A channel the starting page can subscribe to as it stands: `system`, `calendar:<id>`. A
 * family's `calendar:*` is a manifest entry, not a channel — the page would subscribe to the
 * id a connection setting picks — so it is refused here rather than written half-working.
 */
export function channelProblem(channel: string): string | null {
  if (channel.endsWith(':*')) return `"${channel}" is a family of channels: start from one of them (or none) and add the connection setting that picks it`
  return /^[a-z0-9][a-z0-9_-]*(:[a-z0-9_-]+)?$/i.test(channel) ? null : `"${channel}" is not a channel name`
}

/** "my-widget" → "My widget": a starting name, which the author is asked to confirm. */
export function nameFromId(id: string): string {
  const words = id.split(/[-_]+/).filter(Boolean).join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const PLACEHOLDER_DESCRIPTION = { fr: 'À décrire en une ligne', en: 'Describe it in one line' }

/** Every bridge member the templates below call is in generation 1 (`server/src/bridge/sdk.ts`). */
export const TEMPLATE_SDK = 1

export function manifestFor(o: ScaffoldOptions): Record<string, unknown> {
  // The smallest size the layout below still reads at, never more than what it is dropped at.
  const minSize: [number, number] = [Math.min(4, o.size[0]), Math.min(2, o.size[1])]
  return {
    id: o.id,
    name: o.name,
    version: '0.1.0',
    // The lowest generation the template uses (all of it is generation 1), as
    // docs/writing-widgets.md asks: declaring the newest would refuse older Fremkits for nothing.
    sdk: TEMPLATE_SDK,
    ...(o.author ? { author: o.author } : {}),
    license: 'MIT',
    description: o.description,
    category: o.category,
    icon: o.channel ? 'activity' : 'hand',
    minSize,
    defaultSize: o.size,
    ...(o.compact ? { compact: { width: o.compact } } : {}),
    subscriptions: o.channel ? [o.channel] : [],
    commands: [],
    permissions: { network: [] },
    settingsSchema: o.channel
      ? {}
      : { step: { type: 'number', default: 1, label: { fr: 'Pas', en: 'Step' } } },
  }
}

const STYLE = `  html,body{margin:0;height:100%;background:transparent;color:var(--on-surface,var(--text,#e6e8eb));
    font-family:var(--font,-apple-system,system-ui,sans-serif);overflow:hidden}
  *{box-sizing:border-box}
  .wrap{height:100%;padding:10px 16px;display:flex;align-items:center;gap:16px}
  .main{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:4px}
  .value{font-size:calc(34px * var(--text-scale,1));font-weight:650;line-height:1.1;color:var(--accent,#d9b36a);
    font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .note{font-size:calc(14px * var(--text-scale,1));color:var(--text-muted,#8b93a0);line-height:1.3;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* 56 px: a button meant to be hit while glancing at the strip (44 px is the floor). */
  button{flex:0 0 auto;min-width:56px;min-height:56px;padding:0 18px;border:0;border-radius:12px;font:inherit;
    font-size:calc(18px * var(--text-scale,1));font-weight:600;background:var(--surface-3,#252a32);color:var(--text,#e6e8eb)}
  button:active{background:var(--accent,#d9b36a);color:var(--on-accent,#0b0d10)}
  /* The host says which way round the tile is: on-light is dark text on a light body. */
  html.on-light .note{color:var(--on-surface,#0b0d10);opacity:.75}
  html.on-light button{background:rgba(128,128,128,.25);color:var(--on-surface,#0b0d10)}
  /* Under accent-fill the body *is* the accent: anything painted in it would vanish. */
  html.accent-fill .value{color:var(--on-surface,#0b0d10)}
  html.accent-fill .note{color:var(--on-surface,#0b0d10);opacity:.75}
  html.accent-fill button{background:rgba(0,0,0,.18);color:var(--on-surface,#0b0d10)}

  /* Compact: one line in the navigation bar, no title and no surface of its own. --h is the
     bar's height, set from Fremkit.size, so everything scales with it. */
  .cwrap{display:none}
  html.compact .wrap{display:none}
  html.compact .cwrap{display:flex;align-items:center;height:100%;width:100%;padding:0 calc(var(--h,80px) * .12);
    font-size:calc(clamp(13px, calc(var(--h,80px) * .32), 26px) * var(--text-scale,1));font-weight:600;white-space:nowrap;overflow:hidden}
  /* The value always shows; the label gives way with an ellipsis when the bar is narrow. */
  html.compact .cwrap span{min-width:0;overflow:hidden;text-overflow:ellipsis}
  html.compact .cwrap b{flex:0 0 auto;color:var(--accent,#d9b36a);margin-left:.4em}
  html.compact.accent-fill .cwrap b{color:var(--on-surface,#0b0d10)}
  /* The right cluster pushes the frame against the page buttons: hug that edge. */
  html.compact.slot-right .cwrap{justify-content:flex-end}`

function counterPage(o: ScaffoldOptions): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(o.name.en)}</title>
<style>
${STYLE}
</style></head>
<body>
<!-- No text here: every string comes from the table below, in the dashboard's language. -->
<div class="wrap">
  <div class="main"><div class="value" id="value">0</div><div class="note" id="note"></div></div>
  <button id="add" type="button"></button>
</div>
<div class="cwrap"><span id="clabel"></span><b id="cvalue">0</b></div>
<script>
  // Every text the widget shows, French and English. Fremkit.t picks the dashboard's language.
  var L = {
    taps: { fr: '{n} appuis depuis l’ouverture', en: '{n} taps since it opened' },
    add: { fr: '+{step}', en: '+{step}' },
    compact: { fr: 'Appuis', en: 'Taps' }
  }
  var count = 0

  function render() {
    document.documentElement.lang = Fremkit.locale
    var step = Number(Fremkit.settings.step) || 1
    document.getElementById('value').textContent = count.toLocaleString(Fremkit.locale)
    document.getElementById('note').textContent = Fremkit.t(L.taps, { n: count })
    document.getElementById('add').textContent = Fremkit.t(L.add, { step: step })
    document.getElementById('clabel').textContent = Fremkit.t(L.compact)
    document.getElementById('cvalue').textContent = count.toLocaleString(Fremkit.locale)
  }

  Fremkit.whenReady(function () {
    // The bar's height drives every compact size; the tile layout ignores it.
    function applySize(size) {
      if (size && size.px) document.documentElement.style.setProperty('--h', size.px.height + 'px')
    }
    applySize(Fremkit.size)
    Fremkit.onResize(applySize)
    document.getElementById('add').addEventListener('click', function () {
      count += Number(Fremkit.settings.step) || 1
      render()
    })
    // Follow the admin and the language without a reload.
    Fremkit.onSettings(render)
    Fremkit.onLocale(render)
    render()
  })
</script>
</body></html>
`
}

function channelPage(o: ScaffoldOptions): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(o.name.en)}</title>
<style>
${STYLE}
</style></head>
<body>
<!-- No text here: every string comes from the table below, in the dashboard's language. -->
<div class="wrap">
  <div class="main"><div class="value" id="value">…</div><div class="note" id="note" role="status"></div></div>
</div>
<div class="cwrap"><span id="clabel"></span><b id="cvalue">…</b></div>
<script>
  // Every text the widget shows, French and English. Fremkit.t picks the dashboard's language.
  var L = {
    waiting: { fr: 'En attente de données…', en: 'Waiting for data…' },
    fields: { fr: '{n} champs', en: '{n} fields' },
    updated: { fr: 'Mis à jour à {time}', en: 'Updated at {time}' },
    stale: { fr: 'Données anciennes : {error}', en: 'Stale data: {error}' },
    failed: { fr: 'Indisponible : {error}', en: 'Unavailable: {error}' },
    compact: { fr: '${escapeJs(o.name.fr)}', en: '${escapeJs(o.name.en)}' }
  }
  var CHANNEL = ${JSON.stringify(o.channel)}
  var last = null, error = null, at = null

  function render() {
    document.documentElement.lang = Fremkit.locale
    var value = document.getElementById('value'), note = document.getElementById('note')
    // TODO: draw what the channel carries. This shows how many fields its snapshot has.
    var shown = last ? Fremkit.t(L.fields, { n: Object.keys(last).length }) : '…'
    value.textContent = shown
    note.textContent = error ? Fremkit.t(last ? L.stale : L.failed, { error: error })
      : !last ? Fremkit.t(L.waiting)
      : Fremkit.t(L.updated, { time: at.toLocaleTimeString(Fremkit.locale) })
    document.getElementById('clabel').textContent = Fremkit.t(L.compact)
    document.getElementById('cvalue').textContent = shown
  }

  Fremkit.whenReady(function () {
    function applySize(size) {
      if (size && size.px) document.documentElement.style.setProperty('--h', size.px.height + 'px')
    }
    applySize(Fremkit.size)
    Fremkit.onResize(applySize)
    // A provider keeps its last good snapshot and adds an \`error\` field when it fails.
    Fremkit.subscribe(CHANNEL, function (data) {
      error = data && data.error ? String(data.error) : null
      if (data && !data.error) { last = data; at = new Date() }
      render()
    })
    Fremkit.onLocale(render)
    render()
  })
</script>
</body></html>
`
}

function changelog(): string {
  return `## 0.1.0

### Added
- Initial release.
`
}

/** The files of a new widget, by name. */
export function scaffoldWidget(o: ScaffoldOptions): Record<string, string> {
  return {
    'manifest.json': JSON.stringify(manifestFor(o), null, 2) + '\n',
    'index.html': o.channel ? channelPage(o) : counterPage(o),
    // The registry refuses a version its changelog does not document; it is never packed.
    'CHANGELOG.md': changelog(),
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** For a string written between single quotes inside the page's script. */
function escapeJs(text: string): string {
  return JSON.stringify(text).slice(1, -1).replace(/'/g, "\\'").replace(/</g, '\\u003c')
}
