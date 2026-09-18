import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

/**
 * Most of these tests are plain TypeScript — the admin layout engine, the store, the rules the
 * dashboard's gestures are made of — and run in `node` with no DOM at all.
 *
 * The exceptions are the few that mount a component, because the thing worth asserting is what the
 * component *does* with an event rather than what its source says. Those name `@vitest-environment
 * jsdom` at the top of the file, so one bar's worth of DOM does not slow down the rest.
 */
export default defineConfig({
  plugins: [vue()],
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
})
