import { describe, it, expect } from 'vitest'
import { createDockerProvider, createLocalModelsProvider, resolveDockerBinary } from '../src/providers/local-operations.js'

const container = (state = 'running') => JSON.stringify({ ID: 'abcd', Names: 'example', Image: 'example:latest', State: state, Status: state === 'running' ? 'Up' : 'Exited', Command: 'PRIVATE' })
const stats = JSON.stringify({ ID: 'abcd', CPUPerc: '2.3%', MemUsage: '12MiB / 2GiB', MemPerc: '1%', PIDs: '3', NetIO: '1kB / 2kB', BlockIO: '0B / 0B' })

describe('Docker observation', () => {
  it('joins container state with its stats by ID without leaking private fields', async () => {
    const calls: string[][] = []
    const provider = createDockerProvider({ run: async (args) => {
      calls.push(args)
      if (args[0] === 'context') return 'unix:///path/to/docker.sock'
      if (args.includes('ps')) return container()
      return stats
    } })
    const snapshot = await provider.poll!()
    expect(snapshot.data?.containers[0]).toMatchObject({ id: 'abcd', name: 'example', state: 'running', stats: { cpu: '2.3%', memory: '12MiB / 2GiB' } })
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE')
    expect(calls.filter((args) => args.includes('ps') || args.includes('stats')).every((args) => args[0] === '--host' && args[1] === 'unix:///path/to/docker.sock')).toBe(true)
    expect(calls.every((args) => !args.includes('start') && !args.includes('inspect-env'))).toBe(true)
  })

  it('refuses a remote context before querying containers', async () => {
    const calls: string[][] = []
    const provider = createDockerProvider({ run: async (args) => { calls.push(args); return 'ssh://example.com' } })
    expect(await provider.poll!()).toMatchObject({ data: null, error: 'remote-context' })
    expect(calls).toHaveLength(1)
  })

  it('keeps stopped containers without inventing usage and marks retained data stale', async () => {
    let offline = false
    const provider = createDockerProvider({ run: async (args) => {
      if (offline) throw new Error('PRIVATE')
      if (args[0] === 'context') return 'unix:///example.sock'
      if (args.includes('ps')) return container('exited')
      throw new Error('stats must not run')
    } })
    const snapshot = await provider.poll!()
    expect(snapshot.data?.containers[0].stats).toBeNull()
    offline = true
    expect(await provider.poll!()).toMatchObject({ data: snapshot.data, stale: true, error: 'offline' })
  })

  it('preserves the container list when stats fail after a container stops', async () => {
    const provider = createDockerProvider({ run: async (args) => {
      if (args[0] === 'context') return 'unix:///example.sock'
      if (args.includes('ps')) return container()
      throw new Error('container stopped')
    } })
    const snapshot = await provider.poll!()
    expect(snapshot.data?.containers[0]).toMatchObject({ id: 'abcd', stats: null })
    expect(snapshot.error).toBeNull()
  })

  it('caps large container lists to 200 rows and distinguishes a missing CLI', async () => {
    const provider = createDockerProvider({ run: async (args) => {
      if (args[0] === 'context') return 'unix:///example.sock'
      if (args.includes('ps')) return Array.from({ length: 201 }, () => container('exited')).join('\n')
      return ''
    } })
    expect((await provider.poll!()).data?.containers).toHaveLength(200)
    const unavailable = createDockerProvider({ run: async () => { throw new Error('unavailable') } })
    expect(await unavailable.poll!()).toMatchObject({ data: null, stale: false, error: 'unavailable' })
  })

  it('resolves only known absolute Docker executable paths', async () => {
    const paths: string[] = []
    const binary = await resolveDockerBinary(async (path) => {
      paths.push(path)
      if (path !== '/usr/local/bin/docker') throw new Error('missing')
    })
    expect(binary).toBe('/usr/local/bin/docker')
    expect(paths).toEqual(['/opt/homebrew/bin/docker', '/usr/local/bin/docker'])
    await expect(resolveDockerBinary(async () => { throw new Error('missing') })).rejects.toThrow('unavailable')
  })
})

