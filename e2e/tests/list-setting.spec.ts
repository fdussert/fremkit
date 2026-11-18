import type { Locator, Page } from '@playwright/test'
import { expect, test, tile } from '../fixtures/test.js'
import { baseConfig, type ConfigSeed } from '../fixtures/seeds.js'

/** A shortcuts tile with four buttons in two columns. */
function seed(): ConfigSeed {
  const c = baseConfig()
  const buttons = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((label) => ({ label, kind: 'url', target: `https://example.com/${label}`, icon: '' }))
  c.widgets['keys-1'] = { widgetId: 'shortcuts', showTitle: true, settings: { buttons, columns: 2 } }
  c.screens[0].pages[0].items.push({ instanceId: 'keys-1', x: 16, y: 0, w: 16, h: 8 })
  return c
}
test.use({ seed: seed() })

const field = (page: Page) => page.locator('[data-setting="buttons"]')
const item = (page: Page, name: string) => field(page).getByRole('button', { name, exact: true })
const labels = async (saved: () => Promise<ConfigSeed>) =>
  ((await saved()).widgets['keys-1'].settings.buttons as { label: string }[]).map((b) => b.label)

/** Presses `from`, travels past the drag threshold, then lets go over the right edge of `onto`. */
async function dragOnto(page: Page, from: Locator, onto: Locator): Promise<void> {
  await from.hover()
  await page.mouse.down()
  const box = (await onto.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 })
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 3 })
  await page.mouse.up()
}

test('a list setting drawn as the widget\'s grid: drag a button into place, touch one to edit it, undo', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await tile(page, 'keys-1').click()
  // Folded: four tiles, two columns, no field shown until one is touched.
  await expect(field(page).locator('[data-list-item]')).toHaveCount(4)
  await expect(field(page).getByRole('textbox')).toHaveCount(0)
  const [a, b] = [await item(page, 'Alpha').boundingBox(), await item(page, 'Beta').boundingBox()]
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2)

  await dragOnto(page, item(page, 'Alpha'), item(page, 'Delta'))
  await expect.poll(() => labels(savedConfig)).toEqual(['Beta', 'Gamma', 'Delta', 'Alpha'])

  await item(page, 'Gamma').click()
  await expect(item(page, 'Gamma')).toHaveAttribute('aria-expanded', 'true')
  await expect(field(page).getByRole('textbox', { name: 'Label' })).toHaveValue('Gamma')
  await field(page).getByRole('button', { name: 'Move earlier' }).click()
  await expect.poll(() => labels(savedConfig)).toEqual(['Gamma', 'Beta', 'Delta', 'Alpha'])

  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => labels(savedConfig)).toEqual(['Beta', 'Gamma', 'Delta', 'Alpha'])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => labels(savedConfig)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
})
