import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/test.js'

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' })
const sidebar = (page: Page) => settings(page).getByRole('navigation', { name: 'Settings' })
// The pane's title is the first h3: a pane may hold its own (About's Diagnostics).
const heading = (page: Page) => settings(page).locator('h3').first()
const search = (page: Page) => sidebar(page).getByPlaceholder('Search settings')

test('the settings window lists the screens and the app panes, each on its own', async ({ page, openAdmin }) => {
  await openAdmin()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(settings(page)).toBeVisible()
  // No Devices: iPad pairing is an experimental feature, off on a fresh dashboard (`labs.devices`).
  await expect(sidebar(page).getByRole('button')).toHaveText(
    ['Xeneon Edge', 'General', 'Appearance', 'Share', 'History & backup', 'Privacy', 'About'])

  // The screen pane: its name field and its sections, with the fold buttons.
  await expect(heading(page)).toHaveText('Xeneon Edge')
  await expect(settings(page).getByLabel('Screen name')).toBeVisible()
  await expect(settings(page).getByRole('button', { name: 'Collapse all' })).toBeVisible()

  // An app pane of one block shows it bare, with nothing to fold.
  await sidebar(page).getByRole('button', { name: 'Privacy' }).click()
  await expect(heading(page)).toHaveText('Privacy')
  await expect(settings(page).getByText('Read the Claude account usage')).toBeVisible()
  await expect(settings(page).getByRole('button', { name: 'Collapse all' })).toHaveCount(0)
})

test('the search shows what it found across the panes, and Escape clears it before closing', async ({ page, openAdmin }) => {
  await openAdmin()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await search(page).fill('kiosk')
  await expect(heading(page)).toHaveText('Search results')
  await expect(settings(page).locator('[data-section]')).toHaveCount(1)
  await expect(settings(page).getByText('Kiosk address')).toBeVisible()

  await search(page).fill('backup')
  await expect(settings(page).getByRole('button', { name: 'Back up' })).toBeVisible()
  await expect(settings(page).getByText('Kiosk address')).toHaveCount(0)

  await search(page).press('Escape')
  await expect(search(page)).toHaveValue('')
  await expect(settings(page)).toBeVisible()
  await search(page).press('Escape')
  await expect(settings(page)).toHaveCount(0)
})

test('a command that reveals a section opens the window on its pane', async ({ page, openAdmin }) => {
  await openAdmin()
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('Copy diagnostics')
  await page.keyboard.press('Enter')
  await expect(settings(page)).toBeVisible()
  await expect(heading(page)).toHaveText('About')
  await expect(settings(page).getByRole('button', { name: 'Prepare diagnostics' })).toBeVisible()
})
