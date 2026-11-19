import type { Page } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '../fixtures/test.js'

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' })
const sidebar = (page: Page) => settings(page).getByRole('navigation', { name: 'Settings' })
// The pane's title is the first h3: a pane may hold its own (About's Diagnostics).
const heading = (page: Page) => settings(page).locator('h3').first()
const search = (page: Page) => sidebar(page).getByPlaceholder('Search settings')

test('the settings window lists the screens and the app panes, each on its own', async ({ page, openAdmin }) => {
  await openAdmin()
  // iPad pairing and extra screens are there on a fresh dashboard: "Add a screen" above the
  // canvas, Devices in the sidebar.
  await expect(page.getByRole('button', { name: '+ Add a screen' })).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(settings(page)).toBeVisible()
  await expect(sidebar(page).getByRole('button')).toHaveText(
    ['Xeneon Edge', 'General', 'Appearance', 'Share', 'History & backup', 'Privacy', 'Devices', 'About'])

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

test('each Claude account in use gets a name field, saved under its account', async ({ page, api, openAdmin, savedConfig }) => {
  // A Claude Code profile folder signed in to a placeholder account, and one hook event from a
  // session running in it: what makes the server list the account.
  const uuid = '00000000-0000-4000-8000-0000000e2e01'
  const profile = await mkdtemp(join(tmpdir(), 'fremkit-e2e-claude-'))
  await mkdir(join(profile, 'projects', '-p'), { recursive: true })
  await writeFile(join(profile, '.claude.json'), JSON.stringify({
    oauthAccount: { accountUuid: uuid, emailAddress: 'someone@example.com', organizationType: 'claude_max', organizationName: 'Example Corp' },
  }))
  const hook = await api.post('/api/hooks/claude', { data: { hook_event_name: 'UserPromptSubmit', session_id: 'e2e-accounts', cwd: '/p', transcript_path: join(profile, 'projects', '-p', 'e2e.jsonl') } })
  expect(hook.status()).toBe(204)

  await openAdmin()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await sidebar(page).getByRole('button', { name: 'Privacy' }).click()
  await expect(settings(page).getByText('Claude accounts', { exact: true })).toBeVisible()
  const field = settings(page).getByLabel(/Max plan · Example Corp · seen/)
  await expect(field).toHaveAttribute('placeholder', 'Max')
  // Never the address, even in a label.
  await expect(settings(page).getByText(/example\.com/)).toHaveCount(0)
  await field.fill('  Work  ')
  await field.press('Enter')
  await expect.poll(async () => ((await savedConfig()) as { privacy?: { claudeAccountNames?: unknown } }).privacy?.claudeAccountNames).toEqual({ [uuid]: 'Work' })
  // Emptied, the row goes back to the plan.
  await field.fill('')
  await field.press('Enter')
  await expect.poll(async () => ((await savedConfig()) as { privacy?: { claudeAccountNames?: unknown } }).privacy?.claudeAccountNames).toEqual({})

  // The search finds the fields' block by its title.
  await search(page).fill('Claude accounts')
  await expect(settings(page).locator('[data-section="screen.privacy"]')).toBeVisible()
})
