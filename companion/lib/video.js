// Frame survey, video placement and crop math for the companion extension. Plain ES module, no
// build step. `survey`, `control` and `youtubeVolume` run inside web pages
// (chrome.scripting.executeScript), so each is self-contained: no imports, no reference to
// anything in this module's scope. What they return comes from the page: `cleanFrames` and
// `cleanState` check it before anything else reads it.

/**
 * Runs in every frame. Reports the frame's main visible video (non-zero size, in the viewport), in
 * that frame's px: the largest one with a source, or else the largest without one, marked `empty`
 * (an embed the user has not started has none until play; a poster placeholder never does). In
 * the top frame it also reports where each iframe sits, so a player embedded from another origin
 * can be located.
 * SELF-CONTAINED: it is serialised into the page.
 */
export function survey() {
  const visible = (v) => {
    const r = v.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
  }
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }
  const empty = (el) => !el.currentSrc && !el.src && !el.srcObject && !(el.readyState > 0)
  const v = [...document.querySelectorAll('video')]
    .filter(visible)
    .sort((a, b) => empty(a) - empty(b) || b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
  const isTop = window === window.top
  return {
    href: location.href,
    top: isTop,
    vw: innerWidth,
    vh: innerHeight,
    title: document.title,
    video: v ? { ...box(v), ...(empty(v) ? { empty: true } : {}) } : null,
    iframes: isTop
      ? [...document.querySelectorAll('iframe')]
          // `fs`: the frame may go full screen, which a video player asks for and an ad rarely does.
          .map((f) => ({ src: f.src, fs: Boolean(f.allowFullscreen || /fullscreen/.test(f.allow || '')), ...box(f) }))
          .filter((f) => f.w > 0 && f.h > 0)
      : [],
  }
}

/**
 * Runs in the chosen frame, in the extension's isolated world: applies an action to its main video
 * and reports the state. Actions are `toggle`, `seek` ({ delta: ±10 }), `volume` ({ value: 0..1 })
 * and `mute` (a toggle); `show` and `stop` are the extension's business, not the page's. Null when
 * the frame has no video. The isolated world reads the element through the browser's own getters,
 * which the page cannot redefine; the values are still the page's, and `cleanState` bounds them.
 * SELF-CONTAINED: it is serialised into the page.
 */
export function control(action, args) {
  // The same choice as `survey`: one with a source first, then the largest.
  const empty = (el) => !el.currentSrc && !el.src && !el.srcObject && !(el.readyState > 0)
  const v = [...document.querySelectorAll('video')].sort(
    (a, b) => empty(a) - empty(b) || b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
  )[0]
  if (!v) return null
  const duration = Number.isFinite(v.duration) ? v.duration : 0
  const opts = args || {}
  if (action === 'toggle') {
    if (v.paused) v.play()?.catch?.(() => undefined)
    else v.pause()
  } else if (action === 'seek') {
    const delta = Number(opts.delta) || 0
    v.currentTime = Math.max(0, Math.min(duration || v.currentTime + delta, v.currentTime + delta))
  } else if (action === 'volume') {
    const value = Math.max(0, Math.min(1, Number(opts.value) || 0))
    v.volume = value
    if (value > 0) v.muted = false
  } else if (action === 'mute') {
    v.muted = !v.muted
  }
  return { paused: v.paused, currentTime: v.currentTime, duration, volume: v.volume, muted: v.muted }
}

/**
 * Runs in the page's main world, the one place the extension does: YouTube puts its own volume
 * back over the element's, so volume and mute go through its player's API, which only the page's
 * world can see. `op` is `volume` (with `value`, 0..1) or `mute` (a toggle). True when YouTube's
 * player took it, false when there is none; the state is then read back in the isolated world.
 * SELF-CONTAINED: it is serialised into the page.
 */
export function youtubeVolume(op, value) {
  try {
    const yt = document.getElementById('movie_player')
    if (!yt || typeof yt.setVolume !== 'function') return false
    if (op === 'volume') {
      const level = Math.max(0, Math.min(1, Number(value) || 0))
      yt.setVolume(Math.round(level * 100))
      if (level > 0) yt.unMute()
    } else if (op === 'mute') {
      if (yt.isMuted()) yt.unMute()
      else yt.mute()
    } else return false
    return true
  } catch {
    return false
  }
}

