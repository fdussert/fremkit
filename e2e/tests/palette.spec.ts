import type { Page } from '@playwright/test'
import { expect, test, tiles } from '../fixtures/test.js'
import { baseConfig, type ConfigSeed } from '../fixtures/seeds.js'

function seed(): ConfigSeed {
  const c = baseConfig()
  c.screens[0].pages.push({ id: 'second', name: 'Second', items: [] })
  return c
}
test.use({ seed: seed() })

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' })
const paletteInput = (page: Page) => palette(page).getByRole('combobox')
/** A row of the palette by its label, and its context ("Add to Home", "Page") when given. */
const option = (page: Page, label: string, context?: string) => {
  let row = palette(page).getByRole('option').filter({ has: page.locator('.label').getByText(label, { exact: true }) })
  if (context) row = row.filter({ has: page.locator('.context').getByText(context, { exact: true }) })
  return row
}
const pageRow = (page: Page, name: string) => page.locator('.sidebar ul > li').filter({ hasText: name })

async function openPalette(page: Page, query: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette(page)).toBeVisible()
  await expect(paletteInput(page)).toBeFocused()
  await paletteInput(page).fill(query)
}

test('⌘K adds a widget to the page shown', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await openPalette(page, 'pomodoro')
  await option(page, 'Pomodoro', 'Add to Home').click()
  await expect(palette(page)).toBeHidden()
  await expect(tiles(page)).toHaveCount(2)
  await expect.poll(async () => {
    const c = await savedConfig()
    return c.screens[0].pages[0].items.map((p) => c.widgets[p.instanceId]?.widgetId)
  }).toEqual(['clock', 'pomodoro'])
})

test('⌘K goes to a page, and the top bar button opens it too', async ({ page, openAdmin }) => {
  await openAdmin()
  await page.locator('[data-test="open-palette"]').click()
  await expect(palette(page)).toBeVisible()
  await paletteInput(page).fill('second')
  await option(page, 'Second', 'Page').click()
  await expect(palette(page)).toBeHidden()
  await expect(pageRow(page, 'Second')).toHaveClass(/\bon\b/)
  await expect(page.locator('header .page')).toHaveText('Second')
})

test('⌘K runs an action, and Escape closes it without running anything', async ({ page, openAdmin }) => {
  await openAdmin()
  await openPalette(page, 'test mode')
  await page.keyboard.press('Escape')
  await expect(palette(page)).toBeHidden()
  await expect(page.locator('.board .overlay')).toBeVisible()

  await openPalette(page, 'test mode')
  await option(page, 'Switch to Test mode').click()
  // Test mode: the edit overlay is gone and the widgets take the pointer.
  await expect(page.locator('.board .overlay')).toHaveCount(0)

  await openPalette(page, 'edit mode')
  await page.keyboard.press('Enter')
  await expect(page.locator('.board .overlay')).toBeVisible()
})

test('"?" shows the keyboard shortcuts, and closes them again', async ({ page, openAdmin }) => {
  await openAdmin()
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await page.keyboard.press('?')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('Open the command palette')).toBeVisible()
  await expect(sheet.locator('kbd', { hasText: '⌘K' })).toBeVisible()
  await page.keyboard.press('?')
  await expect(sheet).toBeHidden()

  // The palette lists the sheet as well, with its key.
  await openPalette(page, 'keyboard')
  await option(page, 'Keyboard shortcuts').click()
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(sheet).toBeHidden()
})
