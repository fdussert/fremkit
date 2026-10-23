import { describe, it, expect, vi } from 'vitest'
import { openUrl } from '../src/platform/open-url.js'

describe('openUrl', () => {
  it('refuses anything but http and https', async () => {
    const exec = vi.fn(async () => {})
    for (const href of ['file:///C:/x', 'javascript:alert(1)', 'codex://threads/1', '-a Calculator', '']) {
      await expect(openUrl(href, { platform: 'win32', exec })).rejects.toThrow()
      await expect(openUrl(href, { platform: 'darwin', exec })).rejects.toThrow()
    }
    expect(exec).not.toHaveBeenCalled()
  })
  it('uses rundll32 by absolute path on Windows', async () => {
    const exec = vi.fn(async () => {})
    await openUrl('https://example.com/a?b=1', { platform: 'win32', exec })
    expect(exec).toHaveBeenCalledOnce()
    const [file, args] = exec.mock.calls[0] as unknown as [string, string[]]
    expect(file).toMatch(/^[A-Za-z]:\\.*\\System32\\rundll32\.exe$/)
    expect(args).toEqual(['url.dll,FileProtocolHandler', 'https://example.com/a?b=1'])
  })
  it('uses /usr/bin/open on the Mac and passes the timeout through', async () => {
    const exec = vi.fn(async () => {})
    await openUrl('https://example.com/', { platform: 'darwin', exec, timeout: 5000 })
    expect(exec).toHaveBeenCalledWith('/usr/bin/open', ['https://example.com/'], { timeout: 5000 })
  })
  it('accepts a deep-link scheme only when the caller names it', async () => {
    const exec = vi.fn(async () => {})
    await openUrl('codex://threads/abc', { platform: 'darwin', exec, schemes: ['codex:'] })
    expect(exec).toHaveBeenCalledWith('/usr/bin/open', ['codex://threads/abc'], undefined)
  })
})
