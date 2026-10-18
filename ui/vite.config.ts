import { defineConfig } from 'vite-plus'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// One config for the dashboard, the admin and the tests: Vite+ runs `vp dev`, `vp build` and
// `vp test` from this file, so the `test` block below is what vitest.config.ts used to hold.
export default defineConfig({
  plugins: [vue()],
  build: { rollupOptions: { input: { index: r('index.html'), admin: r('admin.html') } } },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4242',
      '/widgets': 'http://127.0.0.1:4242',
      '/fremkit.js': 'http://127.0.0.1:4242',
      '/ws': { target: 'ws://127.0.0.1:4242', ws: true },
    },
  },

  /**
   * Most of these tests are plain TypeScript — the admin layout engine, the store, the rules the
   * dashboard's gestures are made of — and run in `node` with no DOM at all.
   *
   * The exceptions are the few that mount a component, because the thing worth asserting is what
   * the component *does* with an event rather than what its source says. Those name
   * `@vitest-environment jsdom` at the top of the file, so one bar's worth of DOM does not slow
   * down the rest.
   */
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
})
