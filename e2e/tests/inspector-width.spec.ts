import { expect, test } from '../fixtures/test.js'

test('the inspector widens by its edge, keeps that width, and a double click brings it back', async ({ page, openAdmin, savedConfig }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await openAdmin()
  const panel = page.locator('aside.inspector')
  const grip = page.getByRole('separator', { name: 'Panel width' })
  await expect(panel).toHaveCSS('width', '300px')
  const before = JSON.stringify(await savedConfig())

  const box = (await grip.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 200, box.y + 200, { steps: 5 })
  await page.mouse.up()
  await expect(panel).toHaveCSS('width', '500px')

  // A habit of this browser, not a change to the dashboard.
  await page.reload()
  await expect(panel).toHaveCSS('width', '500px')
  expect(JSON.stringify(await savedConfig())).toBe(before)

  await grip.dblclick()
  await expect(panel).toHaveCSS('width', '300px')
  await grip.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(panel).toHaveCSS('width', '320px')
})
