import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/test.js'
import { menuItem, rightClickCell } from '../fixtures/board.js'
import { baseConfig, deviceScreen, type ConfigSeed } from '../fixtures/seeds.js'

function seed(): ConfigSeed {
  const c = baseConfig()
  c.screens.push(deviceScreen())
  return c
}
test.use({ seed: seed() })

/** A dashboard tab on one screen, marked so a reload shows: the mark goes with the old document. */
async function dashboard(page: Page, screen: string): Promise<Page> {
  const tab = await page.context().newPage()
  await tab.goto(`/?screen=${screen}`)
  await expect(tab.locator('.stage')).toBeVisible()
  await tab.evaluate(() => { (window as unknown as { mark: boolean }).mark = true })
  return tab
}
const marked = (tab: Page) => tab.evaluate(() => (window as unknown as { mark?: boolean }).mark === true)

test('Reload the dashboard reloads the pages of that screen and no other', async ({ page, openAdmin }) => {
  await openAdmin()
  const edge = await dashboard(page, 'edge')
  const desk = await dashboard(page, 'desk')

  // The canvas menu reloads the screen being edited. Retried: a tab only hears the request once
  // its socket subscribed, and nothing tells the test when that was.
  await expect(async () => {
    await rightClickCell(page, 40.25, 10.25)
    await menuItem(page, 'Reload the dashboard').click()
    await expect.poll(() => marked(edge), { timeout: 1500 }).toBe(false)
  }).toPass({ timeout: 10_000 })
  await expect(page.getByRole('alert').filter({ hasText: 'Dashboard reloaded on Xeneon Edge' })).toBeVisible()
  expect(await marked(desk)).toBe(true)

  // The selector's menu reloads the screen it was opened on, here not the one being edited.
  await expect(edge.locator('.stage')).toBeVisible()
  await edge.evaluate(() => { (window as unknown as { mark: boolean }).mark = true })
  await expect(async () => {
    await page.getByRole('tab', { name: 'Desk' }).click({ button: 'right' })
    await menuItem(page, 'Reload the dashboard').click()
    await expect.poll(() => marked(desk), { timeout: 1500 }).toBe(false)
  }).toPass({ timeout: 10_000 })
  await expect(page.getByRole('alert').filter({ hasText: 'Dashboard reloaded on Desk' })).toBeVisible()
  expect(await marked(edge)).toBe(true)
  // The reloaded page comes back and stays: nothing replays the request to it.
  await expect(desk.locator('.stage')).toBeVisible()
  await desk.evaluate(() => { (window as unknown as { mark: boolean }).mark = true })
  await desk.waitForTimeout(1000)
  expect(await marked(desk)).toBe(true)
})
