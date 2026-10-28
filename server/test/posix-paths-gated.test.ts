import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A POSIX absolute path such as `/usr/bin/open` is drive-relative on Windows: it resolves to
 * `C:\usr\bin\open`, and libuv appends `.exe`. Any local account may create `C:\usr` or `C:\opt`,
 * so a Mac tool path that a Windows server can reach runs a planted program as the user.
 *
 * Every file under `src/` that holds such a literal is listed here with how many lines hold one and
 * the reason they never run on `win32`. A new file with one, or one line more in a listed file,
 * fails this test: gate it on `targetPlatform()` (or keep it behind a darwin-only channel), then
 * update the entry and its reason. A count that went down fails too, so the list stays the real one.
 * The macOS system folders are covered (`/usr`, `/opt`, `/bin`, `/sbin`, `/Applications`,
 * `/System`, `/Library`, `/private`, `/var`, `/etc`): all of them are drive-relative on Windows.
 */
const GATED: Record<string, [lines: number, reason: string]> = {
  'apps/icons.ts': [1, 'app icons are read only when the dock family runs (darwin-only, `noApps` in app.ts)'],
  'apps/installed.ts': [3, 'installed apps are listed only when the dock family runs (darwin-only, `noApps` in app.ts)'],
  'providers/bambu-rtsp.ts': [4, 'resolveFfmpeg takes absolute X:\\ PATH entries only on win32, no fallback list'],
  'claude/account.ts': [1, 'win32 reads .credentials.json; `security` is the darwin branch'],
  'claude/attention.ts': [1, 'win32 returns before afplay'],
  'claude/focus.ts': [11, 'focus answers `unsupported` on win32 before any tool runs'],
  'claude/identity.ts': [1, 'claudeCandidates has its own win32 list'],
  'claude/processes.ts': [2, 'listClaudeProcesses returns null on win32'],
  'codex/sqlite.ts': [1, 'win32 uses node:sqlite, never the sqlite3 CLI'],
  'devices/bonjour.ts': [2, 'win32 advertises through ciao, never dns-sd'],
  'devices/certificate.ts': [1, 'win32 makes the key and certificate in process, never openssl'],
  'devices/host.ts': [3, 'every scutil/route call sits behind `onWindows`'],
  'diagnostics/report.ts': [3, 'the Mac version and names are read only when not win32'],
  'dock/provider.ts': [1, 'the dock family is darwin-only (CHANNEL_PLATFORMS)'],
  'helper/routes.ts': [2, 'the helper routes answer 503 on win32 without running anything'],
  'platform/index.ts': [1, 'SYSTEM_DIRS is the darwin branch of safePath'],
  'platform/open-url.ts': [1, 'win32 opens through rundll32 by windowsTool()'],
  'providers/battery.ts': [3, 'win32 reads through the PowerShell host'],
  'providers/clipboard.ts': [3, 'win32 uses winPasteboard (the PowerShell host)'],
  'providers/cleanshot.ts': [2, 'the cleanshot family is darwin-only (CHANNEL_PLATFORMS)'],
  'providers/disk-map.ts': [2, 'the disk-map family is darwin-only (CHANNEL_PLATFORMS)'],
  'providers/disk-map-scanner.ts': [1, 'the disk-map family is darwin-only (CHANNEL_PLATFORMS)'],
  'providers/local-operations.ts': [1, 'docker candidates have their own win32 list'],
  'providers/mac-readings.ts': [4, 'system.ts calls it only on the Mac'],
  'providers/mac-thermals.ts': [1, 'supported only on darwin arm64'],
  'providers/network.ts': [6, 'win32 reads through the PowerShell host'],
  'providers/osascript.ts': [1, 'its callers (spotify, volume) take another path on win32 or are darwin-only'],
  'providers/rtk.ts': [1, 'rtk candidates have their own win32 list'],
  'providers/service-status.ts': [1, 'ping is windowsTool(\'ping\') on win32'],
  'providers/shortcuts.ts': [3, 'the shortcuts family is darwin-only (CHANNEL_PLATFORMS)'],
  'providers/spotify.ts': [1, 'the spotify family is darwin-only (CHANNEL_PLATFORMS)'],
  'providers/system.ts': [1, 'compared with a mount name, never run or opened'],
  'secrets/keychain.ts': [1, 'the secret store is DPAPI on win32 (createSecretStore)'],
}

/** A string literal opening on a POSIX system folder, outside a comment line. */
const LITERAL = /['"`]\/(?:usr|opt|bin|sbin|Applications|System|Library|private|var|etc)\//
const isComment = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

const SRC = join(import.meta.dirname, '..', 'src')

describe('POSIX tool paths reachable on Windows', () => {
  const holders = Object.fromEntries(sourceFiles(SRC)
    .map((file) => [relative(SRC, file).split(sep).join('/'), readFileSync(file, 'utf8').split('\n').filter((line) => !isComment(line) && LITERAL.test(line)).length] as const)
    .filter(([, lines]) => lines > 0))

  it('live only in files whose literals are gated off win32, as many lines as were reviewed', () => {
    const reviewed = Object.fromEntries(Object.entries(GATED).map(([file, [lines]]) => [file, lines]))
    expect(holders).toEqual(reviewed)
  })
})