const MAX_URL = 2048
const MAX_TITLE = 300
const MAX_IFRAMES = 100
/** Larger than any screen in CSS px; a bigger coordinate is a page making things up. */
const MAX_PX = 1e6

const finite = (n, max = MAX_PX) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= max

function cleanBox(b) {
  if (!b || typeof b !== 'object') return null
  const { x, y, w, h } = b
  return finite(x) && finite(y) && finite(w) && finite(h) && w > 0 && h > 0 ? { x, y, w, h } : null
}

/** A reported video: its box, and `empty: true` only when the page said it has no source. */
function cleanVideo(v) {
  const at = cleanBox(v)
  return at && v.empty === true ? { ...at, empty: true } : at
}

/**
 * One frame's `survey` result, type-checked and bounded: what a page reports is untrusted, and the
 * worker reads it every second. Null when it is not a usable report.
 */
export function cleanSurvey(r) {
  if (!r || typeof r !== 'object' || !finite(r.vw) || !finite(r.vh) || r.vw <= 0 || r.vh <= 0) return null
  const top = r.top === true
  return {
    href: typeof r.href === 'string' && r.href.length <= MAX_URL ? r.href : '',
    top,
    vw: r.vw,
    vh: r.vh,
    title: typeof r.title === 'string' ? r.title.slice(0, MAX_TITLE) : '',
    video: cleanVideo(r.video),
    iframes: top && Array.isArray(r.iframes)
      ? r.iframes.slice(0, MAX_IFRAMES).flatMap((f) => {
          const at = cleanBox(f)
          return at && typeof f.src === 'string' && f.src.length <= MAX_URL ? [{ src: f.src, fs: f.fs === true, ...at }] : []
        })
      : [],
  }
}

/** The `executeScript` results of `survey`, each cleaned; entries with no usable frame id are dropped. */
export function cleanFrames(results) {
  if (!Array.isArray(results)) return []
  return results
    .filter((f) => f && Number.isInteger(f.frameId) && f.frameId >= 0)
    .map((f) => ({ frameId: f.frameId, result: cleanSurvey(f.result) }))
}

/** A `control` result, type-checked and bounded the way the server's meta schema bounds it. Null when unusable. */
export function cleanState(s) {
  if (!s || typeof s !== 'object') return null
  const seconds = (n) => (finite(n, Infinity) ? Math.min(604_800, Math.max(0, n)) : 0)
  return {
    paused: s.paused !== false,
    currentTime: seconds(s.currentTime),
    duration: seconds(s.duration),
    volume: finite(s.volume, Infinity) ? Math.min(1, Math.max(0, s.volume)) : 1,
    muted: s.muted === true,
  }
}

