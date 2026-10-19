import type { Page } from '@playwright/test'
import { expect, test, tiles } from '../fixtures/test.js'
import { menuItem } from '../fixtures/board.js'
import type { ConfigSeed } from '../fixtures/seeds.js'

const card = (page: Page, name: string) => page.locator('.sidebar .card').filter({ has: page.locator('strong').getByText(name, { exact: true }) })
const pageRow = (page: Page, name: string) => page.locator('.sidebar ul > li').filter({ hasText: name })
const RENAMED = 'Edited by the history test'

/** What the edits change, as the server holds it. */
async function state(saved: () => Promise<ConfigSeed>) {
  const c = await saved()
  return { pages: c.screens[0].pages.map((p) => p.name), widgets: Object.values(c.widgets).map((w) => w.widgetId).sort() }
}
const EDITED = { pages: [RENAMED], widgets: ['clock', 'pomodoro'] }

/**
 * Opens the row under the newest one — the version before the current state — and restores it.
 * Saves less than two minutes apart share one history entry, so whatever came before this test's
 * edits is one row down, whichever tests ran on this server first.
 */
async function restorePrevious(page: Page): Promise<void> {
  const history = page.locator('[data-test="history"]')
  const rows = history.locator('li')
  await expect(rows.first().getByText('Current')).toBeVisible()
  await rows.nth(1).getByRole('button').first().click()
  const restore = rows.nth(1).locator('[data-test="history-restore"]')
  await expect(restore).toHaveText(/Restore this version/)
  await restore.click()
  // Armed: the same button asks once more, in red, before replacing anything.
  await expect(restore).toHaveText(/Replace the dashboard\?/)
  await restore.click()
  await expect(history.getByText(/^Version of .* restored\.$/)).toBeVisible()
}

test('restoring an earlier version, then the one it replaced', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await card(page, 'Pomodoro').click()
  await pageRow(page, 'Home').click({ button: 'right' })
  await menuItem(page, 'Rename').click()
  await page.locator('.sidebar ul > li input').fill(RENAMED)
  await page.locator('.sidebar ul > li input').press('Enter')
  await expect.poll(() => state(savedConfig)).toEqual(EDITED)

  await page.locator('[data-test="open-history"]').click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.locator('[data-test="history"]')).toBeVisible()

  // Back to before the edits: the server and the editor both lose them.
  await restorePrevious(page)
  await expect.poll(async () => (await state(savedConfig)).pages).not.toContain(RENAMED)
  await expect.poll(async () => (await state(savedConfig)).widgets).not.toContain('pomodoro')
  await expect(pageRow(page, RENAMED)).toHaveCount(0)
  // The restore is itself a version, on top, and the edited state is kept just below it.
  const rows = dialog.locator('[data-test="history"] li')
  await expect(rows.first()).toContainText('restored')

  // And forward again: the edited version comes back whole.
  await restorePrevious(page)
  await expect.poll(() => state(savedConfig)).toEqual(EDITED)
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(pageRow(page, RENAMED)).toBeVisible()
  await pageRow(page, RENAMED).click()
  await expect(tiles(page)).toHaveCount(2)
})
