// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'

const html = readFileSync(new NodeURL('../../widgets/notifications/index.html', import.meta.url), 'utf8')
function load(appIcon: (id: string) => Promise<string>) {
  document.body.innerHTML = html.match(/<body>([\s\S]*?)<script>/)![1]!
  let publish!: (data: unknown) => void
  const F = {
    locale: 'fr', settings: {}, appIcon,
    t: (dict: {fr: string}) => dict.fr,
    whenReady: (cb: () => void) => cb(), onLocale: () => {}, onSettings: () => {},
    subscribe: (_channel: string, cb: (data: unknown) => void) => { publish = cb },
    sendCommand: vi.fn().mockResolvedValue({ok: true}),
  }
  new Function('Fremkit', html.match(/<script>([\s\S]*?)<\/script>/)![1]!)(F)
  publish({ available: true, apps: [{bundleId: 'com.apple.mail', name: 'Mail', running: true, badge: '2'}] })
  return F
}
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = '' })
describe('Notifications icons', () => {
  it('asks the host for image data instead of fetching from the opaque frame', async () => {
    const appIcon = vi.fn().mockResolvedValue('data:image/png;base64,aWNvbg==')
    load(appIcon)
    await Promise.resolve()
    expect(appIcon).toHaveBeenCalledWith('com.apple.mail')
    expect(document.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,aWNvbg==')
    expect(document.querySelector('.badge')!.textContent).toBe('2')
  })
  it('retries a missing icon and replaces the placeholder when it becomes available', async () => {
    vi.useFakeTimers()
    const appIcon = vi.fn().mockRejectedValueOnce(new Error('missing')).mockResolvedValue('data:image/png;base64,aWNvbg==')
    load(appIcon)
    await vi.advanceTimersByTimeAsync(0)
    expect(document.querySelector('.fallback')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(30000)
    expect(document.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,aWNvbg==')
    expect(document.querySelector('.fallback')).toBeNull()
  })
})
