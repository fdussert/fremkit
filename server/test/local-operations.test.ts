import { describe, it, expect } from 'vite-plus/test'
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
