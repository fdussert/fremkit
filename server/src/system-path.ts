/**
 * The `PATH` the server runs its children with: the system's own folders first.
 *
 * The server runs macOS tools (most by absolute path, a few through libraries) and third-party
 * ones it has to find (`ffmpeg`, `gh`, `claude`). With Homebrew's folder first, whoever can write
 * there — another account on a shared Mac, any process of this user — could plant an `open` or an
 * `osascript` that then runs with the helper's privacy grants. So `/usr/bin:/bin:/usr/sbin:/sbin`
 * come first, always; the rest keep their order after them, and relative or empty entries (which
 * mean "the current folder") are dropped.
 */
export const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const

export function safePath(path: string | undefined): string {
  const rest = (path ?? '').split(':').filter((dir) => dir.startsWith('/') && !(SYSTEM_DIRS as readonly string[]).includes(dir))
  return [...SYSTEM_DIRS, ...new Set(rest)].join(':')
}
