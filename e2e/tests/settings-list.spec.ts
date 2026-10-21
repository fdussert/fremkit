import type { Page } from '@playwright/test'
import { expect, test, tile } from '../fixtures/test.js'
import { baseConfig, type ConfigSeed } from '../fixtures/seeds.js'

/** A clock whose cities list starts Paris, Tokyo, New York. */
function seed(): ConfigSeed {
  const c = baseConfig()
  c.widgets['clock-1'].settings.cities = [
    { label: 'Paris', timezone: 'Europe/Paris', hour12: false, seconds: false },
    { label: 'Tokyo', timezone: 'Asia/Tokyo', hour12: false, seconds: false },
    { label: 'New York', timezone: 'America/New_York', hour12: false, seconds: false },
  ]
  return c
}
test.use({ seed: seed() })

const cities = (page: Page) => page.locator('[data-setting="cities"]')
const rows = (page: Page) => cities(page).locator('ul.list > li')
const cityOrder = async (savedConfig: () => Promise<ConfigSeed>): Promise<string[]> =>
  ((await savedConfig()).widgets['clock-1'].settings.cities as { label: string }[]).map((c) => c.label)

test('a list row reorders by its grip, and the whole drag is one undo step', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await tile(page, 'clock-1').click()
  await expect(rows(page)).toHaveCount(3)
  await expect(rows(page).locator('button.grip')).toHaveCount(3)

  // The grip arms the row's `draggable` on mousedown; the gesture then drags the row itself.
  const grip = rows(page).nth(0).locator('button.grip')
  const target = rows(page).nth(2)
  await grip.hover()
  await page.mouse.down()
  const box = (await target.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()

  await expect.poll(() => cityOrder(savedConfig)).toEqual(['Tokyo', 'New York', 'Paris'])

  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => cityOrder(savedConfig)).toEqual(['Paris', 'Tokyo', 'New York'])
})

test('typing stays possible inside a row: only the grip starts a drag', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await tile(page, 'clock-1').click()

  // A drag straight out of the label input selects text rather than moving the row.
  const input = rows(page).nth(0).locator('input').first()
  await input.click()
  await input.fill('Lyon')
  await input.press('Tab')
  await expect.poll(() => cityOrder(savedConfig)).toEqual(['Lyon', 'Tokyo', 'New York'])
  const start = await input.boundingBox()
  const end = (await rows(page).nth(2).boundingBox())!
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2)
  await page.mouse.down()
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 4 })
  await page.mouse.up()

  await expect.poll(() => cityOrder(savedConfig)).toEqual(['Lyon', 'Tokyo', 'New York'])
})
