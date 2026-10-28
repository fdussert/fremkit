import { describe, it, expect } from 'vitest'
import { identityEnv } from '../src/claude/identity.js'
import { localEnv } from '../src/providers/local-operations.js'
import { resolveCodexBinary } from '../src/codex/adapter.js'
import { envValue, isAbsoluteFolder, safePath, systemRoot, targetPlatform, windowsEnvDir, windowsTool } from '../src/platform/index.js'

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
    expect(systemRoot({ SystemRoot: 'D:\\Win\\' })).toBe('D:\\Win')
    expect(windowsTool('wsl', { SystemRoot: 'C:\\' })).toBe('C:\\System32\\wsl.exe')
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
  it('treats a trailing backslash and surrounding quotes as the same folder', () => {
    expect(safePath('C:\\Windows\\System32\\;"C:\\Tools";"C:\\Windows\\"', 'win32', env)).toBe(
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

describe('windowsEnvDir', () => {
  it('accepts an absolute folder in any case of the variable name, without a trailing slash', () => {
    expect(windowsEnvDir('USERPROFILE', { UserProfile: 'C:\\Users\\example\\' })).toBe('C:\\Users\\example')
    expect(windowsEnvDir('ProgramFiles', { PROGRAMFILES: 'D:\\' })).toBe('D:\\')
  })
  it('refuses a missing, relative or UNC value', () => {
    expect(windowsEnvDir('USERPROFILE', {})).toBeNull()
    expect(windowsEnvDir('USERPROFILE', { USERPROFILE: 'Users\\example' })).toBeNull()
    expect(windowsEnvDir('USERPROFILE', { USERPROFILE: '\\\\host\\share' })).toBeNull()
  })
})

describe('envValue (the one environment lookup)', () => {
  it('ignores case on Windows only', () => {
    const env = { Path: 'C:\\Windows', HOME: '/Users/example' }
    expect(envValue(env, 'PATH', 'win32')).toBe('C:\\Windows')
    expect(envValue(env, 'PATH', 'darwin')).toBeUndefined()
    expect(envValue(env, 'HOME', 'darwin')).toBe('/Users/example')
  })

  it('feeds every Windows child environment the same way', () => {
    const env = { path: 'C:\\Windows', userprofile: 'C:\\Users\\Example' }
    expect(identityEnv(env, 'win32')).toMatchObject({ PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Example' })
    expect(localEnv(env, 'win32')).toMatchObject({ PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Example' })
    expect(identityEnv(env, 'darwin')).toEqual({})
  })

  it('takes the Codex binary folder from a drive path only, as every other Windows folder', () => {
    for (const appData of ['\\\\server\\share\\Roaming', '\\Roaming', 'Roaming']) {
      expect(resolveCodexBinary({ APPDATA: appData }, 'win32', () => true, 'x64')).toBeNull()
    }
  })
})

describe('isAbsoluteFolder (FREMKIT_DATA_DIR)', () => {
  it('takes an absolute drive path on Windows, as docs/windows.md says, and an absolute path elsewhere', () => {
    expect(isAbsoluteFolder('D:\\fremkit-data', 'win32')).toBe(true)
    for (const path of ['\\\\server\\share\\data', '\\data', 'data', 'D:data', '/data']) expect(isAbsoluteFolder(path, 'win32'), path).toBe(false)
    expect(isAbsoluteFolder('/Users/example/data', 'darwin')).toBe(true)
    expect(isAbsoluteFolder('data', 'darwin')).toBe(false)
  })
})
