import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A POSIX absolute path such as `/usr/bin/open` is drive-relative on Windows: it resolves to
 * `C:\usr\bin\open`, and libuv appends `.exe`. Any local account may create `C:\usr` or `C:\opt`,
 * so a Mac tool path that a Windows server can reach runs a planted program as the user.
 *
 * Every file under `src/` that holds such a literal is listed here with the reason it never runs
 * on `win32`. A new file with one fails this test: gate it on `targetPlatform()` (or keep it behind
 * a darwin-only channel), then add it here with that reason. A file that no longer holds one fails
 * too, so the list stays the real one.
 */
const GATED: Record<string, string> = {
  'apps/icons.ts': 'app icons are read only when the dock family runs (darwin-only, `noApps` in app.ts)',
  'apps/installed.ts': 'installed apps are listed only when the dock family runs (darwin-only, `noApps` in app.ts)',
  'providers/bambu-rtsp.ts': 'resolveFfmpeg takes absolute X:\\ PATH entries only on win32, no fallback list',
  'claude/account.ts': 'win32 reads .credentials.json; `security` is the darwin branch',
  'claude/attention.ts': 'win32 returns before afplay',
  'claude/focus.ts': 'focus answers `unsupported` on win32 before any tool runs',
  'claude/identity.ts': 'claudeCandidates has its own win32 list',
  'claude/processes.ts': 'listClaudeProcesses returns null on win32',
  'codex/sqlite.ts': 'win32 uses node:sqlite, never the sqlite3 CLI',
  'devices/bonjour.ts': 'win32 advertises through ciao, never dns-sd',
  'devices/certificate.ts': 'win32 makes the key and certificate in process, never openssl',
  'devices/host.ts': 'every scutil/route call sits behind `onWindows`',
  'diagnostics/report.ts': 'the Mac version and names are read only when not win32',
  'dock/provider.ts': 'the dock family is darwin-only (CHANNEL_PLATFORMS)',
  'helper/routes.ts': 'the helper routes answer 503 on win32 without running anything',
  'platform/index.ts': 'SYSTEM_DIRS is the darwin branch of safePath',
  'platform/open-url.ts': 'win32 opens through rundll32 by windowsTool()',
  'providers/battery.ts': 'win32 reads through the PowerShell host',
  'providers/clipboard.ts': 'win32 uses winPasteboard (the PowerShell host)',
  'providers/cleanshot.ts': 'the cleanshot family is darwin-only (CHANNEL_PLATFORMS)',
  'providers/disk-map.ts': 'the disk-map family is darwin-only (CHANNEL_PLATFORMS)',
  'providers/disk-map-scanner.ts': 'the disk-map family is darwin-only (CHANNEL_PLATFORMS)',
  'providers/local-operations.ts': 'docker candidates have their own win32 list',
  'providers/mac-readings.ts': 'system.ts calls it only on the Mac',
  'providers/mac-thermals.ts': 'supported only on darwin arm64',
  'providers/network.ts': 'win32 reads through the PowerShell host',
  'providers/osascript.ts': 'its callers (spotify, volume) take another path on win32 or are darwin-only',
  'providers/rtk.ts': 'rtk candidates have their own win32 list',
  'providers/service-status.ts': 'ping is windowsTool(\'ping\') on win32',
  'providers/shortcuts.ts': 'the shortcuts family is darwin-only (CHANNEL_PLATFORMS)',
  'providers/spotify.ts': 'the spotify family is darwin-only (CHANNEL_PLATFORMS)',
  'secrets/keychain.ts': 'the secret store is DPAPI on win32 (createSecretStore)',
}

/** A string literal opening on a POSIX system folder, outside a comment line. */
const LITERAL = /['"`]\/(?:usr|opt|bin|sbin)\//
const isComment = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

const SRC = join(import.meta.dirname, '..', 'src')
const gated = new Set(Object.keys(GATED))

describe('POSIX tool paths reachable on Windows', () => {
  const holders = sourceFiles(SRC)
    .filter((file) => readFileSync(file, 'utf8').split('\n').some((line) => !isComment(line) && LITERAL.test(line)))
    .map((file) => relative(SRC, file).split(sep).join('/'))

  it('live only in files whose literals are gated off win32', () => {
    expect(holders.filter((file) => !gated.has(file))).toEqual([])
  })

  it('lists no file that no longer holds one', () => {
    expect([...gated].filter((file) => !holders.includes(file))).toEqual([])
  })
})
