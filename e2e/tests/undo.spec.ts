import type { Page } from '@playwright/test'
import { expect, test, tile, tiles } from '../fixtures/test.js'
import { menuItem } from '../fixtures/board.js'
import { baseConfig, type ConfigSeed } from '../fixtures/seeds.js'

function seed(): ConfigSeed {
  const c = baseConfig()
  c.screens[0].pages.push({ id: 'second', name: 'Second', items: [] })
  return c
}
test.use({ seed: seed() })

const card = (page: Page, name: string) => page.locator('.sidebar .card').filter({ has: page.locator('strong').getByText(name, { exact: true }) })
const pageRow = (page: Page, name: string) => page.locator('.sidebar ul > li').filter({ hasText: name })

/** What the edits below touch, as the server has it. */
async function shape(saved: () => Promise<ConfigSeed>) {
  const c = await saved()
  const edge = c.screens[0]
  return {
    pages: edge.pages.map((p) => p.name),
    home: edge.pages[0].items.map((p) => ({ widget: c.widgets[p.instanceId]?.widgetId, x: p.x, y: p.y, w: p.w, h: p.h })),
    widgets: Object.values(c.widgets).map((w) => w.widgetId).sort(),
  }
}

const SEEDED = {
  pages: ['Home', 'Second'],
  home: [{ widget: 'clock', x: 0, y: 0, w: 16, h: 4 }],
  widgets: ['clock'],
}

test('undo and redo walk back and forth through edits of every kind, and the server follows', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  const undo = page.getByRole('button', { name: 'Undo (Cmd+Z)' })
  const redo = page.getByRole('button', { name: 'Redo (Cmd+Shift+Z)' })
  await expect(undo).toBeDisabled()

  // 1. The clock nudged down twice (a held key would be one step; two presses are two).
  // 2. A widget from the library. 3. A page renamed from its menu. 4. A page added.
  await tile(page, 'clock-1').click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await card(page, 'Pomodoro').click()
  await pageRow(page, 'Second').click({ button: 'right' })
  await menuItem(page, 'Rename').click()
  await page.locator('.sidebar ul > li input').fill('Renamed')
  await page.locator('.sidebar ul > li input').press('Enter')
  await page.getByRole('button', { name: 'Add a page' }).click()

  const edited = {
    pages: ['Home', 'Renamed', 'New page'],
    home: [{ widget: 'clock', x: 0, y: 2, w: 16, h: 4 }, { widget: 'pomodoro', x: expect.any(Number), y: expect.any(Number), w: 8, h: 6 }],
    widgets: ['clock', 'pomodoro'],
  }
  await expect.poll(() => shape(savedConfig)).toEqual(edited)

  // Back one step at a time, with the keyboard and the button.
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => shape(savedConfig)).toMatchObject({ pages: ['Home', 'Renamed'] })
  await undo.click()
  await expect.poll(() => shape(savedConfig)).toMatchObject({ pages: ['Home', 'Second'] })
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await shape(savedConfig)).widgets).toEqual(['clock'])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await shape(savedConfig)).home).toEqual([{ widget: 'clock', x: 0, y: 1, w: 16, h: 4 }])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => shape(savedConfig)).toEqual(SEEDED)
  await expect(undo).toBeDisabled()
  await pageRow(page, 'Home').click()
  await expect(tiles(page)).toHaveCount(1)

  // And forward again to where the edits ended.
  for (let i = 0; i < 4; i++) await page.keyboard.press('ControlOrMeta+Shift+z')
  await redo.click()
  await expect.poll(() => shape(savedConfig)).toEqual(edited)
  await expect(redo).toBeDisabled()
  await pageRow(page, 'Home').click()
  await expect(tiles(page)).toHaveCount(2)

  // A new edit after an undo drops what could have been redone.
  await undo.click()
  await expect(redo).toBeEnabled()
  await card(page, 'Uptime').click()
  await expect(redo).toBeDisabled()
  await expect.poll(async () => (await shape(savedConfig)).widgets).toEqual(['clock', 'pomodoro', 'uptime'])
})
