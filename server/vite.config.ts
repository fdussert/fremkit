import { defineConfig } from 'vite-plus'
// The only thing Vite+ does for the server is run its tests: the server is built by tsc and run by
// tsx, so there is no dev or build here, just the `test` block vitest.config.ts used to hold.
// Pin the timezone: several tests build day boundaries from local time.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], env: { TZ: 'Europe/Paris' } } })
