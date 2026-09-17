import { defineConfig } from 'vitest/config'

// The admin layout engine and store are plain TypeScript: no DOM, no Vue SFC compilation.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } })
