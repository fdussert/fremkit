import { describe, it, expect } from 'vite-plus/test'
import { createClaudeIdentityProvider, identityEnv, resolveClaudeBinary } from '../src/claude/identity.js'
import { ProviderRegistry } from '../src/providers/registry.js'

const status = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'PRIVATE', accessToken: 'PRIVATE' })

describe('Claude identity', () => {
  it('projects only login and plan from CLI status', async () => {
    const provider = createClaudeIdentityProvider({ read: async () => status, now: () => 100 })
    const result = await provider.poll!()
    expect(result).toEqual({ loggedIn: true, subscriptionType: 'max', authMethod: 'claude.ai', updatedAt: 100, stale: false, error: null })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })
  it('keeps login status without inventing an unrecognized plan', async () => {
    const provider = createClaudeIdentityProvider({ read: async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'unknown-plan' }) })
    expect(await provider.poll!()).toMatchObject({ loggedIn: true, subscriptionType: null, stale: false })
  })
  it('does not publish an unrecognized authentication method', async () => {
    const provider = createClaudeIdentityProvider({
      read: async () => JSON.stringify({ loggedIn: true, authMethod: 'unexpected', subscriptionType: 'max' }),
    })
    expect(await provider.poll!()).toMatchObject({ authMethod: null, subscriptionType: null })
  })
  it('clears account on logout and marks a later status failure stale', async () => {
    let raw = status
    const provider = createClaudeIdentityProvider({
      read: async () => {
        if (raw === 'fail') throw new Error('secret stderr')
        return raw
      },
    })
    await provider.poll!()
    raw = JSON.stringify({ loggedIn: false, authMethod: 'none' })
    expect(await provider.poll!()).toMatchObject({ loggedIn: false, subscriptionType: null, authMethod: null })
    raw = 'fail'
    expect(await provider.poll!()).toMatchObject({ loggedIn: false, stale: true, error: 'offline' })
    expect(provider.intervalMs).toBe(30000)
  })
  it('rejects malformed status without exposing its content', async () => {
    const provider = createClaudeIdentityProvider({
      read: async () => JSON.stringify({ loggedIn: 'yes', token: 'PRIVATE' }),
    })
    expect(await provider.poll!()).toMatchObject({ subscriptionType: null, stale: true, error: 'invalid' })
    expect(provider.intervalMs).toBe(30000)
  })
  it('uses only the first executable absolute path from the closed list', async () => {
    const seen: string[] = []
    const path = await resolveClaudeBinary(async (candidate) => {
      seen.push(candidate)
      if (candidate !== '/opt/homebrew/bin/claude') throw new Error('missing')
    })
    expect(path).toBe('/opt/homebrew/bin/claude')
    expect(seen[0]).toMatch(/\/\.local\/bin\/claude$/)
    expect(seen).toHaveLength(2)
  })
  it('strips token and loader environment variables', () => {
    const env = identityEnv({
      HOME: '/path/to/home', PATH: '/usr/bin', USER: 'example', LOGNAME: 'example',
      ANTHROPIC_API_KEY: 'PRIVATE', NODE_OPTIONS: 'PRIVATE',
    })
    expect(env).toEqual({ HOME: '/path/to/home', PATH: '/usr/bin', USER: 'example', LOGNAME: 'example' })
  })
  it('rereads promptly if a widget returns while the first CLI read is pending', async () => {
    let resolveFirst!: (value: string) => void
    const first = new Promise<string>((resolve) => { resolveFirst = resolve })
    let reads = 0
    const provider = createClaudeIdentityProvider({ read: () => ++reads === 1 ? first : Promise.resolve(status) })
    const published: unknown[] = []
    const registry = new ProviderRegistry((_channel, value) => published.push(value))
    try {
      registry.register(provider)
      registry.addSubscriber('claude-identity')
      await new Promise((resolve) => setTimeout(resolve, 10))
      registry.removeSubscriber('claude-identity')
      registry.addSubscriber('claude-identity')
      resolveFirst(status)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(reads).toBe(2)
      expect(published).toContainEqual(expect.objectContaining({ subscriptionType: 'max' }))
    } finally {
      registry.stop()
    }
  })
})
