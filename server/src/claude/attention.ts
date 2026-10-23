import { execFile } from 'node:child_process'
import type { InstanceView } from '../config/instances.js'
import { targetPlatform, type Platform } from '../platform/index.js'
import { sharedHost } from '../win/powershell-host.js'

/**
 * A sound when a session starts waiting for you.
 *
 * Played by the core, not by the widget, and that is the whole point: a widget is HTML in a
 * sandboxed iframe, an iframe cannot start audio nobody clicked on, and the moment worth hearing
 * about is precisely the one where the dashboard is not in front of you. The Edge is a strip on a
 * desk — a question can sit on it for twenty minutes unseen.
 *
 * Which sound is a *widget* setting all the same, because that is where the person configuring
 * their dashboard will look for it. The provider reads the placed instances and the first one
 * that chose a sound wins, so two tiles of the same widget do not play twice.
 */

/**
 * The sounds macOS ships in `/System/Library/Sounds`, as a closed list.
 *
 * Written down rather than read from disk: this ends up as a path handed to `afplay`, and a
 * closed list is what makes "the setting is a file name" not a question anybody has to think
 * about again. It is also the enum the manifest offers, so the two cannot drift.
 */
export const SOUNDS = [
  'Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero', 'Morse',
  'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink',
] as const
export type SoundName = typeof SOUNDS[number]

export function isSoundName(v: unknown): v is SoundName {
  return typeof v === 'string' && (SOUNDS as readonly string[]).includes(v)
}

/**
 * What each setting plays on Windows, which has two of the host's five sounds to offer instead of
 * fourteen: the sharper settings play `notify`, the soft ones `chimes`. A closed map, so the name
 * handed to the host is never the setting itself.
 */
const WINDOWS_SOUND: Record<SoundName, 'chimes' | 'notify'> = {
  Basso: 'notify', Blow: 'notify', Bottle: 'chimes', Frog: 'notify', Funk: 'notify', Glass: 'chimes', Hero: 'chimes',
  Morse: 'notify', Ping: 'chimes', Pop: 'chimes', Purr: 'chimes', Sosumi: 'notify', Submarine: 'chimes', Tink: 'chimes',
}

/** The PowerShell host's `sound` op, which is all this module asks of it. */
export interface SoundHost { call<T>(op: 'sound', arg?: unknown, timeoutMs?: number): Promise<T> }

export interface PlayOptions { platform?: Platform; host?: SoundHost }

/**
 * Plays one of the sounds, now, whatever the tiles say — the admin's preview button. The name
 * has to come out of the list; anything else is refused before a path exists.
 */
export async function playSound(name: unknown, runner: Runner = run, opts: PlayOptions = {}): Promise<boolean> {
  if (!isSoundName(name)) return false
  if ((opts.platform ?? targetPlatform()) === 'win32') {
    try { await (opts.host ?? sharedHost()).call('sound', WINDOWS_SOUND[name], 5000) } catch { return false }
    return true
  }
  try { await runner('/usr/bin/afplay', [`/System/Library/Sounds/${name}.aiff`]) } catch { return false }
  return true
}

/** What the sound is for: a question the assistant asked, or that and a permission prompt. */
export type SoundOn = 'question' | 'attention'

/** One session has started waiting. `isQuestion` separates an AskUserQuestion from a permission. */
export interface AttentionEvent { sessionId: string; isQuestion: boolean }

export type Runner = (cmd: string, args: string[]) => Promise<void>

const run: Runner = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 10_000 }, (err) => (err ? reject(err) : resolve())))

/**
 * Least time between two sounds.
 *
 * Five subagents hitting a permission prompt together is one event as far as the room is
 * concerned. Without this the Mac chimes five times and the sound stops meaning anything.
 */
const MIN_GAP_MS = 5_000

export interface AttentionOptions {
  /** The placed instances of the widget, in the order the dashboard holds them. */
  instances: () => InstanceView[]
  runner?: Runner
  platform?: Platform
  host?: SoundHost
  now?: () => number
  minGapMs?: number
}

/** The chosen sound, or null when no placed tile asked for one. */
function chosen(instances: InstanceView[]): { sound: SoundName; on: SoundOn } | null {
  for (const instance of instances) {
    const sound = instance.settings.sound
    // `none` is the default and means this tile has no opinion — the next one may.
    if (typeof sound !== 'string' || sound === 'none') continue
    if (!(SOUNDS as readonly string[]).includes(sound)) continue
    const on = instance.settings.soundOn
    return { sound: sound as SoundName, on: on === 'question' ? 'question' : 'attention' }
  }
  return null
}

/**
 * Builds the listener the tracker calls when a session starts waiting.
 *
 * Every refusal is silent and none of them is an error: a dashboard with no Claude tile on it, a
 * tile set to `none`, a second prompt three seconds after the first — all of these are "do not
 * play a sound", and none is worth a log line.
 */
export function createAttention(opts: AttentionOptions): (event: AttentionEvent) => void {
  const runner = opts.runner ?? run
  const now = opts.now ?? Date.now
  const gap = opts.minGapMs ?? MIN_GAP_MS
  // Not 0: with a monotonic clock that starts near zero, or a test clock that does, a real first
  // sound would fall inside the gap after the epoch and be swallowed.
  let lastAt = Number.NEGATIVE_INFINITY
  return (event) => {
    const pick = chosen(opts.instances())
    if (!pick) return
    if (pick.on === 'question' && !event.isQuestion) return
    const t = now()
    if (t - lastAt < gap) return
    lastAt = t
    // The name came out of the closed list above, so the path cannot be anything else.
    void playSound(pick.sound, runner, { platform: opts.platform, host: opts.host })
  }
}
