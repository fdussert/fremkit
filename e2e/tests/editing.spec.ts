import type { Page } from '@playwright/test'
import { expect, test, tile, tiles } from '../fixtures/test.js'
import { cellPoint, dragCells, menuItem, overlay } from '../fixtures/board.js'
import type { ConfigSeed, Placement } from '../fixtures/seeds.js'

const card = (page: Page, name: string) => page.locator('.sidebar .card').filter({ has: page.locator('strong').getByText(name, { exact: true }) })

/** The placements of the Edge's first page as saved, waiting for the debounced save to land. */
function placements(saved: () => Promise<ConfigSeed>, page = 0) {
  return async (): Promise<Placement[]> => (await saved()).screens[0].pages[page].items
}
const placementOf = (items: Placement[], instanceId: string) => items.find((p) => p.instanceId === instanceId)
const geometry = (p: Placement | undefined) => p && { x: p.x, y: p.y, w: p.w, h: p.h, locked: !!p.locked }

test('a click on a library card adds the widget in the largest free spot, selected', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await expect(tiles(page)).toHaveCount(1)
  await card(page, 'Pomodoro').click()
  await expect(tiles(page)).toHaveCount(2)
  const added = page.locator('[data-test="tile"].selected')
  await expect(added).toHaveAttribute('data-instance-id', /^pomodoro/)
  const id = (await added.getAttribute('data-instance-id'))!
  await expect.poll(async () => (await placements(savedConfig)()).map((p) => p.instanceId)).toEqual(['clock-1', id])
  const saved = await savedConfig()
  expect(saved.widgets[id]).toMatchObject({ widgetId: 'pomodoro', showTitle: true })
})

test('dragging a library card drops the widget where it is released', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  const target = await cellPoint(page, 40.25, 8.25)
  const box = await overlay(page).boundingBox()
  await card(page, 'Pomodoro').dragTo(overlay(page), { targetPosition: { x: target.x - box!.x, y: target.y - box!.y } })
  await expect(tiles(page)).toHaveCount(2)
  // Centred on the cell it was dropped on, at its default 8 × 6.
  const id = (await page.locator('[data-test="tile"].selected').getAttribute('data-instance-id'))!
  expect(id).toMatch(/^pomodoro/)
  await expect.poll(async () => geometry(placementOf(await placements(savedConfig)(), id)))
    .toEqual({ x: 36, y: 5, w: 8, h: 6, locked: false })
})

test('a tile moves and resizes with the mouse', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  // The clock sits at 0,0, 16 × 4. Grabbed a little inside, dropped ten cells right and two down.
  await dragCells(page, [3.25, 1.25], [13.25, 3.25])
  await expect.poll(async () => geometry(placementOf(await placements(savedConfig)(), 'clock-1')))
    .toEqual({ x: 10, y: 2, w: 16, h: 4, locked: false })

  // Selected by the drag, so its handles show: the bottom-right one adds four columns and a row.
  const handle = tile(page, 'clock-1').locator('[data-test="handle-se"]')
  await expect(handle).toBeVisible()
  await dragCells(page, [26, 6], [30, 7])
  await expect.poll(async () => geometry(placementOf(await placements(savedConfig)(), 'clock-1')))
    .toEqual({ x: 10, y: 2, w: 20, h: 5, locked: false })
})

test('a selected tile moves with the arrows and resizes with shift-arrows', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await tile(page, 'clock-1').click()
  await expect(tile(page, 'clock-1')).toHaveClass(/selected/)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  await expect.poll(async () => geometry(placementOf(await placements(savedConfig)(), 'clock-1')))
    .toEqual({ x: 2, y: 1, w: 17, h: 5, locked: false })
  // Nothing moves past the grid's edge, and Escape lets go of the tile.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => geometry(placementOf(await placements(savedConfig)(), 'clock-1')))
    .toEqual({ x: 0, y: 1, w: 17, h: 5, locked: false })
  await page.keyboard.press('Escape')
  await expect(tile(page, 'clock-1')).not.toHaveClass(/selected/)
})

test('a locked tile stays where it is until unlocked', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await tile(page, 'clock-1').click({ button: 'right' })
  await menuItem(page, 'Lock position').click()
  await expect(tile(page, 'clock-1').locator('.lock')).toBeVisible()
  await expect.poll(async () => geometry(placementOf(await placements(savedConfig)(), 'clock-1')))
    .toEqual({ x: 0, y: 0, w: 16, h: 4, locked: true })

  // Neither the mouse nor the keyboard moves it, and it shows no handles.
  await dragCells(page, [3.25, 1.25], [13.25, 3.25])
  await expect(tile(page, 'clock-1').locator('[data-test="handle-se"]')).toBeHidden()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(tile(page, 'clock-1')).toHaveClass(/selected/)

  await tile(page, 'clock-1').click({ button: 'right' })
  await expect(menuItem(page, 'Lock position')).toHaveAttribute('aria-checked', 'true')
  await menuItem(page, 'Lock position').click()
  await expect(tile(page, 'clock-1').locator('.lock')).toBeHidden()
  // Still at the origin: the attempts above changed nothing.
  await expect.poll(async () => geometry(placementOf(await placements(savedConfig)(), 'clock-1')))
    .toEqual({ x: 0, y: 0, w: 16, h: 4, locked: false })

  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => geometry(placementOf(await placements(savedConfig)(), 'clock-1')))
    .toEqual({ x: 1, y: 0, w: 16, h: 4, locked: false })
})
