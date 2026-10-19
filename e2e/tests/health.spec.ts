import { expect, test, tile } from '../fixtures/test.js'
import { menuItem } from '../fixtures/board.js'
import { baseConfig, type ConfigSeed } from '../fixtures/seeds.js'

/**
 * Two calendars that cannot show anything: one points at a connection that was deleted, the other
 * at none while no calendar connection exists at all. Neither needs the network to be judged.
 */
function seed(): ConfigSeed {
  const c = baseConfig()
  c.widgets['cal-gone'] = { widgetId: 'calendar', showTitle: true, title: 'Gone calendar', settings: { calendars: ['deleted-connection'] } }
  c.widgets['cal-unset'] = { widgetId: 'calendar', showTitle: true, title: 'Unset calendar', settings: { calendars: [] } }
  c.screens[0].pages[0].items.push(
    { instanceId: 'cal-gone', x: 16, y: 0, w: 16, h: 10 },
    { instanceId: 'cal-unset', x: 32, y: 0, w: 16, h: 10 },
  )
  return c
}
test.use({ seed: seed() })

test('a widget with a missing connection shows a badge, counts in the top bar, and leads to its fix', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()

  // Badges: an error for the deleted connection, a warning for the one never chosen; none on the clock.
  await expect(tile(page, 'cal-gone').locator('[data-health-badge]')).toHaveClass(/\berror\b/)
  await expect(tile(page, 'cal-gone').locator('[data-health-badge]')).toHaveAttribute('aria-label', /no longer exists/)
  await expect(tile(page, 'cal-unset').locator('[data-health-badge]')).toHaveClass(/\bwarning\b/)
  await expect(tile(page, 'clock-1').locator('[data-health-badge]')).toHaveCount(0)
  // The page and the screen say so too.
  await expect(page.locator('.sidebar ul > li').filter({ hasText: 'Home' }).getByTitle('A widget on this page needs attention')).toBeVisible()

  // The counter, and the list behind it, worst first.
  const count = page.locator('[data-health-count]')
  await expect(count).toHaveText('2 to fix')
  await count.click()
  const list = page.locator('[data-health-list]')
  await expect(list).toBeVisible()
  const entries = list.locator('li')
  await expect(entries).toHaveCount(2)
  await expect(entries.nth(0)).toContainText('Gone calendar')
  await expect(entries.nth(0)).toContainText('The connection chosen for “Calendars” no longer exists.')
  await expect(entries.nth(1)).toContainText('Unset calendar')
  await expect(entries.nth(1)).toContainText('No connection is chosen for “Calendars”.')

  // No calendar connection exists: the fix is to create one, in the Connections panel.
  await entries.nth(1).getByRole('button', { name: 'Create a connection' }).click()
  const connections = page.getByRole('dialog', { name: 'Connections' })
  await expect(connections).toBeVisible()
  await expect(connections.getByText('Calendar address')).toBeVisible()
  await connections.getByRole('button', { name: 'Close' }).click()

  // The deleted connection's fix opens the widget's settings at that field; the tile's menu
  // leads with the same fix.
  await tile(page, 'cal-gone').click({ button: 'right' })
  await expect(page.locator('[role="menu"] [role^="menuitem"]').first()).toHaveText(/Fix: Open its settings/)
  await menuItem(page, 'Fix: Open its settings').click()
  await expect(tile(page, 'cal-gone')).toHaveClass(/selected/)
  await expect(page.locator('[data-setting="calendars"]')).toBeVisible()

  // Unticking the dead reference (the row goes with it) turns the error into the milder "none chosen".
  await page.locator('[data-setting="calendars"]').getByRole('checkbox').first().click()
  await expect(tile(page, 'cal-gone').locator('[data-health-badge]')).toHaveClass(/\bwarning\b/)
  await expect(count).toHaveText('2 to fix')
  await expect.poll(async () => (await savedConfig()).widgets['cal-gone'].settings.calendars).toEqual([])
})
