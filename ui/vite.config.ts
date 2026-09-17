import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

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
})
