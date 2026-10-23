/**
 * The `PATH` the server runs its children with: the system's own folders first.
 *
 * The server runs system tools (most by absolute path, a few through libraries) and third-party
 * ones it has to find (`ffmpeg`, `gh`, `claude`). With Homebrew's folder first, whoever can write
 * there — another account on a shared Mac, any process of this user — could plant an `open` or an
 * `osascript` that then runs with the helper's privacy grants. So the system folders come first,
 * always; the rest keep their order after them, and relative or empty entries (which mean "the
 * current folder") are dropped. The implementation lives in `platform/` with the Windows folders.
 */
export { SYSTEM_DIRS, safePath } from './platform/index.js'
