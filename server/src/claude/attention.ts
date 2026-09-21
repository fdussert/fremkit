import { execFile } from 'node:child_process'
import type { InstanceView } from '../config/instances.js'

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
    void runner('/usr/bin/afplay', [`/System/Library/Sounds/${pick.sound}.aiff`]).catch(() => { /* muted, missing, busy */ })
  }
}
