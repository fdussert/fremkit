import { defineConfig } from 'vitest/config'
// Pin the timezone: several tests build day boundaries from local time.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], env: { TZ: 'Europe/Paris' } } })
