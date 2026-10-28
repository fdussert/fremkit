// Whether a script is being run directly (`node scripts/x.mjs`) rather than imported, comparing
// real paths so a symlink or a relative invocation still counts.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl))
  } catch {
    return false
  }
}
