import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/test.js'
import { baseConfig } from '../fixtures/seeds.js'

const library = (page: Page) => page.locator('.sidebar')
const search = (page: Page) => page.locator('[data-library-search] input')
const card = (page: Page, name: string) => library(page).locator('.card').filter({ has: page.locator('strong').getByText(name, { exact: true }) })
const shelves = (page: Page) => library(page).locator('details[data-section^="library."]')

test.describe('in French', () => {
  test.use({ seed: { ...baseConfig(), locale: 'fr' } as never })

  test('search ignores accents and case, either way round', async ({ page, openAdmin }) => {
    await openAdmin()
    await expect(card(page, 'Mémoire')).toBeVisible()

    // Typed without the accent, found with it.
    await search(page).fill('memoire')
    await expect(card(page, 'Mémoire')).toBeVisible()
    await expect(card(page, 'Horloge')).toBeHidden()

    // Typed with accents and capitals the name does not have, found all the same.
    await search(page).fill('MÉTÉO')
    await expect(card(page, 'Météo')).toBeVisible()
    await expect(card(page, 'Mémoire')).toBeHidden()

    await search(page).fill('zzz-nothing')
    await expect(library(page).getByText('Aucun widget ne correspond.')).toBeVisible()

    // Escape clears the search and every card is back.
    await search(page).press('Escape')
    await expect(search(page)).toHaveValue('')
    await expect(card(page, 'Horloge')).toBeVisible()
  })
})

test('expand all and collapse all fold every shelf, and are off while searching', async ({ page, openAdmin }) => {
  await openAdmin()
  const expandAll = library(page).getByRole('button', { name: 'Expand all' })
  const collapseAll = library(page).getByRole('button', { name: 'Collapse all' })
  const count = await shelves(page).count()
  expect(count).toBeGreaterThan(2)

  await collapseAll.click()
  for (let i = 0; i < count; i++) await expect(shelves(page).nth(i)).not.toHaveAttribute('open', '')
  await expect(card(page, 'Clock')).toBeHidden()

  await expandAll.click()
  for (let i = 0; i < count; i++) await expect(shelves(page).nth(i)).toHaveAttribute('open', '')
  await expect(card(page, 'Clock')).toBeVisible()

  // A search opens what it found whatever was folded, and the two buttons wait for it to end.
  await collapseAll.click()
  await search(page).fill('pomodoro')
  await expect(card(page, 'Pomodoro')).toBeVisible()
  await expect(expandAll).toBeDisabled()
  await expect(collapseAll).toBeDisabled()
  await search(page).fill('')
  await expect(expandAll).toBeEnabled()
  // Folded again once the search is over: the search never rewrote the choice.
  await expect(card(page, 'Pomodoro')).toBeHidden()
})

test('"hide those already on this screen" hides the placed widgets, and remembers it', async ({ page, openAdmin }) => {
  await openAdmin()
  const hide = library(page).getByLabel('Hide those already on this screen')
  await expect(card(page, 'Clock')).toBeVisible()

  await hide.check()
  await expect(card(page, 'Clock')).toBeHidden()
  await expect(card(page, 'Pomodoro')).toBeVisible()

  // Placing a widget hides its card at once.
  await card(page, 'Pomodoro').click()
  await expect(card(page, 'Pomodoro')).toBeHidden()

  // A reload keeps the choice: it is this browser's, not the config's.
  await page.reload()
  await expect(library(page).getByLabel('Hide those already on this screen')).toBeChecked()
  await expect(card(page, 'Clock')).toBeHidden()

  await library(page).getByLabel('Hide those already on this screen').uncheck()
  await expect(card(page, 'Clock')).toBeVisible()
  await expect(card(page, 'Pomodoro')).toBeVisible()
})
