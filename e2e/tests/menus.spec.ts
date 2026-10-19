import type { Page } from '@playwright/test'
import { expect, test, tile, tiles } from '../fixtures/test.js'
import { menuItem, rightClickCell } from '../fixtures/board.js'
import { baseConfig, deviceScreen, type ConfigSeed } from '../fixtures/seeds.js'

/** The Edge with two pages and two widgets in its bar, and a device screen beside it. */
function seed(): ConfigSeed {
  const c = baseConfig()
  c.widgets['pomodoro-bar'] = { widgetId: 'pomodoro', showTitle: true, settings: {} }
  c.widgets['clock-bar'] = { widgetId: 'clock', showTitle: true, settings: {} }
  c.screens[0].nav = [{ instanceId: 'pomodoro-bar', slot: 'left' }, { instanceId: 'clock-bar', slot: 'left' }]
  c.screens[0].pages.push({ id: 'second', name: 'Second', items: [] }, { id: 'third', name: 'Third', items: [] })
  c.screens.push(deviceScreen())
  return c
}
test.use({ seed: seed() })

const pageRows = (page: Page) => page.locator('.sidebar ul > li')
const pageRow = (page: Page, name: string) => pageRows(page).filter({ hasText: name })
const screenTab = (page: Page, name: string) => page.getByRole('tab', { name })
const edge = (c: ConfigSeed) => c.screens.find((s) => s.id === 'edge')!
const desk = (c: ConfigSeed) => c.screens.find((s) => s.id === 'desk')!

test('widget menu: duplicate, move to page, opacity', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await tile(page, 'clock-1').click({ button: 'right' })
  await menuItem(page, 'Duplicate').click()
  await expect(tiles(page)).toHaveCount(2)
  const copy = (await page.locator('[data-test="tile"].selected').getAttribute('data-instance-id'))!
  expect(copy).not.toBe('clock-1')

  // The copy goes to the page named in the submenu, and the editor follows it there.
  await tile(page, copy).click({ button: 'right' })
  await menuItem(page, 'Move to page').click()
  await menuItem(page, 'Third').click()
  await expect(pageRow(page, 'Third')).toHaveClass(/\bon\b/)
  await expect(tiles(page)).toHaveCount(1)

  // Appearance → a preset opacity, stored on the widget.
  await tile(page, copy).click({ button: 'right' })
  await menuItem(page, 'Appearance').click()
  await menuItem(page, 'Opacity 40%').click()

  await expect.poll(async () => {
    const c = await savedConfig()
    return {
      home: edge(c).pages[0].items.map((p) => p.instanceId),
      third: edge(c).pages[2].items.map((p) => p.instanceId),
      widget: c.widgets[copy] && { widgetId: c.widgets[copy].widgetId, opacity: c.widgets[copy].opacity },
    }
  }).toEqual({ home: ['clock-1'], third: [copy], widget: { widgetId: 'clock', opacity: 0.4 } })

  await tile(page, copy).click({ button: 'right' })
  await menuItem(page, 'Appearance').click()
  await expect(menuItem(page, 'Opacity 40%')).toHaveAttribute('aria-checked', 'true')
})

test('copy a widget, paste it on another page and on another screen', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await tile(page, 'clock-1').click({ button: 'right' })
  await menuItem(page, 'Copy').click()

  // Another page: the canvas's own menu pastes.
  await pageRow(page, 'Second').click()
  await expect(tiles(page)).toHaveCount(0)
  await rightClickCell(page, 30.25, 8.25)
  await menuItem(page, 'Paste').click()
  await expect(tiles(page)).toHaveCount(1)

  // Another screen: the clipboard follows, and ⌘V pastes.
  await screenTab(page, 'Desk').click()
  await expect(tiles(page)).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+v')
  await expect(tiles(page)).toHaveCount(1)

  await expect.poll(async () => {
    const c = await savedConfig()
    const ids = [edge(c).pages[1].items[0]?.instanceId, desk(c).pages[0].items[0]?.instanceId]
    return ids.map((id) => id && id !== 'clock-1' ? c.widgets[id]?.widgetId : null)
  }).toEqual(['clock', 'clock'])
})