describe('Docker actions', () => {
  const SOCKET = 'unix:///path/to/docker.sock'
  const local = { loopback: true, paired: false }
  /** A provider that has listed the container `abcd`, with every docker call it makes recorded. */
  async function listed(over: { act?: (args: string[]) => Promise<string>; context?: () => string } = {}) {
    const calls: string[][] = []
    const timeouts: (number | undefined)[] = []
    let refreshed = 0
    const provider = createDockerProvider({
      refresh: () => { refreshed++ },
      run: async (args, timeoutMs) => {
        calls.push(args)
        timeouts.push(timeoutMs)
        if (args[0] === 'context') return over.context?.() ?? SOCKET
        if (args.includes('ps')) return container()
        if (args.includes('stats')) return stats
        return over.act ? over.act(args) : ''
      },
    })
    await provider.poll!()
    calls.length = 0
    timeouts.length = 0
    return { provider, calls, timeouts, refreshed: () => refreshed }
  }
  const acted = (calls: string[][]): string[][] => calls.filter((args) => args[0] !== 'context')

  it('says which actions it takes, so a widget shows a button only where one works', async () => {
    const { provider } = await listed()
    expect((await provider.poll!()).data?.actions).toEqual(['start', 'stop', 'restart'])
    expect(Object.keys(provider.commands!).sort()).toEqual(['restart', 'start', 'stop'])
  })

  it('starts, stops and restarts a listed container on the local socket it checked', async () => {
    for (const verb of ['start', 'stop', 'restart']) {
      const { provider, calls, timeouts, refreshed } = await listed()
      // The host stamps `instanceId` on every widget command: a payload carrying it is not refused.
      expect(await provider.commands![verb]({ id: 'abcd', instanceId: 'docker-1' }, local)).toEqual({ ok: true })
      expect(acted(calls)).toEqual([['--host', SOCKET, verb, 'abcd']])
      // `docker stop` waits for the container's own grace period: longer than a query is given.
      expect(timeouts.at(-1)).toBeGreaterThanOrEqual(30000)
      expect(refreshed()).toBe(1)
    }
  })

  it('acts for a paired device as it does for the Mac, and for nobody else', async () => {
    const { provider, calls } = await listed()
    expect(await provider.commands!.stop({ id: 'abcd' }, { loopback: false, paired: true, deviceId: 'd1' })).toEqual({ ok: true })
    calls.length = 0
    expect(await provider.commands!.stop({ id: 'abcd' }, { loopback: false, paired: false })).toEqual({ ok: false, error: 'local-only' })
    expect(await provider.commands!.stop({ id: 'abcd' })).toEqual({ ok: false, error: 'local-only' })
    expect(calls).toEqual([])
  })

  it('takes its target from the containers it listed, and from nothing else', async () => {
    const { provider, calls } = await listed()
    expect(await provider.commands!.stop({ id: 'beef' }, local)).toEqual({ ok: false, error: 'unknown-container' })
    for (const payload of [{ id: '--all' }, { id: 'abcd; rm -rf /' }, { id: 'example' }, { id: ['abcd'] }, {}, null, 'abcd']) {
      expect(await provider.commands!.stop(payload, local), JSON.stringify(payload)).toEqual({ ok: false, error: 'invalid' })
    }
    expect(calls).toEqual([])
    // Before the first listing there is no list at all: nothing is a target.
    const unlisted = createDockerProvider({ run: async (args) => { calls.push(args); return '' } })
    expect(await unlisted.commands!.start({ id: 'abcd' }, local)).toEqual({ ok: false, error: 'unknown-container' })
    expect(calls).toEqual([])
  })

  it('reads the context again before acting, and leaves a remote one alone', async () => {
    let context = SOCKET
    const { provider, calls } = await listed({ context: () => context })
    context = 'tcp://192.0.2.10:2375'
    expect(await provider.commands!.restart({ id: 'abcd' }, local)).toEqual({ ok: false, error: 'remote-context' })
    expect(acted(calls)).toEqual([])
  })

  it('runs one action at a time on a container', async () => {
    // Only the first action is held; the ones after it answer at once.
    let release: (() => void) | null = null
    const { provider, calls } = await listed({
      act: () => release ? Promise.resolve('') : new Promise((resolve) => { release = () => resolve('') }),
    })
    const first = provider.commands!.stop({ id: 'abcd' }, local)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await provider.commands!.start({ id: 'abcd' }, local)).toEqual({ ok: false, error: 'busy' })
    release!()
    expect(await first).toEqual({ ok: true })
    expect(acted(calls)).toEqual([['--host', SOCKET, 'stop', 'abcd']])
    expect(await provider.commands!.start({ id: 'abcd' }, local)).toEqual({ ok: true })
  })

  it('reports a failure with a code, never with what docker said, and still asks for a fresh list', async () => {
    const failing = await listed({ act: async () => { throw new Error('PRIVATE') } })
    const result = await failing.provider.commands!.stop({ id: 'abcd' }, local)
    expect(result).toEqual({ ok: false, error: 'failed' })
    expect(failing.refreshed()).toBe(1)
    const missing = await listed({ act: async () => { throw new Error('unavailable') } })
    expect(await missing.provider.commands!.stop({ id: 'abcd' }, local)).toEqual({ ok: false, error: 'unavailable' })
  })
})

