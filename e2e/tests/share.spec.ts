import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/test.js'
import { menuItem } from '../fixtures/board.js'
import { baseConfig, deviceScreen, type ConfigSeed } from '../fixtures/seeds.js'

/**
 * A calendar connection with everything a shared file must never carry: a secret (the ICS address
 * is one, and holds a host), a name, an id. The address is a closed port on this machine, so the
 * provider the editor's preview starts fails at once instead of reaching anything.
 */
const SECRET_TOKEN = 'e2e-secret-token-5f1c'
const SECRET_HOST = '127.0.0.1:9'
const CONNECTION = {
  id: 'work-cal',
  type: 'ics',
  name: 'Work calendar of a person',
  fields: { color: '#aa3355' },
  secrets: { url: `https://${SECRET_HOST}/${SECRET_TOKEN}/calendar.ics` },
}

function seed(): ConfigSeed {
  const c = baseConfig()
  c.widgets['cal-1'] = { widgetId: 'calendar', showTitle: true, settings: { calendars: [CONNECTION.id], days: 3 } }
  c.screens[0].pages[0].items.push({ instanceId: 'cal-1', x: 16, y: 0, w: 16, h: 10 })
  c.screens.push(deviceScreen())
  return c
}
test.use({ seed: seed(), connections: [CONNECTION] })

const pageRow = (page: Page, name: string) => page.locator('.sidebar ul > li').filter({ hasText: name })

test('a page exported from one screen imports into another, with nothing secret in the file', async ({ page, api, server, openAdmin, savedConfig }) => {
  // The seed did store a secret: the API says one is there, without saying what. And it is in the
  // test's own secrets.json, never in this Mac's keychain.
  const stored = await (await api.get('/api/connections')).json() as { id: string; secrets: Record<string, boolean> }[]
  expect(stored.find((x) => x.id === CONNECTION.id)?.secrets).toEqual({ url: true })
  expect(await readFile(join(server.dataDir, 'secrets.json'), 'utf8')).toContain(SECRET_TOKEN)
  await openAdmin()

  await pageRow(page, 'Home').click({ button: 'right' })
  await menuItem(page, 'Export page…').click()
  const exportDialog = page.getByRole('dialog', { name: 'Export' })
  await expect(exportDialog.getByText('The page “Home”')).toBeVisible()
  await expect(exportDialog.getByText('1 screen(s), 1 page(s), 2 tile(s)')).toBeVisible()
  // The calendar's connection is named as left out.
  await expect(exportDialog.locator('.removed')).toContainText('points to one of your connections')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportDialog.getByRole('button', { name: 'Download' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.fremkit-layout\.json$/)
  const path = await download.path()
  const text = await readFile(path, 'utf8')
  const file = JSON.parse(text) as unknown

  // Nothing of the connection: not its secret, not the host inside it, not its name or id, not
  // its colour field.
  for (const leak of [SECRET_TOKEN, SECRET_HOST, CONNECTION.id, CONNECTION.name, CONNECTION.fields.color, 'secrets']) {
    expect(text, `the file holds "${leak}"`).not.toContain(leak)
  }
  expect(text).toContain('"calendar"')
  expect(text).toContain('"clock"')
  expect(file).toBeTruthy()
  await exportDialog.getByRole('button', { name: 'Close' }).click()

  // Into the device screen, as a new page, through its menu's file picker.
  await page.getByRole('tab', { name: 'Desk' }).click({ button: 'right' })
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    menuItem(page, 'Import a layout…').click(),
  ])
  await chooser.setFiles(path)
  const importDialog = page.getByRole('dialog', { name: 'Import a layout' })
  await expect(importDialog.getByText('The page “Home”')).toBeVisible()
  // The connection is asked for again; left for later.
  await expect(importDialog.getByText('A shared file never carries connections.', { exact: false })).toBeVisible()
  await expect(importDialog.getByRole('combobox')).toHaveValue('')
  await importDialog.getByRole('button', { name: 'Import' }).click()
  await expect(importDialog).toBeHidden()
  await expect(page.getByText(/^Layout imported/)).toBeVisible()

  await expect.poll(async () => {
    const c = await savedConfig()
    const desk = c.screens.find((s) => s.id === 'desk')!
    return desk.pages.map((p) => ({
      name: p.name,
      widgets: p.items.map((i) => c.widgets[i.instanceId]?.widgetId).sort(),
    }))
  }).toEqual([{ name: 'Main', widgets: [] }, { name: 'Home', widgets: ['calendar', 'clock'] }])

  // The imported calendar is a new widget, pointing at no connection until one is chosen.
  const c = await savedConfig()
  const desk = c.screens.find((s) => s.id === 'desk')!
  const imported = desk.pages[1].items.map((i) => c.widgets[i.instanceId]).find((w) => w.widgetId === 'calendar')!
  expect(desk.pages[1].items.map((i) => i.instanceId)).not.toContain('cal-1')
  expect(JSON.stringify(imported.settings)).not.toContain(CONNECTION.id)
  // And the original keeps its own.
  expect(c.widgets['cal-1'].settings.calendars).toEqual([CONNECTION.id])
})