test('canvas menu: new page; paste is off with nothing copied', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await rightClickCell(page, 40.25, 10.25)
  await expect(menuItem(page, 'Paste')).toHaveAttribute('aria-disabled', 'true')
  await menuItem(page, 'New page').click()
  await expect(pageRows(page)).toHaveCount(4)
  await expect(pageRows(page).nth(3)).toHaveClass(/\bon\b/)
  await expect.poll(async () => edge(await savedConfig()).pages.length).toBe(4)
})

test('pages list: rename, reorder by drag, page background', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()

  // Rename from the row's menu: an inline field, Enter commits.
  await pageRow(page, 'Second').click({ button: 'right' })
  await menuItem(page, 'Rename').click()
  const field = pageRows(page).locator('input')
  await expect(field).toBeFocused()
  await field.fill('Renamed')
  await field.press('Enter')
  await expect(pageRow(page, 'Renamed')).toBeVisible()

  // Drag "Third" above "Home".
  const from = await pageRow(page, 'Third').boundingBox()
  const to = await pageRow(page, 'Home').boundingBox()
  await page.mouse.move(from!.x + 20, from!.y + from!.height / 2)
  await page.mouse.down()
  await page.mouse.move(from!.x + 20, to!.y + 2, { steps: 10 })
  await page.mouse.up()
  await expect(pageRows(page)).toHaveText([/Third/, /Home/, /Renamed/])

  // Page background…: the inspector shows the page's own section, and a colour there is the page's.
  await pageRow(page, 'Renamed').click({ button: 'right' })
  await menuItem(page, 'Page background…').click()
  await expect(pageRow(page, 'Renamed')).toHaveClass(/\bon\b/)
  const colour = page.getByLabel('Page background colour')
  await expect(colour).toBeVisible()
  await colour.fill('#336699')

  await expect.poll(async () => edge(await savedConfig()).pages.map((p) => [p.name, p.background?.color ?? null]))
    .toEqual([['Third', null], ['Home', null], ['Renamed', '#336699']])
})

test('bar widget menu: reorder within the bar, remove from it', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  const barItem = (id: string) => page.locator(`.board [data-nav-instance="${id}"]`)
  await barItem('pomodoro-bar').click({ button: 'right' })
  await expect(menuItem(page, 'Move left')).toHaveAttribute('aria-disabled', 'true')
  await menuItem(page, 'Move right').click()
  await expect.poll(async () => edge(await savedConfig()).nav.map((n) => n.instanceId)).toEqual(['clock-bar', 'pomodoro-bar'])

  // Its only place: removing it is deleting it, confirmed in a submenu that names it.
  await barItem('pomodoro-bar').click({ button: 'right' })
  await menuItem(page, 'Delete everywhere').click()
  await menuItem(page, 'Delete “Pomodoro”').click()
  await expect(barItem('pomodoro-bar')).toHaveCount(0)
  await expect.poll(async () => {
    const c = await savedConfig()
    return { nav: edge(c).nav.map((n) => n.instanceId), widget: 'pomodoro-bar' in c.widgets }
  }).toEqual({ nav: ['clock-bar'], widget: false })
})

test('screen selector menu: rename, open the screen settings', async ({ page, openAdmin, savedConfig }) => {
  await openAdmin()
  await screenTab(page, 'Desk').click({ button: 'right' })
  await menuItem(page, 'Rename').click()
  const field = page.getByLabel('Screen name')
  await expect(field).toBeFocused()
  await field.fill('Study')
  await field.press('Enter')
  await expect(screenTab(page, 'Study')).toBeVisible()
  await expect.poll(async () => desk(await savedConfig()).name).toBe('Study')

  await screenTab(page, 'Xeneon Edge').click({ button: 'right' })
  await menuItem(page, 'Screen settings…').click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await expect(screenTab(page, 'Xeneon Edge')).toHaveAttribute('aria-selected', 'true')
})
