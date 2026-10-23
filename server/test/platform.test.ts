import { describe, it, expect } from 'vitest'
import { safePath, systemRoot, targetPlatform, windowsTool } from '../src/platform/index.js'

describe('targetPlatform', () => {
  it('knows darwin and win32 and treats anything else as darwin', () => {
    expect(targetPlatform('win32')).toBe('win32')
    expect(targetPlatform('darwin')).toBe('darwin')
    expect(targetPlatform('linux')).toBe('darwin')
  })
})

describe('systemRoot', () => {
  it('takes an absolute SystemRoot and falls back to C:\\Windows otherwise', () => {
    expect(systemRoot({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win')
    expect(systemRoot({ SystemRoot: 'relative\\x' })).toBe('C:\\Windows')
    expect(systemRoot({ SystemRoot: '\\\\host\\share' })).toBe('C:\\Windows')
    expect(systemRoot({})).toBe('C:\\Windows')
  })
})

describe('windowsTool', () => {
  const env = { SystemRoot: 'C:\\Windows' }
  it('builds absolute paths from the system root', () => {
    expect(windowsTool('powershell', env)).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(windowsTool('wsl', env)).toBe('C:\\Windows\\System32\\wsl.exe')
    expect(windowsTool('icacls', env)).toBe('C:\\Windows\\System32\\icacls.exe')
    expect(windowsTool('rundll32', { SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\rundll32.exe')
    expect(windowsTool('ping', {})).toBe('C:\\Windows\\System32\\PING.EXE')
    expect(windowsTool('whoami', env)).toBe('C:\\Windows\\System32\\whoami.exe')
  })
})

describe('safePath on win32', () => {
  const env = { SystemRoot: 'C:\\Windows' }
  it('puts the system folders first, dedupes case-insensitively and drops relative entries', () => {
    expect(safePath('C:\\Tools;.;;C:\\Windows\\system32', 'win32', env)).toBe(
      'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Tools')
  })
  it('follows the system root', () => {
    expect(safePath(undefined, 'win32', { SystemRoot: 'D:\\Win' })).toBe(
      'D:\\Win\\System32;D:\\Win;D:\\Win\\System32\\Wbem;D:\\Win\\System32\\WindowsPowerShell\\v1.0')
  })
  it('keeps the macOS behaviour elsewhere', () => {
    expect(safePath('/opt/homebrew/bin:/usr/bin', 'darwin')).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin')
    expect(safePath('/opt/x', 'linux')).toBe('/usr/bin:/bin:/usr/sbin:/sbin:/opt/x')
  })
})
