/**
 * The editor's board, in grid cells rather than pixels.
 *
 * The admin scales the screen's board to fit the window, so a cell is a few pixels whose size
 * depends on the viewport. The overlay that takes the drags covers the grid exactly; a point is
 * found from its box. Edits snap to the nearest grid line (`snapPoint`), so a drag is aimed a
 * quarter of a cell past a line, never at it.
 */
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

export const overlay = (page: Page) => page.locator('.board .overlay')

/** The page coordinates of grid point (`x`, `y`), in cells, on a screen `cols` cells wide. */
export async function cellPoint(page: Page, x: number, y: number, cols = 64): Promise<{ x: number; y: number }> {
  const box = await overlay(page).boundingBox()
  expect(box).not.toBeNull()
  const cell = box!.width / cols
  return { x: box!.x + x * cell, y: box!.y + y * cell }
}

/** Presses at grid point `from`, moves in steps to `to`, releases. */
export async function dragCells(page: Page, from: [number, number], to: [number, number], cols = 64): Promise<void> {
  const a = await cellPoint(page, from[0], from[1], cols)
  const b = await cellPoint(page, to[0], to[1], cols)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 8 })
  await page.mouse.up()
}

/** Right-clicks grid point (`x`, `y`). */
export async function rightClickCell(page: Page, x: number, y: number, cols = 64): Promise<void> {
  const p = await cellPoint(page, x, y, cols)
  await page.mouse.click(p.x, p.y, { button: 'right' })
}

/**
 * An item of the open context menus, by its label alone: an item's accessible name also holds its
 * shortcut ("Duplicate⌘D"), which a test should not have to spell.
 */
export const menuItem = (page: Page, label: string) =>
  page.locator('[role="menu"] [role^="menuitem"]').filter({ has: page.locator('.label').getByText(label, { exact: true }) })