function originOf(url) {
  try {
    const { origin } = new URL(url)
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/** Where an iframe's document sits in the top page: same URL, else same origin (largest), else null. */
export function placeFrame(frame, iframes) {
  const exact = iframes.find((f) => f.src === frame.href)
  if (exact) return exact
  const origin = originOf(frame.href)
  if (!origin) return null
  return iframes.filter((f) => originOf(f.src) === origin).sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? null
}

/**
 * The main video of a tab, from the `executeScript` results of `survey` over all frames
 * (`{ frameId, result }`): the biggest one with a source, or else the biggest empty one (an embed
 * not started yet), so a large poster placeholder never wins over the video actually playing. The
 * rectangle is a fraction of the top viewport. A frame that cannot be placed in the top page is
 * skipped rather than guessed.
 */
export function pickVideo(frames) {
  const topResult = frames.find((f) => f.result?.top)?.result
  if (!topResult) return null
  let best = null
  for (const f of frames) {
    const r = f.result
    if (!r?.video) continue
    let rect
    if (r.top) rect = r.video
    else {
      const at = placeFrame(r, topResult.iframes ?? [])
      if (!at) continue
      const sx = at.w / r.vw
      const sy = at.h / r.vh
      rect = { x: at.x + r.video.x * sx, y: at.y + r.video.y * sy, w: r.video.w * sx, h: r.video.h * sy }
    }
    const empty = r.video.empty === true
    if (!best || (best.empty && !empty) || (best.empty === empty && rect.w * rect.h > best.rect.w * best.rect.h)) {
      best = { frameId: f.frameId, rect, empty }
    }
  }
  if (!best) return null
  const { x, y, w, h } = best.rect
  return { frameId: best.frameId, rect: { x: x / topResult.vw, y: y / topResult.vh, w: w / topResult.vw, h: h / topResult.vh } }
}

/**
 * The source rectangle (in captured-frame px) and the even output size for a video rectangle given
 * as fractions of the viewport. Null for no rectangle or an implausible one, so the caller keeps
 * its last frame rather than sending the tab around a video that is gone. (The page places the
 * video element, so a page can make this rectangle the whole tab.)
 */
export function cropRect(rect, videoWidth, videoHeight, max = { w: 1920, h: 1080 }) {
  if (!rect || !videoWidth || !videoHeight || rect.w < 0.05 || rect.h < 0.05) return null
  // Intersect with the viewport first: a video scrolled partly out of view crops only what shows.
  const x0 = Math.max(0, rect.x)
  const x1 = Math.min(1, rect.x + rect.w)
  const y0 = Math.max(0, rect.y)
  const y1 = Math.min(1, rect.y + rect.h)
  if (x1 - x0 < 0.05 || y1 - y0 < 0.05) return null
  const sx = videoWidth * x0
  const sy = videoHeight * y0
  const sw = videoWidth * (x1 - x0)
  const sh = videoHeight * (y1 - y0)
  const scale = Math.min(1, max.w / sw, max.h / sh)
  // Even sizes: the H.264 encoder behind WebRTC wants them.
  const w = Math.round(sw * scale) & ~1
  const h = Math.round(sh * scale) & ~1
  if (w < 2 || h < 2) return null
  return { sx, sy, sw, sh, w, h }
}

/**
 * The origin of the frame holding the video `pickVideo` picks, or null when it picks none. Run
 * after the user granted an origin: the grant stays only when the share plays a video in a frame
 * of that origin, not when that frame merely holds a placeholder `<video>` (or none at all, like
 * a webmail page sized like a player) while the video shared is somewhere else.
 */
export function pickedOrigin(frames) {
  const picked = pickVideo(frames)
  if (!picked) return null
  const at = frames.find((f) => f.frameId === picked.frameId)?.result
  return at ? originOf(at.href) : null
}

/**
 * The origin of an embedded player the extension cannot see into yet: the largest cross-origin
 * iframe of the top frame that may go full screen, covers at least a quarter of the viewport each
 * way, and is bigger than the video already found (`picked`, fractions of the viewport, or null).
 * Null when there is none, or when a frame of that origin already answered the survey (its
 * permission is there). `frames` are the survey results, as for `pickVideo`.
 *
 * Only a candidate: nothing inside a frame of another origin can be seen before its grant. So the
 * popup names the origin before the browser asks, and the grant goes back unless the share plays
 * a video in that frame (`pickedOrigin`).
 */
export function embeddedPlayer(frames, picked) {
  const topResult = frames.find((f) => f.result?.top)?.result
  if (!topResult) return null
  const topOrigin = originOf(topResult.href)
  const seen = new Set(frames.map((f) => originOf(f.result?.href)).filter(Boolean))
  const vw = topResult.vw || 1
  const vh = topResult.vh || 1
  const pickedArea = picked ? picked.rect.w * picked.rect.h : 0
  let best = null
  for (const f of topResult.iframes ?? []) {
    const origin = originOf(f.src)
    if (!origin || !/^https?:/.test(origin) || origin === topOrigin || seen.has(origin) || !f.fs) continue
    const w = f.w / vw
    const h = f.h / vh
    if (w < 0.25 || h < 0.25 || w * h <= pickedArea) continue
    if (!best || w * h > best.area) best = { origin, area: w * h }
  }
  return best?.origin ?? null
}
