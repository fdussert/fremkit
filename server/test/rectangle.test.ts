import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createRectangleProvider, nativeArgsFor, nativeInvocationFor } from '../src/providers/rectangle.js'

const nativeHelper = fileURLToPath(new URL('../src/providers/rectangle-native.swift', import.meta.url))

const nativeTarget = {
  pid: 4242,
  bundleId: 'com.apple.TextEdit',
  title: 'Fremkit Rectangle Probe.txt',
  application: 'TextEdit',
  windowID: 41,
}

const resolveWindowIDs = (inputs: unknown[]) => JSON.parse(execFileSync('/usr/bin/swift', [nativeHelper, 'test-window-identity', JSON.stringify(inputs)], {
  encoding: 'utf8',
  env: { ...process.env, FREMKIT_RECTANGLE_TESTING: '1' },
})) as Array<number | null>

describe('built-in macOS window provider', () => {
  it('inspects the active app and returns an opaque target token without exposing its title', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => args[1] === 'inspect'
      ? JSON.stringify({ ok: true, target: nativeTarget })
      : JSON.stringify({ ok: true }))
    const provider = createRectangleProvider(run)

    const result = await provider.commands?.['inspect-target']?.({}, { loopback: true }) as {
      ok: boolean
      target?: { token: string; application: string }
    }

    expect(result.ok).toBe(true)
    expect(result.target?.application).toBe('TextEdit')
    expect(result.target?.token).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(result)).not.toContain(nativeTarget.title)
    expect(run).toHaveBeenCalledWith('/usr/bin/swift', nativeArgsFor('inspect'))
  })

  it.each(['left-half', 'right-half', 'fill', 'next-display'] as const)(
    'runs the built-in native action %s only for the inspected target', async (action) => {
      const run = vi.fn(async (_file: string, args: string[]) => args[1] === 'inspect'
        ? JSON.stringify({ ok: true, target: nativeTarget })
        : JSON.stringify({ ok: true, changed: true }))
      const provider = createRectangleProvider(run)
      const inspected = await provider.commands?.['inspect-target']?.({}, { loopback: true }) as {
        target: { token: string }
      }

      const result = await provider.commands?.run?.({ action, targetToken: inspected.target.token }, { loopback: true })

      expect(result).toEqual({ ok: true, changed: true })
      expect(run).toHaveBeenLastCalledWith('/usr/bin/swift', nativeArgsFor(action, nativeTarget))
      expect(run.mock.calls.flatMap(([, args]) => args).join(' ')).not.toContain('rectangle://')
    },
  )

  it('rejects a same-process same-title focus switch to a different window ID', () => {
    const firstWindow = { windowID: 41, pid: nativeTarget.pid, title: nativeTarget.title, x: 100, y: 100, width: 600, height: 400 }
    const secondWindow = { ...firstWindow, windowID: 42, x: 720 }
    const input = { pid: nativeTarget.pid, title: nativeTarget.title, x: firstWindow.x, y: firstWindow.y, width: firstWindow.width, height: firstWindow.height, windows: [firstWindow, secondWindow] }

    expect(resolveWindowIDs([input, { ...input, expectedWindowID: 42 }])).toEqual([41, null])
  })

  it.each([
    ['missing window metadata', []],
    ['ambiguous same-title and same-bounds windows', [
      { windowID: 41, pid: nativeTarget.pid, title: nativeTarget.title, x: 100, y: 100, width: 600, height: 400 },
      { windowID: 42, pid: nativeTarget.pid, title: nativeTarget.title, x: 100, y: 100, width: 600, height: 400 },
    ]],
  ])('fails closed on %s', (_case, windows) => {
    expect(resolveWindowIDs([{ pid: nativeTarget.pid, title: nativeTarget.title, x: 100, y: 100, width: 600, height: 400, expectedWindowID: 41, windows }])).toEqual([null])
  })

  it.each([
    ['left-half', ['menu', 'Window', 'Move & Resize', 'Left']],
    ['right-half', ['menu', 'Window', 'Move & Resize', 'Right']],
    ['fill', ['menu', 'Window', 'Fill']],
    ['next-display', ['position', 'next-display']],
  ] as const)('maps %s to a built-in macOS action', (action, invocation) => {
    expect(nativeInvocationFor(action)).toEqual(invocation)
    expect(nativeArgsFor(action, nativeTarget).slice(6)).toEqual(invocation)
  })

  it('carries the inspected window ID in the private native invocation', () => {
    expect(nativeArgsFor('fill', nativeTarget)).toEqual([
      expect.any(String), 'run', '4242', 'com.apple.TextEdit', 'Fremkit Rectangle Probe.txt', '41', 'menu', 'Window', 'Fill',
    ])
  })

  it('rejects remote, malformed, stale, and arbitrary-target requests without invoking a native action', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => JSON.stringify({ ok: true, target: nativeTarget }))
    const provider = createRectangleProvider(run)

    await expect(provider.commands?.['inspect-target']?.({}, { loopback: false }))
      .resolves.toEqual({ ok: false, error: 'local-only' })
    await expect(provider.commands?.run?.({ action: 'run-shell', targetToken: 'nope' }, { loopback: true }))
      .resolves.toEqual({ ok: false, error: 'invalid-request' })
    await expect(provider.commands?.run?.({ action: 'left-half', targetToken: '00000000-0000-4000-8000-000000000001' }, { loopback: true }))
      .resolves.toEqual({ ok: false, error: 'target-expired' })
    expect(run).not.toHaveBeenCalled()
  })

  it('fails closed when the inspected foreground window is not a safe app window', async () => {
    const run = vi.fn(async () => JSON.stringify({ ok: false, error: 'unsafe-target' }))
    const provider = createRectangleProvider(run)

    await expect(provider.commands?.['inspect-target']?.({}, { loopback: true }))
      .resolves.toEqual({ ok: false, error: 'no-target' })
  })

  it.each([
    ['missing', (({ windowID: _windowID, ...target }) => target)(nativeTarget)],
    ['invalid', { ...nativeTarget, windowID: 0 }],
  ])('rejects an inspector response with a %s window ID', async (_case, target) => {
    const provider = createRectangleProvider(async () => JSON.stringify({ ok: true, target }))

    await expect(provider.commands?.['inspect-target']?.({}, { loopback: true }))
      .resolves.toEqual({ ok: false, error: 'no-target' })
  })

  it('fails closed when native geometry verification does not succeed', async () => {
    const run = vi.fn(async (_file: string, args: string[]) => args[1] === 'inspect'
      ? JSON.stringify({ ok: true, target: nativeTarget })
      : JSON.stringify({ ok: false, error: 'geometry-unverified' }))
    const provider = createRectangleProvider(run)
    const inspected = await provider.commands?.['inspect-target']?.({}, { loopback: true }) as {
      target: { token: string }
    }

    await expect(provider.commands?.run?.({ action: 'left-half', targetToken: inspected.target.token }, { loopback: true }))
      .resolves.toEqual({ ok: false, error: 'geometry-unverified' })
  })
})
