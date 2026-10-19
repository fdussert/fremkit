// Bundles the server into one CommonJS file for Fremkit.app, where it runs as a Node single
// executable application (scripts/build-app.sh). Usage: node scripts/bundle.mjs <outfile>
//
// CommonJS because the pinned Node's single executable applications only run a CommonJS main.
// Everything is inlined: inside a single executable, `require` reaches the built-in modules and
// nothing else, so a dependency left external would fail at the first request that needs it.
//
// The one expected warning is `import.meta` being empty in CommonJS: `src/paths.ts` reads it
// only when FREMKIT_ROOT is unset, which never happens inside the app. Any other warning fails
// the build rather than shipping a bundle that may break at run time.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const outfile = process.argv[2]
if (!outfile) {
  console.error('usage: node scripts/bundle.mjs <outfile>')
  process.exit(2)
}

const result = await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  legalComments: 'external',
  logLevel: 'warning',
  logOverride: { 'empty-import-meta': 'silent' },
})
if (result.warnings.length > 0) {
  console.error(`bundle: ${result.warnings.length} unexpected warning(s); refusing to ship this bundle`)
  process.exit(1)
}
