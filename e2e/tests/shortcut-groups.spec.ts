import type { Page } from '@playwright/test'
import { expect, test, tile } from '../fixtures/test.js'
import { baseConfig, type ConfigSeed } from '../fixtures/seeds.js'

/** A shortcuts tile with two buttons and a group holding one, in three columns. */
function seed(): ConfigSeed {
  const c = baseConfig()
  const buttons = [
    { label: 'Alpha', kind: 'url', target: 'https://example.com/a', icon: '', items: [] },
    { label: 'Beta', kind: 'url', target: 'https://example.com/b', icon: '', items: [] },
    { label: 'Prod', kind: 'group', target: '', icon: '', items: [{ label: 'Deploy', kind: 'url', target: 'https://example.com/d', icon: '' }] },
  ]
  c.widgets['keys-1'] = { widgetId: 'shortcuts', showTitle: true, settings: { buttons, columns: 3 } }
  c.screens[0].pages[0].items.push({ instanceId: 'keys-1', x: 16, y: 0, w: 16, h: 8 })
  return c
}
test.use({ seed: seed() })

type Button = { label: string; items?: { label: string }[] }
const field = (page: Page) => page.locator('[data-setting="buttons"]')
const top = (page: Page, name: RegExp) => field(page).locator(':scope > ul > li > button').filter({ hasText: name })
const saved = async (savedConfig: () => Promise<ConfigSeed>) =>
  ((await savedConfig()).widgets['keys-1'].settings.buttons as Button[])
    .map((b) => (b.items?.length ? `${b.label}[${b.items.map((i) => i.label).join(',')}]` : b.label))

test('a button dropped onto a group goes into it, and comes back out', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await tile(page, 'keys-1').click()

  // A group hides the target box and shows its own buttons instead.
  await top(page, /^Prod/).click()
  await expect(field(page).getByRole('textbox', { name: /^Target/ })).toHaveCount(0)
  await expect(field(page).locator('[data-held="items"]').getByRole('button', { name: 'Deploy' })).toBeVisible()
  await top(page, /^Prod/).click()

  // Dropped onto the group's middle, Alpha goes in at its end.
  await top(page, /^Alpha/).hover()
  await page.mouse.down()
  const box = (await top(page, /^Prod/).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => saved(savedConfig)).toEqual(['Beta', 'Prod[Deploy,Alpha]'])
  await expect(top(page, /^Prod/)).toContainText('2')

  // The group opened on the drop; Alpha is taken out right after it.
  const held = field(page).locator('[data-held="items"]')
  await held.getByRole('button', { name: 'Alpha' }).click()
  await held.getByRole('button', { name: 'Take out of the group' }).click()
  await expect.poll(() => saved(savedConfig)).toEqual(['Beta', 'Prod[Deploy]', 'Alpha'])

  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => saved(savedConfig)).toEqual(['Beta', 'Prod[Deploy,Alpha]'])
})
