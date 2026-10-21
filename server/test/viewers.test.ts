import { describe, expect, it } from 'vitest'
import { PANE_POLL_WINDOW_MS, PairingViewers } from '../src/companion/viewers.js'

describe('PairingViewers', () => {
  it('sees nobody with no dashboard and no pane poll', () => {
    expect(new PairingViewers(() => 0, () => 1_000_000).seen()).toBe(false)
  })

  it('sees a dashboard on the channel', () => {
    expect(new PairingViewers(() => 1, () => 1_000_000).seen()).toBe(true)
  })

  it('sees the Devices pane for three of its polls after the last one, then no more', () => {
    let now = 1_000_000
    const viewers = new PairingViewers(() => 0, () => now)
    viewers.notePanePoll()
    expect(viewers.seen()).toBe(true)
    now += PANE_POLL_WINDOW_MS
    expect(viewers.seen()).toBe(true)
    now += 1
    expect(viewers.seen()).toBe(false)
  })
})
