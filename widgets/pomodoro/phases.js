/**
 * The pomodoro phase machine, kept out of index.html so it can be unit tested on its own. The
 * whole timer is derived from one integer — the step index — rather than from a stored phase, so
 * skipping, resetting and reloading all land on the same place with no state to keep in step.
 *
 * Steps alternate work and break: even index is a work phase, odd index the break after it. Every
 * `cycles`-th break is the long one. The file is a plain script, loaded with a <script> tag in the
 * widget and evaluated against a scope object in the test, so it needs no module system either side.
 */
;(function (root) {
  'use strict'

  /** Which phase step `index` is, given how many work phases precede a long break. */
  function phaseAt(index, cycles) {
    var n = Math.max(0, Math.floor(index))
    if (n % 2 === 0) return 'work'
    var breakNumber = (n - 1) / 2 + 1
    return breakNumber % Math.max(1, Math.floor(cycles)) === 0 ? 'long' : 'short'
  }

  /** The phase's length in milliseconds; a missing or absurd setting falls back to the default. */
  function durationMs(phase, settings) {
    var minutes = phase === 'work' ? settings.work : phase === 'long' ? settings.longBreak : settings.shortBreak
    var m = Number(minutes)
    if (!isFinite(m) || m <= 0) m = phase === 'work' ? 25 : phase === 'long' ? 15 : 5
    return Math.round(Math.min(m, 180) * 60000)
  }

  /**
   * How many work phases of the current set are already done — the filled dots. A set is `cycles`
   * work phases long and starts over right after the long break.
   */
  function completedInSet(index, cycles) {
    var c = Math.max(1, Math.floor(cycles))
    var n = Math.max(0, Math.floor(index))
    // The long break closes the set, so every dot stays filled through it rather than emptying the
    // moment the last work phase ends.
    if (phaseAt(n, c) === 'long') return c
    return Math.ceil(n / 2) % c
  }

  /** `mm:ss`, never negative, rounding up so the last second is shown as 0:01 rather than 0:00. */
  function mmss(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000))
    var m = Math.floor(total / 60)
    var sec = total % 60
    return m + ':' + (sec < 10 ? '0' : '') + sec
  }

  root.FremkitPomodoro = { phaseAt: phaseAt, durationMs: durationMs, completedInSet: completedInSet, mmss: mmss }
})(typeof globalThis !== 'undefined' ? globalThis : this)
