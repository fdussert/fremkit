import { defineConfig } from 'vitest/config'
// Pin the timezone: several tests build day boundaries from local time.
// Windows file systems and process starts are slower: a cold first request or a key derivation
// that takes 1 s on the Mac can pass 5 s on a CI runner or an ARM VM.
const slow = process.platform === 'win32' ? { testTimeout: 20_000, hookTimeout: 30_000 } : {}
export default defineConfig({ test: { include: ['test/**/*.test.ts'], env: { TZ: 'Europe/Paris' }, ...slow } })
