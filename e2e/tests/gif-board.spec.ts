import type { Page } from '@playwright/test'
import { expect, test, tile } from '../fixtures/test.js'
import { menuItem } from '../fixtures/board.js'
import { baseConfig, type ConfigSeed } from '../fixtures/seeds.js'

/** The clock and a GIF board on the page, no connection: Giphy search is unconfigured. */
function seed(): ConfigSeed {
  const c = baseConfig()
  c.widgets['gifs-1'] = { widgetId: 'gif-board', showTitle: true, settings: {} }
  c.screens[0].pages[0].items.push({ instanceId: 'gifs-1', x: 16, y: 0, w: 16, h: 8 })
  return c
}
test.use({ seed: seed() })

const panel = (page: Page) => page.getByRole('dialog', { name: 'GIFs' })
/** A GIF in the panel: its image has no text, so it is found by the hint it carries. */
const thumbs = (page: Page) => panel(page).getByTitle('Drag to reorder or move to another group; right-click for more')
const groups = async (saved: () => Promise<ConfigSeed>) => (await saved()).gifs?.groups ?? []

test('the GIF panel collects a pasted Giphy address into a new group, removes it, and undo brings it back', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await tile(page, 'gifs-1').click()
  await page.getByRole('button', { name: 'Manage the GIFs…' }).click()
  await expect(panel(page)).toBeVisible()
  // No Giphy connection: the search says so, and pasting still works.
  await expect(panel(page).getByText('Searching needs a Giphy connection. Pasting an address works without one.')).toBeVisible()

  // A new group opens its name for editing.
  await panel(page).getByRole('button', { name: 'New group' }).click()
  const name = panel(page).getByRole('textbox', { name: 'Group name' })
  await expect(name).toBeFocused()
  await name.fill('Work')
  await name.press('Enter')
  await expect(panel(page).getByText('Work', { exact: true })).toBeVisible()

  // A Giphy address is kept as its id, without asking the network.
  await panel(page).getByRole('textbox', { name: 'Add a GIF to Work' }).fill('https://i.giphy.com/abc123.gif')
  await panel(page).getByRole('button', { name: 'Add', exact: true }).click()
  await expect(thumbs(page)).toHaveCount(1)
  await expect.poll(() => groups(savedConfig)).toEqual([
    { id: expect.any(String), name: 'Work', items: [{ id: expect.any(String), kind: 'giphy', giphyId: 'abc123' }] },
  ])

  // Removed from its menu; the thumbnail may never load offline, so the config is what is checked.
  await thumbs(page).first().click({ button: 'right' })
  await menuItem(page, 'Remove').click()
  await expect(thumbs(page)).toHaveCount(0)
  await expect.poll(async () => (await groups(savedConfig))[0]?.items).toEqual([])

  await page.keyboard.press('ControlOrMeta+z')
  await expect(thumbs(page)).toHaveCount(1)
  await expect.poll(async () => (await groups(savedConfig))[0]?.items).toEqual([
    { id: expect.any(String), kind: 'giphy', giphyId: 'abc123' },
  ])
})

test.describe('with three groups', () => {
  const ordered = (): ConfigSeed => {
    const c = seed()
    c.gifs = { groups: ['One', 'Two', 'Three'].map((name, i) => ({ id: `group${i}aaaa`, name, items: [] })) }
    return c
  }
  test.use({ seed: ordered() })

  test('a group dragged by its header lands where the line shows, and undo puts it back', async ({ page, openAdmin, savedConfig }) => {
    await openAdmin()
    await tile(page, 'gifs-1').click()
    await page.getByRole('button', { name: 'Manage the GIFs…' }).click()
    const header = (name: string) => panel(page).locator('header', { hasText: name })
    const from = await header('Three').boundingBox()
    const to = await header('One').boundingBox()
    if (!from || !to) throw new Error('no header')
    await page.mouse.move(from.x + 20, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + 20, from.y - 10, { steps: 4 })
    await page.mouse.move(to.x + 20, to.y + 2, { steps: 8 })
    await page.mouse.up()
    const names = async () => (await groups(savedConfig)).map((g) => g.name)
    await expect.poll(names).toEqual(['Three', 'One', 'Two'])

    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(names).toEqual(['One', 'Two', 'Three'])
  })
})
