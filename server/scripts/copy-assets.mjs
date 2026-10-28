// Copies the files the compiled server reads beside its own code into dist/: the widget bridge
// and the Windows host script. A Node script rather than `mkdir -p` and `cp`, which pnpm runs
// through cmd.exe on Windows, where neither exists. Usage: node scripts/copy-assets.mjs
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ASSETS = [
  ['src/bridge/fremkit.js', 'dist/bridge/fremkit.js'],
  ['src/win/host.ps1', 'dist/win/host.ps1'],
]

const root = new URL('../', import.meta.url)
for (const [from, to] of ASSETS) {
  const target = fileURLToPath(new URL(to, root))
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(fileURLToPath(new URL(from, root)), target)
}
