/**
 * Three widgets that try to leave their frame, loaded from the widget author's folder of a server
 * of their own (`devWidgets`): see fixtures/widgets/. The ideas are those of
 * scripts/check-widget-sandbox.ts, which also covers the network side in both engines.
 */
import { expect, test } from '../fixtures/test.js'
import { baseConfig, type ConfigSeed } from '../fixtures/seeds.js'

function hostile(): ConfigSeed {
  const c = baseConfig()
  for (const [i, id] of ['zz-top', 'zz-away', 'zz-hop'].entries()) {
    c.widgets[`${id}-1`] = { widgetId: id, showTitle: true, settings: {} }
    c.screens[0].pages[0].items.push({ instanceId: `${id}-1`, x: 16 + i * 8, y: 0, w: 8, h: 4 })
  }
  return c
}

test.use({ devWidgets: ['zz-top', 'zz-away', 'zz-hop'], seed: hostile() })

test('a widget frame cannot navigate the dashboard, nor itself off its folder, nor run a second page', async ({ page, signIn, server }) => {
  const said: string[] = []
  page.on('console', (m) => { if (m.text().startsWith('E2E ')) said.push(m.text()) })
  const from = server.log.length
  await signIn('/')
  await expect(page.locator('iframe')).toHaveCount(4)

  // Each one tried.
  await expect.poll(() => said.filter((s) => s.endsWith(': trying')).sort())
    .toEqual(['E2E zz-away: trying', 'E2E zz-hop: trying', 'E2E zz-top: trying'])
  // The hop was served — the request reached the server — so its page had every chance to run.
  await expect.poll(() => server.log.slice(from).join('')).toContain('/widgets/zz-hop/second.html')
  await page.waitForTimeout(500)

  expect(new URL(page.url()).pathname).toBe('/')
  expect(said).not.toContain('E2E zz-hop: SECOND PAGE RAN')
  const log = server.log.slice(from).join('')
  expect(log).not.toContain('/escaped-top')
  expect(log).not.toContain('/escaped-frame')
  // The dashboard is still the dashboard.
  await expect(page.locator('nav .page-button')).toHaveCount(1)
})
