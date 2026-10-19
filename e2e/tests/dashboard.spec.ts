import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/test.js'
import { baseConfig, clockIn, type ConfigSeed } from '../fixtures/seeds.js'

const EDGE_BG = '#1b2026' // themes/edge/theme.json
const FREMKIT_BG = '#0b0d10' // themes/fremkit/theme.json, the built-in day theme

/** Three pages; the second has its own background colour, the others show the screen's. */
function pages(): ConfigSeed {
  const c = baseConfig()
  c.screens[0].display.background = { color: '#101010' }
  c.screens[0].pages.push(
    { id: 'second', name: 'Second', items: [], background: { color: '#224466' } },
    { id: 'third', name: 'Third', items: [] },
  )
  return c
}

/** A little over useSwipe's gesture lock, after which a new swipe counts. */
const LOCK_MS = 600

const current = (page: Page) => page.locator('nav .page-button[aria-current="page"]')
const stage = (page: Page) => page.locator('.stage')

/** A horizontal wheel over the stage: what the touch driver turns a finger swipe into. */
async function swipe(page: Page, deltaX: number): Promise<void> {
  const box = await stage(page).boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.wheel(deltaX, 0)
}

test.describe('pages', () => {
  test.use({ seed: pages(), viewport: { width: 2560, height: 720 } })

  test('a horizontal wheel swipes between pages, and the page background crossfades', async ({ page, signIn }) => {
    await signIn('/')
    await expect(current(page)).toHaveAttribute('aria-label', 'Home')

    // Record every background layer the page fades in, from before the first swipe.
    await page.evaluate(() => {
      const w = window as unknown as { fades: number }
      w.fades = 0
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) {
          if (n instanceof HTMLElement && n.classList.contains('background') && n.className.includes('bg-fade-enter')) w.fades++
        }
      }).observe(document.body, { subtree: true, childList: true })
    })

    // Two wheels in a row are one gesture and its momentum: one page, not two.
    await swipe(page, 120)
    await swipe(page, 120)
    await expect(current(page)).toHaveAttribute('aria-label', 'Second')
    // Its own background, faded in over the screen's rather than cut to.
    await expect(page.locator('.root > .background').last()).toHaveCSS('background-color', 'rgb(34, 68, 102)')
    await expect.poll(() => page.evaluate(() => (window as unknown as { fades: number }).fades)).toBeGreaterThan(0)
    await expect(page.locator('.root > .background')).toHaveCount(1)

    // Once the gesture is over (useSwipe's 500 ms lock), the next one counts; backwards too.
    await page.waitForTimeout(LOCK_MS)
    await swipe(page, 120)
    await expect(current(page)).toHaveAttribute('aria-label', 'Third')
    await expect(page.locator('.root > .background').last()).toHaveCSS('background-color', 'rgb(16, 16, 16)')
    await page.waitForTimeout(LOCK_MS)
    await swipe(page, -120)
    await expect(current(page)).toHaveAttribute('aria-label', 'Second')

    // A vertical wheel is a scroll, not a swipe.
    await page.waitForTimeout(LOCK_MS)
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(100)
    await expect(current(page)).toHaveAttribute('aria-label', 'Second')
  })
})

/** The built-in theme by day, Edge by night, switching at fixed times an hour either side of now. */
function scheduled(night: boolean): ConfigSeed {
  const c = baseConfig()
  c.theme = 'fremkit'
  c.themeSchedule = night
    ? { night: 'edge', schedule: 'fixed', nightAt: clockIn(-60), dayAt: clockIn(60) }
    : { night: 'edge', schedule: 'fixed', dayAt: clockIn(-60), nightAt: clockIn(60) }
  return c
}
const bgVar = (page: Page) => page.evaluate(() => document.documentElement.style.getPropertyValue('--bg').trim().toLowerCase())

test.describe('at night', () => {
  test.use({ seed: scheduled(true) })
  test('the dashboard wears the night theme', async ({ page, signIn }) => {
    await signIn('/')
    await expect.poll(() => bgVar(page)).toBe(EDGE_BG)
  })
})

test.describe('by day', () => {
  test.use({ seed: scheduled(false) })
  test('the dashboard wears the day theme', async ({ page, signIn }) => {
    await signIn('/')
    await expect(current(page)).toHaveAttribute('aria-label', 'Home')
    await expect.poll(() => bgVar(page)).toBe(FREMKIT_BG)
  })
})