describe('Local model observation', () => {
  const modelResponse = async () => new Response(JSON.stringify({ models: [{ name: 'example-model', size: 100, size_vram: 80, context_length: 4096 }] }))

  it('separates installed Ollama models, loaded models and MLX process evidence', async () => {
    const urls: string[] = []
    const provider = createLocalModelsProvider({
      fetchFn: (async (url) => { urls.push(String(url)); return modelResponse() }) as typeof fetch,
      processes: async () => [{ pid: 12, name: 'python', command: 'python', params: '-m mlx_lm.server --model example/model --port 8080 --api-key PRIVATE', cpu: 3, mem: 2, memRss: 1024 }],
    })
    const snapshot = await provider.poll!()
    expect(snapshot.installed.data?.[0].name).toBe('example-model')
    expect(snapshot.loaded.data?.[0].size_vram).toBe(80)
    expect(snapshot.mlx.data?.[0]).toMatchObject({ model: 'example/model', port: 8080, cpu: 3 })
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE')
    expect(urls).toEqual(['http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:11434/api/ps'])
  })

  it('does not publish an absolute model path and detects console-script launches', async () => {
    const provider = createLocalModelsProvider({
      fetchFn: modelResponse as typeof fetch,
      processes: async () => [{ pid: 14, name: 'python', command: '/opt/homebrew/bin/python3', params: '/Users/example/bin/mlx_lm.server --model /Users/example/models/llama-3 --port 8080', cpu: 4, mem: 1, memRss: 100 }],
    })
    const snapshot = await provider.poll!()
    expect(snapshot.mlx.data?.[0].model).toBe('llama-3')
    expect(JSON.stringify(snapshot)).not.toContain('/Users/example')
  })

  it('detects Python-launched oMLX and mlx-server scripts', async () => {
    const provider = createLocalModelsProvider({
      fetchFn: modelResponse as typeof fetch,
      processes: async () => [
        { pid: 15, name: 'python3', command: 'python3', params: '/opt/example/bin/omlx serve --port 8000', cpu: 1, mem: 1, memRss: 100 },
        { pid: 16, name: 'python3', command: 'python3', params: '/opt/example/bin/mlx-server --port 8001', cpu: 1, mem: 1, memRss: 100 },
      ],
    })
    expect((await provider.poll!()).mlx.data?.map((entry) => entry.backend)).toEqual(['oMLX', 'MLX'])
  })

  it('keeps MLX independent when Ollama is offline', async () => {
    const provider = createLocalModelsProvider({ fetchFn: (async () => { throw new Error('PRIVATE') }) as typeof fetch, processes: async () => [] })
    const snapshot = await provider.poll!()
    expect(snapshot.loaded).toMatchObject({ data: null, error: 'offline' })
    expect(snapshot.mlx).toMatchObject({ data: [], stale: false })
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE')
  })
})
