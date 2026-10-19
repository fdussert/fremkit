import { expect, test, tile } from '../fixtures/test.js'
import { cellPoint, dragCells, menuItem } from '../fixtures/board.js'
import { baseConfig, type ConfigSeed } from '../fixtures/seeds.js'

/** The clock at 0,0 (16 × 4), a pomodoro at 20,8 (8 × 6) and a second clock at 40,2 (8 × 4). */
function seed(): ConfigSeed {
  const c = baseConfig()
  c.widgets['pomodoro-1'] = { widgetId: 'pomodoro', showTitle: true, settings: {} }
  c.widgets['clock-2'] = { widgetId: 'clock', showTitle: true, settings: {} }
  c.screens[0].pages[0].items.push(
    { instanceId: 'pomodoro-1', x: 20, y: 8, w: 8, h: 6 },
    { instanceId: 'clock-2', x: 40, y: 2, w: 8, h: 4 },
  )
  return c
}
test.use({ seed: seed() })

const selected = (page: import('@playwright/test').Page) => page.locator('[data-test="tile"].selected')
const placementsOf = (c: ConfigSeed) => Object.fromEntries(c.screens[0].pages[0].items.map((p) => [p.instanceId, [p.x, p.y]]))

const guides = (page: import('@playwright/test').Page) => page.locator('[data-test="guide"]')

test('alignment guides show while a tile is dragged into line, and go on release', async ({ page, openAdmin }) => {
  await openAdmin()
  await expect(guides(page)).toHaveCount(0)
  // Grab the clock and bring its left edge to the pomodoro's (x = 20), its top at 7: nothing else lines up.
  const a = await cellPoint(page, 3.25, 1.25)
  const b = await cellPoint(page, 23.25, 8.25)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 8 })
  await expect(guides(page)).not.toHaveCount(0)
  await expect(page.locator('[data-test="guide"].x')).not.toHaveCount(0)
  await page.mouse.up()
  await expect(guides(page)).toHaveCount(0)
})

test('an arrow key that brings a tile into line flashes its guides', async ({ page, openAdmin }) => {
  await openAdmin()
  await tile(page, 'clock-2').click()
  // Six steps down put clock-2's top at 8, in line with the pomodoro's.
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown')
  await expect(page.locator('[data-test="guide"].y')).not.toHaveCount(0)
  await expect(guides(page)).toHaveCount(0, { timeout: 3000 })
})

test('shift-click builds a group that moves and is deleted as one', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await tile(page, 'clock-1').click()
  await tile(page, 'clock-2').click({ modifiers: ['Shift'] })
  await expect(selected(page)).toHaveCount(2)
  await expect(page.getByText('2 widgets selected')).toBeVisible()
  // ⌘-click takes one out, and puts it back. Meta, not ControlOrMeta: on Linux that is Control,
  // and a Control-click is the Mac's right click, which the editor leaves to the menu.
  await tile(page, 'clock-2').click({ modifiers: ['Meta'] })
  await expect(selected(page)).toHaveCount(1)
  await tile(page, 'clock-2').click({ modifiers: ['Shift'] })
  await expect(selected(page)).toHaveCount(2)

  // Dragging either one moves both, two cells right and two down.
  await dragCells(page, [43.25, 3.25], [45.25, 5.25])
  await expect.poll(async () => placementsOf(await savedConfig()))
    .toEqual({ 'clock-1': [2, 2], 'pomodoro-1': [20, 8], 'clock-2': [42, 4] })
  await expect(selected(page)).toHaveCount(2)

  // Both are on their last screen: Delete arms, a second Delete confirms, one step to undo.
  await page.keyboard.press('Delete')
  await expect(page.getByRole('button', { name: 'Confirm?' })).toBeVisible()
  await page.keyboard.press('Delete')
  await expect.poll(async () => Object.keys(placementsOf(await savedConfig()))).toEqual(['pomodoro-1'])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => Object.keys(placementsOf(await savedConfig())).sort()).toEqual(['clock-1', 'clock-2', 'pomodoro-1'])
})

test('a marquee selects what it touches; arrows move the group, ⌘A and Escape', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  // From an empty cell across the pomodoro and the second clock, never reaching the first clock.
  const a = await cellPoint(page, 18.5, 1.5)
  const b = await cellPoint(page, 41.5, 12.5)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 8 })
  await expect(page.locator('[data-test="marquee"]')).toBeVisible()
  await page.mouse.up()
  await expect(page.locator('[data-test="marquee"]')).toHaveCount(0)
  await expect(selected(page)).toHaveCount(2)
  await expect(tile(page, 'clock-1')).not.toHaveClass(/selected/)

  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => placementsOf(await savedConfig()))
    .toEqual({ 'clock-1': [0, 0], 'pomodoro-1': [21, 8], 'clock-2': [41, 2] })
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => placementsOf(await savedConfig()))
    .toEqual({ 'clock-1': [0, 0], 'pomodoro-1': [20, 8], 'clock-2': [40, 2] })

  // The group's own menu, on a right click of any of its tiles.
  await tile(page, 'pomodoro-1').click({ button: 'right' })
  await expect(menuItem(page, 'Delete everywhere')).toBeVisible()
  await expect(menuItem(page, 'Lock position')).toBeVisible()
  // One widget's commands are not there.
  await expect(menuItem(page, 'Copy style')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(selected(page)).toHaveCount(2)

  await page.keyboard.press('ControlOrMeta+a')
  await expect(selected(page)).toHaveCount(3)
  await page.keyboard.press('Escape')
  await expect(selected(page)).toHaveCount(0)
})
